import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { WorkerChatEvent } from "./worker-stream.ts";

export type WebEvent =
  | { type: "message"; id?: string; body: string; at: number; kind?: string; worker?: string; origin?: string }
  | { type: "sessions"; sessions: unknown[]; assistant: unknown; at: number };

export interface WorkerSubscriptionTarget {
  nickname: string;
  endpointId: string;
  threadId: string;
  mappingId: string;
  requestId: string;
}

export interface WorkerSubscription extends WorkerSubscriptionTarget {
  subscriptionId: string;
}

export interface WorkerSubscriptionResult extends WorkerSubscription {
  resumed: boolean;
  replayGap: boolean;
  latestSeq: number;
}

interface ReplayEntry {
  seq: number;
  event: WorkerChatEvent;
  bytes: number;
}

interface SubscriptionState {
  subscription: WorkerSubscription;
  socket?: WebSocket;
  replay: ReplayEntry[];
  replayBytes: number;
  latestSeq: number;
  droppedThroughSeq: number;
  expiry?: ReturnType<typeof setTimeout>;
}

const MAX_WORKER_SOCKET_BYTES = 1024 * 1024;
const MAX_REPLAY_EVENT_BYTES = 256 * 1024;
const DEFAULT_MAX_REPLAY_EVENTS = 500;
const DEFAULT_MAX_REPLAY_BYTES = 2 * 1024 * 1024;
const DEFAULT_DETACHED_TTL_MS = 30_000;
const workerKey = (endpointId: string, threadId: string): string => `${endpointId}\0${threadId}`;

export class WebBus {
  private readonly sockets = new Set<WebSocket>();
  private readonly subscriptions = new Map<WebSocket, SubscriptionState>();
  private readonly subscriptionsById = new Map<string, SubscriptionState>();
  private readonly workerTasks = new Map<string, WorkerChatEvent>();
  private readonly subscriptionsByWorker = new Map<string, Set<SubscriptionState>>();
  private readonly removalListeners = new Set<(subscription: WorkerSubscription) => void>();
  private readonly maxReplayEvents: number;
  private readonly maxReplayBytes: number;
  private readonly detachedTtlMs: number;

  constructor(options: { maxReplayEvents?: number; maxReplayBytes?: number; detachedTtlMs?: number } = {}) {
    this.maxReplayEvents = options.maxReplayEvents ?? DEFAULT_MAX_REPLAY_EVENTS;
    this.maxReplayBytes = options.maxReplayBytes ?? DEFAULT_MAX_REPLAY_BYTES;
    this.detachedTtlMs = options.detachedTtlMs ?? DEFAULT_DETACHED_TTL_MS;
  }

  add(socket: WebSocket): void { this.sockets.add(socket); }

  remove(socket: WebSocket): void {
    this.detachSubscription(socket);
    this.sockets.delete(socket);
  }

  get size(): number { return this.sockets.size; }

  subscribe(
    socket: WebSocket,
    target: WorkerSubscriptionTarget,
    resume?: { subscriptionId: string; afterSeq: number },
  ): WorkerSubscriptionResult {
    if (!this.sockets.has(socket)) this.sockets.add(socket);
    this.deleteSocketSubscription(socket);
    const resumable = resume ? this.subscriptionsById.get(resume.subscriptionId) : undefined;
    if (resumable && resumable.socket === undefined && sameTarget(resumable.subscription, target)) {
      if (resumable.expiry) clearTimeout(resumable.expiry);
      delete resumable.expiry;
      resumable.subscription = { ...resumable.subscription, requestId: target.requestId };
      resumable.socket = socket;
      this.subscriptions.set(socket, resumable);
      const replayGap = this.replayGap(resumable, resume!.afterSeq);
      return { ...resumable.subscription, resumed: true, replayGap, latestSeq: resumable.latestSeq };
    }

    let subscriptionId = randomUUID();
    while (this.subscriptionsById.has(subscriptionId)) subscriptionId = randomUUID();
    const subscription: WorkerSubscription = { ...target, subscriptionId };
    const state: SubscriptionState = {
      subscription, socket, replay: [], replayBytes: 0, latestSeq: 0, droppedThroughSeq: 0,
    };
    this.subscriptions.set(socket, state);
    this.subscriptionsById.set(subscriptionId, state);
    const key = workerKey(target.endpointId, target.threadId);
    const subscriptions = this.subscriptionsByWorker.get(key) ?? new Set<SubscriptionState>();
    subscriptions.add(state);
    this.subscriptionsByWorker.set(key, subscriptions);
    // Through the ordinary numbered path rather than out of band, so it lands in this
    // subscription's replay buffer and cannot arrive out of order with what follows.
    const tasks = this.workerTasks.get(key);
    if (tasks) this.publishSubscription(state, tasks);
    return { ...subscription, resumed: false, replayGap: false, latestSeq: state.latestSeq };
  }

