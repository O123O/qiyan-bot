import type { Database } from "../storage/database.ts";
import type { DeliveryRecord, DeliveryStore } from "../storage/delivery-store.ts";

export function persistDeliveryStateEvent(db: Database, delivery: DeliveryRecord): boolean {
  if (!new Set(["confirmed", "failed", "uncertain"]).has(delivery.state)) return false;
  const id = `delivery-status:${delivery.id}:${delivery.state}`;
  return db.prepare(`INSERT OR IGNORE INTO events(id, endpoint_id, thread_id, kind, payload_json, state, created_at)
    VALUES (?, 'chat', ?, 'delivery_status', ?, 'pending', ?)`)
    .run(id, delivery.destination, JSON.stringify({
      deliveryId: delivery.id,
      kind: delivery.kind,
      state: delivery.state,
      mandatory: delivery.mandatory,
      telegramMessageId: delivery.telegramMessageId ?? null,
    }), Date.now()).changes === 1;
}

export function reconcileDeliveryStateEvents(db: Database, deliveries: DeliveryStore): number {
  const rows = db.prepare(`SELECT d.id FROM deliveries d
    WHERE d.state IN ('confirmed', 'failed', 'uncertain')
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.id = 'delivery-status:' || d.id || ':' || d.state)
    ORDER BY d.created_at, d.id`).all() as Array<{ id: string }>;
  let inserted = 0;
  for (const row of rows) {
    const delivery = deliveries.get(row.id);
    if (delivery && persistDeliveryStateEvent(db, delivery)) inserted += 1;
  }
  return inserted;
}
