import { Buffer } from "node:buffer";
import { HistoryScanBudgetExhaustedError, type ThreadHistoryItem, type ThreadHistoryPage, type ThreadHistoryTurn, type ThreadItemsView } from "../app-server/thread-history.ts";
import { AppError } from "../core/errors.ts";
import { claudeTurnIdFromRecord, reconstructClaudeThread } from "../sessions/claude-thread.ts";
import type { ClaudeCommandRunner, ClaudeTranscriptChunk, ClaudeTranscriptSnapshot } from "./claude-command-runner.ts";

// Reserve one byte inside each transfer for a predecessor probe. That proves whether
// the requested payload begins on a JSONL boundary without exceeding the wire caps.
export const CLAUDE_PAGE_WINDOW_BYTES = 256 * 1024 - 1;
const PAGE_TRANSFER_BYTES = CLAUDE_PAGE_WINDOW_BYTES + 1;
const EXACT_WINDOW_BYTES = 4 * 1024 * 1024 - 1;
const EXACT_TRANSFER_BYTES = EXACT_WINDOW_BYTES + 1;

interface ParsedRecord {
  offset: number;
  value: unknown;
}

interface TranscriptWindow {
  chunk: ClaudeTranscriptChunk;
  leadingProbe: boolean;
}

type TurnsCursor = {
  v: 1;
  kind: "turns";
  threadId: string;
  direction: "asc" | "desc";
  boundary: number;
  snapshot: ClaudeTranscriptSnapshot;
};

type ItemsCursor = {
  v: 1;
  kind: "items";
  threadId: string;
  turnId: string;
  direction: "asc" | "desc";
  offset: number;
  snapshot: ClaudeTranscriptSnapshot;
};

export class ClaudeTranscriptHistory {
  constructor(private readonly runner: ClaudeCommandRunner) {}

