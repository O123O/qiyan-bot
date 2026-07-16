import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  REMOTE_APP_SERVER_PROXY_READY,
  SshRemoteClient,
  SshRuntime,
  attestUserControlMaster,
  decodeRemoteArgument,
  encodeRemoteArgument,
  prepareRemoteHost,
  type RemoteRuntimeClient,
  type RemoteBootstrapPayload,
} from "../../src/endpoints/ssh-runtime.ts";
import { AppError } from "../../src/core/errors.ts";
import type { SshConnectionPlan } from "../../src/endpoints/ssh-config.ts";
import type { ReadyProcessStream } from "../../src/endpoints/ssh-process.ts";

const userMasterPlan: SshConnectionPlan = {
  alias: "devbox",
  destination: { hostname: "host.example", user: "xin", port: 22 },
  commonArgs: ["-o", "BatchMode=yes"],
  controlPath: "/tmp/user-master",
  ownsControlMaster: false,
};
const helperPath = "/tmp/qiyan-1000/abcdef0123456789abcdef01/qiyan-ssh-helper.mjs";
const helperSource = await readFile(new URL("../../assets/remote/qiyan-ssh-helper.mjs", import.meta.url));
const framedOk = Buffer.from('qiyan-helper-v1:{"ok":true}\n');

async function privateUserMaster(t: test.TestContext, mode = 0o600): Promise<{ plan: SshConnectionPlan; server: Server }> {
  const root = await mkdtemp(join(tmpdir(), "qiyan-user-master-"));
  await chmod(root, 0o700);
  const controlPath = join(root, "master");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(controlPath, resolve);
  });
  await chmod(controlPath, mode);
  t.after(async () => {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { plan: { ...userMasterPlan, controlPath }, server };
}

class FakeRemote implements RemoteRuntimeClient {
  readonly calls: Array<{ operation: string; args: string[] }> = [];
  status: "absent" | "healthy" | "unhealthy" = "absent";
  exposeIdentity = true;
  identity = { kind: "ssh" as const, token: "a".repeat(32), pid: 101, linuxStartTime: "202", processGroupId: 101 };

  async bootstrap(): Promise<void> { this.calls.push({ operation: "bootstrap", args: [] }); }
  async invoke<T>(operation: string, args: readonly string[]): Promise<T> {
    this.calls.push({ operation, args: [...args] });
    if (operation === "preflight") return { uid: 1000, home: "/home/test", shell: "/bin/bash", runtimeBase: "/tmp/qiyan-1000" } as T;
    if (operation === "inspect") return { status: this.status, ...((this.status === "healthy" || this.status === "unhealthy") && this.exposeIdentity ? { identity: this.identity } : {}) } as T;
    if (operation === "start") { this.status = "healthy"; return { identity: this.identity } as T; }
    if (operation === "stop") { this.status = "absent"; return { stopped: true } as T; }
    throw new Error(`unexpected operation ${operation}`);
  }
}

class NamespaceRemote implements RemoteRuntimeClient {
  readonly identity = { kind: "ssh" as const, token: "c".repeat(32), pid: 303, linuxStartTime: "404", processGroupId: 303 };
  readonly calls: Array<{ operation: string; value?: Record<string, unknown>; helperPath?: string }> = [];
  legacyStatus: "absent" | "healthy" | "unhealthy" = "absent";
  sharedStatus: "absent" | "healthy" | "unhealthy" = "absent";
  runtimeBase = "/run/user/1000/qiyan-bot";

  async bootstrap(payload: RemoteBootstrapPayload): Promise<void> {
    this.calls.push({ operation: "bootstrap", value: { runtimeDir: payload.runtimeDir } });
  }

  async invoke<T>(operation: string, args: readonly string[], helperPath?: string): Promise<T> {
    if (operation === "preflight") {
      return { uid: 1000, home: "/home/test", shell: "/bin/bash", runtimeBase: this.runtimeBase } as T;
    }
    const value = JSON.parse(args[0] ?? "{}") as Record<string, unknown>;
    this.calls.push({ operation, value, ...(helperPath ? { helperPath } : {}) });
    const legacy = value.tmuxMode === "legacy";
    const status = legacy ? this.legacyStatus : this.sharedStatus;
    if (operation === "inspect") return { status, ...(status === "absent" ? {} : { identity: this.identity }) } as T;
    if (operation === "start") {
      if (legacy) this.legacyStatus = "healthy";
      else this.sharedStatus = "healthy";
      return { identity: this.identity } as T;
    }
    if (operation === "stop") {
      if (legacy) this.legacyStatus = "absent";
      else this.sharedStatus = "absent";
      return { stopped: true } as T;
    }
    throw new Error(`unexpected operation ${operation}`);
  }
}

test("remote arguments round-trip only as bounded base64url tokens", () => {
  for (const value of ["line\nbreak", "'\"$()`", "-leading", "space value", "你好"]) {
    const encoded = encodeRemoteArgument(value);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/u);
    assert.equal(encoded.includes(value), false);
    assert.equal(decodeRemoteArgument(encoded), value);
  }
  assert.throws(() => encodeRemoteArgument("x".repeat(20_000)), /too large/u);
  assert.throws(() => decodeRemoteArgument("not+base64"), /invalid/u);
});

