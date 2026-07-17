import { AppError } from "../core/errors.ts";
import {
  DashboardGoalSchema,
  DashboardTokenUsageSchema,
  LastSentSchema,
  LastWorkerEventSchema,
  ManagerNotesSchema,
  SessionNotesPatchSchema,
  toIsoTimestamp,
  type DashboardGoal,
  type DashboardTokenUsage,
  type LastSent,
  type LastWorkerEvent,
  type ManagerNotes,
  type SessionNotesPatch,
} from "../assistant/dashboard-schema.ts";
import type { Database } from "./database.ts";
import { inTransaction } from "./database.ts";

export interface DashboardIdentity { endpointId: string; threadId: string }
export interface DashboardNotification { sequence: number; endpointId: string; method: string; params: unknown; receivedAt: number }
export interface StoredSessionFacts {
  lastSent: LastSent | null;
  lastWorkerEvent: LastWorkerEvent | null;
  currentSettings: { model: string | null; effort: string | null; observedAt: number | null; observationSequence: number };
  tokenUsage: DashboardTokenUsage | null;
  goalObserved: boolean;
  goal: DashboardGoal | null;
  newestObservationAt: number | null;
}

const emptyNotes: ManagerNotes = {
  project_summary: null,
  supervision_objective: null,
  pending_follow_up: null,
  updated_at: null,
};

export class DashboardMetadataRecoveryRequiredError extends AppError {
  constructor() {
    super("CONFIGURATION_ERROR", "dashboard metadata requires automatic recovery");
    this.name = "DashboardMetadataRecoveryRequiredError";
  }
}

export function isDashboardMetadataRecoveryRequired(error: unknown): error is DashboardMetadataRecoveryRequiredError {
  return error instanceof DashboardMetadataRecoveryRequiredError;
}

export interface SessionDashboardStoreOptions {
  onMetadataRecoveryRequired?: () => void;
}

export class SessionDashboardStore {
  private recoveryRequested = false;
  private readonly changeListeners = new Set<() => void>();
  private changeScheduled = false;

  constructor(
    private readonly db: Database,
    private readonly options: SessionDashboardStoreOptions = {},
  ) {}

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  assertMetadataHealthy(): void {
    const rows = this.db.prepare("SELECT * FROM session_dashboard_meta").all() as Array<Record<string, unknown>>;
    const row = rows[0];
    if (
      rows.length !== 1
      || row?.singleton !== 1
      || (row.assistant_root !== null && typeof row.assistant_root !== "string")
      || !binary(row.dirty)
      || !nonnegativeInteger(row.revision)
      || !positiveInteger(row.next_observation_sequence)
      || (row.last_render_error !== null && typeof row.last_render_error !== "string")
      || !nonnegativeInteger(row.render_failure_generation)
    ) throw new DashboardMetadataRecoveryRequiredError();
  }

  allocateObservationSequence(): number {
    this.guardMetadata();
    return inTransaction(this.db, () => this.nextObservationSequence());
  }

  acceptNotification(endpointId: string, method: string, normalizedParams: unknown, receivedAt: number): number {
    this.guardMetadata();
    return inTransaction(this.db, () => {
      const sequence = this.nextObservationSequence();
      this.db.prepare(`INSERT INTO session_dashboard_notifications
        (sequence, endpoint_id, method, params_json, received_at) VALUES (?, ?, ?, ?, ?)`)
        .run(sequence, endpointId, method, JSON.stringify(normalizedParams), receivedAt);
      return sequence;
    });
  }

