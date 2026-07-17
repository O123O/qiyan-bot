import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type { WorkerHistoryMessage, WorkerHistoryPage } from "./worker-history-reader.ts";

const MAX_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_RECORDS = 20_000;
const MAX_PARSE_LINE_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PAGE_JSON_BYTES = 700 * 1024;
const MAX_PAGE_FRAME_BYTES = 768 * 1024;
const MAX_CURSOR_BYTES = 4096;
const MAX_CURSOR_TERMINALS = 16;
const TERMINAL = new Set(["completed", "failed", "interrupted"]);
const TURN_STATUS = new Set([...TERMINAL, "inProgress"]);

interface PendingLine { start: number; end: number }
interface TurnTerminal { status: string; at: number }
interface ResolvedTurn { turnId: string; status: string; at: number; turnOrder: number }
interface HistoryCursor {
  device: string;
  inode: string;
  before: number;
  pending: PendingLine[];
  terminals: Array<{ turnId: string; status: string; at: number }>;
  skipPartial: boolean;
  pendingSkipped: boolean;
  activeTurnId?: string;
  resolved?: ResolvedTurn;
}

interface MaterializedPending {
  consumed: number;
  emitted: number;
  pageJsonBytes: number;
  oldestSelectedOffset?: number;
  filled: boolean;
}
interface ReverseLine { start: number; end: number; bytes?: Buffer }
interface ReverseWindow { lines: ReverseLine[]; nextBefore: number; hasMore: boolean; skipPartial: boolean }
interface PendingMessage {
  lineStart: number;
  role: "you" | "worker";
  body: string;
  at: number;
  nativeId?: string;
  clientId?: string;
  phase?: string;
}

export interface CodexRolloutHistoryRequest {
  path: string;
  threadId: string;
  limit: number;
  activeTurnId?: string;
  cursor?: string;
}

/**
 * Reads one bounded reverse window from Codex's durable rollout. A cursor carries only byte
 * offsets needed to finish assigning a turn ID when a tool-heavy turn crosses windows; message
 * bodies stay in Codex's rollout and only the requested foreground page is materialized.
 */
