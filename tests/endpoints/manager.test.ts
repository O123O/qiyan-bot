import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { EndpointManager } from "../../src/endpoints/manager.ts";
import type { PermissionBlockedEvent } from "../../src/app-server/managed-endpoint.ts";
import type { EndpointLossKind, ManagedAppServerEndpoint, RuntimeIdentity } from "../../src/endpoints/types.ts";
import { RpcRequestTimeoutError } from "../../src/app-server/rpc-client.ts";
import { AppError } from "../../src/core/errors.ts";
import { createOperationReconciliationLoop, operationRecoveryFailureDisposition } from "../../src/production-app.ts";

class FakeEndpoint implements ManagedAppServerEndpoint {
  daemonless = false;
  state: ManagedAppServerEndpoint["state"] = "stopped";
  starts = 0;
  connectionCloses = 0;
  runtimeStops = 0;
  rotateIdentityOnStop = false;
  failStart = false;
  startError: Error | undefined;
  identityAvailable = true;
  identityToken = "a".repeat(32);
  localPid = 10;
  threadStatus: "idle" | "active" | "systemError" = "idle";
  requestError: Error | undefined;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  onRuntimeIdentity: (() => void) | undefined;
  private readonly events = new EventEmitter();
  constructor(readonly id: string) {}
  async start() { this.starts += 1; if (this.failStart) throw this.startError ?? new Error("offline"); this.state = "ready"; this.events.emit("ready"); }
  async closeConnection() { this.connectionCloses += 1; this.state = "stopped"; }
  async shutdownRuntime() {
    this.runtimeStops += 1;
    this.state = "stopped";
    if (this.rotateIdentityOnStop) {
      if (this.id === "local") this.localPid += 1;
      else this.identityToken = "b".repeat(32);
    }
  }
  async runtimeIdentity(): Promise<RuntimeIdentity | undefined> {
    this.onRuntimeIdentity?.();
    if (!this.identityAvailable) return undefined;
    return this.id === "local"
      ? { kind: "local", pid: this.localPid, startTime: "20" }
      : { kind: "ssh", token: this.identityToken, pid: 10, linuxStartTime: "20", processGroupId: 10 };
  }
  async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
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

function queuedFixture(candidates: FakeEndpoint[], managedThreadIds: readonly string[] = []) {
  const local = new FakeEndpoint("local");
  let index = 0;
  const manager = new EndpointManager({
    localEndpoint: local,
    catalog: {
      reload: async () => undefined,
      require: (id: string) => ({ id, provider: "codex" as const, transport: "ssh" as const, host: id, projectsRoot: "~/qiyan-projects" }),
    },
    createRemote: async () => {
      const endpoint = candidates[index++];
      assert.ok(endpoint, "unexpected remote candidate request");
      return { endpoint };
    },
    hasIdentityReferences: () => true,
    managedThreadIds: () => managedThreadIds,
  });
  return { manager, local, candidateCount: () => index };
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
      require: (id: string) => ({ id, provider: "codex" as const, transport: "ssh" as const, host: id, projectsRoot: "~/qiyan-projects" }),
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
    catalog: { reload: async () => undefined, require: () => ({ id: "offline", provider: "codex" as const, transport: "ssh" as const, host: "offline", projectsRoot: "~/qiyan-projects" }) },
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

test("reconnect backoff escalates then gives up after ~48h of failures instead of hammering forever", async () => {
  const local = new FakeEndpoint("local");
  const remote = new FakeEndpoint("offline");
  remote.failStart = true;
  const scheduled: Array<{ delay: number; run: () => void }> = [];
  const gaveUp: Array<{ id: string; attempts: number }> = [];
  const manager = new EndpointManager({
    localEndpoint: local,
    catalog: { reload: async () => undefined, require: () => ({ id: "offline", provider: "codex" as const, transport: "ssh" as const, host: "offline", projectsRoot: "~/qiyan-projects" }) },
    createRemote: async () => ({ endpoint: remote }),
    hasIdentityReferences: () => true,
    managedThreadIds: () => [],
    schedule: (delay, run) => { scheduled.push({ delay, run }); return { cancel: () => undefined }; },
    onReconnectGaveUp: (id, attempts) => { gaveUp.push({ id, attempts }); },
  });
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };

  await assert.rejects(manager.ensureReady("offline"), /offline/u);
  await settle();

  const delays: number[] = [];
  let guard = 0;
  while (scheduled.length > 0 && guard++ < 500) {
    const item = scheduled.shift()!;
    delays.push(item.delay);
    item.run();
    await settle();
  }

  assert.ok(guard < 500, "the reconnect loop terminated via give-up, not the test safety cap");
  // 5 fast ramp attempts (5s,10s,30s,1m,2m) then hourly until ~48h total → give up.
  assert.equal(delays.length, 53);
  assert.deepEqual(delays.slice(0, 5), [5_000, 10_000, 30_000, 60_000, 120_000]);
  assert.equal(delays[5], 3_600_000);
  assert.equal(delays[52], 3_600_000);
  assert.deepEqual(gaveUp, [{ id: "offline", attempts: 53 }]);
  assert.equal(scheduled.length, 0, "no further retries are scheduled once the circuit gives up");

  // In production ensureReady runs per turn/RPC (AppServerPool.resolveEndpoint); a downed endpoint
  // under continued use must NOT re-emit the give-up signal or re-arm the background retry loop.
  await assert.rejects(manager.ensureReady("offline"), /offline/u);
  await settle();
  await assert.rejects(manager.ensureReady("offline"), /offline/u);
  await settle();
  assert.deepEqual(gaveUp, [{ id: "offline", attempts: 53 }], "give-up is latched: fired exactly once");
  assert.equal(scheduled.length, 0, "post-give-up on-demand use stays bounded (one direct attempt, no ramp)");
});

test("a successful reconnect resets the backoff so a later outage restarts at the fast ramp", async () => {
  const local = new FakeEndpoint("local");
  const remote = new FakeEndpoint("offline");
  remote.failStart = true;
  const scheduled: Array<{ delay: number; run: () => void }> = [];
  const manager = new EndpointManager({
    localEndpoint: local,
    catalog: { reload: async () => undefined, require: () => ({ id: "offline", provider: "codex" as const, transport: "ssh" as const, host: "offline", projectsRoot: "~/qiyan-projects" }) },
    createRemote: async () => ({ endpoint: remote }),
    hasIdentityReferences: () => true,
    managedThreadIds: () => [],
    schedule: (delay, run) => { scheduled.push({ delay, run }); return { cancel: () => undefined }; },
  });
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };

  await assert.rejects(manager.ensureReady("offline"), /offline/u);
  await settle();
  assert.deepEqual(scheduled.map((item) => item.delay), [5_000]); // first attempt

  scheduled.shift()!.run(); // still failing → escalates
  await settle();
  assert.deepEqual(scheduled.map((item) => item.delay), [10_000]); // second attempt

  remote.failStart = false;
  scheduled.shift()!.run(); // succeeds → publishes and resets reconnectAttempt
  await settle();
  assert.equal(manager.endpointGeneration("offline").endpoint.state, "ready");
  assert.equal(scheduled.length, 0);

  remote.failStart = true;
  remote.fail("connection-lost"); // a fresh outage after recovery
  await settle();
  assert.deepEqual(scheduled.map((item) => item.delay), [5_000], "the backoff restarts at the fast ramp, not the previous escalation");
});