test("the SSH client refuses remote helper source that does not match the pinned digest", () => {
  assert.throws(() => new SshRemoteClient({
    plan: { ...userMasterPlan, ownsControlMaster: true },
    helperSource: Buffer.concat([helperSource, Buffer.from("\nmodified")]),
  }), /integrity verification/u);
});

test("user-owned helper and transfer calls rely on their authoritative SSH operations", async (t) => {
  const { plan } = await privateUserMaster(t);
  const calls: Array<{ args: string[]; timeoutMs: number }> = [];
  const remote = new SshRemoteClient({
    plan,
    helperSource,
    run: async (_command, args, options) => {
      calls.push({ args: [...args], timeoutMs: options.timeoutMs });
      return {
        stdout: framedOk,
        stderr: Buffer.alloc(0),
      };
    },
  });

  await remote.invoke("inspect", ["{}"], helperPath);
  await remote.invokeTransfer("read-file", ["{}"], { maxOutputBytes: 1024 }, helperPath);

  assert.deepEqual(calls.map(({ args }) => args.includes("-O") ? args[args.indexOf("-O") + 1] : "helper"), ["helper", "helper"]);
  assert.deepEqual(calls.map((call) => call.timeoutMs), [300_000, 300_000]);
  for (const { args } of calls.filter(({ args }) => !args.includes("-O"))) {
    assert.deepEqual(args.slice(args.indexOf("-S"), args.indexOf("-S") + 2), ["-S", plan.controlPath]);
    assert.ok(args.includes("ControlMaster=no"));
  }
  await remote.closeControlMaster();
  assert.equal(calls.some(({ args }) => args.includes("exit")), false);
});

test("the SSH client opens an identity-bound helper stream over the authenticated master", async (t) => {
  const { plan } = await privateUserMaster(t);
  const input = new PassThrough();
  const output = new PassThrough();
  const stream: ReadyProcessStream = { input, output, onClose: () => () => undefined, close: async () => undefined };
  let observed: { command: string; args: string[]; marker: Buffer } | undefined;
  const remote = new SshRemoteClient({
    plan,
    helperSource,
    openStream: async (command, args, options) => {
      observed = { command, args: [...args], marker: Buffer.from(options.readyMarker) };
      return stream;
    },
  });
  const expected = { kind: "ssh" as const, token: "d".repeat(32), pid: 901, linuxStartTime: "902", processGroupId: 901 };

  assert.equal(await remote.openAppServerStream({
    runtimeDir: "/tmp/qiyan-1000/abcdef0123456789abcdef01",
    session: "qiyan-abcdef0123456789abcdef01",
    tmuxMode: "explicit",
    expected,
  }, helperPath), stream);

  assert.ok(observed);
  assert.equal(observed.command, "ssh");
  assert.deepEqual(observed.marker, REMOTE_APP_SERVER_PROXY_READY);
  assert.deepEqual(observed.args.slice(observed.args.indexOf("-S"), observed.args.indexOf("-S") + 2), ["-S", plan.controlPath]);
  const operation = observed.args.indexOf("proxy-app-server");
  assert.notEqual(operation, -1);
  assert.deepEqual(JSON.parse(decodeRemoteArgument(observed.args[operation + 1]!)), {
    runtimeDir: "/tmp/qiyan-1000/abcdef0123456789abcdef01",
    session: "qiyan-abcdef0123456789abcdef01",
    tmuxMode: "explicit",
    expected,
  });
});

