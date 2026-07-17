import { randomUUID } from "node:crypto";
import type { ConversationBinding, JsonValue } from "../chat-apps/shared/binding.ts";
import type { SourceContext } from "../core/types.ts";
import type { Database } from "../storage/database.ts";
import { inTransaction } from "../storage/database.ts";
import type { DeliveryStore } from "../storage/delivery-store.ts";
import type { OperationRecord, OperationStore } from "../storage/operation-store.ts";

export interface ActiveAssistantContext {
  attemptId: string;
  contextId: string;
  turnId?: string;
  triggerKind: "chat" | "internal";
  binding?: ConversationBinding;
  toolFence: number;
}

export function classifyAttemptEffects(operations: readonly Pick<OperationRecord, "effectClass" | "state">[]): boolean {
  return operations.some((operation) => operation.effectClass === "side_effecting"
    && new Set(["dispatched", "uncertain", "succeeded"]).has(operation.state));
}

const DEFAULT_MAX_EFFECT_FREE_ATTEMPTS = 3;

export class AssistantRuntime {
  private active: ActiveAssistantContext | undefined;
  private readonly activeTools = new Map<string, number>();
  private readonly toolWaiters = new Map<string, Set<() => void>>();
  private readonly allToolsWaiters = new Set<() => void>();
  private readonly ownerBinding: () => ConversationBinding;
  private readonly maxEffectFreeAttempts: number;

  constructor(
    private readonly db: Database,
    private readonly operations: OperationStore,
    private readonly deliveries: DeliveryStore,
    options: { binding: ConversationBinding | (() => ConversationBinding); maxEffectFreeAttempts?: number },
  ) {
    if (typeof options.binding === "function") this.ownerBinding = options.binding;
    else {
      const binding = options.binding;
      this.ownerBinding = () => binding;
    }
    this.maxEffectFreeAttempts = options.maxEffectFreeAttempts ?? DEFAULT_MAX_EFFECT_FREE_ATTEMPTS;
    if (!Number.isSafeInteger(this.maxEffectFreeAttempts) || this.maxEffectFreeAttempts < 1) {
      throw new RangeError("maxEffectFreeAttempts must be a positive integer");
    }
  }

  activateAttempt(attemptId: string): ActiveAssistantContext | undefined {
    const row = this.admissibleRow(attemptId);
    if (!row) {
      this.active = undefined;
      return undefined;
    }
    this.active = this.parseActive(row);
    return this.current();
  }

  clearActive(): void { this.active = undefined; }

  current(): ActiveAssistantContext | undefined {
    if (!this.active) return undefined;
    const row = this.admissibleRow(this.active.attemptId);
    if (!row) {
      this.active = undefined;
      return undefined;
    }
    this.active = this.parseActive(row);
    return { ...this.active };
  }

  abandonActive(turnId: string): void {
    if (this.active?.turnId === turnId) this.active = undefined;
  }

  contextForTurn(turnId: string): ActiveAssistantContext | undefined {
    const row = this.attemptRow(turnId);
    return row ? this.parseActive(row) : undefined;
  }

  activeAttempts(): ActiveAssistantContext[] {
    return (this.db.prepare(`SELECT a.id, a.context_id, a.turn_id, a.trigger_kind, a.adapter_id, a.conversation_key,
        a.destination_json, a.native_reply_json, a.tool_fence
      FROM assistant_attempts a
      WHERE a.state = 'active' ORDER BY a.created_at, a.id`).all() as Array<Record<string, unknown>>).map((row) => this.parseActive(row));
  }

  beginTerminalizing(turnId: string): ActiveAssistantContext | undefined {
    const row = this.attemptRow(turnId);
    if (!row) return undefined;
    return this.terminalizeAttempt(String(row.id), turnId);
  }

  fenceToolAdmission(): void {
    for (const attempt of this.activeAttempts()) this.terminalizeAttempt(attempt.attemptId, attempt.turnId);
  }

  private terminalizeAttempt(attemptId: string, turnId?: string): ActiveAssistantContext {
    return inTransaction(this.db, () => {
      this.db.prepare(`UPDATE assistant_attempts
        SET tool_fence = tool_fence + CASE WHEN accepting_tools = 1 THEN 1 ELSE 0 END, accepting_tools = 0
        WHERE id = ? AND state = 'active'`).run(attemptId);
      const refreshed = this.db.prepare("SELECT * FROM assistant_attempts WHERE id = ?").get(attemptId) as Record<string, unknown>;
      const active = this.parseActive(refreshed);
      if (this.active?.attemptId === attemptId) this.active = active;
      return active;
    });
  }

