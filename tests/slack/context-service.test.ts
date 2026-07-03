import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { ConversationBinding } from "../../src/chat/binding.ts";
import type { SlackBotClient } from "../../src/slack/clients.ts";
import { SlackContextService } from "../../src/slack/context-service.ts";

type ResponseFactory = (args: Record<string, unknown>) => Record<string, unknown>;

function bot(options: { history?: ResponseFactory; replies?: ResponseFactory }) {
  const historyCalls: Record<string, unknown>[] = [];
  const replyCalls: Record<string, unknown>[] = [];
  const client: SlackBotClient = {
    authTest: async () => ({ ok: true }),
    openOwnerDm: async () => ({ ok: true }),
    channelInfo: async () => ({ ok: true }),
    userInfo: async () => ({ ok: true }),
    postMessage: async () => ({ ok: true }),
    uploadFileV2: async () => ({ ok: true }),
    downloadFile: async () => ({ stream: Readable.from([]) }),
    conversationHistory: async (args) => { historyCalls.push(args); return options.history?.(args) ?? { ok: true, messages: [] }; },
    conversationReplies: async (args) => { replyCalls.push(args); return options.replies?.(args) ?? { ok: true, messages: [] }; },
  };
  return { client, historyCalls, replyCalls };
}

const dm: ConversationBinding = {
  adapterId: "slack",
  conversationKey: "slack:T123:dm:D123",
  destination: { workspaceId: "T123", channelId: "D123" },
};
const thread: ConversationBinding = {
  adapterId: "slack",
  conversationKey: "slack:T123:thread:C123:1.000",
  destination: { workspaceId: "T123", channelId: "C123", threadTs: "1.000" },
};
const message = (ts: string) => ({ ts, text: `m${ts}`, user: `U${ts.replace(".", "")}`, thread_ts: "1.000" });

test("DM and channel history consume newest-first pages only until the requested window is full", async () => {
  const fake = bot({ history: (args) => {
    if (args.latest === "6.000") return { ok: true, messages: [message("5.000"), message("4.000"), message("3.000")], response_metadata: { next_cursor: "older" } };
    if (args.cursor === "next") return { ok: true, messages: [message("6.000"), message("5.000")], response_metadata: { next_cursor: "unused" } };
    return { ok: true, messages: [message("8.000"), message("7.000")], response_metadata: { next_cursor: "next" } };
  } });
  const service = new SlackContextService(fake.client, "T123");
  const first = await service.getHistory(dm, { scope: "conversation", count: 3 });
  assert.deepEqual((first as any).messages.map((item: any) => item.messageTs), ["6.000", "7.000", "8.000"]);
  assert.equal((first as any).nextBefore, "6.000");
  assert.deepEqual(fake.historyCalls, [
    { channel: "D123", limit: 3 },
    { channel: "D123", limit: 1, cursor: "next" },
  ]);

  const second = await service.getHistory(dm, { scope: "conversation", count: 3, before: (first as any).nextBefore });
  assert.deepEqual((second as any).messages.map((item: any) => item.messageTs), ["3.000", "4.000", "5.000"]);
  assert.equal(new Set([...(first as any).messages, ...(second as any).messages].map((item: any) => item.messageTs)).size, 6);

  await service.getHistory(thread, { scope: "channel", count: 1 });
  assert.equal(fake.replyCalls.length, 0);
  assert.equal(fake.historyCalls.at(-1)?.channel, "C123");
});

test("thread history consumes all oldest-first pages into a bounded newest window and deduplicates the root", async () => {
  const fake = bot({ replies: (args) => {
    if (args.cursor === "page-2") return { ok: true, messages: [message("1.000"), message("4.000"), message("5.000")], response_metadata: { next_cursor: "page-3" } };
    if (args.cursor === "page-3") return { ok: true, messages: [message("6.000"), message("7.000"), message("8.000")], response_metadata: { next_cursor: "" } };
    return { ok: true, messages: [message("1.000"), message("2.000"), message("3.000")], response_metadata: { next_cursor: "page-2" } };
  } });
  const result = await new SlackContextService(fake.client, "T123").getHistory(thread, { scope: "conversation", count: 3, before: "9.000" });
  assert.deepEqual((result as any).messages.map((item: any) => item.messageTs), ["6.000", "7.000", "8.000"]);
  assert.equal((result as any).nextBefore, "6.000");
  assert.deepEqual(fake.replyCalls.map((args) => args.cursor), [undefined, "page-2", "page-3"]);
  for (const call of fake.replyCalls) {
    assert.equal(call.channel, "C123");
    assert.equal(call.ts, "1.000");
    assert.equal(call.latest, "9.000");
    assert.equal(call.inclusive, false);
  }
});

test("history validates the persisted Slack binding instead of accepting model-selected destinations", async () => {
  const service = new SlackContextService(bot({}).client, "T123");
  await assert.rejects(service.getHistory({ ...dm, adapterId: "telegram" }, { scope: "conversation", count: 1 }), /Slack binding/i);
  await assert.rejects(service.getHistory({ ...dm, destination: { workspaceId: "T999", channelId: "D123" } }, { scope: "conversation", count: 1 }), /Slack binding/i);
  await assert.rejects(service.getHistory(dm, { scope: "conversation", count: 1, before: "not-a-timestamp" }), /boundary/i);
});