  async sessionCwd(threadId: string, cwd: string): Promise<string | undefined> {
    const chunk = await this.runner.readTranscriptChunk(threadId, cwd, {
      offset: 0,
      length: PAGE_TRANSFER_BYTES,
    });
    if (!chunk) return undefined;
    for (const parsed of parseRecords(chunk, false)) {
      if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) continue;
      const value = (parsed.value as Record<string, unknown>).cwd;
      if (typeof value === "string" && value.length > 0) return value;
    }
    if (chunk.offset + chunk.bytes.length < chunk.snapshot.size) throw new HistoryScanBudgetExhaustedError();
    throw new AppError("OPERATION_UNCERTAIN", "Claude transcript does not expose a non-empty session cwd");
  }

  async fullRecords(threadId: string, cwd: string): Promise<unknown[] | undefined> {
    const chunk = await this.runner.readTranscriptChunk(threadId, cwd, {
      offset: 0,
      length: EXACT_TRANSFER_BYTES,
    });
    if (!chunk) return undefined;
    if (chunk.snapshot.size > EXACT_TRANSFER_BYTES) throw new HistoryScanBudgetExhaustedError();
    return parseRecords(chunk, false).map((record) => record.value);
  }

  async turnsPage(
    threadId: string,
    cwd: string,
    params: { cursor?: string; limit: number; sortDirection: "asc" | "desc"; itemsView: ThreadItemsView },
  ): Promise<ThreadHistoryPage<ThreadHistoryTurn>> {
    requireLimit(params.limit);
    const cursor = params.cursor === undefined
      ? undefined
      : decodeCursor<TurnsCursor>(params.cursor, {
        kind: "turns", threadId, direction: params.sortDirection,
      });
    const window = await this.turnWindow(threadId, cwd, params.sortDirection, cursor);
    if (!window) return { data: [], nextCursor: null, backwardsCursor: null };
    const { chunk } = window;
    const records = parseRecords(chunk, window.leadingProbe);
    const starts = records.flatMap((record, index) => {
      const id = claudeTurnIdFromRecord(record.value);
      return id === undefined ? [] : [{ id, recordIndex: index, offset: record.offset }];
    });
    if (starts.length === 0) {
      if ((params.sortDirection === "desc" && chunk.offset > 0)
        || (params.sortDirection === "asc" && chunk.offset + chunk.bytes.length < chunk.snapshot.size)) {
        throw new HistoryScanBudgetExhaustedError();
      }
      return { data: [], nextCursor: null, backwardsCursor: null };
    }
    const reconstructed = reconstructClaudeThread({
      threadId,
      cwd,
      records: records.slice(starts[0]!.recordIndex).map((record) => record.value),
    }).turns.map((turn) => asHistoryTurn(turn));
    if (reconstructed.length !== starts.length) {
      throw new AppError("OPERATION_UNCERTAIN", "Claude transcript turn boundaries were inconsistent");
    }

    if (params.sortDirection === "desc") {
      const selected = reconstructed.slice(-params.limit).reverse();
      const oldestIndex = reconstructed.length - selected.length;
      const hasOlder = oldestIndex > 0 || chunk.offset > 0;
      const nextCursor = hasOlder && selected.length > 0
        ? encodeCursor<TurnsCursor>({
          v: 1, kind: "turns", threadId, direction: "desc",
          boundary: starts[oldestIndex]!.offset, snapshot: chunk.snapshot,
        })
        : null;
      return {
        data: selected.map((turn) => projectTurn(turn, params.itemsView)),
        nextCursor,
        backwardsCursor: null,
      };
    }

    const reachesEnd = chunk.offset + chunk.bytes.length >= chunk.snapshot.size;
    // A forward window ending in the middle of a turn cannot classify that last turn.
    // Keep it as the next page's boundary instead of silently calling it interrupted.
    const completeCount = reachesEnd ? reconstructed.length : Math.max(0, reconstructed.length - 1);
    const selectedCount = Math.min(params.limit, completeCount);
    if (selectedCount === 0 && !reachesEnd) throw new HistoryScanBudgetExhaustedError();
    const selected = reconstructed.slice(0, selectedCount);
    const hasNewer = selectedCount < reconstructed.length || !reachesEnd;
    const nextCursor = hasNewer && starts[selectedCount]
      ? encodeCursor<TurnsCursor>({
        v: 1, kind: "turns", threadId, direction: "asc",
        boundary: starts[selectedCount]!.offset, snapshot: chunk.snapshot,
      })
      : null;
    return {
      data: selected.map((turn) => projectTurn(turn, params.itemsView)),
      nextCursor,
      backwardsCursor: null,
    };
  }

  async itemsPage(
    threadId: string,
    cwd: string,
    params: { turnId: string; cursor?: string; limit: number; sortDirection: "asc" | "desc" },
  ): Promise<ThreadHistoryPage<ThreadHistoryItem>> {
    requireLimit(params.limit);
    const cursor = params.cursor === undefined
      ? undefined
      : decodeCursor<ItemsCursor>(params.cursor, {
        kind: "items", threadId, turnId: params.turnId, direction: params.sortDirection,
      });
    const exact = await this.exactTurn(threadId, cwd, params.turnId, cursor?.snapshot);
    if (!exact) return { data: [], nextCursor: null, backwardsCursor: null };
    const ordered = params.sortDirection === "asc" ? exact.turn.items : [...exact.turn.items].reverse();
    const offset = cursor?.offset ?? 0;
    if (offset > ordered.length) throw new AppError("OPERATION_UNCERTAIN", "Claude item cursor is outside the pinned turn");
    const data = ordered.slice(offset, offset + params.limit);
    const nextOffset = offset + data.length;
    return {
      data,
      nextCursor: nextOffset < ordered.length
        ? encodeCursor<ItemsCursor>({
          v: 1, kind: "items", threadId, turnId: params.turnId,
          direction: params.sortDirection, offset: nextOffset, snapshot: exact.snapshot,
        })
        : null,
      backwardsCursor: null,
    };
  }

  private async exactTurn(
    threadId: string,
    cwd: string,
    turnId: string,
    expected?: ClaudeTranscriptSnapshot,
  ): Promise<{ turn: ThreadHistoryTurn; snapshot: ClaudeTranscriptSnapshot } | undefined> {
    const chunk = await this.runner.readTranscriptChunk(threadId, cwd, {
      offset: "tail",
      length: EXACT_TRANSFER_BYTES,
      ...(expected === undefined ? {} : { expected }),
    });
    if (!chunk) return undefined;
    const records = parseRecords(chunk, chunk.offset > 0);
    const firstStart = records.findIndex((record) => claudeTurnIdFromRecord(record.value) !== undefined);
    if (firstStart < 0) {
      if (chunk.offset > 0) throw new HistoryScanBudgetExhaustedError();
      return undefined;
    }
    const thread = reconstructClaudeThread({
      threadId, cwd, records: records.slice(firstStart).map((record) => record.value),
    });
    const projected = thread.turns.map((candidate) => asHistoryTurn(candidate));
    const turn = projected.find((candidate) => candidate.id === turnId);
    if (turn) return { turn, snapshot: chunk.snapshot };
    if (chunk.offset > 0) throw new HistoryScanBudgetExhaustedError();
    return undefined;
  }

  private turnWindow(
    threadId: string,
    cwd: string,
    direction: "asc" | "desc",
    cursor: TurnsCursor | undefined,
  ): Promise<TranscriptWindow | undefined> {
    if (direction === "desc" && cursor === undefined) {
      return this.runner.readTranscriptChunk(threadId, cwd, { offset: "tail", length: PAGE_TRANSFER_BYTES })
        .then((chunk) => chunk === undefined ? undefined : { chunk, leadingProbe: chunk.offset > 0 });
    }
    const boundary = cursor?.boundary ?? 0;
    const logicalStart = direction === "desc" ? Math.max(0, boundary - CLAUDE_PAGE_WINDOW_BYTES) : boundary;
    const offset = direction === "desc" && logicalStart > 0 ? logicalStart - 1 : logicalStart;
    const length = direction === "desc" ? boundary - offset : PAGE_TRANSFER_BYTES;
    if (length <= 0) return Promise.resolve(undefined);
    return this.runner.readTranscriptChunk(threadId, cwd, {
      offset,
      length,
      ...(cursor === undefined ? {} : { expected: cursor.snapshot }),
    }).then((chunk) => chunk === undefined ? undefined : {
      chunk,
      leadingProbe: direction === "desc" && logicalStart > 0,
    });
  }
}

