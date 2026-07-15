import assert from "node:assert/strict";
import test from "node:test";
import { createWebUiToggle } from "../../src/webui/index.ts";

function fakeServer() {
  const state = { starts: 0, stops: 0, listening: false, failNext: false };
  const handle = {
    start: async () => {
      if (state.failNext) { state.failNext = false; throw new Error("EADDRINUSE"); }
      state.starts += 1; state.listening = true; return { url: `http://x/?token=t${state.starts}` };
    },
    stop: async () => { state.stops += 1; state.listening = false; },
  };
  return { handle, state };
}

test("reconcile starts when enabled and is idempotent", async () => {
  const s = fakeServer();
  const started: string[] = [];
  const toggle = createWebUiToggle({ server: s.handle, readEnabled: () => true, onStarted: (u) => started.push(u), report: () => {} });
  await toggle.reconcile();
  assert.equal(s.state.starts, 1);
  assert.equal(toggle.isRunning(), true);
  assert.deepEqual(started, ["http://x/?token=t1"]);
  await toggle.reconcile(); // still enabled → no second start
  assert.equal(s.state.starts, 1);
});

test("reconcile stays down when disabled and toggles on state change", async () => {
  const s = fakeServer();
  let enabled = false;
  const toggle = createWebUiToggle({ server: s.handle, readEnabled: () => enabled, onStarted: () => {}, report: () => {} });
  await toggle.reconcile();
  assert.equal(s.state.starts, 0);
  assert.equal(toggle.isRunning(), false);
  enabled = true; await toggle.reconcile();
  assert.equal(s.state.starts, 1);
  enabled = false; await toggle.reconcile();
  assert.equal(s.state.stops, 1);
  assert.equal(toggle.isRunning(), false);
});

test("a corrupt state read keeps the current state (fail-safe, never fail-open)", async () => {
  const s = fakeServer();
  const warnings: string[] = [];
  const toggle = createWebUiToggle({ server: s.handle, readEnabled: () => { throw new Error("corrupt"); }, onStarted: () => {}, report: (e) => warnings.push(e.reason ?? "") });
  await toggle.reconcile();
  assert.equal(s.state.starts, 0);
  assert.equal(toggle.isRunning(), false);
  assert.equal(warnings.length, 1);
});

test("a failed start leaves running false; a later reconcile retries", async () => {
  const s = fakeServer();
  s.state.failNext = true;
  const toggle = createWebUiToggle({ server: s.handle, readEnabled: () => true, onStarted: () => {}, report: () => {} });
  await assert.rejects(toggle.reconcile(), /EADDRINUSE/); // propagates so composeApp sees the startup failure
  assert.equal(toggle.isRunning(), false);
  await toggle.reconcile(); // retry succeeds
  assert.equal(s.state.starts, 1);
  assert.equal(toggle.isRunning(), true);
});

const tick = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

test("dispose drains an in-flight start so no listener survives shutdown", async () => {
  let releaseStart!: () => void;
  const gate = new Promise<void>((resolve) => { releaseStart = resolve; });
  const state = { starts: 0, stops: 0, listening: false };
  const server = {
    start: async () => { await gate; state.starts += 1; state.listening = true; return { url: "http://x" }; },
    stop: async () => { state.stops += 1; state.listening = false; },
  };
  const toggle = createWebUiToggle({ server, readEnabled: () => true, onStarted: () => {}, report: () => {} });
  const started = toggle.reconcile(); // start op runs, passes the disposed check, awaits the gate
  await tick();
  const disposed = toggle.dispose();  // disposed=true; stop enqueued on the SAME chain (runs after start settles)
  releaseStart();
  await started; await disposed;
  assert.equal(state.starts, 1);
  assert.equal(state.stops, 1, "dispose stopped the server that finished starting");
  assert.equal(state.listening, false, "no orphaned listener");
  assert.equal(toggle.isRunning(), false);
});

test("reconcile enqueued behind an in-flight start does not start after dispose", async () => {
  let releaseStart!: () => void;
  const gate = new Promise<void>((resolve) => { releaseStart = resolve; });
  const state = { starts: 0, stops: 0 };
  const server = {
    start: async () => { await gate; state.starts += 1; return { url: "http://x" }; },
    stop: async () => { state.stops += 1; },
  };
  const toggle = createWebUiToggle({ server, readEnabled: () => true, onStarted: () => {}, report: () => {} });
  const first = toggle.reconcile();  // start op in-flight, awaiting the gate
  await tick();
  const disposed = toggle.dispose(); // disposed=true, stop enqueued
  const late = toggle.reconcile();   // enqueued after dispose → must short-circuit
  releaseStart();
  await first; await disposed; await late;
  assert.equal(state.starts, 1, "only the pre-dispose start ran");
  assert.equal(toggle.isRunning(), false);
});
