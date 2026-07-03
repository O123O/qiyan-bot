import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "../../src/chat/binding.ts";
import type { ChatDeliveryAdapter } from "../../src/chat/contracts.ts";
import { ChatAdapterRegistry } from "../../src/chat/adapter-registry.ts";
import { DeliveryWorker } from "../../src/chat/delivery-worker.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

class FakeAdapter implements ChatDeliveryAdapter {
  readonly sent: Array<{ destination: JsonValue; body: string; deliveryId?: string }> = [];
  constructor(readonly id: string, private readonly receipt: JsonValue) {}
  async sendMessage(destination: JsonValue, body: string, _reply?: JsonValue, options?: { deliveryId: string }): Promise<JsonValue> {
    this.sent.push({ destination, body, ...(options ? { deliveryId: options.deliveryId } : {}) });
    return this.receipt;
  }
}

test("delivery worker routes by adapter and persists opaque binding and receipt", async () => {
  const db = createTestDatabase();
  const store = new DeliveryStore(db);
  const telegram = new FakeAdapter("telegram", { messageId: 7 });
  const slack = new FakeAdapter("slack", { ts: "1.2" });
  const worker = new DeliveryWorker(store, new ChatAdapterRegistry([{ delivery: telegram }, { delivery: slack }]));
  const binding = { adapterId: "slack", conversationKey: "slack:C1:thread:9", destination: { channel: "C1", threadTs: "9" } } as const;
  const delivery = store.prepare({ id: "d1", kind: "chat", binding, body: "hello", mandatory: true });
  assert.deepEqual(store.get("d1")?.binding, binding);
  await worker.processOne(delivery.id);
  assert.deepEqual(store.get("d1")?.receipt, { ts: "1.2" });
  assert.deepEqual(slack.sent, [{ destination: { channel: "C1", threadTs: "9" }, body: "hello", deliveryId: "d1" }]);
  assert.equal(telegram.sent.length, 0);
});

test("adapter-specific retry proof overrides generic HTTP status handling", async () => {
  const store = new DeliveryStore(createTestDatabase());
  const binding = { adapterId: "slack", conversationKey: "slack:C1", destination: { channel: "C1" } } as const;
  const safe = store.prepare({ id: "safe", kind: "chat", binding, body: "one", mandatory: true });
  const ambiguous = store.prepare({ id: "ambiguous", kind: "chat", binding, body: "two", mandatory: true });
  const adapter: ChatDeliveryAdapter = {
    id: "slack",
    sendMessage: async (_destination, _body, _reply, options) => {
      throw { status: 429, safeToRetry: options?.deliveryId === "safe" };
    },
    isSafeToRetry: (error) => (error as { safeToRetry?: boolean }).safeToRetry === true,
  };
  const worker = new DeliveryWorker(store, new ChatAdapterRegistry([{ delivery: adapter }]));
  await assert.rejects(worker.processOne(safe.id));
  await assert.rejects(worker.processOne(ambiguous.id));
  assert.equal(store.get(safe.id)?.state, "prepared");
  assert.equal(store.get(ambiguous.id)?.state, "uncertain");
});

test("a deterministic Slack rejection fails without retrying", async () => {
  const store = new DeliveryStore(createTestDatabase());
  const binding = { adapterId: "slack", conversationKey: "slack:C1", destination: { channel: "C1" } } as const;
  const delivery = store.prepare({ id: "rejected", kind: "chat", binding, body: "one", mandatory: true });
  let attempts = 0;
  const adapter: ChatDeliveryAdapter = {
    id: "slack",
    sendMessage: async () => { attempts += 1; throw { deterministic: true, safeToRetry: false }; },
    isSafeToRetry: () => false,
  };
  const worker = new DeliveryWorker(store, new ChatAdapterRegistry([{ delivery: adapter }]));
  await assert.rejects(worker.processOne(delivery.id));
  assert.equal(store.get(delivery.id)?.state, "failed");
  assert.equal(attempts, 1);
});

test("same destination JSON does not erase distinct conversation keys", () => {
  const store = new DeliveryStore(createTestDatabase());
  const first = store.prepare({
    id: "one", kind: "chat", binding: { adapterId: "slack", conversationKey: "slack:C1", destination: { channel: "C1" } }, body: "1", mandatory: true,
  });
  const second = store.prepare({
    id: "two", kind: "chat", binding: { adapterId: "slack", conversationKey: "slack:C1:T2", destination: { channel: "C1" } }, body: "2", mandatory: true,
  });
  assert.notEqual(first.binding.conversationKey, second.binding.conversationKey);
});
