import type { Database } from "./database.ts";

export class SessionDeliveryProgressStore {
  constructor(private readonly db: Database) {}

  setCursor(endpointId: string, threadId: string, mappingId: string, cursor: string): void {
    this.db.prepare(`INSERT INTO session_delivery_progress(endpoint_id, thread_id, mapping_id, delivery_cursor)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint_id, thread_id, mapping_id) DO UPDATE SET delivery_cursor = excluded.delivery_cursor`)
      .run(endpointId, threadId, mappingId, cursor);
  }

  cursor(endpointId: string, threadId: string, mappingId: string): string | undefined {
    const row = this.db.prepare(`SELECT delivery_cursor FROM session_delivery_progress
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`).get(endpointId, threadId, mappingId) as
      { delivery_cursor: string | null } | undefined;
    return row?.delivery_cursor ?? undefined;
  }

  markRecoveryIncident(endpointId: string, threadId: string, mappingId: string, reason: string): boolean {
    this.db.prepare(`INSERT OR IGNORE INTO session_delivery_progress(endpoint_id, thread_id, mapping_id)
      VALUES (?, ?, ?)`).run(endpointId, threadId, mappingId);
    return Number(this.db.prepare(`UPDATE session_delivery_progress SET recovery_incident = ?
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ? AND recovery_incident IS NULL`)
      .run(reason, endpointId, threadId, mappingId).changes) === 1;
  }

  recoveryIncident(endpointId: string, threadId: string, mappingId: string): { reason: string } | undefined {
    const row = this.db.prepare(`SELECT recovery_incident FROM session_delivery_progress
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`).get(endpointId, threadId, mappingId) as
      { recovery_incident: string | null } | undefined;
    return row?.recovery_incident ? { reason: row.recovery_incident } : undefined;
  }

  delete(endpointId: string, threadId: string, mappingId: string): void {
    this.db.prepare("DELETE FROM session_delivery_progress WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?")
      .run(endpointId, threadId, mappingId);
  }
}
