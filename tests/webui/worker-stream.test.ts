import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { WebSocket } from "ws";
import { WebBus } from "../../src/webui/web-bus.ts";
import { createWorkerStream, offerWorkerNotification, type WorkerStream } from "../../src/webui/worker-stream.ts";

function fakeSocket(events: unknown[]): WebSocket {
  return { readyState: 1, bufferedAmount: 0, send: (payload: string) => events.push(JSON.parse(payload)), close: () => undefined } as unknown as WebSocket;
}

function registry(mappingId = "m1") {
  return { version: 3, assistant: {} as never, sessions: {
    worker: { endpoint: "local", thread_id: "thread", project_dir: "/p", mapping_id: mappingId, lifecycle_state: "managed" },
  } } as never;
}

test("unviewed detailed notifications return before registry lookup or item inspection", () => {
  const bus = new WebBus();
  let registryReads = 0;
  const stream = createWorkerStream({ bus, registrySnapshot: () => { registryReads += 1; return registry(); } });
  const params = new Proxy({ threadId: "thread" }, { get(target, key) { if (key === "item") throw new Error("item inspected"); return Reflect.get(target, key); } });

  stream.handleNotification("local", "item/completed", params);
  assert.equal(registryReads, 0);
});

test("active worker notifications are normalized without retaining raw events", () => {
  const bus = new WebBus(); const events: unknown[] = []; const ws = fakeSocket(events);
  bus.add(ws);
  const sub = bus.subscribe(ws, { nickname: "worker", endpointId: "local", threadId: "thread", mappingId: "m1", requestId: crypto.randomUUID() });
  const stream = createWorkerStream({ bus, registrySnapshot: () => registry() });

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

test("a rebound mapping is invalidated before message text is extracted", () => {
  const bus = new WebBus(); const events: unknown[] = []; const ws = fakeSocket(events);
  bus.add(ws);
  const sub = bus.subscribe(ws, { nickname: "worker", endpointId: "local", threadId: "thread", mappingId: "old", requestId: crypto.randomUUID() });
  const stream = createWorkerStream({ bus, registrySnapshot: () => registry("new") });
  const item = new Proxy({ type: "agentMessage", id: "a1" }, { get(target, key) { if (key === "text") throw new Error("text extracted"); return Reflect.get(target, key); } });

  stream.handleNotification("local", "item/completed", { threadId: "thread", turnId: "turn", item });

  assert.equal(bus.subscription(sub.subscriptionId, "worker"), undefined);
  assert.equal((events[0] as any).code, "stale-worker");
});

test("production offers fenced project notifications to the Web UI observer without consuming core routing", async () => {
  const source = await readFile(new URL("../../src/production-app.ts", import.meta.url), "utf8");
  assert.match(source, /if \(!current\(\)\) return;\s*offerWorkerNotification\(webWorkerStream, target\.id, method, params\);\s*if \(!observations\.accept/u);
});

test("a failing Web UI observer cannot prevent later core notification routing", () => {
  const stream: WorkerStream = { handleNotification() { throw new Error("web observer failed"); } };
  let coreReached = false;
  assert.doesNotThrow(() => {
    offerWorkerNotification(stream, "local", "turn/completed", {});
    coreReached = true;
  });
  assert.equal(coreReached, true);
});
