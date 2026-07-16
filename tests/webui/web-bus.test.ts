import assert from "node:assert/strict";
import test from "node:test";
import type { WebSocket } from "ws";
import { WebBus } from "../../src/webui/web-bus.ts";

interface FakeSocket {
  readyState: number;
  bufferedAmount: number;
  sent: string[];
  closed: Array<{ code?: number; reason?: string }>;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
}

function socket(): FakeSocket {
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    closed: [],
    send(payload) { this.sent.push(payload); },
    close(code, reason) { this.closed.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) }); this.readyState = 3; },
  };
}

const target = (nickname: string, threadId: string, requestId = crypto.randomUUID()) => ({
  nickname, endpointId: "local", threadId, mappingId: `mapping-${nickname}`, requestId,
});

test("worker delivery targets only the socket's one active subscription", () => {
  const bus = new WebBus();
  const one = socket(), two = socket(), idle = socket();
  bus.add(one as unknown as WebSocket); bus.add(two as unknown as WebSocket); bus.add(idle as unknown as WebSocket);
  const first = bus.subscribe(one as unknown as WebSocket, target("one", "t1"));
  bus.subscribe(two as unknown as WebSocket, target("two", "t2"));

  assert.match(first.subscriptionId, /^[0-9a-f-]{36}$/u);
  assert.equal(bus.hasWorkerSubscriber("local", "t1"), true);
  bus.publishWorker("local", "t1", { kind: "agent-message-delta", turnId: "turn", itemId: "item", delta: "hello" });

  assert.equal(one.sent.length, 1);
  assert.equal(two.sent.length, 0);
  assert.equal(idle.sent.length, 0);
  assert.deepEqual(JSON.parse(one.sent[0]!), {
    type: "worker/event", nickname: "one", requestId: first.requestId,
    subscriptionId: first.subscriptionId,
    event: { kind: "agent-message-delta", turnId: "turn", itemId: "item", delta: "hello" },
  });

  const replacement = bus.subscribe(one as unknown as WebSocket, target("two", "t2"));
  assert.equal(bus.hasWorkerSubscriber("local", "t1"), false);
  assert.equal(bus.subscription(first.subscriptionId, "one"), undefined);
  assert.equal(bus.subscription(replacement.subscriptionId, "two")?.threadId, "t2");
});

test("unsubscribe, socket removal, and mapping invalidation clear exact subscriptions", () => {
  const bus = new WebBus();
  const one = socket(), two = socket();
  bus.add(one as unknown as WebSocket); bus.add(two as unknown as WebSocket);
  const removed: string[] = [];
  const off = bus.onSubscriptionRemoved((subscription) => removed.push(subscription.subscriptionId));
  const first = bus.subscribe(one as unknown as WebSocket, target("one", "t1"));
  const second = bus.subscribe(two as unknown as WebSocket, target("one", "t1"));

  bus.pruneWorkerSubscriptions("local", "t1", (subscription) => subscription.mappingId === first.mappingId && subscription.subscriptionId === first.subscriptionId);
  assert.equal(bus.subscription(first.subscriptionId, "one")?.threadId, "t1");
  assert.equal(bus.subscription(second.subscriptionId, "one"), undefined);
  assert.equal(JSON.parse(two.sent[0]!).code, "stale-worker");

  bus.unsubscribe(one as unknown as WebSocket);
  bus.remove(two as unknown as WebSocket);
  off();
  assert.deepEqual(new Set(removed), new Set([first.subscriptionId, second.subscriptionId]));
});

test("a slow worker socket is closed before its outbound queue exceeds the cap", () => {
  const bus = new WebBus();
  const slow = socket(); slow.bufferedAmount = 1024 * 1024;
  bus.add(slow as unknown as WebSocket);
  const subscription = bus.subscribe(slow as unknown as WebSocket, target("one", "t1"));

  bus.publishWorker("local", "t1", { kind: "agent-message-delta", turnId: "turn", itemId: "item", delta: "x" });

  assert.equal(bus.subscription(subscription.subscriptionId, "one"), undefined);
  assert.deepEqual(slow.closed, [{ code: 1013, reason: "worker stream backpressure" }]);
  assert.equal(slow.sent.length, 0);
});