  replay(subscriptionId: string, afterSeq: number): void {
    const state = this.subscriptionsById.get(subscriptionId);
    if (!state?.socket || this.replayGap(state, afterSeq)) return;
    for (const entry of state.replay) {
      if (entry.seq > afterSeq) this.sendWorkerEntry(state, entry);
    }
  }

  unsubscribe(socket: WebSocket): void { this.deleteSocketSubscription(socket); }

  subscription(subscriptionId: string, nickname?: string): WorkerSubscription | undefined {
    const value = this.subscriptionsById.get(subscriptionId)?.subscription;
    return value && (nickname === undefined || value.nickname === nickname) ? value : undefined;
  }

  isSubscriptionCurrent(expected: WorkerSubscription): boolean {
    const current = this.subscriptionsById.get(expected.subscriptionId)?.subscription;
    return current?.endpointId === expected.endpointId && current.threadId === expected.threadId
      && current.mappingId === expected.mappingId && current.nickname === expected.nickname;
  }

  hasWorkerSubscriber(endpointId: string, threadId: string): boolean {
    return (this.subscriptionsByWorker.get(workerKey(endpointId, threadId))?.size ?? 0) > 0;
  }

  pruneWorkerSubscriptions(
    endpointId: string,
    threadId: string,
    keep: (subscription: WorkerSubscription) => boolean,
  ): void {
    for (const state of [...(this.subscriptionsByWorker.get(workerKey(endpointId, threadId)) ?? [])]) {
      if (keep(state.subscription)) continue;
      if (state.socket) this.send(state.socket, {
        type: "worker/subscription-error", requestId: state.subscription.requestId,
        subscriptionId: state.subscription.subscriptionId, code: "stale-worker",
      });
      this.deleteState(state);
    }
  }

  onSubscriptionRemoved(listener: (subscription: WorkerSubscription) => void): () => void {
    this.removalListeners.add(listener);
    return () => this.removalListeners.delete(listener);
  }

  send(socket: WebSocket, event: unknown): void {
    if (socket.readyState !== 1) return;
    try { socket.send(JSON.stringify(event)); } catch { /* drop on a broken socket */ }
  }

