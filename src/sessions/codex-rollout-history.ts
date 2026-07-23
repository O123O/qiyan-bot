import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

export interface RolloutLine {
  offset: number;
  line: string;
}

export interface RolloutSlice {
  device: string;
  inode: string;
  size: number;
  start: number;
  end: number;
  rows: RolloutLine[];
}

export interface CodexRolloutHistoryMessage {
  id: string;
  turnId: string;
  body: string;
  completedAt: number;
  terminalStatus: string;
  turnOrder: number;
  itemOrder: number;
  role?: "you";
  clientId?: string;
  phase?: string;
}

export interface CodexRolloutHistoryPage {
  messages: CodexRolloutHistoryMessage[];
  hasOlder: boolean;
  nextCursor?: string;
  openTurnIds: string[];
  terminalTurnIds: string[];
}

export interface CodexRolloutHistoryDeps {
  readSlice(path: string, threadId: string, before: number | undefined, maxBytes: number, signal: AbortSignal): Promise<RolloutSlice>;
}

export function parseRolloutSlice(value: unknown): RolloutSlice {
  const raw = record(value);
  if (!raw || typeof raw.device !== "string" || !raw.device || typeof raw.inode !== "string" || !raw.inode
    || !Number.isSafeInteger(raw.size) || Number(raw.size) < 0
    || !Number.isSafeInteger(raw.start) || Number(raw.start) < 0
    || !Number.isSafeInteger(raw.end) || Number(raw.end) < Number(raw.start)
    || !Array.isArray(raw.rows)) throw new Error("invalid rollout history slice");
  const rows = raw.rows.map((value) => {
    const item = record(value);
    if (!item || !Number.isSafeInteger(item.offset) || Number(item.offset) < Number(raw.start)
      || Number(item.offset) >= Number(raw.end) || typeof item.line !== "string") throw new Error("invalid rollout history slice");
    return { offset: Number(item.offset), line: item.line };
  });
  return {
    device: raw.device, inode: raw.inode, size: Number(raw.size), start: Number(raw.start), end: Number(raw.end), rows,
  };
}

interface HistoryCursor {
  version: 2;
  thread: string;
  device: string;
  inode: string;
  before: number;
  state: HistoryState;
}

interface ParsedMessage extends CodexRolloutHistoryMessage { offset: number }
type TerminalStatus = "completed" | "failed" | "interrupted";
interface HistoryState {
  terminal: Array<[string, TerminalStatus]>;
  excluded: string[];
  rollbackDebt: number;
  rollbackOpen: string[];
}

const SLICE_BYTES = 8 * 1024 * 1024;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_CURSOR_BYTES = 16_384;
const TERMINAL_LIMIT = 50;
const CURSOR_TURN_LIMIT = 200;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const string = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;

const binding = (path: string, threadId: string): string =>
  createHash("sha256").update(`${threadId}\0${path}`).digest("base64url");

function decodeCursor(value: string | undefined, path: string, threadId: string): HistoryCursor | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid worker history cursor");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new Error("invalid worker history cursor"); }
  const cursor = record(parsed);
  const state = record(cursor?.state);
  const terminal = Array.isArray(state?.terminal) ? state.terminal : undefined;
  const excluded = Array.isArray(state?.excluded) ? state.excluded : undefined;
  const rollbackOpen = Array.isArray(state?.rollbackOpen) ? state.rollbackOpen : undefined;
  if (cursor?.version !== 2 || cursor.thread !== binding(path, threadId)
    || typeof cursor.device !== "string" || !cursor.device
    || typeof cursor.inode !== "string" || !cursor.inode
    || !Number.isSafeInteger(cursor.before) || Number(cursor.before) <= 0
    || !terminal || terminal.length > CURSOR_TURN_LIMIT
    || terminal.some((item) => !Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !item[0]
      || !["completed", "failed", "interrupted"].includes(String(item[1])))
    || !excluded || excluded.length > CURSOR_TURN_LIMIT || excluded.some((item) => typeof item !== "string" || !item)
    || !rollbackOpen || rollbackOpen.length > CURSOR_TURN_LIMIT || rollbackOpen.some((item) => typeof item !== "string" || !item)
    || !Number.isSafeInteger(state?.rollbackDebt) || Number(state?.rollbackDebt) < 0 || Number(state?.rollbackDebt) > 1_000) {
    throw new Error("invalid worker history cursor");
  }
  return cursor as unknown as HistoryCursor;
}

