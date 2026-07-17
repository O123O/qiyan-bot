// Command runner for a Claude session (Phase 1.3) — the seam that makes "local vs
// remote" a spawn parameter, not a subsystem. `LocalClaudeCommandRunner` runs
// `claude -p` directly; a future ssh runner will run `ssh <host> claude -p` over the
// existing ControlMaster (1.4). The runtime above depends only on this interface.
import { spawn } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppError } from "../core/errors.ts";

// Stable per-session launch flags. They sit in the cached prompt prefix, so the
// runtime MUST pass byte-identical values every turn of a session (design §5).
export interface ClaudeLaunchFlags {
  appendSystemPrompt?: string;
  disallowedTools?: readonly string[];
  mcpConfig?: readonly string[];
  model?: string;
  effort?: string;
  permissionMode?: string;
}

// Metadata for one discoverable Claude session (thread). Deliberately body-free beyond a
// short preview — never carries assistant/tool output (a transcript exfil surface).
export interface ClaudeThreadMeta {
  id: string;
  cwd: string;
  updatedAt: number;
  preview: string;
}

export const CLAUDE_PREVIEW_MAX = 200;

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

export interface ClaudeTranscriptSnapshot {
  device: string;
  inode: string;
  size: number;
}

export interface ClaudeTranscriptChunk {
  snapshot: ClaudeTranscriptSnapshot;
  offset: number;
  bytes: Uint8Array;
}

export interface ClaudeTranscriptChunkRequest {
  offset: number | "tail";
  length: number;
  expected?: ClaudeTranscriptSnapshot;
}

export interface ClaudeCommandRunner {
  startTurn(request: ClaudeTurnRequest): ClaudeTurnHandle;
  // Reads at most `length` transcript bytes from the worker host. Snapshot pinning makes
  // pagination fail closed if the JSONL is replaced, truncated, or appended between pages.
  readTranscriptChunk(threadId: string, cwd: string, request: ClaudeTranscriptChunkRequest): Promise<ClaudeTranscriptChunk | undefined>;
  // The transcript file path (used as the ownership "rollout path"), or undefined
  // before the session is materialized.
  transcriptPath(threadId: string, cwd: string): Promise<string | undefined>;
  // Enumerate discoverable sessions, optionally filtered to a project cwd. Claude has no
  // list API, so this scans the transcript store; only id/cwd/updatedAt/preview leave the host.
  listThreads(cwd?: string): Promise<ClaudeThreadMeta[]>;
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
  if (flags.effort !== undefined) args.push("--effort", flags.effort);
  if (flags.permissionMode !== undefined) args.push("--permission-mode", flags.permissionMode);
  return args;
}

// The first user message of a transcript, trimmed to a short preview — never assistant/tool
// output. Mirrors Codex discovery's body-free preview. Exported for the runner impls + tests.
export function claudePreviewFromRecords(records: unknown[]): string {
  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    if (record.type !== "user") continue;
    const message = (record.message ?? {}) as Record<string, unknown>;
    const content = message.content;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && (part as any).type === "text" ? String((part as any).text ?? "") : "")).join(" ")
      : "";
    const trimmed = text.replace(/<!--\s*qiyan-cid:[^>]*-->/gu, "").replace(/\s+/gu, " ").trim();
    if (trimmed) return trimmed.slice(0, CLAUDE_PREVIEW_MAX);
  }
  return "";
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

  async readTranscriptChunk(
    threadId: string,
    cwd: string,
    request: ClaudeTranscriptChunkRequest,
  ): Promise<ClaudeTranscriptChunk | undefined> {
    if (!Number.isSafeInteger(request.length) || request.length <= 0) {
      throw new AppError("CONFIGURATION_ERROR", "invalid Claude transcript chunk length");
    }
    const path = await this.transcriptPath(threadId, cwd);
    if (!path) return undefined;
    let handle;
    try { handle = await open(path, "r"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.pathCache.delete(threadId);
        return undefined;
      }
      throw error;
    }
    try {
      const before = transcriptSnapshot(await handle.stat());
      requireExpectedSnapshot(before, request.expected);
      const offset = request.offset === "tail"
        ? Math.max(0, before.size - request.length)
        : request.offset;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > before.size) {
        throw new AppError("OPERATION_UNCERTAIN", "Claude transcript cursor is outside the pinned snapshot");
      }
      const bytes = Buffer.alloc(Math.min(request.length, before.size - offset));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
      const after = transcriptSnapshot(await handle.stat());
      requireExpectedSnapshot(after, before);
      return { snapshot: before, offset, bytes: bytes.subarray(0, bytesRead) };
    } finally {
      await handle.close();
    }
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

  async listThreads(cwd?: string): Promise<ClaudeThreadMeta[]> {
    const projects = join(this.options.home ?? homedir(), ".claude", "projects");
    let dirs: string[];
    try { dirs = await readdir(projects); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const out: ClaudeThreadMeta[] = [];
    for (const dir of dirs) {
      let entries: string[];
      try { entries = await readdir(join(projects, dir)); } catch { continue; }
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const meta = await readClaudeThreadMeta(entry.slice(0, -6), join(projects, dir, entry));
        if (meta && (cwd === undefined || meta.cwd === cwd)) out.push(meta);
      }
    }
    return out;
  }
}

// Reads one transcript for its discovery metadata (cwd from the records — NOT the dir's
// cwd-hash, which the runtime deliberately does not reproduce; updatedAt from mtime; a
// body-free preview). Returns undefined for an unreadable / non-materialized transcript.
async function readClaudeThreadMeta(id: string, path: string): Promise<ClaudeThreadMeta | undefined> {
  let text: string;
  let updatedAt: number;
  try {
    const handle = await open(path, "r");
    try {
      const bytes = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      text = bytes.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    updatedAt = (await stat(path)).mtimeMs;
  }
  catch { return undefined; }
  const records: unknown[] = [];
  let cwd: string | undefined;
  // Only the head up to the first user record is needed (cwd + the preview source); stop there
  // so a large transcript isn't fully parsed on every discover, and no later bodies are examined.
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: unknown;
    try { record = JSON.parse(trimmed); } catch { continue; }
    records.push(record);
    if (record && typeof record === "object") {
      const value = (record as Record<string, unknown>).cwd;
      if (cwd === undefined && typeof value === "string" && value.length > 0) cwd = value;
      if ((record as Record<string, unknown>).type === "user") break;
    }
  }
  if (cwd === undefined) return undefined;
  return { id, cwd, updatedAt, preview: claudePreviewFromRecords(records) };
}

function transcriptSnapshot(value: { dev: number | bigint; ino: number | bigint; size: number }): ClaudeTranscriptSnapshot {
  return { device: String(value.dev), inode: String(value.ino), size: value.size };
}

function requireExpectedSnapshot(actual: ClaudeTranscriptSnapshot, expected: ClaudeTranscriptSnapshot | undefined): void {
  if (!expected) return;
  if (actual.device !== expected.device || actual.inode !== expected.inode || actual.size !== expected.size) {
    throw new AppError("OPERATION_UNCERTAIN", "Claude transcript changed during bounded history paging");
  }
}
