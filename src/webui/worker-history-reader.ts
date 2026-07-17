import { Buffer } from "node:buffer";
import type { WebBus, WorkerSubscription } from "./web-bus.ts";
import type { StreamSessionIdentity } from "./worker-stream.ts";
import { openWorkerTurnIds, pageWorkerConversation, terminalWorkerTurnIds } from "./worker-conversation.ts";

export type WorkerHistoryErrorCode = "busy" | "cancelled" | "stale";

export class WorkerHistoryError extends Error {
  constructor(readonly code: WorkerHistoryErrorCode, message: string) { super(message); }
}

export interface WorkerHistoryMessage {
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

export interface WorkerHistoryPage {
  messages: WorkerHistoryMessage[];
  hasOlder: boolean;
  nextCursor?: string;
  openTurnIds: string[];
  terminalTurnIds: string[];
}

export interface WorkerHistoryReader {
  read(subscriptionId: string, nickname: string, limit: number, before?: string, signal?: AbortSignal): Promise<WorkerHistoryPage>;
  dispose(): void;
}

interface NativeRead {
  controller: AbortController;
  promise: Promise<WorkerNativeHistoryPage>;
  consumers: Set<string>;
}

export interface WorkerNativeHistoryPage {
  turns: unknown[];
  nextTurnCursor?: string;
}

interface WorkerHistoryCursor {
  turnCursor?: string;
  messageBoundary?: string;
}

interface Consumer {
  key: string;
  subscription: WorkerSubscription;
  cancel(error: WorkerHistoryError): void;
}

const identityKey = (subscription: WorkerSubscription): string => `${subscription.endpointId}\0${subscription.threadId}\0${subscription.mappingId}`;

function mappingCurrent(resolveSession: (nickname: string) => StreamSessionIdentity | undefined, subscription: WorkerSubscription): boolean {
  const current = resolveSession(subscription.nickname);
  return current?.endpointId === subscription.endpointId
    && current.threadId === subscription.threadId
    && current.mappingId === subscription.mappingId;
}

export function createWorkerHistoryReader(deps: {
  bus: WebBus;
  resolveSession(nickname: string): StreamSessionIdentity | undefined;
  readTurns(endpointId: string, threadId: string, limit: number, cursor: string | undefined, signal: AbortSignal): Promise<WorkerNativeHistoryPage>;
}): WorkerHistoryReader {
  const reads = new Map<string, NativeRead>();
  const consumers = new Map<string, Consumer>();
  let disposed = false;

  const detach = (subscriptionId: string, error?: WorkerHistoryError): void => {
    const consumer = consumers.get(subscriptionId);
    if (!consumer) return;
    consumers.delete(subscriptionId);
    const read = reads.get(consumer.key);
    read?.consumers.delete(subscriptionId);
    if (error) consumer.cancel(error);
    if (read?.consumers.size === 0) {
      reads.delete(consumer.key);
      read.controller.abort(error ?? new WorkerHistoryError("cancelled", "history read has no active viewers"));
    }
  };

  const off = deps.bus.onSubscriptionRemoved((subscription) => {
    detach(subscription.subscriptionId, new WorkerHistoryError("stale", "worker subscription ended"));
  });

  const read = async (subscriptionId: string, nickname: string, limit: number, before?: string, signal?: AbortSignal): Promise<WorkerHistoryPage> => {
    if (disposed) throw new WorkerHistoryError("cancelled", "history reader stopped");
    if (consumers.has(subscriptionId)) throw new WorkerHistoryError("busy", "worker history read already in progress");
    const subscription = deps.bus.subscription(subscriptionId, nickname);
    if (!subscription || !mappingCurrent(deps.resolveSession, subscription)) throw new WorkerHistoryError("stale", "worker subscription is stale");
    if (signal?.aborted) throw new WorkerHistoryError("cancelled", "history request was cancelled");

    const cursor = decodeHistoryCursor(before);
    const key = `${identityKey(subscription)}\0${limit}\0${cursor.turnCursor ?? ""}`;
    let native = reads.get(key);
    if (!native) {
      const controller = new AbortController();
      const created: NativeRead = { controller, consumers: new Set(), promise: Promise.resolve({ turns: [] }) };
      created.promise = deps.readTurns(subscription.endpointId, subscription.threadId, limit, cursor.turnCursor, controller.signal)
        .finally(() => { if (reads.get(key) === created && created.consumers.size === 0) reads.delete(key); });
      native = created;
      reads.set(key, native);
    }
    native.consumers.add(subscriptionId);

    let rejectCancellation!: (error: WorkerHistoryError) => void;
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    consumers.set(subscriptionId, { key, subscription, cancel: rejectCancellation });
    const abort = () => detach(subscriptionId, new WorkerHistoryError("cancelled", "history request was cancelled"));
    signal?.addEventListener("abort", abort, { once: true });

    try {
      const nativePage = await Promise.race([native.promise, cancellation]);
      if (signal?.aborted || consumers.get(subscriptionId)?.subscription !== subscription) {
        throw new WorkerHistoryError("cancelled", "history request was cancelled");
      }
      if (!deps.bus.isSubscriptionCurrent(subscription) || !mappingCurrent(deps.resolveSession, subscription)) {
        throw new WorkerHistoryError("stale", "worker mapping changed during history read");
      }
      const page = pageWorkerConversation(nativePage.turns, limit, cursor.messageBoundary);
      const nextCursor = page.hasOlder && page.nextCursor
        ? encodeHistoryCursor({ ...cursor, messageBoundary: page.nextCursor })
        : nativePage.nextTurnCursor
          ? encodeHistoryCursor({ turnCursor: nativePage.nextTurnCursor })
          : undefined;
      return {
        messages: page.messages.map((row) => ({
          id: row.id, turnId: row.turnId, body: row.body, completedAt: row.completedAt,
          terminalStatus: row.terminalStatus, turnOrder: row.turnOrder, itemOrder: row.itemOrder,
          ...(row.role === "you" ? { role: "you" as const } : {}),
          ...(row.clientId ? { clientId: row.clientId } : {}), ...(row.phase ? { phase: row.phase } : {}),
        })),
        hasOlder: nextCursor !== undefined,
        ...(nextCursor ? { nextCursor } : {}),
        openTurnIds: openWorkerTurnIds(nativePage.turns),
        terminalTurnIds: terminalWorkerTurnIds(nativePage.turns).slice(-50),
      };
    } finally {
      signal?.removeEventListener("abort", abort);
      detach(subscriptionId);
    }
  };

  return {
    read,
    dispose() {
      if (disposed) return;
      disposed = true;
      off();
      for (const subscriptionId of [...consumers.keys()]) detach(subscriptionId, new WorkerHistoryError("cancelled", "history reader stopped"));
      for (const native of reads.values()) native.controller.abort(new WorkerHistoryError("cancelled", "history reader stopped"));
      reads.clear();
    },
  };
}

function encodeHistoryCursor(cursor: WorkerHistoryCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, turnCursor: cursor.turnCursor ?? null, messageBoundary: cursor.messageBoundary ?? null }), "utf8")
    .toString("base64url");
}

function decodeHistoryCursor(value: string | undefined): WorkerHistoryCursor {
  if (value === undefined) return {};
  if (!value || value.length > 4_096 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid worker history cursor");
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new Error("invalid worker history cursor"); }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid worker history cursor");
  const cursor = decoded as Record<string, unknown>;
  const turnCursor = cursor.turnCursor === null ? undefined : cursor.turnCursor;
  const messageBoundary = cursor.messageBoundary === null ? undefined : cursor.messageBoundary;
  if (cursor.v !== 1
    || (turnCursor !== undefined && (typeof turnCursor !== "string" || turnCursor.length === 0 || turnCursor.length > 2_048))
    || (messageBoundary !== undefined && (typeof messageBoundary !== "string" || messageBoundary.length === 0 || messageBoundary.length > 512))) {
    throw new Error("invalid worker history cursor");
  }
  return {
    ...(typeof turnCursor === "string" ? { turnCursor } : {}),
    ...(typeof messageBoundary === "string" ? { messageBoundary } : {}),
  };
}
