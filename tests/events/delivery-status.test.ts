import assert from "node:assert/strict";
import test from "node:test";
import { reconcileDeliveryStateEvents } from "../../src/events/delivery-status.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

test("delivery metadata reconciliation visits only terminal rows missing their stable event", () => {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  for (let index = 0; index < 25; index += 1) {
    const delivery = deliveries.prepare({ id: `delivery-${index}`, kind: "worker_final", destination: "42", body: "hidden", mandatory: true });
    deliveries.markDispatched(delivery.id);
    deliveries.confirm(delivery.id, String(index));
  }
  assert.equal(reconcileDeliveryStateEvents(db, deliveries), 25);
  assert.equal(reconcileDeliveryStateEvents(db, deliveries), 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind = 'delivery_status'").get() as { count: number }).count, 25);
});
