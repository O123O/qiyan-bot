import type { SourceContext } from "../core/types.ts";
import type { Database } from "../storage/database.ts";
import type { DeliveryStore } from "../storage/delivery-store.ts";
import type { OperationStore } from "../storage/operation-store.ts";
import { inTransaction } from "../storage/database.ts";

export interface ActiveCoordinatorContext { contextId: string; attemptId: string; turnId: string; triggerKind: "user" | "internal" }

export class CoordinatorRuntime {
  private active: ActiveCoordinatorContext | undefined;

  constructor(private readonly db: Database, private readonly operations: OperationStore, private readonly deliveries: DeliveryStore, private readonly options: { destination: string }) {}

  beginUserAttempt(contextId: string, attemptId: string, turnId: string): void { this.begin(contextId, attemptId, turnId, "user"); }
  beginInternalAttempt(contextId: string, attemptId: string, turnId: string): void { this.begin(contextId, attemptId, turnId, "internal"); }

  prepareAttempt(contextId: string, attemptId: string, triggerKind: "user" | "internal"): void {
    const provisionalTurnId = `pending:${attemptId}`;
    inTransaction(this.db, () => {
      this.db.prepare(`INSERT OR REPLACE INTO coordinator_attempts(id, context_id, turn_id, trigger_kind, state, created_at)
        VALUES (?, ?, ?, ?, 'active', ?)`)
        .run(attemptId, contextId, provisionalTurnId, triggerKind, Date.now());
      this.operations.setSourceState(contextId, "active");
      this.db.prepare("UPDATE event_batches SET state = 'active' WHERE id = ?").run(contextId);
    });
    this.active = { contextId, attemptId, turnId: provisionalTurnId, triggerKind };
  }

  bindTurn(attemptId: string, turnId: string): void {
    this.db.prepare("UPDATE coordinator_attempts SET turn_id = ? WHERE id = ? AND state = 'active'").run(turnId, attemptId);
    if (this.active?.attemptId === attemptId) this.active = { ...this.active, turnId };
  }

  current(): ActiveCoordinatorContext | undefined { return this.active ? { ...this.active } : undefined; }

  abandonActive(turnId: string): void {
    if (this.active?.turnId === turnId) this.active = undefined;
  }

  contextForTurn(turnId: string): ActiveCoordinatorContext | undefined {
    const attempt = this.attempt(turnId);
    return attempt ? { ...attempt } : undefined;
  }

  activeAttempts(): ActiveCoordinatorContext[] {
    return (this.db.prepare("SELECT context_id, id, turn_id, trigger_kind FROM coordinator_attempts WHERE state = 'active' ORDER BY created_at, id").all() as Array<Record<string, unknown>>).map((row) => ({
      contextId: String(row.context_id),
      attemptId: String(row.id),
      turnId: String(row.turn_id),
      triggerKind: String(row.trigger_kind) as "user" | "internal",
    }));
  }

  handleTerminal(turnId: string, finalText?: string): void {
    const attempt = this.attempt(turnId);
    if (!attempt) return;
    inTransaction(this.db, () => {
      this.db.prepare("UPDATE coordinator_attempts SET state = 'completed' WHERE turn_id = ?").run(turnId);
      this.operations.setSourceState(attempt.contextId, "completed");
      this.finalizeEventBatch(attempt.contextId, "processed");
      this.releaseSourceAttachments(attempt.contextId);
      if (attempt.triggerKind === "user" && finalText) {
        this.deliveries.prepare({ id: `coordinator:${turnId}`, kind: "coordinator_final", destination: this.options.destination, body: `[coordinator] ${finalText}`, mandatory: true });
      }
    });
    if (this.active?.turnId === turnId) this.active = undefined;
  }

  failAttempt(turnId: string, error: unknown): SourceContext | undefined {
    const attempt = this.attempt(turnId);
    if (!attempt) return undefined;
    const recovery = inTransaction(this.db, () => {
      const effects = this.db.prepare(`SELECT id, state, receipt_json FROM operations
        WHERE context_id = ? AND attempt_id = ?
          AND state IN ('dispatched','succeeded','uncertain')
          AND kind NOT IN ('list_managed_sessions','discover_sessions','get_session_status','read_worker_message','list_models','get_goal')`)
        .all(attempt.contextId, attempt.attemptId) as Array<Record<string, unknown>>;
      this.db.prepare("UPDATE coordinator_attempts SET state = 'failed' WHERE turn_id = ?").run(turnId);
      if (effects.length === 0) {
        this.operations.setSourceState(attempt.contextId, "pending");
        this.db.prepare("UPDATE event_batches SET state = 'pending' WHERE id = ?").run(attempt.contextId);
        return undefined;
      }
      const created = this.operations.supersedeWithRecoveryInTransaction(attempt.contextId, effects.map((effect) => ({
        operationId: String(effect.id),
        state: effect.state === "succeeded" ? "succeeded" : "uncertain",
        ...(effect.receipt_json ? { receipt: JSON.parse(String(effect.receipt_json)) } : {}),
        error: String(error),
      })));
      this.finalizeEventBatch(attempt.contextId, "superseded");
      this.releaseSourceAttachments(attempt.contextId);
      return created;
    });
    if (this.active?.turnId === turnId) this.active = undefined;
    return recovery;
  }

  private begin(contextId: string, attemptId: string, turnId: string, triggerKind: "user" | "internal"): void {
    this.prepareAttempt(contextId, attemptId, triggerKind);
    this.bindTurn(attemptId, turnId);
  }

  private attempt(turnId: string): ActiveCoordinatorContext | undefined {
    const row = this.db.prepare("SELECT context_id, id, turn_id, trigger_kind FROM coordinator_attempts WHERE turn_id = ?").get(turnId) as Record<string, unknown> | undefined;
    return row ? { contextId: String(row.context_id), attemptId: String(row.id), turnId: String(row.turn_id), triggerKind: String(row.trigger_kind) as "user" | "internal" } : undefined;
  }

  private finalizeEventBatch(contextId: string, state: "processed" | "superseded"): void {
    const row = this.db.prepare("SELECT event_ids_json FROM event_batches WHERE id = ?").get(contextId) as { event_ids_json: string } | undefined;
    if (!row) return;
    const eventIds = JSON.parse(row.event_ids_json) as string[];
    if (eventIds.length > 0) {
      const placeholders = eventIds.map(() => "?").join(",");
      this.db.prepare(`UPDATE events SET state = ? WHERE id IN (${placeholders})`).run(state, ...eventIds);
    }
    this.db.prepare("UPDATE event_batches SET state = ? WHERE id = ?").run(state, contextId);
  }

  private releaseSourceAttachments(contextId: string): void {
    const inserted = this.db.prepare("INSERT OR IGNORE INTO source_attachment_releases(context_id, released_at) VALUES (?, ?)").run(contextId, Date.now()).changes;
    if (!inserted) return;
    const row = this.db.prepare("SELECT attachment_ids_json FROM source_contexts WHERE id = ?").get(contextId) as { attachment_ids_json: string } | undefined;
    for (const id of row ? JSON.parse(row.attachment_ids_json) as string[] : []) {
      this.db.prepare("UPDATE attachments SET ref_count = MAX(ref_count - 1, 0) WHERE id = ?").run(id);
    }
  }
}
