import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RpcWire } from "../../src/app-server/rpc-client.ts";
import { openSshUnixTunnel, SshEndpoint, type SshTunnel } from "../../src/endpoints/ssh-endpoint.ts";
import type { RuntimeIdentity } from "../../src/endpoints/types.ts";

class FakeWire implements RpcWire {
  private readonly messages = new Set<(message: string) => void>();
  private readonly closes = new Set<(error?: Error) => void>();
  readonly methods: string[] = [];
  constructor(private readonly userAgent = "codex_app_server/0.143.0") {}
  send(message: string): void {
    const request = JSON.parse(message) as { id?: number; method: string };
    this.methods.push(request.method);
    if (request.id === undefined) return;
    const result = request.method === "initialize"
      ? { userAgent: this.userAgent }
      : request.method === "account/read" ? { account: { type: "apiKey" }, requiresOpenaiAuth: true } : {};
    queueMicrotask(() => { for (const listener of this.messages) listener(JSON.stringify({ id: request.id, result })); });
  }
  close(): void { this.emitClose(); }
  emitClose(error?: Error): void { for (const listener of this.closes) listener(error); }
  onMessage(listener: (message: string) => void): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
  onClose(listener: (error?: Error) => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }
}

class FakeTunnel extends EventEmitter implements SshTunnel {
  closed = false;
  close(): void { this.closed = true; }
  onClose(listener: (error?: Error) => void): () => void { this.on("close", listener); return () => this.off("close", listener); }
  fail(): void { this.emit("close", new Error("tunnel lost")); }
}

const identity: RuntimeIdentity = { kind: "ssh", token: "a".repeat(32), pid: 10, linuxStartTime: "20", processGroupId: 10 };

test("bridges a private local Unix socket through an SSH byte stream", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-ssh-tunnel-"));
  const localSocketPath = join(root, "app-server.sock");
  const fixture = new URL("../fixtures/fake-ssh-tunnel.mjs", import.meta.url);
  await chmod(fixture, 0o755);
  context.after(async () => { await rm(root, { recursive: true, force: true }); });

  const tunnel = await openSshUnixTunnel({
    plan: {
      alias: "devbox",
      destination: { hostname: "example.test", user: "worker", port: 22 },
      commonArgs: [],
      ownsControlMaster: false,
    },
    localSocketPath,
    remoteSocketPath: "/tmp/qiyan-1000/0123456789abcdef01234567/app-server.sock",
    sshBinary: fixture.pathname,
  });
  context.after(async () => { await tunnel.close(); });

  const peer = createConnection(localSocketPath);
  context.after(() => peer.destroy());
  await new Promise<void>((resolve, reject) => peer.once("connect", resolve).once("error", reject));
  const received = new Promise<Buffer>((resolve, reject) => peer.once("data", resolve).once("error", reject));
  peer.write("ping");
  assert.equal((await received).toString("utf8"), "ping");
});

test("initializes over a tunnel and reconnects to the same detached runtime", async () => {
  const wires = [new FakeWire(), new FakeWire()];
  const tunnels = [new FakeTunnel(), new FakeTunnel()];
  let index = 0;
  let starts = 0;
  const endpoint = new SshEndpoint({
    id: "devbox",
    minimumVersion: "0.142.5",
    runtime: {
      ensureStarted: async () => { starts += 1; return identity; },
      runtimeIdentity: async () => identity,
      stop: async () => undefined,
      remoteSocketPath: "/tmp/qiyan-1000/abc/app-server.sock",
    },
    openTunnel: async () => tunnels[index]!,
    connectWire: async () => wires[index++]!,
  });
  await endpoint.start();
  assert.equal(endpoint.state, "ready");
  assert.deepEqual(wires[0]!.methods.slice(0, 3), ["initialize", "initialized", "account/read"]);
  await endpoint.closeConnection();
  assert.equal(tunnels[0]!.closed, true);
  await endpoint.start();
  assert.equal(starts, 2);
  assert.deepEqual(await endpoint.runtimeIdentity(), identity);
});

test("unexpected connection loss emits once and stale generations stay silent", async () => {
  const wires = [new FakeWire(), new FakeWire()];
  const tunnels = [new FakeTunnel(), new FakeTunnel()];
  let index = 0;
  const endpoint = new SshEndpoint({
    id: "devbox", minimumVersion: "0.142.5",
    runtime: { ensureStarted: async () => identity, runtimeIdentity: async () => identity, stop: async () => undefined, remoteSocketPath: "/remote.sock" },
    openTunnel: async () => tunnels[index]!, connectWire: async () => wires[index++]!,
  });
  const losses: string[] = [];
  endpoint.onUnavailable((kind) => losses.push(kind));
  await endpoint.start();
  tunnels[0]!.fail();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(losses, ["connection-lost"]);
  await endpoint.start();
  tunnels[0]!.fail();
  wires[0]!.emitClose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(losses, ["connection-lost"]);
  tunnels[1]!.fail();
  wires[1]!.emitClose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(losses, ["connection-lost", "connection-lost"]);
});

test("rejects old versions and remote profiles that require missing auth", async () => {
  const create = (wire: FakeWire) => new SshEndpoint({
    id: "devbox", minimumVersion: "0.142.5",
    runtime: { ensureStarted: async () => identity, runtimeIdentity: async () => identity, stop: async () => undefined, remoteSocketPath: "/remote.sock" },
    openTunnel: async () => new FakeTunnel(), connectWire: async () => wire,
  });
  await assert.rejects(create(new FakeWire("codex_app_server/0.142.4 (SECRET)")).start(), (error: unknown) => !String(error).includes("SECRET"));

  class MissingAuthWire extends FakeWire {
    override send(message: string): void {
      const request = JSON.parse(message) as { id?: number; method: string };
      if (request.method !== "account/read") { super.send(message); return; }
      queueMicrotask(() => {
        const listeners = (this as unknown as { messages: Set<(message: string) => void> }).messages;
        for (const listener of listeners) listener(JSON.stringify({ id: request.id, result: { account: null, requiresOpenaiAuth: true } }));
      });
    }
  }
  await assert.rejects(create(new MissingAuthWire()).start(), /not authenticated/u);
});

test("refuses to publish a connection when the detached runtime incarnation changes", async () => {
  const replacement: RuntimeIdentity = { kind: "ssh", token: "b".repeat(32), pid: 11, linuxStartTime: "21", processGroupId: 11 };
  const endpoint = new SshEndpoint({
    id: "devbox", minimumVersion: "0.142.5",
    runtime: { ensureStarted: async () => identity, runtimeIdentity: async () => replacement, stop: async () => undefined, remoteSocketPath: "/remote.sock" },
    openTunnel: async () => new FakeTunnel(), connectWire: async () => new FakeWire(),
  });
  await assert.rejects(endpoint.start(), /identity changed/u);
  assert.equal(endpoint.state, "unavailable");
});
