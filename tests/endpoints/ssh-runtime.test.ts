import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SshRemoteClient,
  SshRuntime,
  attestUserControlMaster,
  decodeRemoteArgument,
  encodeRemoteArgument,
  type RemoteRuntimeClient,
} from "../../src/endpoints/ssh-runtime.ts";
import { AppError } from "../../src/core/errors.ts";
import type { SshConnectionPlan } from "../../src/endpoints/ssh-config.ts";

const userMasterPlan: SshConnectionPlan = {
  alias: "devbox",
  destination: { hostname: "host.example", user: "xin", port: 22 },
  commonArgs: ["-o", "BatchMode=yes"],
  controlPath: "/tmp/user-master",
  ownsControlMaster: false,
};
const helperPath = "/tmp/qiyan-1000/abcdef0123456789abcdef01/qiyan-ssh-helper.mjs";
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
    if (operation === "preflight") return { uid: 1000, home: "/home/test", shell: "/bin/bash" } as T;
    if (operation === "inspect") return { status: this.status, ...((this.status === "healthy" || this.status === "unhealthy") && this.exposeIdentity ? { identity: this.identity } : {}) } as T;
    if (operation === "start") { this.status = "healthy"; return { identity: this.identity } as T; }
    if (operation === "stop") { this.status = "absent"; return { stopped: true } as T; }
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

test("user-owned helper and transfer calls rely on their authoritative SSH operations", async (t) => {
  const { plan } = await privateUserMaster(t);
  const calls: Array<{ args: string[]; timeoutMs: number }> = [];
  const remote = new SshRemoteClient({
    plan,
    helperSource: Buffer.from("helper"),
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

test("helper response framing ignores unrelated remote shell stdout", async (t) => {
  const { plan } = await privateUserMaster(t);
  const framed = 'qiyan-helper-v1:{"ok":true}\n';
  const remote = new SshRemoteClient({
    plan,
    helperSource: Buffer.from("helper"),
    run: async (_command, args) => ({
      stdout: args.includes("-O") ? Buffer.alloc(0) : Buffer.from(`remote shell banner\n${framed}`),
      stderr: Buffer.alloc(0),
    }),
  });

  assert.deepEqual(await remote.invoke("inspect", ["{}"], helperPath), { ok: true });
});

test("a failed user-owned helper operation preserves its direct SSH failure", async (t) => {
  const { plan } = await privateUserMaster(t);
  const calls: string[][] = [];
  const remote = new SshRemoteClient({
    plan,
    helperSource: Buffer.from("helper"),
    run: async (_command, args) => {
      calls.push([...args]);
      throw new AppError("ENDPOINT_UNAVAILABLE", "SSH process failed (exit 255)");
    },
  });

  await assert.rejects(remote.invoke("inspect", ["{}"], helperPath), /SSH process failed \(exit 255\)/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.includes("-O"), false);
});

test("a missing socket in a safe local parent reaches the authoritative helper operation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-missing-master-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: string[][] = [];
  const remote = new SshRemoteClient({
    plan: { ...userMasterPlan, controlPath: join(root, "master") },
    helperSource: Buffer.from("helper"),
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
    helperSource: Buffer.from("helper"), run,
  });
  await assert.rejects(shared.invoke("inspect", ["{}"], helperPath), /unsafe user-owned SSH ControlMaster/u);

  const { plan: broadPlan } = await privateUserMaster(t, 0o660);
  const broad = new SshRemoteClient({ plan: broadPlan, helperSource: Buffer.from("helper"), run });
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
    plan: { ...userMasterPlan, controlPath: join(root, "link", "master") }, helperSource: Buffer.from("helper"), run,
  });
  await assert.rejects(linked.invoke("inspect", ["{}"], helperPath), /unsafe user-owned SSH ControlMaster/u);
  assert.equal(calls.length, 0);
});

test("user-owned ControlMaster attestation rejects NFS socket directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-nfs-master-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const nfsPlan = { ...userMasterPlan, controlPath: join(root, "missing-master") };

  await assert.rejects(
    attestUserControlMaster(nfsPlan, async () => ({ type: 0x6969 })),
    (error: unknown) => error instanceof AppError
      && error.code === "CONFIGURATION_ERROR"
      && /private local filesystem/u.test(error.message),
  );
});

test("owned transport cleanup exits only its persistent QiYan ControlMaster", async () => {
  const calls: string[][] = [];
  const remote = new SshRemoteClient({
    plan: { ...userMasterPlan, ownsControlMaster: true },
    helperSource: Buffer.from("helper"),
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
  assert.match(runtime.remoteSocketPath, /^\/tmp\/qiyan-1000\/[a-f0-9]{24}\/app-server\.sock$/u);

  assert.deepEqual(await runtime.runtimeIdentity(), first);
  assert.equal(remote.calls.filter((call) => call.operation === "preflight").length, 1);
  assert.equal(remote.calls.filter((call) => call.operation === "bootstrap").length, 1);
  remote.identity = { ...remote.identity, token: "b".repeat(32), linuxStartTime: "303" };
  assert.notDeepEqual(await runtime.runtimeIdentity(), first);
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
