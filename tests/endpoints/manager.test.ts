import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { EndpointManager } from "../../src/endpoints/manager.ts";
import type { PermissionBlockedEvent } from "../../src/app-server/managed-endpoint.ts";
import type { EndpointLossKind, ManagedAppServerEndpoint, RuntimeIdentity } from "../../src/endpoints/types.ts";
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
  threadStatus: "notLoaded" | "idle" | "active" | "systemError" = "idle";
  requestError: Error | undefined;
  startGate: Promise<void> | undefined;
  onStart: (() => void) | undefined;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  onRuntimeIdentity: (() => void) | undefined;
  private readonly events = new EventEmitter();
  constructor(readonly id: string) {}
  async start() {
    this.starts += 1;
    this.onStart?.();
    await this.startGate;
    if (this.failStart) throw this.startError ?? new Error("offline");
    this.state = "ready";
    this.events.emit("ready");
  }
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

function queuedFixture(
  candidates: FakeEndpoint[],
  managedThreadIds: readonly string[] = [],
  cleanupTimeoutMs?: number,
) {
  const local = new FakeEndpoint("local");
  const endpoints = new Map<string, FakeEndpoint>([["local", local]]);
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
      endpoints.set(endpoint.id, endpoint);
      return { endpoint };
    },
    hasIdentityReferences: () => true,
    managedThreadIds: () => managedThreadIds,
    managedThreadState: (id, _threadId, generation) => {
      const status = endpoints.get(id)?.threadStatus;
      return {
        availability: "ready",
        status: status === "notLoaded" ? "idle"
          : status === "systemError" ? "error"
            : status ?? "unknown",
        endpointGeneration: generation,
      };
    },
    ...cleanupTimeoutMs === undefined ? {} : { cleanupTimeoutMs },
  });
  return { manager, local, candidateCount: () => index };
}

function fixture(options: { onRecoveryPaused?(id: string, recovery: { reason: "ssh_fresh_channel_unavailable"; sshHost: string }): boolean } = {}) {
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
    managedThreadState: (id, _threadId, generation) => {
      const endpoint = id === "local" ? local : remotes.get(id);
      if (!endpoint) return undefined;
      return {
        availability: "ready",
        status: endpoint.threadStatus === "notLoaded" ? "idle"
          : endpoint.threadStatus === "systemError" ? "error"
            : endpoint.threadStatus,
        endpointGeneration: generation,
      };
    },
    ...(options.onRecoveryPaused ? { onRecoveryPaused: options.onRecoveryPaused } : {}),
  });
  return { manager, local, remotes, commits, reloads: () => reloads };
}

function freshSshChannelUnavailable(sshHost = "prenyx"): AppError {
  return new AppError("ENDPOINT_UNAVAILABLE", "SSH cannot open a fresh remote session", {
    recovery: "ssh_fresh_channel_unavailable",
    sshHost,
  });
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

test("a fresh-channel activation failure pauses retries, notifies once, and re-arms after recovery", async () => {
  const local = new FakeEndpoint("local");
  const remote = new FakeEndpoint("prenyx-codex");
  remote.failStart = true;
  remote.startError = freshSshChannelUnavailable();
  const scheduled: Array<{ delay: number; run: () => void }> = [];
  const notifications: Array<{ id: string; reason: string; sshHost: string }> = [];
  const manager = new EndpointManager({
    localEndpoint: local,
    catalog: { reload: async () => undefined, require: () => ({ id: remote.id, provider: "codex" as const, transport: "ssh" as const, host: "prenyx", projectsRoot: "~/qiyan-projects" }) },
    createRemote: async () => ({ endpoint: remote }),
    hasIdentityReferences: () => true,
    managedThreadIds: () => [],
    schedule: (delay, run) => { scheduled.push({ delay, run }); return { cancel: () => undefined }; },
    onRecoveryPaused: (id, recovery) => { notifications.push({ id, ...recovery }); return true; },
  });
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };

  await assert.rejects(manager.ensureReady(remote.id), (error) => error === remote.startError);
  await settle();
  assert.equal(scheduled.length, 0, "classified activation failures do not start the retry ramp");
  assert.deepEqual(notifications, [{ id: remote.id, reason: "ssh_fresh_channel_unavailable", sshHost: "prenyx" }]);

  await assert.rejects(manager.ensureReady(remote.id), (error) => error === remote.startError);
  await settle();
  assert.equal(remote.starts, 2, "direct use still makes one recovery attempt");
  assert.equal(scheduled.length, 0);
  assert.equal(notifications.length, 1, "a prepared notice is latched for the incident");

  remote.failStart = false;
  await manager.ensureReady(remote.id);
  remote.failStart = true;
  remote.fail("connection-lost");
  await settle();
  assert.equal(scheduled.length, 1, "successful publication clears the pause and restores normal retries");
  scheduled.shift()!.run();
  await settle();
  assert.equal(scheduled.length, 0, "the later classified loss pauses before another timer is installed");
  assert.equal(notifications.length, 2, "a fresh incident after recovery notifies again");
});