  pendingNotifications(endpointId?: string): DashboardNotification[] {
    const rows = (endpointId === undefined
      ? this.db.prepare("SELECT * FROM session_dashboard_notifications WHERE state = 'pending' ORDER BY sequence").all()
      : this.db.prepare("SELECT * FROM session_dashboard_notifications WHERE state = 'pending' AND endpoint_id = ? ORDER BY sequence").all(endpointId)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      endpointId: String(row.endpoint_id),
      method: String(row.method),
      params: JSON.parse(String(row.params_json)),
      receivedAt: Number(row.received_at),
    }));
  }

  completeNotification(sequence: number): void {
    this.db.prepare("UPDATE session_dashboard_notifications SET state = 'processed', error_json = NULL WHERE sequence = ? AND state = 'pending'").run(sequence);
  }

  failNotification(sequence: number, safeError: unknown): void {
    this.db.prepare("UPDATE session_dashboard_notifications SET state = 'failed', error_json = ? WHERE sequence = ? AND state = 'pending'")
      .run(JSON.stringify(safeError), sequence);
  }

  hydrateTurnOrder(identity: DashboardIdentity, turns: ReadonlyArray<{ id: string; startedAt: number | null }>): void {
    inTransaction(this.db, () => {
      const existing = this.db.prepare(`SELECT turn_id, started_at, turn_ordinal FROM session_turn_order
        WHERE endpoint_id = ? AND thread_id = ? ORDER BY turn_ordinal`).all(identity.endpointId, identity.threadId) as Array<{
          turn_id: string;
          started_at: number | null;
          turn_ordinal: number;
        }>;
      const existingById = new Map(existing.map((row) => [String(row.turn_id), row]));
      const ordered: Array<{ id: string; startedAt: number | null }> = [];
      const seen = new Set<string>();
      for (const turn of turns) {
        if (seen.has(turn.id)) continue;
        seen.add(turn.id);
        ordered.push({ id: turn.id, startedAt: turn.startedAt ?? existingById.get(turn.id)?.started_at ?? null });
      }
      for (const row of existing) {
        if (seen.has(row.turn_id)) continue;
        seen.add(row.turn_id);
        ordered.push({ id: row.turn_id, startedAt: row.started_at });
      }

      this.db.prepare("DELETE FROM session_turn_order WHERE endpoint_id = ? AND thread_id = ?")
        .run(identity.endpointId, identity.threadId);
      const insert = this.db.prepare(`INSERT INTO session_turn_order(endpoint_id, thread_id, turn_id, started_at, turn_ordinal)
        VALUES (?, ?, ?, ?, ?)`);
      const ordinalById = new Map<string, number>();
      ordered.forEach((turn, index) => {
        const ordinal = index + 1;
        insert.run(identity.endpointId, identity.threadId, turn.id, turn.startedAt, ordinal);
        ordinalById.set(turn.id, ordinal);
      });

      const facts = this.rawFacts(identity);
      if (!facts) return;
      const tokenTurnId = facts.token_turn_id === null ? undefined : String(facts.token_turn_id);
      const tokenOrdinal = tokenTurnId ? ordinalById.get(tokenTurnId) : undefined;
      let workerOrdinal: number | undefined;
      if (facts.last_worker_event_json !== null) {
        const worker = LastWorkerEventSchema.parse(JSON.parse(String(facts.last_worker_event_json)));
        workerOrdinal = ordinalById.get(worker.turn_id);
      }
      this.db.prepare(`UPDATE session_dashboard_facts SET
        token_turn_ordinal = CASE WHEN ? IS NULL THEN token_turn_ordinal ELSE ? END,
        last_worker_turn_ordinal = CASE WHEN ? IS NULL THEN last_worker_turn_ordinal ELSE ? END
        WHERE endpoint_id = ? AND thread_id = ?`)
        .run(tokenOrdinal ?? null, tokenOrdinal ?? null, workerOrdinal ?? null, workerOrdinal ?? null, identity.endpointId, identity.threadId);
    });
  }

  observeTurnStarted(identity: DashboardIdentity, turn: { id: string; startedAt: number | null }): number {
    return inTransaction(this.db, () => {
      const existing = this.db.prepare(`SELECT turn_ordinal FROM session_turn_order
        WHERE endpoint_id = ? AND thread_id = ? AND turn_id = ?`).get(identity.endpointId, identity.threadId, turn.id) as { turn_ordinal: number } | undefined;
      if (existing) return Number(existing.turn_ordinal);
      const row = this.db.prepare(`SELECT COALESCE(MAX(turn_ordinal), 0) + 1 AS value FROM session_turn_order
        WHERE endpoint_id = ? AND thread_id = ?`).get(identity.endpointId, identity.threadId) as { value: number };
      const ordinal = Number(row.value);
      this.db.prepare(`INSERT INTO session_turn_order(endpoint_id, thread_id, turn_id, started_at, turn_ordinal)
        VALUES (?, ?, ?, ?, ?)`)
        .run(identity.endpointId, identity.threadId, turn.id, turn.startedAt, ordinal);
      return ordinal;
    });
  }

  turnOrdinal(identity: DashboardIdentity, turnId: string): number | undefined {
    const row = this.db.prepare(`SELECT turn_ordinal FROM session_turn_order
      WHERE endpoint_id = ? AND thread_id = ? AND turn_id = ?`).get(identity.endpointId, identity.threadId, turnId) as { turn_ordinal: number } | undefined;
    return row ? Number(row.turn_ordinal) : undefined;
  }

  observeLastSent(identity: DashboardIdentity, value: LastSent, operationSequence: number): boolean {
    this.guardMetadata();
    const parsed = LastSentSchema.parse(value);
    this.ensureFacts(identity);
    const row = this.rawFacts(identity)!;
    if (row.last_sent_operation_sequence !== null && Number(row.last_sent_operation_sequence) >= operationSequence) return false;
    const observedAt = Date.parse(parsed.at);
    this.db.prepare(`UPDATE session_dashboard_facts SET last_sent_json = ?, last_sent_operation_sequence = ?,
      newest_observation_at = MAX(COALESCE(newest_observation_at, ?), ?) WHERE endpoint_id = ? AND thread_id = ?`)
      .run(JSON.stringify(parsed), operationSequence, observedAt, observedAt, identity.endpointId, identity.threadId);
    this.advanceRevision();
    return true;
  }

  observeLastWorkerEvent(identity: DashboardIdentity, value: LastWorkerEvent, turnOrdinal: number): boolean {
    this.guardMetadata();
    const parsed = LastWorkerEventSchema.parse(value);
    this.ensureFacts(identity);
    const row = this.rawFacts(identity)!;
    if (row.last_worker_turn_ordinal !== null && Number(row.last_worker_turn_ordinal) >= turnOrdinal) return false;
    const observedAt = Date.parse(parsed.at);
    this.db.prepare(`UPDATE session_dashboard_facts SET last_worker_event_json = ?, last_worker_turn_ordinal = ?,
      newest_observation_at = MAX(COALESCE(newest_observation_at, ?), ?) WHERE endpoint_id = ? AND thread_id = ?`)
      .run(JSON.stringify(parsed), turnOrdinal, observedAt, observedAt, identity.endpointId, identity.threadId);
    this.advanceRevision();
    return true;
  }

  observeCurrentSettings(
    identity: DashboardIdentity,
    value: { model?: string | null; effort?: string | null; observedAt: number },
    observationSequence: number,
  ): { valueChanged: boolean; watermarkAdvanced: boolean } {
    this.guardMetadata();
    this.ensureFacts(identity);
    const row = this.rawFacts(identity)!;
    const currentSequence = Number(row.current_settings_observation_sequence ?? 0);
    if (observationSequence <= currentSequence) return { valueChanged: false, watermarkAdvanced: false };
    const model = Object.hasOwn(value, "model") ? value.model ?? null : row.current_model === null ? null : String(row.current_model);
    const effort = Object.hasOwn(value, "effort") ? value.effort ?? null : row.current_effort === null ? null : String(row.current_effort);
    const valueChanged = model !== row.current_model || effort !== row.current_effort;
    if (valueChanged) {
      this.db.prepare(`UPDATE session_dashboard_facts SET current_model = ?, current_effort = ?, current_settings_observed_at = ?,
        current_settings_observation_sequence = ?, newest_observation_at = MAX(COALESCE(newest_observation_at, ?), ?)
        WHERE endpoint_id = ? AND thread_id = ?`)
        .run(model, effort, value.observedAt, observationSequence, value.observedAt, value.observedAt, identity.endpointId, identity.threadId);
      this.advanceRevision();
    } else {
      this.db.prepare(`UPDATE session_dashboard_facts SET current_settings_observation_sequence = ?
        WHERE endpoint_id = ? AND thread_id = ?`).run(observationSequence, identity.endpointId, identity.threadId);
    }
    return { valueChanged, watermarkAdvanced: true };
  }

  observeTokenUsage(identity: DashboardIdentity, turnId: string, value: DashboardTokenUsage, turnOrdinal: number, observationSequence: number): boolean {
    this.guardMetadata();
    const parsed = DashboardTokenUsageSchema.parse(value);
    this.ensureFacts(identity);
    const row = this.rawFacts(identity)!;
    const existingOrdinal = Number(row.token_turn_ordinal ?? 0);
    const existingSequence = Number(row.token_observation_sequence ?? 0);
    if (turnOrdinal < existingOrdinal || (turnOrdinal === existingOrdinal && observationSequence <= existingSequence)) return false;
    const observedAt = Date.parse(parsed.observed_at);
    this.db.prepare(`UPDATE session_dashboard_facts SET token_usage_json = ?, token_turn_id = ?, token_turn_ordinal = ?, token_observation_sequence = ?,
      newest_observation_at = MAX(COALESCE(newest_observation_at, ?), ?) WHERE endpoint_id = ? AND thread_id = ?`)
      .run(JSON.stringify(parsed), turnId, turnOrdinal, observationSequence, observedAt, observedAt, identity.endpointId, identity.threadId);
    this.advanceRevision();
    return true;
  }

  observeGoal(identity: DashboardIdentity, value: DashboardGoal | null, sourceTime: number, observationSequence: number, observedAt: number): boolean {
    this.guardMetadata();
    const parsed = value === null ? null : DashboardGoalSchema.parse(value);
    this.ensureFacts(identity);
    const row = this.rawFacts(identity)!;
    const existingTime = Number(row.goal_source_time ?? -1);
    const existingSequence = Number(row.goal_observation_sequence ?? 0);
    if (sourceTime < existingTime || (sourceTime === existingTime && observationSequence <= existingSequence)) return false;
    const serialized = JSON.stringify(parsed);
    const valueChanged = Number(row.goal_observed) !== 1 || String(row.goal_json) !== serialized;
    if (valueChanged) {
      this.db.prepare(`UPDATE session_dashboard_facts SET goal_json = ?, goal_observed = 1, goal_source_time = ?, goal_observation_sequence = ?,
        newest_observation_at = MAX(COALESCE(newest_observation_at, ?), ?) WHERE endpoint_id = ? AND thread_id = ?`)
        .run(serialized, sourceTime, observationSequence, observedAt, observedAt, identity.endpointId, identity.threadId);
      this.advanceRevision();
    } else {
      this.db.prepare(`UPDATE session_dashboard_facts SET goal_source_time = ?, goal_observation_sequence = ?
        WHERE endpoint_id = ? AND thread_id = ?`).run(sourceTime, observationSequence, identity.endpointId, identity.threadId);
    }
    return valueChanged;
  }

  updateNotes(identity: DashboardIdentity, operationId: string, patch: SessionNotesPatch, now: number): ManagerNotes {
    this.guardMetadata();
    const parsedPatch = SessionNotesPatchSchema.parse(patch);
    const patchJson = JSON.stringify(parsedPatch);
    return inTransaction(this.db, () => {
      const existing = this.db.prepare("SELECT * FROM session_note_operations WHERE operation_id = ?").get(operationId) as Record<string, unknown> | undefined;
      if (existing) {
        if (String(existing.endpoint_id) !== identity.endpointId || String(existing.thread_id) !== identity.threadId || String(existing.patch_json) !== patchJson) {
          throw new AppError("OPERATION_CONFLICT", "manager note operation identity or patch changed");
        }
        return ManagerNotesSchema.parse(JSON.parse(String(existing.result_json)));
      }
      const current = this.notes(identity);
      const result = ManagerNotesSchema.parse({
        project_summary: Object.hasOwn(parsedPatch, "project_summary") ? parsedPatch.project_summary ?? null : current.project_summary,
        supervision_objective: Object.hasOwn(parsedPatch, "supervision_objective") ? parsedPatch.supervision_objective ?? null : current.supervision_objective,
        pending_follow_up: Object.hasOwn(parsedPatch, "pending_follow_up") ? parsedPatch.pending_follow_up ?? null : current.pending_follow_up,
        updated_at: toIsoTimestamp(now),
      });
      this.writeNotes(identity, result, now);
      this.db.prepare(`INSERT INTO session_note_operations(operation_id, endpoint_id, thread_id, patch_json, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(operationId, identity.endpointId, identity.threadId, patchJson, JSON.stringify(result), now);
      this.advanceRevision();
      return result;
    });
  }

  noteOperationResult(operationId: string): ManagerNotes | undefined {
    const row = this.db.prepare("SELECT result_json FROM session_note_operations WHERE operation_id = ?").get(operationId) as { result_json: string } | undefined;
    return row ? ManagerNotesSchema.parse(JSON.parse(String(row.result_json))) : undefined;
  }

  facts(identity: DashboardIdentity): StoredSessionFacts {
    const row = this.rawFacts(identity);
    if (!row) return {
      lastSent: null,
      lastWorkerEvent: null,
      currentSettings: { model: null, effort: null, observedAt: null, observationSequence: 0 },
      tokenUsage: null,
      goalObserved: false,
      goal: null,
      newestObservationAt: null,
    };
    const goalObserved = Number(row.goal_observed) === 1;
    const goalValue = goalObserved ? JSON.parse(String(row.goal_json)) : null;
    return {
      lastSent: row.last_sent_json === null ? null : LastSentSchema.parse(JSON.parse(String(row.last_sent_json))),
      lastWorkerEvent: row.last_worker_event_json === null ? null : LastWorkerEventSchema.parse(JSON.parse(String(row.last_worker_event_json))),
      currentSettings: {
        model: row.current_model === null ? null : String(row.current_model),
        effort: row.current_effort === null ? null : String(row.current_effort),
        observedAt: row.current_settings_observed_at === null ? null : Number(row.current_settings_observed_at),
        observationSequence: Number(row.current_settings_observation_sequence ?? 0),
      },
      tokenUsage: row.token_usage_json === null ? null : DashboardTokenUsageSchema.parse(JSON.parse(String(row.token_usage_json))),
      goalObserved,
      goal: goalValue === null ? null : DashboardGoalSchema.parse(goalValue),
      newestObservationAt: row.newest_observation_at === null ? null : Number(row.newest_observation_at),
    };
  }

  notes(identity: DashboardIdentity): ManagerNotes {
    const row = this.db.prepare(`SELECT * FROM session_manager_notes WHERE endpoint_id = ? AND thread_id = ?`)
      .get(identity.endpointId, identity.threadId) as Record<string, unknown> | undefined;
    if (!row) return structuredClone(emptyNotes);
    return ManagerNotesSchema.parse({
      project_summary: row.project_summary === null ? null : String(row.project_summary),
      supervision_objective: row.supervision_objective === null ? null : String(row.supervision_objective),
      pending_follow_up: row.pending_follow_up === null ? null : String(row.pending_follow_up),
      updated_at: row.updated_at === null ? null : toIsoTimestamp(Number(row.updated_at)),
    });
  }

  claimAssistantRoot(canonicalRoot: string): void {
    this.guardMetadata();
    inTransaction(this.db, () => {
      const row = this.meta();
      if (row.assistant_root !== null && String(row.assistant_root) !== canonicalRoot) {
        throw new AppError("CONFIGURATION_ERROR", "dashboard database is claimed by a different assistant root");
      }
      if (row.assistant_root === null) this.db.prepare("UPDATE session_dashboard_meta SET assistant_root = ? WHERE singleton = 1").run(canonicalRoot);
    });
  }

  markDirty(): number {
    this.guardMetadata();
    this.advanceRevision();
    return Number(this.meta().revision);
  }

  renderState(): { dirty: boolean; revision: number; lastError: string | null; failureGeneration: number } {
    this.guardMetadata();
    const row = this.meta();
    return {
      dirty: Number(row.dirty) === 1,
      revision: Number(row.revision),
      lastError: row.last_render_error === null ? null : String(row.last_render_error),
      failureGeneration: Number(row.render_failure_generation),
    };
  }

  markRenderSucceeded(renderedRevision: number): void {
    this.guardMetadata();
    this.db.prepare(`UPDATE session_dashboard_meta SET dirty = 0, last_render_error = NULL
      WHERE singleton = 1 AND revision = ?`).run(renderedRevision);
  }

  markRenderFailed(safeMessage: string): { warningRequired: boolean; generation: number } {
    this.guardMetadata();
    return inTransaction(this.db, () => {
      const before = this.meta();
      const warningRequired = before.last_render_error === null;
      this.db.prepare(`UPDATE session_dashboard_meta SET dirty = 1, last_render_error = ?,
        render_failure_generation = render_failure_generation + ? WHERE singleton = 1`)
        .run(safeMessage, warningRequired ? 1 : 0);
      return { warningRequired, generation: Number(this.meta().render_failure_generation) };
    });
  }

  private rawFacts(identity: DashboardIdentity): Record<string, unknown> | undefined {
    return this.db.prepare(`SELECT * FROM session_dashboard_facts WHERE endpoint_id = ? AND thread_id = ?`)
      .get(identity.endpointId, identity.threadId) as Record<string, unknown> | undefined;
  }

  private ensureFacts(identity: DashboardIdentity): void {
    this.db.prepare("INSERT OR IGNORE INTO session_dashboard_facts(endpoint_id, thread_id) VALUES (?, ?)")
      .run(identity.endpointId, identity.threadId);
  }

  private writeNotes(identity: DashboardIdentity, notes: ManagerNotes, updatedAt: number): void {
    this.db.prepare(`INSERT INTO session_manager_notes(endpoint_id, thread_id, project_summary, supervision_objective, pending_follow_up, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint_id, thread_id) DO UPDATE SET project_summary = excluded.project_summary,
        supervision_objective = excluded.supervision_objective, pending_follow_up = excluded.pending_follow_up, updated_at = excluded.updated_at`)
      .run(identity.endpointId, identity.threadId, notes.project_summary, notes.supervision_objective, notes.pending_follow_up, updatedAt);
  }

  private advanceRevision(): void {
    this.db.prepare("UPDATE session_dashboard_meta SET dirty = 1, revision = revision + 1 WHERE singleton = 1").run();
    if (this.changeScheduled) return;
    this.changeScheduled = true;
    queueMicrotask(() => {
      this.changeScheduled = false;
      for (const listener of this.changeListeners) listener();
    });
  }

  private nextObservationSequence(): number {
    const row = this.db.prepare("SELECT next_observation_sequence AS value FROM session_dashboard_meta WHERE singleton = 1").get() as { value: number };
    const value = Number(row.value);
    this.db.prepare("UPDATE session_dashboard_meta SET next_observation_sequence = ? WHERE singleton = 1").run(value + 1);
    return value;
  }

  private meta(): Record<string, unknown> {
    return this.db.prepare("SELECT * FROM session_dashboard_meta WHERE singleton = 1").get() as Record<string, unknown>;
  }

  private guardMetadata(): void {
    try { this.assertMetadataHealthy(); }
    catch (error) {
      if (isDashboardMetadataRecoveryRequired(error) && !this.recoveryRequested) {
        this.recoveryRequested = true;
        try { this.options.onMetadataRecoveryRequired?.(); }
        catch { /* Recovery callback failure cannot replace the metadata error. */ }
      }
      throw error;
    }
  }
}

function binary(value: unknown): boolean {
  return value === 0 || value === 1;
}

function nonnegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
