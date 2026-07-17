import { randomUUID } from "node:crypto";
import type { AttachmentStore, FileHandleId } from "../attachments/store.ts";
import type { ConversationBinding, JsonValue } from "../chat-apps/shared/binding.ts";
import { sameConversation } from "../chat-apps/shared/binding.ts";
import { AppError } from "../core/errors.ts";
import type { CanonicalChatSource, FailedAttachmentDescriptor, SourceContext } from "../core/types.ts";
import type { Database } from "./database.ts";
import { inTransaction } from "./database.ts";
import type { DeliveryStore } from "./delivery-store.ts";

export interface InternalSource {
  id: string;
  kind: "event_batch" | "recovery" | "direct_to" | "web_goal" | "system_notice";
  sourceId: string;
  rawText: string;
  attachmentIds: readonly string[];
  receivedAt: number;
  binding?: ConversationBinding;
}

export interface AssistantAttempt {
  attemptId: string;
  primaryContextId: string;
  binding?: ConversationBinding;
  turnId?: string;
  triggerKind: "chat" | "internal";
  acceptingTools: boolean;
}

export interface AttemptSource {
  attemptId: string;
  contextId: string;
  sourceOrdinal: number;
  clientUserMessageId: string;
  submissionKind: "start" | "steer";
  state: "pending" | "start_submitting" | "steer_submitting" | "uncertain" | "submitted" | "completed" | "failed" | "superseded";
  expectedTurnId?: string;
  observedTurnId?: string;
  baselineTurnId?: string | null;
}

export interface ReservedSubmission extends AttemptSource {
  rawText: string;
  attachmentIds: readonly string[];
  failedAttachments: readonly FailedAttachmentDescriptor[];
  binding?: ConversationBinding;
}

export interface ChatAcceptanceEffects { commitNativeCheckpoint?: () => void }

export type SubmissionConfirmation = "bound" | "already_same" | "already_terminal_same" | "conflict";

export type ReconciliationDecision =
  | { kind: "ready" }
  | { kind: "wait"; retryAt: number }
  | { kind: "needs_attention" };

export interface ConversationStoreOptions {
  now?(): number;
  reconciliationDeadlineMs?: number;
  reconciliationMaxAttempts?: number;
  reconciliationBaseMs?: number;
  ownerBinding?(): ConversationBinding;
}

export class ConversationStore {
  private readonly now: () => number;

  constructor(
    private readonly db: Database,
    private readonly deliveries: DeliveryStore,
    private readonly attachments?: AttachmentStore,
    private readonly options: ConversationStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  acceptChatSource(
    input: CanonicalChatSource,
    effects: ChatAcceptanceEffects = {},
    activeAttempt?: AssistantAttempt,
  ): { contextId: string; disposition: "pending" | "owner" | "queued" } {
    return inTransaction(this.db, () => {
      const duplicate = this.db.prepare("SELECT id FROM source_contexts WHERE adapter_id = ? AND source_id = ?")
        .get(input.binding.adapterId, input.nativeSourceId) as { id: string } | undefined;
      if (duplicate) {
        const source = this.source(duplicate.id);
        const disposition = this.disposition(source, activeAttempt);
        if (disposition === "queued") this.ensureQueueNotice(source);
        effects.commitNativeCheckpoint?.();
        return { contextId: source.id, disposition };
      }

      if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(input.binding.adapterId)) this.conflict("chat adapter identifier is invalid");

      const arrival = this.takeArrivalSequence();
      this.db.prepare(`INSERT INTO source_contexts
        (id, kind, source_id, raw_text, attachment_ids_json, state, created_at, adapter_id, conversation_key,
          destination_json, native_reply_json, arrival_sequence, source_class, queue_notice_required, failed_attachments_json)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 'chat', 0, ?)`)
        .run(input.id, input.binding.adapterId, input.nativeSourceId, input.rawText, JSON.stringify(input.attachmentIds), input.receivedAt,
          input.binding.adapterId, input.binding.conversationKey, JSON.stringify(input.binding.destination),
          input.binding.reply === undefined ? null : JSON.stringify(input.binding.reply), arrival, JSON.stringify(input.failedAttachments ?? []));
      this.attachments?.retainAcceptedSourceInTransaction(input.id, input.attachmentIds as readonly FileHandleId[]);
      this.db.prepare(`INSERT INTO latest_owner_route
        (singleton, adapter_id, conversation_key, destination_json, reply_json, source_context_id, accepted_at)
        VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          adapter_id = excluded.adapter_id,
          conversation_key = excluded.conversation_key,
          destination_json = excluded.destination_json,
          reply_json = excluded.reply_json,
          source_context_id = excluded.source_context_id,
          accepted_at = excluded.accepted_at`)
        .run(input.binding.adapterId, input.binding.conversationKey, JSON.stringify(input.binding.destination),
          input.binding.reply === undefined ? null : JSON.stringify(input.binding.reply), input.id, Date.now());
      const source = this.source(input.id);
      const disposition = this.disposition(source, activeAttempt);
      if (disposition === "queued") this.ensureQueueNotice(source);
      effects.commitNativeCheckpoint?.();
      return { contextId: input.id, disposition };
    });
  }

  hasChatSource(adapterId: string, nativeSourceId: string): boolean {
    return this.db.prepare("SELECT 1 FROM source_contexts WHERE adapter_id = ? AND source_id = ?").get(adapterId, nativeSourceId) !== undefined;
  }