function encodeCursor(path: string, threadId: string, slice: RolloutSlice, before: number, state: HistoryState): string {
  return Buffer.from(JSON.stringify({
    version: 2, thread: binding(path, threadId), device: slice.device, inode: slice.inode, before, state,
  } satisfies HistoryCursor), "utf8").toString("base64url");
}

const timestamp = (value: unknown): number => {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

const stripSetup = (text: string): string => text.replace(/^\s*<environment_context>[\s\S]*?<\/environment_context>\s*/iu, "").trim();

function relevantRolloutLine(line: string): boolean {
  return (line.includes('"type":"response_item"') && line.includes('"type":"message"') && line.includes('"role":"assistant"'))
    || (line.includes('"type":"event_msg"')
      && (line.includes('"type":"user_message"') || line.includes('"type":"task_started"') || line.includes('"type":"task_complete"')
        || line.includes('"type":"turn_aborted"') || line.includes('"type":"thread_rolled_back"')));
}

function filteredLines(bytes: Buffer, absoluteStart: number, completeStart: boolean, completeEnd: boolean): RolloutLine[] {
  const rows: RolloutLine[] = [];
  let start = completeStart ? 0 : bytes.indexOf(0x0a) + 1;
  if (start <= 0 && !completeStart) return rows;
  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start);
    const end = newline >= 0 ? newline : completeEnd ? bytes.length : -1;
    if (end < 0) break;
    if (end > start) {
      const line = bytes.toString("utf8", start, end);
      if (relevantRolloutLine(line)) rows.push({ offset: absoluteStart + start, line });
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  return rows;
}

export async function readLocalRolloutSlice(
  path: string,
  threadId: string,
  before: number | undefined,
  maxBytes: number,
  signal: AbortSignal,
  allowMissing = false,
): Promise<RolloutSlice> {
  if (!isAbsolute(path) || !basename(path).startsWith("rollout-") || !basename(path).endsWith(`-${threadId}.jsonl`)
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > SLICE_BYTES) throw new Error("invalid rollout history read");
  if (signal.aborted) throw signal.reason ?? new Error("worker history read cancelled");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (allowMissing && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!file) return { device: "unmaterialized", inode: threadId, size: 0, start: 0, end: 0, rows: [] };
  try {
    const state = await file.stat({ bigint: true });
    const uid = process.getuid?.();
    if (!state.isFile() || state.size > BigInt(Number.MAX_SAFE_INTEGER) || (uid !== undefined && state.uid !== BigInt(uid))) {
      throw new Error("invalid rollout history file");
    }
    const size = Number(state.size);
    const end = before === undefined ? size : before;
    if (!Number.isSafeInteger(end) || end < 0 || end > size) throw new Error("invalid rollout history offset");
    const start = Math.max(0, end - maxBytes);
    const bytes = Buffer.alloc(end - start);
    let filled = 0;
    while (filled < bytes.length) {
      if (signal.aborted) throw signal.reason ?? new Error("worker history read cancelled");
      const read = await file.read(bytes, filled, bytes.length - filled, start + filled);
      if (read.bytesRead === 0) throw new Error("rollout history file changed");
      filled += read.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (after.dev !== state.dev || after.ino !== state.ino || after.size < BigInt(end)) throw new Error("rollout history file changed");
    return {
      device: state.dev.toString(10), inode: state.ino.toString(10), size, start, end,
      rows: filteredLines(bytes, start, start === 0, end === size),
    };
  } finally { await file.close(); }
}

function messageText(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.content)) return "";
  return payload.content.flatMap((raw) => {
    const item = record(raw);
    return (item?.type === "input_text" || item?.type === "output_text") && typeof item.text === "string" ? [item.text] : [];
  }).join("").trim();
}

