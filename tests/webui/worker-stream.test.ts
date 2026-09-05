import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { WebSocket } from "ws";
import { WebBus } from "../../src/webui/web-bus.ts";
import { createWorkerStream, offerWorkerNotification, type WorkerStream } from "../../src/webui/worker-stream.ts";

function fakeSocket(events: unknown[]): WebSocket {
  return { readyState: 1, bufferedAmount: 0, send: (payload: string) => events.push(JSON.parse(payload)), close: () => undefined } as unknown as WebSocket;
}

const resolveWorker = (mappingId = "m1") => (nickname: string) => nickname === "worker"
  ? { endpointId: "local", threadId: "thread", mappingId }
  : undefined;

test("unviewed detailed notifications return before registry lookup or item inspection", () => {
  const bus = new WebBus();
  let registryReads = 0;
  const stream = createWorkerStream({ bus, resolveSession: (nickname) => { registryReads += 1; return resolveWorker()(nickname); } });
  const params = new Proxy({ threadId: "thread" }, { get(target, key) { if (key === "item") throw new Error("item inspected"); return Reflect.get(target, key); } });

  stream.handleNotification("local", "item/completed", params);
  assert.equal(registryReads, 0);
});

test("active worker notifications are normalized without retaining raw events", () => {
  const bus = new WebBus(); const events: unknown[] = []; const ws = fakeSocket(events);
  bus.add(ws);
  const sub = bus.subscribe(ws, { nickname: "worker", endpointId: "local", threadId: "thread", mappingId: "m1", requestId: crypto.randomUUID() });
  const stream = createWorkerStream({ bus, resolveSession: resolveWorker() });

  stream.handleNotification("local", "item/started", { threadId: "thread", turnId: "turn", startedAtMs: 10, item: { type: "userMessage", id: "u1", clientId: "to:web:1", content: [{ type: "text", text: "hello" }, { type: "image", url: "secret" }] } });
  stream.handleNotification("local", "item/agentMessage/delta", { threadId: "thread", turnId: "turn", itemId: "a1", delta: "working" });
  stream.handleNotification("local", "item/completed", { threadId: "thread", turnId: "turn", completedAtMs: 20, item: { type: "agentMessage", id: "a1", text: "done", phase: "final_answer", memoryCitation: null } });
  stream.handleNotification("local", "turn/completed", { threadId: "thread", turn: { id: "turn" } });

  assert.equal(events.length, 4);
  assert.deepEqual((events[0] as any).event, { kind: "item-started", turnId: "turn", atMs: 10, item: { type: "user-message", id: "u1", clientId: "to:web:1", text: "hello" } });
  assert.deepEqual((events[1] as any).event, { kind: "agent-message-delta", turnId: "turn", itemId: "a1", delta: "working" });
  assert.deepEqual((events[2] as any).event, { kind: "item-completed", turnId: "turn", atMs: 20, item: { type: "agent-message", id: "a1", text: "done", phase: "final_answer" } });
  assert.deepEqual((events[3] as any).event, { kind: "turn-completed", turnId: "turn" });
  assert.equal((events[0] as any).subscriptionId, sub.subscriptionId);
});

// Background work is state, not an occurrence: it stays true until it changes. It was only sent as
// a change event, so a panel opened after a subagent started showed nothing until the next change
// -- and with no panel open the stream drops notifications entirely, so the interval that most
// needs covering was exactly the one nothing recorded.
test("a panel opened while work is already running is told the current counts", () => {
  const bus = new WebBus();
  const stream = createWorkerStream({ bus, resolveSession: resolveWorker() });

  // Nobody is watching yet -- the case the old code discarded.
  stream.handleNotification("local", "thread/tasks/updated",
    { threadId: "thread", background: 2, subagents: 1, descriptions: ["build", "scan", "review"] });

  const events: unknown[] = []; const ws = fakeSocket(events);
  bus.add(ws);
  const sub = bus.subscribe(ws, { nickname: "worker", endpointId: "local", threadId: "thread", mappingId: "m1", requestId: crypto.randomUUID() });

  assert.equal(events.length, 1, "the subscriber is told on arrival, not on the next change");
  assert.deepEqual((events[0] as any).event,
    { kind: "tasks-updated", background: 2, subagents: 1, descriptions: ["build", "scan", "review"] });
  // Numbered like any other event, so the client's sequence and replay stay consistent.
  assert.equal((events[0] as any).seq, 1);
  assert.equal(sub.latestSeq, 1);
});

// A snapshot that stops tracking while unwatched would report work that has since finished, which
// is worse than reporting none: it makes a finished worker look busy forever.
test("the snapshot follows changes made while nobody was subscribed", () => {
  const bus = new WebBus();
  const stream = createWorkerStream({ bus, resolveSession: resolveWorker() });

  stream.handleNotification("local", "thread/tasks/updated",
    { threadId: "thread", background: 2, subagents: 1, descriptions: ["build"] });
  stream.handleNotification("local", "thread/tasks/updated",
    { threadId: "thread", background: 0, subagents: 0, descriptions: [] });

  const events: unknown[] = []; const ws = fakeSocket(events);
  bus.add(ws);
  bus.subscribe(ws, { nickname: "worker", endpointId: "local", threadId: "thread", mappingId: "m1", requestId: crypto.randomUUID() });

  assert.deepEqual((events[0] as any).event,
    { kind: "tasks-updated", background: 0, subagents: 0, descriptions: [] },
    "the latest state wins, so finished work is not reported as running");
});

