import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../core/errors.ts";
import { parseDirective } from "../directives/parser.ts";
import type { OperationRecord, OperationStore } from "../storage/operation-store.ts";
import type { AttemptScope } from "./attempt-scope.ts";

export interface ToolCallContext { sourceContextId: string; attemptId: string; turnId?: string; callId: string; toolFence?: number; signal?: AbortSignal }
export type ToolHandler = (context: ToolCallContext, args: unknown) => Promise<unknown>;
export interface ToolActionContext extends ToolCallContext { effectiveSourceContextId: string; operationId: string; operationCreatedAt: number; operationSequence: number; checkpoint(receipt: unknown): void }

const nickname = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u).describe("the managed session's short unique nickname");
const endpoint = () => z.string().describe("endpoint id (e.g. 'local', 'claude-local', a catalog id); omit for the default endpoint");
export const ASSISTANT_TOOL_SCHEMAS = {
  list_managed_sessions: z.object({}).strict(),
  discover_sessions: z.object({ endpoint: endpoint().optional(), search: z.string().describe("filter by a substring of the id/cwd/preview").optional(), cwd: z.string().describe("only sessions whose working directory equals this path").optional(), cursor: z.string().describe("pagination cursor from a previous call").optional(), limit: z.number().int().positive().max(100).describe("max results (1-100)").optional() }).strict(),
  get_session_status: z.object({ nickname: nickname }).strict(),
  create_session: z.object({ nickname, project_dir: z.string().min(1).describe("absolute project directory; omit to use default_projects_root/<nickname>").optional(), endpoint: endpoint().optional() }).strict(),
  adopt_session: z.object({ nickname, thread_id: z.string().min(1).describe("native thread id to adopt (from discover_sessions)"), endpoint: endpoint().optional() }).strict(),
  rename_session: z.object({ old_nickname: nickname, new_nickname: nickname }).strict(),
  unadopt_session: z.object({ nickname }).strict(), archive_session: z.object({ nickname }).strict(),
  send_to_session: z.object({ nickname, content: z.string().describe("the message text to send to the worker"), attachment_ids: z.array(z.string()).describe("attachment ids to include, in order").default([]), mode: z.enum(["start", "steer"]).describe("'start' = new turn (fails if one is running); 'steer' = queue onto the active turn") }).strict(),
  read_worker_message: z.object({ nickname, message_id: z.string().min(1).describe("worker message id (from a notification)") }).strict(),
  collect_messages: z.object({ nickname, count: z.number().int().positive().describe("how many of the most-recent final messages to deliver (max 20)") }).strict(),
  interrupt_session: z.object({ nickname, turn_id: z.string().describe("specific turn to interrupt; omit for the active turn").optional() }).strict(),
  list_models: z.object({ endpoint: endpoint().optional() }).strict(),
  disconnect_endpoint: z.object({ endpoint: endpoint().min(1).default("local") }).strict(),
  restart_endpoint: z.object({ endpoint: endpoint().min(1).default("local") }).strict(),
  set_session_model: z.object({ nickname, model: z.string().min(1).describe("a model id from list_models; 'default' follows the account/org default") }).strict(),
  set_reasoning_effort: z.object({ nickname, effort: z.string().min(1).describe("a value from list_models.supportedReasoningEfforts (Claude: low|medium|high|xhigh|max)") }).strict(),
  get_goal: z.object({ nickname }).strict(),
  set_goal: z.object({ nickname, objective: z.string().min(1).describe("what the worker should accomplish (replaces any current goal)"), token_budget: z.number().int().positive().describe("optional token budget bounding the goal (Codex)").optional() }).strict(),
  pause_goal: z.object({ nickname }).strict(), resume_goal: z.object({ nickname }).strict(),
  cancel_goal: z.object({ nickname, interrupt_active_turn: z.boolean().describe("also stop the currently running goal turn").optional() }).strict(),
  update_session_notes: z.object({
    nickname,
    project_summary: z.string().max(4_000).describe("concise summary of the worker's project; null to clear").nullable().optional(),
    supervision_objective: z.string().max(4_000).describe("standing supervision goal for this session; null to clear").nullable().optional(),
    pending_follow_up: z.string().max(4_000).describe("the next follow-up you owe; null to clear when resolved").nullable().optional(),
  }).strict().refine((value) => Object.keys(value).some((key) => key !== "nickname"), "at least one manager note field is required"),
  send_chat_message: z.object({ content: z.string().describe("message text to send to the current chat/user") }).strict(),
  prepare_chat_attachment: z.object({ owner: z.string().min(1).describe("owning session nickname, or 'assistant' for the assistant's own workdir"), relative_path: z.string().min(1).describe("file path relative to the owner's root directory") }).strict(),
  send_chat_attachment: z.object({ file_handle: z.string().min(1).describe("file_handle from prepare_chat_attachment"), caption: z.string().describe("optional caption").optional() }).strict(),
  get_chat_history: z.object({
    scope: z.enum(["conversation", "channel"]).describe("'conversation' = this thread; 'channel' = the whole channel"),
    count: z.number().int().positive().max(100).describe("how many messages to read (1-100)"),
    before: z.string().min(1).describe("only messages before this cursor/id").optional(),
  }).strict(),
  search_slack: z.object({ query: z.string().min(1).describe("search text"), date_from: z.string().describe("ISO date lower bound").optional(), date_to: z.string().describe("ISO date upper bound").optional() }).strict(),
  get_slack_mentions: z.object({ date_from: z.string().describe("ISO date to list mentions since") }).strict(),
} as const;

