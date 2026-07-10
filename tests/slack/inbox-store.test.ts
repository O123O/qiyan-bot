import assert from "node:assert/strict";
import test from "node:test";
import { SlackInboxStore } from "../../src/chat-apps/slack/inbox-store.ts";
import type { NormalizedSlackEvent } from "../../src/chat-apps/slack/types.ts";
import { createTestDatabase } from "../../src/storage/database.ts";

function event(id: string, channel: string, receivedAt = 1): NormalizedSlackEvent {
  return {
    eventId: id,
    eventType: "message.im",
    teamId: "T1",
    channelId: channel,
    messageTs: `${id}.0`,
    userId: "U1",
    rawText: id,
    files: [],
    nativeSourceId: `T1:${channel}:${id}.0`,
    sourceId: `slack:T1:${channel}:${id}.0`,
    binding: { adapterId: "slack", conversationKey: `slack:T1:dm:${channel}`, destination: { workspaceId: "T1", channelId: channel }, reply: { messageTs: `${id}.0` } },
    activate: false,
    receivedAt,
  };
}

test("inbox allocates stable order, deduplicates events, and claims equal-time rows by sequence", () => {
  const db = createTestDatabase();
  const store = new SlackInboxStore(db);
  assert.equal(store.accept(event("E9", "D9", 10)), "inserted");
  assert.equal(store.accept(event("E1", "D1", 10)), "inserted");
  assert.equal(store.accept(event("E9", "D9", 10)), "duplicate");
  assert.equal(db.prepare("SELECT next_value FROM slack_inbox_sequence WHERE singleton = 1").get()!.next_value, 3);
  assert.equal(store.claimNext()?.eventId, "E9");
  store.markProcessedInTransaction("E9");
  assert.equal(store.claimNext()?.eventId, "E1");
});

test("a retry at the head blocks later rows and recovery restores processing", () => {
  const db = createTestDatabase();
  const store = new SlackInboxStore(db);
  store.accept(event("E1", "D1"));
  store.accept(event("E2", "D2"));
  assert.equal(store.claimNext()?.eventId, "E1");
  store.retry("E1", "temporary token=redacted");
  assert.equal(store.peekOldest()?.eventId, "E1");
  assert.equal(store.claimNext()?.eventId, "E1");
  assert.equal(store.recoverProcessing(), 1);
  assert.equal(store.peekOldest()?.state, "retry");
  assert.doesNotMatch(String(db.prepare("SELECT last_error FROM slack_inbox WHERE event_id = 'E1'").get()!.last_error), /temporary token=/u);
});

test("file checkpoints retain only normalized completed or failed state", () => {
  const db = createTestDatabase();
  const store = new SlackInboxStore(db);
  store.accept(event("E1", "D1"));
  store.markFileCompleted("E1", "F1", "file_abc");
  store.markFileFailed("E1", "F2", { nativeId: "F2", displayName: "missing.txt", reasonCode: "not_accessible" });
  assert.deepEqual(store.get("E1")?.fileState, {
    F1: { state: "completed", attachmentId: "file_abc" },
    F2: { state: "failed", descriptor: { nativeId: "F2", displayName: "missing.txt", reasonCode: "not_accessible" } },
  });
});
