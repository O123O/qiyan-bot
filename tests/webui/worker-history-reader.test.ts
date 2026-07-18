import assert from "node:assert/strict";
import test from "node:test";
import type { WebSocket } from "ws";
import { WebBus } from "../../src/webui/web-bus.ts";
import { WorkerHistoryError, createWorkerHistoryReader } from "../../src/webui/worker-history-reader.ts";
import { readReadyWorkerTurns } from "../../src/webui/worker-native-read.ts";

const turn = (text = "done") => ({ id: "turn", status: "completed", startedAt: 1, completedAt: 2, items: [{ type: "agentMessage", id: "a1", text, phase: "final_answer" }] });
const nativePage = (body = "done") => ({
  messages: [{ id: "a:turn:a1", turnId: "turn", body, completedAt: 2_000, terminalStatus: "completed", turnOrder: 0, itemOrder: 0 }],
  hasOlder: false, openTurnIds: [], terminalTurnIds: ["turn"],
});
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
  let resolve!: (page: ReturnType<typeof nativePage>) => void; let reads = 0;
  const pending = new Promise<ReturnType<typeof nativePage>>((done) => { resolve = done; });
  const reader = createWorkerHistoryReader({ bus, resolveSession: resolveWorker(), readTurns: async () => { reads += 1; return pending; } });

  const one = reader.read(first.subscriptionId, "worker", 20);
  const two = reader.read(second.subscriptionId, "worker", 20);
  await assert.rejects(reader.read(first.subscriptionId, "worker", 20), (error) => error instanceof WorkerHistoryError && error.code === "busy");
  assert.equal(reads, 1);
  resolve(nativePage());
  assert.deepEqual((await one).messages.map((message) => message.body), ["done"]);
  assert.deepEqual((await two).messages.map((message) => message.body), ["done"]);
});

test("subscription removal and HTTP cancellation detach consumers and abort the last native read", async () => {
  const bus = new WebBus(); const socket = fakeSocket(); const subscription = subscribe(bus, socket);
  let aborted = false;
  const reader = createWorkerHistoryReader({
    bus, resolveSession: resolveWorker(),
    readTurns: async (_endpoint, _thread, _mapping, _limit, _cursor, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true })),
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
  let mappingId = "m1"; let resolve!: (page: ReturnType<typeof nativePage>) => void;
  const pending = new Promise<ReturnType<typeof nativePage>>((done) => { resolve = done; });
  const reader = createWorkerHistoryReader({ bus, resolveSession: (nickname) => resolveWorker(mappingId)(nickname), readTurns: async () => pending });
  const read = reader.read(subscription.subscriptionId, "worker", 20);
  mappingId = "m2";
  resolve(nativePage("must not be returned"));
  await assert.rejects(read, (error) => error instanceof WorkerHistoryError && error.code === "stale");
});

