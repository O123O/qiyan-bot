import { randomUUID } from "node:crypto";
import type { ConversationBinding, JsonValue } from "../chat/binding.ts";
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

export class AssistantRuntime {
  private active: ActiveAssistantContext | undefined;
  private readonly activeTools = new Map<string, number>();
  private readonly toolWaiters = new Map<string, Set<() => void>>();
  private readonly allToolsWaiters = new Set<() => void>();

  constructor(
    private readonly db: Database,
    private readonly operations: OperationStore,
    private readonly deliveries: DeliveryStore,
    _options: { binding: ConversationBinding | (() => ConversationBinding) },
  ) {}

  beginUserAttempt(contextId: string, attemptId: string, turnId: string): void { this.begin(contextId, attemptId, turnId, "chat"); }
  beginInternalAttempt(contextId: string, attemptId: string, turnId: string): void { this.begin(contextId, attemptId, turnId, "internal"); }

  prepareAttempt(contextId: string, attemptId: string, triggerKind: "user" | "internal" | "chat"): void {
    const provisionalTurnId = `pending:${attemptId}`;
    const source = this.operations.getSourceContext(contextId);
    inTransaction(this.db, () => {
      this.db.prepare(`INSERT OR IGNORE INTO assistant_attempts
        (id, context_id, turn_id, trigger_kind, state, created_at, adapter_id, conversation_key, destination_json, native_reply_json)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`)
        .run(attemptId, contextId, provisionalTurnId, triggerKind === "chat" ? "user" : triggerKind, Date.now(),
          source?.binding?.adapterId ?? null, source?.binding?.conversationKey ?? null,
          source?.binding === undefined ? null : JSON.stringify(source.binding.destination),
          source?.binding?.reply === undefined ? null : JSON.stringify(source.binding.reply));
      this.operations.setSourceState(contextId, "active");
      this.db.prepare("UPDATE event_batches SET state = 'active' WHERE id = ?").run(contextId);
    });
    this.active = {
      contextId,
      attemptId,
      turnId: provisionalTurnId,
      triggerKind: triggerKind === "user" ? "chat" : triggerKind,
      ...(source?.binding ? { binding: source.binding } : {}),
      toolFence: 0,
    };
  }

  bindTurn(attemptId: string, turnId: string): void {
    this.db.prepare("UPDATE assistant_attempts SET turn_id = ? WHERE id = ? AND state = 'active'").run(turnId, attemptId);
    if (this.active?.attemptId === attemptId) this.active = { ...this.active, turnId };
  }

  hydrateActive(): ActiveAssistantContext | undefined {
    const row = this.admissibleRow();
    if (!row) {
      this.active = undefined;
      return undefined;
    }
    this.active = this.parseActive(row);
    return this.current();
  }

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

  contextForLease(attemptId: string, turnId: string): ActiveAssistantContext | undefined {
    const row = this.db.prepare(`SELECT a.*, l.trigger_kind AS lease_trigger_kind FROM assistant_turn_lease l
      JOIN assistant_attempts a ON a.id = l.attempt_id
      WHERE l.singleton = 1 AND l.phase = 'terminalizing' AND l.attempt_id = ? AND l.turn_id = ?
        AND a.state = 'active' AND a.turn_id = ?`).get(attemptId, turnId, turnId) as Record<string, unknown> | undefined;
    return row ? this.parseActive(row) : undefined;
  }

  activeAttempts(): ActiveAssistantContext[] {
    return (this.db.prepare(`SELECT a.id, a.context_id, a.turn_id, a.trigger_kind, a.adapter_id, a.conversation_key,
        a.destination_json, a.native_reply_json, a.tool_fence, l.trigger_kind AS lease_trigger_kind
      FROM assistant_attempts a LEFT JOIN assistant_turn_lease l ON l.attempt_id = a.id
      WHERE a.state = 'active' ORDER BY a.created_at, a.id`).all() as Array<Record<string, unknown>>).map((row) => this.parseActive(row));
  }

  beginTerminalizing(turnId: string): ActiveAssistantContext | undefined {
    const row = this.attemptRow(turnId);
    if (!row) return undefined;
    return this.terminalizeAttempt(String(row.id), turnId);
  }

  beginLeaseTerminalizing(attemptId: string, turnId: string): ActiveAssistantContext | undefined {
    if (!this.contextForLease(attemptId, turnId)) return undefined;
    return this.terminalizeAttempt(attemptId, turnId);
  }

  fenceToolAdmission(): void {
    for (const attempt of this.activeAttempts()) this.terminalizeAttempt(attempt.attemptId, attempt.turnId);
  }

