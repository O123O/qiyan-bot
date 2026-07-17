import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { ThreadHistoryReader } from "../app-server/thread-history.ts";
import type { EndpointWorkLease } from "../endpoints/types.ts";
import type { WorkerNativeHistoryPage } from "./worker-history-reader.ts";
import { openWorkerTurnIds, pageWorkerConversation, terminalWorkerTurnIds } from "./worker-conversation.ts";

export interface ReadyWorkerReadDeps {
  withReadyWorkLease<T>(endpointId: string, run: (lease: EndpointWorkLease) => Promise<T>): Promise<T>;
  request(endpointId: string, method: string, params: unknown, signal?: AbortSignal, lease?: EndpointWorkLease): Promise<unknown>;
}

interface ReadyHistoryCursor {
  version: 1;
  nativeCursor?: string;
  messageCursor?: string;
  pageKey?: string;
}

const MAX_CURSOR_BYTES = 16_384;
const MAX_NATIVE_CURSOR_BYTES = 8_192;

function decodeReadyCursor(value: string | undefined): ReadyHistoryCursor {
  if (value === undefined) return { version: 1 };
  if (!value || value.length > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid worker history cursor");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new Error("invalid worker history cursor"); }
  const cursor = parsed as Partial<ReadyHistoryCursor>;
  if (!cursor || typeof cursor !== "object" || cursor.version !== 1
    || (cursor.nativeCursor !== undefined && (typeof cursor.nativeCursor !== "string" || !cursor.nativeCursor || cursor.nativeCursor.length > MAX_NATIVE_CURSOR_BYTES))
    || (cursor.messageCursor !== undefined && (typeof cursor.messageCursor !== "string" || !cursor.messageCursor || cursor.messageCursor.length > 512))
    || (cursor.pageKey !== undefined && (typeof cursor.pageKey !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(cursor.pageKey)))
    || Boolean(cursor.messageCursor) !== Boolean(cursor.pageKey)) throw new Error("invalid worker history cursor");
  return cursor as ReadyHistoryCursor;
}

function encodeReadyCursor(cursor: ReadyHistoryCursor): string {
  const value = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  if (value.length > MAX_CURSOR_BYTES) throw new Error("worker history cursor exceeds limit");
  return value;
}

function readyPageKey(turns: readonly unknown[]): string {
  const structural = turns.map((raw) => {
    const turn = raw && typeof raw === "object" ? raw as { id?: unknown; status?: unknown; items?: unknown } : {};
    const items = Array.isArray(turn.items) ? turn.items.map((rawItem) => {
      const item = rawItem && typeof rawItem === "object" ? rawItem as { id?: unknown; type?: unknown } : {};
      return [item.id, item.type];
    }) : [];
    return [turn.id, turn.status, items];
  });
  return createHash("sha256").update(JSON.stringify(structural)).digest("base64url");
}

// Claude's runtime implements the same native turn page contract. Codex history uses its bounded
// rollout reader instead, because legacy Codex does not expose item pagination and a full turn can
// exceed the remote App Server WebSocket frame.
export async function readReadyWorkerTurns(
  deps: ReadyWorkerReadDeps,
  endpointId: string,
  threadId: string,
  limit: number,
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<WorkerNativeHistoryPage> {
  return deps.withReadyWorkLease(endpointId, async (lease) => {
    const cursorState = decodeReadyCursor(cursor);
    const history = new ThreadHistoryReader((method, params) => deps.request(endpointId, method, params, signal, lease));
    const page = await history.turnsPage(threadId, {
      ...(cursorState.nativeCursor === undefined ? {} : { cursor: cursorState.nativeCursor }),
      limit: Math.max(1, Math.min(12, Math.trunc(limit) || 12)),
      sortDirection: "desc",
      itemsView: "full",
    });
    const turns = [...page.data].reverse();
    const pageKey = readyPageKey(turns);
    if (cursorState.pageKey && cursorState.pageKey !== pageKey) throw new Error("worker history cursor is stale");
    const conversation = pageWorkerConversation(turns, limit, cursorState.messageCursor);
    const nextCursor = conversation.hasOlder && conversation.nextCursor
      ? encodeReadyCursor({
        version: 1,
        ...(cursorState.nativeCursor ? { nativeCursor: cursorState.nativeCursor } : {}),
        messageCursor: conversation.nextCursor,
        pageKey,
      })
      : page.nextCursor
        ? encodeReadyCursor({ version: 1, nativeCursor: page.nextCursor })
        : undefined;
    return {
      messages: conversation.messages.map((row) => ({
        id: row.id, turnId: row.turnId, body: row.body, completedAt: row.completedAt,
        terminalStatus: row.terminalStatus, turnOrder: row.turnOrder, itemOrder: row.itemOrder,
        ...(row.role === "you" ? { role: "you" as const } : {}),
        ...(row.clientId ? { clientId: row.clientId } : {}),
        ...(row.phase ? { phase: row.phase } : {}),
      })),
      hasOlder: nextCursor !== undefined,
      ...(nextCursor ? { nextCursor } : {}),
      openTurnIds: openWorkerTurnIds(turns),
      terminalTurnIds: terminalWorkerTurnIds(turns).slice(-50),
    };
  });
}
