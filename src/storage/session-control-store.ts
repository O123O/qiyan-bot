import type { Database } from "./database.ts";
import { inTransaction } from "./database.ts";

export interface PendingSessionSettings { model?: string; effort?: string }
export interface GoalControlState { controlled: boolean; known: boolean; observationSequence: number }

export class SessionControlStore {
  constructor(private readonly db: Database) {}

  setModel(endpointId: string, threadId: string, mappingId: string, model: string): void {
    this.ensure(endpointId, threadId, mappingId);
    this.db.prepare("UPDATE session_controls SET model = ? WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?")
      .run(model, endpointId, threadId, mappingId);
  }

  setEffort(endpointId: string, threadId: string, mappingId: string, effort: string): void {
    this.ensure(endpointId, threadId, mappingId);
    this.db.prepare("UPDATE session_controls SET effort = ? WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?")
      .run(effort, endpointId, threadId, mappingId);
  }

  settings(endpointId: string, threadId: string, mappingId: string): PendingSessionSettings {
    const row = this.db.prepare("SELECT model, effort FROM session_controls WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?")
      .get(endpointId, threadId, mappingId) as { model: string | null; effort: string | null } | undefined;
    return row ? { ...(row.model ? { model: row.model } : {}), ...(row.effort ? { effort: row.effort } : {}) } : {};
  }

  consumeSettings(
    endpointId: string,
    threadId: string,
    mappingId: string,
    expected: PendingSessionSettings = this.settings(endpointId, threadId, mappingId),
  ): PendingSessionSettings {
    return inTransaction(this.db, () => {
      if (Object.hasOwn(expected, "model")) {
        this.db.prepare("UPDATE session_controls SET model = NULL WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ? AND model = ?")
          .run(endpointId, threadId, mappingId, expected.model ?? null);
      }
      if (Object.hasOwn(expected, "effort")) {
        this.db.prepare("UPDATE session_controls SET effort = NULL WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ? AND effort = ?")
          .run(endpointId, threadId, mappingId, expected.effort ?? null);
      }
      return { ...expected };
    });
  }

  setGoalControlled(endpointId: string, threadId: string, mappingId: string, controlled: boolean, observationSequence = 0): void {
    this.ensure(endpointId, threadId, mappingId);
    this.db.prepare(`UPDATE session_controls SET goal_controlled = ?, goal_control_known = 1,
      goal_control_sequence = CASE WHEN ? = 1 THEN ? ELSE goal_control_sequence END
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
      .run(controlled ? 1 : 0, controlled ? 1 : 0, observationSequence, endpointId, threadId, mappingId);
  }

  goalControlled(endpointId: string, threadId: string, mappingId: string): boolean {
    return this.goalControl(endpointId, threadId, mappingId).controlled;
  }

  goalControl(endpointId: string, threadId: string, mappingId: string): GoalControlState {
    const row = this.db.prepare(`SELECT goal_controlled, goal_control_known, goal_control_sequence FROM session_controls
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`).get(endpointId, threadId, mappingId) as
      { goal_controlled: number; goal_control_known: number; goal_control_sequence: number } | undefined;
    return {
      controlled: Number(row?.goal_controlled ?? 0) === 1,
      known: row !== undefined && Number(row.goal_control_known) === 1,
      observationSequence: Number(row?.goal_control_sequence ?? 0),
    };
  }

  clearGoalControlledBefore(endpointId: string, threadId: string, mappingId: string, observationSequence: number): boolean {
    return this.db.prepare(`UPDATE session_controls SET goal_controlled = 0, goal_control_known = 1
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?
        AND goal_controlled = 1 AND goal_control_sequence < ?`)
      .run(endpointId, threadId, mappingId, observationSequence).changes === 1;
  }

  delete(endpointId: string, threadId: string, mappingId: string): void {
    this.db.prepare("DELETE FROM session_controls WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?")
      .run(endpointId, threadId, mappingId);
  }

  private ensure(endpointId: string, threadId: string, mappingId: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO session_controls(endpoint_id, thread_id, mapping_id)
      VALUES (?, ?, ?)`).run(endpointId, threadId, mappingId);
  }
}
