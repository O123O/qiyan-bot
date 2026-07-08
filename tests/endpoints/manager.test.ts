import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { EndpointManager } from "../../src/endpoints/manager.ts";
import type { PermissionBlockedEvent } from "../../src/app-server/local-endpoint.ts";
import type { EndpointLossKind, ManagedAppServerEndpoint, RuntimeIdentity } from "../../src/endpoints/types.ts";
import { RpcRequestTimeoutError } from "../../src/app-server/rpc-client.ts";
import { AppError } from "../../src/core/errors.ts";
import { createOperationReconciliationLoop, operationRecoveryFailureDisposition } from "../../src/production-app.ts";

class FakeEndpoint implements ManagedAppServerEndpoint {
  state: ManagedAppServerEndpoint["state"] = "stopped";
  starts = 0;
  connectionCloses = 0;
  runtimeStops = 0;
  rotateIdentityOnStop = false;
  failStart = false;
  startError: Error | undefined;
  identityAvailable = true;
  identityToken = "a".repeat(32);
  threadStatus: "idle" | "active" | "systemError" = "idle";
  requestError: Error | undefined;
  private readonly events = new EventEmitter();
  constructor(readonly id: string) {}
  async start() { this.starts += 1; if (this.failStart) throw this.startError ?? new Error("offline"); this.state = "ready"; this.events.emit("ready"); }
  async closeConnection() { this.connectionCloses += 1; this.state = "stopped"; }
  async shutdownRuntime() {
    this.runtimeStops += 1;
    this.state = "stopped";
    if (this.rotateIdentityOnStop && this.id !== "local") this.identityToken = "b".repeat(32);
  }
  async runtimeIdentity(): Promise<RuntimeIdentity | undefined> {
    if (!this.identityAvailable) return undefined;
    return this.id === "local"
      ? { kind: "local", pid: 10, startTime: "20" }
      : { kind: "ssh", token: this.identityToken, pid: 10, linuxStartTime: "20", processGroupId: 10 };
  }
  async request<T>(method: string): Promise<T> {
    if (this.requestError) throw this.requestError;
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

test("an unavailable referenced endpoint keeps retrying without blocking startup", async () => {
  const local = new FakeEndpoint("local");
  const remote = new FakeEndpoint("offline");
  remote.failStart = true;
  const scheduled: Array<() => void> = [];
  const manager = new EndpointManager({
    localEndpoint: local,
    catalog: { reload: async () => undefined, require: () => ({ id: "offline", type: "ssh" as const, projectsRoot: "~/qiyan-projects" }) },
    createRemote: async () => ({ endpoint: remote }),
    hasIdentityReferences: () => true,
    managedThreadIds: () => [],
    schedule: (_delay, run) => { scheduled.push(run); return { cancel: () => undefined }; },
  });
  assert.deepEqual(await manager.activateReferenced(["offline"]), { unavailable: ["offline"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1);
  remote.failStart = false;
  scheduled.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.endpointGeneration("offline").endpoint.state, "ready");
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

test("concurrent disconnects serialize and stop one exact runtime generation", async () => {
  const value = fixture();
  await value.manager.ensureReady("devbox");
  const checkpoints: unknown[] = [];
  await Promise.all([
    value.manager.disconnect("devbox", (item) => checkpoints.push(item)),
    value.manager.disconnect("devbox", (item) => checkpoints.push(item)),
  ]);
  assert.equal(value.remotes.get("devbox")!.runtimeStops, 1);
  assert.deepEqual(checkpoints.map((item) => (item as { phase: string }).phase), ["draining", "idle_proven", "runtime_stopped"]);
});

test("disconnect stops an attested unavailable orphan without requiring a ready connection", async () => {
  const value = fixture();
  const orphan = await value.manager.ensureReady("orphan") as FakeEndpoint;
  orphan.state = "unavailable";
  await value.manager.disconnect("orphan");
  assert.equal(orphan.starts, 1);
  assert.equal(orphan.runtimeStops, 1);
  assert.equal(value.manager.desiredState("orphan"), "disconnected");
});

test("shutdown fences a reconnect whose identity-reference check resolves late", async () => {
  const local = new FakeEndpoint("local");
  const remote = new FakeEndpoint("devbox");
  let resolveReferences!: (value: boolean) => void;
  const references = new Promise<boolean>((resolve) => { resolveReferences = resolve; });
  let referenceChecks = 0;
  const scheduled: Array<() => void> = [];
  const manager = new EndpointManager({
    localEndpoint: local,
    catalog: { reload: async () => undefined, require: () => ({ id: "devbox", type: "ssh" as const, projectsRoot: "~/qiyan-projects" }) },
    createRemote: async () => ({ endpoint: remote }),
    hasIdentityReferences: () => referenceChecks++ === 0 ? true : references,
    managedThreadIds: () => [],
    schedule: (_delay, run) => { scheduled.push(run); return { cancel: () => undefined }; },
  });
  await manager.ensureReady("devbox");
  remote.fail();
  await manager.closeConnections();
  resolveReferences(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(scheduled, []);
  assert.equal(remote.starts, 1);
});

test("disconnect recovery confirms an already-absent exact runtime without starting a replacement", async () => {
  const value = fixture();
  const remote = new FakeEndpoint("orphan");
  remote.identityAvailable = false;
  value.remotes.set("orphan", remote);
  const checkpoints: unknown[] = [];
  await value.manager.recoverDisconnect("orphan", "draining", { kind: "ssh", token: "a".repeat(32), pid: 10, linuxStartTime: "20", processGroupId: 10 }, (checkpoint) => checkpoints.push(checkpoint));
  assert.equal(remote.starts, 0);
  assert.equal(remote.runtimeStops, 0);
  assert.equal(value.manager.desiredState("orphan"), "disconnected");
  assert.deepEqual(checkpoints, [{ phase: "runtime_stopped", identity: { kind: "ssh", token: "a".repeat(32), pid: 10, linuxStartTime: "20", processGroupId: 10 } }]);
});

test("runtime-stopped local disconnect recovery never starts an unavailable endpoint", async () => {
  const value = fixture();
  value.local.state = "unavailable";
  await value.manager.recoverDisconnect("local", "runtime_stopped", { kind: "local", pid: 10, startTime: "20" });
  assert.equal(value.local.starts, 0);
  assert.equal(value.local.runtimeStops, 1);
  assert.equal(value.manager.desiredState("local"), "disconnected");
});

test("runtime-stopped remote restart recovery starts and validates only its replacement", async () => {
  const value = fixture();
  const replacement = new FakeEndpoint("devbox");
  replacement.identityToken = "b".repeat(32);
  value.remotes.set("devbox", replacement);
  await value.manager.recoverRestart("devbox", "runtime_stopped", {
    kind: "ssh", token: "a".repeat(32), pid: 10, linuxStartTime: "20", processGroupId: 10,
  });
  assert.equal(replacement.starts, 1);
  assert.equal(replacement.state, "ready");
  assert.equal(replacement.runtimeStops, 0);
});

test("lifecycle idle proof preserves the typed RPC timeout source", async () => {
  const value = fixture();
  const remote = await value.manager.ensureReady("devbox") as FakeEndpoint;
  remote.requestError = new RpcRequestTimeoutError("thread/read");
  await assert.rejects(value.manager.disconnect("devbox"), (error: unknown) => error instanceof RpcRequestTimeoutError);
});

test("lifecycle cold activation retries on its capped timer without a ready event", async () => {
  const value = fixture();
  const replacement = new FakeEndpoint("devbox");
  replacement.identityToken = "b".repeat(32);
  replacement.failStart = true;
  replacement.startError = new AppError("ENDPOINT_UNAVAILABLE", "cold activation failed");
  value.remotes.set("devbox", replacement);
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  let attempts = 0;
  const target = { policy: "endpoint_lifecycle", endpointId: "devbox" } as const;
  const loop = createOperationReconciliationLoop({
    isEndpointReady: () => false,
    timers: {
      setTimeout: (callback, delay) => { const timer = { callback, delay }; scheduled.push(timer); return timer; },
      clearTimeout: () => undefined,
    },
    reconcileOnce: async () => {
      attempts += 1;
      try {
        await value.manager.recoverRestart("devbox", "runtime_stopped", {
          kind: "ssh", token: "a".repeat(32), pid: 10, linuxStartTime: "20", processGroupId: 10,
        });
        return { outcome: { attempted: true, transientRetry: false, waitingForEndpoint: false }, transientTargets: new Map() };
      } catch (error) {
        const retry = operationRecoveryFailureDisposition(error, target) === "retry";
        return {
          outcome: { attempted: true, transientRetry: retry, waitingForEndpoint: false },
          transientTargets: retry ? new Map([["restart", target]]) : new Map(),
        };
      }
    },
  });
  await loop.request();
  assert.equal(scheduled[0]!.delay, 1_000);
  replacement.failStart = false;
  scheduled[0]!.callback();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(attempts, 2);
  assert.equal(replacement.starts, 2);
  assert.equal(replacement.state, "ready");
  await loop.stop();
});

test("lifecycle idle-proof timeout retries through the same operation timer", async () => {
  const value = fixture();
  const remote = await value.manager.ensureReady("devbox") as FakeEndpoint;
  const identity = await remote.runtimeIdentity();
  assert.ok(identity?.kind === "ssh");
  remote.requestError = new RpcRequestTimeoutError("thread/read");
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  let attempts = 0;
  const target = { policy: "endpoint_lifecycle", endpointId: "devbox" } as const;
  const loop = createOperationReconciliationLoop({
    isEndpointReady: () => remote.state === "ready",
    timers: {
      setTimeout: (callback, delay) => { const timer = { callback, delay }; scheduled.push(timer); return timer; },
      clearTimeout: () => undefined,
    },
    reconcileOnce: async () => {
      attempts += 1;
      try {
        await value.manager.recoverDisconnect("devbox", "draining", identity);
        return { outcome: { attempted: true, transientRetry: false, waitingForEndpoint: false }, transientTargets: new Map() };
      } catch (error) {
        const retry = operationRecoveryFailureDisposition(error, target) === "retry";
        return {
          outcome: { attempted: true, transientRetry: retry, waitingForEndpoint: false },
          transientTargets: retry ? new Map([["disconnect", target]]) : new Map(),
        };
      }
    },
  });
  await loop.request();
  assert.equal(scheduled[0]!.delay, 1_000);
  remote.requestError = undefined;
  scheduled[0]!.callback();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(attempts, 2);
  assert.equal(remote.runtimeStops, 1);
  await loop.stop();
});

test("restart recovery accepts the checkpointed replacement without restarting it again", async () => {
  const value = fixture();
  const remote = await value.manager.ensureReady("devbox") as FakeEndpoint;
  const identity = await remote.runtimeIdentity();
  assert.ok(identity);
  await value.manager.recoverRestart("devbox", "runtime_started", identity);
  assert.equal(remote.starts, 1);
  assert.equal(remote.runtimeStops, 0);

  remote.identityToken = "b".repeat(32);
  await assert.rejects(value.manager.recoverRestart("devbox", "runtime_started", identity), /identity changed/u);
  assert.equal(remote.runtimeStops, 0);
});

test("restart recovery durably checkpoints the stopped and replacement runtime identities", async () => {
  const value = fixture();
  const remote = await value.manager.ensureReady("devbox") as FakeEndpoint;
  const identity = await remote.runtimeIdentity();
  assert.ok(identity);
  remote.rotateIdentityOnStop = true;
  const checkpoints: unknown[] = [];

  await value.manager.recoverRestart("devbox", "draining", identity, (checkpoint) => checkpoints.push(checkpoint));

  assert.deepEqual(checkpoints.map((checkpoint) => (checkpoint as { phase: string }).phase), ["runtime_stopped", "runtime_started"]);
});

test("runtime-stopped restart recovery refuses to relabel the old runtime as its replacement", async () => {
  const value = fixture();
  const remote = await value.manager.ensureReady("devbox") as FakeEndpoint;
  const identity = await remote.runtimeIdentity();
  assert.ok(identity);

  await assert.rejects(value.manager.recoverRestart("devbox", "runtime_stopped", identity), /replacement|identity changed/u);
});

test("restart prepares the replacement before stopping the current runtime", async () => {
  const value = fixture();
  const current = await value.manager.ensureReady("devbox") as FakeEndpoint;
  value.remotes.delete("devbox");
  let failPreparation = true;
  const original = value.manager as unknown as { options: { createRemote: (definition: { id: string }, refs: boolean) => Promise<unknown> } };
  const create = original.options.createRemote;
  original.options.createRemote = async (definition, refs) => {
    if (failPreparation) throw new Error("SSH preflight failed");
    return create(definition as never, refs);
  };
  await assert.rejects(value.manager.restart("devbox"), /preflight failed/u);
  assert.equal(current.runtimeStops, 0);
  failPreparation = false;
});

test("restart refuses a replacement that retains the stopped runtime identity", async () => {
  const value = fixture();
  await value.manager.ensureReady("devbox");

  await assert.rejects(value.manager.restart("devbox"), /replacement|identity/u);
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

test("a ready-only work lease uses the published generation and drains before disconnect", async () => {
  const value = fixture();
  const endpoint = await value.manager.ensureReady("devbox");
  let captured: import("../../src/endpoints/types.ts").EndpointWorkLease | undefined;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });

  const work = value.manager.withReadyWorkLease("devbox", async (lease) => {
    captured = lease;
    assert.equal(value.manager.validateWorkLease(lease, "devbox"), true);
    assert.equal(value.manager.endpointGeneration("devbox").endpoint, endpoint);
    entered?.();
    await blocked;
    return "done";
  });
  await started;
  const disconnecting = value.manager.disconnect("devbox");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.remotes.get("devbox")?.runtimeStops, 0);

  release?.();
  assert.equal(await work, "done");
  await disconnecting;
  assert.ok(captured);
  assert.equal(value.manager.validateWorkLease(captured, "devbox"), false);
  assert.equal(value.remotes.get("devbox")?.runtimeStops, 1);
});

test("a ready-only work lease never activates or reloads an unavailable endpoint", async () => {
  const value = fixture();
  let ran = false;

  await assert.rejects(
    value.manager.withReadyWorkLease("offline", async () => { ran = true; }),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "ENDPOINT_UNAVAILABLE",
  );

  assert.equal(ran, false);
  assert.equal(value.reloads(), 0);
  assert.equal(value.remotes.size, 0);
});
