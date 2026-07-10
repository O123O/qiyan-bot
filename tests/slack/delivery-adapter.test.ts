import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import { ChatAdapterRegistry } from "../../src/chat-apps/shared/adapter-registry.ts";
import { DeliveryWorker } from "../../src/chat-apps/shared/delivery-worker.ts";
import { SlackDeliveryAdapter, slackClientMessageId } from "../../src/chat-apps/slack/delivery-adapter.ts";
import { SlackApiError, type SlackBotClient } from "../../src/chat-apps/slack/clients.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

function client(overrides: Partial<SlackBotClient> = {}) {
  const messages: Record<string, unknown>[] = [];
  const uploads: Record<string, unknown>[] = [];
  const value: SlackBotClient = {
    authTest: async () => ({ ok: true }),
    openOwnerDm: async () => ({ ok: true }),
    conversationHistory: async () => ({ ok: true }),
    conversationReplies: async () => ({ ok: true }),
    channelInfo: async () => ({ ok: true }),
    userInfo: async () => ({ ok: true }),
    downloadFile: async () => ({ stream: Readable.from([]) }),
    postMessage: async (args) => { messages.push(args); return { ok: true, channel: args.channel, ts: "10.200" }; },
    uploadFileV2: async (args) => {
      uploads.push(args);
      return { ok: true, files: [{ ok: true, files: [{ id: "F1" }, { id: "F2" }] }] };
    },
    ...overrides,
  };
  return { value, messages, uploads };
}

function boundAdapter(value: SlackBotClient): SlackDeliveryAdapter {
  const adapter = new SlackDeliveryAdapter(value);
  adapter.bindWorkspace("T123");
  return adapter;
}

test("Slack delivery posts DMs and thread replies with stable UUID client IDs", async () => {
  const fake = client();
  const adapter = new SlackDeliveryAdapter(fake.value);
  await assert.rejects(adapter.sendMessage(
    { workspaceId: "T123", channelId: "D123" }, "hello", undefined, { deliveryId: "unbound" },
  ), /workspace.*initialize|initialize.*workspace/iu);
  adapter.bindWorkspace("T123");
  adapter.bindWorkspace("T123");
  assert.throws(() => adapter.bindWorkspace("T999"), /workspace/iu);
  const direct = await adapter.sendMessage(
    { workspaceId: "T123", channelId: "D123" },
    "hello",
    undefined,
    { deliveryId: "delivery-one" },
  );
  const threaded = await adapter.sendMessage(
    { workspaceId: "T123", channelId: "C123", threadTs: "9.100" },
    "done",
    { messageTs: "9.200" },
    { deliveryId: "delivery-two" },
  );
  assert.deepEqual(direct, { channelId: "D123", messageTs: "10.200" });
  assert.deepEqual(threaded, { channelId: "C123", messageTs: "10.200" });
  assert.deepEqual(fake.messages, [
    { channel: "D123", text: "hello", client_msg_id: slackClientMessageId("delivery-one") },
    { channel: "C123", text: "done", thread_ts: "9.100", client_msg_id: slackClientMessageId("delivery-two") },
  ]);
  assert.match(slackClientMessageId("delivery-one"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(slackClientMessageId("delivery-one"), slackClientMessageId("delivery-one"));
  assert.notEqual(slackClientMessageId("delivery-one"), slackClientMessageId("delivery-two"));
});

test("a successful message response without an identity becomes durably uncertain", async () => {
  const fake = client({ postMessage: async () => ({ ok: true, channel: "D123" }) });
  const adapter = boundAdapter(fake.value);
  const store = new DeliveryStore(createTestDatabase());
  const delivery = store.prepare({
    id: "missing-message-id", kind: "chat", mandatory: true, body: "hello",
    binding: { adapterId: "slack", conversationKey: "slack:T123:dm:D123", destination: { workspaceId: "T123", channelId: "D123" } },
  });
  const worker = new DeliveryWorker(store, new ChatAdapterRegistry([{ delivery: adapter }]));

  await assert.rejects(worker.processOne(delivery.id), (error: unknown) =>
    error instanceof SlackApiError && error.deterministic === false && error.safeToRetry === false);
  assert.equal(store.get(delivery.id)?.state, "uncertain");
});

test("Slack documents use upload-v2 with the frozen channel thread and return opaque file IDs", async () => {
  const fake = client();
  const adapter = boundAdapter(fake.value);
  const stream = Readable.from(["payload"]);
  assert.deepEqual(await adapter.sendDocument!(
    { workspaceId: "T123", channelId: "C123", threadTs: "9.100" },
    {
      stream,
      size: 7,
      displayName: "report.txt",
      mediaType: "text/plain",
      caption: "report",
      deliveryId: "delivery-file",
    },
  ), { channelId: "C123", fileIds: ["F1", "F2"] });
  assert.deepEqual(fake.uploads, [{
    channel_id: "C123",
    thread_ts: "9.100",
    file: stream,
    filename: "report.txt",
    title: "report.txt",
    initial_comment: "report",
  }]);
  const source = await readFile(new URL("../../src/chat-apps/slack/delivery-adapter.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /files\.upload(?:\W|$)/u);
});

test("a successful upload without a Slack file identity remains uncertain", async () => {
  const adapter = boundAdapter(client({
    uploadFileV2: async () => ({ ok: true, files: [{ ok: true, files: [] }] }),
  }).value);
  await assert.rejects(adapter.sendDocument!(
    { workspaceId: "T123", channelId: "D123" },
    { stream: Readable.from(["payload"]), size: 7, displayName: "report.txt", mediaType: "text/plain", deliveryId: "delivery-file" },
  ), (error: unknown) => error instanceof SlackApiError && error.deterministic === false && error.safeToRetry === false);
});

test("Slack delivery rejects destinations outside the configured workspace", async () => {
  const adapter = boundAdapter(client().value);
  for (const destination of [
    { workspaceId: "T999", channelId: "C123" },
    { workspaceId: "T123", channelId: "bad" },
    { workspaceId: "T123", channelId: "C123", threadTs: "bad" },
    { channelId: "C123" },
  ]) await assert.rejects(adapter.sendMessage(destination, "x", undefined, { deliveryId: "d" }), /Slack destination/i);
});

test("only failures explicitly proven to precede an effect are retryable", () => {
  const adapter = boundAdapter(client().value);
  assert.equal(adapter.isSafeToRetry(new SlackApiError("pre-dispatch rate limit", 429, 1_000, false, true)), true);
  assert.equal(adapter.isSafeToRetry(new SlackApiError("ambiguous transport", undefined, undefined, false, false)), false);
  assert.equal(adapter.isSafeToRetry(new SlackApiError("upload URL stage", 429, 1_000, false, false)), false);
  assert.equal(adapter.isSafeToRetry(new SlackApiError("byte upload stage", undefined, undefined, false, false)), false);
  assert.equal(adapter.isSafeToRetry(new SlackApiError("completion stage", undefined, undefined, false, false)), false);
  assert.equal(adapter.isSafeToRetry(new Error("unknown")), false);
});
