import { createHash, randomUUID } from "node:crypto";
import { AppError } from "../core/errors.ts";
import type { OperationState, SourceContext } from "../core/types.ts";
import type { Database } from "./database.ts";
import { inTransaction } from "./database.ts";

const readOnlyOperationKinds = new Set(["list_managed_sessions", "discover_sessions", "get_session_status", "read_worker_message", "list_models", "get_goal"]);
const currentRecoveryProtocol = 1;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export interface OperationRecord {
  id: string;
  contextId: string;
  attemptId: string;
  callId: string;
  kind: string;
  effectClass: "read_only" | "side_effecting";
  state: OperationState;
  createdAt: number;
  sequence: number;
  recoveryProtocol: number;
  receipt?: unknown;
  error?: unknown;
}

export interface RecoverableOperation extends OperationRecord {
  contextId: string;
  attemptId: string;
  callId: string;
  kind: string;
  args: any;
}

export class OperationStore {
  constructor(private readonly db: Database) {}

  createSourceContext(context: SourceContext): boolean {
    this.db.exec("SAVEPOINT create_source_context");
    try {
      const arrival = Number((this.db.prepare("SELECT next_value FROM arrival_sequence WHERE singleton = 1").get() as { next_value: number }).next_value);
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO source_contexts
        (id, kind, source_id, raw_text, attachment_ids_json, adapter_id, conversation_key, destination_json, native_reply_json,
          arrival_sequence, source_class, created_at, failed_attachments_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(context.id, context.kind, context.sourceId, context.rawText, JSON.stringify(context.attachmentIds),
          context.binding?.adapterId ?? null, context.binding?.conversationKey ?? null,
          context.binding === undefined ? null : JSON.stringify(context.binding.destination),
          context.binding?.reply === undefined ? null : JSON.stringify(context.binding.reply), arrival,
          context.kind === "telegram" || context.kind === "slack" ? "chat" : "internal", Date.now(), JSON.stringify(context.failedAttachments ?? [])).changes === 1;
      if (inserted) this.db.prepare("UPDATE arrival_sequence SET next_value = ? WHERE singleton = 1").run(arrival + 1);
      this.db.exec("RELEASE SAVEPOINT create_source_context");
      return inserted;
    } catch (error) {
      this.db.exec("ROLLBACK TO SAVEPOINT create_source_context; RELEASE SAVEPOINT create_source_context");
      throw error;
    }
  }

  getSourceContext(id: string): (SourceContext & { state: "pending" | "active" | "completed" | "superseded"; supersededBy?: string }) | undefined {
    const row = this.db.prepare("SELECT * FROM source_contexts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      kind: String(row.kind) as SourceContext["kind"],
      sourceId: String(row.source_id),
      rawText: String(row.raw_text),
      attachmentIds: JSON.parse(String(row.attachment_ids_json)) as string[],
      failedAttachments: JSON.parse(String(row.failed_attachments_json ?? "[]")),
      ...(row.adapter_id && row.conversation_key && row.destination_json ? {
        binding: {
          adapterId: String(row.adapter_id),
          conversationKey: String(row.conversation_key),
          destination: JSON.parse(String(row.destination_json)),
          ...(row.native_reply_json ? { reply: JSON.parse(String(row.native_reply_json)) } : {}),
        },
      } : {}),
      ...(row.arrival_sequence == null ? {} : { arrivalSequence: Number(row.arrival_sequence) }),
      queueNoticeRequired: Number(row.queue_notice_required) === 1,
      state: String(row.state) as "pending" | "active" | "completed" | "superseded",
      ...(row.superseded_by ? { supersededBy: String(row.superseded_by) } : {}),
    };
  }

  listPendingSourceContexts(kinds: readonly SourceContext["kind"][]): SourceContext[] {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT id FROM source_contexts WHERE state = 'pending' AND kind IN (${placeholders}) ORDER BY arrival_sequence, id`).all(...kinds) as Array<{ id: string }>;
    return rows.map((row) => this.getSourceContext(row.id)!).filter(Boolean);
  }

  setSourceState(id: string, state: "pending" | "active" | "completed" | "superseded"): void {
    this.db.prepare("UPDATE source_contexts SET state = ? WHERE id = ?").run(state, id);
  }

  prepare(input: { contextId: string; attemptId: string; callId: string; kind: string; args: unknown; effectClass?: "read_only" | "side_effecting"; toolFence?: number }): OperationRecord {
    if (input.toolFence !== undefined) this.assertToolFence(input.attemptId, input.toolFence);
    const argsJson = canonical(input.args);
    const argsHash = hash(input.args);
    const effectClass = input.effectClass ?? (readOnlyOperationKinds.has(input.kind) ? "read_only" : "side_effecting");
    const existing = this.db.prepare(`SELECT id, context_id, attempt_id, call_id, kind, effect_class, state, args_hash, receipt_json, error_json, created_at, sequence, recovery_protocol FROM operations
      WHERE context_id = ? AND attempt_id = ? AND call_id = ? AND kind = ?`)
      .get(input.contextId, input.attemptId, input.callId, input.kind) as Record<string, unknown> | undefined;
    if (existing) {
      if (String(existing.args_hash) !== argsHash) {
        throw new AppError("OPERATION_CONFLICT", "OPERATION_CONFLICT: operation arguments changed");
      }
      if (String(existing.effect_class) !== effectClass) throw new AppError("OPERATION_CONFLICT", "OPERATION_CONFLICT: operation effect class changed");
      return this.parseOperation(existing);
    }
    const id = `op_${randomUUID()}`;
    const now = Date.now();
    this.db.exec("SAVEPOINT prepare_operation");
    try {
      this.db.prepare(`INSERT INTO operations
        (id, context_id, attempt_id, call_id, kind, args_hash, args_json, state, created_at, updated_at, sequence, effect_class, recovery_protocol)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM operations), ?, ?)`)
        .run(id, input.contextId, input.attemptId, input.callId, input.kind, argsHash, argsJson, now, now, effectClass, currentRecoveryProtocol);
      const created = this.get(id);
      if (!created) throw new Error("operation insert was not persisted");
      if (created.recoveryProtocol !== currentRecoveryProtocol) throw new Error("operation recovery protocol was not persisted");
      this.db.exec("RELEASE SAVEPOINT prepare_operation");
      return created;
    } catch (error) {
      this.db.exec("ROLLBACK TO SAVEPOINT prepare_operation; RELEASE SAVEPOINT prepare_operation");
      throw error;
    }
  }

  get(id: string): OperationRecord | undefined {
    const row = this.db.prepare("SELECT id, context_id, attempt_id, call_id, kind, effect_class, state, receipt_json, error_json, created_at, sequence, recovery_protocol FROM operations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.parseOperation(row) : undefined;
  }

  listForAttempt(attemptId: string): OperationRecord[] {
    return (this.db.prepare(`SELECT id, context_id, attempt_id, call_id, kind, effect_class, state, receipt_json, error_json, created_at, sequence, recovery_protocol
      FROM operations WHERE attempt_id = ? ORDER BY sequence`).all(attemptId) as Array<Record<string, unknown>>).map((row) => this.parseOperation(row));
  }

  findForCall(attemptId: string, callId: string, kind: string): OperationRecord | undefined {
    const row = this.db.prepare(`SELECT id, context_id, attempt_id, call_id, kind, effect_class, state, receipt_json, error_json, created_at, sequence, recovery_protocol
      FROM operations WHERE attempt_id = ? AND call_id = ? AND kind = ?`).get(attemptId, callId, kind) as Record<string, unknown> | undefined;
    return row ? this.parseOperation(row) : undefined;
  }

  ownsWorkerTurn(turn: { turnId: string; clientId?: string }): boolean {
    const row = this.db.prepare(`SELECT 1 FROM operations
      WHERE kind = 'send_to_session' AND (
        (? IS NOT NULL AND context_id || ':' || call_id = ?)
        OR json_extract(receipt_json, '$.turnId') = ?
      ) LIMIT 1`).get(turn.clientId ?? null, turn.clientId ?? null, turn.turnId);
    return row !== undefined;
  }

  listRecoverable(): RecoverableOperation[] {
    return (this.db.prepare(`SELECT id, context_id, attempt_id, call_id, kind, args_json, effect_class, state, receipt_json, error_json, created_at, sequence, recovery_protocol
      FROM operations WHERE state IN ('dispatched', 'uncertain') ORDER BY created_at, id`).all() as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      contextId: String(row.context_id),
      attemptId: String(row.attempt_id),
      callId: String(row.call_id),
      kind: String(row.kind),
      effectClass: String(row.effect_class) as "read_only" | "side_effecting",
      args: JSON.parse(String(row.args_json)),
      state: String(row.state) as OperationState,
      createdAt: Number(row.created_at),
      sequence: Number(row.sequence),
      recoveryProtocol: Number(row.recovery_protocol),
      ...(row.receipt_json ? { receipt: JSON.parse(String(row.receipt_json)) } : {}),
      ...(row.error_json ? { error: JSON.parse(String(row.error_json)) } : {}),
    }));
  }

  replayDirective(contextId: string, kind: string, binding: unknown): OperationRecord | undefined {
    const row = this.db.prepare("SELECT kind, binding_hash, operation_id FROM directive_consumptions WHERE context_id = ?").get(contextId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if (String(row.kind) !== kind || String(row.binding_hash) !== hash(binding)) {
      throw new AppError("DIRECTIVE_ALREADY_CONSUMED", "directive authorization was already consumed with a different target, mode, or arguments");
    }
    return this.get(String(row.operation_id));
  }

  bindDirective(contextId: string, kind: string, binding: unknown, operationId: string): void {
    const replay = this.replayDirective(contextId, kind, binding);
    if (replay) return;
    this.db.prepare("INSERT INTO directive_consumptions(context_id, kind, binding_hash, operation_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(contextId, kind, hash(binding), operationId, Date.now());
  }

  markDispatched(id: string, toolFence?: number): void {
    this.transition(id, ["prepared"], "dispatched", toolFence);
  }

  checkpoint(id: string, receipt: unknown, toolFence?: number): void {
    const changed = toolFence === undefined
      ? this.db.prepare("UPDATE operations SET receipt_json = ?, updated_at = ? WHERE id = ? AND state IN ('dispatched', 'uncertain')").run(JSON.stringify(receipt), Date.now(), id).changes
      : this.db.prepare(`UPDATE operations SET receipt_json = ?, updated_at = ? WHERE id = ? AND state = 'dispatched'
          AND EXISTS (SELECT 1 FROM assistant_attempts a WHERE a.id = operations.attempt_id AND a.accepting_tools = 1 AND a.tool_fence = ?)`)
        .run(JSON.stringify(receipt), Date.now(), id, toolFence).changes;
    if (changed !== 1) this.uncertainTransition(id, "checkpoint");
  }

  succeed(id: string, receipt: unknown, toolFence?: number): void {
    const changed = toolFence === undefined
      ? this.db.prepare("UPDATE operations SET state = 'succeeded', receipt_json = ?, error_json = NULL, updated_at = ? WHERE id = ? AND state IN ('prepared','dispatched','uncertain')").run(JSON.stringify(receipt), Date.now(), id).changes
      : this.db.prepare(`UPDATE operations SET state = 'succeeded', receipt_json = ?, error_json = NULL, updated_at = ?
          WHERE id = ? AND state IN ('prepared','dispatched')
            AND EXISTS (SELECT 1 FROM assistant_attempts a WHERE a.id = operations.attempt_id AND a.accepting_tools = 1 AND a.tool_fence = ?)`)
        .run(JSON.stringify(receipt), Date.now(), id, toolFence).changes;
    if (changed !== 1) this.uncertainTransition(id, "success");
  }

  fail(id: string, error: unknown, uncertain = false, toolFence?: number): void {
    const state = uncertain ? "uncertain" : "failed";
    const changed = toolFence === undefined
      ? this.db.prepare("UPDATE operations SET state = ?, error_json = ?, updated_at = ? WHERE id = ? AND state IN ('prepared','dispatched','uncertain')").run(state, JSON.stringify(error), Date.now(), id).changes
      : this.db.prepare(`UPDATE operations SET state = ?, error_json = ?, updated_at = ?
          WHERE id = ? AND state IN ('prepared','dispatched')
            AND EXISTS (SELECT 1 FROM assistant_attempts a WHERE a.id = operations.attempt_id AND a.accepting_tools = 1 AND a.tool_fence = ?)`)
        .run(state, JSON.stringify(error), Date.now(), id, toolFence).changes;
    if (changed !== 1) this.uncertainTransition(id, "failure");
  }

  unbindDirective(operationId: string): void {
    this.db.prepare("DELETE FROM directive_consumptions WHERE operation_id = ?").run(operationId);
  }

  failAndUnbind(id: string, error: unknown, toolFence?: number): void {
    inTransaction(this.db, () => {
      this.fail(id, error, false, toolFence);
      this.unbindDirective(id);
    });
  }

  markAttemptOperationsUncertain(attemptId: string): number {
    return Number(this.db.prepare(`UPDATE operations SET state = 'uncertain', updated_at = ?
      WHERE attempt_id = ? AND state = 'dispatched'`).run(Date.now(), attemptId).changes);
  }

  supersedeWithRecovery(contextId: string, receipts: readonly unknown[]): SourceContext {
    return inTransaction(this.db, () => this.supersedeWithRecoveryInTransaction(contextId, receipts));
  }

  supersedeWithRecoveryInTransaction(contextId: string, receipts: readonly unknown[]): SourceContext {
    const source = this.getSourceContext(contextId);
    if (!source) throw new Error(`unknown source context ${contextId}`);
    if (source.supersededBy) return this.getSourceContext(source.supersededBy) ?? (() => { throw new Error("missing recovery context"); })();
    const recovery: SourceContext = {
      id: `recovery_${randomUUID()}`,
      kind: "recovery",
      sourceId: contextId,
      rawText: JSON.stringify(receipts),
      attachmentIds: [],
      ...(source.binding ? { binding: source.binding } : {}),
    };
    this.createSourceContext(recovery);
    this.db.prepare("UPDATE source_contexts SET state = 'superseded', superseded_by = ? WHERE id = ?").run(recovery.id, contextId);
    return recovery;
  }

  private setState(id: string, state: OperationState): void {
    this.db.prepare("UPDATE operations SET state = ?, updated_at = ? WHERE id = ?").run(state, Date.now(), id);
  }

  private transition(id: string, expected: readonly OperationState[], state: OperationState, toolFence?: number): void {
    const placeholders = expected.map(() => "?").join(",");
    const changed = toolFence === undefined
      ? this.db.prepare(`UPDATE operations SET state = ?, updated_at = ? WHERE id = ? AND state IN (${placeholders})`).run(state, Date.now(), id, ...expected).changes
      : this.db.prepare(`UPDATE operations SET state = ?, updated_at = ? WHERE id = ? AND state IN (${placeholders})
          AND EXISTS (SELECT 1 FROM assistant_attempts a WHERE a.id = operations.attempt_id AND a.accepting_tools = 1 AND a.tool_fence = ?)`)
        .run(state, Date.now(), id, ...expected, toolFence).changes;
    if (changed !== 1) this.uncertainTransition(id, state);
  }

  private assertToolFence(attemptId: string, toolFence: number): void {
    const row = this.db.prepare("SELECT accepting_tools, tool_fence FROM assistant_attempts WHERE id = ? AND state = 'active'").get(attemptId) as { accepting_tools: number; tool_fence: number } | undefined;
    if (!row || row.accepting_tools !== 1 || row.tool_fence !== toolFence) {
      throw new AppError("OPERATION_UNCERTAIN", "assistant attempt has terminalized and no longer accepts tool dispatch");
    }
  }

  private uncertainTransition(id: string, transition: string): never {
    throw new AppError("OPERATION_UNCERTAIN", `operation ${id} ${transition} was fenced or already terminalized`);
  }

  private parseOperation(row: Record<string, unknown>): OperationRecord {
    return {
      id: String(row.id),
      contextId: String(row.context_id),
      attemptId: String(row.attempt_id),
      callId: String(row.call_id),
      kind: String(row.kind),
      effectClass: String(row.effect_class) as "read_only" | "side_effecting",
      state: String(row.state) as OperationState,
      createdAt: Number(row.created_at),
      sequence: Number(row.sequence),
      recoveryProtocol: Number(row.recovery_protocol),
      ...(row.receipt_json ? { receipt: JSON.parse(String(row.receipt_json)) } : {}),
      ...(row.error_json ? { error: JSON.parse(String(row.error_json)) } : {}),
    };
  }
}
