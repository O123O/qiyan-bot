// Claude Code transcript scanner — the provider-specific half of RolloutAccess.
//
// A Claude session's durable state is its transcript jsonl at
// `~/.claude/projects/<cwd-hash>/<session_id>.jsonl` (the process exits between
// turns, so there is no live server to query). This scanner reads that transcript
// the same way the Codex scanner (`rollout-ownership.ts`) reads a Codex rollout:
// incrementally, by byte offset, emitting ONLY per-turn ownership metadata
// (`RolloutTurnStart`) and never the message bodies — so it plugs into the
// existing `SessionOwnershipGuard` unchanged.
//
// Turn model (verified by Phase-0 spike 0.2; fixtures in spike/fixtures/):
//   - A turn STARTS on a `user` row whose `promptSource` is a non-empty string
//     (`"sdk"` for headless/QiYan-driven turns). A `user` row with a null
//     `promptSource` carries a `tool_result` and is mid-turn, NOT a boundary.
//   - A turn ENDS on an `assistant` row with `stop_reason === "end_turn"`.
//   - Every turn starts with a user message, so `hasUserMessage` is always true;
//     ownership therefore hinges on the QiYan clientId marker (below): an owned
//     turn carries it, an external (human-resumed) turn does not.
//   - An interrupted turn (subprocess killed mid-generation) leaves the turn-start
//     user row with no `end_turn` assistant row — it is reported as `openTurn`.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type { RolloutCursor, RolloutScanResult, RolloutTurnStart } from "./rollout-ownership.ts";

const readChunkBytes = 64 * 1024;
const maxLineBytes = 64 * 1024 * 1024;
const maxReportedStarts = 1024;

// QiYan stamps this marker into every turn message it drives and reads it back
// from the verbatim-stored user row to prove ownership (spike 0.2: message content
// is persisted verbatim). The clientId is `<contextId>:<callId>` of the driving
// `send_to_session` operation, which `OperationStore.ownsWorkerTurn` matches.
const clientMarkerPattern = /<!--\s*qiyan-cid:([A-Za-z0-9:_.-]{1,256})\s*-->/u;

export function encodeClaudeClientMarker(clientId: string): string {
  return `<!-- qiyan-cid:${clientId} -->`;
}

function safeThreadId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
}

// A Claude transcript is `<session_id>.jsonl` (session_id === threadId); the Codex
// validator hard-rejects this (it requires `rollout-*`), which is why this is a
// separate scanner.
export function validClaudeTranscriptPath(path: string, threadId: string): boolean {
  return isAbsolute(path) && safeThreadId(threadId) && basename(path) === `${threadId}.jsonl`;
}

