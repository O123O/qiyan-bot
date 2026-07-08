import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { AttachmentStore } from "../../src/attachments/store.ts";
import { parseDirective } from "../../src/directives/parser.ts";
import { classifySlackEvent } from "../../src/slack/event-classifier.ts";
import { SlackInboxStore } from "../../src/slack/inbox-store.ts";
import { SlackIngressWorker } from "../../src/slack/ingress-worker.ts";
import type { NormalizedSlackEvent } from "../../src/slack/types.ts";
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

function event(eventId: string, nativeTs = "1.0", rawText = "file"): NormalizedSlackEvent {
  return {
    eventId,
    eventType: "app_mention",
    teamId: "T1",
    channelId: "C1",
    messageTs: nativeTs,
    userId: "U1",
    rawText,
    files: [{ slackFileId: "F1", displayName: "one.txt", mediaType: "text/plain", declaredSize: 3, downloadUrl: "https://files.slack.com/F1" }],
    nativeSourceId: `T1:C1:${nativeTs}`,
    sourceId: `slack:T1:C1:${nativeTs}`,
    binding: {
      adapterId: "slack",
      conversationKey: `slack:T1:thread:C1:${nativeTs}`,
      destination: { workspaceId: "T1", channelId: "C1", threadTs: nativeTs },
      reply: { messageTs: nativeTs },
    },
    activate: true,
    receivedAt: 1,
  };
}

async function fixture(downloadFile: (url: string) => Promise<{ stream: AsyncIterable<Uint8Array | string>; size?: number }>) {
  const db = createTestDatabase();
  const inbox = new SlackInboxStore(db);
  const deliveries = new DeliveryStore(db);
  const attachments = new AttachmentStore(db, await mkdtemp(join(tmpdir(), "qiyan-slack-ingress-")), { maxFileBytes: 100, maxStoreBytes: 1_000 });
  await attachments.initialize();
  const conversations = new ConversationStore(db, deliveries, attachments);
  const worker = new SlackIngressWorker(inbox, attachments, conversations, deliveries, {
    downloadFile,
    isTransient: (error) => error instanceof Error && error.message === "transient",
    onMessage: async (source, effects) => { conversations.acceptChatSource(source, effects); },
  });
  return { db, inbox, deliveries, conversations, attachments, worker };
}

test("downloads, checkpoints, accepts, and retains one Slack attachment", async () => {
  let downloads = 0;
  const value = await fixture(async () => { downloads += 1; return { stream: Readable.from(["one"]), size: 3 }; });
  value.inbox.accept(event("E1"));
  assert.equal(await value.worker.processOne(), true);
  assert.equal(downloads, 1);
  assert.equal(value.inbox.get("E1")?.state, "processed");
  assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM source_contexts WHERE adapter_id = 'slack'").get()!.count, 1);
  const attachment = value.db.prepare("SELECT scope_id, ref_count, size FROM attachments").get()!;
  assert.equal(attachment.scope_id, "slack:T1:C1:1.0");
  assert.equal(attachment.ref_count, 1);
  assert.equal(attachment.size, 3);
});

test("overlapping events reuse one successful download and accepted source", async () => {
  let downloads = 0;
  const value = await fixture(async () => { downloads += 1; return { stream: Readable.from(["one"]), size: 3 }; });
  value.inbox.accept(event("E1"));
  value.inbox.accept({ ...event("E2"), activate: false, eventType: "message.channels" });
  assert.equal(await value.worker.processOne(), true);
  assert.equal(await value.worker.processOne(), true);
  assert.equal(downloads, 1);
  assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM attachments").get()!.count, 1);
  assert.equal(value.db.prepare("SELECT ref_count FROM attachments").get()!.ref_count, 1);
  assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM source_contexts WHERE adapter_id = 'slack'").get()!.count, 1);
  assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE kind = 'attachment_warning'").get()!.count, 0);
});

test("message-first overlap preserves canonical mention stripping for directive safeguards", async () => {
  const value = await fixture(async () => ({ stream: Readable.from([]), size: 0 }));
  value.inbox.accept({ ...event("E-root", "1.0", "activate"), files: [] });
  assert.equal(await value.worker.processOne(), true);

  const classify = (eventId: string, slackEvent: Record<string, unknown>) => classifySlackEvent({
    type: "event_callback", team_id: "T1", event_id: eventId, event_time: 2, event: slackEvent,
  }, {
    teamId: "T1", ownerUserId: "U1", botUserId: "B1", now: () => 2_000,
    isActivated: (conversationKey) => value.inbox.isActivated(conversationKey),
  });
  const message = classify("E-message", {
    type: "message", channel_type: "channel", channel: "C1", user: "U1", ts: "2.0", thread_ts: "1.0", text: "<@B1> /pass exact",
  });
  const mention = classify("E-mention", {
    type: "app_mention", channel: "C1", user: "U1", ts: "2.0", thread_ts: "1.0", text: "<@B1> /pass exact",
  });
  assert.equal(message.kind, "accept");
  assert.equal(mention.kind, "accept");
  if (message.kind !== "accept" || mention.kind !== "accept") return;
  value.inbox.accept(message.event);
  value.inbox.accept(mention.event);
  assert.equal(await value.worker.processOne(), true);
  assert.equal(await value.worker.processOne(), true);

  const source = value.db.prepare("SELECT raw_text FROM source_contexts WHERE id = 'slack:T1:C1:2.0'").get() as { raw_text: string };
  assert.equal(source.raw_text, "/pass exact");
  assert.deepEqual(parseDirective(source.raw_text, [], 10), { kind: "pass", prefix: "", payload: "exact" });
});

