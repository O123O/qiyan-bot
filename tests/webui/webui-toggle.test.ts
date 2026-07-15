import assert from "node:assert/strict";
import test from "node:test";
import { createWebUiToggle, type WebUiTarget } from "../../src/webui/index.ts";

function fakeServers() {
  const s = { creates: [] as Array<{ host: string; port: number }>, starts: 0, stops: 0, failNext: false, live: undefined as { host: string; port: number } | undefined };
  const createServer = (host: string, port: number) => {
    s.creates.push({ host, port });
    return {
      start: async () => { if (s.failNext) { s.failNext = false; throw new Error("EADDRINUSE"); } s.starts += 1; s.live = { host, port }; return { url: `http://${host}:${port}` }; },
      stop: async () => { s.stops += 1; s.live = undefined; },
    };
  };
  return { createServer, s };
}

test("reconcile creates + starts a server on the target host/port when enabled", async () => {
  const f = fakeServers();
  const target: WebUiTarget = { enabled: true, host: "127.0.0.1", port: 9520 };
  const started: string[] = [];
  const toggle = createWebUiToggle({ createServer: f.createServer, resolveTarget: () => target, onStarted: (u) => started.push(u), report: () => {} });
  await toggle.reconcile();
  assert.equal(f.s.starts, 1);
  assert.deepEqual(f.s.creates, [{ host: "127.0.0.1", port: 9520 }]);
  assert.equal(toggle.isRunning(), true);
  assert.deepEqual(started, ["http://127.0.0.1:9520"]);
  await toggle.reconcile(); // unchanged target ⇒ no new create/start
  assert.equal(f.s.starts, 1);
  assert.equal(f.s.creates.length, 1);
});

test("disabled ⇒ no server; enabling then disabling toggles", async () => {
  const f = fakeServers();
  let target: WebUiTarget = { enabled: false, host: "127.0.0.1", port: 9520 };
  const toggle = createWebUiToggle({ createServer: f.createServer, resolveTarget: () => target, onStarted: () => {}, report: () => {} });
  await toggle.reconcile();
  assert.equal(f.s.starts, 0);
  assert.equal(toggle.isRunning(), false);
  target = { ...target, enabled: true }; await toggle.reconcile();
  assert.equal(f.s.starts, 1);
  target = { ...target, enabled: false }; await toggle.reconcile();
  assert.equal(f.s.stops, 1);
  assert.equal(toggle.isRunning(), false);
});

test("a host/port change rebinds: stops the old server and starts a new one (no orphan)", async () => {
  const f = fakeServers();
  let target: WebUiTarget = { enabled: true, host: "127.0.0.1", port: 9520 };
  const toggle = createWebUiToggle({ createServer: f.createServer, resolveTarget: () => target, onStarted: () => {}, report: () => {} });
  await toggle.reconcile();
  assert.deepEqual(f.s.live, { host: "127.0.0.1", port: 9520 });
  target = { enabled: true, host: "0.0.0.0", port: 8420 };
  await toggle.reconcile();
  assert.equal(f.s.stops, 1, "old listener stopped");
  assert.equal(f.s.starts, 2);
  assert.deepEqual(f.s.creates.map((c) => c.port), [9520, 8420]);
  assert.deepEqual(f.s.live, { host: "0.0.0.0", port: 8420 }, "only the new address listens");
});

test("a corrupt state (resolveTarget throws) keeps the current server", async () => {
  const f = fakeServers();
  let throwing = false;
  const warnings: string[] = [];
  const toggle = createWebUiToggle({
    createServer: f.createServer,
    resolveTarget: () => { if (throwing) throw new Error("corrupt"); return { enabled: true, host: "127.0.0.1", port: 9520 }; },
    onStarted: () => {}, report: (e) => warnings.push(e.reason ?? ""),
  });
  await toggle.reconcile();
  assert.equal(toggle.isRunning(), true);
  throwing = true;
  await toggle.reconcile();
  assert.equal(toggle.isRunning(), true, "kept running on a corrupt read (fail-safe)");
  assert.equal(f.s.stops, 0);
  assert.equal(warnings.length, 1);
});

test("a failed start leaves nothing running; a later reconcile retries", async () => {
  const f = fakeServers();
  f.s.failNext = true;
  const toggle = createWebUiToggle({ createServer: f.createServer, resolveTarget: () => ({ enabled: true, host: "127.0.0.1", port: 9520 }), onStarted: () => {}, report: () => {} });
  await assert.rejects(toggle.reconcile(), /EADDRINUSE/u);
  assert.equal(toggle.isRunning(), false);
  await toggle.reconcile();
  assert.equal(f.s.starts, 1);
  assert.equal(toggle.isRunning(), true);
});

const tick = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

test("dispose drains an in-flight start so no listener survives shutdown", async () => {
  let releaseStart!: () => void;
  const gate = new Promise<void>((resolve) => { releaseStart = resolve; });
  const rec = { starts: 0, stops: 0 };
  const createServer = () => ({
    start: async () => { await gate; rec.starts += 1; return { url: "http://x" }; },
    stop: async () => { rec.stops += 1; },
  });
  const toggle = createWebUiToggle({ createServer, resolveTarget: () => ({ enabled: true, host: "h", port: 1 }), onStarted: () => {}, report: () => {} });
  const started = toggle.reconcile(); // start op runs, passes the disposed check, awaits the gate
  await tick();
  const disposed = toggle.dispose();  // enqueues stop on the SAME chain (runs after start settles)
  releaseStart();
  await started; await disposed;
  assert.equal(rec.starts, 1);
  assert.equal(rec.stops, 1, "dispose stopped the server that finished starting");
  assert.equal(toggle.isRunning(), false);
});

test("dispose during a host/port rebind drains — no listener survives", async () => {
  let releaseSecond!: () => void;
  const gate2 = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const rec = { starts: 0, stops: 0 };
  let n = 0;
  const createServer = (host: string, port: number) => {
    const idx = n++;
    return {
      start: async () => { if (idx === 1) await gate2; rec.starts += 1; return { url: `http://${host}:${port}` }; },
      stop: async () => { rec.stops += 1; },
    };
  };
  let target: WebUiTarget = { enabled: true, host: "127.0.0.1", port: 9520 };
  const toggle = createWebUiToggle({ createServer, resolveTarget: () => target, onStarted: () => {}, report: () => {} });
  await toggle.reconcile(); // first server up
  assert.equal(rec.starts, 1);
  target = { enabled: true, host: "127.0.0.1", port: 8420 }; // change ⇒ rebind
  const rebinding = toggle.reconcile(); // stops old, creates new, awaits gate2 (current === undefined here)
  await tick();
  const disposed = toggle.dispose();    // enqueued strictly after the whole rebind op
  releaseSecond();
  await rebinding; await disposed;
  assert.equal(rec.starts, 2, "both servers started");
  assert.equal(rec.stops, 2, "old stopped by the rebind, new stopped by dispose");
  assert.equal(toggle.isRunning(), false, "no orphan after dispose during a rebind");

  // A stray reconcile after dispose (e.g. a late SIGUSR2) must short-circuit — the `if (disposed)
  // return` guard — and never start a fresh server.
  await toggle.reconcile();
  assert.equal(rec.starts, 2, "no start after dispose");
  assert.equal(toggle.isRunning(), false);
});