function parseRecords(chunk: ClaudeTranscriptChunk, leadingProbe: boolean): ParsedRecord[] {
  const bytes = Buffer.from(chunk.bytes);
  let position = 0;
  if (leadingProbe && chunk.offset > 0) {
    if (bytes[0] === 0x0a) position = 1;
    else {
      const firstNewline = bytes.indexOf(0x0a, 1);
      if (firstNewline < 0) return [];
      position = firstNewline + 1;
    }
  }
  const records: ParsedRecord[] = [];
  while (position < bytes.length) {
    const newline = bytes.indexOf(0x0a, position);
    const atSnapshotEnd = chunk.offset + bytes.length >= chunk.snapshot.size;
    if (newline < 0 && !atSnapshotEnd) break;
    const end = newline < 0 ? bytes.length : newline;
    const raw = bytes.subarray(position, end).toString("utf8").trim();
    if (raw.length > 0) {
      try { records.push({ offset: chunk.offset + position, value: JSON.parse(raw) }); }
      catch {
        if (newline >= 0) throw new AppError("OPERATION_UNCERTAIN", "Claude transcript contained an invalid complete JSONL record");
      }
    }
    if (newline < 0) break;
    position = newline + 1;
  }
  return records;
}

function projectTurn(turn: ThreadHistoryTurn, view: ThreadItemsView): ThreadHistoryTurn {
  if (view === "full") return turn;
  if (view === "notLoaded") return { ...turn, itemsView: "notLoaded", items: [] };
  const firstUser = turn.items.find((item) => item.type === "userMessage");
  const lastAgent = [...turn.items].reverse().find((item) => item.type === "agentMessage");
  return {
    ...turn,
    itemsView: "summary",
    items: [firstUser, lastAgent].filter((item): item is ThreadHistoryItem => item !== undefined),
  };
}

function asHistoryTurn(turn: { id: string; status: string; itemsView: ThreadItemsView; items: readonly { type: string; id: string }[] }): ThreadHistoryTurn {
  return { ...turn, items: turn.items.map((item) => ({ ...item }) as ThreadHistoryItem) };
}

function requireLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new AppError("CONFIGURATION_ERROR", "invalid Claude history page limit");
  }
}

function encodeCursor<T extends TurnsCursor | ItemsCursor>(value: T): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor<T extends TurnsCursor | ItemsCursor>(
  value: string,
  expected: { kind: T["kind"]; threadId: string; direction: "asc" | "desc"; turnId?: string },
): T {
  if (!value || value.length > 8_192 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw invalidCursor();
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw invalidCursor(); }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw invalidCursor();
  const cursor = decoded as Record<string, unknown>;
  const snapshot = cursor.snapshot as Record<string, unknown> | undefined;
  if (cursor.v !== 1 || cursor.kind !== expected.kind || cursor.threadId !== expected.threadId
    || cursor.direction !== expected.direction || (cursor.turnId ?? undefined) !== expected.turnId
    || !snapshot || typeof snapshot.device !== "string" || typeof snapshot.inode !== "string"
    || !Number.isSafeInteger(snapshot.size) || Number(snapshot.size) < 0) throw invalidCursor();
  if (expected.kind === "turns" && (!Number.isSafeInteger(cursor.boundary) || Number(cursor.boundary) < 0)) throw invalidCursor();
  if (expected.kind === "items" && (!Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0)) throw invalidCursor();
  return decoded as T;
}

function invalidCursor(): AppError {
  return new AppError("OPERATION_UNCERTAIN", "Claude history cursor is invalid or does not match the request");
}