test("overlapping permanent failure creates one descriptor and warning without an attachment row", async () => {
  let downloads = 0;
  const value = await fixture(async () => { downloads += 1; throw new Error("permanent"); });
  value.inbox.accept(event("E1", "1.0", ""));
  value.inbox.accept({ ...event("E2", "1.0", ""), activate: false, eventType: "message.channels" });
  assert.equal(await value.worker.processOne(), true);
  assert.equal(await value.worker.processOne(), true);
  assert.equal(downloads, 1);
  assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM attachments").get()!.count, 0);
  const source = value.db.prepare("SELECT raw_text, failed_attachments_json FROM source_contexts WHERE adapter_id = 'slack'").get()!;
  assert.equal(source.raw_text, "");
  assert.deepEqual(JSON.parse(String(source.failed_attachments_json)), [{ nativeId: "F1", displayName: "one.txt", reasonCode: "download_failed" }]);
  assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE kind = 'attachment_warning'").get()!.count, 1);
});

test("a transient head failure blocks later inbox rows", async () => {
  let downloads = 0;
  const value = await fixture(async () => { downloads += 1; throw new Error("transient"); });
  value.inbox.accept(event("E1", "1.0"));
  value.inbox.accept(event("E2", "2.0"));
  assert.equal(await value.worker.processOne(), false);
  assert.equal(downloads, 1);
  assert.equal(value.inbox.peekOldest()?.eventId, "E1");
  assert.equal(value.inbox.peekOldest()?.state, "retry");
  assert.equal(value.inbox.get("E2")?.state, "pending");
});

test("restart after file checkpoint reuses bytes before source acceptance", async () => {
  let downloads = 0;
  const value = await fixture(async () => { downloads += 1; return { stream: Readable.from(["one"]), size: 3 }; });
  value.inbox.accept(event("E1"));
  let failAcceptance = true;
  const crashing = new SlackIngressWorker(value.inbox, value.attachments, value.conversations, value.deliveries, {
    downloadFile: async () => { downloads += 1; return { stream: Readable.from(["one"]), size: 3 }; },
    isTransient: () => true,
    onMessage: async (source, effects) => {
      if (failAcceptance) { failAcceptance = false; throw new Error("transient"); }
      value.conversations.acceptChatSource(source, effects);
    },
  });
  assert.equal(await crashing.processOne(), false);
  assert.equal(await crashing.processOne(), true);
  assert.equal(downloads, 1);
  assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM attachments").get()!.count, 1);
  assert.equal(value.db.prepare("SELECT ref_count FROM attachments").get()!.ref_count, 1);
});

test("restart drains persisted canonical forwarded text without the raw Slack event", async () => {
  const value = await fixture(async () => ({ stream: Readable.from([]), size: 0 }));
  const rawAttachment = { is_share: true, author_name: "Bob", text: "Forwarded hello" };
  const classified = classifySlackEvent({
    type: "event_callback", team_id: "T1", event_id: "E-forward", event_time: 2,
    event: { type: "message", channel_type: "im", channel: "D1", user: "U1", ts: "2.0", text: "", attachments: [rawAttachment] },
  }, {
    teamId: "T1", ownerUserId: "U1", botUserId: "B1", now: () => 2_000, isActivated: () => false,
  });
  assert.equal(classified.kind, "accept");
  if (classified.kind !== "accept") return;
  value.inbox.accept(classified.event);
  rawAttachment.text = "mutated after persistence";

  const restarted = new SlackIngressWorker(value.inbox, value.attachments, value.conversations, value.deliveries, {
    downloadFile: async () => { throw new Error("no download expected"); },
    isTransient: () => false,
    onMessage: async (source, effects) => { value.conversations.acceptChatSource(source, effects); },
  });
  await restarted.recoverAndDrain();

  const source = value.db.prepare("SELECT raw_text FROM source_contexts WHERE id = 'slack:T1:D1:2.0'").get() as { raw_text: string };
  assert.equal(source.raw_text, "[Forwarded Slack message from Bob]\nForwarded hello");
  assert.doesNotMatch(source.raw_text, /mutated/u);
});

test("a forwarded nested file without a URL uses the durable unavailable path", async () => {
  let downloads = 0;
  const value = await fixture(async () => { downloads += 1; throw new Error("download must not run"); });
  const classified = classifySlackEvent({
    type: "event_callback", team_id: "T1", event_id: "E-nested-file", event_time: 3,
    event: {
      type: "message", channel_type: "im", channel: "D1", user: "U1", ts: "3.0", text: "",
      attachments: [{ is_share: true, text: "Forwarded file", files: [{ id: "F2", name: "nested.txt", mimetype: "text/plain" }] }],
    },
  }, {
    teamId: "T1", ownerUserId: "U1", botUserId: "B1", now: () => 3_000, isActivated: () => false,
  });
  assert.equal(classified.kind, "accept");
  if (classified.kind !== "accept") return;
  value.inbox.accept(classified.event);
  assert.equal(await value.worker.processOne(), true);

  assert.equal(downloads, 0);
  const source = value.db.prepare("SELECT failed_attachments_json FROM source_contexts WHERE id = 'slack:T1:D1:3.0'").get() as { failed_attachments_json: string };
  assert.deepEqual(JSON.parse(source.failed_attachments_json), [{ nativeId: "F2", displayName: "nested.txt", reasonCode: "download_unavailable" }]);
  assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE kind = 'attachment_warning'").get()!.count, 1);
});
