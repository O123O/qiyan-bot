import type { FileHandleId } from "../attachments/store.ts";
import type { AttachmentStore } from "../attachments/store.ts";
import { AppError } from "../core/errors.ts";
import { parseDirective, type ParsedDirective } from "../directives/parser.ts";
import type { AttemptSource } from "../storage/conversation-store.ts";
import type { Database } from "../storage/database.ts";
import { inTransaction } from "../storage/database.ts";
import type { OperationRecord, OperationStore } from "../storage/operation-store.ts";

type GuardedTool = "send_to_session" | "collect_messages";

export interface SafeguardResolution {
  effectiveSourceContextId: string;
  operation: OperationRecord;
  replay: boolean;
  directiveKind?: "pass" | "collect";
  releaseConsumptionOnNoEffect(): void;
}

export class AttemptScope {
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly db: Database,
    private readonly operations: OperationStore,
    private readonly options: { maxCollectCount: number; attachments?: AttachmentStore },
  ) {}

  admittedSources(attemptId: string): AttemptSource[] {
    return (this.db.prepare("SELECT * FROM assistant_attempt_sources WHERE attempt_id = ? ORDER BY source_ordinal").all(attemptId) as Array<Record<string, unknown>>).map((row) => ({
      attemptId: String(row.attempt_id),
      contextId: String(row.context_id),
      sourceOrdinal: Number(row.source_ordinal),
      clientUserMessageId: String(row.client_user_message_id),
      submissionKind: String(row.submission_kind) as "start" | "steer",
      state: String(row.state) as AttemptSource["state"],
      ...(row.expected_turn_id ? { expectedTurnId: String(row.expected_turn_id) } : {}),
      ...(row.observed_turn_id ? { observedTurnId: String(row.observed_turn_id) } : {}),
    }));
  }

  async waitUntilSubmitted(attemptId: string, contextId: string): Promise<void> {
    while (true) {
      const row = this.db.prepare(`SELECT m.state AS member_state, s.state AS source_state FROM assistant_attempt_sources m
        JOIN source_contexts s ON s.id = m.context_id WHERE m.attempt_id = ? AND m.context_id = ?`).get(attemptId, contextId) as
        { member_state: string; source_state: string } | undefined;
      if (!row) throw new AppError("OPERATION_CONFLICT", "safeguard source is not admitted to this attempt");
      if (new Set(["submitted", "completed"]).has(row.member_state)) return;
      if (new Set(["failed", "superseded"]).has(row.member_state) || row.source_state === "pending") {
        throw new AppError("OPERATION_CONFLICT", "safeguard source was restored and is not admitted to the native turn");
      }
      await new Promise<void>((resolve) => {
        const listeners = this.waiters.get(contextId) ?? new Set<() => void>();
        listeners.add(resolve);
        this.waiters.set(contextId, listeners);
      });
    }
  }

  notifyMembership(contextId: string): void {
    for (const resolve of this.waiters.get(contextId) ?? []) resolve();
    this.waiters.delete(contextId);
  }

  resolveAttachment(attemptId: string, attachmentId: string): { contextId: string; attachmentId: FileHandleId } {
    for (const member of this.admittedSources(attemptId)) {
      if (!new Set(["submitted", "completed"]).has(member.state)) continue;
      const source = this.source(member.contextId);
      if (!source.attachmentIds.includes(attachmentId)) continue;
      const id = attachmentId as FileHandleId;
      if (this.options.attachments && !this.options.attachments.get(member.contextId, id)) continue;
      return { contextId: member.contextId, attachmentId: id };
    }
    throw new AppError("ATTACHMENT_INVALID", "attachment is not admitted to the active assistant attempt");
  }

  async resolveSafeguard(input: {
    attemptId: string;
    callId: string;
    tool: GuardedTool;
    args: unknown;
    toolFence?: number;
  }): Promise<SafeguardResolution> {
    while (true) {
      const replay = this.operations.findForCall(input.attemptId, input.callId, input.tool);
      if (replay) return this.replayResolution(input, replay);
      await this.waitForAttachmentAdmission(input.attemptId, input.tool, input.args);
      const selected = this.select(input.attemptId, input.tool);
      if (selected.kind === "exhausted") throw new AppError("DIRECTIVE_ALREADY_CONSUMED", `all /${selected.directive} safeguards in this attempt are already consumed`);
      if (selected.kind === "mismatch") throw new AppError("DIRECTIVE_MISMATCH", `next safeguard source requires /${selected.directive}`);
      if (selected.kind === "malformed") throw new AppError("DIRECTIVE_MISMATCH", selected.reason);
      const contextId = selected.kind === "ordinary" ? selected.primaryContextId : selected.contextId;
      const source = this.source(contextId);
      const directiveKind = selected.kind === "directive"
        ? this.validate(input.tool, input.args, selected.parsed, source.attachmentIds, true)
        : undefined;
      if (selected.kind === "directive") await this.waitUntilSubmitted(input.attemptId, contextId);

      try {
        return inTransaction(this.db, () => {
          if (directiveKind && this.db.prepare("SELECT operation_id FROM directive_consumptions WHERE context_id = ?").get(contextId)) {
            throw new RetrySelection();
          }
          const operation = this.operations.prepare({
            contextId,
            attemptId: input.attemptId,
            callId: input.callId,
            kind: input.tool,
            args: input.args,
            effectClass: directiveKind || input.tool === "send_to_session" ? "side_effecting" : "read_only",
            ...(input.toolFence === undefined ? {} : { toolFence: input.toolFence }),
          });
          if (directiveKind) this.operations.bindDirective(contextId, directiveKind, this.binding(input.tool, input.args), operation.id);
          return this.resolution(contextId, operation, false, directiveKind);
        });
      } catch (error) {
        if (error instanceof RetrySelection) continue;
        const concurrent = this.operations.findForCall(input.attemptId, input.callId, input.tool);
        if (concurrent) return this.replayResolution(input, concurrent);
        throw error;
      }
    }
  }

  private async waitForAttachmentAdmission(attemptId: string, tool: GuardedTool, args: unknown): Promise<void> {
    if (tool !== "send_to_session") return;
    const attachmentIds = (args as { attachment_ids?: unknown }).attachment_ids;
    if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) return;
    const members = this.admittedSources(attemptId);
    const contexts = new Set<string>();
    for (const attachmentId of attachmentIds) {
      if (typeof attachmentId !== "string") throw new AppError("ATTACHMENT_INVALID", "attachment identifier is invalid");
      const owner = members.find((member) => this.source(member.contextId).attachmentIds.includes(attachmentId));
      if (!owner) throw new AppError("ATTACHMENT_INVALID", "attachment is not reserved by this assistant attempt");
      contexts.add(owner.contextId);
    }
    for (const contextId of contexts) await this.waitUntilSubmitted(attemptId, contextId);
  }

  private replayResolution(
    input: { attemptId: string; callId: string; tool: GuardedTool; args: unknown; toolFence?: number },
    replay: OperationRecord,
  ): SafeguardResolution {
    const source = this.source(replay.contextId);
    const parsed = parseDirective(source.rawText, source.attachmentIds, this.options.maxCollectCount);
    const directiveKind = this.validate(input.tool, input.args, parsed, source.attachmentIds, false);
    const operation = this.operations.prepare({
      contextId: replay.contextId,
      attemptId: input.attemptId,
      callId: input.callId,
      kind: input.tool,
      args: input.args,
      effectClass: directiveKind || input.tool === "send_to_session" ? "side_effecting" : "read_only",
      ...(input.toolFence === undefined ? {} : { toolFence: input.toolFence }),
    });
    return this.resolution(replay.contextId, operation, true, directiveKind);
  }

  private select(attemptId: string, tool: GuardedTool): Selection {
    const members = this.admittedSources(attemptId);
    if (members.length === 0) throw new AppError("OPERATION_CONFLICT", "attempt has no admitted sources");
    const expected = tool === "send_to_session" ? "pass" : "collect";
    let sawExpected = false;
    for (const member of members) {
      const source = this.source(member.contextId);
      const parsed = parseDirective(source.rawText, source.attachmentIds, this.options.maxCollectCount);
      if (parsed.kind === expected) sawExpected = true;
      if (parsed.kind === "none") continue;
      const consumed = this.db.prepare("SELECT operation_id FROM directive_consumptions WHERE context_id = ?").get(member.contextId);
      if (consumed) continue;
      if (parsed.kind === "malformed") return { kind: "malformed", reason: parsed.reason };
      if (parsed.kind !== expected) return { kind: "mismatch", directive: parsed.kind };
      return { kind: "directive", contextId: member.contextId, parsed };
    }
    if (sawExpected) return { kind: "exhausted", directive: expected };
    return { kind: "ordinary", primaryContextId: members[0]!.contextId };
  }

  private validate(tool: GuardedTool, args: unknown, parsed: ParsedDirective, attachmentIds: readonly string[], requireDirective: boolean): "pass" | "collect" | undefined {
    if (parsed.kind === "malformed") throw new AppError("DIRECTIVE_MISMATCH", parsed.reason);
    if (parsed.kind === "none") {
      if (requireDirective) throw new AppError("DIRECTIVE_MISMATCH", "expected an admitted safeguard message");
      return undefined;
    }
    if (tool === "send_to_session") {
      if (parsed.kind !== "pass") throw new AppError("DIRECTIVE_MISMATCH", `source context requires /${parsed.kind}`);
      const value = args as { nickname?: unknown; content?: unknown; attachment_ids?: unknown; mode?: unknown };
      if (value.content !== parsed.payload || !Array.isArray(value.attachment_ids)
        || value.attachment_ids.length !== attachmentIds.length
        || !value.attachment_ids.every((item, index) => item === attachmentIds[index])) {
        throw new AppError("DIRECTIVE_MISMATCH", "send content or attachments differ from the immutable /pass payload");
      }
      return "pass";
    }
    if (parsed.kind !== "collect") throw new AppError("DIRECTIVE_MISMATCH", `source context requires /${parsed.kind}`);
    if ((args as { count?: unknown }).count !== parsed.count) throw new AppError("DIRECTIVE_MISMATCH", `collection count must be ${parsed.count}`);
    return "collect";
  }

  private binding(tool: GuardedTool, args: unknown): unknown {
    const value = args as Record<string, unknown>;
    return tool === "send_to_session"
      ? { nickname: value.nickname, mode: value.mode, content: value.content, attachment_ids: value.attachment_ids }
      : { nickname: value.nickname, count: value.count };
  }

  private source(contextId: string): { rawText: string; attachmentIds: string[] } {
    const row = this.db.prepare("SELECT raw_text, attachment_ids_json FROM source_contexts WHERE id = ?").get(contextId) as { raw_text: string; attachment_ids_json: string } | undefined;
    if (!row) throw new AppError("OPERATION_CONFLICT", `unknown source context ${contextId}`);
    return { rawText: row.raw_text, attachmentIds: JSON.parse(row.attachment_ids_json) as string[] };
  }

  private resolution(contextId: string, operation: OperationRecord, replay: boolean, directiveKind?: "pass" | "collect"): SafeguardResolution {
    return {
      effectiveSourceContextId: contextId,
      operation,
      replay,
      ...(directiveKind ? { directiveKind } : {}),
      releaseConsumptionOnNoEffect: () => { if (directiveKind) this.operations.unbindDirective(operation.id); },
    };
  }
}

class RetrySelection extends Error {}

type Selection =
  | { kind: "directive"; contextId: string; parsed: Extract<ParsedDirective, { kind: "pass" | "collect" }> }
  | { kind: "ordinary"; primaryContextId: string }
  | { kind: "malformed"; reason: string }
  | { kind: "mismatch"; directive: "pass" | "collect" }
  | { kind: "exhausted"; directive: "pass" | "collect" };
