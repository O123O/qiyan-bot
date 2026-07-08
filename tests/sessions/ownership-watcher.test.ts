import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { createBackgroundFailureReporter, createFailureCycle } from "../../src/core/background-failure-reporter.ts";
import type { EndpointWorkLease } from "../../src/endpoints/types.ts";
import { SessionRegistry } from "../../src/registry/session-registry.ts";
import {
  ExternalOwnershipMonitor,
  externalOwnershipEventPayload,
  type ExternalOwnershipCycleResult,
  type OwnershipMonitorTimers,
  SessionOwnershipWatcher,
} from "../../src/sessions/ownership-watcher.ts";

const MINUTE_MS = 60_000;

type ScheduledOwnershipCycle = {
  callback: () => void;
  handle: ReturnType<typeof setTimeout>;
  ms: number;
};

class FakeOwnershipTimers implements OwnershipMonitorTimers {
  readonly scheduled: ScheduledOwnershipCycle[] = [];
  readonly cleared: Array<ReturnType<typeof setTimeout>> = [];
  private nextHandle = 1;

  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const handle = this.nextHandle as unknown as ReturnType<typeof setTimeout>;
    this.nextHandle += 1;
    this.scheduled.push({ callback, handle, ms });
    return handle;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.cleared.push(handle);
    const index = this.scheduled.findIndex((scheduled) => scheduled.handle === handle);
    if (index >= 0) this.scheduled.splice(index, 1);
  }

  takeNext(): ScheduledOwnershipCycle {
    const next = this.scheduled.shift();
    assert.ok(next);
    return next;
  }

  peekNext(): ScheduledOwnershipCycle {
    const next = this.scheduled[0];
    assert.ok(next);
    return next;
  }
}

function lease(endpointId: string): EndpointWorkLease {
  return { endpointId, lifecycleGeneration: 1, endpointGeneration: 2, leaseId: `lease-${endpointId}` };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

async function registryFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "qiyan-ownership-watcher-")));
  return SessionRegistry.open(join(root, "sessions.json"), {
    version: 3,
    assistant: { endpoint: "local", thread_id: "assistant", project_dir: root },
    sessions: {
      worker: { endpoint: "local", thread_id: "thread-1", project_dir: root, mapping_id: "mapping-1", lifecycle_state: "managed" },
    },
  });
}

test("an external turn is reported and automatically unadopted", async () => {
  const registry = await registryFixture();
  const removed: string[] = [];
  const notifications: string[] = [];
  const watcher = new SessionOwnershipWatcher(
    registry,
    { inspect: async () => ({ state: "external", turnId: "external-turn" }) },
    { unadopt: async (nickname) => {
      const session = registry.get(nickname)!;
      await registry.transition(nickname, session, "unadopting");
      await registry.removeIfMatch(nickname, session);
      removed.push(nickname);
    } },
    {
      onExternal: (incident) => { notifications.push(`pending:${incident.nickname}:${incident.turnId}`); },
      onReleased: (incident) => {
        assert.equal(registry.get(incident.nickname), undefined);
        notifications.push(`released:${incident.nickname}:${incident.turnId}`);
      },
    },
  );

  await watcher.reconcileEndpoint("local");

  assert.deepEqual(notifications, ["pending:worker:external-turn", "released:worker:external-turn"]);
  assert.deepEqual(removed, ["worker"]);
  assert.equal(registry.get("worker"), undefined);
});

test("a busy external turn remains pending without a false released notification", async () => {
  const registry = await registryFixture();
  const notifications: string[] = [];
  const watcher = new SessionOwnershipWatcher(
    registry,
    { inspect: async () => ({ state: "external", turnId: "external-turn" }) },
    { unadopt: async () => { throw new AppError("SESSION_BUSY", "external turn is active"); } },
    {
      onExternal: () => { notifications.push("pending"); },
      onReleased: () => { notifications.push("released"); },
    },
  );

  await watcher.reconcileEndpoint("local");

  assert.deepEqual(notifications, ["pending"]);
  assert.equal(registry.get("worker")?.lifecycle_state, "managed");
});

test("external ownership event payloads explicitly distinguish pending and completed release", () => {
  const incident = { nickname: "worker", endpoint: "local", thread_id: "thread-1", mapping_id: "mapping-1", turnId: "external-turn" };
  assert.deepEqual(externalOwnershipEventPayload(incident, "pending"), {
    event: "external_worker_turn_detected",
    releaseStatus: "pending",
    nickname: "worker",
    mappingId: "mapping-1",
    turnId: "external-turn",
  });
  assert.deepEqual(externalOwnershipEventPayload(incident, "completed"), {
    event: "external_worker_session_released",
    releaseStatus: "completed",
    nickname: "worker",
    mappingId: "mapping-1",
    turnId: "external-turn",
  });
});

