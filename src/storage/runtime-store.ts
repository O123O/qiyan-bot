import type { ManagementState } from "../core/types.ts";
import type { Database } from "./database.ts";
import { inTransaction } from "./database.ts";

export class RuntimeStore {
  constructor(private readonly db: Database) {}

  setSession(endpointId: string, threadId: string, mappingId: string, managementState: ManagementState, nativeStatus = "notLoaded", observationSequence?: number): void {
    this.db.prepare(`INSERT INTO session_runtime(endpoint_id, thread_id, mapping_id, management_state, native_status, native_observation_sequence)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint_id, thread_id, mapping_id) DO UPDATE SET
        restore_state = CASE
          WHEN excluded.management_state = 'unavailable' AND session_runtime.management_state <> 'unavailable' THEN session_runtime.management_state
          WHEN excluded.management_state = 'unavailable' THEN session_runtime.restore_state
          ELSE NULL
        END,
        management_state = excluded.management_state,
        native_status = CASE WHEN ? IS NULL OR ? > session_runtime.native_observation_sequence THEN excluded.native_status ELSE session_runtime.native_status END,
        native_observation_sequence = CASE WHEN ? IS NOT NULL AND ? > session_runtime.native_observation_sequence THEN ? ELSE session_runtime.native_observation_sequence END`)
      .run(endpointId, threadId, mappingId, managementState, nativeStatus, observationSequence ?? 0,
        observationSequence ?? null, observationSequence ?? null,
        observationSequence ?? null, observationSequence ?? null, observationSequence ?? null);
  }

  getSession(endpointId: string, threadId: string, mappingId: string): { managementState: ManagementState; restoreState?: ManagementState; nativeStatus: string; nativeObservationSequence: number; deliveryCursor?: string } | undefined {
    const row = this.db.prepare("SELECT * FROM session_runtime WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?").get(endpointId, threadId, mappingId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      managementState: String(row.management_state) as ManagementState,
      ...(row.restore_state ? { restoreState: String(row.restore_state) as ManagementState } : {}),
      nativeStatus: String(row.native_status),
      nativeObservationSequence: Number(row.native_observation_sequence ?? 0),
      ...(row.delivery_cursor ? { deliveryCursor: String(row.delivery_cursor) } : {}),
    };
  }

  setActiveTurn(endpointId: string, threadId: string, mappingId: string, turnId: string | undefined, observationSequence?: number): boolean {
    if (observationSequence === undefined) {
      return this.db.prepare("UPDATE session_runtime SET active_turn_id = ?, native_status = ? WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?")
        .run(turnId ?? null, turnId ? "active" : "idle", endpointId, threadId, mappingId).changes === 1;
    }
    return this.db.prepare(`UPDATE session_runtime SET active_turn_id = ?, native_status = ?, native_observation_sequence = ?
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ? AND native_observation_sequence < ?`)
      .run(turnId ?? null, turnId ? "active" : "idle", observationSequence, endpointId, threadId, mappingId, observationSequence).changes === 1;
  }

  clearActiveTurn(endpointId: string, threadId: string, mappingId: string, turnId: string, observationSequence?: number): boolean {
    if (observationSequence === undefined) {
      return this.db.prepare(`UPDATE session_runtime SET active_turn_id = NULL, native_status = 'idle'
        WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ? AND active_turn_id = ?`)
        .run(endpointId, threadId, mappingId, turnId).changes === 1;
    }
    return this.db.prepare(`UPDATE session_runtime SET active_turn_id = NULL, native_status = 'idle', native_observation_sequence = ?
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ? AND active_turn_id = ? AND native_observation_sequence < ?`)
      .run(observationSequence, endpointId, threadId, mappingId, turnId, observationSequence).changes === 1;
  }

  reconcileNativeState(endpointId: string, threadId: string, mappingId: string, nativeStatus: string, activeTurnId?: string, observationSequence?: number): boolean {
    if (observationSequence === undefined) {
      return this.db.prepare("UPDATE session_runtime SET native_status = ?, active_turn_id = ? WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?")
        .run(nativeStatus, activeTurnId ?? null, endpointId, threadId, mappingId).changes === 1;
    }
    return this.db.prepare(`UPDATE session_runtime SET native_status = ?, active_turn_id = ?, native_observation_sequence = ?
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ? AND native_observation_sequence < ?`)
      .run(nativeStatus, activeTurnId ?? null, observationSequence, endpointId, threadId, mappingId, observationSequence).changes === 1;
  }

  activeTurn(endpointId: string, threadId: string, mappingId: string): string | undefined {
    const row = this.db.prepare("SELECT active_turn_id FROM session_runtime WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?").get(endpointId, threadId, mappingId) as { active_turn_id: string | null } | undefined;
    return row?.active_turn_id ?? undefined;
  }

