import assert from "node:assert/strict";
import test from "node:test";
import {
  SshRuntime,
  decodeRemoteArgument,
  encodeRemoteArgument,
  type RemoteRuntimeClient,
} from "../../src/endpoints/ssh-runtime.ts";

class FakeRemote implements RemoteRuntimeClient {
  readonly calls: Array<{ operation: string; args: string[] }> = [];
  status: "absent" | "healthy" | "unhealthy" = "absent";
  identity = { kind: "ssh" as const, token: "a".repeat(32), pid: 101, linuxStartTime: "202", processGroupId: 101 };

  async bootstrap(): Promise<void> { this.calls.push({ operation: "bootstrap", args: [] }); }
  async invoke<T>(operation: string, args: readonly string[]): Promise<T> {
    this.calls.push({ operation, args: [...args] });
    if (operation === "preflight") return { uid: 1000, home: "/home/test", shell: "/bin/bash", codexPath: "/usr/bin/codex", tmuxPath: "/usr/bin/tmux" } as T;
    if (operation === "inspect") return { status: this.status, ...(this.status === "healthy" ? { identity: this.identity } : {}) } as T;
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

test("reuses a healthy detached runtime and changes identity only after replacement", async () => {
  const remote = new FakeRemote();
  remote.status = "healthy";
  const runtime = new SshRuntime({ endpointId: "devbox", remote });
  const first = await runtime.ensureStarted();
  assert.deepEqual(first, remote.identity);
  assert.equal(remote.calls.filter((call) => call.operation === "start").length, 0);
  assert.match(runtime.remoteSocketPath, /^\/tmp\/qiyan-1000\/[a-f0-9]{24}\/app-server\.sock$/u);

  assert.deepEqual(await runtime.runtimeIdentity(), first);
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
  await assert.rejects(runtime.ensureStarted(), /unhealthy/u);
  assert.equal(remote.calls.filter((call) => call.operation === "stop").length, 1);
});