  registerTool(attemptId: string): number {
    if (this.active?.attemptId !== attemptId) {
      throw new Error("assistant attempt is not active in this process, is not accepting tools, or has terminalized");
    }
    const row = this.admissibleRow(attemptId);
    if (!row) throw new Error("assistant attempt is not accepting tools or has terminalized");
    this.activeTools.set(attemptId, (this.activeTools.get(attemptId) ?? 0) + 1);
    return Number(row.tool_fence);
  }

  hasActiveTools(attemptId: string): boolean {
    return (this.activeTools.get(attemptId) ?? 0) > 0;
  }

  finishTool(attemptId: string): void {
    const next = Math.max(0, (this.activeTools.get(attemptId) ?? 0) - 1);
    if (next > 0) this.activeTools.set(attemptId, next);
    else {
      this.activeTools.delete(attemptId);
      for (const resolve of this.toolWaiters.get(attemptId) ?? []) resolve();
      this.toolWaiters.delete(attemptId);
      if (this.activeTools.size === 0) {
        for (const resolve of this.allToolsWaiters) resolve();
        this.allToolsWaiters.clear();
      }
    }
  }

  async fenceTools(attemptId: string, timeoutMs: number): Promise<"settled" | "timed_out"> {
    if (!this.hasActiveTools(attemptId)) return "settled";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settleWaiter: (() => void) | undefined;
    const result = await Promise.race([
      new Promise<"settled">((resolve) => {
        settleWaiter = () => resolve("settled");
        const waiters = this.toolWaiters.get(attemptId) ?? new Set<() => void>();
        waiters.add(settleWaiter);
        this.toolWaiters.set(attemptId, waiters);
      }),
      new Promise<"timed_out">((resolve) => { timer = setTimeout(() => resolve("timed_out"), Math.max(0, timeoutMs)); }),
    ]);
    if (timer) clearTimeout(timer);
    if (settleWaiter) {
      this.toolWaiters.get(attemptId)?.delete(settleWaiter);
      if (this.toolWaiters.get(attemptId)?.size === 0) this.toolWaiters.delete(attemptId);
    }
    if (result === "timed_out" && this.hasActiveTools(attemptId)) {
      inTransaction(this.db, () => {
        this.operations.markAttemptOperationsUncertain(attemptId);
        this.db.prepare("UPDATE assistant_attempts SET accepting_tools = 0 WHERE id = ?").run(attemptId);
      });
    }
    return result;
  }

  async waitForTools(): Promise<void> {
    if (this.activeTools.size === 0) return;
    await new Promise<void>((resolve) => this.allToolsWaiters.add(resolve));
  }

  handleTerminal(turnId: string, status: "completed" | "failed" | "interrupted", finalText?: string, error?: unknown): { recoveryContextId?: string };
  handleTerminal(turnId: string, finalText?: string): { recoveryContextId?: string };
  handleTerminal(turnId: string, statusOrText: "completed" | "failed" | "interrupted" | string = "completed", finalText?: string, error?: unknown): { recoveryContextId?: string } {
    const isStatus = new Set(["completed", "failed", "interrupted"]).has(statusOrText);
    const status = (isStatus ? statusOrText : "completed") as "completed" | "failed" | "interrupted";
    const text = isStatus ? finalText : statusOrText;
    const attempt = this.attemptRow(turnId);
    if (!attempt) return {};
    if (String(attempt.state) !== "active") {
      const recovery = this.existingRecovery(String(attempt.id));
      return recovery ? { recoveryContextId: recovery } : {};
    }
    this.beginTerminalizing(turnId);
    this.operations.markAttemptOperationsUncertain(String(attempt.id));
    const missingChatFinal = status === "completed" && this.triggerKind(attempt) === "chat" && !text;
    const result = status === "completed" && !missingChatFinal
      ? this.completeAttempt(attempt, text)
      : this.failAttemptGroup(attempt, error ?? (missingChatFinal ? "assistant turn completed without a final response" : status));
    if (this.active?.attemptId === String(attempt.id)) this.active = undefined;
    return result;
  }

  failAttempt(turnId: string, error: unknown): SourceContext | undefined {
    const result = this.handleTerminal(turnId, "failed", undefined, error);
    return result.recoveryContextId ? this.operations.getSourceContext(result.recoveryContextId) : undefined;
  }

