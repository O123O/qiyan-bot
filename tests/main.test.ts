import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BotApp } from "../src/app.ts";
import { requestServiceRestart, runForegroundApp, runWebUiCommand, type WebUiCommandDeps } from "../src/main.ts";
import { readWebUiState, webUiStatePath } from "../src/webui/webui-state.ts";

const webUiDeps = (dir: string, over: Partial<WebUiCommandDeps> = {}): WebUiCommandDeps => ({
  qiyanHome: dir, defaults: { host: "127.0.0.1", port: 9520 }, dataDir: dir,
  mainPid: async () => 999, signal: () => true, readToken: () => "tok", write: () => {},
  ...over,
});

test("web-ui start enables + signals the running bot, defaulting host/port to env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-webui-cmd-"));
  const writes: string[] = [];
  let signalled: number | undefined;
  await runWebUiCommand("start", webUiDeps(dir, { signal: (pid) => { signalled = pid; return true; }, write: (t) => writes.push(t) }));
  assert.equal(signalled, 999);
  assert.deepEqual(readWebUiState(webUiStatePath(dir)), { enabled: true }, "no host/port override persisted");
  assert.match(writes.join(""), /Web UI started on 127\.0\.0\.1:9520/u);
});

test("web-ui start --host --port overrides env, persists, and warns on non-loopback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-webui-cmd-"));
  const writes: string[] = [];
  await runWebUiCommand("start", webUiDeps(dir, { host: "0.0.0.0", port: 8420, write: (t) => writes.push(t) }));
  assert.deepEqual(readWebUiState(webUiStatePath(dir)), { enabled: true, host: "0.0.0.0", port: 8420 });
  const out = writes.join("");
  assert.match(out, /Web UI started on 0\.0\.0\.0:8420/u);
  assert.match(out, /non-loopback/u);
});

test("web-ui stop keeps the saved host/port but does not signal when the bot is not running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-webui-cmd-"));
  await runWebUiCommand("start", webUiDeps(dir, { host: "0.0.0.0", port: 8420 })); // seed an override
  const writes: string[] = [];
  let signalled = false;
  await runWebUiCommand("stop", webUiDeps(dir, { mainPid: async () => undefined, signal: () => { signalled = true; return true; }, write: (t) => writes.push(t) }));
  assert.equal(signalled, false);
  assert.deepEqual(readWebUiState(webUiStatePath(dir)), { enabled: false, host: "0.0.0.0", port: 8420 }, "override preserved for next start");
  assert.match(writes.join(""), /apply on next start/u);
});

test("web-ui status reports enabled/host-port/running/URL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-webui-cmd-"));
  const writes: string[] = [];
  await runWebUiCommand("status", webUiDeps(dir, { mainPid: async () => 777, readToken: () => "tok", write: (t) => writes.push(t) }));
  const out = writes.join("");
  assert.match(out, /Enabled: no/u); // absent state ⇒ off by default
  assert.match(out, /Host\/port: 127\.0\.0\.1:9520 \(env\/default\)/u);
  assert.match(out, /running \(pid 777\)/u);
  assert.match(out, /http:\/\/127\.0\.0\.1:9520\/\?token=tok/u);
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