test("ownership inspection is serialized with session dispatch", async () => {
  const registry = await registryFixture();
  const seen: string[] = [];
  const watcher = new SessionOwnershipWatcher(
    registry,
    { inspect: async () => { seen.push("inspect"); return { state: "owned" }; } },
    { unadopt: async () => undefined },
    { onExternal: async () => undefined, onReleased: async () => undefined },
    { run: async (endpointId, threadId, inspect) => {
      seen.push(`gate:${endpointId}:${threadId}:start`);
      const result = await inspect();
      seen.push(`gate:${endpointId}:${threadId}:end`);
      return result;
    } },
  );

  await watcher.reconcileEndpoint("local");

  assert.deepEqual(seen, ["gate:local:thread-1:start", "inspect", "gate:local:thread-1:end"]);
});

test("an unavailable mapping without an initialized rollout guard is isolated", async () => {
  const registry = await registryFixture();
  let inspected = false;
  const watcher = new SessionOwnershipWatcher(
    registry,
    { inspect: async () => { inspected = true; throw new Error("guard is not initialized"); } },
    { unadopt: async () => undefined },
    { onExternal: async () => undefined, onReleased: async () => undefined, isInspectable: () => false },
  );

  await watcher.reconcileEndpoint("local");

  assert.equal(inspected, false);
});

test("ownership detection and release propagate one existing endpoint lease", async () => {
  const registry = await registryFixture();
  const existingLease = lease("local");
  const inspections: Array<EndpointWorkLease | undefined> = [];
  const removals: Array<EndpointWorkLease | undefined> = [];
  const watcher = new SessionOwnershipWatcher(
    registry,
    { inspect: async (_identity, actualLease) => {
      inspections.push(actualLease);
      return { state: "external", turnId: "external-turn" };
    } },
    { unadopt: async (_nickname, _checkpoint, actualLease) => { removals.push(actualLease); } },
    { onExternal: async () => undefined, onReleased: async () => undefined },
  );

  await watcher.reconcileEndpoint("local", existingLease);

  assert.deepEqual(inspections, [existingLease]);
  assert.deepEqual(removals, [existingLease]);
});

test("the external monitor reuses one lease for pending and newly detected release", async () => {
  const timers = new FakeOwnershipTimers();
  const existingLease = lease("devbox");
  const pendingIncident = {
    nickname: "worker", endpoint: "devbox", thread_id: "thread-1", mapping_id: "mapping-1", turnId: "external-turn",
  };
  const seen: string[] = [];
  let acquisitions = 0;
  let completeCycle: (() => void) | undefined;
  const cycleCompleted = new Promise<void>((resolve) => { completeCycle = resolve; });
  const monitor = new ExternalOwnershipMonitor({
    endpointIds: () => ["devbox"],
    pending: (endpointId) => {
      assert.equal(endpointId, "devbox");
      return [pendingIncident];
    },
    withReadyEndpointWorkLease: async (endpointId, run) => {
      acquisitions += 1;
      assert.equal(endpointId, "devbox");
      seen.push("lease");
      return run(existingLease);
    },
    resumeRemoval: async (incident, actualLease) => {
      assert.equal(incident, pendingIncident);
      assert.equal(actualLease, existingLease);
      seen.push("resume");
    },
    inspectAndRelease: async (endpointId, actualLease) => {
      assert.equal(endpointId, "devbox");
      assert.equal(actualLease, existingLease);
      seen.push("inspect-release");
    },
    onCycle: (results) => {
      assert.deepEqual(results, [{ endpointId: "devbox", outcome: "succeeded" }]);
      seen.push("cycle");
      completeCycle?.();
    },
  }, timers);

  await monitor.start();
  assert.deepEqual(seen, [], "startup reconciliation already performed the initial scan");
  const scheduled = timers.takeNext();
  assert.equal(scheduled.ms, MINUTE_MS);
  scheduled.callback();
  await cycleCompleted;
  await nextTurn();

  assert.equal(acquisitions, 1);
  assert.deepEqual(seen, ["lease", "resume", "inspect-release", "cycle"]);
  assert.equal(timers.scheduled.length, 1);
  await monitor.stop();
});