export async function readCodexRolloutHistory(request: CodexRolloutHistoryRequest): Promise<WorkerHistoryPage> {
  validateRequest(request);
  const file = await open(request.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = await file.stat({ bigint: true });
    const uid = process.getuid?.();
    if (!state.isFile() || state.size > BigInt(Number.MAX_SAFE_INTEGER)
      || (uid !== undefined && state.uid !== BigInt(uid))) throw new Error("invalid Codex rollout file");
    const device = state.dev.toString(10);
    const inode = state.ino.toString(10);
    const cursor = decodeCursor(request.cursor);
    if (cursor && (cursor.device !== device || cursor.inode !== inode || BigInt(cursor.before) > state.size)) {
      throw new Error("Codex rollout history cursor is stale");
    }
    if (cursor?.pending.some((entry) => BigInt(entry.end) > state.size || entry.start < cursor.before)) {
      throw new Error("Codex rollout history cursor is stale");
    }
    const before = cursor?.before ?? Number(state.size);
    const pageSize = Math.max(1, Math.min(50, Math.trunc(request.limit) || 20));
    let pending = cursor?.pending ?? [];
    let pendingBytes = pendingLength(pending);
    let pendingSkipped = cursor?.pendingSkipped ?? false;
    const terminal = new Map((cursor?.terminals ?? []).map((entry) => [entry.turnId, { status: entry.status, at: entry.at }]));
    const messages: WorkerHistoryMessage[] = [];
    const openTurnIds: string[] = [];
    const terminalTurnIds: string[] = [];
    const parsedVisible = new Map<number, PendingMessage>();
    let pageJsonBytes = 128;
    let oldestSelectedOffset: number | undefined;
    let pageFilled = false;
    let pageBoundaryOffset: number | undefined;
    let carryTerminal: { turnId: string; status: string; at: number } | undefined;
    let resolvedCursor: HistoryCursor | undefined;
    let unresolvedActiveTurnId = cursor?.activeTurnId ?? (cursor ? undefined : request.activeTurnId);

    if (cursor?.resolved) {
      const materialized = await materializePending(
        file, pending, cursor.resolved, parsedVisible, messages, pageSize, pageJsonBytes,
      );
      pageJsonBytes = materialized.pageJsonBytes;
      oldestSelectedOffset = materialized.oldestSelectedOffset;
      pending = pending.slice(materialized.consumed);
      pendingBytes = pendingLength(pending);
      rememberTurnPresentation(cursor.resolved, materialized.emitted, openTurnIds, terminalTurnIds);
      if (pending.length > 0) {
        resolvedCursor = {
          device, inode, before, pending, terminals: cursor.terminals, skipPartial: false,
          pendingSkipped: false, ...(cursor.activeTurnId ? { activeTurnId: cursor.activeTurnId } : {}), resolved: cursor.resolved,
        };
        return finishPage(messages, openTurnIds, terminalTurnIds, encodeCursor(resolvedCursor));
      }
      if (messages.length >= pageSize || materialized.filled) {
        const nextCursor = before > 0
          ? encodeCursor({
            device, inode, before, pending: [], terminals: [], skipPartial: false, pendingSkipped: false,
            ...(cursor.activeTurnId ? { activeTurnId: cursor.activeTurnId } : {}),
          })
          : undefined;
        return finishPage(messages, openTurnIds, terminalTurnIds, nextCursor);
      }
    }

    const window = await readReverseWindow(file, before, cursor?.skipPartial ?? false);

    for (const line of window.lines) {
      if (!line.bytes) continue;
      const value = parseRecord(line.bytes);
      if (!value) continue;
      const payload = record(value.payload);
      const timestamp = timestampMillis(value.timestamp);
      if (value.type === "event_msg" && payload) {
        const eventType = text(payload.type);
        const turnId = text(payload.turn_id);
        const terminalStatus = terminalStatusFor(eventType);
        if (terminalStatus && turnId) {
          rememberTerminal(terminal, turnId, { status: terminalStatus, at: timestamp });
          continue;
        }
        if ((eventType === "task_started" || eventType === "turn_started") && turnId) {
          if (turnId === unresolvedActiveTurnId) unresolvedActiveTurnId = undefined;
          const proof = terminal.get(turnId);
          const status = proof?.status ?? "inProgress";
          const resolved: ResolvedTurn = { turnId, status, at: proof?.at ?? -1, turnOrder: line.start };
          const materialized = await materializePending(file, pending, resolved, parsedVisible, messages, pageSize, pageJsonBytes);
          pageJsonBytes = materialized.pageJsonBytes;
          oldestSelectedOffset = materialized.oldestSelectedOffset ?? oldestSelectedOffset;
          const remaining = pending.slice(materialized.consumed);
          rememberTurnPresentation(resolved, materialized.emitted, openTurnIds, terminalTurnIds);
          if (remaining.length > 0) {
            resolvedCursor = {
              device, inode, before: line.start, pending: remaining, terminals: [], skipPartial: false,
              pendingSkipped: false, resolved,
            };
            pageFilled = true;
            break;
          }
          if (pendingSkipped && proof) carryTerminal = { turnId, status, at: proof.at };
          pending = [];
          pendingBytes = 0;
          terminal.delete(turnId);
          if (pendingSkipped || messages.length >= pageSize || materialized.filled) {
            pageFilled = true; pageBoundaryOffset = line.start; break;
          }
          pendingSkipped = false;
          continue;
        }
        if (eventType === "user_message" && typeof payload.message === "string") {
          const item = visibleUser(line.start, payload, timestamp);
          const descriptor = { start: line.start, end: line.end };
          if (item && canRetainPending(pending, pendingBytes, descriptor, messages.length, pageSize)) {
            pending.push(descriptor);
            pendingBytes += line.end - line.start;
            parsedVisible.set(line.start, item);
          } else if (item) pendingSkipped = true;
        }
        continue;
      }
      if (value.type !== "response_item" || !payload || payload.type !== "message" || payload.role !== "assistant") continue;
      const item = visibleAssistant(line.start, payload, timestamp);
      const descriptor = { start: line.start, end: line.end };
      if (item && canRetainPending(pending, pendingBytes, descriptor, messages.length, pageSize)) {
        pending.push(descriptor);
        pendingBytes += line.end - line.start;
        parsedVisible.set(line.start, item);
      } else if (item) pendingSkipped = true;
    }

    // A single active turn can grow beyond the reverse-scan budget. The App Server already tells us
    // its exact ID, so recent visible records do not need to wait for a task_started line several
    // windows away. Carry that proof in the cursor until the matching start boundary is crossed.
    if (!resolvedCursor && !pageFilled && unresolvedActiveTurnId && pending.length > 0) {
      const resolved: ResolvedTurn = {
        turnId: unresolvedActiveTurnId, status: "inProgress", at: -1, turnOrder: window.nextBefore,
      };
      const materialized = await materializePending(file, pending, resolved, parsedVisible, messages, pageSize, pageJsonBytes);
      pageJsonBytes = materialized.pageJsonBytes;
      oldestSelectedOffset = materialized.oldestSelectedOffset ?? oldestSelectedOffset;
      const remaining = pending.slice(materialized.consumed);
      rememberTurnPresentation(resolved, materialized.emitted, openTurnIds, terminalTurnIds);
      if (remaining.length > 0) {
        resolvedCursor = {
          device, inode, before: window.nextBefore, pending: remaining, terminals: [], skipPartial: false,
          pendingSkipped: false, activeTurnId: unresolvedActiveTurnId, resolved,
        };
        pageFilled = true;
      } else {
        pending = [];
        pendingBytes = 0;
        if (pendingSkipped || messages.length >= pageSize || materialized.filled) {
          pageFilled = true;
          pageBoundaryOffset = materialized.oldestSelectedOffset ?? window.nextBefore;
        }
      }
    }

    messages.sort((left, right) => left.itemOrder - right.itemOrder);
    let nextCursor: string | undefined;
    if (resolvedCursor) {
      nextCursor = encodeCursor(resolvedCursor);
    } else if (pageFilled && pendingSkipped && oldestSelectedOffset !== undefined && oldestSelectedOffset > 0) {
      nextCursor = encodeCursor({
        device, inode, before: oldestSelectedOffset, pending: [],
        terminals: carryTerminal ? [carryTerminal] : [], skipPartial: false, pendingSkipped: false,
        ...(unresolvedActiveTurnId ? { activeTurnId: unresolvedActiveTurnId } : {}),
      });
    } else if (pageFilled && (pageBoundaryOffset ?? 0) > 0) {
      nextCursor = encodeCursor({
        device, inode, before: pageBoundaryOffset!, pending: [], terminals: [], skipPartial: false, pendingSkipped: false,
        ...(unresolvedActiveTurnId ? { activeTurnId: unresolvedActiveTurnId } : {}),
      });
    } else if (window.hasMore) {
      nextCursor = encodeCursor({
        device, inode, before: window.nextBefore, pending,
        terminals: [...terminal].slice(-MAX_CURSOR_TERMINALS).map(([turnId, proof]) => ({ turnId, ...proof })),
        skipPartial: window.skipPartial, pendingSkipped,
        ...(unresolvedActiveTurnId ? { activeTurnId: unresolvedActiveTurnId } : {}),
      });
    }
    return finishPage(messages, openTurnIds, terminalTurnIds, nextCursor);
  } finally {
    await file.close();
  }
}

