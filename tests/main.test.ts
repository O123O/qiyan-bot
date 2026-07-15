import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BotApp } from "../src/app.ts";
import { requestServiceRestart, runForegroundApp, runWebUiCommand, type WebUiCommandDeps } from "../src/main.ts";
import { readWebUiEnabled, webUiStatePath } from "../src/webui/webui-state.ts";

test("web-ui start persists the state and signals a running bot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-webui-cmd-"));
  const writes: string[] = [];
  let signalled: number | undefined;
  const deps: WebUiCommandDeps = {
    qiyanHome: dir, webUi: { host: "127.0.0.1", port: 4180 }, dataDir: dir,
    mainPid: async () => 999, signal: (pid) => { signalled = pid; return true; },
    readToken: () => "tok", write: (t) => writes.push(t),
  };
  await runWebUiCommand("start", deps);
  assert.equal(signalled, 999);
  assert.equal(readWebUiEnabled(webUiStatePath(dir)), true);
  assert.match(writes.join(""), /Web UI started/u);
});

test("web-ui does not signal when the web UI is not configured", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-webui-cmd-"));
  const writes: string[] = [];
  let signalled = false;
  await runWebUiCommand("stop", {
    qiyanHome: dir, dataDir: dir, // webUi omitted ⇒ not configured
    mainPid: async () => 999, signal: () => { signalled = true; return true; },
    readToken: () => undefined, write: (t) => writes.push(t),
  });
  assert.equal(signalled, false, "must not signal a bot that has no web-ui machinery");
  assert.match(writes.join(""), /not configured/u);
});

test("web-ui stop persists but does not signal when the bot is not running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-webui-cmd-"));
  const writes: string[] = [];
  let signalled = false;
  await runWebUiCommand("stop", {
    qiyanHome: dir, webUi: { host: "h", port: 1 }, dataDir: dir,
    mainPid: async () => undefined, signal: () => { signalled = true; return true; },
    readToken: () => undefined, write: (t) => writes.push(t),
  });
  assert.equal(signalled, false);
  assert.equal(readWebUiEnabled(webUiStatePath(dir)), false, "state persisted for next start");
  assert.match(writes.join(""), /apply on next start/u);
});

test("web-ui status reports configured/desired/running and the URL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-webui-cmd-"));
  const writes: string[] = [];
  await runWebUiCommand("status", {
    qiyanHome: dir, webUi: { host: "127.0.0.1", port: 4180 }, dataDir: dir,
    mainPid: async () => 777, signal: () => true, readToken: () => "tok", write: (t) => writes.push(t),
  });
  const out = writes.join("");
  assert.match(out, /Web UI: configured/u);
  assert.match(out, /Desired: enabled/u); // absent state file ⇒ enabled
  assert.match(out, /running \(pid 777\)/u);
  assert.match(out, /http:\/\/127\.0\.0\.1:4180\/\?token=tok/u);
});

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
