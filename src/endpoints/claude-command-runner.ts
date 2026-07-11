// Command runner for a Claude session (Phase 1.3) — the seam that makes "local vs
// remote" a spawn parameter, not a subsystem. `LocalClaudeCommandRunner` runs
// `claude -p` directly; a future ssh runner will run `ssh <host> claude -p` over the
// existing ControlMaster (1.4). The runtime above depends only on this interface.
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Stable per-session launch flags. They sit in the cached prompt prefix, so the
// runtime MUST pass byte-identical values every turn of a session (design §5).
export interface ClaudeLaunchFlags {
  appendSystemPrompt?: string;
  disallowedTools?: readonly string[];
  mcpConfig?: readonly string[];
  model?: string;
  permissionMode?: string;
}

export interface ClaudeTurnRequest {
  threadId: string;   // Claude session id
  cwd: string;
  message: string;
  resume: boolean;    // false => --session-id (create); true => --resume
  flags: ClaudeLaunchFlags;
}

export type ClaudeTurnStatus = "completed" | "failed";

export interface ClaudeTurnHandle {
  readonly done: Promise<ClaudeTurnStatus>;
  interrupt(): void;
}

export interface ClaudeCommandRunner {
  startTurn(request: ClaudeTurnRequest): ClaudeTurnHandle;
  // Returns the parsed transcript records for a session, or [] if none exists yet.
  readTranscript(threadId: string, cwd: string): Promise<unknown[]>;
  // The transcript file path (used as the ownership "rollout path"), or undefined
  // before the session is materialized.
  transcriptPath(threadId: string, cwd: string): Promise<string | undefined>;
}

// Builds the stable, deterministic `claude -p` argv for a turn. Exported for tests
// and so the byte-identical-per-turn invariant is auditable in one place.
// The prompt is delivered over stdin (see startTurn), NOT as a positional arg, so a
// message beginning with "--" is never parsed as a flag and there is no ARG_MAX limit.
export function buildClaudeArgs(request: ClaudeTurnRequest): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  args.push(request.resume ? "--resume" : "--session-id", request.threadId);
  const { flags } = request;
  if (flags.appendSystemPrompt !== undefined) args.push("--append-system-prompt", flags.appendSystemPrompt);
  if (flags.disallowedTools && flags.disallowedTools.length > 0) args.push("--disallowedTools", flags.disallowedTools.join(" "));
  for (const config of flags.mcpConfig ?? []) args.push("--mcp-config", config);
  if (flags.mcpConfig && flags.mcpConfig.length > 0) args.push("--strict-mcp-config");
  if (flags.model !== undefined) args.push("--model", flags.model);
  if (flags.permissionMode !== undefined) args.push("--permission-mode", flags.permissionMode);
  return args;
}

export class LocalClaudeCommandRunner implements ClaudeCommandRunner {
  private readonly pathCache = new Map<string, string>();
  constructor(private readonly options: { command?: string; home?: string } = {}) {}

  startTurn(request: ClaudeTurnRequest): ClaudeTurnHandle {
    // stdin: prompt; stdout: stream-json; stderr IGNORED so a chatty child can never
    // block on a full stderr pipe (which would deadlock and never emit `close`).
    const child = spawn(this.options.command ?? "claude", buildClaudeArgs(request), {
      cwd: request.cwd,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let isError = false;
    let buffer = "";
    const consume = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        if (event.type === "result" && event.is_error === true) isError = true;
      } catch { /* partial/non-json line — ignore */ }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      // Parse the stream-json only to learn the terminal `result` outcome; the
      // authoritative content is read back from the transcript.
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    });
    // Deliver the prompt over stdin, then close it.
    child.stdin.on("error", () => { /* child already gone */ });
    child.stdin.end(request.message);
    const done = new Promise<ClaudeTurnStatus>((resolve) => {
      child.once("error", () => resolve("failed"));
      child.once("close", (code) => { consume(buffer); resolve(code === 0 && !isError ? "completed" : "failed"); });
    });
    return { done, interrupt: () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } } };
  }

  async readTranscript(threadId: string, cwd: string): Promise<unknown[]> {
    const path = await this.transcriptPath(threadId, cwd);
    if (!path) return [];
    let text: string;
    try { text = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const records: unknown[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { records.push(JSON.parse(trimmed)); }
      catch { /* a partial trailing line written concurrently — skip it */ }
    }
    return records;
  }

  // A session's transcript is `<home>/.claude/projects/<cwd-hash>/<threadId>.jsonl`.
  // Rather than reproduce Claude's cwd-hashing, find the file by its unique session id.
  async transcriptPath(threadId: string, _cwd?: string): Promise<string | undefined> {
    const cached = this.pathCache.get(threadId);
    if (cached) return cached;
    const projects = join(this.options.home ?? homedir(), ".claude", "projects");
    let dirs: string[];
    try { dirs = await readdir(projects); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const file = `${threadId}.jsonl`;
    for (const dir of dirs) {
      try {
        const entries = await readdir(join(projects, dir));
        if (entries.includes(file)) { const path = join(projects, dir, file); this.pathCache.set(threadId, path); return path; }
      } catch { /* race: dir vanished — keep looking */ }
    }
    return undefined;
  }
}
