import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { BotApp } from "../src/app.ts";
import { requestServiceRestart, runForegroundApp } from "../src/main.ts";

test("service restart requests a nonzero graceful SIGTERM", () => {
  const signals: Array<{ pid: number; signal: string }> = [];
  const control: { pid: number; exitCode: string | number | null | undefined; kill(pid: number, signal: string): void } = {
    pid: 42,
    exitCode: undefined,
    kill: (pid, signal) => { signals.push({ pid, signal }); },
  };

  requestServiceRestart(control);

  assert.equal(control.exitCode, 1);
  assert.deepEqual(signals, [{ pid: 42, signal: "SIGTERM" }]);
});

test("foreground startup announces readiness and stops on a signal", async () => {
  const events: string[] = [];
  const signals = new EventEmitter();
  const app: BotApp = {
    start: async () => { events.push("start"); },
    stop: async () => { events.push("stop"); },
  };

  await runForegroundApp(app, {
    signals,
    write: (text) => { events.push(`write:${text}`); },
    onStopError: () => { events.push("stop-error"); },
  });

  assert.deepEqual(events, ["start", "write:QiYan is running in the foreground. Press Ctrl+C to stop.\n"]);
  signals.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["start", "write:QiYan is running in the foreground. Press Ctrl+C to stop.\n", "stop"]);
});

test("foreground startup reports nothing before a failed start", async () => {
  const signals = new EventEmitter();
  const writes: string[] = [];
  await assert.rejects(runForegroundApp({
    start: async () => { throw new Error("failed"); },
    stop: async () => undefined,
  }, {
    signals,
    write: (text) => { writes.push(text); },
    onStopError: () => undefined,
  }), /failed/u);
  assert.deepEqual(writes, []);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});
