// The only place QiYan constructs an Agent SDK query. Every launch decision the
// capability spike settled lives here, so there is one answer to "how is a managed
// Claude session started" rather than one per call site.
//
// A managed session is an ordinary Claude Code session. QiYan appends no system prompt,
// sets no tool allow/deny list, and injects no MCP servers: scheduling, background tasks,
// subagents, and goals are Claude's own. The only options passed are the ones required to
// *be* a normal session.
import type { EffortLevel, Options } from "@anthropic-ai/claude-agent-sdk";
import type { OpenSessionRequest } from "./host.ts";
import { permissionWarning, resolveClaudePermissions } from "./permissions.ts";
import type { SessionInput, SessionQuery, SessionQueryFactory } from "./session.ts";

// The SDK's `query` narrowed to what this module needs, so the module is testable without
// spawning Claude and the SDK stays a type-only import.
export type QueryFn = (params: {
  prompt: AsyncIterable<SessionInput>;
  options: Options;
}) => SessionQuery;

export interface LaunchContext {
  // The Claude CLI installed on this host. Passed explicitly so a machine runs one Claude
  // rather than also using the SDK's ~264 MB vendored copy.
  claudeExecutable: string;
  home?: string;
  onWarning?: (message: string) => void;
}

export async function buildLaunchOptions(
  request: OpenSessionRequest,
  context: LaunchContext,
): Promise<Options> {
  const permissions = await resolveClaudePermissions(request.cwd, {
    ...(context.home === undefined ? {} : { home: context.home }),
  });
  const warning = permissionWarning(permissions);
  if (warning) context.onWarning?.(warning);

  return {
    cwd: request.cwd,
    pathToClaudeCodeExecutable: context.claudeExecutable,
    // Mandatory: omitting systemPrompt selects the SDK's minimal prompt instead of Claude
    // Code's. Nothing is appended — the redirect prompt the one-shot design needed is gone
    // along with the QiYan-side schedulers it redirected to.
    systemPrompt: { type: "preset", preset: "claude_code" },
    // settingSources is deliberately omitted: that loads user/project/local settings,
    // CLAUDE.md, skills, agents, commands, and hooks exactly as the CLI does.
    //
    // Permission mode is the one exception, and it is a pass-through of the user's own
    // config rather than a QiYan policy: the SDK does not read permissions.defaultMode
    // from settings files, and bypassPermissions needs an in-process opt-in.
    permissionMode: permissions.permissionMode,
    ...(permissions.allowDangerouslySkipPermissions === undefined
      ? {}
      : { allowDangerouslySkipPermissions: permissions.allowDangerouslySkipPermissions }),
    // sessionId reserves the caller's UUID as the native session id; resume reopens an
    // existing one. The SDK rejects both together unless forking, which QiYan never wants.
    ...(request.mode === "create" ? { sessionId: request.sessionId } : { resume: request.sessionId }),
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.effort === undefined ? {} : { effort: request.effort as EffortLevel }),
  };
}

// Resolves the launch options, then hands back a synchronous factory for the session
// actor. Options are settled before the query exists, so nothing has to be patched in
// after construction.
export function sdkSessionPreparer(query: QueryFn, context: LaunchContext) {
  return async (request: OpenSessionRequest): Promise<SessionQueryFactory> => {
    const options = await buildLaunchOptions(request, context);
    return (input) => query({ prompt: input, options });
  };
}