async function materializePending(
  file: Awaited<ReturnType<typeof open>>,
  pending: readonly PendingLine[],
  resolved: ResolvedTurn,
  parsedVisible: ReadonlyMap<number, PendingMessage>,
  messages: WorkerHistoryMessage[],
  pageSize: number,
  initialPageJsonBytes: number,
): Promise<MaterializedPending> {
  let pageJsonBytes = initialPageJsonBytes;
  let emitted = 0;
  let oldestSelectedOffset: number | undefined;
  for (let index = 0; index < pending.length; index += 1) {
    if (messages.length >= pageSize) {
      return { consumed: index, emitted, pageJsonBytes, ...(oldestSelectedOffset === undefined ? {} : { oldestSelectedOffset }), filled: true };
    }
    const descriptor = pending[index]!;
    const item = parsedVisible.get(descriptor.start) ?? await readPendingMessage(file, descriptor);
    if (!item) continue;
    const nativeId = item.nativeId ?? item.clientId ?? `rollout-${item.lineStart}`;
    const message: WorkerHistoryMessage = {
      id: `${item.role === "you" ? "u" : "a"}:${resolved.turnId}:${nativeId}`,
      turnId: resolved.turnId, body: item.body,
      completedAt: resolved.at >= 0 ? resolved.at : item.at,
      terminalStatus: resolved.status, turnOrder: resolved.turnOrder, itemOrder: item.lineStart,
      ...(item.role === "you" ? { role: "you" as const } : {}),
      ...(item.clientId ? { clientId: item.clientId } : {}),
      ...(item.phase ? { phase: item.phase } : {}),
    };
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8") + 1;
    if (pageJsonBytes + bytes > MAX_PAGE_JSON_BYTES) {
      return { consumed: index, emitted, pageJsonBytes, ...(oldestSelectedOffset === undefined ? {} : { oldestSelectedOffset }), filled: true };
    }
    messages.push(message);
    emitted += 1;
    pageJsonBytes += bytes;
    oldestSelectedOffset = descriptor.start;
  }
  return {
    consumed: pending.length, emitted, pageJsonBytes,
    ...(oldestSelectedOffset === undefined ? {} : { oldestSelectedOffset }), filled: false,
  };
}