  private completeAttempt(attempt: Record<string, unknown>, finalText?: string): { recoveryContextId?: string } {
    const attemptId = String(attempt.id);
    const members = this.memberContextIds(attempt);
    inTransaction(this.db, () => {
      this.db.prepare("UPDATE assistant_attempts SET state = 'completed', accepting_tools = 0 WHERE id = ?").run(attemptId);
      this.db.prepare("UPDATE assistant_attempt_sources SET state = 'completed', updated_at = ? WHERE attempt_id = ? AND state = 'submitted'").run(Date.now(), attemptId);
      for (const contextId of members) {
        this.operations.setSourceState(contextId, "completed");
        this.finalizeEventBatch(contextId, "processed");
        this.releaseSourceAttachments(contextId);
      }
      if (this.triggerKind(attempt) === "chat" && finalText) {
        const binding = this.bindingForAttempt(attempt);
        if (!binding) throw new Error("chat assistant attempt is missing its immutable conversation binding");
        this.deliveries.prepare({ id: `assistant:${String(attempt.turn_id)}`, kind: "assistant_final", binding, body: finalText, mandatory: true });
      }
    });
    return {};
  }

  private failAttemptGroup(attempt: Record<string, unknown>, error: unknown): { recoveryContextId?: string } {
    const attemptId = String(attempt.id);
    const members = this.memberContextIds(attempt);
    const effects = this.operations.listForAttempt(attemptId);
    if (!classifyAttemptEffects(effects)) {
      const exhausted = new Set(members.filter((contextId) =>
        this.failedAttempts(contextId) + 1 >= this.maxEffectFreeAttempts));
      let warningBinding: ConversationBinding | undefined;
      inTransaction(this.db, () => {
        this.db.prepare("UPDATE assistant_attempts SET state = 'failed', accepting_tools = 0 WHERE id = ?").run(attemptId);
        this.db.prepare("UPDATE assistant_attempt_sources SET state = 'failed', updated_at = ? WHERE attempt_id = ? AND state NOT IN ('completed','superseded')").run(Date.now(), attemptId);
        for (const contextId of members) {
          if (!exhausted.has(contextId)) {
            this.operations.setSourceState(contextId, "pending");
            this.db.prepare("UPDATE event_batches SET state = 'pending' WHERE id = ?").run(contextId);
            continue;
          }
          this.operations.setSourceState(contextId, "completed");
          this.finalizeEventBatch(contextId, "processed");
          this.releaseSourceAttachments(contextId);
          warningBinding ??= this.bindingForAttempt(attempt) ?? this.ownerBinding();
          this.deliveries.prepare({
            id: `assistant-attempts-exhausted:${contextId}`,
            kind: "system_warning",
            binding: warningBinding,
            body: `[system] assistant work needs attention; automatic retry stopped after ${this.maxEffectFreeAttempts} failed attempts`,
            mandatory: true,
          });
        }
      });
      return {};
    }

    return inTransaction(this.db, () => {
      const recoveryId = `recovery_${randomUUID()}`;
      const binding = this.bindingForAttempt(attempt);
      const arrival = Number((this.db.prepare("SELECT next_value FROM arrival_sequence WHERE singleton = 1").get() as { next_value: number }).next_value);
      this.db.prepare("UPDATE arrival_sequence SET next_value = ? WHERE singleton = 1").run(arrival + 1);
      const receipts = effects.filter((operation) => operation.effectClass === "side_effecting" && new Set(["dispatched", "uncertain", "succeeded"]).has(operation.state))
        .map((operation) => ({ operationId: operation.id, state: operation.state, receipt: operation.receipt ?? null, error: String(error) }));
      this.db.prepare(`INSERT INTO source_contexts
        (id, kind, source_id, raw_text, attachment_ids_json, state, created_at, adapter_id, conversation_key,
          destination_json, native_reply_json, arrival_sequence, source_class, queue_notice_required)
        VALUES (?, 'recovery', ?, ?, '[]', 'pending', ?, ?, ?, ?, ?, ?, 'internal', 0)`)
        .run(recoveryId, String(attempt.context_id), JSON.stringify(receipts), Date.now(), binding?.adapterId ?? null, binding?.conversationKey ?? null,
          binding === undefined ? null : JSON.stringify(binding.destination), binding?.reply === undefined ? null : JSON.stringify(binding.reply), arrival);
      this.db.prepare("UPDATE assistant_attempts SET state = 'failed', accepting_tools = 0 WHERE id = ?").run(attemptId);
      this.db.prepare("UPDATE assistant_attempt_sources SET state = 'superseded', updated_at = ? WHERE attempt_id = ? AND state = 'submitted'").run(Date.now(), attemptId);
      for (const contextId of members) {
        this.db.prepare("UPDATE source_contexts SET state = 'superseded', superseded_by = ? WHERE id = ?").run(recoveryId, contextId);
        this.finalizeEventBatch(contextId, "superseded");
        this.releaseSourceAttachments(contextId);
      }
      return { recoveryContextId: recoveryId };
    });
  }