  setDeliveryCursor(endpointId: string, threadId: string, mappingId: string, cursor: string): void {
    this.db.prepare("UPDATE session_runtime SET delivery_cursor = ? WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?").run(cursor, endpointId, threadId, mappingId);
  }

  setModel(endpointId: string, threadId: string, mappingId: string, model: string): void {
    this.db.prepare("UPDATE session_runtime SET model = ? WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?").run(model, endpointId, threadId, mappingId);
  }

  setEffort(endpointId: string, threadId: string, mappingId: string, effort: string): void {
    this.db.prepare("UPDATE session_runtime SET effort = ? WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?").run(effort, endpointId, threadId, mappingId);
  }

  settings(endpointId: string, threadId: string, mappingId: string): { model?: string; effort?: string } {
    const row = this.db.prepare("SELECT model, effort FROM session_runtime WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?").get(endpointId, threadId, mappingId) as { model: string | null; effort: string | null } | undefined;
    return row ? { ...(row.model ? { model: row.model } : {}), ...(row.effort ? { effort: row.effort } : {}) } : {};
  }

  consumeSettings(endpointId: string, threadId: string, mappingId: string, expected: { model?: string; effort?: string } = this.settings(endpointId, threadId, mappingId)): { model?: string; effort?: string } {
    return inTransaction(this.db, () => {
      if (Object.hasOwn(expected, "model")) {
        this.db.prepare("UPDATE session_runtime SET model = NULL WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ? AND model = ?")
          .run(endpointId, threadId, mappingId, expected.model ?? null);
      }
      if (Object.hasOwn(expected, "effort")) {
        this.db.prepare("UPDATE session_runtime SET effort = NULL WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ? AND effort = ?")
          .run(endpointId, threadId, mappingId, expected.effort ?? null);
      }
      return { ...expected };
    });
  }

  listSessions(): Array<{ endpointId: string; threadId: string; mappingId: string; managementState: ManagementState; restoreState?: ManagementState; nativeStatus: string; activeTurnId?: string }> {
    return (this.db.prepare("SELECT endpoint_id, thread_id, mapping_id, management_state, restore_state, native_status, active_turn_id FROM session_runtime").all() as Array<Record<string, unknown>>).map((row) => ({
      endpointId: String(row.endpoint_id), threadId: String(row.thread_id), mappingId: String(row.mapping_id), managementState: String(row.management_state) as ManagementState,
      ...(row.restore_state ? { restoreState: String(row.restore_state) as ManagementState } : {}),
      nativeStatus: String(row.native_status),
      ...(row.active_turn_id ? { activeTurnId: String(row.active_turn_id) } : {}),
    }));
  }

  beginEpoch(endpointId: string, threadId: string, mappingId: string, baselineTurnId: string | undefined, startedAt: number): string {
    const id = `epoch_${crypto.randomUUID()}`;
    this.db.prepare("INSERT INTO managed_epochs(id, endpoint_id, thread_id, mapping_id, baseline_turn_id, started_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, endpointId, threadId, mappingId, baselineTurnId ?? null, startedAt);
    return id;
  }

  endEpoch(endpointId: string, threadId: string, mappingId: string, endedAt: number): void {
    this.db.prepare("UPDATE managed_epochs SET ended_at = ? WHERE id = (SELECT id FROM managed_epochs WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1)")
      .run(endedAt, endpointId, threadId, mappingId);
  }

  currentEpoch(endpointId: string, threadId: string, mappingId: string): { id: string; baselineTurnId?: string; startedAt: number } | undefined {
    const row = this.db.prepare("SELECT * FROM managed_epochs WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1").get(endpointId, threadId, mappingId) as Record<string, unknown> | undefined;
    return row ? { id: String(row.id), ...(row.baseline_turn_id ? { baselineTurnId: String(row.baseline_turn_id) } : {}), startedAt: Number(row.started_at) } : undefined;
  }

  latestEpoch(endpointId: string, threadId: string, mappingId: string): { id: string; baselineTurnId?: string; startedAt: number; endedAt?: number } | undefined {
    const row = this.db.prepare("SELECT * FROM managed_epochs WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ? ORDER BY started_at DESC LIMIT 1").get(endpointId, threadId, mappingId) as Record<string, unknown> | undefined;
    return row ? { id: String(row.id), ...(row.baseline_turn_id ? { baselineTurnId: String(row.baseline_turn_id) } : {}), startedAt: Number(row.started_at), ...(row.ended_at ? { endedAt: Number(row.ended_at) } : {}) } : undefined;
  }
}