  broadcast(event: WebEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of this.sockets) {
      if (socket.readyState === 1) { try { socket.send(payload); } catch { /* drop on a broken socket */ } }
    }
  }

  // Task activity is STATE, not an occurrence: "2 background tasks, 1 subagent" stays true until
  // it changes. It was only ever sent as a change event, so a panel opened after the work started
  // showed nothing until the next change -- which is why the indicator appeared to populate only
  // when a new question was asked, that being the next thing to change it.
  //
  // Recorded even with no subscribers, deliberately: the stream drops notifications when nobody is
  // watching, so a cache filled only while watched would go stale across exactly the interval it
  // exists to cover.
  recordWorkerTasks(endpointId: string, threadId: string, event: WorkerChatEvent): void {
    this.workerTasks.set(workerKey(endpointId, threadId), event);
  }

  publishWorker(endpointId: string, threadId: string, event: WorkerChatEvent): void {
    for (const state of [...(this.subscriptionsByWorker.get(workerKey(endpointId, threadId)) ?? [])]) {
      this.publishSubscription(state, event);
    }
  }

  publishWorkerDiscontinuity(endpointId: string): void {
    for (const state of [...this.subscriptionsById.values()]) {
      if (state.subscription.endpointId === endpointId) this.publishSubscription(state, { kind: "stream-discontinuity" });
    }
  }

  private publishSubscription(state: SubscriptionState, event: WorkerChatEvent): void {
    const seq = ++state.latestSeq;
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8") + 256;
    const entry: ReplayEntry = { seq, event, bytes };
    if (bytes <= MAX_REPLAY_EVENT_BYTES) {
      state.replay.push(entry);
      state.replayBytes += bytes;
      while (state.replay.length > this.maxReplayEvents || state.replayBytes > this.maxReplayBytes) {
        const removed = state.replay.shift();
        if (!removed) break;
        state.replayBytes -= removed.bytes;
        state.droppedThroughSeq = Math.max(state.droppedThroughSeq, removed.seq);
      }
    } else {
      state.droppedThroughSeq = seq;
    }
    if (state.socket) this.sendWorkerEntry(state, entry);
  }

  private sendWorkerEntry(state: SubscriptionState, entry: ReplayEntry): void {
    const socket = state.socket;
    if (!socket) return;
    const subscription = state.subscription;
    const payload = JSON.stringify({
      type: "worker/event", nickname: subscription.nickname, requestId: subscription.requestId,
      subscriptionId: subscription.subscriptionId, streamId: subscription.subscriptionId,
      seq: entry.seq, event: entry.event,
    });
    const bytes = Buffer.byteLength(payload);
    if (socket.readyState !== 1 || bytes > MAX_WORKER_SOCKET_BYTES || socket.bufferedAmount + bytes > MAX_WORKER_SOCKET_BYTES) {
      this.detachSubscription(socket);
      try { socket.close(1013, "worker stream backpressure"); } catch { /* already broken */ }
      return;
    }
    try { socket.send(payload); }
    catch { this.detachSubscription(socket); }
  }

  private replayGap(state: SubscriptionState, afterSeq: number): boolean {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > state.latestSeq) return true;
    if (afterSeq < state.droppedThroughSeq) return true;
    const first = state.replay[0]?.seq;
    return first !== undefined && first > afterSeq + 1;
  }

  private detachSubscription(socket: WebSocket): void {
    const state = this.subscriptions.get(socket);
    if (!state) return;
    this.subscriptions.delete(socket);
    delete state.socket;
    if (state.expiry) clearTimeout(state.expiry);
    state.expiry = setTimeout(() => this.deleteState(state), this.detachedTtlMs);
    state.expiry.unref?.();
  }

  private deleteSocketSubscription(socket: WebSocket): void {
    const state = this.subscriptions.get(socket);
    if (state) this.deleteState(state);
  }

  private deleteState(state: SubscriptionState): void {
    if (state.expiry) clearTimeout(state.expiry);
    if (state.socket) this.subscriptions.delete(state.socket);
    this.subscriptionsById.delete(state.subscription.subscriptionId);
    const key = workerKey(state.subscription.endpointId, state.subscription.threadId);
    const subscriptions = this.subscriptionsByWorker.get(key);
    subscriptions?.delete(state);
    if (subscriptions?.size === 0) this.subscriptionsByWorker.delete(key);
    for (const listener of this.removalListeners) {
      try { listener(state.subscription); } catch { /* observers cannot break cleanup */ }
    }
  }
}

function sameTarget(subscription: WorkerSubscription, target: WorkerSubscriptionTarget): boolean {
  return subscription.nickname === target.nickname && subscription.endpointId === target.endpointId
    && subscription.threadId === target.threadId && subscription.mappingId === target.mappingId;
}
