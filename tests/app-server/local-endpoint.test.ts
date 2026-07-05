import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { LocalEndpoint, resolveMcpClientIdentity } from "../../src/app-server/local-endpoint.ts";

class FakeChild extends EventEmitter {
  constructor(readonly pid?: number) { super(); }
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() { this.killed = true; this.emit("exit", 0, null); return true; }
}

test("resolves one exact protocol process and rejects ambiguous launchers", async () => {
  const identify = async (pid: number) => ({ pid, startTime: `start-${pid}` });
  assert.deepEqual(await resolveMcpClientIdentity(10, async () => [], identify), { pid: 10, startTime: "start-10" });
  assert.deepEqual(await resolveMcpClientIdentity(10, async (pid) => pid === 10 ? [11] : [], identify), { pid: 11, startTime: "start-11" });
  await assert.rejects(resolveMcpClientIdentity(10, async (pid) => pid === 10 ? [11, 12] : [], identify), /launcher topology/);
  await assert.rejects(resolveMcpClientIdentity(10, async (pid) => pid === 10 ? [11] : [12], identify), /launcher topology/);
});

test("initializes app-server before becoming ready", async () => {
  const child = new FakeChild();
  const requests: Array<Record<string, unknown>> = [];
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
    requests.push(request);
    if (request.method === "initialize") child.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: "test", platformFamily: "unix", platformOs: "linux" } })}\n`);
  });
  const endpoint = new LocalEndpoint({ codexBinary: "codex", spawn: () => child as never });
  await endpoint.start();
  assert.equal(endpoint.state, "ready");
  assert.deepEqual(await endpoint.runtimeIdentity(), undefined);
  assert.equal(requests[0]?.method, "initialize");
  assert.equal((requests[0]?.params as any).clientInfo.version, "0.4.0");
  assert.equal(requests[1]?.method, "initialized");
  await endpoint.stop();
  assert.equal(child.killed, true);
});

test("declines approval requests and emits a blocked event", async () => {
  const child = new FakeChild();
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
    if (request.method === "initialize") child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
  });
  const endpoint = new LocalEndpoint({ codexBinary: "codex", spawn: () => child as never });
  const blocked: unknown[] = [];
  endpoint.onPermissionBlocked((event) => blocked.push(event));
  await endpoint.start();
  child.stdout.write(`${JSON.stringify({ id: 17, method: "item/fileChange/requestApproval", params: { threadId: "t1", turnId: "turn1", itemId: "i1", reason: "write" } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(blocked.length, 1);
});

test("accepts newer app-server versions and rejects older versions", async () => {
  const newer = new FakeChild();
  newer.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
    if (request.method === "initialize") newer.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: "codex_app_server/0.143.0-alpha.36" } })}\n`);
  });
  const accepted = new LocalEndpoint({ codexBinary: "codex", spawn: () => newer as never, minimumVersion: "0.142.5" });
  await accepted.start();
  assert.equal(accepted.state, "ready");
  await accepted.stop();

  const child = new FakeChild();
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
    if (request.method === "initialize") child.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: "codex_app_server/0.142.4 (DO_NOT_LEAK)" } })}\n`);
  });
  const endpoint = new LocalEndpoint({ codexBinary: "codex", spawn: () => child as never, minimumVersion: "0.142.5" });
  let thrown: unknown;
  try { await endpoint.start(); } catch (error) { thrown = error; }
  assert.match(String(thrown), /0\.142\.5 or newer/u);
  assert.doesNotMatch(String(thrown), /DO_NOT_LEAK/u);
  assert.equal(endpoint.state, "unavailable");
});

test("attests the assistant CODEX_HOME before publishing readiness", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-home-attestation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expected = join(root, "expected");
  const other = join(root, "other");
  await mkdir(expected);
  await mkdir(other);

  const create = (codexHome: string | undefined) => {
    const child = new FakeChild();
    child.stdin.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
      if (request.method === "initialize") child.stdout.write(`${JSON.stringify({ id: request.id, result: { ...(codexHome ? { codexHome } : {}) } })}\n`);
    });
    return { child, endpoint: new LocalEndpoint({ codexBinary: "codex", spawn: () => child as never, expectedCodexHome: expected }) };
  };

  const matching = create(expected);
  await matching.endpoint.start();
  assert.equal(matching.endpoint.state, "ready");
  await matching.endpoint.stop();

  for (const actual of [other, undefined]) {
    const mismatching = create(actual);
    await assert.rejects(mismatching.endpoint.start(), /unexpected CODEX_HOME/);
    assert.equal(mismatching.endpoint.state, "unavailable");
  }
});