  private attemptRow(turnId: string): Record<string, unknown> | undefined {
    return this.db.prepare(`SELECT * FROM assistant_attempts WHERE turn_id = ?
      ORDER BY (state = 'active') DESC, created_at DESC, id DESC LIMIT 1`).get(turnId) as Record<string, unknown> | undefined;
  }

  private admissibleRow(attemptId?: string): Record<string, unknown> | undefined {
    return this.db.prepare(`SELECT a.id, a.context_id, a.turn_id, a.trigger_kind, a.adapter_id, a.conversation_key,
        a.destination_json, a.native_reply_json, a.tool_fence
      FROM assistant_attempts a
      WHERE a.state = 'active' AND a.accepting_tools = 1
        AND (? IS NULL OR a.id = ?)
        AND EXISTS (
          SELECT 1 FROM assistant_attempt_sources m
          WHERE m.attempt_id = a.id AND m.submission_kind = 'start'
            AND ((a.turn_id IS NULL AND m.state IN ('start_submitting', 'uncertain'))
              OR (a.turn_id IS NOT NULL AND m.state IN ('submitted', 'completed') AND m.observed_turn_id = a.turn_id))
        )
      ORDER BY a.created_at, a.id LIMIT 1`).get(attemptId ?? null, attemptId ?? null) as Record<string, unknown> | undefined;
  }

  private memberContextIds(attempt: Record<string, unknown>): string[] {
    const rows = this.db.prepare("SELECT context_id FROM assistant_attempt_sources WHERE attempt_id = ? AND state IN ('submitted','completed') ORDER BY source_ordinal")
      .all(String(attempt.id)) as Array<{ context_id: string }>;
    return rows.length > 0 ? rows.map((row) => row.context_id) : [String(attempt.context_id)];
  }

  private existingRecovery(attemptId: string): string | undefined {
    const row = this.db.prepare(`SELECT s.superseded_by FROM assistant_attempt_sources m JOIN source_contexts s ON s.id = m.context_id
      WHERE m.attempt_id = ? AND s.superseded_by IS NOT NULL LIMIT 1`).get(attemptId) as { superseded_by: string } | undefined;
    if (row) return row.superseded_by;
    const legacy = this.db.prepare(`SELECT s.superseded_by FROM assistant_attempts a JOIN source_contexts s ON s.id = a.context_id
      WHERE a.id = ? AND s.superseded_by IS NOT NULL`).get(attemptId) as { superseded_by: string } | undefined;
    return legacy?.superseded_by;
  }

  private failedAttempts(contextId: string): number {
    const row = this.db.prepare(`SELECT COUNT(DISTINCT a.id) AS count
      FROM assistant_attempt_sources member
      JOIN assistant_attempts a ON a.id = member.attempt_id
      WHERE member.context_id = ? AND a.state = 'failed'
        AND a.turn_id IS NOT NULL AND member.observed_turn_id = a.turn_id`).get(contextId) as { count: number };
    return Number(row.count);
  }

  private triggerKind(attempt: Record<string, unknown>): "chat" | "internal" {
    return attempt.trigger_kind === "user" ? "chat" : "internal";
  }

  private bindingForAttempt(attempt: Record<string, unknown>): ConversationBinding | undefined {
    if (attempt.adapter_id && attempt.conversation_key && attempt.destination_json) {
      return {
        adapterId: String(attempt.adapter_id),
        conversationKey: String(attempt.conversation_key),
        destination: JSON.parse(String(attempt.destination_json)) as JsonValue,
        ...(attempt.native_reply_json ? { reply: JSON.parse(String(attempt.native_reply_json)) as JsonValue } : {}),
      };
    }
    const sourceBinding = this.operations.getSourceContext(String(attempt.context_id))?.binding;
    if (sourceBinding) return sourceBinding;
    return undefined;
  }

  private parseActive(row: Record<string, unknown>): ActiveAssistantContext {
    return {
      attemptId: String(row.id),
      contextId: String(row.context_id),
      ...(row.turn_id == null ? {} : { turnId: String(row.turn_id) }),
      triggerKind: this.triggerKind(row),
      ...(this.bindingForAttempt(row) ? { binding: this.bindingForAttempt(row)! } : {}),
      toolFence: Number(row.tool_fence),
    };
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
