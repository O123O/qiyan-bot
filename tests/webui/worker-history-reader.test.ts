import assert from "node:assert/strict";
import test from "node:test";
import type { WebSocket } from "ws";
import { WebBus } from "../../src/webui/web-bus.ts";
import { WorkerHistoryError, createWorkerHistoryReader } from "../../src/webui/worker-history-reader.ts";
import { readReadyWorkerTurns } from "../../src/webui/worker-native-read.ts";

const turn = (text = "done") => ({ id: "turn", status: "completed", startedAt: 1, completedAt: 2, items: [{ type: "agentMessage", id: "a1", text, phase: "final_answer" }] });
const registry = (mappingId = "m1") => ({ version: 3, assistant: { endpoint: "a", thread_id: "a", project_dir: "/a" }, sessions: {
  worker: { endpoint: "local", thread_id: "thread", project_dir: "/p", mapping_id: mappingId, lifecycle_state: "managed" },
} } as const);

function fakeSocket(): WebSocket {
  return { readyState: 1, bufferedAmount: 0, send: () => undefined, close: () => undefined } as unknown as WebSocket;
}

function subscribe(bus: WebBus, socket: WebSocket) {
  bus.add(socket);
  return bus.subscribe(socket, { nickname: "worker", endpointId: "local", threadId: "thread", mappingId: "m1", requestId: crypto.randomUUID() });
}

test("shares one native read across subscriptions but rejects overlap from the same subscription", async () => {
  const bus = new WebBus(); const first = subscribe(bus, fakeSocket()), second = subscribe(bus, fakeSocket());
  let resolve!: (turns: unknown[]) => void; let reads = 0;
  const pending = new Promise<unknown[]>((done) => { resolve = done; });
  const reader = createWorkerHistoryReader({ bus, registrySnapshot: () => registry() as never, readTurns: async () => { reads += 1; return pending; } });

  const one = reader.read(first.subscriptionId, "worker", 20);
  const two = reader.read(second.subscriptionId, "worker", 20);
  await assert.rejects(reader.read(first.subscriptionId, "worker", 20), (error) => error instanceof WorkerHistoryError && error.code === "busy");
  assert.equal(reads, 1);
  resolve([turn()]);
  assert.deepEqual((await one).messages.map((message) => message.body), ["done"]);
  assert.deepEqual((await two).messages.map((message) => message.body), ["done"]);
});

test("subscription removal and HTTP cancellation detach consumers and abort the last native read", async () => {
  const bus = new WebBus(); const socket = fakeSocket(); const subscription = subscribe(bus, socket);
  let aborted = false;
  const reader = createWorkerHistoryReader({
    bus, registrySnapshot: () => registry() as never,
    readTurns: async (_endpoint, _thread, signal) => new Promise<unknown[]>((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true })),
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
  let mappingId = "m1"; let resolve!: (turns: unknown[]) => void;
  const pending = new Promise<unknown[]>((done) => { resolve = done; });
  const reader = createWorkerHistoryReader({ bus, registrySnapshot: () => registry(mappingId) as never, readTurns: async () => pending });
  const item = new Proxy({ type: "agentMessage", id: "a1", phase: "final_answer" }, { get(target, key) { if (key === "text") throw new Error("text extracted"); return Reflect.get(target, key); } });
  const read = reader.read(subscription.subscriptionId, "worker", 20);
  mappingId = "m2";
  resolve([{ id: "turn", status: "completed", items: [item] }]);
  await assert.rejects(read, (error) => error instanceof WorkerHistoryError && error.code === "stale");
});

test("ready native reads pass the atomically acquired existing lease and never activate", async () => {
  const lease = { endpointId: "local", endpointGeneration: 3, leaseId: "lease" } as never;
  let requested: unknown[] | undefined;
  const turns = await readReadyWorkerTurns({
    withReadyWorkLease: async (endpointId, run) => { assert.equal(endpointId, "local"); return run(lease); },
    request: async (...args) => { requested = args; return { thread: { turns: [turn()] } }; },
  }, "local", "thread", new AbortController().signal);
  assert.deepEqual(turns, [turn()]);
  assert.equal(requested?.[0], "local");
  assert.equal(requested?.[1], "thread/read");
  assert.equal(requested?.[4], lease);

  let touched = false;
  await assert.rejects(readReadyWorkerTurns({
    withReadyWorkLease: async () => { throw new Error("not ready"); },
    request: async () => { touched = true; return { thread: { turns: [] } }; },
  }, "remote", "thread", new AbortController().signal), /not ready/u);
  assert.equal(touched, false);
});

test("history pages prove terminal turns and preserve native read failures", async () => {
  const bus = new WebBus(); const subscription = subscribe(bus, fakeSocket());
  const expected = new Error("thread read failed");
  const failed = createWorkerHistoryReader({
    bus, registrySnapshot: () => registry() as never,
    readTurns: async () => { throw expected; },
  });
  await assert.rejects(failed.read(subscription.subscriptionId, "worker", 20), (error) => error === expected);

  const next = subscribe(bus, fakeSocket());
  const reader = createWorkerHistoryReader({
    bus, registrySnapshot: () => registry() as never,
    readTurns: async () => [turn()],
  });
  const page = await reader.read(next.subscriptionId, "worker", 20);
  assert.deepEqual(page.terminalTurnIds, ["turn"]);
});