function parseRows(
  rows: readonly RolloutLine[],
  threadId: string,
  nativeStatus: string,
  activeTurnId: string | null,
  seed: HistoryState = { terminal: [], excluded: [], rollbackDebt: 0, rollbackOpen: [] },
): {
  messages: ParsedMessage[];
  terminalTurnIds: string[];
  state: HistoryState;
} {
  const messages: ParsedMessage[] = [];
  const statuses = new Map<string, TerminalStatus>(seed.terminal);
  const excluded = new Set(seed.excluded);
  const turnOrder: Array<{ turnId: string; offset: number; hasUser: boolean }> = [];
  const turns = new Map<string, { turnId: string; offset: number; hasUser: boolean }>();
  const rollbacks: Array<{ offset: number; count: number }> = [];
  let currentTurn: string | undefined;
  let unassigned: number[] = [];

  const rememberTurn = (turnId: string, offset: number, hasUser = false): void => {
    const existing = turns.get(turnId);
    if (existing) {
      if (hasUser) existing.hasUser = true;
      return;
    }
    const turn = { turnId, offset, hasUser };
    turns.set(turnId, turn);
    turnOrder.push(turn);
  };
  const assign = (indexes: readonly number[], turnId: string): void => {
    for (const index of indexes) {
      const message = messages[index];
      if (!message) continue;
      message.turnId = turnId;
      rememberTurn(turnId, message.offset, message.role === "you");
    }
  };

  for (const row of [...rows].sort((left, right) => left.offset - right.offset)) {
    let outer: Record<string, unknown> | undefined;
    try { outer = record(JSON.parse(row.line)); } catch { continue; }
    const payload = record(outer?.payload);
    if (!payload) continue;
    if (outer?.type === "event_msg" && payload.type === "task_started") {
      currentTurn = string(payload.turn_id);
      if (currentTurn) rememberTurn(currentTurn, row.offset);
      continue;
    }
    if (outer?.type === "event_msg" && payload.type === "user_message") {
      const turn = currentTurn ?? `rollout:${threadId}:${row.offset}`;
      const clientId = string(payload.client_id);
      rememberTurn(turn, row.offset, true);
      const body = stripSetup(typeof payload.message === "string" ? payload.message : "");
      if (body) messages.push({
        id: `u:${threadId}:${row.offset}`,
        turnId: turn,
        body,
        completedAt: timestamp(outer.timestamp),
        terminalStatus: "unknown",
        turnOrder: row.offset,
        itemOrder: row.offset,
        offset: row.offset,
        role: "you",
        ...(clientId ? { clientId } : {}),
      });
      continue;
    }
    if (outer?.type === "event_msg" && (payload.type === "task_complete" || payload.type === "turn_aborted")) {
      const completedTurn = string(payload.turn_id);
      if (!completedTurn) continue;
      if (!currentTurn && unassigned.length > 0) {
        assign(unassigned, completedTurn);
        unassigned = [];
      }
      rememberTurn(completedTurn, row.offset);
      statuses.set(completedTurn, payload.type === "turn_aborted" ? "interrupted" : payload.error == null ? "completed" : "failed");
      if (currentTurn === completedTurn) currentTurn = undefined;
      continue;
    }
    if (outer?.type === "event_msg" && payload.type === "thread_rolled_back") {
      const count = Number(payload.num_turns);
      if (Number.isSafeInteger(count) && count > 0 && count <= 1_000) rollbacks.push({ offset: row.offset, count });
      continue;
    }
    if (outer?.type !== "response_item" || payload.type !== "message") continue;
    const role = payload.role;
    if (role !== "assistant") continue;
    const metadata = record(payload.internal_chat_message_metadata_passthrough);
    const turn = string(metadata?.turn_id) ?? currentTurn ?? "";
    const body = messageText(payload);
    if (!body) continue;
    const index = messages.length;
    const phase = string(payload.phase);
    messages.push({
      id: `a:${threadId}:${row.offset}`,
      turnId: turn,
      body,
      completedAt: timestamp(outer.timestamp),
      terminalStatus: "unknown",
      turnOrder: row.offset,
      itemOrder: row.offset,
      offset: row.offset,
      ...(phase ? { phase } : {}),
    });
    if (turn) rememberTurn(turn, row.offset);
    else unassigned.push(index);
  }

  if (unassigned.length > 0) {
    const fallback = nativeStatus === "active" && activeTurnId ? activeTurnId : `rollout:${threadId}:${messages[unassigned[0]!]!.offset}`;
    assign(unassigned, fallback);
  }

  let rollbackDebt = 0;
  let rollbackOpen: string[] = [];
  const applyRollback = (count: number, beforeOffset: number, pending: readonly string[] = []): void => {
    if (count <= 0) return;
    let remaining = count;
    const unresolved: string[] = [];
    for (const turnId of pending) {
      if (remaining <= 0) break;
      if (turns.get(turnId)?.hasUser) remaining -= 1;
      else unresolved.push(turnId);
    }
    const candidates = turnOrder.filter((turn) => turn.offset < beforeOffset && !excluded.has(turn.turnId));
    for (let index = candidates.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const turn = candidates[index]!;
      excluded.add(turn.turnId);
      if (turn.hasUser) remaining -= 1;
      else unresolved.push(turn.turnId);
    }
    rollbackDebt += remaining;
    if (remaining > 0) rollbackOpen.push(...unresolved);
  };
  for (const rollback of rollbacks) applyRollback(rollback.count, rollback.offset);
  applyRollback(seed.rollbackDebt, Number.POSITIVE_INFINITY, seed.rollbackOpen);
  if (excluded.size > CURSOR_TURN_LIMIT) throw new Error("rollout rollback history exceeds cursor limit");
  rollbackOpen = [...new Set(rollbackOpen)];
  if (rollbackOpen.length > CURSOR_TURN_LIMIT) throw new Error("rollout rollback history exceeds cursor limit");

  const visible = messages.filter((message) => !excluded.has(message.turnId));
  for (const message of visible) {
    message.terminalStatus = nativeStatus === "active" && activeTurnId === message.turnId
      ? "inProgress"
      : statuses.get(message.turnId) ?? "unknown";
  }
  const terminal = [...statuses.entries()].filter(([turnId]) => !excluded.has(turnId)).slice(-CURSOR_TURN_LIMIT);
  return {
    messages: visible,
    terminalTurnIds: terminal.map(([turnId]) => turnId).slice(-TERMINAL_LIMIT),
    state: { terminal, excluded: [...excluded], rollbackDebt, rollbackOpen },
  };
}

