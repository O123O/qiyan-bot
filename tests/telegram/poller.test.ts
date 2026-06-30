import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { AttachmentStore } from "../../src/attachments/store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";
import { TelegramPoller } from "../../src/telegram/poller.ts";

test("accepted input atomically stores source context and advances the offset after download", async () => {
  const db = createTestDatabase();
  const attachments = new AttachmentStore(db, await mkdtemp(join(tmpdir(), "poll-files-")), { maxFileBytes: 10, maxStoreBytes: 100 });
  await attachments.initialize();
  const operations = new OperationStore(db);
  const queued: string[] = [];
  const api = {
    getUpdates: async () => [{ update_id: 4, message: { message_id: 2, date: 1, chat: { id: 10, type: "private" }, from: { id: 42 }, caption: "/pass hi", document: { file_id: "f", file_name: "a.txt", mime_type: "text/plain" } } }],
    downloadFile: async () => ({ stream: Readable.from(["abc"]) }),
  };
  const poller = new TelegramPoller(db, api, operations, attachments, { ownerId: 42, onAccepted: async (id) => { queued.push(id); } });
  await poller.pollOnce();
  assert.equal((db.prepare("SELECT next_update_id FROM telegram_state").get() as any).next_update_id, 5);
  const context = operations.getSourceContext("telegram:10:2");
  assert.equal(context?.rawText, "/pass hi");
  assert.equal(context?.attachmentIds.length, 1);
  assert.deepEqual(queued, ["telegram:10:2"]);
});

test("unauthorized and unsupported updates advance offset without downloads or retained content", async () => {
  const db = createTestDatabase();
  const attachments = new AttachmentStore(db, await mkdtemp(join(tmpdir(), "poll-ignore-")), { maxFileBytes: 10, maxStoreBytes: 100 });
  await attachments.initialize();
  let downloads = 0;
  const api = {
    getUpdates: async () => [
      { update_id: 1, message: { message_id: 1, date: 1, chat: { id: 1, type: "private" }, from: { id: 99 }, text: "secret", document: { file_id: "x" } } },
      { update_id: 2, callback_query: { data: "secret" } },
    ],
    downloadFile: async () => { downloads += 1; return { stream: Readable.from([]) }; },
  };
  const poller = new TelegramPoller(db, api, new OperationStore(db), attachments, { ownerId: 42, onAccepted: async () => undefined });
  await poller.pollOnce();
  assert.equal((db.prepare("SELECT next_update_id FROM telegram_state").get() as any).next_update_id, 3);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM source_contexts").get() as any).count, 0);
  assert.equal(downloads, 0);
});