test("a loss-triggered retry pauses immediately when activation reports a fresh-channel failure", async () => {
  const local = new FakeEndpoint("local");
  const remote = new FakeEndpoint("prenyx-codex");
  const scheduled: Array<() => void> = [];
  let notifications = 0;
  const manager = new EndpointManager({
    localEndpoint: local,
    catalog: { reload: async () => undefined, require: () => ({ id: remote.id, provider: "codex" as const, transport: "ssh" as const, host: "prenyx", projectsRoot: "~/qiyan-projects" }) },
    createRemote: async () => ({ endpoint: remote }),
    hasIdentityReferences: () => true,
    managedThreadIds: () => [],
    schedule: (_delay, run) => { scheduled.push(run); return { cancel: () => undefined }; },
    onRecoveryPaused: () => { notifications += 1; return true; },
  });
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };

  await manager.ensureReady(remote.id);
  remote.failStart = true;
  remote.startError = freshSshChannelUnavailable();
  remote.fail("runtime-lost");
  await settle();
  assert.equal(scheduled.length, 1);
  scheduled.shift()!();
  await settle();
  assert.equal(notifications, 1);
  assert.equal(scheduled.length, 0, "the classified retry failure does not recursively reschedule");
});

// A host waiting on a person must still be retried, on the backoff's slow cadence: the
// pause is a notify-once marker, not a stop. Latching it meant nothing retried after the
// person acted, and since only a successful publish clears the pause, the endpoint stayed
// unreachable to QiYan long after it was reachable again.
test("a paused endpoint keeps retrying so it can recover once the human acts", async () => {
  const local = new FakeEndpoint("local");
  const remote = new FakeEndpoint("prenyx-codex");
  let resolveReferences!: (value: boolean) => void;
  const pendingReferences = new Promise<boolean>((resolve) => { resolveReferences = resolve; });
  let referenceCalls = 0;
  const scheduled: Array<() => void> = [];
  const manager = new EndpointManager({
    localEndpoint: local,
    catalog: { reload: async () => undefined, require: () => ({ id: remote.id, provider: "codex" as const, transport: "ssh" as const, host: "prenyx", projectsRoot: "~/qiyan-projects" }) },
    createRemote: async () => ({ endpoint: remote }),
    hasIdentityReferences: () => ++referenceCalls === 2 ? pendingReferences : true,
    managedThreadIds: () => [],
    schedule: (_delay, run) => { scheduled.push(run); return { cancel: () => undefined }; },
    onRecoveryPaused: () => true,
  });
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };

  await manager.ensureReady(remote.id);
  remote.fail("connection-lost");
  await settle();
  assert.equal(referenceCalls, 2, "loss-triggered scheduling is waiting on its durable-reference check");

  remote.failStart = true;
  remote.startError = freshSshChannelUnavailable();
  await assert.rejects(manager.ensureReady(remote.id), (error) => error === remote.startError);
  resolveReferences(true);
  await settle();
  assert.ok(scheduled.length > 0, "a paused endpoint still has a retry armed");
});

