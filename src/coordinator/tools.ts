import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../core/errors.ts";
import { parseDirective } from "../directives/parser.ts";
import type { OperationRecord, OperationStore } from "../storage/operation-store.ts";

export interface ToolCallContext { sourceContextId: string; attemptId: string; turnId: string; callId: string }
export type ToolHandler = (context: ToolCallContext, args: unknown) => Promise<unknown>;

const nickname = z.string().min(1);
export const COORDINATOR_TOOL_SCHEMAS = {
  list_managed_sessions: z.object({}).strict(),
  discover_sessions: z.object({ endpoint: z.string().optional(), search: z.string().optional(), cwd: z.string().optional(), cursor: z.string().optional(), limit: z.number().int().positive().max(100).optional() }).strict(),
  get_session_status: z.object({ nickname: nickname }).strict(),
  create_session: z.object({ nickname, project_dir: z.string().min(1), endpoint: z.string().optional() }).strict(),
  register_session: z.object({ nickname, thread_id: z.string().min(1), project_dir: z.string().min(1), endpoint: z.string().optional() }).strict(),
  adopt_session: z.object({ nickname, thread_id: z.string().min(1), endpoint: z.string().optional(), project_dir: z.string().optional() }).strict(),
  rename_session: z.object({ old_nickname: nickname, new_nickname: nickname }).strict(),
  detach_session: z.object({ nickname }).strict(), attach_session: z.object({ nickname }).strict(), archive_session: z.object({ nickname }).strict(),
  send_to_session: z.object({ nickname, content: z.string(), attachment_ids: z.array(z.string()).default([]), mode: z.enum(["start", "steer"]) }).strict(),
  read_worker_message: z.object({ nickname, message_id: z.string().min(1) }).strict(),
  collect_messages: z.object({ nickname, count: z.number().int().positive() }).strict(),
  interrupt_session: z.object({ nickname, turn_id: z.string().optional() }).strict(),
  list_models: z.object({ endpoint: z.string().optional() }).strict(),
  set_session_model: z.object({ nickname, model: z.string().min(1) }).strict(),
  set_reasoning_effort: z.object({ nickname, effort: z.string().min(1) }).strict(),
  get_goal: z.object({ nickname }).strict(),
  set_goal: z.object({ nickname, objective: z.string().min(1), token_budget: z.number().int().positive().optional() }).strict(),
  pause_goal: z.object({ nickname }).strict(), resume_goal: z.object({ nickname }).strict(),
  cancel_goal: z.object({ nickname, interrupt_active_turn: z.boolean().optional() }).strict(),
  send_chat_message: z.object({ content: z.string(), reply_to: z.number().int().optional() }).strict(),
  prepare_chat_attachment: z.object({ owner: z.string().min(1), relative_path: z.string().min(1) }).strict(),
  send_chat_attachment: z.object({ file_handle: z.string().min(1), caption: z.string().optional(), reply_to: z.number().int().optional() }).strict(),
} as const;

export const TOOL_NAMES = Object.freeze(Object.keys(COORDINATOR_TOOL_SCHEMAS)) as readonly (keyof typeof COORDINATOR_TOOL_SCHEMAS)[];
export type CoordinatorToolName = keyof typeof COORDINATOR_TOOL_SCHEMAS;
type Action = (args: any, context: ToolCallContext) => Promise<any>;

export const READ_ONLY_TOOLS = new Set<CoordinatorToolName>([
  "list_managed_sessions", "discover_sessions", "get_session_status", "read_worker_message", "list_models", "get_goal",
]);

export function createCoordinatorTools(
  operations: OperationStore,
  actions: Partial<Record<CoordinatorToolName, Action>>,
  options: { maxCollectCount: number },
): Record<CoordinatorToolName, ToolHandler> {
  const result = {} as Record<CoordinatorToolName, ToolHandler>;
  for (const name of TOOL_NAMES) {
    result[name] = async (context, raw) => {
      const args = COORDINATOR_TOOL_SCHEMAS[name].parse(raw) as any;
      const source = operations.getSourceContext(context.sourceContextId);
      if (!source) throw new AppError("OPERATION_CONFLICT", "tool call is not bound to an active source context");
      let directive: { kind: "pass" | "collect"; binding: unknown } | undefined;
      if (name === "send_to_session" || name === "collect_messages") {
        const parsed = parseDirective(source.rawText, source.attachmentIds, options.maxCollectCount);
        if (parsed.kind === "malformed") throw new AppError("DIRECTIVE_MISMATCH", parsed.reason);
        if (name === "send_to_session" && parsed.kind === "pass") {
          if (args.content !== parsed.payload || !equalStrings(args.attachment_ids, source.attachmentIds)) {
            throw new AppError("DIRECTIVE_MISMATCH", "send content or attachments differ from the immutable /pass payload", { expectedPayload: parsed.payload, expectedAttachmentIds: source.attachmentIds });
          }
          directive = { kind: "pass", binding: { nickname: args.nickname, mode: args.mode, content: args.content, attachment_ids: args.attachment_ids } };
        } else if (name === "collect_messages" && parsed.kind === "collect") {
          if (args.count !== parsed.count) throw new AppError("DIRECTIVE_MISMATCH", `collection count must be ${parsed.count}`);
          directive = { kind: "collect", binding: { nickname: args.nickname, count: args.count } };
        } else if ((name === "send_to_session" && parsed.kind === "collect") || (name === "collect_messages" && parsed.kind === "pass")) {
          throw new AppError("DIRECTIVE_MISMATCH", `source context requires /${parsed.kind}`);
        }
      }

      let operation: OperationRecord | undefined;
      if (directive) operation = operations.replayDirective(context.sourceContextId, directive.kind, directive.binding);
      operation ??= operations.prepare({ contextId: context.sourceContextId, attemptId: context.attemptId, callId: context.callId, kind: name, args });
      if (directive) operations.bindDirective(context.sourceContextId, directive.kind, directive.binding, operation.id);
      if (operation.state === "succeeded") return operation.receipt;
      if (operation.state === "dispatched" || operation.state === "uncertain") throw new AppError("OPERATION_UNCERTAIN", `${name} may already have taken effect`);
      if (operation.state === "failed") throw new AppError("OPERATION_UNCERTAIN", `${name} previously failed and requires reconciliation`);

      const action = actions[name];
      if (!action) throw new AppError("UNSUPPORTED_CAPABILITY", `tool is not configured: ${name}`);
      const sideEffecting = name === "collect_messages" ? directive?.kind === "collect" : !READ_ONLY_TOOLS.has(name);
      if (sideEffecting) operations.markDispatched(operation.id);
      try {
        const actionResult = await action(directive?.kind === "collect" ? { ...args, direct: true } : args, context);
        const receipt = directive?.kind === "pass"
          ? { ...(isRecord(actionResult) ? actionResult : { result: actionResult }), nickname: args.nickname, actualText: args.content, attachmentIds: args.attachment_ids, payloadHash: createHash("sha256").update(args.content).digest("hex") }
          : directive?.kind === "collect"
            ? { deliveries: Array.isArray(actionResult) ? actionResult.map((item) => item.deliveryId) : [], count: args.count, nickname: args.nickname }
            : actionResult;
        operations.succeed(operation.id, receipt);
        return receipt;
      } catch (error) {
        operations.fail(operation.id, { message: error instanceof Error ? error.message : String(error) }, sideEffecting);
        throw error;
      }
    };
  }
  return result;
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
