import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { LocalAppServerRuntime, resolveMcpClientIdentity } from "../../src/app-server/local-runtime.ts";
import { ManagedAppServerEndpoint } from "../../src/app-server/managed-endpoint.ts";

class FakeChild extends EventEmitter {
  constructor(readonly pid: number) { super(); }
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  kill() { this.killed = true; this.exitCode = 0; this.emit("exit", 0, null); return true; }
  exitNow() { this.exitCode = 1; this.emit("exit", 1, null); }
}

test("resolves one exact protocol process and rejects ambiguous launchers", async () => {
  const identify = async (pid: number) => ({ pid, startTime: `start-${pid}` });
  assert.deepEqual(await resolveMcpClientIdentity(10, async () => [], identify), { pid: 10, startTime: "start-10" });
  assert.deepEqual(await resolveMcpClientIdentity(10, async (pid) => pid === 10 ? [11] : [], identify), { pid: 11, startTime: "start-11" });
  await assert.rejects(resolveMcpClientIdentity(10, async (pid) => pid === 10 ? [11, 12] : [], identify), /launcher topology/u);
  await assert.rejects(resolveMcpClientIdentity(10, async (pid) => pid === 10 ? [11] : [12], identify), /launcher topology/u);
});

test("local runtime owns spawn, environment attestation, and exact process identity", async () => {
  const child = new FakeChild(101);
  const spawns: unknown[][] = [];
  let validations = 0;
  const runtime = new LocalAppServerRuntime({
    codexBinary: "codex",
    spawn: (command, args, options) => { spawns.push([command, args, options]); return child as never; },
    validateEnvironment: async () => { validations += 1; },
    resolveMcpClientIdentity: async (pid) => ({ pid: pid + 1_000, startTime: "1234" }),
  });

  const connection = await runtime.open();
  const identity = await connection.confirmInitialized({});

  assert.deepEqual(spawns.map(([command, args]) => [command, args]), [["codex", ["app-server", "--listen", "stdio://"]]]);
  assert.equal(validations, 2);
  assert.deepEqual(identity, {
    runtime: { kind: "local", pid: 1_101, startTime: "1234" },
    allowedClientProcess: { pid: 1_101, startTime: "1234" },
  });
  assert.deepEqual(await runtime.runtimeIdentity(), { kind: "local", pid: 1_101, startTime: "1234" });

  await connection.close();
  assert.equal(child.killed, true);
  assert.equal(await runtime.runtimeIdentity(), undefined);
});

test("local runtime attests CODEX_HOME during connection confirmation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-local-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expected = join(root, "expected");
  const other = join(root, "other");
  await Promise.all([mkdir(expected), mkdir(other)]);

  for (const actual of [other, undefined]) {
    const child = new FakeChild(actual === undefined ? 201 : 202);
    const runtime = new LocalAppServerRuntime({
      codexBinary: "codex", expectedCodexHome: expected, spawn: () => child as never,
      resolveMcpClientIdentity: async (pid) => ({ pid, startTime: String(pid) }),
    });
    const connection = await runtime.open();
    await assert.rejects(connection.confirmInitialized(actual === undefined ? {} : { codexHome: actual }), /unexpected CODEX_HOME/u);
    await connection.close();
  }
});

test("CODEX_HOME attestation rejects replacement of the pinned expected path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-local-replacement-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expected = join(root, "expected");
  const replacement = join(root, "replacement");
  await mkdir(replacement);
  await symlink(replacement, expected);
  const child = new FakeChild(250);
  const runtime = new LocalAppServerRuntime({
    codexBinary: "codex", expectedCodexHome: expected, spawn: () => child as never,
    resolveMcpClientIdentity: async (pid) => ({ pid, startTime: String(pid) }),
  });
  const connection = await runtime.open();

  await assert.rejects(connection.confirmInitialized({ codexHome: expected }), /unexpected CODEX_HOME/u);
  await connection.close();
});

test("exit or close during process resolution cannot confirm a stale local generation", async () => {
  for (const action of ["exit", "close"] as const) {
    const child = new FakeChild(action === "exit" ? 260 : 261);
    let release!: (identity: { pid: number; startTime: string }) => void;
    let resolving!: () => void;
    const started = new Promise<void>((resolve) => { resolving = resolve; });
    const resolution = new Promise<{ pid: number; startTime: string }>((resolve) => { release = resolve; });
    const runtime = new LocalAppServerRuntime({
      codexBinary: "codex", spawn: () => child as never,
      resolveMcpClientIdentity: async () => { resolving(); return resolution; },
    });
    const connection = await runtime.open();
    const confirming = connection.confirmInitialized({});
    await started;
    if (action === "exit") child.exitNow(); else await connection.close();
    release({ pid: child.pid, startTime: String(child.pid) });

    await assert.rejects(confirming, /generation changed/iu);
    assert.equal(await runtime.runtimeIdentity(), undefined);
  }
});

test("local runtime requires the exact confirmed identity for shutdown", async () => {
  const child = new FakeChild(301);
  const runtime = new LocalAppServerRuntime({
    codexBinary: "codex", spawn: () => child as never,
    resolveMcpClientIdentity: async () => ({ pid: 1_301, startTime: "1301" }),
  });
  const connection = await runtime.open();
  const confirmed = await connection.confirmInitialized({});

  await assert.rejects(
    runtime.shutdownRuntime({ kind: "local", pid: 1_302, startTime: "1302" }),
    /identity/iu,
  );
  assert.equal(child.killed, false);
  await connection.close();
  await assert.rejects(
    runtime.shutdownRuntime({ kind: "local", pid: 1_302, startTime: "1302" }),
    /identity/iu,
  );
  await runtime.shutdownRuntime(confirmed.runtime);
});

