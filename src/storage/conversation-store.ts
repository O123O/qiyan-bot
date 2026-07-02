import { randomUUID } from "node:crypto";
import type { AttachmentStore, FileHandleId } from "../attachments/store.ts";
import type { ConversationBinding, JsonValue } from "../chat/binding.ts";
import { sameConversation } from "../chat/binding.ts";
import { AppError } from "../core/errors.ts";
import type { CanonicalChatSource, SourceContext } from "../core/types.ts";
import type { Database } from "./database.ts";
import { inTransaction } from "./database.ts";
import type { DeliveryStore } from "./delivery-store.ts";

export interface InternalSource {
  id: string;
  kind: "event_batch" | "recovery";
  sourceId: string;
  rawText: string;
  attachmentIds: readonly string[];
  receivedAt: number;
  binding?: ConversationBinding;
}

export interface AssistantLease {
  phase: "starting" | "active" | "terminalizing";
  attemptId: string;
  primaryContextId: string;
  binding?: ConversationBinding;
  clientUserMessageId: string;
  turnId?: string;
  triggerKind: "chat" | "internal";
  capacityClaimId: string;
  steerPaused: boolean;
  pauseReason?: string;
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
}

export interface ReservedSubmission extends AttemptSource {
  rawText: string;
  attachmentIds: readonly string[];
  binding?: ConversationBinding;
}

export class ConversationStore {
  constructor(
    private readonly db: Database,
    private readonly deliveries: DeliveryStore,
    private readonly attachments?: AttachmentStore,
  ) {}