function canRetainPending(
  pending: readonly PendingLine[],
  pendingBytes: number,
  descriptor: PendingLine,
  emittedMessages: number,
  pageSize: number,
): boolean {
  return pending.length + emittedMessages < pageSize
    && pendingBytes + descriptor.end - descriptor.start <= MAX_PENDING_BYTES;
}

function pendingLength(pending: readonly PendingLine[]): number {
  return pending.reduce((total, descriptor) => total + descriptor.end - descriptor.start, 0);
}

function rememberTurnPresentation(
  resolved: ResolvedTurn,
  emitted: number,
  openTurnIds: string[],
  terminalTurnIds: string[],
): void {
  if (emitted === 0) return;
  if (TERMINAL.has(resolved.status)) terminalTurnIds.push(resolved.turnId);
  else openTurnIds.push(resolved.turnId);
}

function finishPage(
  messages: WorkerHistoryMessage[],
  openTurnIds: string[],
  terminalTurnIds: string[],
  nextCursor?: string,
): WorkerHistoryPage {
  messages.sort((left, right) => left.itemOrder - right.itemOrder);
  const page: WorkerHistoryPage = {
    messages, hasOlder: nextCursor !== undefined, ...(nextCursor ? { nextCursor } : {}),
    openTurnIds: [...new Set(openTurnIds)], terminalTurnIds: [...new Set(terminalTurnIds)].slice(-50),
  };
  if (Buffer.byteLength(JSON.stringify(page), "utf8") > MAX_PAGE_FRAME_BYTES) {
    throw new Error("Codex rollout history page exceeds the Web UI frame budget");
  }
  return page;
}

async function readReverseWindow(
  file: Awaited<ReturnType<typeof open>>,
  end: number,
  skipPartial: boolean,
): Promise<ReverseWindow> {
  const start = Math.max(0, end - MAX_SCAN_BYTES);
  const bytes = Buffer.allocUnsafe(end - start);
  const { bytesRead } = await file.read(bytes, 0, bytes.byteLength, start);
  if (bytesRead !== bytes.byteLength) throw new Error("Codex rollout changed during history read");
  const lines: ReverseLine[] = [];
  let boundary = bytes.byteLength;
  let skipped = !skipPartial;
  let resolvedPartialBefore: number | undefined;
  let recordLimited = false;
  for (let index = bytes.byteLength - 1; index >= 0; index -= 1) {
    if (bytes[index] !== 0x0a) continue;
    if (boundary > index + 1) {
      const lineStart = start + index + 1;
      const lineEnd = start + boundary;
      if (skipped) {
        const length = boundary - index - 1;
        lines.push({ start: lineStart, end: lineEnd, ...(length <= MAX_PARSE_LINE_BYTES ? { bytes: bytes.subarray(index + 1, boundary) } : {}) });
        if (lines.length >= MAX_SCAN_RECORDS) { recordLimited = true; break; }
      } else {
        skipped = true;
        resolvedPartialBefore = lineStart;
      }
    }
    boundary = index;
  }
  if (!recordLimited && start === 0 && boundary > 0) {
    if (skipped) lines.push({ start: 0, end: boundary, ...(boundary <= MAX_PARSE_LINE_BYTES ? { bytes: bytes.subarray(0, boundary) } : {}) });
  }
  const nextBefore = lines.at(-1)?.start ?? resolvedPartialBefore ?? start;
  return {
    lines,
    nextBefore,
    hasMore: recordLimited || start > 0 || nextBefore > 0,
    skipPartial: !recordLimited && start > 0 && lines.length === 0 && resolvedPartialBefore === undefined,
  };
}