test("the give-up latch re-arms after a recovery so a second sustained outage warns again", async () => {
  const local = new FakeEndpoint("local");
  const remote = new FakeEndpoint("offline");
  remote.failStart = true;
  const scheduled: Array<{ delay: number; run: () => void }> = [];
  const gaveUp: Array<{ id: string; attempts: number }> = [];
  const manager = new EndpointManager({
    localEndpoint: local,
    catalog: { reload: async () => undefined, require: () => ({ id: "offline", provider: "codex" as const, transport: "ssh" as const, host: "offline", projectsRoot: "~/qiyan-projects" }) },
    createRemote: async () => ({ endpoint: remote }),
    hasIdentityReferences: () => true,
    managedThreadIds: () => [],
    schedule: (delay, run) => { scheduled.push({ delay, run }); return { cancel: () => undefined }; },
    onReconnectGaveUp: (id, attempts) => { gaveUp.push({ id, attempts }); },
  });
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const driveToGiveUp = async () => {
    let guard = 0;
    while (scheduled.length > 0 && guard++ < 500) { scheduled.shift()!.run(); await settle(); }
    assert.ok(guard < 500, "the reconnect loop terminated via give-up, not the test safety cap");
  };

  // First sustained outage, via on-demand activation retries → gives up once.
  await assert.rejects(manager.ensureReady("offline"), /offline/u);
  await settle();
  await driveToGiveUp();
  assert.deepEqual(gaveUp, [{ id: "offline", attempts: 53 }]);

  // Cluster comes back: a successful activation publishes and clears the latch.
  remote.failStart = false;
  await manager.ensureReady("offline");
  await settle();
  assert.equal(manager.endpointGeneration("offline").endpoint.state, "ready");
  assert.equal(scheduled.length, 0);

  // A second sustained outage — this time via the loss path (onUnavailable → scheduleReconnect,
  // the real cluster-maintenance trigger): the latch has re-armed, so it ramps up and warns again.
  remote.failStart = true;
  remote.fail("connection-lost");
  await settle();
  await driveToGiveUp();
  assert.deepEqual(gaveUp, [{ id: "offline", attempts: 53 }, { id: "offline", attempts: 53 }]);
});