  acceptChatSource(input: CanonicalChatSource, commitNativeCheckpoint?: () => void): { contextId: string; disposition: "pending" | "owner" | "queued" } {
    return inTransaction(this.db, () => {
      const duplicate = this.db.prepare("SELECT id FROM source_contexts WHERE adapter_id = ? AND source_id = ?")
        .get(input.binding.adapterId, input.nativeSourceId) as { id: string } | undefined;
      if (duplicate) {
        const source = this.source(duplicate.id);
        const disposition = this.disposition(source);
        if (disposition === "queued") this.ensureQueueNotice(source);
        commitNativeCheckpoint?.();
        return { contextId: source.id, disposition };
      }

      const arrival = this.takeArrivalSequence();
      this.db.prepare(`INSERT INTO source_contexts
        (id, kind, source_id, raw_text, attachment_ids_json, state, created_at, adapter_id, conversation_key,
          destination_json, native_reply_json, arrival_sequence, source_class, queue_notice_required)
        VALUES (?, 'telegram', ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 'chat', 0)`)
        .run(input.id, input.nativeSourceId, input.rawText, JSON.stringify(input.attachmentIds), input.receivedAt,
          input.binding.adapterId, input.binding.conversationKey, JSON.stringify(input.binding.destination),
          input.binding.reply === undefined ? null : JSON.stringify(input.binding.reply), arrival);
      this.attachments?.retainAcceptedSourceInTransaction(input.id, input.attachmentIds as readonly FileHandleId[]);
      const source = this.source(input.id);
      const disposition = this.disposition(source);
      if (disposition === "queued") this.ensureQueueNotice(source);
      commitNativeCheckpoint?.();
      return { contextId: input.id, disposition };
    });
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

  lease(): AssistantLease | undefined {
    const row = this.db.prepare("SELECT * FROM assistant_turn_lease WHERE singleton = 1").get() as Record<string, unknown> | undefined;
    return row ? this.parseLease(row) : undefined;
  }

  nextPendingCandidate(): { kind: "chat" | "internal"; contextId: string } | undefined {
    const row = this.db.prepare(`SELECT id, source_class FROM source_contexts
      WHERE state = 'pending' ORDER BY arrival_sequence, id LIMIT 1`).get() as { id: string; source_class: string } | undefined;
    return row ? { kind: row.source_class === "chat" ? "chat" : "internal", contextId: row.id } : undefined;
  }

  acquireLease(candidate: { kind: "chat" | "internal"; contextId: string }, capacityClaimId: string): AssistantLease {
    return inTransaction(this.db, () => {
      if (this.lease()) this.conflict("assistant lease already exists");
      const source = this.source(candidate.contextId);
      if (source.state !== "pending") this.conflict("lease candidate is not pending");
      if ((source.sourceClass === "chat") !== (candidate.kind === "chat")) this.conflict("lease candidate kind changed");
      if (candidate.kind === "chat" && !source.binding) this.conflict("chat lease candidate has no binding");

      const attemptId = `attempt_${randomUUID()}`;
      const clientUserMessageId = source.id;
      const now = Date.now();
      this.db.prepare(`INSERT INTO assistant_attempts
        (id, context_id, turn_id, trigger_kind, state, created_at, adapter_id, conversation_key, destination_json, native_reply_json)
        VALUES (?, ?, NULL, ?, 'active', ?, ?, ?, ?, ?)`)
        .run(attemptId, source.id, candidate.kind === "chat" ? "user" : "internal", now,
          source.binding?.adapterId ?? null, source.binding?.conversationKey ?? null,
          source.binding === undefined ? null : JSON.stringify(source.binding.destination),
          source.binding?.reply === undefined ? null : JSON.stringify(source.binding.reply));
      this.db.prepare(`INSERT INTO assistant_turn_lease
        (singleton, phase, attempt_id, primary_context_id, adapter_id, conversation_key, destination_json, native_reply_json,
          client_user_message_id, turn_id, trigger_kind, capacity_claim_id, steer_paused, pause_reason)
        VALUES (1, 'starting', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, NULL)`)
        .run(attemptId, source.id, source.binding?.adapterId ?? null, source.binding?.conversationKey ?? null,
          source.binding === undefined ? null : JSON.stringify(source.binding.destination),
          source.binding?.reply === undefined ? null : JSON.stringify(source.binding.reply),
          clientUserMessageId, candidate.kind, capacityClaimId);

      const pendingChats = this.db.prepare("SELECT id FROM source_contexts WHERE state = 'pending' AND source_class = 'chat' ORDER BY arrival_sequence, id")
        .all() as Array<{ id: string }>;
      for (const row of pendingChats) {
        const pending = this.source(row.id);
        if (candidate.kind === "internal" || !source.binding || !pending.binding || !sameConversation(source.binding, pending.binding)) {
          this.ensureQueueNotice(pending);
        }
      }
      return this.lease()!;
    });
  }

  reserveStart(contextId: string): ReservedSubmission {
    return inTransaction(this.db, () => {
      const lease = this.requiredLease();
      if (lease.phase !== "starting" || lease.primaryContextId !== contextId) this.conflict("start reservation does not match the lease");
      this.assertNoUnresolvedSubmission();
      return this.reserve(lease, this.source(contextId), "start", lease.clientUserMessageId);
    });
  }

  reserveNextSteer(attemptId: string): ReservedSubmission | undefined {
    return inTransaction(this.db, () => {
      const lease = this.requiredLease();
      if (lease.attemptId !== attemptId || lease.phase !== "active" || lease.steerPaused) this.conflict("attempt is not accepting steering");
      this.assertNoUnresolvedSubmission();
      if (!lease.binding) return undefined;
      const rows = this.db.prepare(`SELECT id FROM source_contexts
        WHERE state = 'pending' AND source_class = 'chat' AND adapter_id = ? AND conversation_key = ?
        ORDER BY arrival_sequence, id`).all(lease.binding.adapterId, lease.binding.conversationKey) as Array<{ id: string }>;
      const next = rows.map((row) => this.source(row.id)).find((source) => !this.membershipForSource(source.id));
      return next ? this.reserve(lease, next, "steer", next.id) : undefined;
    });
  }

  markSubmitted(attemptId: string, contextId: string, turnId: string): void {
    inTransaction(this.db, () => {
      const changed = this.db.prepare(`UPDATE assistant_attempt_sources SET state = 'submitted', observed_turn_id = ?, updated_at = ?
        WHERE attempt_id = ? AND context_id = ? AND state IN ('start_submitting', 'steer_submitting', 'uncertain')`)
        .run(turnId, Date.now(), attemptId, contextId).changes;
      if (changed !== 1) this.conflict("submission is no longer unresolved");
      this.db.prepare("UPDATE assistant_attempts SET turn_id = ? WHERE id = ?").run(turnId, attemptId);
      const leaseChanged = this.db.prepare(`UPDATE assistant_turn_lease
        SET phase = CASE WHEN phase = 'terminalizing' THEN phase ELSE 'active' END,
            turn_id = ?,
            steer_paused = CASE WHEN phase = 'terminalizing' THEN 1 ELSE 0 END,
            pause_reason = CASE WHEN phase = 'terminalizing' THEN pause_reason ELSE NULL END
        WHERE singleton = 1 AND attempt_id = ? AND (turn_id IS NULL OR turn_id = ?)`)
        .run(turnId, attemptId, turnId).changes;
      if (leaseChanged !== 1) this.conflict("lease changed while binding submission");
    });
  }

  markUncertain(attemptId: string, contextId: string): void {
    inTransaction(this.db, () => {
      const changed = this.db.prepare(`UPDATE assistant_attempt_sources SET state = 'uncertain', updated_at = ?
        WHERE attempt_id = ? AND context_id = ? AND state IN ('start_submitting', 'steer_submitting')`)
        .run(Date.now(), attemptId, contextId).changes;
      if (changed !== 1) this.conflict("submission cannot become uncertain");
      this.db.prepare("UPDATE assistant_turn_lease SET steer_paused = 1, pause_reason = 'submission_uncertain' WHERE attempt_id = ?").run(attemptId);
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
      this.db.prepare("UPDATE assistant_turn_lease SET steer_paused = 0, pause_reason = NULL WHERE attempt_id = ?").run(attemptId);
    });
  }

  pauseSteering(attemptId: string, reason: string): void {
    inTransaction(this.db, () => {
      if (this.db.prepare("UPDATE assistant_turn_lease SET steer_paused = 1, pause_reason = ? WHERE singleton = 1 AND attempt_id = ? AND phase = 'active'")
        .run(reason, attemptId).changes !== 1) this.conflict("attempt cannot pause steering");
    });
  }

  beginTerminalizing(turnId: string): AssistantLease | undefined {
    return inTransaction(this.db, () => {
      const current = this.lease();
      if (!current || current.turnId !== turnId) return undefined;
      if (current.phase === "terminalizing") return current;
      if (current.phase !== "active") this.conflict("lease is not active");
      if (this.db.prepare("UPDATE assistant_turn_lease SET phase = 'terminalizing', steer_paused = 1, pause_reason = 'terminalizing' WHERE singleton = 1 AND phase = 'active' AND turn_id = ?").run(turnId).changes !== 1) {
        this.conflict("lease changed before terminalization");
      }
      return this.lease();
    });
  }

  membersForAttempt(attemptId: string): AttemptSource[] {
    return (this.db.prepare("SELECT * FROM assistant_attempt_sources WHERE attempt_id = ? ORDER BY source_ordinal").all(attemptId) as Array<Record<string, unknown>>)
      .map((row) => this.parseMember(row));
  }

  clearLease(attemptId: string): void {
    inTransaction(this.db, () => {
      const current = this.lease();
      if (!current) return;
      if (current.attemptId !== attemptId) this.conflict("another attempt owns the lease");
      this.db.prepare("DELETE FROM assistant_turn_lease WHERE singleton = 1 AND attempt_id = ?").run(attemptId);
      this.db.prepare(`UPDATE assistant_attempts SET state = 'failed'
        WHERE id = ? AND state = 'active'
          AND NOT EXISTS (SELECT 1 FROM assistant_attempt_sources WHERE attempt_id = ? AND state = 'submitted')`).run(attemptId, attemptId);
    });
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

  private disposition(source: StoredSource): "pending" | "owner" | "queued" {
    const lease = this.lease();
    if (!lease) return "pending";
    return lease.binding && source.binding && sameConversation(lease.binding, source.binding) ? "owner" : "queued";
  }

  private ensureQueueNotice(source: StoredSource): boolean {
    if (!source.binding) this.conflict("queued chat source has no binding");
    this.db.prepare("UPDATE source_contexts SET queue_notice_required = 1 WHERE id = ?").run(source.id);
    if (this.deliveries.get(`queued:${source.id}`)) return false;
    this.deliveries.prepare({ id: `queued:${source.id}`, kind: "queue_notice", binding: source.binding, body: "[system] queued", mandatory: true });
    return true;
  }

  private reserve(lease: AssistantLease, source: StoredSource, kind: "start" | "steer", clientUserMessageId: string): ReservedSubmission {
    if (source.state !== "pending") this.conflict("source is not pending");
    const ordinal = Number((this.db.prepare("SELECT COALESCE(MAX(source_ordinal), 0) + 1 AS ordinal FROM assistant_attempt_sources WHERE attempt_id = ?")
      .get(lease.attemptId) as { ordinal: number }).ordinal);
    const now = Date.now();
    this.db.prepare(`INSERT INTO assistant_attempt_sources
      (attempt_id, context_id, source_ordinal, client_user_message_id, submission_kind, state, expected_turn_id, observed_turn_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
      .run(lease.attemptId, source.id, ordinal, clientUserMessageId, kind,
        kind === "start" ? "start_submitting" : "steer_submitting", kind === "steer" ? lease.turnId ?? null : null, now, now);
    if (this.db.prepare("UPDATE source_contexts SET state = 'active' WHERE id = ? AND state = 'pending'").run(source.id).changes !== 1) {
      this.conflict("source changed while reserving submission");
    }
    return {
      ...this.membersForAttempt(lease.attemptId).find((member) => member.contextId === source.id)!,
      rawText: source.rawText,
      attachmentIds: source.attachmentIds,
      ...(source.binding ? { binding: source.binding } : {}),
    };
  }

  private assertNoUnresolvedSubmission(): void {
    const unresolved = this.db.prepare(`SELECT context_id FROM assistant_attempt_sources
      WHERE state IN ('start_submitting', 'steer_submitting', 'uncertain') LIMIT 1`).get();
    if (unresolved) this.conflict("another native submission is unresolved");
  }

  private membershipForSource(contextId: string): AttemptSource | undefined {
    const row = this.db.prepare(`SELECT * FROM assistant_attempt_sources WHERE context_id = ?
      AND state IN ('start_submitting', 'steer_submitting', 'uncertain', 'submitted')`).get(contextId) as Record<string, unknown> | undefined;
    return row ? this.parseMember(row) : undefined;
  }

  private requiredLease(): AssistantLease {
    return this.lease() ?? this.conflict("assistant lease is missing");
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

  private parseLease(row: Record<string, unknown>): AssistantLease {
    return {
      phase: String(row.phase) as AssistantLease["phase"],
      attemptId: String(row.attempt_id),
      primaryContextId: String(row.primary_context_id),
      ...(row.adapter_id && row.conversation_key && row.destination_json ? {
        binding: {
          adapterId: String(row.adapter_id),
          conversationKey: String(row.conversation_key),
          destination: JSON.parse(String(row.destination_json)) as JsonValue,
          ...(row.native_reply_json ? { reply: JSON.parse(String(row.native_reply_json)) as JsonValue } : {}),
        },
      } : {}),
      clientUserMessageId: String(row.client_user_message_id),
      ...(row.turn_id ? { turnId: String(row.turn_id) } : {}),
      triggerKind: String(row.trigger_kind) as "chat" | "internal",
      capacityClaimId: String(row.capacity_claim_id),
      steerPaused: Number(row.steer_paused) === 1,
      ...(row.pause_reason ? { pauseReason: String(row.pause_reason) } : {}),
    };
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
    };
  }

  private conflict(message: string): never {
    throw new AppError("OPERATION_CONFLICT", `OPERATION_CONFLICT: ${message}`);
  }
}

interface StoredSource {
  id: string;
  kind: SourceContext["kind"];
  sourceId: string;
  rawText: string;
  attachmentIds: readonly string[];
  state: "pending" | "active" | "completed" | "superseded";
  sourceClass: "chat" | "internal";
  arrivalSequence: number;
  queueNoticeRequired: boolean;
  binding?: ConversationBinding;
}
