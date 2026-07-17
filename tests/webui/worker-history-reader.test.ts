import assert from "node:assert/strict";
import test from "node:test";
import type { WebSocket } from "ws";
import { WebBus } from "../../src/webui/web-bus.ts";
import { WorkerHistoryError, createWorkerHistoryReader } from "../../src/webui/worker-history-reader.ts";
import { readReadyWorkerTurns } from "../../src/webui/worker-native-read.ts";
import { JsonRpcResponseError } from "../../src/app-server/rpc-client.ts";

const turn = (text = "done") => ({ id: "turn", status: "completed", startedAt: 1, completedAt: 2, items: [{ type: "agentMessage", id: "a1", text, phase: "final_answer" }] });
const resolveWorker = (mappingId = "m1") => (nickname: string) => nickname === "worker"
  ? { endpointId: "local", threadId: "thread", mappingId }
  : undefined;

function fakeSocket(): WebSocket {
  return { readyState: 1, bufferedAmount: 0, send: () => undefined, close: () => undefined } as unknown as WebSocket;
}

function subscribe(bus: WebBus, socket: WebSocket) {
  bus.add(socket);
  return bus.subscribe(socket, { nickname: "worker", endpointId: "local", threadId: "thread", mappingId: "m1", requestId: crypto.randomUUID() });
}

test("shares one native read across subscriptions but rejects overlap from the same subscription", async () => {
  const bus = new WebBus(); const first = subscribe(bus, fakeSocket()), second = subscribe(bus, fakeSocket());
  let resolve!: (page: { turns: unknown[] }) => void; let reads = 0;
  const pending = new Promise<{ turns: unknown[] }>((done) => { resolve = done; });
  const reader = createWorkerHistoryReader({ bus, resolveSession: resolveWorker(), readTurns: async () => { reads += 1; return pending; } });

  const one = reader.read(first.subscriptionId, "worker", 20);
  const two = reader.read(second.subscriptionId, "worker", 20);
  await assert.rejects(reader.read(first.subscriptionId, "worker", 20), (error) => error instanceof WorkerHistoryError && error.code === "busy");
  assert.equal(reads, 1);
  resolve({ turns: [turn()] });
  assert.deepEqual((await one).messages.map((message) => message.body), ["done"]);
  assert.deepEqual((await two).messages.map((message) => message.body), ["done"]);
});

test("subscription removal and HTTP cancellation detach consumers and abort the last native read", async () => {
  const bus = new WebBus(); const socket = fakeSocket(); const subscription = subscribe(bus, socket);
  let aborted = false;
  const reader = createWorkerHistoryReader({
    bus, resolveSession: resolveWorker(),
    readTurns: async (_endpoint, _thread, _limit, _cursor, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true })),
  });
  const requestAbort = new AbortController();
  const read = reader.read(subscription.subscriptionId, "worker", 20, undefined, requestAbort.signal);
  requestAbort.abort();
  await assert.rejects(read);
  assert.equal(aborted, true);

  const next = subscribe(bus, socket);
  aborted = false;
  const removed = reader.read(next.subscriptionId, "worker", 20);
  bus.unsubscribe(socket);
  await assert.rejects(removed);
  assert.equal(aborted, true);
});

test("revalidates the complete mapping after the raw read before extracting text", async () => {
  const bus = new WebBus(); const subscription = subscribe(bus, fakeSocket());
  let mappingId = "m1"; let resolve!: (page: { turns: unknown[] }) => void;
  const pending = new Promise<{ turns: unknown[] }>((done) => { resolve = done; });
  const reader = createWorkerHistoryReader({ bus, resolveSession: (nickname) => resolveWorker(mappingId)(nickname), readTurns: async () => pending });
  const item = new Proxy({ type: "agentMessage", id: "a1", phase: "final_answer" }, { get(target, key) { if (key === "text") throw new Error("text extracted"); return Reflect.get(target, key); } });
  const read = reader.read(subscription.subscriptionId, "worker", 20);
  mappingId = "m2";
  resolve({ turns: [{ id: "turn", status: "completed", items: [item] }] });
  await assert.rejects(read, (error) => error instanceof WorkerHistoryError && error.code === "stale");
});

