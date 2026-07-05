import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { EndpointManager } from "../../src/endpoints/manager.ts";
import type { PermissionBlockedEvent } from "../../src/app-server/local-endpoint.ts";
import type { EndpointLossKind, ManagedAppServerEndpoint, RuntimeIdentity } from "../../src/endpoints/types.ts";

class FakeEndpoint implements ManagedAppServerEndpoint {
  state: ManagedAppServerEndpoint["state"] = "stopped";
  starts = 0;
  connectionCloses = 0;
  runtimeStops = 0;
  failStart = false;
  threadStatus: "idle" | "active" | "systemError" = "idle";
  private readonly events = new EventEmitter();
  constructor(readonly id: string) {}
  async start() { this.starts += 1; if (this.failStart) throw new Error("offline"); this.state = "ready"; this.events.emit("ready"); }
  async closeConnection() { this.connectionCloses += 1; this.state = "stopped"; }
  async shutdownRuntime() { this.runtimeStops += 1; this.state = "stopped"; }
  async runtimeIdentity(): Promise<RuntimeIdentity> {
    return this.id === "local"
      ? { kind: "local", pid: 10, startTime: "20" }
      : { kind: "ssh", token: "a".repeat(32), pid: 10, linuxStartTime: "20", processGroupId: 10 };
  }
  async request<T>(method: string): Promise<T> {
    if (method === "thread/read") return { thread: { status: { type: this.threadStatus }, turns: [] } } as T;
    return {} as T;
  }
  onNotification(listener: (method: string, params: unknown) => void) { this.events.on("notification", listener); return () => this.events.off("notification", listener); }
  onReady(listener: () => void) { this.events.on("ready", listener); return () => this.events.off("ready", listener); }
  onUnavailable(listener: (kind: EndpointLossKind) => void) { this.events.on("unavailable", listener); return () => this.events.off("unavailable", listener); }
  onPermissionBlocked(listener: (event: PermissionBlockedEvent) => void) { this.events.on("permission", listener); return () => this.events.off("permission", listener); }
  fail(kind: EndpointLossKind = "connection-lost") { this.state = "unavailable"; this.events.emit("unavailable", kind); }
}

function fixture() {
  const local = new FakeEndpoint("local");
  const remotes = new Map<string, FakeEndpoint>();
  const commits: string[] = [];
  let reloads = 0;
  const manager = new EndpointManager({
    localEndpoint: local,
    catalog: {
      reload: async () => { reloads += 1; },
      require: (id: string) => ({ id, type: "ssh" as const, projectsRoot: "~/qiyan-projects" }),
    },
    createRemote: async (definition) => {
      const endpoint = remotes.get(definition.id) ?? new FakeEndpoint(definition.id);
      remotes.set(definition.id, endpoint);
      return { endpoint, pendingBinding: { endpointId: definition.id, destination: { hostname: definition.id, user: "xin", port: 22 } } };
    },
    hasIdentityReferences: () => true,
    commitBinding: (binding) => { commits.push(binding.endpointId); },
    managedThreadIds: (id) => id === "devbox" ? ["thread-1"] : [],
  });
  return { manager, local, remotes, commits, reloads: () => reloads };
}

test("local is the default and SSH endpoints are created lazily", async () => {
  const value = fixture();
  assert.equal(value.manager.normalize(), "local");
  assert.equal((await value.manager.ensureReady()).id, "local");
  assert.equal(value.remotes.size, 0);
  assert.equal((await value.manager.ensureReady("devbox")).id, "devbox");
  assert.equal(value.remotes.size, 1);
  assert.equal(value.reloads(), 1);
  assert.deepEqual(value.commits, ["devbox"]);
});

test("failed activation commits no destination and does not replace the published generation", async () => {
  const value = fixture();
  const remote = new FakeEndpoint("offline");
  remote.failStart = true;
  value.remotes.set("offline", remote);
  await assert.rejects(value.manager.ensureReady("offline"), /offline/u);
  assert.deepEqual(value.commits, []);
  assert.throws(() => value.manager.endpointGeneration("offline"), /unavailable/u);
});

test("startup activation isolates an unavailable referenced endpoint", async () => {
  const value = fixture();
  const offline = new FakeEndpoint("offline");
  offline.failStart = true;
  value.remotes.set("offline", offline);
  const result = await value.manager.activateReferenced(["offline", "healthy"]);
  assert.deepEqual(result.unavailable, ["offline"]);
  assert.equal(value.manager.endpointGeneration("healthy").endpoint.state, "ready");
});

test("disconnect drains admitted work, rejects new work, proves idle, and stops only that runtime", async () => {
  const value = fixture();
  await value.manager.ensureReady("devbox");
  let release!: () => void;
  let admitted!: () => void;
  const reached = new Promise<void>((resolve) => { admitted = resolve; });
  const held = value.manager.withWorkLease("devbox", "file-transfer", async () => {
    admitted();
    await new Promise<void>((resolve) => { release = resolve; });
  });
  await reached;
  const disconnecting = value.manager.disconnect("devbox");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(value.manager.withWorkLease("devbox", "rpc", async () => undefined), /draining/u);
  release();
  await held;
  await disconnecting;
  assert.equal(value.remotes.get("devbox")!.runtimeStops, 1);
  assert.equal(value.manager.desiredState("devbox"), "disconnected");
});

test("active history prevents disconnect and reopens admission without stopping", async () => {
  const value = fixture();
  const endpoint = await value.manager.ensureReady("devbox") as FakeEndpoint;
  endpoint.threadStatus = "active";
  await assert.rejects(value.manager.disconnect("devbox"), /not idle/u);
  assert.equal(endpoint.runtimeStops, 0);
  assert.equal(value.manager.desiredState("devbox"), "automatic");
  await value.manager.withWorkLease("devbox", "rpc", async () => undefined);
});

test("leases reject foreign generations and old endpoint callbacks cannot replace a newer generation", async () => {
  const value = fixture();
  const first = await value.manager.ensureReady("devbox") as FakeEndpoint;
  let captured: import("../../src/endpoints/types.ts").EndpointWorkLease | undefined;
  await value.manager.withWorkLease("devbox", "rpc", async (_endpoint, lease) => { captured = lease; });
  assert.equal(value.manager.validateWorkLease(captured!, "devbox"), false);

  first.fail("connection-lost");
  const second = new FakeEndpoint("devbox");
  value.remotes.set("devbox", second);
  await value.manager.ensureReady("devbox");
  first.fail("runtime-lost");
  assert.equal(value.manager.endpointGeneration("devbox").endpoint, second);
});
