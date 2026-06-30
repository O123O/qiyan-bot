import { randomUUID } from "node:crypto";
import type { DeliveryState } from "../core/types.ts";
import type { Database } from "./database.ts";
import { inTransaction } from "./database.ts";

export interface DeliveryRecord {
  id: string;
  kind: string;
  destination: string;
  body: string;
  attachmentId?: string;
  attachmentScopeId?: string;
  replyTo?: number;
  mandatory: boolean;
  state: DeliveryState;
  telegramMessageId?: string;
  attemptCount: number;
}

export class DeliveryStore {
  constructor(private readonly db: Database) {}

  prepare(input: { kind: string; destination: string; body: string; mandatory: boolean; id?: string; attachmentId?: string; attachmentScopeId?: string; replyTo?: number }): DeliveryRecord {
    const id = input.id ?? `delivery_${randomUUID()}`;
    const existing = this.get(id);
    if (existing) return existing;
    return this.insert(id, input);
  }

  prepareAttachment(input: { kind: string; destination: string; body: string; mandatory: boolean; id?: string; attachmentId: string; attachmentScopeId: string; replyTo?: number }): DeliveryRecord {
    const id = input.id ?? `delivery_${randomUUID()}`;
    return inTransaction(this.db, () => {
      const existing = this.get(id);
      if (existing) return existing;
      const delivery = this.insert(id, input);
      const retained = this.db.prepare("UPDATE attachments SET ref_count = ref_count + 1 WHERE id = ? AND scope_id = ?")
        .run(input.attachmentId, input.attachmentScopeId).changes;
      if (retained !== 1) throw new Error("attachment delivery handle is missing or out of scope");
      return delivery;
    });
  }

  private insert(id: string, input: { kind: string; destination: string; body: string; mandatory: boolean; attachmentId?: string; attachmentScopeId?: string; replyTo?: number }): DeliveryRecord {
    const now = Date.now();
    this.db.prepare(`INSERT INTO deliveries
      (id, kind, destination, body, attachment_id, attachment_scope_id, reply_to, mandatory, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`)
      .run(id, input.kind, input.destination, input.body, input.attachmentId ?? null, input.attachmentScopeId ?? null, input.replyTo ?? null, input.mandatory ? 1 : 0, now, now);
    return this.get(id) as DeliveryRecord;
  }

  get(id: string): DeliveryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      kind: String(row.kind),
      destination: String(row.destination),
      body: String(row.body),
      ...(row.attachment_id ? { attachmentId: String(row.attachment_id) } : {}),
      ...(row.attachment_scope_id ? { attachmentScopeId: String(row.attachment_scope_id) } : {}),
      ...(row.reply_to !== null && row.reply_to !== undefined ? { replyTo: Number(row.reply_to) } : {}),
      mandatory: Number(row.mandatory) === 1,
      state: String(row.state) as DeliveryState,
      ...(row.telegram_message_id ? { telegramMessageId: String(row.telegram_message_id) } : {}),
      attemptCount: Number(row.attempt_count),
    };
  }

  markDispatched(id: string): void {
    this.db.prepare("UPDATE deliveries SET state = 'dispatched', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  confirm(id: string, telegramMessageId: string): void {
    inTransaction(this.db, () => {
      const changed = this.db.prepare("UPDATE deliveries SET state = 'confirmed', telegram_message_id = ?, updated_at = ? WHERE id = ? AND state <> 'confirmed'")
        .run(telegramMessageId, Date.now(), id).changes;
      if (changed) this.releaseAttachment(id);
    });
  }

  fail(id: string): void {
    inTransaction(this.db, () => {
      const changed = this.db.prepare("UPDATE deliveries SET state = 'failed', updated_at = ? WHERE id = ? AND state <> 'failed'").run(Date.now(), id).changes;
      if (changed) this.releaseAttachment(id);
    });
  }

  markUncertain(id: string): void {
    inTransaction(this.db, () => {
      const row = this.db.prepare("SELECT state, mandatory FROM deliveries WHERE id = ?").get(id) as { state: string; mandatory: number } | undefined;
      if (!row || row.state === "uncertain") return;
      this.db.prepare("UPDATE deliveries SET state = 'uncertain', updated_at = ? WHERE id = ?").run(Date.now(), id);
      if (row.mandatory === 0) this.releaseAttachment(id);
    });
  }

  markPrepared(id: string): void {
    this.db.prepare("UPDATE deliveries SET state = 'prepared', updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  recoverAfterCrash(): DeliveryRecord[] {
    return inTransaction(this.db, () => {
      const optional = this.db.prepare("SELECT id, destination FROM deliveries WHERE state = 'dispatched' AND mandatory = 0").all() as Array<{ id: string; destination: string }>;
      const recovered = this.db.prepare("SELECT id FROM deliveries WHERE state = 'dispatched' ORDER BY created_at, id").all() as Array<{ id: string }>;
      this.db.prepare("UPDATE deliveries SET state = 'uncertain', updated_at = ? WHERE state = 'dispatched'").run(Date.now());
      for (const delivery of optional) {
        this.releaseAttachment(delivery.id);
        this.prepare({
          id: `delivery-warning:${delivery.id}`,
          kind: "delivery_warning",
          destination: delivery.destination,
          body: `[system] delivery ${delivery.id} could not be confirmed and was not automatically retried`,
          mandatory: true,
        });
      }
      return recovered.map(({ id }) => this.get(id)!).filter(Boolean);
    });
  }

  listReady(): DeliveryRecord[] {
    const rows = this.db.prepare("SELECT id FROM deliveries WHERE state IN ('prepared', 'uncertain') ORDER BY created_at").all() as Array<{ id: string }>;
    return rows.map(({ id }) => this.get(id) as DeliveryRecord);
  }

  private releaseAttachment(deliveryId: string): void {
    this.db.prepare(`UPDATE attachments SET ref_count = MAX(ref_count - 1, 0)
      WHERE id = (SELECT attachment_id FROM deliveries WHERE id = ?)`).run(deliveryId);
  }
}