  hasInternalSource(kind: InternalSource["kind"], sourceId: string): boolean {
    return this.db.prepare("SELECT 1 FROM source_contexts WHERE adapter_id IS NULL AND kind = ? AND source_id = ?").get(kind, sourceId) !== undefined;
  }

  // The owner↔QiYan conversation for the web UI's QiYan tab, oldest → newest. QiYan's side is the
  // `deliveries` outbox — everything the owner was actually sent: assistant replies, the backend's
  // "[worker] …" relays (delivered directly, so NOT in the assistant thread), and system notices —
  // merged with your inbound chat messages (source_class='chat'). The cursor is INCLUSIVE (`<=`) with a
  // stable-id tie-break (the caller dedups) so same-millisecond rows are never skipped; `created_at` is
  // millis but normalized defensively. Lease-free; the merge + pagination are one correct query.
  listOwnerConversation(before: number | undefined, limit: number): Array<{ id: string; role: "you" | "assistant"; body: string; at: number; deliveryKind?: string }> {
    const clamped = Math.max(1, Math.min(50, limit));
    const cursor = before !== undefined && Number.isFinite(before);
    const NORM = "(CASE WHEN created_at < 1000000000000 THEN created_at * 1000 ELSE created_at END)";
    const rows = this.db.prepare(`SELECT id, role, body, at, delivery_kind FROM (
        SELECT id AS id, 'assistant' AS role, body AS body, ${NORM} AS at, kind AS delivery_kind FROM deliveries
          WHERE kind <> 'queue_notice'${cursor ? ` AND ${NORM} <= ?` : ""}
        UNION ALL
        SELECT id AS id, 'you' AS role, raw_text AS body, ${NORM} AS at, NULL AS delivery_kind FROM source_contexts
          WHERE source_class = 'chat'${cursor ? ` AND ${NORM} <= ?` : ""}
      ) ORDER BY at DESC, id DESC LIMIT ?`)
      .all(...(cursor ? [before, before, clamped] : [clamped])) as Array<{ id: string; role: string; body: string; at: number; delivery_kind: string | null }>;
    return rows.reverse().map((row) => ({
      id: String(row.id), role: row.role === "you" ? "you" : "assistant", body: String(row.body), at: Number(row.at),
      ...(row.delivery_kind ? { deliveryKind: String(row.delivery_kind) } : {}),
    }));
  }

  createInternalSource(input: InternalSource): string {
    return inTransaction(this.db, () => {
      const existing = this.db.prepare("SELECT id FROM source_contexts WHERE adapter_id IS NULL AND kind = ? AND source_id = ?")
        .get(input.kind, input.sourceId) as { id: string } | undefined;
      if (existing) return existing.id;
      const arrival = this.takeArrivalSequence();
      this.db.prepare(`INSERT INTO source_contexts
        (id, kind, source_id, raw_text, attachment_ids_json, state, created_at, adapter_id, conversation_key,
          destination_json, native_reply_json, arrival_sequence, source_class, queue_notice_required)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, ?, 'internal', 0)`)
        .run(input.id, input.kind, input.sourceId, input.rawText, JSON.stringify(input.attachmentIds), input.receivedAt, arrival);
      return input.id;
    });
  }

  attempt(attemptId: string): AssistantAttempt | undefined {
    const row = this.attemptById(attemptId);
    return row ? this.parseAttempt(row) : undefined;
  }

  attemptForTurn(turnId: string): AssistantAttempt | undefined {
    const row = this.db.prepare(`SELECT * FROM assistant_attempts
      WHERE state = 'active' AND turn_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`).get(turnId) as Record<string, unknown> | undefined;
    return row ? this.parseAttempt(row) : undefined;
  }

  incompleteAttempts(): AssistantAttempt[] {
    return (this.db.prepare(`SELECT * FROM assistant_attempts
      WHERE state = 'active' ORDER BY created_at, id`).all() as Array<Record<string, unknown>>).map((row) => this.parseAttempt(row));
  }

  nextPendingCandidate(): { kind: "chat" | "internal"; contextId: string } | undefined {
    const row = this.db.prepare(`SELECT id, source_class FROM source_contexts
      WHERE state = 'pending' ORDER BY arrival_sequence, id LIMIT 1`).get() as { id: string; source_class: string } | undefined;
    return row ? { kind: row.source_class === "chat" ? "chat" : "internal", contextId: row.id } : undefined;
  }

  createAttempt(candidate: { kind: "chat" | "internal"; contextId: string }): AssistantAttempt {
    return inTransaction(this.db, () => this.createAttemptInTransaction(candidate));
  }

