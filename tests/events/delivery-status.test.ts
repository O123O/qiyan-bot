import assert from "node:assert/strict";
import test from "node:test";
import { persistDeliveryStateEvent, reconcileDeliveryStateEvents } from "../../src/events/delivery-status.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

const binding = { adapterId: "telegram", conversationKey: "telegram:42", destination: { chatId: "42" } } as const;

test("delivery outcomes remain in the outbox and never become assistant input events", () => {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  for (let index = 0; index < 25; index += 1) {
    const delivery = deliveries.prepare({ id: `delivery-${index}`, kind: "worker_final", binding, body: "hidden", mandatory: true });
    deliveries.markDispatched(delivery.id);
    deliveries.confirm(delivery.id, { messageId: index });
  }
  assert.equal(persistDeliveryStateEvent(db, deliveries.get("delivery-0")!), false);
  assert.equal(reconcileDeliveryStateEvents(db, deliveries), 0);
  assert.equal(reconcileDeliveryStateEvents(db, deliveries), 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind = 'delivery_status'").get() as { count: number }).count, 0);
});
