import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { AttachmentStore } from "../../src/attachments/store.ts";
import { AppError } from "../../src/core/errors.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { DeliveryWorker } from "../../src/telegram/delivery-worker.ts";

test("prepared delivery becomes dispatched then atomically confirmed", async () => {
  const db = createTestDatabase();
  const store = new DeliveryStore(db);
  const delivery = store.prepare({ id: "d_abc", kind: "text", destination: "7", body: "[payments] done", mandatory: true });
  const states: string[] = [];
  const worker = new DeliveryWorker(store, { sendMessage: async () => { states.push(store.get(delivery.id)!.state); return { message_id: 11 }; } });
  await worker.processOne(delivery.id);
  assert.deepEqual(states, ["dispatched"]);
  assert.equal(store.get(delivery.id)?.state, "confirmed");
  assert.equal(store.get(delivery.id)?.telegramMessageId, "11");
  await worker.processOne(delivery.id);
  assert.equal(states.length, 1);
});

test("crash recovery retries mandatory uncertainty with a stable recovery label", async () => {
  const store = new DeliveryStore(createTestDatabase());
  const delivery = store.prepare({ id: "d_ab12", kind: "text", destination: "7", body: "[payments] done", mandatory: true });
  store.markDispatched(delivery.id);
  store.recoverAfterCrash();
  const bodies: string[] = [];
  const worker = new DeliveryWorker(store, { sendMessage: async (_chat, body) => { bodies.push(body); return { message_id: 12 }; } });
  await worker.processOne(delivery.id);
  assert.deepEqual(bodies, ["[payments · recovery retry d_ab12] done"]);
});

test("optional uncertain tool output is not automatically retried", async () => {
  const store = new DeliveryStore(createTestDatabase());
  const delivery = store.prepare({ id: "d_optional", kind: "text", destination: "7", body: "x", mandatory: false });
  store.markDispatched(delivery.id);
  store.recoverAfterCrash();
  let sends = 0;
  const worker = new DeliveryWorker(store, { sendMessage: async () => { sends += 1; return { message_id: 1 }; } });
  await assert.rejects(worker.processOne(delivery.id), (error: unknown) => error instanceof AppError && error.code === "DELIVERY_UNCERTAIN");
  assert.equal(sends, 0);
  assert.equal(store.get(`delivery-warning:${delivery.id}`)?.mandatory, true);
});

test("a nondeterministic send failure is persisted as uncertain immediately", async () => {
  const store = new DeliveryStore(createTestDatabase());
  const delivery = store.prepare({ id: "d_network", kind: "text", destination: "7", body: "x", mandatory: true });
  const worker = new DeliveryWorker(store, { sendMessage: async () => { throw new Error("socket reset"); } });
  await assert.rejects(worker.processOne(delivery.id), /socket reset/);
  assert.equal(store.get(delivery.id)?.state, "uncertain");
});

test("an optional delivery failure creates one mandatory visible warning", async () => {
  const store = new DeliveryStore(createTestDatabase());
  const delivery = store.prepare({ id: "d_optional_network", kind: "text", destination: "7", body: "x", mandatory: false });
  const worker = new DeliveryWorker(store, { sendMessage: async () => { throw new Error("socket reset"); } });
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
  const delivery = store.prepareAttachment({ id: "d_file", kind: "attachment", destination: "7", body: "caption", mandatory: false, attachmentId: file.id, attachmentScopeId: "ctx" });
  assert.equal((db.prepare("SELECT ref_count FROM attachments WHERE id = ?").get(file.id) as any).ref_count, 1);
  let uploaded = "";
  const worker = new DeliveryWorker(store, {
    sendMessage: async () => ({ message_id: 1 }),
    sendDocument: async (_chat, upload) => { for await (const chunk of upload.stream) uploaded += Buffer.from(chunk).toString(); assert.equal(upload.caption, "caption"); return { message_id: 22 }; },
  }, attachments);
  await worker.processOne(delivery.id);
  assert.equal(uploaded, "payload");
  assert.equal(store.get(delivery.id)?.telegramMessageId, "22");
  assert.equal((db.prepare("SELECT ref_count FROM attachments WHERE id = ?").get(file.id) as any).ref_count, 0);
});

test("document rate limits reopen the stream and retry without becoming uncertain", async () => {
  const db = createTestDatabase();
  const attachments = new AttachmentStore(db, await mkdtemp(join(tmpdir(), "delivery-rate-file-")), { maxFileBytes: 100, maxStoreBytes: 100 });
  await attachments.initialize();
  const file = await attachments.ingest("ctx", Readable.from(["payload"]), { displayName: "report.txt", mediaType: "text/plain" });
  const store = new DeliveryStore(db);
  const delivery = store.prepareAttachment({ id: "d_rate_file", kind: "attachment", destination: "7", body: "", mandatory: false, attachmentId: file.id, attachmentScopeId: "ctx" });
  let attempts = 0;
  const sleeps: number[] = [];
  const worker = new DeliveryWorker(store, {
    sendMessage: async () => ({ message_id: 1 }),
    sendDocument: async (_chat, upload) => {
      let bytes = ""; for await (const chunk of upload.stream) bytes += Buffer.from(chunk).toString();
      assert.equal(bytes, "payload");
      attempts += 1;
      if (attempts === 1) throw { status: 429, response: { parameters: { retry_after: 2 } } };
      return { message_id: 23 };
    },
  }, attachments, async (ms) => { sleeps.push(ms); });
  await worker.processOne(delivery.id);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [2_000]);
  assert.equal(store.get(delivery.id)?.state, "confirmed");
});