test("CODEX_HOME attestation rejects replacement of the pinned expected path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-home-replacement-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expected = join(root, "expected");
  const replacement = join(root, "replacement");
  await mkdir(expected);
  await mkdir(replacement);
  await rm(expected, { recursive: true });
  await symlink(replacement, expected);
  const child = new FakeChild();
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
    if (request.method === "initialize") child.stdout.write(`${JSON.stringify({ id: request.id, result: { codexHome: expected } })}\n`);
  });
  const endpoint = new LocalEndpoint({ codexBinary: "codex", spawn: () => child as never, expectedCodexHome: expected });
  await assert.rejects(endpoint.start(), /unexpected CODEX_HOME/);
  assert.equal(endpoint.state, "unavailable");
});

test("validates the pinned assistant environment before and after initialization", async () => {
  const child = new FakeChild();
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
    if (request.method === "initialize") child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
  });
  let validations = 0;
  const endpoint = new LocalEndpoint({
    codexBinary: "codex",
    spawn: () => child as never,
    validateEnvironment: async () => {
      validations += 1;
      if (validations === 2) throw new Error("profile changed unexpectedly");
    },
  });
  await assert.rejects(endpoint.start(), /profile changed unexpectedly/);
  assert.equal(validations, 2);
  assert.equal(endpoint.state, "unavailable");
});

test("a delayed exit from an old child cannot close a restarted endpoint", async () => {
  class DelayedChild extends FakeChild {
    override kill() { this.killed = true; return true; }
    exitNow() { this.emit("exit", 0, null); }
  }
  const children = [new DelayedChild(101), new DelayedChild(102)];
  for (const child of children) {
    child.stdin.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
      if (request.method === "initialize") child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      if (request.method === "model/list") child.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [], nextCursor: null } })}\n`);
    });
  }
  let index = 0;
  const endpoint = new LocalEndpoint({ codexBinary: "codex", spawn: () => children[index++] as never, resolveMcpClientIdentity: async (pid) => ({ pid: pid + 1_000, startTime: `start-${pid}` }) });
  await endpoint.start();
  assert.deepEqual(endpoint.mcpClientIdentity, { pid: 1_101, startTime: "start-101" });
  assert.deepEqual(await endpoint.runtimeIdentity(), { kind: "local", pid: 1_101, startTime: "start-101" });
  await endpoint.stop();
  assert.equal(endpoint.mcpClientIdentity, undefined);
  await endpoint.start();
  assert.deepEqual(endpoint.mcpClientIdentity, { pid: 1_102, startTime: "start-102" });
  children[0]!.exitNow();
  assert.deepEqual(endpoint.mcpClientIdentity, { pid: 1_102, startTime: "start-102" });
  assert.deepEqual(await endpoint.request("model/list", {}), { data: [], nextCursor: null });
  assert.equal(endpoint.state, "ready");
  await endpoint.stop();
  assert.equal(endpoint.mcpClientIdentity, undefined);
  children[1]!.exitNow();
});

test("exit or stop during process resolution cannot publish a stale ready generation", async () => {
  class ControllableChild extends FakeChild {
    exitNow() { this.emit("exit", 0, null); }
  }
  const run = async (action: "exit" | "stop") => {
    const child = new ControllableChild(action === "exit" ? 201 : 202);
    child.stdin.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
      if (request.method === "initialize") child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
    });
    let release!: (identity: { pid: number; startTime: string }) => void;
    let resolving!: () => void;
    const resolutionStarted = new Promise<void>((resolve) => { resolving = resolve; });
    const resolution = new Promise<{ pid: number; startTime: string }>((resolve) => { release = resolve; });
    const endpoint = new LocalEndpoint({
      codexBinary: "codex",
      spawn: () => child as never,
      resolveMcpClientIdentity: async () => { resolving(); return resolution; },
    });
    const starting = endpoint.start();
    await resolutionStarted;
    if (action === "exit") child.exitNow();
    else await endpoint.stop();
    release({ pid: child.pid! + 1_000, startTime: `start-${child.pid}` });
    await assert.rejects(starting, /generation changed/);
    assert.notEqual(endpoint.state, "ready");
    assert.equal(endpoint.mcpClientIdentity, undefined);
  };
  await run("exit");
  await run("stop");
});
