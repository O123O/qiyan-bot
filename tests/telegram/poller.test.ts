import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { AttachmentStore } from "../../src/attachments/store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { TelegramPoller } from "../../src/chat-apps/telegram/poller.ts";

test("accepted input atomically stores source context and advances the offset after download", async () => {
  const db = createTestDatabase();
  const attachments = new AttachmentStore(db, await mkdtemp(join(tmpdir(), "poll-files-")), { maxFileBytes: 10, maxStoreBytes: 100 });
  await attachments.initialize();
  const operations = new OperationStore(db);
  const conversations = new ConversationStore(db, new DeliveryStore(db), attachments);
  const queued: string[] = [];
  const api = {
    getUpdates: async () => [{ update_id: 4, message: { message_id: 2, date: 1, chat: { id: 10, type: "private" }, from: { id: 42 }, caption: "/pass hi", document: { file_id: "f", file_name: "a.txt", mime_type: "text/plain" } } }],
    downloadFile: async () => ({ stream: Readable.from(["abc"]) }),
  };
  const poller = new TelegramPoller(db, api, attachments, { ownerId: 42, onMessage: async (source, checkpoint) => {
    conversations.acceptChatSource(source, { commitNativeCheckpoint: checkpoint });
    queued.push(source.id);
  } });
  await poller.pollOnce();
  assert.equal((db.prepare("SELECT next_update_id FROM telegram_state").get() as any).next_update_id, 5);
  const context = operations.getSourceContext("telegram:10:2");
  assert.equal(context?.rawText, "/pass hi");
  assert.equal(context?.attachmentIds.length, 1);
  assert.deepEqual(context?.binding, {
    adapterId: "telegram",
    conversationKey: "telegram:10",
    destination: { chatId: "10" },
    reply: { messageId: 2 },
  });
  assert.equal((db.prepare("SELECT ref_count FROM attachments").get() as any).ref_count, 1);
  assert.deepEqual(queued, ["telegram:10:2"]);
});

test("unauthorized and unsupported updates advance offset without downloads or retained content", async () => {
  const db = createTestDatabase();
  const attachments = new AttachmentStore(db, await mkdtemp(join(tmpdir(), "poll-ignore-")), { maxFileBytes: 10, maxStoreBytes: 100 });
  await attachments.initialize();
  let downloads = 0;
  const operational: unknown[] = [];
  const api = {
    getUpdates: async () => [
      { update_id: 1, message: { message_id: 1, date: 1, chat: { id: 1, type: "private" }, from: { id: 99 }, text: "secret", document: { file_id: "x" } } },
      { update_id: 2, callback_query: { data: "secret" } },
    ],
    downloadFile: async () => { downloads += 1; return { stream: Readable.from([]) }; },
  };
  const poller = new TelegramPoller(db, api, attachments, {
    ownerId: 42,
    onMessage: async () => undefined,
    onOperationalEvent: (event) => { operational.push(event); },
  });
  await poller.pollOnce();
  assert.equal((db.prepare("SELECT next_update_id FROM telegram_state").get() as any).next_update_id, 3);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM source_contexts").get() as any).count, 0);
  assert.equal(downloads, 0);
  assert.deepEqual(operational, [
    { level: "warn", code: "chat_input_ignored", adapter: "telegram", reason: "unauthorized_sender" },
    { level: "info", code: "chat_input_ignored", adapter: "telegram", reason: "unsupported_update" },
  ]);
});

test("polling failures and recovery are observable without exposing raw errors", async () => {
  const db = createTestDatabase();
  const attachments = new AttachmentStore(db, await mkdtemp(join(tmpdir(), "poll-observe-")), { maxFileBytes: 10, maxStoreBytes: 100 });
  await attachments.initialize();
  const operational: unknown[] = [];
  let calls = 0;
  const api = {
    getUpdates: async (_offset: number, signal?: AbortSignal) => {
      calls += 1;
      if (calls === 1) throw new Error("secret-token");
      if (calls === 2) return [];
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return [];
    },
    downloadFile: async () => ({ stream: Readable.from([]) }),
  };
  const poller = new TelegramPoller(db, api, attachments, {
    ownerId: 42,
    onMessage: async () => undefined,
    retrySleep: async () => undefined,
    onOperationalEvent: (event) => { operational.push(event); },
  });
  poller.start();
  while (calls < 3) await new Promise((resolve) => setImmediate(resolve));
  await poller.stop();
  assert.deepEqual(operational, [
    { level: "warn", code: "chat_ingress_failed", adapter: "telegram", consecutiveFailures: 1 },
    { level: "info", code: "chat_ingress_recovered", adapter: "telegram", consecutiveFailures: 1 },
  ]);
  assert.equal(JSON.stringify(operational).includes("secret-token"), false);
});

test("source, retain, notice, and offset roll back together when the native checkpoint fails", async () => {
  const db = createTestDatabase();
  const attachments = new AttachmentStore(db, await mkdtemp(join(tmpdir(), "poll-rollback-")), { maxFileBytes: 10, maxStoreBytes: 100 });
  await attachments.initialize();
  const conversations = new ConversationStore(db, new DeliveryStore(db), attachments);
  const updates = [{ update_id: 7, message: { message_id: 3, date: 1, chat: { id: 10, type: "private" }, from: { id: 42 }, text: "hello" } }];
  const api = { getUpdates: async () => updates, downloadFile: async () => ({ stream: Readable.from([]) }) };
  let fail = true;
  const poller = new TelegramPoller(db, api, attachments, { ownerId: 42, onMessage: async (source, checkpoint) => {
    conversations.acceptChatSource(source, { commitNativeCheckpoint: () => { if (fail) throw new Error("offset failed"); checkpoint(); } });
  } });
  await assert.rejects(poller.pollOnce(), /offset failed/u);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_contexts").get()!.n, 0);
  assert.equal(db.prepare("SELECT next_update_id FROM telegram_state").get()!.next_update_id, 0);
  fail = false;
  await poller.pollOnce();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_contexts").get()!.n, 1);
  assert.equal(db.prepare("SELECT next_update_id FROM telegram_state").get()!.next_update_id, 8);
});
