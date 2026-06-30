import type { ManagementState } from "../core/types.ts";
import type { Database } from "./database.ts";

export class RuntimeStore {
  constructor(private readonly db: Database) {}

  setSession(endpointId: string, threadId: string, managementState: ManagementState, nativeStatus = "notLoaded"): void {
    this.db.prepare(`INSERT INTO session_runtime(endpoint_id, thread_id, management_state, native_status)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint_id, thread_id) DO UPDATE SET
        restore_state = CASE
          WHEN excluded.management_state = 'unavailable' AND session_runtime.management_state <> 'unavailable' THEN session_runtime.management_state
          WHEN excluded.management_state = 'unavailable' THEN session_runtime.restore_state
          ELSE NULL
        END,
        management_state = excluded.management_state,
        native_status = excluded.native_status`)
      .run(endpointId, threadId, managementState, nativeStatus);
  }

  getSession(endpointId: string, threadId: string): { managementState: ManagementState; restoreState?: ManagementState; nativeStatus: string; deliveryCursor?: string } | undefined {
    const row = this.db.prepare("SELECT * FROM session_runtime WHERE endpoint_id = ? AND thread_id = ?").get(endpointId, threadId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      managementState: String(row.management_state) as ManagementState,
      ...(row.restore_state ? { restoreState: String(row.restore_state) as ManagementState } : {}),
      nativeStatus: String(row.native_status),
      ...(row.delivery_cursor ? { deliveryCursor: String(row.delivery_cursor) } : {}),
    };
  }

  setActiveTurn(endpointId: string, threadId: string, turnId: string | undefined): void {
    this.db.prepare("UPDATE session_runtime SET active_turn_id = ?, native_status = ? WHERE endpoint_id = ? AND thread_id = ?")
      .run(turnId ?? null, turnId ? "active" : "idle", endpointId, threadId);
  }

  reconcileNativeState(endpointId: string, threadId: string, nativeStatus: string, activeTurnId?: string): void {
    this.db.prepare("UPDATE session_runtime SET native_status = ?, active_turn_id = ? WHERE endpoint_id = ? AND thread_id = ?")
      .run(nativeStatus, activeTurnId ?? null, endpointId, threadId);
  }

  activeTurn(endpointId: string, threadId: string): string | undefined {
    const row = this.db.prepare("SELECT active_turn_id FROM session_runtime WHERE endpoint_id = ? AND thread_id = ?").get(endpointId, threadId) as { active_turn_id: string | null } | undefined;
    return row?.active_turn_id ?? undefined;
  }

  setDeliveryCursor(endpointId: string, threadId: string, cursor: string): void {
    this.db.prepare("UPDATE session_runtime SET delivery_cursor = ? WHERE endpoint_id = ? AND thread_id = ?").run(cursor, endpointId, threadId);
  }

  setModel(endpointId: string, threadId: string, model: string): void {
    this.db.prepare("UPDATE session_runtime SET model = ? WHERE endpoint_id = ? AND thread_id = ?").run(model, endpointId, threadId);
  }

  setEffort(endpointId: string, threadId: string, effort: string): void {
    this.db.prepare("UPDATE session_runtime SET effort = ? WHERE endpoint_id = ? AND thread_id = ?").run(effort, endpointId, threadId);
  }

  settings(endpointId: string, threadId: string): { model?: string; effort?: string } {
    const row = this.db.prepare("SELECT model, effort FROM session_runtime WHERE endpoint_id = ? AND thread_id = ?").get(endpointId, threadId) as { model: string | null; effort: string | null } | undefined;
    return row ? { ...(row.model ? { model: row.model } : {}), ...(row.effort ? { effort: row.effort } : {}) } : {};
  }

  consumeSettings(endpointId: string, threadId: string): { model?: string; effort?: string } {
    return this.settings(endpointId, threadId);
  }

  listSessions(): Array<{ endpointId: string; threadId: string; managementState: ManagementState; restoreState?: ManagementState; nativeStatus: string }> {
    return (this.db.prepare("SELECT endpoint_id, thread_id, management_state, restore_state, native_status FROM session_runtime").all() as Array<Record<string, unknown>>).map((row) => ({
      endpointId: String(row.endpoint_id), threadId: String(row.thread_id), managementState: String(row.management_state) as ManagementState,
      ...(row.restore_state ? { restoreState: String(row.restore_state) as ManagementState } : {}),
      nativeStatus: String(row.native_status),
    }));
  }

  beginEpoch(endpointId: string, threadId: string, baselineTurnId: string | undefined, startedAt: number): string {
    const id = `epoch_${crypto.randomUUID()}`;
    this.db.prepare("INSERT INTO managed_epochs(id, endpoint_id, thread_id, baseline_turn_id, started_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, endpointId, threadId, baselineTurnId ?? null, startedAt);
    return id;
  }

  endEpoch(endpointId: string, threadId: string, endedAt: number): void {
    this.db.prepare("UPDATE managed_epochs SET ended_at = ? WHERE id = (SELECT id FROM managed_epochs WHERE endpoint_id = ? AND thread_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1)")
      .run(endedAt, endpointId, threadId);
  }

  currentEpoch(endpointId: string, threadId: string): { id: string; baselineTurnId?: string; startedAt: number } | undefined {
    const row = this.db.prepare("SELECT * FROM managed_epochs WHERE endpoint_id = ? AND thread_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1").get(endpointId, threadId) as Record<string, unknown> | undefined;
    return row ? { id: String(row.id), ...(row.baseline_turn_id ? { baselineTurnId: String(row.baseline_turn_id) } : {}), startedAt: Number(row.started_at) } : undefined;
  }

  latestEpoch(endpointId: string, threadId: string): { id: string; baselineTurnId?: string; startedAt: number; endedAt?: number } | undefined {
    const row = this.db.prepare("SELECT * FROM managed_epochs WHERE endpoint_id = ? AND thread_id = ? ORDER BY started_at DESC LIMIT 1").get(endpointId, threadId) as Record<string, unknown> | undefined;
    return row ? { id: String(row.id), ...(row.baseline_turn_id ? { baselineTurnId: String(row.baseline_turn_id) } : {}), startedAt: Number(row.started_at), ...(row.ended_at ? { endedAt: Number(row.ended_at) } : {}) } : undefined;
  }
}