async function readPendingMessage(
  file: Awaited<ReturnType<typeof open>>,
  descriptor: PendingLine,
): Promise<PendingMessage | undefined> {
  const length = descriptor.end - descriptor.start;
  if (length <= 0 || length > MAX_PARSE_LINE_BYTES) return undefined;
  const bytes = Buffer.allocUnsafe(length);
  const { bytesRead } = await file.read(bytes, 0, length, descriptor.start);
  if (bytesRead !== length) throw new Error("Codex rollout changed during history read");
  const value = parseRecord(bytes);
  const payload = record(value?.payload);
  const timestamp = timestampMillis(value?.timestamp);
  if (value?.type === "event_msg" && payload && payload.type === "user_message" && typeof payload.message === "string") {
    return visibleUser(descriptor.start, payload, timestamp);
  }
  if (value?.type === "response_item" && payload?.type === "message" && payload.role === "assistant") {
    return visibleAssistant(descriptor.start, payload, timestamp);
  }
  return undefined;
}

function visibleUser(lineStart: number, payload: Record<string, unknown>, at: number): PendingMessage | undefined {
  const body = truncateBody(stripSetup(String(payload.message)));
  if (!body) return undefined;
  const clientId = text(payload.client_id);
  return { lineStart, role: "you", body, at, ...(clientId ? { clientId } : {}) };
}

function visibleAssistant(lineStart: number, payload: Record<string, unknown>, at: number): PendingMessage | undefined {
  const body = truncateBody(outputText(payload.content));
  if (!body) return undefined;
  const nativeId = text(payload.id);
  const phase = text(payload.phase);
  return { lineStart, role: "worker", body, at, ...(nativeId ? { nativeId } : {}), ...(phase ? { phase } : {}) };
}

function validateRequest(request: CodexRolloutHistoryRequest): void {
  const name = basename(request.path);
  if (!isAbsolute(request.path) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(request.threadId)
    || !name.startsWith("rollout-") || !name.endsWith(`-${request.threadId}.jsonl`)
    || (request.activeTurnId !== undefined && (typeof request.activeTurnId !== "string"
      || request.activeTurnId.length < 1 || request.activeTurnId.length > 256))) {
    throw new Error("invalid Codex rollout history request");
  }
}

function parseRecord(bytes: Buffer): Record<string, unknown> | undefined {
  if (bytes.byteLength === 0) return undefined;
  try { return record(JSON.parse(bytes.toString("utf8"))); }
  catch { return undefined; }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function outputText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.flatMap((entry) => {
    const item = record(entry);
    return item?.type === "output_text" && typeof item.text === "string" ? [item.text] : [];
  }).join("").trim();
}

function stripSetup(value: string): string {
  return value.replace(/^\s*<environment_context>[\s\S]*?<\/environment_context>\s*/iu, "").trim();
}