export async function scanLocalClaudeTranscript(request: {
  path: string;
  threadId: string;
  cursor?: RolloutCursor;
  collectFromStart?: true;
}): Promise<RolloutScanResult> {
  if (!validClaudeTranscriptPath(request.path, request.threadId)) {
    throw new Error("invalid claude transcript scan request");
  }
  const offset = request.cursor?.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid claude transcript cursor");
  const file = await open(request.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = await file.stat({ bigint: true });
    if (!state.isFile() || state.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid claude transcript cursor");
    const device = state.dev.toString(10);
    const inode = state.ino.toString(10);
    if (request.cursor && (request.cursor.device !== device || request.cursor.inode !== inode)) throw new Error("claude transcript identity changed");
    if (BigInt(offset) > state.size) throw new Error("claude transcript was truncated");
    const parser = await parseTranscriptFile(file, offset, Number(state.size), request.cursor !== undefined || request.collectFromStart === true);
    const after = await file.stat({ bigint: true });
    if (after.dev !== state.dev || after.ino !== state.ino) throw new Error("claude transcript identity changed");
    if (after.size < state.size) throw new Error("claude transcript was truncated");
    if (after.size > state.size) throw new Error("claude transcript appended while scanning");
    if (after.mtimeNs !== state.mtimeNs) throw new Error("claude transcript changed while scanning");
    return parser.result({ device, inode, offset });
  } finally {
    await file.close();
  }
}

interface PendingTurn extends RolloutTurnStart { startOffset: number }

class ClaudeTranscriptParser {
  private readonly starts: RolloutTurnStart[] = [];
  private current: PendingTurn | undefined;
  private parsedEnd: number;
  private malformedOffset: number | undefined;

  constructor(baseOffset: number, private readonly collectStarts: boolean) { this.parsedEnd = baseOffset; }

  consume(raw: Buffer, lineStart: number, lineEnd: number): void {
    this.parsedEnd = lineEnd;
    if (raw.byteLength === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(raw.toString("utf8")) as unknown;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // A malformed line is an uncertainty boundary; keep any already-observed
      // turn visible (its ownership evidence matters) but stop coalescing across it.
      this.malformedOffset ??= lineStart;
      if (this.current) this.report(this.current);
      this.current = undefined;
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    const type = record.type;
    if (type === "user") {
      // Only a non-empty promptSource marks a genuine turn start; a null-promptSource
      // user row is a tool_result (mid-turn) and must NOT open a new turn.
      const promptSource = record.promptSource;
      if (typeof promptSource !== "string" || promptSource.length === 0) return;
      const turnId = turnIdOf(record);
      if (!turnId) return;
      if (this.current) this.report(this.current);
      const pending: PendingTurn = { turnId, startOffset: lineStart, hasUserMessage: true };
      const clientId = extractClientMarker(record.message);
      if (clientId) pending.clientId = clientId;
      this.current = pending;
      return;
    }
    if (type === "assistant" && this.current && isEndTurn(record)) {
      this.report(this.current);
      this.current = undefined;
    }
  }

  result(identity: RolloutCursor): RolloutScanResult {
    // Every Claude turn starts with a user message, so an open (incomplete/
    // interrupted) turn is a real observed turn: report it AND surface it as
    // openTurn, and advance the cursor past it — mirroring the Codex scanner's
    // handling of an open turn that has seen its user message.
    if (this.current) this.report(this.current);
    const cursorOffset = this.malformedOffset === undefined ? this.parsedEnd : Math.min(this.parsedEnd, this.malformedOffset);
    return {
      cursor: { ...identity, offset: cursorOffset },
      starts: this.starts,
      ...(this.current ? { openTurn: publicStart(this.current) } : {}),
      ...(this.malformedOffset === undefined ? {} : { malformed: true }),
    };
  }

  private report(turn: PendingTurn): void {
    if (!this.collectStarts) return;
    if (this.starts.length >= maxReportedStarts) throw new Error("claude transcript scan contains too many turns");
    this.starts.push(publicStart(turn));
  }
}

async function parseTranscriptFile(
  file: Awaited<ReturnType<typeof open>>,
  offset: number,
  size: number,
  collectStarts: boolean,
): Promise<ClaudeTranscriptParser> {
  const parser = new ClaudeTranscriptParser(offset, collectStarts);
  let position = offset;
  let carry = Buffer.alloc(0);
  let carryStart = offset;
  while (position < size) {
    const chunk = Buffer.allocUnsafe(Math.min(readChunkBytes, size - position));
    const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, position);
    if (bytesRead === 0) throw new Error("claude transcript was truncated");
    position += bytesRead;
    const bytes = carry.byteLength === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
    let lineStart = 0;
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (bytes[index] !== 0x0a) continue;
      parser.consume(bytes.subarray(lineStart, index), carryStart + lineStart, carryStart + index + 1);
      lineStart = index + 1;
    }
    carryStart += lineStart;
    carry = Buffer.from(bytes.subarray(lineStart));
    if (carry.byteLength > maxLineBytes) throw new Error("claude transcript line exceeds the maximum size");
  }
  return parser;
}

function turnIdOf(record: Record<string, unknown>): string | undefined {
  if (typeof record.promptId === "string" && record.promptId.length > 0) return record.promptId;
  if (typeof record.uuid === "string" && record.uuid.length > 0) return record.uuid;
  return undefined;
}

function isEndTurn(record: Record<string, unknown>): boolean {
  const message = record.message;
  return !!message && typeof message === "object" && !Array.isArray(message)
    && (message as Record<string, unknown>).stop_reason === "end_turn";
}

// Extracts ONLY QiYan's own clientId marker; the message body is never returned.
function extractClientMarker(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const content = (message as Record<string, unknown>).content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string") {
        text += `${(block as Record<string, unknown>).text as string}\n`;
      }
    }
  }
  const match = clientMarkerPattern.exec(text);
  return match ? match[1] : undefined;
}

function publicStart(turn: PendingTurn): RolloutTurnStart {
  return {
    turnId: turn.turnId,
    ...(turn.clientId ? { clientId: turn.clientId } : {}),
    ...(turn.hasUserMessage ? { hasUserMessage: true as const } : {}),
  };
}
