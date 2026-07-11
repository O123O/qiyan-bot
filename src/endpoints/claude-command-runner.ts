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
}

// Builds the stable, deterministic `claude -p` argv for a turn. Exported for tests
// and so the byte-identical-per-turn invariant is auditable in one place.
export function buildClaudeArgs(request: ClaudeTurnRequest): string[] {
  const args = ["-p", request.message, "--output-format", "stream-json", "--verbose"];
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
  constructor(private readonly options: { command?: string; home?: string } = {}) {}

  startTurn(request: ClaudeTurnRequest): ClaudeTurnHandle {
    const child = spawn(this.options.command ?? "claude", buildClaudeArgs(request), {
      cwd: request.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let isError = false;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      // Parse the stream-json only to learn the terminal `result` outcome; the
      // authoritative content is read back from the transcript.
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.type === "result" && event.is_error === true) isError = true;
        } catch { /* partial/non-json line — ignore */ }
      }
    });
    const done = new Promise<ClaudeTurnStatus>((resolve) => {
      child.once("error", () => resolve("failed"));
      child.once("close", (code) => resolve(code === 0 && !isError ? "completed" : "failed"));
    });
    return { done, interrupt: () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } } };
  }

  async readTranscript(threadId: string, _cwd: string): Promise<unknown[]> {
    const path = await this.transcriptPath(threadId);
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
  private async transcriptPath(threadId: string): Promise<string | undefined> {
    const projects = join(this.options.home ?? homedir(), ".claude", "projects");
    let dirs: string[];
    try { dirs = await readdir(projects); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const file = `${threadId}.jsonl`;
    for (const dir of dirs) {
      try {
        const entries = await readdir(join(projects, dir));
        if (entries.includes(file)) return join(projects, dir, file);
      } catch { /* race: dir vanished — keep looking */ }
    }
    return undefined;
  }
}
