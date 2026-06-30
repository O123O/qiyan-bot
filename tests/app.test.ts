import assert from "node:assert/strict";
import test from "node:test";
import { composeApp, TerminalInbox, type AppPhase } from "../src/app.ts";

test("composition starts in order, starts each worker once, and stops in reverse", async () => {
  const events: string[] = [];
  const phases: AppPhase[] = ["storage", "registry", "attachments", "mcp", "subscriptions", "endpoint", "reconciliation", "coordinator", "scheduler", "delivery", "maintenance", "polling"].map((name) => ({
    name, start: async () => { events.push(`start:${name}`); }, stop: async () => { events.push(`stop:${name}`); },
  }));
  const app = composeApp(phases);
  await Promise.all([app.start(), app.start()]);
  await Promise.all([app.stop(), app.stop()]);
  assert.deepEqual(events.slice(0, phases.length), phases.map((phase) => `start:${phase.name}`));
  assert.deepEqual(events.slice(phases.length), [...phases].reverse().map((phase) => `stop:${phase.name}`));
});

test("startup failure cleans already started resources in reverse order", async () => {
  const events: string[] = [];
  const app = composeApp([
    { name: "one", start: async () => { events.push("start:one"); }, stop: async () => { events.push("stop:one"); } },
    { name: "two", start: async () => { events.push("start:two"); throw new Error("boom"); }, stop: async () => { events.push("stop:two"); } },
    { name: "three", start: async () => { events.push("start:three"); }, stop: async () => undefined },
  ]);
  await assert.rejects(app.start(), /boom/);
  assert.deepEqual(events, ["start:one", "start:two", "stop:one"]);
  await app.stop();
});

test("maintenance scheduling is deterministic and stops cleanly", async () => {
  let callback: (() => void) | undefined;
  let clears = 0;
  const events: string[] = [];
  const app = composeApp([], {
    maintenance: { intervalMs: 100, run: async () => { events.push("maintain"); } },
    timers: { setInterval: (fn) => { callback = fn; return 1 as any; }, clearInterval: () => { clears += 1; } },
  });
  await app.start();
  callback?.();
  await new Promise((resolve) => setImmediate(resolve));
  await app.stop();
  assert.deepEqual(events, ["maintain"]);
  assert.equal(clears, 1);
});

test("terminal inbox preserves a completion that precedes attempt registration", () => {
  const inbox = new TerminalInbox<{ status: string }>();
  inbox.publish("turn", { status: "completed" });
  assert.deepEqual(inbox.take("turn"), { status: "completed" });
  assert.equal(inbox.take("turn"), undefined);
});

test("shutdown attempts every phase and propagates the first cleanup failure", async () => {
  const stopped: string[] = [];
  const app = composeApp([
    { name: "one", start: async () => undefined, stop: async () => { stopped.push("one"); } },
    { name: "two", start: async () => undefined, stop: async () => { stopped.push("two"); throw new Error("cleanup failed"); } },
  ]);
  await app.start();
  await assert.rejects(app.stop(), /cleanup failed/);
  assert.deepEqual(stopped, ["two", "one"]);
});
