import type { ConversationBinding } from "../chat/binding.ts";
import { inTransaction, type Database } from "./database.ts";
import type { DeliveryStore } from "./delivery-store.ts";

export class BackgroundFailureStore {
  constructor(private readonly db: Database, private readonly deliveries: DeliveryStore) {}

  record(input: {
    id: string;
    label: string;
    incident: number;
    endpointId: string;
    threadId: string;
    binding: ConversationBinding;
  }): void {
    inTransaction(this.db, () => {
      if (this.deliveries.get(input.id) || this.db.prepare("SELECT 1 FROM events WHERE id = ?").get(input.id)) {
        throw new Error("background failure id already exists");
      }
      this.deliveries.prepare({
        id: input.id,
        kind: "system_warning",
        binding: input.binding,
        body: `[system] ${input.label} failed; durable reconciliation will retry`,
        mandatory: true,
      });
      const inserted = this.db.prepare(`INSERT INTO events
        (id, endpoint_id, thread_id, kind, payload_json, state, created_at)
        VALUES (?, ?, ?, 'background_failure', ?, 'pending', ?)`).run(
        input.id, input.endpointId, input.threadId,
        JSON.stringify({ label: input.label, incident: input.incident }), Date.now(),
      ).changes;
      if (inserted !== 1) throw new Error("background failure event was not inserted");
    });
  }

  recordExternalOwnershipDegraded(input: {
    id: string;
    incident: number;
    endpointId: string;
    threadId: string;
    binding: ConversationBinding;
  }): void {
    inTransaction(this.db, () => {
      if (this.deliveries.get(input.id) || this.db.prepare("SELECT 1 FROM events WHERE id = ?").get(input.id)) {
        throw new Error("external ownership degradation id already exists");
      }
      this.deliveries.prepare({
        id: input.id,
        kind: "system_warning",
        binding: input.binding,
        body: "[system] external session ownership detection is degraded; automatic release will retry",
        mandatory: true,
      });
      const inserted = this.db.prepare(`INSERT INTO events
        (id, endpoint_id, thread_id, kind, payload_json, state, created_at)
        VALUES (?, ?, ?, 'external_ownership_degraded', ?, 'pending', ?)`).run(
        input.id,
        input.endpointId,
        input.threadId,
        JSON.stringify({ event: "external_ownership_degraded", incident: input.incident }),
        Date.now(),
      ).changes;
      if (inserted !== 1) throw new Error("external ownership degradation event was not inserted");
    });
  }
}