export const TOOL_NAMES = Object.freeze(Object.keys(ASSISTANT_TOOL_SCHEMAS)) as readonly (keyof typeof ASSISTANT_TOOL_SCHEMAS)[];
export type AssistantToolName = keyof typeof ASSISTANT_TOOL_SCHEMAS;

// Per-tool descriptions surfaced to the assistant's MCP client (the manager MCP server falls
// back to a generic string for tools not listed here). Use these to document behavior the
// assistant must know but can't infer from the schema.
export const TOOL_DESCRIPTIONS: Partial<Record<AssistantToolName, string>> = {
  list_managed_sessions: "List all managed sessions (nickname, endpoint, provider codex|claude, thread, project dir). Use get_session_status for live status.",
  discover_sessions: "Find existing native threads on an endpoint that can be adopted (most-recent-first). Returns thread ids for adopt_session; creates nothing.",
  get_session_status: "Live status of a managed session: native_status, active turn, model/effort, goal, notes.",
  create_session: "Create a new managed worker session on an endpoint (omit project_dir for default_projects_root/<nickname>).",
  adopt_session: "Adopt an existing native thread under a nickname (validates its native cwd; never repoints).",
  rename_session: "Rename a managed session's nickname (backend-side only; native thread unchanged).",
  unadopt_session: "Release a session WITHOUT archiving its native thread or deleting project files — it stays discoverable/re-adoptable.",
  archive_session: "Release a session and mark its native thread archived (still returned by discover_sessions, flagged archived; unadopt leaves it unarchived).",
  send_to_session: "Send a message to a worker as a new turn (start) or onto the active turn (steer). Used by /pass.",
  read_worker_message: "Read one worker message's full body by id (notifications are metadata-only until read).",
  collect_messages: "Deliver the worker's last N final message bodies into chat. Used by /collect.",
  interrupt_session: "Interrupt the worker's active turn.",
  list_models: "List an endpoint's selectable models and their supported reasoning efforts. Call before set_session_model / set_reasoning_effort.",
  disconnect_endpoint: "Disconnect an endpoint's runtime; managed sessions recover on next use.",
  restart_endpoint: "Restart an endpoint's runtime and restore its managed sessions.",
  set_session_model: "Set a session's model for its next new turn onward (sticky for Claude). Use a list_models value; 'default' = account default.",
  set_reasoning_effort: "Set a session's reasoning effort for its next new turn (sticky for Claude); values from list_models.supportedReasoningEfforts.",
  get_goal: "Read the session's current goal (objective + status) or null.",
  set_goal: "Set/replace a worker's goal; the backend auto-drives it after each turn until the worker ends it via set_goal_status — or (Claude) up to 50 turns then it pauses budgetLimited (resume_goal continues).",
  pause_goal: "Pause the goal so the backend stops auto-driving it (resume_goal continues).",
  resume_goal: "Resume a paused/budgetLimited goal (resets the auto-continue counter).",
  cancel_goal: "Clear the session's goal (interrupt_active_turn also stops the running goal turn).",
  update_session_notes: "Set your manager notes (project_summary / supervision_objective / pending_follow_up); null clears a field.",
  send_chat_message: "Send a message to the current chat/user.",
  prepare_chat_attachment: "Stage a worker's file for chat; returns a file_handle for send_chat_attachment.",
  send_chat_attachment: "Send a prepared attachment (file_handle) to chat with an optional caption.",
  get_chat_history: "Read recent chat history (conversation or channel), up to count messages.",
  search_slack: "Search Slack messages (query, optional date range).",
  get_slack_mentions: "List Slack mentions of you since date_from.",
};