  materializeAndCreateEventAttempt(candidate: { batchId: string; eventIds: readonly string[]; payload: unknown; queuedAt: number }): AssistantAttempt {
    return inTransaction(this.db, () => {
      if (candidate.eventIds.length === 0) this.conflict("event batch is empty");
      const placeholders = candidate.eventIds.map(() => "?").join(",");
      const pending = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM events WHERE id IN (${placeholders}) AND state = 'pending'`)
        .get(...candidate.eventIds) as { count: number }).count);
      if (pending !== candidate.eventIds.length) this.conflict("event batch changed before materialization");
      const arrival = this.takeArrivalSequence();
      this.db.prepare(`INSERT INTO source_contexts
        (id, kind, source_id, raw_text, attachment_ids_json, state, created_at, adapter_id, conversation_key,
          destination_json, native_reply_json, arrival_sequence, source_class, queue_notice_required)
        VALUES (?, 'event_batch', ?, ?, '[]', 'pending', ?, NULL, NULL, NULL, NULL, ?, 'internal', 0)`)
        .run(candidate.batchId, candidate.batchId, JSON.stringify(candidate.payload), candidate.queuedAt, arrival);
      this.db.prepare("INSERT INTO event_batches(id, event_ids_json, state, created_at) VALUES (?, ?, 'pending', ?)")
        .run(candidate.batchId, JSON.stringify(candidate.eventIds), candidate.queuedAt);
      const changed = Number(this.db.prepare(`UPDATE events SET state = 'batched' WHERE id IN (${placeholders}) AND state = 'pending'`).run(...candidate.eventIds).changes);
      if (changed !== candidate.eventIds.length) this.conflict("event batch changed while materializing");
      return this.createAttemptInTransaction({ kind: "internal", contextId: candidate.batchId });
    });
  }

  reserveStart(attemptId: string, contextId: string): ReservedSubmission {
    return inTransaction(this.db, () => {
      const attempt = this.requiredAttempt(attemptId);
      if (attempt.turnId || attempt.primaryContextId !== contextId || !attempt.acceptingTools) {
        this.conflict("start reservation does not match the attempt");
      }
      this.assertNoUnresolvedSubmission(attempt.attemptId);
      return this.reserve(attempt, this.source(contextId), "start");
    });
  }

  reserveNextSteer(attemptId: string): ReservedSubmission | undefined {
    return inTransaction(this.db, () => {
      const attempt = this.requiredAttempt(attemptId);
      if (!attempt.turnId || !attempt.acceptingTools) this.conflict("attempt is not accepting steering");
      this.assertNoUnresolvedSubmission(attempt.attemptId);
      if (attempt.triggerKind !== "chat" || !attempt.binding) return undefined;
      const rows = this.db.prepare(`SELECT id FROM source_contexts
        WHERE state = 'pending' AND source_class = 'chat' AND adapter_id = ? AND conversation_key = ?
        ORDER BY arrival_sequence, id`).all(attempt.binding.adapterId, attempt.binding.conversationKey) as Array<{ id: string }>;
      const next = rows.map((row) => this.source(row.id)).find((source) => !this.membershipForSource(source.id));
      return next ? this.reserve(attempt, next, "steer") : undefined;
    });
  }

  confirmStart(attemptId: string, contextId: string, turnId: string, options: { terminal?: boolean } = {}): SubmissionConfirmation {
    return inTransaction(this.db, () => {
      const member = this.membersForAttempt(attemptId).find((candidate) => candidate.contextId === contextId);
      const attempt = this.db.prepare("SELECT * FROM assistant_attempts WHERE id = ?").get(attemptId) as Record<string, unknown> | undefined;
      if (!attempt || String(attempt.context_id) !== contextId || !member || member.submissionKind !== "start") return "conflict";
      if (String(attempt.state) !== "active") {
        const exactFinalizedStart = new Set(["completed", "failed"]).has(String(attempt.state))
          && new Set(["completed", "failed"]).has(member.state)
          && String(attempt.turn_id) === turnId
          && member.observedTurnId === turnId;
        return exactFinalizedStart ? "already_terminal_same" : "conflict";
      }
      const terminalizing = Number(attempt.accepting_tools) === 0;
      if (member.state === "submitted") {
        if (member.observedTurnId !== turnId || String(attempt.turn_id) !== turnId) return "conflict";
        if (options.terminal && !terminalizing) this.markAttemptTerminalizing(attemptId, turnId);
        return options.terminal || terminalizing ? "already_terminal_same" : "already_same";
      }
      if (!new Set(["start_submitting", "uncertain"]).has(member.state) || attempt.turn_id !== null
        || (attempt.turn_id !== null && String(attempt.turn_id) !== turnId)) return "conflict";
      const attemptChanged = this.db.prepare(`UPDATE assistant_attempts SET turn_id = ?
        WHERE id = ? AND state = 'active' AND (turn_id IS NULL OR turn_id = ?)`).run(turnId, attemptId, turnId).changes;
      if (attemptChanged !== 1) this.conflict("attempt changed while binding start");
      const memberChanged = this.db.prepare(`UPDATE assistant_attempt_sources SET state = 'submitted', observed_turn_id = ?, updated_at = ?
        WHERE attempt_id = ? AND context_id = ? AND submission_kind = 'start' AND state IN ('start_submitting', 'uncertain')`)
        .run(turnId, this.now(), attemptId, contextId).changes;
      if (memberChanged !== 1) this.conflict("submission changed while binding start");
      this.resolveReconciliation(attemptId, contextId);
      if (options.terminal) this.markAttemptTerminalizing(attemptId, turnId);
      return "bound";
    });
  }

  confirmSteer(attemptId: string, contextId: string, turnId: string): SubmissionConfirmation {
    return inTransaction(this.db, () => {
      const member = this.membersForAttempt(attemptId).find((candidate) => candidate.contextId === contextId);
      const attempt = this.attemptById(attemptId);
      if (!attempt || !member || member.submissionKind !== "steer") return "conflict";
      const terminalizing = Number(attempt.accepting_tools) === 0;
      if (member.state === "submitted") {
        if (member.observedTurnId !== turnId || member.expectedTurnId !== turnId || String(attempt.turn_id) !== turnId) return "conflict";
        return terminalizing ? "already_terminal_same" : "already_same";
      }
      if (!new Set(["steer_submitting", "uncertain"]).has(member.state)
        || attempt.turn_id === null || String(attempt.turn_id) !== turnId || member.expectedTurnId !== turnId) return "conflict";
      if (!attempt || String(attempt.turn_id) !== turnId) return "conflict";
      const changed = this.db.prepare(`UPDATE assistant_attempt_sources SET state = ?, observed_turn_id = ?, updated_at = ?
        WHERE attempt_id = ? AND context_id = ? AND submission_kind = 'steer' AND expected_turn_id = ?
          AND state IN ('steer_submitting', 'uncertain')`)
        .run(terminalizing ? "completed" : "submitted", turnId, this.now(), attemptId, contextId, turnId).changes;
      if (changed !== 1) this.conflict("submission changed while confirming steer");
      this.resolveReconciliation(attemptId, contextId);
      if (terminalizing) {
        this.db.prepare("UPDATE source_contexts SET state = 'completed' WHERE id = ? AND state = 'active'").run(contextId);
        this.finalizeEventBatch(contextId, "processed");
        this.releaseSourceAttachments(contextId);
      }
      return terminalizing ? "already_terminal_same" : "bound";
    });
  }

  markSubmitted(attemptId: string, contextId: string, turnId: string): void {
    const member = this.membersForAttempt(attemptId).find((candidate) => candidate.contextId === contextId);
    const result = member?.submissionKind === "start"
      ? this.confirmStart(attemptId, contextId, turnId)
      : this.confirmSteer(attemptId, contextId, turnId);
    if (result === "conflict") this.conflict("submission confirmation conflicts with the assistant attempt");
  }

  markUncertain(attemptId: string, contextId: string): void {
    if (!this.markUncertainIfUnresolved(attemptId, contextId)) this.conflict("submission cannot become uncertain");
  }

  beginReconciliation(attemptId: string, contextId: string): ReconciliationDecision {
    return inTransaction(this.db, () => {
      this.ensureReconciliation(attemptId, contextId);
      const row = this.db.prepare(`SELECT * FROM assistant_input_reconciliation
        WHERE attempt_id = ? AND context_id = ?`).get(attemptId, contextId) as Record<string, unknown> | undefined;
      if (!row || row.outcome !== "pending") {
        return row?.outcome === "needs_attention" ? { kind: "needs_attention" } : { kind: "wait", retryAt: this.now() };
      }
      const now = this.now();
      const attempts = Number(row.attempt_count);
      if (now >= Number(row.deadline_at) || attempts >= (this.options.reconciliationMaxAttempts ?? 6)) {
        this.markNeedsAttention(attemptId, contextId, now);
        return { kind: "needs_attention" };
      }
      if (now < Number(row.next_retry_at)) return { kind: "wait", retryAt: Number(row.next_retry_at) };
      const exponential = Math.min((this.options.reconciliationBaseMs ?? 1_000) * 2 ** attempts, 30_000);
      const delay = jitteredDelay(exponential, `${attemptId}\u0000${contextId}\u0000${attempts}`);
      this.db.prepare(`UPDATE assistant_input_reconciliation
        SET attempt_count = attempt_count + 1, next_retry_at = ?, updated_at = ?
        WHERE attempt_id = ? AND context_id = ? AND outcome = 'pending'`)
        .run(Math.min(Number(row.deadline_at), now + delay), now, attemptId, contextId);
      return { kind: "ready" };
    });
  }

  beginTerminalReconciliation(attemptId: string): ReconciliationDecision {
    return inTransaction(this.db, () => {
      const attempt = this.attemptById(attemptId);
      if (!attempt || attempt.state !== "active" || attempt.turn_id === null || Number(attempt.accepting_tools) !== 0) {
        return { kind: "wait", retryAt: this.now() };
      }
      const createdAt = this.now();
      const deadlineAt = createdAt + (this.options.reconciliationDeadlineMs ?? 5 * 60_000);
      this.db.prepare(`INSERT OR IGNORE INTO assistant_terminal_reconciliation
        (attempt_id, attempt_count, deadline_at, next_retry_at, outcome, created_at, updated_at)
        VALUES (?, 0, ?, ?, 'pending', ?, ?)`).run(attemptId, deadlineAt, createdAt, createdAt, this.now());
      const row = this.db.prepare("SELECT * FROM assistant_terminal_reconciliation WHERE attempt_id = ?").get(attemptId) as Record<string, unknown>;
      if (row.outcome !== "pending") {
        return { kind: "needs_attention" };
      }
      const now = this.now();
      const attempts = Number(row.attempt_count);
      if (now >= Number(row.deadline_at) || attempts >= (this.options.reconciliationMaxAttempts ?? 6)) {
        this.markTerminalNeedsAttention(attemptId, now);
        return { kind: "needs_attention" };
      }
      if (now < Number(row.next_retry_at)) return { kind: "wait", retryAt: Number(row.next_retry_at) };
      const exponential = Math.min((this.options.reconciliationBaseMs ?? 1_000) * 2 ** attempts, 30_000);
      const delay = jitteredDelay(exponential, `${attemptId}\u0000terminal\u0000${attempts}`);
      this.db.prepare(`UPDATE assistant_terminal_reconciliation
        SET attempt_count = attempt_count + 1, next_retry_at = ?, updated_at = ?
        WHERE attempt_id = ? AND outcome = 'pending'`)
        .run(Math.min(Number(row.deadline_at), now + delay), now, attemptId);
      return { kind: "ready" };
    });
  }

  terminalReconciliationRetryAt(attemptId: string): number | undefined {
    const row = this.db.prepare(`SELECT next_retry_at FROM assistant_terminal_reconciliation
      WHERE attempt_id = ? AND outcome = 'pending'`).get(attemptId) as { next_retry_at: number } | undefined;
    return row ? Number(row.next_retry_at) : undefined;
  }

  observeUnknownStartTerminal(attemptId: string, contextId: string): boolean {
    return inTransaction(this.db, () => {
      const member = this.membersForAttempt(attemptId).find((candidate) => candidate.contextId === contextId);
      const attempt = this.attemptById(attemptId);
      if (!attempt || String(attempt.context_id) !== contextId || attempt.turn_id !== null
        || !member || member.submissionKind !== "start"
        || !new Set(["start_submitting", "uncertain"]).has(member.state)) return false;
      const changed = this.db.prepare(`UPDATE assistant_attempt_sources SET state = 'uncertain', updated_at = ?
        WHERE attempt_id = ? AND context_id = ? AND submission_kind = 'start' AND state = 'start_submitting'`)
        .run(Date.now(), attemptId, contextId).changes;
      this.ensureReconciliation(attemptId, contextId);
      return changed === 1;
    });
  }

  markUncertainIfUnresolved(attemptId: string, contextId: string): boolean {
    return inTransaction(this.db, () => {
      const member = this.membersForAttempt(attemptId).find((candidate) => candidate.contextId === contextId);
      const attempt = this.attemptById(attemptId);
      if (!attempt || !member
        || !new Set(["start_submitting", "steer_submitting"]).has(member.state)) return false;
      const validStart = member.submissionKind === "start" && attempt.turn_id === null;
      const validSteer = member.submissionKind === "steer" && attempt.turn_id !== null
        && member.expectedTurnId === String(attempt.turn_id);
      if (!validStart && !validSteer) return false;
      const changed = this.db.prepare(`UPDATE assistant_attempt_sources SET state = 'uncertain', updated_at = ?
        WHERE attempt_id = ? AND context_id = ? AND state IN ('start_submitting', 'steer_submitting')`)
        .run(Date.now(), attemptId, contextId).changes;
      if (changed !== 1) this.conflict("submission changed while marking uncertainty");
      this.ensureReconciliation(attemptId, contextId);
      return true;
    });
  }

  restorePending(attemptId: string, contextId: string): void {
    inTransaction(this.db, () => {
      const changed = this.db.prepare(`UPDATE assistant_attempt_sources SET state = 'failed', updated_at = ?
        WHERE attempt_id = ? AND context_id = ? AND state IN ('start_submitting', 'steer_submitting', 'uncertain')`)
        .run(Date.now(), attemptId, contextId).changes;
      if (changed !== 1) this.conflict("submission cannot be restored");
      if (this.db.prepare("UPDATE source_contexts SET state = 'pending' WHERE id = ? AND state = 'active'").run(contextId).changes !== 1) {
        this.conflict("source cannot be restored");
      }
      this.db.prepare(`UPDATE assistant_input_reconciliation SET outcome = 'resolved', updated_at = ?
        WHERE attempt_id = ? AND context_id = ? AND outcome = 'pending'`).run(this.now(), attemptId, contextId);
    });
  }

  beginTerminalizing(attemptId: string, turnId: string): AssistantAttempt | undefined {
    return inTransaction(this.db, () => {
      const row = this.db.prepare("SELECT * FROM assistant_attempts WHERE id = ? AND state = 'active' AND turn_id = ?")
        .get(attemptId, turnId) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      this.markAttemptTerminalizing(attemptId, turnId);
      return this.attempt(attemptId);
    });
  }

  membersForAttempt(attemptId: string): AttemptSource[] {
    return (this.db.prepare("SELECT * FROM assistant_attempt_sources WHERE attempt_id = ? ORDER BY source_ordinal").all(attemptId) as Array<Record<string, unknown>>)
      .map((row) => this.parseMember(row));
  }

  submissionFor(attemptId: string, contextId: string): ReservedSubmission | undefined {
    const member = this.membersForAttempt(attemptId).find((candidate) => candidate.contextId === contextId);
    if (!member) return undefined;
    const source = this.source(contextId);
    return {
      ...member,
      rawText: source.rawText,
      attachmentIds: source.attachmentIds,
      failedAttachments: source.failedAttachments,
      ...(source.binding ? { binding: source.binding } : {}),
    };
  }

  checkpointSubmissionBaseline(attemptId: string, contextId: string, baselineTurnId: string | null): void {
    inTransaction(this.db, () => {
      const row = this.db.prepare(`SELECT baseline_recorded, baseline_turn_id FROM assistant_attempt_sources
        WHERE attempt_id = ? AND context_id = ? AND submission_kind = 'start'
          AND state IN ('start_submitting', 'uncertain')`).get(attemptId, contextId) as {
            baseline_recorded: number;
            baseline_turn_id: unknown;
          } | undefined;
      if (!row) this.conflict("assistant start submission is not awaiting a baseline checkpoint");
      if (Number(row.baseline_recorded) === 1) {
        const current = row.baseline_turn_id === null ? null : String(row.baseline_turn_id);
        if (current !== baselineTurnId) this.conflict("assistant start baseline changed");
        return;
      }
      const changed = this.db.prepare(`UPDATE assistant_attempt_sources
        SET baseline_turn_id = ?, baseline_recorded = 1, updated_at = ?
        WHERE attempt_id = ? AND context_id = ? AND submission_kind = 'start'
          AND state IN ('start_submitting', 'uncertain') AND baseline_recorded = 0`)
        .run(baselineTurnId, Date.now(), attemptId, contextId).changes;
      if (changed !== 1) this.conflict("assistant start baseline checkpoint raced");
    });
  }

  failUnstartedAttempt(attemptId: string): void {
    inTransaction(this.db, () => {
      const current = this.attemptById(attemptId);
      if (!current) return;
      this.db.prepare(`UPDATE assistant_attempts SET state = 'failed'
        WHERE id = ? AND state = 'active'
          AND NOT EXISTS (SELECT 1 FROM assistant_attempt_sources WHERE attempt_id = ? AND state = 'submitted')`).run(attemptId, attemptId);
    });
  }

  unresolvedSubmissions(): ReservedSubmission[] {
    const rows = this.db.prepare(`SELECT attempt_id, context_id FROM assistant_attempt_sources
      WHERE state IN ('start_submitting', 'steer_submitting', 'uncertain')
      ORDER BY created_at, attempt_id, source_ordinal`).all() as Array<{ attempt_id: string; context_id: string }>;
    return rows.map((row) => this.submissionFor(row.attempt_id, row.context_id)).filter((value): value is ReservedSubmission => value !== undefined);
  }

  reconciliationRetryAt(attemptId: string, contextId: string): number | undefined {
    const row = this.db.prepare(`SELECT next_retry_at FROM assistant_input_reconciliation
      WHERE attempt_id = ? AND context_id = ? AND outcome = 'pending'`).get(attemptId, contextId) as { next_retry_at: number } | undefined;
    return row ? Number(row.next_retry_at) : undefined;
  }

  failOrphanedUnstartedAttempts(): number {
    return Number(this.db.prepare(`UPDATE assistant_attempts SET state = 'failed', accepting_tools = 0
      WHERE state = 'active' AND turn_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM assistant_attempt_sources WHERE attempt_id = assistant_attempts.id)`).run().changes);
  }

  bindingForTurn(turnId: string): ConversationBinding | undefined {
    return this.attemptForTurn(turnId)?.binding;
  }

  repairQueueNotices(): number {
    return inTransaction(this.db, () => {
      const rows = this.db.prepare("SELECT id FROM source_contexts WHERE source_class = 'chat' AND queue_notice_required = 1 ORDER BY arrival_sequence, id")
        .all() as Array<{ id: string }>;
      let created = 0;
      for (const row of rows) if (this.ensureQueueNotice(this.source(row.id))) created += 1;
      return created;
    });
  }

  private disposition(source: StoredSource, activeAttempt?: AssistantAttempt): "pending" | "owner" | "queued" {
    if (!activeAttempt) return "pending";
    return activeAttempt.triggerKind === "chat" && activeAttempt.binding && source.binding
      && sameConversation(activeAttempt.binding, source.binding) ? "owner" : "queued";
  }

  private createAttemptInTransaction(candidate: { kind: "chat" | "internal"; contextId: string }): AssistantAttempt {
    const source = this.source(candidate.contextId);
    if (source.state !== "pending") this.conflict("attempt candidate is not pending");
    if ((source.sourceClass === "chat") !== (candidate.kind === "chat")) this.conflict("attempt candidate kind changed");
    if (candidate.kind === "chat" && !source.binding) this.conflict("chat attempt candidate has no binding");

    const attemptId = `attempt_${randomUUID()}`;
    const now = this.now();
    this.db.prepare(`INSERT INTO assistant_attempts
      (id, context_id, turn_id, trigger_kind, state, created_at, adapter_id, conversation_key, destination_json, native_reply_json)
      VALUES (?, ?, NULL, ?, 'active', ?, ?, ?, ?, ?)`)
      .run(attemptId, source.id, candidate.kind === "chat" ? "user" : "internal", now,
        source.binding?.adapterId ?? null, source.binding?.conversationKey ?? null,
        source.binding === undefined ? null : JSON.stringify(source.binding.destination),
        source.binding?.reply === undefined ? null : JSON.stringify(source.binding.reply));
    const pendingChats = this.db.prepare("SELECT id FROM source_contexts WHERE state = 'pending' AND source_class = 'chat' ORDER BY arrival_sequence, id")
      .all() as Array<{ id: string }>;
    for (const row of pendingChats) {
      const pendingChat = this.source(row.id);
      if (candidate.kind === "internal" || !source.binding || !pendingChat.binding || !sameConversation(source.binding, pendingChat.binding)) {
        this.ensureQueueNotice(pendingChat);
      }
    }
    return this.parseAttempt(this.attemptById(attemptId)!);
  }

  private ensureQueueNotice(source: StoredSource): boolean {
    if (!source.binding) this.conflict("queued chat source has no binding");
    this.db.prepare("UPDATE source_contexts SET queue_notice_required = 1 WHERE id = ?").run(source.id);
    if (this.deliveries.get(`queued:${source.id}`)) return false;
    this.deliveries.prepare({ id: `queued:${source.id}`, kind: "queue_notice", binding: source.binding, body: "[system] queued", mandatory: true });
    return true;
  }

  private reserve(attempt: AssistantAttempt, source: StoredSource, kind: "start" | "steer"): ReservedSubmission {
    if (source.state !== "pending") this.conflict("source is not pending");
    const ordinal = Number((this.db.prepare("SELECT COALESCE(MAX(source_ordinal), 0) + 1 AS ordinal FROM assistant_attempt_sources WHERE attempt_id = ?")
      .get(attempt.attemptId) as { ordinal: number }).ordinal);
    const clientUserMessageId = nativeSubmissionId(attempt.attemptId, ordinal);
    const now = this.now();
    this.db.prepare(`INSERT INTO assistant_attempt_sources
      (attempt_id, context_id, source_ordinal, client_user_message_id, submission_kind, state, expected_turn_id, observed_turn_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
      .run(attempt.attemptId, source.id, ordinal, clientUserMessageId, kind,
        kind === "start" ? "start_submitting" : "steer_submitting", kind === "steer" ? attempt.turnId ?? null : null, now, now);
    if (this.db.prepare("UPDATE source_contexts SET state = 'active' WHERE id = ? AND state = 'pending'").run(source.id).changes !== 1) {
      this.conflict("source changed while reserving submission");
    }
    return {
      ...this.membersForAttempt(attempt.attemptId).find((member) => member.contextId === source.id)!,
      rawText: source.rawText,
      attachmentIds: source.attachmentIds,
      failedAttachments: source.failedAttachments,
      ...(source.binding ? { binding: source.binding } : {}),
    };
  }

  private assertNoUnresolvedSubmission(attemptId: string): void {
    const unresolved = this.db.prepare(`SELECT context_id FROM assistant_attempt_sources
      WHERE attempt_id = ? AND state IN ('start_submitting', 'steer_submitting', 'uncertain') LIMIT 1`).get(attemptId);
    if (unresolved) this.conflict("another native submission is unresolved");
  }

  private membershipForSource(contextId: string): AttemptSource | undefined {
    const row = this.db.prepare(`SELECT * FROM assistant_attempt_sources WHERE context_id = ?
      AND state IN ('start_submitting', 'steer_submitting', 'uncertain', 'submitted')`).get(contextId) as Record<string, unknown> | undefined;
    return row ? this.parseMember(row) : undefined;
  }

  private requiredAttempt(attemptId: string): AssistantAttempt {
    return this.attempt(attemptId) ?? this.conflict("assistant attempt is missing");
  }

  private source(id: string): StoredSource {
    const row = this.db.prepare("SELECT * FROM source_contexts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) this.conflict(`unknown source ${id}`);
    return {
      id: String(row.id),
      kind: String(row.kind) as SourceContext["kind"],
      sourceId: String(row.source_id),
      rawText: String(row.raw_text),
      attachmentIds: JSON.parse(String(row.attachment_ids_json)) as string[],
      failedAttachments: JSON.parse(String(row.failed_attachments_json ?? "[]")) as FailedAttachmentDescriptor[],
      state: String(row.state) as StoredSource["state"],
      sourceClass: String(row.source_class) as "chat" | "internal",
      arrivalSequence: Number(row.arrival_sequence),
      queueNoticeRequired: Number(row.queue_notice_required) === 1,
      ...(row.adapter_id && row.conversation_key && row.destination_json ? {
        binding: {
          adapterId: String(row.adapter_id),
          conversationKey: String(row.conversation_key),
          destination: JSON.parse(String(row.destination_json)) as JsonValue,
          ...(row.native_reply_json ? { reply: JSON.parse(String(row.native_reply_json)) as JsonValue } : {}),
        },
      } : {}),
    };
  }

  private takeArrivalSequence(): number {
    const row = this.db.prepare("SELECT next_value FROM arrival_sequence WHERE singleton = 1").get() as { next_value: number };
    const value = Number(row.next_value);
    this.db.prepare("UPDATE arrival_sequence SET next_value = ? WHERE singleton = 1").run(value + 1);
    return value;
  }

  private attemptById(attemptId: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM assistant_attempts WHERE id = ? AND state = 'active'").get(attemptId) as Record<string, unknown> | undefined;
  }

  private parseAttempt(row: Record<string, unknown>): AssistantAttempt {
    return {
      attemptId: String(row.id),
      primaryContextId: String(row.context_id),
      ...(row.adapter_id && row.conversation_key && row.destination_json ? {
        binding: {
          adapterId: String(row.adapter_id),
          conversationKey: String(row.conversation_key),
          destination: JSON.parse(String(row.destination_json)) as JsonValue,
          ...(row.native_reply_json ? { reply: JSON.parse(String(row.native_reply_json)) as JsonValue } : {}),
        },
      } : {}),
      ...(row.turn_id ? { turnId: String(row.turn_id) } : {}),
      triggerKind: row.trigger_kind === "user" ? "chat" : "internal",
      acceptingTools: Number(row.accepting_tools) === 1,
    };
  }

  private markAttemptTerminalizing(attemptId: string, turnId: string): void {
    this.db.prepare(`UPDATE assistant_attempts
      SET tool_fence = tool_fence + CASE WHEN accepting_tools = 1 THEN 1 ELSE 0 END, accepting_tools = 0
      WHERE id = ? AND state = 'active' AND turn_id = ?`).run(attemptId, turnId);
  }

  private ensureReconciliation(attemptId: string, contextId: string): void {
    const member = this.db.prepare(`SELECT created_at FROM assistant_attempt_sources
      WHERE attempt_id = ? AND context_id = ?`).get(attemptId, contextId) as { created_at: number } | undefined;
    if (!member) this.conflict("unknown assistant input reconciliation");
    const deadline = Number(member.created_at) + (this.options.reconciliationDeadlineMs ?? 5 * 60_000);
    this.db.prepare(`INSERT OR IGNORE INTO assistant_input_reconciliation
      (attempt_id, context_id, attempt_count, deadline_at, next_retry_at, outcome, created_at, updated_at)
      VALUES (?, ?, 0, ?, ?, 'pending', ?, ?)`)
      .run(attemptId, contextId, deadline, Number(member.created_at), Number(member.created_at), this.now());
  }

  private resolveReconciliation(attemptId: string, contextId: string): void {
    this.db.prepare(`UPDATE assistant_input_reconciliation SET outcome = 'resolved', updated_at = ?
      WHERE attempt_id = ? AND context_id = ? AND outcome = 'pending'`).run(this.now(), attemptId, contextId);
  }

  private markNeedsAttention(attemptId: string, contextId: string, now: number): void {
    const member = this.membersForAttempt(attemptId).find((candidate) => candidate.contextId === contextId);
    if (!member) this.conflict("unknown assistant input reconciliation");
    const source = this.source(contextId);
    this.db.prepare(`UPDATE assistant_input_reconciliation SET outcome = 'needs_attention', updated_at = ?
      WHERE attempt_id = ? AND context_id = ? AND outcome = 'pending'`).run(now, attemptId, contextId);
    this.db.prepare(`UPDATE assistant_attempt_sources SET state = 'failed', updated_at = ?
      WHERE attempt_id = ? AND context_id = ? AND state IN ('start_submitting', 'steer_submitting', 'uncertain')`)
      .run(now, attemptId, contextId);
    this.db.prepare("UPDATE source_contexts SET state = 'completed' WHERE id = ? AND state = 'active'").run(contextId);
    if (member.submissionKind === "start") {
      this.db.prepare("UPDATE assistant_attempts SET state = 'failed', accepting_tools = 0 WHERE id = ? AND state = 'active'").run(attemptId);
    }
    this.finalizeEventBatch(contextId, "processed");
    this.releaseSourceAttachments(contextId);
    const binding = source.binding ?? this.options.ownerBinding?.();
    if (binding) this.deliveries.prepare({
      id: `assistant-needs-attention:${contextId}`,
      kind: "system_warning",
      binding,
      body: "[system] assistant input needs attention; native submission could not be reconciled",
      mandatory: true,
    });
  }

  private markTerminalNeedsAttention(attemptId: string, now: number): void {
    const attempt = this.attemptById(attemptId);
    if (!attempt) return;
    const members = this.membersForAttempt(attemptId).filter((member) => member.state === "submitted");
    this.db.prepare(`UPDATE assistant_terminal_reconciliation SET outcome = 'needs_attention', updated_at = ?
      WHERE attempt_id = ? AND outcome = 'pending'`).run(now, attemptId);
    this.db.prepare("UPDATE assistant_attempts SET state = 'failed', accepting_tools = 0 WHERE id = ? AND state = 'active'").run(attemptId);
    this.db.prepare("UPDATE assistant_attempt_sources SET state = 'failed', updated_at = ? WHERE attempt_id = ? AND state = 'submitted'")
      .run(now, attemptId);
    for (const member of members) {
      this.db.prepare("UPDATE source_contexts SET state = 'completed' WHERE id = ? AND state = 'active'").run(member.contextId);
      this.finalizeEventBatch(member.contextId, "processed");
      this.releaseSourceAttachments(member.contextId);
    }
    const binding = this.parseAttempt(attempt).binding ?? this.options.ownerBinding?.();
    if (binding) this.deliveries.prepare({
      id: `assistant-terminal-needs-attention:${attemptId}`,
      kind: "system_warning",
      binding,
      body: "[system] assistant terminal response needs attention; finalization could not be reconciled",
      mandatory: true,
    });
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
    const inserted = this.db.prepare("INSERT OR IGNORE INTO source_attachment_releases(context_id, released_at) VALUES (?, ?)")
      .run(contextId, this.now()).changes;
    if (!inserted) return;
    const row = this.db.prepare("SELECT attachment_ids_json FROM source_contexts WHERE id = ?").get(contextId) as { attachment_ids_json: string } | undefined;
    for (const id of row ? JSON.parse(row.attachment_ids_json) as string[] : []) {
      this.db.prepare("UPDATE attachments SET ref_count = MAX(ref_count - 1, 0) WHERE id = ?").run(id);
    }
  }

  private parseMember(row: Record<string, unknown>): AttemptSource {
    return {
      attemptId: String(row.attempt_id),
      contextId: String(row.context_id),
      sourceOrdinal: Number(row.source_ordinal),
      clientUserMessageId: String(row.client_user_message_id),
      submissionKind: String(row.submission_kind) as "start" | "steer",
      state: String(row.state) as AttemptSource["state"],
      ...(row.expected_turn_id ? { expectedTurnId: String(row.expected_turn_id) } : {}),
      ...(row.observed_turn_id ? { observedTurnId: String(row.observed_turn_id) } : {}),
      ...(Number(row.baseline_recorded) === 1
        ? { baselineTurnId: row.baseline_turn_id === null ? null : String(row.baseline_turn_id) }
        : {}),
    };
  }

  private conflict(message: string): never {
    throw new AppError("OPERATION_CONFLICT", `OPERATION_CONFLICT: ${message}`);
  }
}

function jitteredDelay(delayMs: number, key: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  const factor = 0.8 + (hash / 0xffff_ffff) * 0.4;
  return Math.min(30_000, Math.max(1, Math.round(delayMs * factor)));
}

function nativeSubmissionId(attemptId: string, ordinal: number): string {
  return `qiyan:${attemptId}:${ordinal}`;
}

interface StoredSource {
  id: string;
  kind: SourceContext["kind"];
  sourceId: string;
  rawText: string;
  attachmentIds: readonly string[];
  failedAttachments: readonly FailedAttachmentDescriptor[];
  state: "held" | "pending" | "active" | "completed" | "superseded";
  sourceClass: "chat" | "internal";
  arrivalSequence: number;
  queueNoticeRequired: boolean;
  binding?: ConversationBinding;
}
