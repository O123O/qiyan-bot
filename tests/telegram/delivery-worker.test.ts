import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { AttachmentStore } from "../../src/attachments/store.ts";
import { ChatAdapterRegistry } from "../../src/chat-apps/shared/adapter-registry.ts";
import type { ChatDeliveryAdapter } from "../../src/chat-apps/shared/contracts.ts";
import { DeliveryWorker } from "../../src/chat-apps/shared/delivery-worker.ts";
import { AppError } from "../../src/core/errors.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

const binding = { adapterId: "telegram", conversationKey: "telegram:7", destination: { chatId: "7" } } as const;

function adapters(adapter: Omit<ChatDeliveryAdapter, "id">): ChatAdapterRegistry {
  return new ChatAdapterRegistry([{ delivery: { id: "telegram", ...adapter } }]);
}

test("prepared delivery becomes dispatched then atomically confirmed", async () => {
  const db = createTestDatabase();
  const store = new DeliveryStore(db);
  const delivery = store.prepare({ id: "d_abc", kind: "text", binding, body: "[payments] done", mandatory: true });
  const states: string[] = [];
  const worker = new DeliveryWorker(store, adapters({ sendMessage: async () => { states.push(store.get(delivery.id)!.state); return { messageId: 11 }; } }));
  await worker.processOne(delivery.id);
  assert.deepEqual(states, ["dispatched"]);
  assert.equal(store.get(delivery.id)?.state, "confirmed");
  assert.deepEqual(store.get(delivery.id)?.receipt, { messageId: 11 });
  await worker.processOne(delivery.id);
  assert.equal(states.length, 1);
});

test("metadata observer failure cannot roll a confirmed delivery back to uncertain", async () => {
  const store = new DeliveryStore(createTestDatabase());
  const delivery = store.prepare({ id: "d_observer", kind: "text", binding, body: "done", mandatory: true });
  const worker = new DeliveryWorker(store, adapters({ sendMessage: async () => ({ messageId: 44 }) }), undefined, undefined, () => { throw new Error("metadata store failed"); });
  await worker.processOne(delivery.id);
  assert.equal(store.get(delivery.id)?.state, "confirmed");
});

test("crash recovery retries mandatory uncertainty with a stable recovery label", async () => {
  const store = new DeliveryStore(createTestDatabase());
  const delivery = store.prepare({ id: "d_ab12", kind: "text", binding, body: "[payments] done", mandatory: true });
  store.markDispatched(delivery.id);
  store.recoverAfterCrash();
  const bodies: string[] = [];
  const worker = new DeliveryWorker(store, adapters({ sendMessage: async (_chat, body) => { bodies.push(body); return { messageId: 12 }; } }));
  await worker.processOne(delivery.id);
  assert.deepEqual(bodies, ["[payments · recovery retry d_ab12] done"]);
});

test("optional uncertain tool output is not automatically retried", async () => {
  const store = new DeliveryStore(createTestDatabase());
  const delivery = store.prepare({ id: "d_optional", kind: "text", binding, body: "x", mandatory: false });
  store.markDispatched(delivery.id);
  store.recoverAfterCrash();
  let sends = 0;
  const worker = new DeliveryWorker(store, adapters({ sendMessage: async () => { sends += 1; return { messageId: 1 }; } }));
  await assert.rejects(worker.processOne(delivery.id), (error: unknown) => error instanceof AppError && error.code === "DELIVERY_UNCERTAIN");
  assert.equal(sends, 0);
  assert.equal(store.get(`delivery-warning:${delivery.id}`)?.mandatory, true);
});

test("a nondeterministic send failure is persisted as uncertain immediately", async () => {
  const store = new DeliveryStore(createTestDatabase());
  const delivery = store.prepare({ id: "d_network", kind: "text", binding, body: "x", mandatory: true });
  const observed: string[] = [];
  const worker = new DeliveryWorker(store, adapters({ sendMessage: async () => { throw new Error("socket reset"); } }), undefined, undefined, (changed) => { observed.push(changed.state); });
  await assert.rejects(worker.processOne(delivery.id), /socket reset/);
  assert.equal(store.get(delivery.id)?.state, "uncertain");
  assert.deepEqual(observed, ["uncertain"]);
});