test("a failed referenced local activation retries and publishes its first generation", async () => {
  const local = new FakeEndpoint("local");
  local.failStart = true;
  const scheduled: Array<() => void> = [];
  const publications: number[] = [];
  const manager = new EndpointManager({
    localEndpoint: local,
    catalog: { reload: async () => undefined, require: () => assert.fail("local activation must not read the SSH catalog") },
    createRemote: async () => assert.fail("local activation must not create an SSH endpoint"),
    hasIdentityReferences: (endpointId) => endpointId === "local",
    managedThreadIds: () => [],
    schedule: (_delay, run) => { scheduled.push(run); return { cancel: () => undefined }; },
  });
  manager.onEndpoint((_endpoint, generation) => { publications.push(generation); });

  assert.deepEqual(await manager.activateReferenced(["local"]), { unavailable: ["local"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1);
  assert.equal(publications.length, 0);

  local.failStart = false;
  scheduled.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.endpointGeneration("local").endpoint, local);
  assert.deepEqual(publications, [1]);
});

test("a failed first on-demand local activation retries only while durably referenced", async () => {
  const local = new FakeEndpoint("local");
  local.failStart = true;
  const scheduled: Array<() => void> = [];
  let referenced = true;
  const manager = new EndpointManager({
    localEndpoint: local,
    catalog: { reload: async () => undefined, require: () => assert.fail("local activation must not read the SSH catalog") },
    createRemote: async () => assert.fail("local activation must not create an SSH endpoint"),
    hasIdentityReferences: () => referenced,
    managedThreadIds: () => [],
    schedule: (_delay, run) => { scheduled.push(run); return { cancel: () => undefined }; },
  });

  await assert.rejects(manager.ensureReady("local"), /offline/u);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1, "the durable operation keeps first-use activation alive");

  referenced = false;
  local.failStart = false;
  scheduled.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => manager.endpointGeneration("local"), /unavailable/u);
  assert.equal(local.starts, 1, "the fenced retry stops when its durable reference disappears");
});

