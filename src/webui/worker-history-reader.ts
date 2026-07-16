import type { RegistryDocument } from "../registry/session-registry.ts";
import type { WebBus, WorkerSubscription } from "./web-bus.ts";
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
  promise: Promise<unknown[]>;
  consumers: Set<string>;
}

interface Consumer {
  key: string;
  subscription: WorkerSubscription;
  cancel(error: WorkerHistoryError): void;
}

const identityKey = (subscription: WorkerSubscription): string => `${subscription.endpointId}\0${subscription.threadId}\0${subscription.mappingId}`;

function mappingCurrent(document: RegistryDocument, subscription: WorkerSubscription): boolean {
  const current = document.sessions[subscription.nickname];
  return current?.endpoint === subscription.endpointId
    && current.thread_id === subscription.threadId
    && current.mapping_id === subscription.mappingId;
}

export function createWorkerHistoryReader(deps: {
  bus: WebBus;
  registrySnapshot(): RegistryDocument;
  readTurns(endpointId: string, threadId: string, signal: AbortSignal): Promise<unknown[]>;
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
    if (!subscription || !mappingCurrent(deps.registrySnapshot(), subscription)) throw new WorkerHistoryError("stale", "worker subscription is stale");
    if (signal?.aborted) throw new WorkerHistoryError("cancelled", "history request was cancelled");

    const key = identityKey(subscription);
    let native = reads.get(key);
    if (!native) {
      const controller = new AbortController();
      const created: NativeRead = { controller, consumers: new Set(), promise: Promise.resolve([]) };
      created.promise = deps.readTurns(subscription.endpointId, subscription.threadId, controller.signal)
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
      const turns = await Promise.race([native.promise, cancellation]);
      if (signal?.aborted || consumers.get(subscriptionId)?.subscription !== subscription) {
        throw new WorkerHistoryError("cancelled", "history request was cancelled");
      }
      if (!deps.bus.isSubscriptionCurrent(subscription) || !mappingCurrent(deps.registrySnapshot(), subscription)) {
        throw new WorkerHistoryError("stale", "worker mapping changed during history read");
      }
      const page = pageWorkerConversation(turns, limit, before);
      return {
        messages: page.messages.map((row) => ({
          id: row.id, turnId: row.turnId, body: row.body, completedAt: row.completedAt,
          terminalStatus: row.terminalStatus, turnOrder: row.turnOrder, itemOrder: row.itemOrder,
          ...(row.role === "you" ? { role: "you" as const } : {}),
          ...(row.clientId ? { clientId: row.clientId } : {}), ...(row.phase ? { phase: row.phase } : {}),
        })),
        hasOlder: page.hasOlder,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        openTurnIds: openWorkerTurnIds(turns),
        // A thread normally has at most one open/recent turn. Bound terminal proof metadata even
        // though Codex currently returns the full history; recovery only targets the latest turn.
        terminalTurnIds: terminalWorkerTurnIds(turns).slice(-50),
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