test("notification preparation failure cannot alter the endpoint error and is retried only on direct use", async () => {
  const local = new FakeEndpoint("local");
  const remote = new FakeEndpoint("prenyx-codex");
  const failure = freshSshChannelUnavailable();
  remote.failStart = true;
  remote.startError = failure;
  const attempts: string[] = [];
  const scheduled: Array<() => void> = [];
  const manager = new EndpointManager({
    localEndpoint: local,
    catalog: { reload: async () => undefined, require: () => ({ id: remote.id, provider: "codex" as const, transport: "ssh" as const, host: "prenyx", projectsRoot: "~/qiyan-projects" }) },
    createRemote: async () => ({ endpoint: remote }),
    hasIdentityReferences: () => true,
    managedThreadIds: () => [],
    schedule: (_delay, run) => { scheduled.push(run); return { cancel: () => undefined }; },
    onRecoveryPaused: () => {
      attempts.push("prepare");
      if (attempts.length === 1) throw new Error("delivery database unavailable");
      return true;
    },
  });
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };

  await assert.rejects(manager.ensureReady(remote.id), (error) => error === failure);
  await settle();
  assert.deepEqual(attempts, ["prepare"]);
  assert.equal(scheduled.length, 0);

  await assert.rejects(manager.ensureReady(remote.id), (error) => error === failure);
  await assert.rejects(manager.ensureReady(remote.id), (error) => error === failure);
  await settle();
  assert.deepEqual(attempts, ["prepare", "prepare"], "a successful second preparation is latched");
  assert.equal(scheduled.length, 0);
});