test("one endpoint failure does not block another and cycles never overlap", async () => {
  const timers = new FakeOwnershipTimers();
  let releaseFailure: (() => void) | undefined;
  const failureBarrier = new Promise<void>((resolve) => { releaseFailure = resolve; });
  const calls: string[] = [];
  let completed: ((results: readonly ExternalOwnershipCycleResult[]) => void) | undefined;
  const cycleCompleted = new Promise<readonly ExternalOwnershipCycleResult[]>((resolve) => { completed = resolve; });
  const monitor = new ExternalOwnershipMonitor({
    endpointIds: () => ["broken", "healthy"],
    pending: () => [],
    withReadyEndpointWorkLease: async (endpointId, run) => {
      calls.push(`lease:${endpointId}`);
      if (endpointId === "broken") {
        await failureBarrier;
        throw new Error("endpoint failed");
      }
      return run(lease(endpointId));
    },
    resumeRemoval: async () => undefined,
    inspectAndRelease: async (endpointId) => { calls.push(`inspect:${endpointId}`); },
    onCycle: (results) => { completed?.(results); },
  }, timers);

  await monitor.start();
  const scheduled = timers.takeNext();
  scheduled.callback();
  scheduled.callback();
  await nextTurn();
  assert.deepEqual(calls, ["lease:broken", "lease:healthy", "inspect:healthy"]);

  releaseFailure?.();
  assert.deepEqual(await cycleCompleted, [
    { endpointId: "broken", outcome: "failed" },
    { endpointId: "healthy", outcome: "succeeded" },
  ]);
  await nextTurn();
  assert.deepEqual(calls, ["lease:broken", "lease:healthy", "inspect:healthy"], "a repeated timer callback cannot overlap the active cycle");
  assert.equal(timers.scheduled.length, 1);
  await monitor.stop();
});

test("an unavailable endpoint is inconclusive and the ownership tick does not activate it", async () => {
  const timers = new FakeOwnershipTimers();
  let leaseAttempts = 0;
  let removalAttempts = 0;
  let inspectionAttempts = 0;
  let completeCycle: ((results: readonly ExternalOwnershipCycleResult[]) => void) | undefined;
  const cycleCompleted = new Promise<readonly ExternalOwnershipCycleResult[]>((resolve) => { completeCycle = resolve; });
  const monitor = new ExternalOwnershipMonitor({
    endpointIds: () => ["pending-only"],
    pending: () => [{
      nickname: "worker", endpoint: "pending-only", thread_id: "thread-1", mapping_id: "mapping-1", turnId: "external-turn",
    }],
    withReadyEndpointWorkLease: async () => {
      leaseAttempts += 1;
      throw new AppError("ENDPOINT_UNAVAILABLE", "endpoint is unavailable");
    },
    resumeRemoval: async () => { removalAttempts += 1; },
    inspectAndRelease: async () => { inspectionAttempts += 1; },
    onCycle: (results) => { completeCycle?.(results); },
  }, timers);

  await monitor.start();
  timers.takeNext().callback();
  assert.deepEqual(await cycleCompleted, [{ endpointId: "pending-only", outcome: "inconclusive" }]);
  assert.equal(leaseAttempts, 1);
  assert.equal(removalAttempts, 0);
  assert.equal(inspectionAttempts, 0);
  await monitor.stop();
});

test("an endpoint-unavailable error after ready-lease admission is a failed cycle", async (context) => {
  for (const stage of ["resume", "inspect"] as const) await context.test(stage, async () => {
    const timers = new FakeOwnershipTimers();
    const pendingIncident = {
      nickname: "worker", endpoint: "devbox", thread_id: "thread-1", mapping_id: "mapping-1", turnId: "external-turn",
    };
    let completeCycle: ((results: readonly ExternalOwnershipCycleResult[]) => void) | undefined;
    const cycleCompleted = new Promise<readonly ExternalOwnershipCycleResult[]>((resolve) => { completeCycle = resolve; });
    const monitor = new ExternalOwnershipMonitor({
      endpointIds: () => ["devbox"],
      pending: () => stage === "resume" ? [pendingIncident] : [],
      withReadyEndpointWorkLease: async (endpointId, run) => run(lease(endpointId)),
      resumeRemoval: async () => {
        if (stage === "resume") throw new AppError("ENDPOINT_UNAVAILABLE", "admitted removal failed");
      },
      inspectAndRelease: async () => {
        if (stage === "inspect") throw new AppError("ENDPOINT_UNAVAILABLE", "admitted inspection failed");
      },
      onCycle: (results) => { completeCycle?.(results); },
    }, timers);

    await monitor.start();
    timers.takeNext().callback();
    assert.deepEqual(await cycleCompleted, [{ endpointId: "devbox", outcome: "failed" }]);
    await monitor.stop();
  });
});