function truncateBody(body: string): string {
  const bytes = Buffer.from(body, "utf8");
  if (bytes.byteLength <= MAX_BODY_BYTES) return body;
  let end = MAX_BODY_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}\n\n[message truncated by Web UI]`;
}

function timestampMillis(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function terminalStatusFor(type: string | undefined): string | undefined {
  if (type === "task_complete" || type === "turn_complete") return "completed";
  if (type === "task_failed" || type === "turn_failed") return "failed";
  if (type === "turn_aborted" || type === "task_aborted") return "interrupted";
  return undefined;
}

function rememberTerminal(terminal: Map<string, TurnTerminal>, turnId: string, proof: TurnTerminal): void {
  terminal.delete(turnId);
  terminal.set(turnId, proof);
  while (terminal.size > MAX_CURSOR_TERMINALS) terminal.delete(terminal.keys().next().value!);
}

function encodeCursor(cursor: HistoryCursor): string {
  const encoded = Buffer.from(JSON.stringify({ v: 2, ...cursor }), "utf8").toString("base64url");
  if (encoded.length > MAX_CURSOR_BYTES) throw new Error("Codex rollout history cursor exceeds its budget");
  return encoded;
}

function decodeCursor(value: string | undefined): HistoryCursor | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid Codex rollout history cursor");
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new Error("invalid Codex rollout history cursor"); }
  const cursor = record(decoded);
  if ((cursor?.v !== 1 && cursor?.v !== 2) || !/^\d+$/u.test(String(cursor.device ?? "")) || !/^\d+$/u.test(String(cursor.inode ?? ""))
    || !Number.isSafeInteger(cursor.before) || Number(cursor.before) < 0) throw new Error("invalid Codex rollout history cursor");
  if (cursor.v === 1) return {
    device: String(cursor.device), inode: String(cursor.inode), before: Number(cursor.before),
    pending: [], terminals: [], skipPartial: false, pendingSkipped: false,
  };
  const pending = Array.isArray(cursor.pending) ? cursor.pending : [];
  const terminals = Array.isArray(cursor.terminals) ? cursor.terminals : [];
  const resolved = record(cursor.resolved);
  if (pending.length > 50 || terminals.length > MAX_CURSOR_TERMINALS
    || !validPending(pending)
    || !terminals.every((entry) => record(entry) && typeof (entry as { turnId?: unknown }).turnId === "string"
      && (entry as { turnId: string }).turnId.length <= 256 && TERMINAL.has((entry as { status?: string }).status ?? "")
      && Number.isSafeInteger((entry as { at?: unknown }).at))
    || (cursor.skipPartial !== undefined && typeof cursor.skipPartial !== "boolean")
    || (cursor.pendingSkipped !== undefined && typeof cursor.pendingSkipped !== "boolean")
    || (cursor.activeTurnId !== undefined && (typeof cursor.activeTurnId !== "string"
      || cursor.activeTurnId.length < 1 || cursor.activeTurnId.length > 256))
    || (cursor.resolved !== undefined && (!resolved || pending.length === 0 || cursor.pendingSkipped === true
      || typeof resolved.turnId !== "string" || resolved.turnId.length < 1 || resolved.turnId.length > 256
      || !TURN_STATUS.has(String(resolved.status ?? "")) || !Number.isSafeInteger(resolved.at)
      || resolved.turnOrder !== cursor.before))) {
    throw new Error("invalid Codex rollout history cursor");
  }
  return {
    device: String(cursor.device), inode: String(cursor.inode), before: Number(cursor.before),
    pending: pending as unknown as PendingLine[], terminals: terminals as unknown as HistoryCursor["terminals"],
    skipPartial: cursor.skipPartial === true, pendingSkipped: cursor.pendingSkipped === true,
    ...(typeof cursor.activeTurnId === "string" ? { activeTurnId: cursor.activeTurnId } : {}),
    ...(resolved ? { resolved: resolved as unknown as ResolvedTurn } : {}),
  };
}

function validPending(values: unknown[]): boolean {
  let bytes = 0;
  let previousStart = Number.MAX_SAFE_INTEGER;
  for (const value of values) {
    const entry = record(value) as unknown as PendingLine | undefined;
    if (!entry || !Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end)
      || entry.start < 0 || entry.end <= entry.start || entry.end > previousStart
      || entry.end - entry.start > MAX_PARSE_LINE_BYTES) return false;
    bytes += entry.end - entry.start;
    if (bytes > MAX_PENDING_BYTES) return false;
    previousStart = entry.start;
  }
  return true;
}