test("helper response framing ignores unrelated remote shell stdout", async (t) => {
  const { plan } = await privateUserMaster(t);
  const framed = 'qiyan-helper-v1:{"ok":true}\n';
  const remote = new SshRemoteClient({
    plan,
    helperSource,
    run: async (_command, args) => ({
      stdout: args.includes("-O") ? Buffer.alloc(0) : Buffer.from(`remote shell banner\n${framed}`),
      stderr: Buffer.alloc(0),
    }),
  });

  assert.deepEqual(await remote.invoke("inspect", ["{}"], helperPath), { ok: true });
});

test("a live user-owned master that rejects helper and no-op channels requires operator action", async (t) => {
  const { plan } = await privateUserMaster(t);
  const calls: string[][] = [];
  const remote = new SshRemoteClient({
    plan,
    helperSource,
    run: async (_command, args) => {
      calls.push([...args]);
      if (args.includes("-O")) return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      throw new AppError("ENDPOINT_UNAVAILABLE", "SSH process failed (exit 255)", { exitCode: 255 });
    },
  });

  await assert.rejects(
    remote.invoke("inspect", ["{}"], helperPath),
    (error: unknown) => error instanceof AppError
      && error.code === "ENDPOINT_UNAVAILABLE"
      && error.details?.recovery === "ssh_fresh_channel_unavailable"
      && error.details?.sshHost === "devbox",
  );
  assert.deepEqual(calls.map((args) => args.includes("-O") ? "check" : args.at(-1) === "true" ? "probe" : "helper"), [
    "helper", "check", "probe",
  ]);
});

test("a working no-op channel preserves the original helper failure", async (t) => {
  const { plan } = await privateUserMaster(t);
  const original = new AppError("ENDPOINT_UNAVAILABLE", "SSH process failed (exit 255)", { exitCode: 255 });
  const calls: string[][] = [];
  const remote = new SshRemoteClient({
    plan,
    helperSource,
    run: async (_command, args) => {
      calls.push([...args]);
      if (calls.length === 1) throw original;
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  });

  await assert.rejects(remote.invoke("inspect", ["{}"], helperPath), (error) => error === original);
  assert.deepEqual(calls.map((args) => args.includes("-O") ? "check" : args.at(-1) === "true" ? "probe" : "helper"), [
    "helper", "check", "probe",
  ]);
});

test("a dead user-owned master preserves the original helper failure", async (t) => {
  const { plan } = await privateUserMaster(t);
  const original = new AppError("ENDPOINT_UNAVAILABLE", "SSH process failed (exit 255)", { exitCode: 255 });
  const calls: string[][] = [];
  const remote = new SshRemoteClient({
    plan,
    helperSource,
    run: async (_command, args) => {
      calls.push([...args]);
      throw original;
    },
  });

  await assert.rejects(remote.invoke("inspect", ["{}"], helperPath), (error) => error === original);
  assert.deepEqual(calls.map((args) => args.includes("-O") ? "check" : "helper"), ["helper", "check"]);
});

test("a QiYan-owned master failure never runs the user-master diagnostic", async (t) => {
  const calls: string[][] = [];
  const original = new AppError("ENDPOINT_UNAVAILABLE", "SSH process failed (exit 255)", { exitCode: 255 });
  const root = await mkdtemp(join(tmpdir(), "qiyan-owned-master-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = new SshRemoteClient({
    plan: { ...userMasterPlan, controlPath: join(root, "master"), ownsControlMaster: true },
    helperSource,
    run: async (_command, args) => { calls.push([...args]); throw original; },
  });

  await assert.rejects(remote.invoke("inspect", ["{}"], helperPath), (error) => error === original);
  assert.equal(calls.length, 1);
});

test("an App Server proxy startup failure uses the same fresh-channel diagnostic", async (t) => {
  const { plan } = await privateUserMaster(t);
  const calls: string[][] = [];
  const remote = new SshRemoteClient({
    plan,
    helperSource,
    openStream: async () => {
      throw new AppError("ENDPOINT_UNAVAILABLE", "SSH process stream failed before readiness", { exitCode: 255 });
    },
    run: async (_command, args) => {
      calls.push([...args]);
      if (args.includes("-O")) return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      throw new AppError("ENDPOINT_UNAVAILABLE", "SSH process failed (exit 255)", { exitCode: 255 });
    },
  });

  await assert.rejects(remote.openAppServerStream({
    runtimeDir: "/tmp/qiyan-1000/abcdef0123456789abcdef01",
    session: "qiyan-abcdef0123456789abcdef01",
    tmuxMode: "explicit",
    expected: { kind: "ssh", token: "d".repeat(32), pid: 901, linuxStartTime: "902", processGroupId: 901 },
  }, helperPath), (error: unknown) => error instanceof AppError
    && error.details?.recovery === "ssh_fresh_channel_unavailable");
  assert.deepEqual(calls.map((args) => args.includes("-O") ? "check" : "probe"), ["check", "probe"]);
});

test("a missing socket in a safe local parent reaches the authoritative helper operation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-missing-master-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: string[][] = [];
  const remote = new SshRemoteClient({
    plan: { ...userMasterPlan, controlPath: join(root, "master") },
    helperSource,
    run: async (_command, args) => {
      calls.push([...args]);
      throw new AppError("ENDPOINT_UNAVAILABLE", "SSH process failed (exit 255)");
    },
  });

  await assert.rejects(
    remote.invoke("inspect", ["{}"], helperPath),
    (error: unknown) => error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE",
  );
  assert.deepEqual(calls.map((args) => args.includes("-O") ? args[args.indexOf("-O") + 1] : "helper"), ["helper"]);
});