test("an optional delivery failure creates one mandatory visible warning", async () => {
  const store = new DeliveryStore(createTestDatabase());
  const delivery = store.prepare({ id: "d_optional_network", kind: "text", binding, body: "x", mandatory: false });
  const worker = new DeliveryWorker(store, adapters({ sendMessage: async () => { throw new Error("socket reset"); } }));
  await assert.rejects(worker.processOne(delivery.id));
  await assert.rejects(worker.processOne(delivery.id), (error: unknown) => error instanceof AppError && error.code === "DELIVERY_UNCERTAIN");
  assert.deepEqual(store.listReady().filter((item) => item.id.startsWith("delivery-warning:")).map((item) => item.body), [
    "[system] delivery d_optional_network could not be confirmed and was not automatically retried",
  ]);
});

test("attachment deliveries use the durable outbox and scoped private snapshot", async () => {
  const db = createTestDatabase();
  const attachments = new AttachmentStore(db, await mkdtemp(join(tmpdir(), "delivery-file-")), { maxFileBytes: 100, maxStoreBytes: 100 });
  await attachments.initialize();
  const file = await attachments.ingest("ctx", Readable.from(["payload"]), { displayName: "report.txt", mediaType: "text/plain" });
  const store = new DeliveryStore(db);
  const delivery = store.prepareAttachment({ id: "d_file", kind: "attachment", binding, body: "caption", mandatory: false, attachmentId: file.id, attachmentScopeId: "ctx" });
  assert.equal((db.prepare("SELECT ref_count FROM attachments WHERE id = ?").get(file.id) as any).ref_count, 1);
  let uploaded = "";
  const worker = new DeliveryWorker(store, adapters({
    sendMessage: async () => ({ messageId: 1 }),
    sendDocument: async (_chat, upload) => { for await (const chunk of upload.stream) uploaded += Buffer.from(chunk).toString(); assert.equal(upload.caption, "caption"); return { messageId: 22 }; },
  }), attachments);
  await worker.processOne(delivery.id);
  assert.equal(uploaded, "payload");
  assert.deepEqual(store.get(delivery.id)?.receipt, { messageId: 22 });
  assert.equal((db.prepare("SELECT ref_count FROM attachments WHERE id = ?").get(file.id) as any).ref_count, 0);
});

test("document rate limits reopen the stream and retry without becoming uncertain", async () => {
  const db = createTestDatabase();
  const attachments = new AttachmentStore(db, await mkdtemp(join(tmpdir(), "delivery-rate-file-")), { maxFileBytes: 100, maxStoreBytes: 100 });
  await attachments.initialize();
  const file = await attachments.ingest("ctx", Readable.from(["payload"]), { displayName: "report.txt", mediaType: "text/plain" });
  const store = new DeliveryStore(db);
  const delivery = store.prepareAttachment({ id: "d_rate_file", kind: "attachment", binding, body: "", mandatory: false, attachmentId: file.id, attachmentScopeId: "ctx" });
  let attempts = 0;
  const sleeps: number[] = [];
  const worker = new DeliveryWorker(store, adapters({
    sendMessage: async () => ({ messageId: 1 }),
    sendDocument: async (_chat, upload) => {
      let bytes = ""; for await (const chunk of upload.stream) bytes += Buffer.from(chunk).toString();
      assert.equal(bytes, "payload");
      attempts += 1;
      if (attempts === 1) throw { status: 429, response: { parameters: { retry_after: 2 } } };
      return { messageId: 23 };
    },
  }), attachments, async (ms) => { sleeps.push(ms); });
  await worker.processOne(delivery.id);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [2_000]);
  assert.equal(store.get(delivery.id)?.state, "confirmed");
});

test("delivery identity is passed to document adapters without changing Telegram retry defaults", async () => {
  const db = createTestDatabase();
  const attachments = new AttachmentStore(db, await mkdtemp(join(tmpdir(), "delivery-id-file-")), { maxFileBytes: 100, maxStoreBytes: 100 });
  await attachments.initialize();
  const file = await attachments.ingest("ctx", Readable.from(["payload"]), { displayName: "report.txt", mediaType: "text/plain" });
  const store = new DeliveryStore(db);
  const delivery = store.prepareAttachment({ id: "stable-file-id", kind: "attachment", binding, body: "", mandatory: true, attachmentId: file.id, attachmentScopeId: "ctx" });
  let seen: string | undefined;
  const worker = new DeliveryWorker(store, adapters({
    sendMessage: async () => ({ messageId: 1 }),
    sendDocument: async (_destination, upload) => { seen = upload.deliveryId; return { messageId: 2 }; },
  }), attachments);
  await worker.processOne(delivery.id);
  assert.equal(seen, delivery.id);
});
