import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type { WebSocket } from "ws";
import type { WorkerChatEvent } from "./worker-stream.ts";

export type WebEvent =
  | { type: "message"; body: string; at: number }
  | { type: "sessions"; sessions: unknown[]; at: number };

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

const MAX_WORKER_BUFFER_BYTES = 1024 * 1024;
const workerKey = (endpointId: string, threadId: string): string => `${endpointId}\0${threadId}`;

export class WebBus {
  private readonly sockets = new Set<WebSocket>();
  private readonly subscriptions = new Map<WebSocket, WorkerSubscription>();
  private readonly subscriptionsById = new Map<string, { socket: WebSocket; subscription: WorkerSubscription }>();
  private readonly socketsByWorker = new Map<string, Set<WebSocket>>();
  private readonly removalListeners = new Set<(subscription: WorkerSubscription) => void>();

  add(socket: WebSocket): void { this.sockets.add(socket); }

  remove(socket: WebSocket): void {
    this.clearSubscription(socket);
    this.sockets.delete(socket);
  }

  get size(): number { return this.sockets.size; }

  subscribe(socket: WebSocket, target: WorkerSubscriptionTarget): WorkerSubscription {
    if (!this.sockets.has(socket)) this.sockets.add(socket);
    this.clearSubscription(socket);
    let subscriptionId = randomUUID();
    while (this.subscriptionsById.has(subscriptionId)) subscriptionId = randomUUID();
    const subscription: WorkerSubscription = { ...target, subscriptionId };
    this.subscriptions.set(socket, subscription);
    this.subscriptionsById.set(subscriptionId, { socket, subscription });
    const key = workerKey(target.endpointId, target.threadId);
    const sockets = this.socketsByWorker.get(key) ?? new Set<WebSocket>();
    sockets.add(socket);
    this.socketsByWorker.set(key, sockets);
    return subscription;
  }

  unsubscribe(socket: WebSocket): void { this.clearSubscription(socket); }

  subscription(subscriptionId: string, nickname?: string): WorkerSubscription | undefined {
    const value = this.subscriptionsById.get(subscriptionId)?.subscription;
    return value && (nickname === undefined || value.nickname === nickname) ? value : undefined;
  }

  isSubscriptionCurrent(expected: WorkerSubscription): boolean {
    return this.subscriptionsById.get(expected.subscriptionId)?.subscription === expected;
  }

  hasWorkerSubscriber(endpointId: string, threadId: string): boolean {
    return (this.socketsByWorker.get(workerKey(endpointId, threadId))?.size ?? 0) > 0;
  }

  pruneWorkerSubscriptions(
    endpointId: string,
    threadId: string,
    keep: (subscription: WorkerSubscription) => boolean,
  ): void {
    for (const socket of [...(this.socketsByWorker.get(workerKey(endpointId, threadId)) ?? [])]) {
      const subscription = this.subscriptions.get(socket);
      if (!subscription || keep(subscription)) continue;
      this.send(socket, { type: "worker/subscription-error", requestId: subscription.requestId, subscriptionId: subscription.subscriptionId, code: "stale-worker" });
      this.clearSubscription(socket);
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

  publishWorker(endpointId: string, threadId: string, event: WorkerChatEvent): void {
    const sockets = [...(this.socketsByWorker.get(workerKey(endpointId, threadId)) ?? [])];
    for (const socket of sockets) {
      const subscription = this.subscriptions.get(socket);
      if (!subscription) continue;
      const payload = JSON.stringify({
        type: "worker/event", nickname: subscription.nickname, requestId: subscription.requestId,
        subscriptionId: subscription.subscriptionId, event,
      });
      const bytes = Buffer.byteLength(payload);
      if (socket.readyState !== 1 || bytes > MAX_WORKER_BUFFER_BYTES || socket.bufferedAmount + bytes > MAX_WORKER_BUFFER_BYTES) {
        this.clearSubscription(socket);
        try { socket.close(1013, "worker stream backpressure"); } catch { /* already broken */ }
        continue;
      }
      try { socket.send(payload); }
      catch { this.clearSubscription(socket); }
    }
  }

  private clearSubscription(socket: WebSocket): void {
    const subscription = this.subscriptions.get(socket);
    if (!subscription) return;
    this.subscriptions.delete(socket);
    this.subscriptionsById.delete(subscription.subscriptionId);
    const key = workerKey(subscription.endpointId, subscription.threadId);
    const sockets = this.socketsByWorker.get(key);
    sockets?.delete(socket);
    if (sockets?.size === 0) this.socketsByWorker.delete(key);
    for (const listener of this.removalListeners) {
      try { listener(subscription); } catch { /* observers cannot break cleanup */ }
    }
  }
}