type Action = (args: any, context: ToolActionContext) => Promise<any>;

export const EPHEMERAL_READ_TOOLS = new Set<AssistantToolName>(["search_slack", "get_slack_mentions"]);

export const READ_ONLY_TOOLS = new Set<AssistantToolName>([
  "list_managed_sessions", "discover_sessions", "get_session_status", "read_worker_message", "list_models", "get_goal", "get_chat_history", "search_slack", "get_slack_mentions",
]);

export function createAssistantTools(
  operations: OperationStore,
  actions: Partial<Record<AssistantToolName, Action>>,
  options: { maxCollectCount: number; attemptScope?: AttemptScope; waitForTerminal?(operationId: string, signal?: AbortSignal): Promise<void> },
): Record<AssistantToolName, ToolHandler> {
  const result = {} as Record<AssistantToolName, ToolHandler>;
  for (const name of TOOL_NAMES) {
    result[name] = async (context, raw) => {
      const args = ASSISTANT_TOOL_SCHEMAS[name].parse(raw) as any;
      const source = operations.getSourceContext(context.sourceContextId);
      if (!source) throw new AppError("OPERATION_CONFLICT", "tool call is not bound to an active source context");
      if (EPHEMERAL_READ_TOOLS.has(name)) {
        const action = actions[name];
        if (!action) throw new AppError("UNSUPPORTED_CAPABILITY", `tool is not configured: ${name}`);
        return action(args, {
          ...context,
          effectiveSourceContextId: context.sourceContextId,
          operationId: `ephemeral:${context.attemptId}:${context.callId}:${name}`,
          operationCreatedAt: Date.now(),
          operationSequence: 0,
          checkpoint: () => { throw new AppError("UNSUPPORTED_CAPABILITY", `${name} cannot create a durable checkpoint`); },
        });
      }
      let directive: { kind: "pass" | "collect"; binding: unknown } | undefined;
      let operation: OperationRecord | undefined;
      let effectiveSourceContextId = context.sourceContextId;
      const guarded = name === "send_to_session" || name === "collect_messages";
      if (guarded && options.attemptScope) {
        const resolved = await options.attemptScope.resolveSafeguard({
          attemptId: context.attemptId,
          callId: context.callId,
          tool: name,
          args,
          ...(context.toolFence === undefined ? {} : { toolFence: context.toolFence }),
        });
        operation = resolved.operation;
        effectiveSourceContextId = resolved.effectiveSourceContextId;
        if (resolved.directiveKind === "pass") directive = { kind: "pass", binding: { nickname: args.nickname, mode: args.mode, content: args.content, attachment_ids: args.attachment_ids } };
        if (resolved.directiveKind === "collect") directive = { kind: "collect", binding: { nickname: args.nickname, count: args.count } };
      } else if (guarded) {
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

      const sideEffecting = name === "collect_messages" ? directive?.kind === "collect" : !READ_ONLY_TOOLS.has(name);
      const effectClass = sideEffecting ? "side_effecting" : "read_only";
      if (!options.attemptScope && directive) operation = operations.replayDirective(context.sourceContextId, directive.kind, directive.binding);
      operation ??= operations.prepare({ contextId: effectiveSourceContextId, attemptId: context.attemptId, callId: context.callId, kind: name, args, effectClass, ...(context.toolFence === undefined ? {} : { toolFence: context.toolFence }) });
      if (operation.state === "succeeded") return operation.receipt;
      if (operation.state === "dispatched" || operation.state === "uncertain") {
        if (operation.state === "uncertain" && name === "create_session" && options.waitForTerminal) {
          return waitForCertainResult(operations, operation.id, name, options.waitForTerminal, context.signal);
        }
        throw new AppError("OPERATION_UNCERTAIN", `${name} may already have taken effect`);
      }
      if (operation.state === "failed") {
        if (name === "create_session" && options.waitForTerminal) throw definiteOperationFailure(name, operation);
        throw new AppError("OPERATION_UNCERTAIN", `${name} previously failed and requires reconciliation`);
      }
      if (!options.attemptScope && directive) operations.bindDirective(context.sourceContextId, directive.kind, directive.binding, operation.id);

      const action = actions[name];
      if (!action) throw new AppError("UNSUPPORTED_CAPABILITY", `tool is not configured: ${name}`);
      if (sideEffecting) operations.markDispatched(operation.id, context.toolFence);
      try {
        const actionResult = await action(directive?.kind === "collect" ? { ...args, direct: true } : args, {
          ...context,
          effectiveSourceContextId,
          operationId: operation.id,
          operationCreatedAt: operation.createdAt,
          operationSequence: operation.sequence,
          checkpoint: (receipt) => operations.checkpoint(operation!.id, receipt, context.toolFence),
        });
        const receipt = directive?.kind === "pass"
          ? { ...(isRecord(actionResult) ? actionResult : { result: actionResult }), nickname: args.nickname, actualText: args.content, attachmentIds: args.attachment_ids, payloadHash: createHash("sha256").update(args.content).digest("hex") }
          : directive?.kind === "collect"
            ? { deliveries: Array.isArray(actionResult) ? actionResult.map((item) => item.deliveryId) : [], count: args.count, nickname: args.nickname }
            : actionResult;
        operations.succeed(operation.id, receipt, context.toolFence);
        return receipt;
      } catch (error) {
        if (operations.get(operation.id)?.state === "uncertain") {
          throw error instanceof AppError && error.code === "OPERATION_UNCERTAIN"
            ? error
            : new AppError("OPERATION_UNCERTAIN", `${name} terminalized before its result could be committed`);
        }
        const uncertain = sideEffecting && !isProvenNoEffect(error, operations.get(operation.id));
        const failure = { message: error instanceof Error ? error.message : String(error) };
        if (uncertain) {
          operations.fail(operation.id, failure, true, context.toolFence);
          if (name === "create_session" && options.waitForTerminal) {
            return waitForCertainResult(operations, operation.id, name, options.waitForTerminal, context.signal);
          }
          throw new AppError("OPERATION_UNCERTAIN", `${name} may already have taken effect; wait for durable reconciliation before retrying`);
        }
        operations.failAndUnbind(operation.id, failure, context.toolFence);
        throw error;
      }
    };
  }
  return result;
}

async function waitForCertainResult(
  operations: OperationStore,
  operationId: string,
  name: AssistantToolName,
  waitForTerminal: (operationId: string, signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<unknown> {
  await waitForTerminal(operationId, signal);
  const operation = operations.get(operationId);
  if (operation?.state === "succeeded") return operation.receipt;
  if (operation?.state === "failed") throw definiteOperationFailure(name, operation);
  throw new AppError("OPERATION_UNCERTAIN", `${name} reconciliation returned without a terminal result`);
}

function definiteOperationFailure(name: AssistantToolName, operation: OperationRecord): AppError {
  const reason = isRecord(operation.error) && typeof operation.error.message === "string"
    ? operation.error.message
    : "durable reconciliation proved that it did not complete";
  return new AppError("OPERATION_FAILED", `${name} failed: ${reason}`, { operationId: operation.id });
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

const provenNoEffectCodes = new Set([
  "UNKNOWN_SESSION", "AMBIGUOUS_SESSION", "SESSION_DETACHED", "SESSION_BUSY", "SESSION_IDLE", "THREAD_NOT_FOUND",
  "UNSUPPORTED_CAPABILITY", "ATTACHMENT_INVALID", "OPERATION_CONFLICT", "CAPACITY_EXCEEDED", "PERMISSION_BLOCKED",
  "CONFIGURATION_ERROR",
]);
function isProvenNoEffect(error: unknown, operation?: OperationRecord): boolean {
  if (operation?.kind === "create_session" && isRecord(operation.receipt)) {
    if (operation.receipt.dispatchStarted === true) return false;
    if (operation.receipt.dispatchStarted === false) return true;
  }
  return error instanceof AppError && provenNoEffectCodes.has(error.code);
}