export async function readCodexRolloutHistoryPage(
  deps: CodexRolloutHistoryDeps,
  input: {
    path: string;
    threadId: string;
    nativeStatus: string;
    activeTurnId: string | null;
    limit: number;
    cursor?: string;
  },
  signal: AbortSignal,
): Promise<CodexRolloutHistoryPage> {
  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit) || 20));
  const cursor = decodeCursor(input.cursor, input.path, input.threadId);
  let before = cursor?.before;
  let scanned = 0;
  let earliest = before;
  let identity: RolloutSlice | undefined;
  const rows: RolloutLine[] = [];

  while (scanned < MAX_SCAN_BYTES) {
    if (signal.aborted) throw signal.reason ?? new Error("worker history read cancelled");
    const maxBytes = Math.min(SLICE_BYTES, MAX_SCAN_BYTES - scanned);
    const slice = await deps.readSlice(input.path, input.threadId, before, maxBytes, signal);
    if (cursor && (slice.device !== cursor.device || slice.inode !== cursor.inode)) throw new Error("worker history cursor is stale");
    identity ??= slice;
    if (slice.end > slice.size || slice.start < 0 || slice.start > slice.end || (before !== undefined && slice.end !== before)) {
      throw new Error("invalid rollout history slice");
    }
    rows.push(...slice.rows);
    scanned += slice.end - slice.start;
    earliest = slice.start;
    const parsed = parseRows(rows, input.threadId, input.nativeStatus, input.activeTurnId, cursor?.state);
    if (parsed.messages.length > limit || slice.start === 0 || slice.start === slice.end) break;
    before = slice.start;
  }

  if (!identity) return { messages: [], hasOlder: false, openTurnIds: [], terminalTurnIds: [] };
  const parsed = parseRows(rows, input.threadId, input.nativeStatus, input.activeTurnId, cursor?.state);
  const selected = parsed.messages.slice(-limit);
  const hasOlder = parsed.messages.length > selected.length || Number(earliest) > 0;
  const firstOffset = selected[0]?.offset ?? earliest;
  const nextState = typeof firstOffset === "number"
    ? parseRows(rows.filter((row) => row.offset >= firstOffset), input.threadId, input.nativeStatus, input.activeTurnId, cursor?.state).state
    : parsed.state;
  const nextCursor = hasOlder && typeof firstOffset === "number" && firstOffset > 0
    ? encodeCursor(input.path, input.threadId, identity, firstOffset, nextState)
    : undefined;
  return {
    messages: selected.map(({ offset: _offset, ...message }) => message),
    hasOlder: nextCursor !== undefined,
    ...(nextCursor ? { nextCursor } : {}),
    openTurnIds: input.nativeStatus === "active" && input.activeTurnId ? [input.activeTurnId] : [],
    terminalTurnIds: parsed.terminalTurnIds,
  };
}