test("a newer lifecycle publication wins over an older classified activation failure", async () => {
  const local = new FakeEndpoint("local");
  const current = new FakeEndpoint("devbox");
  const stale = new FakeEndpoint("devbox");
  stale.failStart = true;
  stale.startError = freshSshChannelUnavailable();
  let releaseStale!: () => void;
  stale.startGate = new Promise<void>((resolve) => { releaseStale = resolve; });
  const replacement = new FakeEndpoint("devbox");
  replacement.identityToken = "b".repeat(32);
  const candidates = [current, stale, replacement];
  const notifications: string[] = [];
  const scheduled: Array<() => void> = [];
  const manager = new EndpointManager({
    localEndpoint: local,
    catalog: { reload: async () => undefined, require: () => ({ id: "devbox", provider: "codex" as const, transport: "ssh" as const, host: "prenyx", projectsRoot: "~/qiyan-projects" }) },
    createRemote: async () => {
      const endpoint = candidates.shift();
      assert.ok(endpoint);
      return { endpoint };
    },
    hasIdentityReferences: () => false,
    managedThreadIds: () => [],
    schedule: (_delay, run) => { scheduled.push(run); return { cancel: () => undefined }; },
    onRecoveryPaused: (id) => { notifications.push(id); return true; },
  });

  await manager.ensureReady("devbox");
  current.fail("connection-lost");
  const staleAttempt = manager.ensureReady("devbox");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stale.starts, 1);

  await manager.restart("devbox");
  assert.equal(manager.endpointGeneration("devbox").endpoint, replacement);
  releaseStale();
  await assert.rejects(staleAttempt, (error) => error === stale.startError);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(notifications, [], "the stale error cannot re-latch after the replacement publication");
  assert.equal(scheduled.length, 0);
  assert.equal(manager.endpointGeneration("devbox").endpoint.state, "ready");
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

test("only completed ready recovery resets reconnect backoff", async () => {
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
  scheduled.shift()!.run(); // transport reconnects and publishes, but owner recovery is not complete yet
  await settle();
  const generation = manager.endpointGeneration("offline");
  assert.equal(generation.endpoint.state, "ready");
  assert.equal(scheduled.length, 0);

  remote.failStart = true;
  remote.fail("connection-lost"); // recovery-stage failure: keep escalating instead of restarting at 5s
  await settle();
  assert.deepEqual(scheduled.map((item) => item.delay), [30_000]);

  remote.failStart = false;
  scheduled.shift()!.run();
  await settle();
  const recovered = manager.endpointGeneration("offline");
  assert.equal(manager.acknowledgeReadyRecovery("offline", recovered.generation), true);

  remote.failStart = true;
  remote.fail("connection-lost"); // a fresh outage after completed owner recovery
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

  // Cluster comes back: activation publishes, then completed owner recovery clears the latch.
  remote.failStart = false;
  await manager.ensureReady("offline");
  await settle();
  const recovered = manager.endpointGeneration("offline");
  assert.equal(recovered.endpoint.state, "ready");
  assert.equal(manager.acknowledgeReadyRecovery("offline", recovered.generation), true);
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

test("lifecycle idle proof fails closed on an error native state", async () => {
  const value = fixture();
  const remote = await value.manager.ensureReady("devbox") as FakeEndpoint;
  remote.threadStatus = "systemError";
  const shutdownsBefore = remote.runtimeStops;
  await assert.rejects(
    value.manager.disconnect("devbox"),
    // CONFLICT, not UNCERTAIN. The proof runs before the runtime is stopped and reopens the
    // endpoint untouched, so the outcome is not in doubt — and only a proven-no-effect code
    // lets the operation settle as failed. Reported as uncertain it stayed recoverable
    // forever, and an unresolved earlier operation fences the next lifecycle action, so a
    // worker whose status could not be read wedged every future restart of its endpoint.
    (error: unknown) => error instanceof AppError && error.code === "OPERATION_CONFLICT",
  );
  assert.equal(remote.runtimeStops, shutdownsBefore, "the runtime was never stopped");
});

test("lifecycle idle proof does not request native history", async () => {
  const value = fixture();
  const remote = await value.manager.ensureReady("devbox") as FakeEndpoint;

  await value.manager.disconnect("devbox");

  assert.deepEqual(remote.requests, []);
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

test("fresh-channel lifecycle recovery pauses and waits for an explicit endpoint-ready wake", async () => {
  const notifications: Array<{ id: string; sshHost: string }> = [];
  const value = fixture({
    onRecoveryPaused: (id, recovery) => { notifications.push({ id, sshHost: recovery.sshHost }); return true; },
  });
  const replacement = new FakeEndpoint("devbox");
  replacement.identityToken = "b".repeat(32);
  replacement.failStart = true;
  replacement.startError = freshSshChannelUnavailable();
  value.remotes.set("devbox", replacement);
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  let attempts = 0;
  const target = { policy: "endpoint_lifecycle", endpointId: "devbox" } as const;
  const loop = createOperationReconciliationLoop({
    isEndpointReady: () => replacement.state === "ready",
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
        const disposition = operationRecoveryFailureDisposition(error, target);
        return {
          outcome: {
            attempted: true,
            transientRetry: disposition === "retry",
            waitingForEndpoint: disposition === "wait_for_endpoint",
          },
          transientTargets: disposition === "retry" ? new Map([["restart", target]]) : new Map(),
        };
      }
    },
  });

  await loop.request();
  assert.equal(attempts, 1);
  assert.deepEqual(notifications, [{ id: "devbox", sshHost: "prenyx" }]);
  assert.equal(scheduled.length, 0, "operator-action failures never arm the lifecycle retry timer");

  replacement.failStart = false;
  await loop.endpointReady("devbox");
  assert.equal(attempts, 2, "an explicit ready edge retries the retained durable operation");
  assert.equal(replacement.state, "ready");
  await loop.stop();
});

test("an uncertain lifecycle idle proof is retained without a blind retry", async () => {
  const value = fixture();
  const remote = await value.manager.ensureReady("devbox") as FakeEndpoint;
  const identity = await remote.runtimeIdentity();
  assert.ok(identity?.kind === "ssh");
  remote.threadStatus = "systemError";
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
  assert.deepEqual(scheduled, []);
  assert.equal(attempts, 1);
  assert.equal(remote.runtimeStops, 0);
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

test("draining restart recovery accepts an already-running replacement identity", async () => {
  const stale = new FakeEndpoint("devbox");
  const replacement = new FakeEndpoint("devbox");
  const value = queuedFixture([stale, replacement]);
  const remote = await value.manager.ensureReady("devbox") as FakeEndpoint;
  const stopped = await stale.runtimeIdentity();
  assert.ok(stopped?.kind === "ssh");
  stale.identityToken = "b".repeat(32);
  replacement.identityToken = "b".repeat(32);
  replacement.onStart = () => {
    assert.equal(stale.connectionCloses, 1, "stale transport must close before the replacement connects");
  };
  const checkpoints: unknown[] = [];
  let publications = 0;
  value.manager.onEndpoint(() => { publications += 1; });

  await value.manager.recoverRestart(
    "devbox",
    "draining",
    stopped,
    (checkpoint) => checkpoints.push(checkpoint),
  );

  assert.deepEqual(checkpoints, [{
    phase: "runtime_started",
    identity: { ...stopped, token: "b".repeat(32) },
  }]);
  assert.equal(stale.runtimeStops, 0, "the replacement must not be stopped as though it were the old runtime");
  assert.equal(stale.connectionCloses, 1, "the stale RPC connection must be closed");
  assert.equal(replacement.starts, 1, "the replacement identity must be attested by a fresh RPC connection");
  assert.equal(publications, 1);
  assert.equal(value.manager.endpointGeneration("devbox").endpoint, replacement);
});

test("replacement recovery cleans an unpublished connection when its checkpoint fails", async () => {
  const stale = new FakeEndpoint("devbox");
  const replacement = new FakeEndpoint("devbox");
  const value = queuedFixture([stale, replacement]);
  await value.manager.ensureReady("devbox");
  const stopped = await stale.runtimeIdentity();
  assert.ok(stopped?.kind === "ssh");
  stale.identityToken = "b".repeat(32);
  replacement.identityToken = "b".repeat(32);
  let publications = 0;
  value.manager.onEndpoint(() => { publications += 1; });

  await assert.rejects(
    value.manager.recoverRestart("devbox", "draining", stopped, () => { throw new Error("checkpoint failed"); }),
    /checkpoint failed/u,
  );

  assert.equal(stale.connectionCloses, 1);
  assert.equal(replacement.connectionCloses, 1, "an uncheckpointed replacement must not remain connected");
  assert.equal(publications, 0);
  assert.equal(value.manager.endpointGeneration("devbox").endpoint, stale);
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

// These are different endpoints with independent locks and transports, so dialling them one at
// a time made startup the SUM of every remote handshake — and one slow or unreachable host
// delayed every endpoint queued behind it, which is how startup reached ~70s for the phase that
// does this. Nothing about the result may change: the unavailable set is still exact.
test("referenced endpoints are activated concurrently, not one after another", async () => {
  const first = new FakeEndpoint("devbox");
  const second = new FakeEndpoint("devbox2");
  const { manager } = queuedFixture([first, second]);
  // A barrier, so this cannot pass by accident: neither handshake completes until BOTH have
  // begun. Activated one at a time, the first would wait for a second start that can never
  // happen while it holds the loop — so serial activation does not merely run slower here, it
  // fails to finish at all.
  let bothStarted!: () => void;
  const started = new Promise<void>((resolve) => { bothStarted = resolve; });
  let begun = 0;
  const gate = Promise.race([
    started,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error("endpoints were activated serially")), 2_000)),
  ]);
  for (const endpoint of [first, second]) {
    endpoint.startGate = gate;
    endpoint.onStart = () => { if ((begun += 1) === 2) bothStarted(); };
  }
  second.failStart = true;
  second.startError = new Error("that host is down");

  const result = await manager.activateReferenced(["devbox", "devbox2"]);

  assert.equal(begun, 2);
  assert.deepEqual(result.unavailable, ["devbox2"], "and the failing endpoint is still reported exactly");
});

// An unreachable host costs its full connect timeout, and startup used to wait for it — 48s of
// a 70s startup, held for endpoints nobody was waiting on. The budget bounds the WAIT, not the
// work: a straggler keeps connecting and publishes when it lands, exactly as it would after a
// later loss, so nothing is lost by not waiting for it.
test("startup stops waiting for an endpoint that will not come up", async () => {
  const quick = new FakeEndpoint("devbox");
  const slow = new FakeEndpoint("devbox2");
  let releaseSlow!: () => void;
  slow.startGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const { manager } = queuedFixture([quick, slow]);

  const began = Date.now();
  const result = await manager.activateReferenced(["devbox", "devbox2"], 40);

  assert.ok(Date.now() - began < 2_000, "the budget expires instead of waiting for the slow host");
  assert.deepEqual(result.unavailable, ["devbox2"], "and an endpoint that is not ready is reported as such");
  assert.equal(manager.endpointGeneration("devbox").endpoint, quick, "the endpoint that answered is published");

  // The straggler is still connecting, and completes on its own afterwards.
  releaseSlow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(slow.starts, 1, "its handshake was never abandoned");
});

test("a close that never answers cannot leave the endpoint draining", async () => {
  const first = new FakeEndpoint("devbox");
  const abandoned = new FakeEndpoint("devbox");
  abandoned.identityToken = "b".repeat(32);
  let closes = 0;
  // A close that never answers: an SSH channel whose peer is gone accepts the request and
  // returns nothing. Awaiting it unbounded left the gate `draining` for good, which failed every
  // read of the endpoint's sessions AND refused the restart that was the only repair -- the
  // endpoint was locked out by the wreckage of its own last attempt.
  abandoned.closeConnection = async () => { closes += 1; await new Promise<never>(() => {}); };
  const spare = new FakeEndpoint("devbox");
  const { manager } = queuedFixture([first, abandoned, spare], [], 5);
  await manager.ensureReady("devbox");
  first.onRuntimeIdentity = () => { throw new Error("SSH process failed (exit 1)"); };

  await assert.rejects(manager.restart("devbox"), /exit 1/u);
  assert.equal(closes, 1, "the abandoned candidate is still discarded");
  assert.equal(manager.desiredState("devbox"), "automatic", "admission reopens once the discard is bounded out");
  // The lifecycle queue must be free too: a discard that blocked it wedged every later restart.
  await assert.rejects(manager.restart("devbox"), /exit 1/u);
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

test("an idle native view permits a guarded local restart without reading history", async () => {
  const { manager, local } = queuedFixture([], ["thread-1"]);
  local.rotateIdentityOnStop = true;
  await manager.ensureReady("local");
  local.threadStatus = "notLoaded";

  await manager.restart("local");

  assert.equal(local.runtimeStops, 1);
  assert.equal(local.state, "ready");
  assert.deepEqual(local.requests, []);
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

// The pause must not survive recovery: a successful publish clears it, so a later
// lifecycle fence does not still believe a human is required.
test("a successful activation clears the recovery pause", async () => {
  const local = new FakeEndpoint("local");
  const remote = new FakeEndpoint("prenyx-codex");
  const scheduled: Array<() => void> = [];
  const manager = new EndpointManager({
    localEndpoint: local,
    catalog: { reload: async () => undefined, require: () => ({ id: remote.id, provider: "codex" as const, transport: "ssh" as const, host: "prenyx", projectsRoot: "~/qiyan-projects" }) },
    createRemote: async () => ({ endpoint: remote }),
    hasIdentityReferences: () => true,
    managedThreadIds: () => [],
    schedule: (_delay, run) => { scheduled.push(run); return { cancel: () => undefined }; },
    onRecoveryPaused: () => true,
  });

  remote.failStart = true;
  remote.startError = freshSshChannelUnavailable();
  await assert.rejects(manager.ensureReady(remote.id));
  assert.equal(manager.awaitingAuthentication(remote.id), true, "the human-required state is recorded");

  remote.failStart = false;
  await manager.ensureReady(remote.id);
  assert.equal(manager.awaitingAuthentication(remote.id), false, "and cleared once it comes back");
});