test("ready native reads request complete turns through the existing lease and never activate", async () => {
  const lease = { endpointId: "local", endpointGeneration: 3, leaseId: "lease" } as never;
  const requests: unknown[][] = [];
  const read = (cursor?: string) => readReadyWorkerTurns({
    withReadyWorkLease: async (endpointId, run) => { assert.equal(endpointId, "local"); return run(lease); },
    request: async (...args) => {
      requests.push(args);
      assert.equal((args[2] as any).limit, 1, "a foreground read must request only one full native turn per frame");
      if (args[1] === "thread/turns/list" && (args[2] as any).cursor === "older-page") return {
        data: [{ ...turn("older"), id: "older-turn", itemsView: "full" }],
        nextCursor: null,
        backwardsCursor: null,
      };
      if (args[1] === "thread/turns/list") return {
        data: [{
          ...turn(), itemsView: "full",
          items: [
            { type: "agentMessage", id: "a0", text: "checking", phase: "commentary" },
            { type: "agentMessage", id: "a1", text: "done", phase: "final_answer" },
          ],
        }],
        nextCursor: "older-page", backwardsCursor: null,
      };
      throw new Error(`unexpected method: ${String(args[1])}`);
    },
  }, "local", "thread", 1, cursor, new AbortController().signal);
  const page = await read();
  assert.deepEqual(page.messages.map((message) => message.body), ["done"]);
  assert.equal(page.hasOlder, true);
  assert.ok(page.nextCursor);
  const withinTurn = await read(page.nextCursor);
  assert.deepEqual(withinTurn.messages.map((message) => message.body), ["checking"]);
  assert.equal(withinTurn.hasOlder, true);
  assert.ok(withinTurn.nextCursor);
  const older = await read(withinTurn.nextCursor);
  assert.deepEqual(older.messages.map((message) => message.body), ["older"]);
  assert.equal(older.hasOlder, false);
  assert.deepEqual(requests.map((request) => request[1]), ["thread/turns/list", "thread/turns/list", "thread/turns/list"]);
  assert.equal((requests[0]?.[2] as any).cursor, undefined);
  assert.equal((requests[1]?.[2] as any).cursor, undefined);
  assert.equal((requests[2]?.[2] as any).cursor, "older-page");
  assert.equal((requests[0]?.[2] as any).itemsView, "full");
  assert.ok(requests.every((request) => request[0] === "local" && request[4] === lease));
  assert.equal(requests.some((request) => request[1] === "thread/read"), false);

  let touched = false;
  await assert.rejects(readReadyWorkerTurns({
    withReadyWorkLease: async () => { throw new Error("not ready"); },
    request: async () => { touched = true; return { thread: { turns: [] } }; },
  }, "remote", "thread", 20, undefined, new AbortController().signal), /not ready/u);
  assert.equal(touched, false);
});

test("native Web UI paging wraps one stable turn cursor without head-relative message boundaries", async () => {
  let requests = 0;
  const cursors: unknown[] = [];
  const request = async (_endpoint: string, method: string, params: unknown) => {
    requests += 1;
    assert.equal(method, "thread/turns/list");
    assert.equal((params as any).itemsView, "full");
    assert.equal((params as any).limit, 1, "message count must not expand the native full-turn page");
    cursors.push((params as any).cursor);
    return {
      data: [{ id: "turn", status: "completed", itemsView: "full", items: [{ type: "reasoning", id: "tool" }] }],
      nextCursor: (params as any).cursor === undefined ? "older" : null,
      backwardsCursor: null,
    };
  };
  const deps = {
    withReadyWorkLease: async (_endpoint, run) => run({ endpointId: "local", endpointGeneration: 1, leaseId: "lease" } as never),
    request,
  } satisfies Parameters<typeof readReadyWorkerTurns>[0];
  const page = await readReadyWorkerTurns(deps, "local", "thread", 20, undefined, new AbortController().signal);

  assert.deepEqual(page.messages, []);
  assert.ok(page.nextCursor);
  await readReadyWorkerTurns(deps, "local", "thread", 20, page.nextCursor, new AbortController().signal);
  assert.equal(requests, 2);
  assert.deepEqual(cursors, [undefined, "older"]);
});

test("native Web UI paging never falls back to lossy summaries", async () => {
  const views: string[] = [];
  const page = await readReadyWorkerTurns({
    withReadyWorkLease: async (_endpoint, run) => run({ endpointId: "legacy", endpointGeneration: 1, leaseId: "lease" } as never),
    request: async (_endpoint, method, params) => {
      assert.equal(method, "thread/turns/list");
      const view = String((params as any).itemsView);
      views.push(view);
      return {
        data: [{
          id: "turn", status: "completed", itemsView: view,
          items: [
            { type: "userMessage", id: "user", clientId: "client", content: [{ type: "text", text: "hello" }] },
            { type: "agentMessage", id: "progress", text: "working", phase: "commentary" },
          ],
        }],
        nextCursor: null,
        backwardsCursor: null,
      };
    },
  }, "legacy", "thread", 20, undefined, new AbortController().signal);

  assert.deepEqual(views, ["full"]);
  assert.deepEqual(page.messages.map((message) => message.body), ["hello", "working"]);
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
    readTurns: async () => nativePage(),
  });
  const page = await reader.read(next.subscriptionId, "worker", 20);
  assert.deepEqual(page.terminalTurnIds, ["turn"]);
});