// Only task activity is state; a turn or an item is an occurrence and replaying one to a new
// subscriber would invent history it did not witness.
test("only task activity is snapshotted to a new subscriber", () => {
  const bus = new WebBus();
  const stream = createWorkerStream({ bus, resolveSession: resolveWorker() });

  stream.handleNotification("local", "turn/started", { threadId: "thread", turn: { id: "turn" } });

  const events: unknown[] = []; const ws = fakeSocket(events);
  bus.add(ws);
  bus.subscribe(ws, { nickname: "worker", endpointId: "local", threadId: "thread", mappingId: "m1", requestId: crypto.randomUUID() });

  assert.deepEqual(events, [], "a turn that happened unwatched is not replayed as if it just started");
});

test("a rebound mapping is invalidated before message text is extracted", () => {
  const bus = new WebBus(); const events: unknown[] = []; const ws = fakeSocket(events);
  bus.add(ws);
  const sub = bus.subscribe(ws, { nickname: "worker", endpointId: "local", threadId: "thread", mappingId: "old", requestId: crypto.randomUUID() });
  const stream = createWorkerStream({ bus, resolveSession: resolveWorker("new") });
  const item = new Proxy({ type: "agentMessage", id: "a1" }, { get(target, key) { if (key === "text") throw new Error("text extracted"); return Reflect.get(target, key); } });

  stream.handleNotification("local", "item/completed", { threadId: "thread", turnId: "turn", item });

  assert.equal(bus.subscription(sub.subscriptionId, "worker"), undefined);
  assert.equal((events[0] as any).code, "stale-worker");
});

test("the assistant foreground subscription receives the same normalized native flow", () => {
  const bus = new WebBus(); const events: unknown[] = []; const ws = fakeSocket(events);
  bus.add(ws);
  bus.subscribe(ws, { nickname: "assistant", endpointId: "assistant-local", threadId: "assistant-thread", mappingId: "assistant", requestId: crypto.randomUUID() });
  const stream = createWorkerStream({
    bus,
    resolveSession: (nickname) => nickname === "assistant"
      ? { endpointId: "assistant-local", threadId: "assistant-thread", mappingId: "assistant" }
      : undefined,
  });

  stream.handleNotification("assistant-local", "item/completed", {
    threadId: "assistant-thread", turnId: "turn", item: { type: "agentMessage", id: "a1", text: "working", phase: "commentary" },
  });
  assert.equal((events[0] as any).nickname, "assistant");
  assert.deepEqual((events[0] as any).event.item, { type: "agent-message", id: "a1", text: "working", phase: "commentary" });
});

test("production offers fenced project notifications to the Web UI observer without consuming core routing", async () => {
  const source = await readFile(new URL("../../src/production-app.ts", import.meta.url), "utf8");
  const notification = source.slice(source.indexOf("target.onNotification((method, params) => {"), source.indexOf("target.onPermissionBlocked"));
  const fence = notification.indexOf("if (!current()) return;");
  const offer = notification.indexOf("offerWorkerNotification(webWorkerStream, target.id, method, params);");
  const core = notification.indexOf("if (!observations.accept(target.id, method, params))");
  assert.ok(fence >= 0 && offer > fence && core > offer);
});

test("production marks active worker streams discontinuous at endpoint availability boundaries", async () => {
  const source = await readFile(new URL("../../src/production-app.ts", import.meta.url), "utf8");
  assert.match(source, /target\.onReady\(\(\) => \{[\s\S]{0,160}offerWorkerDiscontinuity\(webWorkerStream, target\.id\)/u);
  assert.match(source, /target\.onUnavailable\(\(kind, reason\) => \{[\s\S]{0,160}offerWorkerDiscontinuity\(webWorkerStream, target\.id\)/u);
  assert.match(source, /assistantEndpoint\.onReady\(\(\) => \{[\s\S]{0,120}offerWorkerDiscontinuity\(webWorkerStream, assistantEndpoint\.id\)/u);
});

test("a failing Web UI observer cannot prevent later core notification routing", () => {
  const stream: WorkerStream = {
    handleNotification() { throw new Error("web observer failed"); },
    handleDiscontinuity() { throw new Error("web observer failed"); },
  };
  let coreReached = false;
  assert.doesNotThrow(() => {
    offerWorkerNotification(stream, "local", "turn/completed", {});
    coreReached = true;
  });
  assert.equal(coreReached, true);
});

// Task activity is session-scoped, not turn-scoped: it outlives the turn that started it,
// so it carries no turnId and must survive the normalizer's turnId guard.
test("task activity reaches the Web UI without a turn id", () => {
  const published: unknown[] = [];
  const stream = createWorkerStream({
    bus: {
      hasWorkerSubscriber: () => true,
      pruneWorkerSubscriptions: () => {},
      publishWorker: (_endpointId: string, _threadId: string, event: unknown) => { published.push(event); },
      publishWorkerDiscontinuity: () => {},
      recordWorkerTasks: () => {},
    } as never,
    resolveSession: () => ({ endpointId: "claude-local", threadId: "t1", mappingId: "m1" }),
  });

  stream.handleNotification("claude-local", "thread/tasks/updated", {
    threadId: "t1", background: 2, subagents: 1, descriptions: ["npm test", "survey"],
  });
  assert.deepEqual(published, [{
    kind: "tasks-updated", background: 2, subagents: 1, descriptions: ["npm test", "survey"],
  }]);
});