test("ready native reads pass the atomically acquired existing lease and never activate", async () => {
  const lease = { endpointId: "local", endpointGeneration: 3, leaseId: "lease" } as never;
  const requests: unknown[][] = [];
  const page = await readReadyWorkerTurns({
    withReadyWorkLease: async (endpointId, run) => { assert.equal(endpointId, "local"); return run(lease); },
    request: async (...args) => {
      requests.push(args);
      if (args[1] === "thread/turns/list") return {
        data: [{ ...turn(), itemsView: "summary" }], nextCursor: "older-page", backwardsCursor: null,
      };
      if (args[1] === "thread/items/list") return {
        data: turn().items, nextCursor: null, backwardsCursor: null,
      };
      throw new Error(`unexpected method: ${String(args[1])}`);
    },
  }, "local", "thread", 1, undefined, new AbortController().signal);
  assert.deepEqual((page.turns[0] as any).items.map((item: any) => item.id), ["a1"]);
  assert.equal(typeof page.nextTurnCursor, "string");
  assert.deepEqual(requests.map((request) => request[1]), ["thread/turns/list", "thread/items/list"]);
  assert.equal((requests[0]?.[2] as any).cursor, undefined);
  assert.equal((requests[0]?.[2] as any).itemsView, "notLoaded");
  assert.ok(requests.every((request) => request[0] === "local" && request[4] === lease));
  assert.equal(requests.some((request) => request[1] === "thread/read"), false);

  let touched = false;
  await assert.rejects(readReadyWorkerTurns({
    withReadyWorkLease: async () => { throw new Error("not ready"); },
    request: async () => { touched = true; return { thread: { turns: [] } }; },
  }, "remote", "thread", 20, undefined, new AbortController().signal), /not ready/u);
  assert.equal(touched, false);
});

test("native Web UI paging caps tool-only scans and returns a continuation", async () => {
  let requests = 0;
  const page = await readReadyWorkerTurns({
    withReadyWorkLease: async (_endpoint, run) => run({ endpointId: "local", endpointGeneration: 1, leaseId: "lease" } as never),
    request: async (_endpoint, method, params) => {
      requests += 1;
      if (method === "thread/turns/list") return {
        data: [{ id: "turn", status: "completed", itemsView: "notLoaded", items: [] }],
        nextCursor: "older-turn", backwardsCursor: null,
      };
      const cursor = (params as any).cursor;
      const offset = cursor ? Number(String(cursor).slice(1)) : 0;
      return {
        data: [{ type: "reasoning", id: `tool-${offset}` }],
        nextCursor: `i${offset + 1}`,
        backwardsCursor: null,
      };
    },
  }, "local", "thread", 20, undefined, new AbortController().signal);

  assert.deepEqual(page.turns, []);
  assert.equal(typeof page.nextTurnCursor, "string");
  assert.equal(requests, 8);
});

test("legacy Web UI fallback requests one exact summary turn only after item paging is unsupported", async () => {
  const views: string[] = [];
  const page = await readReadyWorkerTurns({
    withReadyWorkLease: async (_endpoint, run) => run({ endpointId: "legacy", endpointGeneration: 1, leaseId: "lease" } as never),
    request: async (_endpoint, method, params) => {
      if (method === "thread/items/list") throw new JsonRpcResponseError(-32601, "thread/items/list is not supported yet");
      const view = String((params as any).itemsView);
      views.push(view);
      return {
        data: [{
          id: "turn", status: "completed", itemsView: view,
          items: view === "summary" ? [{ type: "userMessage", id: "user", clientId: "client", content: [{ type: "text", text: "hello" }] }] : [],
        }],
        nextCursor: null,
        backwardsCursor: null,
      };
    },
  }, "legacy", "thread", 20, undefined, new AbortController().signal);

  assert.deepEqual(views, ["notLoaded", "summary"]);
  assert.deepEqual((page.turns[0] as any).items.map((item: any) => item.id), ["user"]);
});

test("history pages prove terminal turns and preserve native read failures", async () => {
  const bus = new WebBus(); const subscription = subscribe(bus, fakeSocket());
  const expected = new Error("thread read failed");
  const failed = createWorkerHistoryReader({
    bus, resolveSession: resolveWorker(),
    readTurns: async () => { throw expected; },
  });
  await assert.rejects(failed.read(subscription.subscriptionId, "worker", 20), (error) => error === expected);

  const next = subscribe(bus, fakeSocket());
  const reader = createWorkerHistoryReader({
    bus, resolveSession: resolveWorker(),
    readTurns: async () => ({ turns: [turn()] }),
  });
  const page = await reader.read(next.subscriptionId, "worker", 20);
  assert.deepEqual(page.terminalTurnIds, ["turn"]);
});