test("user-owned ControlMaster attestation rejects unsafe parents and sockets before SSH", async (t) => {
  const calls: string[][] = [];
  const run = async (_command: string, args: readonly string[]) => {
    calls.push([...args]);
    return { stdout: framedOk, stderr: Buffer.alloc(0) };
  };
  const shared = new SshRemoteClient({
    plan: { ...userMasterPlan, controlPath: join(tmpdir(), `qiyan-unsafe-master-${process.pid}`) },
    helperSource, run,
  });
  await assert.rejects(shared.invoke("inspect", ["{}"], helperPath), /unsafe user-owned SSH ControlMaster/u);

  const { plan: broadPlan } = await privateUserMaster(t, 0o660);
  const broad = new SshRemoteClient({ plan: broadPlan, helperSource, run });
  await assert.rejects(broad.invoke("inspect", ["{}"], helperPath), /unsafe user-owned SSH ControlMaster/u);

  const root = await mkdtemp(join(tmpdir(), "qiyan-master-link-"));
  const target = await mkdtemp(join(tmpdir(), "qiyan-master-target-"));
  await chmod(root, 0o700);
  await chmod(target, 0o700);
  const server = createServer();
  const targetSocket = join(target, "master");
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(targetSocket, resolve));
  await chmod(targetSocket, 0o600);
  await symlink(target, join(root, "link"));
  t.after(async () => {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([rm(root, { recursive: true, force: true }), rm(target, { recursive: true, force: true })]);
  });
  const linked = new SshRemoteClient({
    plan: { ...userMasterPlan, controlPath: join(root, "link", "master") }, helperSource, run,
  });
  await assert.rejects(linked.invoke("inspect", ["{}"], helperPath), /unsafe user-owned SSH ControlMaster/u);
  assert.equal(calls.length, 0);
});

test("user-owned ControlMaster attestation accepts a private NFS socket directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-nfs-master-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const nfsPlan = { ...userMasterPlan, controlPath: join(root, "missing-master") };

  await assert.doesNotReject(attestUserControlMaster(nfsPlan, async () => ({ type: 0x6969 })));
});

test("owned transport cleanup exits only its persistent QiYan ControlMaster", async () => {
  const calls: string[][] = [];
  const remote = new SshRemoteClient({
    plan: { ...userMasterPlan, ownsControlMaster: true },
    helperSource,
    run: async (_command, args) => {
      calls.push([...args]);
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  });

  await remote.closeControlMaster();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.slice(calls[0]!.indexOf("-O"), calls[0]!.indexOf("-O") + 2), ["-O", "exit"]);
});