test("an unreferenced local endpoint remains dormant during startup activation", async () => {
  const local = new FakeEndpoint("local");
  const scheduled: Array<() => void> = [];
  const manager = new EndpointManager({
    localEndpoint: local,
    catalog: { reload: async () => undefined, require: () => assert.fail("no endpoint should activate") },
    createRemote: async () => assert.fail("no endpoint should activate"),
    hasIdentityReferences: () => false,
    managedThreadIds: () => [],
    schedule: (_delay, run) => { scheduled.push(run); return { cancel: () => undefined }; },
  });

  assert.deepEqual(await manager.activateReferenced([]), { unavailable: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(local.starts, 0);
  assert.equal(scheduled.length, 0);
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
    catalog: { reload: async () => undefined, require: () => ({ id: "devbox", provider: "codex" as const, transport: "ssh" as const, host: "devbox", projectsRoot: "~/qiyan-projects" }) },
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

test("lifecycle idle proof does not require materialized turn history", async () => {
  const value = fixture();
  const remote = await value.manager.ensureReady("devbox") as FakeEndpoint;

  await value.manager.disconnect("devbox");

  assert.deepEqual(remote.requests, [{ method: "thread/read", params: { threadId: "thread-1", includeTurns: false } }]);
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

test("restart recovery of a daemonless endpoint completes without a runtime identity", async () => {
  // Regression: a daemonless (Claude) endpoint checkpoints with no identity, so recovery runs
  // with expectedIdentity=undefined. It must re-ready the adapter without the identity proof
  // (otherwise the op is stranded forever and locks out all future restart/disconnect).
  const value = fixture();
  const remote = await value.manager.ensureReady("devbox") as FakeEndpoint;
  remote.daemonless = true;
  remote.identityAvailable = false;
  const before = remote.starts;
  const checkpoints: unknown[] = [];

  await value.manager.recoverRestart("devbox", "draining", undefined, (checkpoint) => checkpoints.push(checkpoint));

  assert.deepEqual(checkpoints.map((checkpoint) => (checkpoint as { phase: string; identity?: unknown })), [
    { phase: "runtime_stopped", identity: undefined },
    { phase: "runtime_started", identity: undefined },
  ]);
  assert.ok(remote.starts > before, "daemonless endpoint was not re-readied");
  assert.equal(remote.state, "ready");
});

test("disconnect recovery of a daemonless endpoint completes without a runtime identity", async () => {
  const value = fixture();
  const remote = await value.manager.ensureReady("devbox") as FakeEndpoint;
  remote.daemonless = true;
  remote.identityAvailable = false;

  await value.manager.recoverDisconnect("devbox", "draining", undefined);

  assert.equal(remote.connectionCloses > 0, true, "daemonless endpoint was not closed on disconnect recovery");
});

test("runtime-stopped restart recovery refuses to relabel the old runtime as its replacement", async () => {
  const value = fixture();
  const remote = await value.manager.ensureReady("devbox") as FakeEndpoint;
  const identity = await remote.runtimeIdentity();
  assert.ok(identity);
  let publications = 0;
  value.manager.onEndpoint(() => { publications += 1; });

  await assert.rejects(value.manager.recoverRestart("devbox", "runtime_stopped", identity), /replacement|identity changed/u);
  assert.equal(publications, 0);
  assert.equal(remote.connectionCloses, 1);
  assert.equal(remote.state, "stopped");
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

test("restart checkpoints and reopens admission before publishing its replacement", async () => {
  const first = new FakeEndpoint("devbox");
  const replacement = new FakeEndpoint("devbox");
  replacement.identityToken = "b".repeat(32);
  const { manager } = queuedFixture([first, replacement]);
  await manager.ensureReady("devbox");
  let runtimeStartedCheckpointed = false;
  const publications: Array<{ automatic: boolean; checkpointed: boolean }> = [];
  const admissions: Array<Promise<boolean>> = [];
  manager.onEndpoint(() => {
    publications.push({
      automatic: manager.desiredState("devbox") === "automatic",
      checkpointed: runtimeStartedCheckpointed,
    });
    admissions.push(manager.withReadyWorkLease("devbox", async () => true).catch(() => false));
  });

  await manager.restart("devbox", (value) => {
    const phase = (value as { phase?: string }).phase;
    if (phase === "runtime_started") runtimeStartedCheckpointed = true;
    assert.equal(publications.length, 0, "replacement must remain unpublished through every checkpoint");
  });

  assert.deepEqual(publications, [{ automatic: true, checkpointed: true }]);
  assert.deepEqual(await Promise.all(admissions), [true]);
  assert.equal(manager.endpointGeneration("devbox").endpoint, replacement);
});

test("restart after disconnect starts a fresh runtime without proving stopped threads idle", async () => {
  const first = new FakeEndpoint("devbox");
  const replacement = new FakeEndpoint("devbox");
  replacement.identityToken = "b".repeat(32);
  const { manager, candidateCount } = queuedFixture([first, replacement], ["thread-1"]);
  await manager.ensureReady("devbox");
  await manager.disconnect("devbox");
  const checkpoints: unknown[] = [];

  await manager.restart("devbox", (checkpoint) => { checkpoints.push(checkpoint); });

  assert.equal(candidateCount(), 2);
  assert.equal(first.runtimeStops, 1);
  assert.equal(replacement.starts, 1);
  assert.equal(replacement.state, "ready");
  assert.deepEqual(replacement.requests, [], "a stopped endpoint has no live thread state to prove");
  assert.deepEqual(checkpoints, [{
    phase: "runtime_started",
    identity: { kind: "ssh", token: "b".repeat(32), pid: 10, linuxStartTime: "20", processGroupId: 10 },
  }]);
  assert.equal(manager.desiredState("devbox"), "automatic");
  assert.equal(manager.endpointGeneration("devbox").endpoint, replacement);
});

test("restart recovery validates stopped and started checkpoint identities before publication", async () => {
  const stoppedIdentity = { kind: "ssh" as const, token: "a".repeat(32), pid: 10, linuxStartTime: "20", processGroupId: 10 };

  const wrongReplacement = new FakeEndpoint("devbox");
  const stoppedRecovery = queuedFixture([wrongReplacement]);
  let stoppedPublications = 0;
  stoppedRecovery.manager.onEndpoint(() => { stoppedPublications += 1; });
  await assert.rejects(
    stoppedRecovery.manager.recoverRestart("devbox", "runtime_stopped", stoppedIdentity),
    /replacement|identity/u,
  );
  assert.equal(stoppedPublications, 0);

  const wrongStarted = new FakeEndpoint("devbox");
  wrongStarted.identityToken = "b".repeat(32);
  const startedRecovery = queuedFixture([wrongStarted]);
  let startedPublications = 0;
  startedRecovery.manager.onEndpoint(() => { startedPublications += 1; });
  await assert.rejects(
    startedRecovery.manager.recoverRestart("devbox", "runtime_started", stoppedIdentity),
    /identity changed/u,
  );
  assert.equal(startedPublications, 0);
});

test("temporary disconnect proof activation is never published", async () => {
  const remote = new FakeEndpoint("devbox");
  const { manager } = queuedFixture([remote], ["thread-1"]);
  const identity = await remote.runtimeIdentity();
  assert.ok(identity);
  let publications = 0;
  manager.onEndpoint(() => { publications += 1; });

  await manager.recoverDisconnect("devbox", "draining", identity);

  assert.equal(publications, 0);
  assert.equal(remote.starts, 1);
  assert.equal(remote.runtimeStops, 1);
  assert.equal(manager.desiredState("devbox"), "disconnected");
});

test("failed idle proof reopens and republishes one retained ready target", async () => {
  const remote = new FakeEndpoint("devbox");
  const { manager } = queuedFixture([remote], ["thread-1"]);
  await manager.ensureReady("devbox");
  const identity = await remote.runtimeIdentity();
  assert.ok(identity);
  remote.state = "unavailable";
  remote.threadStatus = "active";
  const publicationStates: string[] = [];
  const admissions: Array<Promise<boolean>> = [];
  manager.onEndpoint(() => {
    publicationStates.push(manager.desiredState("devbox"));
    admissions.push(manager.withReadyWorkLease("devbox", async () => true).catch(() => false));
  });

  await assert.rejects(manager.recoverDisconnect("devbox", "draining", identity), /not idle/u);

  assert.deepEqual(publicationStates, ["automatic"]);
  assert.deepEqual(await Promise.all(admissions), [true]);
  assert.equal(manager.endpointGeneration("devbox").endpoint, remote);
});

test("replacement readiness lost after checkpoint is cleaned before admission reopens", async () => {
  const first = new FakeEndpoint("devbox");
  const replacement = new FakeEndpoint("devbox");
  replacement.identityToken = "b".repeat(32);
  const { manager } = queuedFixture([first, replacement]);
  await manager.ensureReady("devbox");
  let checkpointed = false;
  replacement.onRuntimeIdentity = () => { replacement.state = "unavailable"; };
  const publications: string[] = [];
  manager.onEndpoint(() => { publications.push(manager.desiredState("devbox")); });

  await assert.rejects(manager.restart("devbox", (value) => {
    if ((value as { phase?: string }).phase === "runtime_started") checkpointed = true;
  }), (error: unknown) => error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE");

  assert.equal(checkpointed, true);
  assert.deepEqual(publications, []);
  assert.equal(replacement.connectionCloses, 1);
  assert.equal(manager.desiredState("devbox"), "automatic");
});

test("a microtask cannot invalidate a checkpointed replacement between readiness check and publication", async () => {
  const first = new FakeEndpoint("devbox");
  const replacement = new FakeEndpoint("devbox");
  replacement.identityToken = "b".repeat(32);
  const { manager } = queuedFixture([first, replacement]);
  await manager.ensureReady("devbox");
  const publications: Array<{ state: string; desired: string }> = [];
  manager.onEndpoint((endpoint) => {
    publications.push({ state: endpoint.state, desired: manager.desiredState("devbox") });
  });

  await manager.restart("devbox", (value) => {
    if ((value as { phase?: string }).phase === "runtime_started") {
      queueMicrotask(() => { replacement.state = "unavailable"; });
    }
  });
  await Promise.resolve();

  assert.deepEqual(publications, [{ state: "ready", desired: "automatic" }]);
  assert.equal(replacement.connectionCloses, 0);
  assert.equal(replacement.state, "unavailable");
  assert.equal(manager.desiredState("devbox"), "automatic");
});

test("local restart checkpoint failure closes the unpublished replacement before reopening", async () => {
  const value = fixture();
  value.local.rotateIdentityOnStop = true;
  await value.manager.ensureReady("local");
  let publications = 0;
  value.manager.onEndpoint(() => { publications += 1; });

  await assert.rejects(value.manager.restart("local", (checkpoint) => {
    if ((checkpoint as { phase?: string }).phase === "runtime_started") throw new Error("checkpoint failed");
  }), /checkpoint failed/u);

  assert.equal(publications, 0);
  assert.equal(value.local.connectionCloses, 1);
  assert.equal(value.local.state, "stopped");
  assert.equal(value.manager.desiredState("local"), "automatic");
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

test("a builtin (e.g. local Claude) endpoint resolves through leased mutations without the catalog", async () => {
  const local = new FakeEndpoint("local");
  const claude = new FakeEndpoint("claude-local");
  let requiredCatalog = false;
  const manager = new EndpointManager({
    localEndpoint: local,
    builtinEndpoints: [claude],
    catalog: {
      reload: async () => undefined,
      require: (id: string) => { requiredCatalog = true; throw new AppError("ENDPOINT_UNAVAILABLE", `unknown endpoint: ${id}`); },
    },
    createRemote: async () => { throw new Error("builtin must not go through createRemote"); },
    hasIdentityReferences: () => false,
    managedThreadIds: () => [],
  });

  // The leased session-mutation path (create/send/set_goal all use this) must resolve
  // the Claude endpoint instead of throwing "unknown endpoint" via catalog.require.
  const resolved = await manager.withWorkLease("claude-local", "session-mutation", async (endpoint) => endpoint);
  assert.equal(resolved, claude);
  assert.equal(claude.starts >= 1, true);
  assert.equal(requiredCatalog, false); // never consulted the ssh catalog for a builtin
});
