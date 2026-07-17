import type { Database } from "../storage/database.ts";
import type { DeliveryRecord, DeliveryStore } from "../storage/delivery-store.ts";

export function persistDeliveryStateEvent(db: Database, delivery: DeliveryRecord): boolean {
  void db;
  void delivery;
  // DeliveryStore is already the durable authority for the outbox outcome. Turning that outcome
  // into assistant input makes every QiYan reply schedule another QiYan turn.
  return false;
}

export function reconcileDeliveryStateEvents(db: Database, deliveries: DeliveryStore): number {
  void db;
  void deliveries;
  return 0;
}