  private terminalizeAttempt(attemptId: string, turnId?: string): ActiveAssistantContext {
    return inTransaction(this.db, () => {
      this.db.prepare(`UPDATE assistant_attempts
        SET tool_fence = tool_fence + CASE WHEN accepting_tools = 1 THEN 1 ELSE 0 END, accepting_tools = 0
        WHERE id = ? AND state = 'active'`).run(attemptId);
      if (turnId) {
        this.db.prepare(`UPDATE assistant_turn_lease SET phase = 'terminalizing', steer_paused = 1, pause_reason = 'terminalizing'
          WHERE attempt_id = ? AND turn_id = ?`).run(attemptId, turnId);
      }
      const refreshed = this.db.prepare(`SELECT a.*, l.trigger_kind AS lease_trigger_kind FROM assistant_attempts a
        LEFT JOIN assistant_turn_lease l ON l.attempt_id = a.id WHERE a.id = ?`).get(attemptId) as Record<string, unknown>;
      const active = this.parseActive(refreshed);
      if (this.active?.attemptId === attemptId) this.active = active;
      return active;
    });
  }

  registerTool(attemptId: string): number {
    const row = this.admissibleRow(attemptId);
    if (!row) throw new Error("assistant attempt has no active assistant lease for tools or has terminalized");
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
    const unresolved = this.db.prepare(`SELECT context_id FROM assistant_attempt_sources
      WHERE attempt_id = ? AND state IN ('start_submitting', 'steer_submitting', 'uncertain') LIMIT 1`).get(String(attempt.id));
    if (unresolved) return {};
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
      this.db.prepare("DELETE FROM assistant_turn_lease WHERE attempt_id = ?").run(attemptId);
    });
    return {};
  }

  private failAttemptGroup(attempt: Record<string, unknown>, error: unknown): { recoveryContextId?: string } {
    const attemptId = String(attempt.id);
    const members = this.memberContextIds(attempt);
    const effects = this.operations.listForAttempt(attemptId);
    if (!classifyAttemptEffects(effects)) {
      inTransaction(this.db, () => {
        this.db.prepare("UPDATE assistant_attempts SET state = 'failed', accepting_tools = 0 WHERE id = ?").run(attemptId);
        this.db.prepare("UPDATE assistant_attempt_sources SET state = 'failed', updated_at = ? WHERE attempt_id = ? AND state NOT IN ('completed','superseded')").run(Date.now(), attemptId);
        for (const contextId of members) {
          this.operations.setSourceState(contextId, "pending");
          this.db.prepare("UPDATE event_batches SET state = 'pending' WHERE id = ?").run(contextId);
        }
        this.db.prepare("DELETE FROM assistant_turn_lease WHERE attempt_id = ?").run(attemptId);
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
      this.db.prepare("DELETE FROM assistant_turn_lease WHERE attempt_id = ?").run(attemptId);
      return { recoveryContextId: recoveryId };
    });
  }

  private begin(contextId: string, attemptId: string, turnId: string, triggerKind: "chat" | "internal"): void {
    this.prepareAttempt(contextId, attemptId, triggerKind);
    this.bindTurn(attemptId, turnId);
  }

  private attemptRow(turnId: string): Record<string, unknown> | undefined {
    return this.db.prepare(`SELECT a.*, l.trigger_kind AS lease_trigger_kind FROM assistant_attempts a
      LEFT JOIN assistant_turn_lease l ON l.attempt_id = a.id WHERE a.turn_id = ?
      ORDER BY (l.singleton IS NOT NULL) DESC, (a.state = 'active') DESC, a.created_at DESC, a.id DESC LIMIT 1`).get(turnId) as Record<string, unknown> | undefined;
  }

  private admissibleRow(attemptId?: string): Record<string, unknown> | undefined {
    return this.db.prepare(`SELECT a.id, a.context_id, a.turn_id, a.trigger_kind, a.adapter_id, a.conversation_key,
        a.destination_json, a.native_reply_json, a.tool_fence, l.trigger_kind AS lease_trigger_kind
      FROM assistant_turn_lease l JOIN assistant_attempts a ON a.id = l.attempt_id
      WHERE l.singleton = 1 AND a.state = 'active' AND a.accepting_tools = 1
        AND l.phase IN ('starting', 'active')
        AND ((l.phase = 'starting' AND l.turn_id IS NULL AND a.turn_id IS NULL)
          OR (l.phase = 'active' AND l.turn_id IS NOT NULL AND a.turn_id = l.turn_id))
        AND (? IS NULL OR a.id = ?)
      LIMIT 1`).get(attemptId ?? null, attemptId ?? null) as Record<string, unknown> | undefined;
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

  private triggerKind(attempt: Record<string, unknown>): "chat" | "internal" {
    return attempt.lease_trigger_kind === "chat" || attempt.trigger_kind === "user" ? "chat" : "internal";
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
