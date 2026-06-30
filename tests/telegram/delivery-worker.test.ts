import assert from "node:assert/strict";
import test from "node:test";
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
});
