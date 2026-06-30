import { createHash, randomUUID } from "node:crypto";
import { AppError } from "../core/errors.ts";
import type { OperationState, SourceContext } from "../core/types.ts";
import type { Database } from "./database.ts";
import { inTransaction } from "./database.ts";

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
  state: OperationState;
  receipt?: unknown;
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
    return this.db.prepare(`INSERT OR IGNORE INTO source_contexts
      (id, kind, source_id, raw_text, attachment_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(context.id, context.kind, context.sourceId, context.rawText, JSON.stringify(context.attachmentIds), Date.now()).changes === 1;
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
      state: String(row.state) as "pending" | "active" | "completed" | "superseded",
      ...(row.superseded_by ? { supersededBy: String(row.superseded_by) } : {}),
    };
  }

  listPendingSourceContexts(kinds: readonly SourceContext["kind"][]): SourceContext[] {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT id FROM source_contexts WHERE state = 'pending' AND kind IN (${placeholders}) ORDER BY created_at, id`).all(...kinds) as Array<{ id: string }>;
    return rows.map((row) => this.getSourceContext(row.id)!).filter(Boolean);
  }

  setSourceState(id: string, state: "pending" | "active" | "completed" | "superseded"): void {
    this.db.prepare("UPDATE source_contexts SET state = ? WHERE id = ?").run(state, id);
  }

  prepare(input: { contextId: string; attemptId: string; callId: string; kind: string; args: unknown }): OperationRecord {
    const argsJson = canonical(input.args);
    const argsHash = hash(input.args);
    const existing = this.db.prepare(`SELECT id, state, args_hash, receipt_json FROM operations
      WHERE context_id = ? AND attempt_id = ? AND call_id = ? AND kind = ?`)
      .get(input.contextId, input.attemptId, input.callId, input.kind) as Record<string, unknown> | undefined;
    if (existing) {
      if (String(existing.args_hash) !== argsHash) {
        throw new AppError("OPERATION_CONFLICT", "OPERATION_CONFLICT: operation arguments changed");
      }
      return {
        id: String(existing.id),
        state: String(existing.state) as OperationState,
        ...(existing.receipt_json ? { receipt: JSON.parse(String(existing.receipt_json)) } : {}),
      };
    }
    const id = `op_${randomUUID()}`;
    const now = Date.now();
    this.db.prepare(`INSERT INTO operations
      (id, context_id, attempt_id, call_id, kind, args_hash, args_json, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`)
      .run(id, input.contextId, input.attemptId, input.callId, input.kind, argsHash, argsJson, now, now);
    return { id, state: "prepared" };
  }

  get(id: string): OperationRecord | undefined {
    const row = this.db.prepare("SELECT id, state, receipt_json FROM operations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? { id: String(row.id), state: String(row.state) as OperationState, ...(row.receipt_json ? { receipt: JSON.parse(String(row.receipt_json)) } : {}) } : undefined;
  }

  listRecoverable(): RecoverableOperation[] {
    return (this.db.prepare(`SELECT id, context_id, attempt_id, call_id, kind, args_json, state, receipt_json
      FROM operations WHERE state IN ('dispatched', 'uncertain') ORDER BY created_at, id`).all() as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      contextId: String(row.context_id),
      attemptId: String(row.attempt_id),
      callId: String(row.call_id),
      kind: String(row.kind),
      args: JSON.parse(String(row.args_json)),
      state: String(row.state) as OperationState,
      ...(row.receipt_json ? { receipt: JSON.parse(String(row.receipt_json)) } : {}),
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

  markDispatched(id: string): void {
    this.setState(id, "dispatched");
  }

  checkpoint(id: string, receipt: unknown): void {
    this.db.prepare("UPDATE operations SET receipt_json = ?, updated_at = ? WHERE id = ? AND state IN ('dispatched', 'uncertain')")
      .run(JSON.stringify(receipt), Date.now(), id);
  }

  succeed(id: string, receipt: unknown): void {
    this.db.prepare("UPDATE operations SET state = 'succeeded', receipt_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(receipt), Date.now(), id);
  }

  fail(id: string, error: unknown, uncertain = false): void {
    this.db.prepare("UPDATE operations SET state = ?, error_json = ?, updated_at = ? WHERE id = ?")
      .run(uncertain ? "uncertain" : "failed", JSON.stringify(error), Date.now(), id);
  }

  unbindDirective(operationId: string): void {
    this.db.prepare("DELETE FROM directive_consumptions WHERE operation_id = ?").run(operationId);
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
    };
    this.createSourceContext(recovery);
    this.db.prepare("UPDATE source_contexts SET state = 'superseded', superseded_by = ? WHERE id = ?").run(recovery.id, contextId);
    return recovery;
  }

  private setState(id: string, state: OperationState): void {
    this.db.prepare("UPDATE operations SET state = ?, updated_at = ? WHERE id = ?").run(state, Date.now(), id);
  }
}