// The identity proof guards against closing a DIFFERENT generation's connection. Under force there
// is nothing for it to guard -- closing a local connection kills no process -- and proving it anyway
// refused in exactly the state force is reached for: a dropped connection clears the identity, so
// there is none to pass and none to compare against.
test("a forced local shutdown needs no identity", async () => {
  const child = new FakeChild(321);
  const runtime = new LocalAppServerRuntime({
    codexBinary: "codex", spawn: () => child as never,
    resolveMcpClientIdentity: async () => ({ pid: 1_321, startTime: "1321" }),
  });
  const connection = await runtime.open();
  await connection.confirmInitialized({});
  await connection.close();
  assert.equal(await runtime.runtimeIdentity(), undefined, "a dropped connection leaves no identity to pass");

  await assert.rejects(runtime.shutdownRuntime(undefined), /identity/iu);
  // Not a rejection, and not a TypeError from dereferencing the absent identity.
  assert.equal(await runtime.shutdownRuntime(undefined, true), undefined);
  // A mismatched identity is likewise not a reason to refuse a forced stop.
  assert.equal(await runtime.shutdownRuntime({ kind: "local", pid: 1_399, startTime: "1399" }, true), undefined);
});

test("an old local process exit cannot affect a newer runtime generation", async () => {
  const children = [new FakeChild(401), new FakeChild(402)];
  let index = 0;
  const runtime = new LocalAppServerRuntime({
    codexBinary: "codex", spawn: () => children[index++] as never,
    resolveMcpClientIdentity: async (pid) => ({ pid, startTime: String(pid) }),
  });
  const first = await runtime.open();
  await first.confirmInitialized({});
  await first.close();
  const second = await runtime.open();
  await second.confirmInitialized({});

  children[0]!.exitNow();

  assert.deepEqual(await runtime.runtimeIdentity(), { kind: "local", pid: 402, startTime: "402" });
  assert.equal(children[1]!.killed, false);
  await second.close();
});

test("local child loss closes only its current connection and classifies runtime loss", async () => {
  const child = new FakeChild(501);
  const runtime = new LocalAppServerRuntime({
    codexBinary: "codex", spawn: () => child as never,
    resolveMcpClientIdentity: async (pid) => ({ pid, startTime: String(pid) }),
  });
  const connection = await runtime.open();
  await connection.confirmInitialized({});
  const losses: string[] = [];
  connection.onClose(() => losses.push("closed"));

  child.exitNow();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(losses, ["closed"]);
  assert.equal(await runtime.runtimeIdentity(), undefined);
  assert.equal(await runtime.classifyLoss(), "runtime-lost");
});

test("local stdout loss closes the connection and releases the runtime before child exit", async () => {
  const child = new FakeChild(601);
  const runtime = new LocalAppServerRuntime({
    codexBinary: "codex", spawn: () => child as never,
    resolveMcpClientIdentity: async (pid) => ({ pid, startTime: String(pid) }),
  });
  const connection = await runtime.open();
  await connection.confirmInitialized({});
  const losses: string[] = [];
  connection.onClose((error) => losses.push(error?.message ?? "closed"));

  child.stdout.end();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(losses, ["app-server stream ended"]);
  assert.equal(await runtime.runtimeIdentity(), undefined);
  await connection.close();
  assert.equal(child.killed, true, "wire loss cleanup stops a child that has not exited");
});

test("local stdout loss preserves the wire error while making the managed endpoint unavailable once", async () => {
  const child = new FakeChild(602);
  let pendingRequestWritten!: () => void;
  const requestWritten = new Promise<void>((resolve) => { pendingRequestWritten = resolve; });
  let input = "";
  child.stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString("utf8");
    for (;;) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      const request = JSON.parse(line) as { id?: number; method?: string };
      if (request.method === "thread/read") {
        pendingRequestWritten();
      } else if (request.id !== undefined && request.method === "initialize") {
        child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      } else if (request.id !== undefined && request.method === "account/read") {
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { account: {}, requiresOpenaiAuth: false } })}\n`);
      }
    }
  });
  const runtime = new LocalAppServerRuntime({
    codexBinary: "codex", spawn: () => child as never,
    resolveMcpClientIdentity: async (pid) => ({ pid, startTime: String(pid) }),
  });
  const endpoint = new ManagedAppServerEndpoint({ id: "local", runtime });
  await endpoint.start();
  const losses: Array<{ kind: string; reason?: string }> = [];
  endpoint.onUnavailable((kind, reason) => losses.push({ kind, ...(reason === undefined ? {} : { reason }) }));

  const pending = endpoint.request("thread/read", { threadId: "thread-1" });
  await requestWritten;
  child.stdout.end();

  await assert.rejects(pending, /app-server stream ended/u);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(endpoint.state, "unavailable");
  // The stream ending IS the app-server dying, and it beats the child's own `exit` event, so this
  // is the only place the reason can be told the truth -- it used to arrive as `transport_error`.
  assert.deepEqual(losses, [{ kind: "runtime-lost", reason: "runtime_exited" }]);
  assert.equal(child.killed, true);
});