test("candidate enumeration failure is fixed, privacy-safe, retryable, and advances degradation", async () => {
  const timers = new FakeOwnershipTimers();
  const warnings: string[] = [];
  const observed: unknown[] = [];
  const reporter = createBackgroundFailureReporter({
    runId: "ownership-candidates",
    onOperational: () => undefined,
    onDurable: (notice) => { warnings.push(notice.id); },
  });
  let enumerationFails = true;
  const monitor = new ExternalOwnershipMonitor({
    endpointIds: () => {
      if (enumerationFails) throw new Error("persisted-payload-must-not-escape");
      return [];
    },
    pending: () => [],
    withReadyEndpointWorkLease: async (_endpointId, run) => run(lease("unused")),
    resumeRemoval: async () => undefined,
    inspectAndRelease: async () => undefined,
    onCycle: (results) => {
      observed.push(results);
      const cycle = createFailureCycle({
        onFailed: () => reporter.report("external session ownership detection is degraded", { episode: "external-ownership", notifyAfter: 3 }),
        onResolved: () => reporter.resolve("external-ownership"),
      });
      for (const result of results) cycle[result.outcome]();
      cycle.finish();
    },
  }, timers);
  const runCycle = async () => {
    timers.takeNext().callback();
    await nextTurn();
  };

  await monitor.start();
  await runCycle();
  await runCycle();
  assert.deepEqual(warnings, []);
  await runCycle();
  await runCycle();
  assert.deepEqual(warnings, ["background-failure:ownership-candidates:1"]);
  assert.deepEqual(observed.slice(0, 4), Array.from({ length: 4 }, () => [
    { component: "candidate_enumeration", outcome: "failed" },
  ]));
  assert.equal(JSON.stringify(observed).includes("persisted-payload-must-not-escape"), false);

  enumerationFails = false;
  await runCycle();
  assert.deepEqual(observed.at(-1), []);
  enumerationFails = true;
  await runCycle();
  await runCycle();
  await runCycle();
  assert.deepEqual(warnings, [
    "background-failure:ownership-candidates:1",
    "background-failure:ownership-candidates:2",
  ]);
  await monitor.stop();
});

test("stop cancels the ownership clock and awaits its in-flight cycle", async () => {
  const timers = new FakeOwnershipTimers();
  let entered: (() => void) | undefined;
  const cycleEntered = new Promise<void>((resolve) => { entered = resolve; });
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const monitor = new ExternalOwnershipMonitor({
    endpointIds: () => ["devbox"],
    pending: () => [{
      nickname: "worker", endpoint: "devbox", thread_id: "thread-1", mapping_id: "mapping-1", turnId: "external-turn",
    }],
    withReadyEndpointWorkLease: async (endpointId, run) => run(lease(endpointId)),
    resumeRemoval: async () => { entered?.(); await barrier; },
    inspectAndRelease: async () => undefined,
    onCycle: () => undefined,
  }, timers);

  await monitor.start();
  timers.takeNext().callback();
  await cycleEntered;
  let stopped = false;
  const stopping = monitor.stop().then(() => { stopped = true; });
  await nextTurn();
  assert.equal(stopped, false);

  release?.();
  await stopping;
  assert.equal(timers.scheduled.length, 0);
});

test("a captured ownership callback is inert after stop", async () => {
  const timers = new FakeOwnershipTimers();
  let cycles = 0;
  const monitor = new ExternalOwnershipMonitor({
    endpointIds: () => [],
    pending: () => [],
    withReadyEndpointWorkLease: async (_endpointId, run) => run(lease("unused")),
    resumeRemoval: async () => undefined,
    inspectAndRelease: async () => undefined,
    onCycle: () => { cycles += 1; },
  }, timers);

  await monitor.start();
  const stale = timers.peekNext();
  await monitor.stop();
  stale.callback();
  await nextTurn();

  assert.equal(cycles, 0);
  assert.equal(timers.scheduled.length, 0);
});