test("reuses a healthy detached runtime and changes identity only after replacement", async () => {
  const remote = new FakeRemote();
  remote.status = "healthy";
  const runtime = new SshRuntime({ endpointId: "devbox", remote });
  const first = await runtime.ensureStarted();
  assert.deepEqual(first, remote.identity);
  assert.equal(remote.calls.filter((call) => call.operation === "start").length, 0);
  assert.deepEqual(await runtime.runtimeIdentity(), first);
  assert.equal(remote.calls.filter((call) => call.operation === "preflight").length, 1);
  assert.equal(remote.calls.filter((call) => call.operation === "bootstrap").length, 1);
  remote.identity = { ...remote.identity, token: "b".repeat(32), linuxStartTime: "303" };
  assert.notDeepEqual(await runtime.runtimeIdentity(), first);
});

test("reuses a healthy legacy runtime without duplication and moves to shared XDG state after exact stop", async () => {
  const remote = new NamespaceRemote();
  remote.legacyStatus = "healthy";
  const runtime = new SshRuntime({ endpointId: "devbox", remote });

  assert.deepEqual(await runtime.ensureStarted(), remote.identity);
  assert.equal(remote.calls.filter((call) => call.operation === "start").length, 0);
  assert.equal(runtime.remoteRuntimeDir, "/run/user/1000/qiyan-bot/2ff8ddd61f5e0a0c72ad9390");
  assert.equal(runtime.remoteHelperPath, `${runtime.remoteRuntimeDir}/qiyan-ssh-helper.mjs`);
  assert.equal(remote.calls.some((call) => call.operation === "inspect" && call.value?.tmuxMode === "legacy"), true);

  await runtime.stop(remote.identity);
  assert.deepEqual(await runtime.ensureStarted(), remote.identity);
  const starts = remote.calls.filter((call) => call.operation === "start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0]!.value?.runtimeDir, runtime.remoteRuntimeDir);
  assert.equal(starts[0]!.value?.tmuxMode, "explicit");
});

test("an unhealthy legacy runtime is never shadowed by a duplicate shared runtime", async () => {
  const remote = new NamespaceRemote();
  remote.legacyStatus = "unhealthy";
  const runtime = new SshRuntime({ endpointId: "devbox", remote });

  await assert.rejects(runtime.ensureStarted(), /unhealthy/u);
  assert.equal(remote.calls.some((call) => call.operation === "start"), false);
});

test("fallback paths probe both tmux namespaces before classifying overlapping legacy files as unhealthy", async () => {
  const remote = new NamespaceRemote();
  remote.runtimeBase = "/tmp/qiyan-1000";
  remote.sharedStatus = "unhealthy";
  remote.legacyStatus = "healthy";
  const runtime = new SshRuntime({ endpointId: "devbox", remote });

  assert.deepEqual(await runtime.ensureStarted(), remote.identity);
  assert.equal(remote.calls.some((call) => call.operation === "start"), false);
});

test("remote host preparation rejects an unvalidated runtime base before bootstrap", async () => {
  let bootstrapped = false;
  const remote: RemoteRuntimeClient = {
    bootstrap: async () => { bootstrapped = true; },
    invoke: async <T>(operation: string) => {
      if (operation === "preflight") return { uid: 1000, home: "/home/test", shell: "/bin/bash", runtimeBase: "/unsafe path" } as T;
      throw new Error("unexpected operation");
    },
  };

  await assert.rejects(prepareRemoteHost({ endpointId: "devbox", remote }), /runtime|preflight|invalid/iu);
  assert.equal(bootstrapped, false);
});

test("starts and stops only its endpoint runtime and refuses unhealthy replacement", async () => {
  const remote = new FakeRemote();
  const runtime = new SshRuntime({ endpointId: "devbox", remote });
  await runtime.ensureStarted();
  assert.equal(remote.calls.filter((call) => call.operation === "start").length, 1);
  await runtime.stop(remote.identity);
  assert.equal(remote.calls.filter((call) => call.operation === "stop").length, 1);

  remote.status = "unhealthy";
  assert.deepEqual(await runtime.runtimeIdentity(), remote.identity);
  await assert.rejects(runtime.ensureStarted(), /unhealthy/u);
  assert.equal(remote.calls.filter((call) => call.operation === "stop").length, 1);
});

test("does not report an unhealthy runtime with missing identity metadata as absent", async () => {
  const remote = new FakeRemote();
  remote.status = "unhealthy";
  remote.exposeIdentity = false;
  const runtime = new SshRuntime({ endpointId: "devbox", remote });

  await assert.rejects(runtime.runtimeIdentity(), /unhealthy|identity/iu);
});