test("an old-generation callback cannot disturb a restarted ownership timer", async () => {
  const timers = new FakeOwnershipTimers();
  let cycles = 0;
  const monitor = new ExternalOwnershipMonitor({
    endpointIds: () => [],
    pending: () => [],
    withReadyEndpointWorkLease: async (_endpointId, run) => run(lease("unused")),
    resumeRemoval: async () => undefined,
    inspectAndRelease: async () => undefined,
    onCycle: () => { cycles += 1; },
  }, timers);

  await monitor.start();
  const stale = timers.peekNext();
  await monitor.stop();
  await monitor.start();
  const current = timers.peekNext();

  stale.callback();
  await nextTurn();
  assert.equal(cycles, 0);
  assert.deepEqual(timers.scheduled.map(({ handle }) => handle), [current.handle]);

  timers.takeNext().callback();
  await nextTurn();
  assert.equal(cycles, 1);
  assert.equal(timers.scheduled.length, 1);
  await monitor.stop();
});

test("restart waits for an old ownership cycle to drain and schedules one new generation", async () => {
  const timers = new FakeOwnershipTimers();
  let entered: (() => void) | undefined;
  const oldCycleEntered = new Promise<void>((resolve) => { entered = resolve; });
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let cycles = 0;
  let inspections = 0;
  const monitor = new ExternalOwnershipMonitor({
    endpointIds: () => ["devbox"],
    pending: () => [],
    withReadyEndpointWorkLease: async (endpointId, run) => run(lease(endpointId)),
    resumeRemoval: async () => undefined,
    inspectAndRelease: async () => {
      inspections += 1;
      if (inspections === 1) { entered?.(); await barrier; }
    },
    onCycle: () => { cycles += 1; },
  }, timers);

  await monitor.start();
  const oldCallback = timers.takeNext();
  oldCallback.callback();
  await oldCycleEntered;
  const stopping = monitor.stop();
  const restarting = monitor.start();
  await nextTurn();
  assert.equal(timers.scheduled.length, 0);
  oldCallback.callback();
  await nextTurn();
  assert.equal(inspections, 1);

  release?.();
  await Promise.all([stopping, restarting]);
  assert.equal(cycles, 1);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.peekNext().ms, MINUTE_MS);

  timers.takeNext().callback();
  await nextTurn();
  assert.equal(cycles, 2);
  assert.equal(inspections, 2);
  assert.equal(timers.scheduled.length, 1);
  await monitor.stop();
});

test("the degradation episode warns after three failed cycles and resets after success", async () => {
  const timers = new FakeOwnershipTimers();
  const warnings: string[] = [];
  const reporter = createBackgroundFailureReporter({
    runId: "ownership-monitor",
    onOperational: () => undefined,
    onDurable: (notice) => { warnings.push(notice.id); },
  });
  let shouldFail = true;
  let completedCycles = 0;
  const cycleWaiters = new Map<number, () => void>();
  const monitor = new ExternalOwnershipMonitor({
    endpointIds: () => ["devbox"],
    pending: () => [],
    withReadyEndpointWorkLease: async (endpointId, run) => {
      if (shouldFail) throw new Error("inspection failed");
      return run(lease(endpointId));
    },
    resumeRemoval: async () => undefined,
    inspectAndRelease: async () => undefined,
    onCycle: (results) => {
      const cycle = createFailureCycle({
        onFailed: () => reporter.report("external session ownership detection is degraded", { episode: "external-ownership", notifyAfter: 3 }),
        onResolved: () => reporter.resolve("external-ownership"),
      });
      for (const result of results) cycle[result.outcome]();
      cycle.finish();
      completedCycles += 1;
      cycleWaiters.get(completedCycles)?.();
    },
  }, timers);
  const runCycle = async () => {
    const target = completedCycles + 1;
    const completed = new Promise<void>((resolve) => { cycleWaiters.set(target, resolve); });
    const scheduled = timers.takeNext();
    assert.equal(scheduled.ms, MINUTE_MS);
    scheduled.callback();
    await completed;
    cycleWaiters.delete(target);
    await nextTurn();
  };

  await monitor.start();
  await runCycle();
  await runCycle();
  assert.deepEqual(warnings, []);
  await runCycle();
  await runCycle();
  assert.deepEqual(warnings, ["background-failure:ownership-monitor:1"]);

  shouldFail = false;
  await runCycle();
  shouldFail = true;
  await runCycle();
  await runCycle();
  await runCycle();
  assert.deepEqual(warnings, [
    "background-failure:ownership-monitor:1",
    "background-failure:ownership-monitor:2",
  ]);
  await monitor.stop();
});
