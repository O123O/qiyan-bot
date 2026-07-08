import assert from "node:assert/strict";
import test from "node:test";
import {
  createOperationReconciliationLoop,
  createManagedSessionRecoveryOwner,
  createEndpointReadyBuffer,
  createChatHistoryAction,
  isUncertainAssistantTransportFailure,
  managedRecoveryDisposition,
  managedRecoveryManagementState,
  managedRetryKey,
  managedSessionNeedsRecovery,
  operationRecoveryAction,
  operationRecoveryFailureDisposition,
  operationRecoveryPreflight,
  parseEndpointLifecycleCheckpoint,
  processWorkerTerminalNotification,
  reconcileLifecycleAndOwnership,
  reconcileLifecycleTransitions,
  reconcileOwnershipBeforeRelay,
  reconcileOwnershipBeforeRelayWithLease,
  recoverManagedEndpointReady,
  recoverRemovalOperation,
  recoverableLifecycleEndpointReferences,
  recoverableOperationActivationReferences,
  recoverableOperationEndpointReferences,
  recoverableOperationTarget,
  registryReloadPreservesWorkerMappings,
  removalRecoveryDecision,
  reportAssistantTerminalFailure,
  reportOperationalSafely,
  requestOperationRecoveryForAttempt,
  runAssistantTerminalRecovery,
  runOperationRecoveryTarget,
  runOperationRecoveryChains,
  stopRelayRecovery,
  stopRecoveryOwnerSet,
  wakeRestoredSessionOwners,
  withRelayEndpointWorkLease,
  type ManagedRetryKey,
  type OperationReconciliationPass,
  type OperationRecoveryTarget,
} from "../src/production-app.ts";
import { AppError } from "../src/core/errors.ts";
import type { ManagementState } from "../src/core/types.ts";
import { ChatAdapterRegistry } from "../src/chat/adapter-registry.ts";
import type { EndpointWorkLease } from "../src/endpoints/types.ts";
import { composeApp } from "../src/app.ts";
import { RpcRequestTimeoutError } from "../src/app-server/rpc-client.ts";
import { createTestDatabase } from "../src/storage/database.ts";
import { OperationStore } from "../src/storage/operation-store.ts";
import { EndpointManager } from "../src/endpoints/manager.ts";
import { SessionOwnershipWatcher } from "../src/sessions/ownership-watcher.ts";

test("operation recovery waits only for the exact in-process tool handler", () => {
  assert.equal(operationRecoveryAction({ state: "dispatched", activeHandler: true }), "wait_for_tool");
  assert.equal(operationRecoveryAction({ state: "uncertain", activeHandler: true }), "wait_for_tool");
  assert.equal(operationRecoveryAction({ state: "uncertain", activeHandler: false }), "attempt");
  assert.equal(operationRecoveryAction({ state: "dispatched", activeHandler: false }), "attempt");
});

test("recoverable operation targets are exhaustive and fail closed", () => {
  const sessionEndpoints = new Map([
    ["worker-a", "endpoint-a"],
    ["worker-b", "endpoint-b"],
  ]);
  const resolve = {
    defaultProjectEndpointId: "local",
    session: (nickname: string) => {
      const endpoint = sessionEndpoints.get(nickname);
      return endpoint ? { endpoint, thread_id: `thread-${nickname}`, project_dir: "/project", mapping_id: `mapping-${nickname}`, lifecycle_state: "managed" as const } : undefined;
    },
  };
  const target = (kind: string, args: Record<string, unknown> = {}, receipt?: unknown) => recoverableOperationTarget({ kind, args, ...(receipt === undefined ? {} : { receipt }) }, resolve);
  const localKinds = [
    "update_session_notes", "send_chat_message", "send_chat_attachment", "collect_messages",
    "set_session_model", "set_reasoning_effort", "rename_session",
  ];
  for (const kind of localKinds) assert.deepEqual(target(kind), { policy: "local" }, kind);
  assert.deepEqual(target("prepare_chat_attachment", { owner: "assistant" }), { policy: "local" });
  assert.deepEqual(target("prepare_chat_attachment", { owner: "worker-a" }), { policy: "ready_endpoint", endpointId: "endpoint-a" });
  for (const kind of ["create_session", "adopt_session"]) {
    assert.deepEqual(target(kind, { endpoint: "endpoint-a" }), { policy: "ready_endpoint", endpointId: "endpoint-a" }, kind);
    assert.deepEqual(target(kind, { endpoint: "endpoint-a" }, { endpoint: "endpoint-b" }), { policy: "ready_endpoint", endpointId: "endpoint-b" }, `${kind} checkpoint`);
  }
  assert.deepEqual(target("create_session", { endpoint: "" }), { policy: "ready_endpoint", endpointId: "local" });
  assert.deepEqual(target("send_to_session", { nickname: "worker-a" }), { policy: "ready_endpoint", endpointId: "endpoint-a" });
  for (const kind of ["set_goal", "pause_goal", "resume_goal", "cancel_goal", "interrupt_session"]) {
    assert.deepEqual(target(kind, { nickname: "worker-b" }), { policy: "ready_endpoint", endpointId: "endpoint-b" }, kind);
  }
  for (const kind of ["unadopt_session", "archive_session"]) {
    assert.deepEqual(target(kind, { nickname: "worker-a" }, { endpoint: "endpoint-b" }), { policy: "local" }, kind);
  }
  for (const kind of ["disconnect_endpoint", "restart_endpoint"]) {
    assert.deepEqual(target(kind, { endpoint: "endpoint-a" }), { policy: "endpoint_lifecycle", endpointId: "endpoint-a" }, kind);
    assert.deepEqual(target(kind, { endpoint: "endpoint-a" }, { endpoint: "endpoint-b" }), { policy: "endpoint_lifecycle", endpointId: "endpoint-b" }, `${kind} checkpoint`);
  }
  assert.deepEqual(target("future_operation", { endpoint: "endpoint-a" }), { policy: "unknown" });
  assert.deepEqual(target("send_to_session", { nickname: "missing" }), { policy: "unknown" });
  assert.deepEqual(recoverableOperationEndpointReferences([
    { kind: "create_session", args: {}, receipt: undefined },
    { kind: "restart_endpoint", args: { endpoint: "endpoint-b" }, receipt: undefined },
    { kind: "future_operation", args: { endpoint: "endpoint-a" }, receipt: undefined },
    { kind: "adopt_session", args: { endpoint: "endpoint-b" }, receipt: undefined },
  ], resolve), ["endpoint-b"]);
  assert.deepEqual(recoverableOperationActivationReferences([
    { kind: "restart_endpoint", args: { endpoint: "endpoint-b" }, receipt: undefined },
    { kind: "disconnect_endpoint", args: { endpoint: "endpoint-a" }, receipt: undefined },
    { kind: "future_operation", args: { endpoint: "endpoint-a" }, receipt: undefined },
  ], resolve), []);
  assert.deepEqual(recoverableOperationEndpointReferences([
    { kind: "restart_endpoint", args: { endpoint: "endpoint-a" }, receipt: undefined },
  ], resolve), ["endpoint-a"], "lifecycle targets pin identity without eager activation");
  assert.deepEqual(recoverableLifecycleEndpointReferences([
    { kind: "disconnect_endpoint", args: {}, receipt: undefined },
    { kind: "restart_endpoint", args: { endpoint: "endpoint-a" }, receipt: undefined },
  ], resolve), ["endpoint-a", "local"]);
});

test("durable operation endpoints survive restart as startup identity references", async () => {
  const db = createTestDatabase();
  const beforeRestart = new OperationStore(db);
  const operation = beforeRestart.prepare({
    contextId: "ctx", attemptId: "attempt", callId: "call", kind: "create_session",
    args: { nickname: "worker", endpoint: "devbox", project_dir: "/project" },
  });
  beforeRestart.markDispatched(operation.id);
  beforeRestart.checkpoint(operation.id, { endpoint: "devbox", dispatchStarted: true, projectDir: "/project" });

  const afterRestart = new OperationStore(db);
  const resolver = { defaultProjectEndpointId: "local", session: () => undefined };
  const references = recoverableOperationEndpointReferences(afterRestart.listRecoverable(), resolver);
  const activationReferences = recoverableOperationActivationReferences(afterRestart.listRecoverable(), resolver);
  assert.deepEqual(references, ["devbox"]);
  assert.deepEqual(activationReferences, ["devbox"]);

  const listeners = () => () => undefined;
  const local = {
    id: "local", state: "stopped" as const, start: async () => undefined, closeConnection: async () => undefined,
    shutdownRuntime: async () => undefined, runtimeIdentity: async () => ({ kind: "local" as const, pid: 1, startTime: "1" }),
    request: async () => ({}), onNotification: listeners, onReady: listeners, onUnavailable: listeners, onPermissionBlocked: listeners,
  };
  let remoteState: "stopped" | "ready" = "stopped";
  let remoteStarts = 0;
  const remote = {
    id: "devbox", get state() { return remoteState; },
    start: async () => { remoteStarts += 1; remoteState = "ready"; }, closeConnection: async () => undefined,
    shutdownRuntime: async () => undefined,
    runtimeIdentity: async () => ({ kind: "ssh" as const, token: "a".repeat(32), pid: 1, linuxStartTime: "1", processGroupId: 1 }),
    request: async () => ({}), onNotification: listeners, onReady: listeners, onUnavailable: listeners, onPermissionBlocked: listeners,
  };
  const identityReferenceChecks: boolean[] = [];
  const manager = new EndpointManager({
    localEndpoint: local as never,
    catalog: { reload: async () => undefined, require: (id: string) => ({ id, type: "ssh" as const, projectsRoot: "~/projects" }) },
    createRemote: async (_definition, hasReferences) => { identityReferenceChecks.push(hasReferences); return { endpoint: remote as never }; },
    hasIdentityReferences: (endpointId) => references.includes(endpointId),
    managedThreadIds: () => [],
  });
  assert.deepEqual(await manager.activateReferenced(activationReferences), { unavailable: [] });
  assert.equal(remoteStarts, 1);
  assert.deepEqual(identityReferenceChecks, [true]);

  const target = recoverableOperationTarget(afterRestart.listRecoverable()[0]!, resolver);
  let recovered = false;
  await runOperationRecoveryTarget(target, manager, async (lease) => {
    assert.equal(lease?.endpointId, "devbox");
    recovered = true;
  });
  assert.equal(recovered, true);
});

test("a ready event deferred during startup drains the complete endpoint pipeline once", async () => {
  const owners: string[] = [];
  const readyBuffer = createEndpointReadyBuffer({
    recover: async (endpointId) => {
      owners.push(`lifecycle:${endpointId}`, `managed:${endpointId}`, `claims:${endpointId}`, `relay:${endpointId}`, `observations:${endpointId}`, `operations:${endpointId}`);
    },
  });
  let retry!: () => void;
  const fakeTimer = { set: (callback: () => void) => { retry = callback; } };
  fakeTimer.set(() => {
    assert.equal(readyBuffer.ready("devbox"), undefined);
    assert.equal(readyBuffer.ready("devbox"), undefined);
  });

  retry();
  assert.deepEqual(owners, []);
  await readyBuffer.acceptAndDrain();
  assert.deepEqual(owners, [
    "lifecycle:devbox", "managed:devbox", "claims:devbox", "relay:devbox", "observations:devbox", "operations:devbox",
  ]);
  await readyBuffer.ready("devbox");
  assert.equal(owners.filter((item) => item === "operations:devbox").length, 2, "accepted ready events remain live after startup");

  let fail = true;
  let attempts = 0;
  const retrying = createEndpointReadyBuffer({
    maxPendingEndpoints: 1,
    recover: async () => {
      attempts += 1;
      if (fail) throw new Error("retry ready recovery");
    },
  });
  retrying.ready("devbox");
  const overflow = retrying.ready("other");
  assert.ok(overflow);
  await assert.rejects(overflow, (error: unknown) => error instanceof AppError && error.code === "CAPACITY_EXCEEDED");
  await assert.rejects(retrying.acceptAndDrain(), /retry ready recovery/u);
  fail = false;
  await retrying.acceptAndDrain();
  assert.equal(attempts, 2, "a failed drain remains pending for the next recovery boundary");
});

test("ready recovery is single-flight per endpoint and coalesces one dirty follow-up", async () => {
  let signalStarted!: () => void;
  let releaseFirst!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let attempts = 0;
  let active = 0;
  let maxActive = 0;
  const readyBuffer = createEndpointReadyBuffer({
    recover: async () => {
      attempts += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (attempts === 1) {
        signalStarted();
        await blocked;
      }
      active -= 1;
    },
  });
  await readyBuffer.acceptAndDrain();
  const first = readyBuffer.ready("devbox");
  assert.ok(first);
  await started;
  const second = readyBuffer.ready("devbox");
  const third = readyBuffer.ready("devbox");
  assert.equal(second, first);
  assert.equal(third, first);
  releaseFirst();
  await first;
  assert.deepEqual({ attempts, maxActive }, { attempts: 2, maxActive: 1 });

  let signalPausedStarted!: () => void;
  let releasePaused!: () => void;
  const pausedStarted = new Promise<void>((resolve) => { signalPausedStarted = resolve; });
  const pausedBlock = new Promise<void>((resolve) => { releasePaused = resolve; });
  let pausedAttempts = 0;
  const pausedBuffer = createEndpointReadyBuffer({
    recover: async () => {
      pausedAttempts += 1;
      if (pausedAttempts === 1) {
        signalPausedStarted();
        await pausedBlock;
      }
    },
  });
  await pausedBuffer.acceptAndDrain();
  const pausedFirst = pausedBuffer.ready("devbox");
  assert.ok(pausedFirst);
  await pausedStarted;
  pausedBuffer.ready("devbox");
  pausedBuffer.pause();
  releasePaused();
  await pausedFirst;
  assert.equal(pausedAttempts, 1, "pause defers a dirty follow-up");
  await pausedBuffer.acceptAndDrain();
  assert.equal(pausedAttempts, 2);
});

test("ready recovery reports only the latest dirty pass and retains a latest failure", async () => {
  let signalStaleStarted!: () => void;
  let releaseStale!: () => void;
  const staleStarted = new Promise<void>((resolve) => { signalStaleStarted = resolve; });
  const staleBlock = new Promise<void>((resolve) => { releaseStale = resolve; });
  let staleAttempts = 0;
  const staleFailure = createEndpointReadyBuffer({
    recover: async () => {
      staleAttempts += 1;
      if (staleAttempts === 1) {
        signalStaleStarted();
        await staleBlock;
        throw new Error("obsolete recovery failure");
      }
    },
  });
  await staleFailure.acceptAndDrain();
  const superseded = staleFailure.ready("devbox");
  assert.ok(superseded);
  await staleStarted;
  staleFailure.ready("devbox");
  releaseStale();
  await superseded;
  staleFailure.pause();
  await staleFailure.acceptAndDrain();
  assert.equal(staleAttempts, 2, "a successful latest pass does not remain pending");

  let signalLatestStarted!: () => void;
  let releaseLatest!: () => void;
  const latestStarted = new Promise<void>((resolve) => { signalLatestStarted = resolve; });
  const latestBlock = new Promise<void>((resolve) => { releaseLatest = resolve; });
  let latestAttempts = 0;
  let failLatest = true;
  const latestFailure = createEndpointReadyBuffer({
    recover: async () => {
      latestAttempts += 1;
      if (latestAttempts === 1) {
        signalLatestStarted();
        await latestBlock;
      } else if (failLatest) {
        throw new Error("latest recovery failure");
      }
    },
  });
  await latestFailure.acceptAndDrain();
  const terminal = latestFailure.ready("devbox");
  assert.ok(terminal);
  await latestStarted;
  latestFailure.ready("devbox");
  releaseLatest();
  await assert.rejects(terminal, /latest recovery failure/u);
  failLatest = false;
  await latestFailure.acceptAndDrain();
  assert.equal(latestAttempts, 3, "a failed latest pass remains pending for the next drain");

  let retainedAttempts = 0;
  let failRetained = true;
  const retainedFailure = createEndpointReadyBuffer({
    recover: async () => {
      retainedAttempts += 1;
      if (failRetained) throw new Error("retained recovery failure");
      if (retainedAttempts > 2) throw new Error("stale pending recovery reactivated the endpoint");
    },
  });
  await retainedFailure.acceptAndDrain();
  const failedLive = retainedFailure.ready("devbox");
  assert.ok(failedLive);
  await assert.rejects(failedLive, /retained recovery failure/u);
  failRetained = false;
  const recoveredLive = retainedFailure.ready("devbox");
  assert.ok(recoveredLive);
  await recoveredLive;
  retainedFailure.pause();
  await retainedFailure.acceptAndDrain();
  assert.equal(retainedAttempts, 2, "a later live success claims the retained pending recovery");
});

test("production-style endpoint recovery starts a dirty pass after the current generation is removed", async () => {
  const owners = ["lifecycle", "managed", "claims", "relay", "observations", "operations"] as const;
  const seen: string[] = [];
  const active = new Map<string, Promise<void>>();
  let generation = 0;
  let readyBuffer!: ReturnType<typeof createEndpointReadyBuffer>;
  const recoverProjectEndpoint = (endpointId: string): Promise<void> => {
    const existing = active.get(endpointId);
    if (existing) return existing;
    const currentGeneration = ++generation;
    let recovery!: Promise<void>;
    recovery = (async () => {
      await Promise.resolve();
      for (const owner of owners) {
        seen.push(`${owner}:${currentGeneration}`);
        if (currentGeneration === 1 && owner === "managed") {
          readyBuffer.ready(endpointId);
          readyBuffer.ready(endpointId);
        }
      }
    })().finally(() => {
      if (active.get(endpointId) === recovery) active.delete(endpointId);
    });
    active.set(endpointId, recovery);
    return recovery;
  };
  readyBuffer = createEndpointReadyBuffer({ recover: recoverProjectEndpoint });
  readyBuffer.ready("devbox");
  await readyBuffer.acceptAndDrain();

  assert.equal(generation, 2);
  assert.deepEqual(seen, [...owners.map((owner) => `${owner}:1`), ...owners.map((owner) => `${owner}:2`)]);
  assert.equal(active.size, 0);
});

test("per-endpoint recovery chains preserve durable lifecycle order and unrelated progress", async () => {
  const entry = (id: string, sequence: number, policy: "endpoint_lifecycle" | "ready_endpoint" | "local", endpointId?: string) => ({
    operation: { id, sequence, createdAt: 1_000 },
    target: policy === "local" ? { policy } as const : { policy, endpointId: endpointId! } as const,
  });
  const tied = [
    entry("disconnect-a", 2, "endpoint_lifecycle", "a"),
    entry("restart-a", 1, "endpoint_lifecycle", "a"),
    entry("ordinary-a", 3, "ready_endpoint", "a"),
    entry("ordinary-b", 4, "ready_endpoint", "b"),
    entry("local", 5, "local"),
  ];
  const first: string[] = [];
  await runOperationRecoveryChains(tied, (item) => item.target, async ({ operation }) => {
    first.push(operation.id);
    return operation.id === "restart-a";
  });
  assert.deepEqual(first, ["restart-a", "ordinary-b", "local"]);

  const second: string[] = [];
  await runOperationRecoveryChains(tied, (item) => item.target, async ({ operation }) => {
    second.push(operation.id);
    return false;
  });
  assert.deepEqual(second, ["restart-a", "disconnect-a", "ordinary-a", "ordinary-b", "local"]);

  const reverse = [
    entry("restart-a", 2, "endpoint_lifecycle", "a"),
    entry("disconnect-a", 1, "endpoint_lifecycle", "a"),
  ];
  const reverseSeen: string[] = [];
  await runOperationRecoveryChains(reverse, (item) => item.target, async ({ operation }) => { reverseSeen.push(operation.id); return false; });
  assert.deepEqual(reverseSeen, ["disconnect-a", "restart-a"]);

  let ordinaryTarget: OperationRecoveryTarget = { policy: "unknown" };
  const dynamic = [
    entry("restart-a", 1, "endpoint_lifecycle", "a"),
    entry("rename", 2, "local"),
    entry("ordinary-after-rename", 3, "ready_endpoint", "placeholder"),
  ];
  const dynamicSeen: string[] = [];
  await runOperationRecoveryChains(dynamic, (item) => item.operation.id === "ordinary-after-rename" ? ordinaryTarget : item.target, async ({ operation }) => {
    dynamicSeen.push(operation.id);
    if (operation.id === "restart-a") return true;
    if (operation.id === "rename") ordinaryTarget = { policy: "ready_endpoint", endpointId: "a" };
    return false;
  });
  assert.deepEqual(dynamicSeen, ["restart-a", "rename"], "later targets are resolved after earlier durable mutations");
});

test("removal recovery concludes locally and leases only an actionable reconciliation", async () => {
  const saved = {
    endpoint: "devbox", thread_id: "thread", project_dir: "/project", mapping_id: "mapping",
    lifecycle_state: "archiving" as const, step: "transitioned",
  };
  const operation = { id: "op", kind: "archive_session", args: { nickname: "worker" }, receipt: saved } as const;
  let endpointCalls = 0;
  let succeeded = 0;
  let failed = 0;
  const unavailableEndpoints = {
    withReadyWorkLease: async () => { endpointCalls += 1; throw new Error("must not touch endpoint"); },
  };
  const localTarget = recoverableOperationTarget(operation as never, { defaultProjectEndpointId: "local", session: () => undefined });
  await runOperationRecoveryTarget(localTarget, unavailableEndpoints as never, (lease) => recoverRemovalOperation({
    operation: operation as never,
    registry: { get: () => undefined } as never,
    lifecycle: { reconcileRemoval: async () => { endpointCalls += 1; } } as never,
    ...(lease ? { lease } : {}),
    succeed: async () => { succeeded += 1; },
    failNoEffect: () => { failed += 1; },
  }));
  assert.deepEqual({ endpointCalls, succeeded, failed }, { endpointCalls: 0, succeeded: 1, failed: 0 });

  const prepared = { ...saved, lifecycle_state: "managed" as const, step: "prepared" };
  const preparedOperation = { ...operation, kind: "unadopt_session", receipt: prepared } as const;
  const preparedSession = { ...prepared, lifecycle_state: "managed" as const };
  const preparedTarget = recoverableOperationTarget(preparedOperation as never, {
    defaultProjectEndpointId: "local", session: () => preparedSession,
  });
  await runOperationRecoveryTarget(preparedTarget, unavailableEndpoints as never, (lease) => recoverRemovalOperation({
    operation: preparedOperation as never,
    registry: { get: () => preparedSession } as never,
    lifecycle: { reconcileRemoval: async () => { endpointCalls += 1; } } as never,
    ...(lease ? { lease } : {}),
    succeed: async () => { succeeded += 1; },
    failNoEffect: () => { failed += 1; },
  }));
  assert.deepEqual(preparedTarget, { policy: "local" });
  assert.deepEqual({ endpointCalls, succeeded, failed }, { endpointCalls: 0, succeeded: 1, failed: 1 });

  const transitioning = { ...saved, lifecycle_state: "archiving" as const };
  const reconcileOperation = { ...operation, receipt: transitioning };
  const reconcileTarget = recoverableOperationTarget(reconcileOperation as never, {
    defaultProjectEndpointId: "local",
    session: () => transitioning,
  });
  const lease = { endpointId: "devbox", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "removal" };
  await runOperationRecoveryTarget(reconcileTarget, {
    withReadyWorkLease: async (_endpointId: string | undefined, run: (lease: EndpointWorkLease) => Promise<unknown>) => { endpointCalls += 1; return run(lease); },
  } as never, (actual) => recoverRemovalOperation({
    operation: reconcileOperation as never,
    registry: { get: () => transitioning } as never,
    lifecycle: { reconcileRemoval: async (_nickname: string, _current: unknown, received: unknown) => {
      assert.equal(received, lease);
    } } as never,
    ...(actual ? { lease: actual } : {}),
    succeed: async () => undefined,
    failNoEffect: () => undefined,
  }));
  assert.equal(endpointCalls, 1);
});

test("ordinary operation recovery waits without endpoint activation while lifecycle work remains actionable", () => {
  let readinessChecks = 0;
  const ready = (endpointId: string) => { readinessChecks += 1; return endpointId === "endpoint-a"; };
  assert.equal(operationRecoveryPreflight({ policy: "ready_endpoint", endpointId: "endpoint-b" }, ready), "wait_for_endpoint");
  assert.equal(operationRecoveryPreflight({ policy: "ready_endpoint", endpointId: "endpoint-a" }, ready), "attempt");
  assert.equal(operationRecoveryPreflight({ policy: "endpoint_lifecycle", endpointId: "endpoint-b" }, ready), "attempt");
  assert.equal(operationRecoveryPreflight({ policy: "local" }, ready), "attempt");
  assert.equal(operationRecoveryPreflight({ policy: "unknown" }, ready), "sleep");
  assert.equal(readinessChecks, 2);
});

test("operation recovery retries only source-classified transient proof failures", () => {
  const lifecycleTarget = { policy: "endpoint_lifecycle", endpointId: "endpoint-a" } as const;
  const ordinaryTarget = { policy: "ready_endpoint", endpointId: "endpoint-a" } as const;
  assert.equal(operationRecoveryFailureDisposition(new RpcRequestTimeoutError("thread/read")), "retry");
  assert.equal(operationRecoveryFailureDisposition(new AppError("OPERATION_UNCERTAIN", "temporary", { recovery: "ownership_unclassified" })), "retry");
  assert.equal(operationRecoveryFailureDisposition(new AppError("ENDPOINT_UNAVAILABLE", "offline"), lifecycleTarget), "retry");
  assert.equal(operationRecoveryFailureDisposition(new AppError("ENDPOINT_UNAVAILABLE", "offline"), ordinaryTarget), "wait_for_endpoint");
  assert.equal(operationRecoveryFailureDisposition(new AppError("OPERATION_UNCERTAIN", "permanent")), "sleep");
  assert.equal(operationRecoveryFailureDisposition(new Error("unknown")), "sleep");
});

test("managed recovery uses only source-specific transient and external dispositions", () => {
  assert.equal(managedRecoveryDisposition(new RpcRequestTimeoutError("thread/read")), "retry");
  assert.equal(managedRecoveryDisposition(new AppError("ENDPOINT_UNAVAILABLE", "x")), "endpoint");
  assert.equal(managedRecoveryDisposition(new AppError("OPERATION_UNCERTAIN", "x", { recovery: "ownership_unclassified" })), "retry");
  assert.equal(managedRecoveryDisposition(new AppError("SESSION_BUSY", "x", { recovery: "external_turn" })), "external");
  assert.equal(managedRecoveryDisposition(new AppError("OPERATION_UNCERTAIN", "changed rollout path")), "permanent");
  assert.equal(managedRecoveryDisposition(new AppError("CWD_MISMATCH", "x")), "permanent");
  assert.equal(managedRecoveryDisposition(new Error("unknown")), "permanent");
  assert.equal(managedRecoveryManagementState("unavailable", "external"), "managed");
  assert.equal(managedRecoveryManagementState("unadopting", "external"), "unadopting");
  assert.equal(managedRecoveryManagementState("managed", "retry"), "unavailable");
});

test("managed endpoint-ready composition falls back only when no owner target supplies the shared wake", async () => {
  const lease: EndpointWorkLease = { endpointId: "endpoint-a", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "ready" };
  for (const [outcome, expectedFallbacks] of [
    ["needs_shared_wake", 1],
    ["pending", 0],
    ["completed", 0],
  ] as const) {
    let fallbacks = 0;
    const result = await recoverManagedEndpointReady({
      endpointReady: async () => ({ outcome }),
    }, "endpoint-a", lease, async () => { fallbacks += 1; });
    assert.deepEqual(result, { outcome });
    assert.equal(fallbacks, expectedFallbacks, outcome);
  }
});

test("an externally owned managed recovery remains inspectable for the next ownership release tick", async () => {
  const session = {
    endpoint: "endpoint-a", thread_id: "thread-a", project_dir: "/project", mapping_id: "mapping-a", lifecycle_state: "managed" as const,
  };
  let runtimeState: ManagementState | "released" = "unavailable";
  runtimeState = managedRecoveryManagementState(runtimeState, "external");
  const seen: string[] = [];
  const watcher = new SessionOwnershipWatcher(
    {
      snapshot: () => ({ version: 3 as const, assistant: { endpoint: "assistant", thread_id: "assistant", project_dir: "/assistant" }, sessions: { worker: session } }),
      get: () => session,
    } as never,
    {
      inspect: async () => {
        seen.push(`inspect:${runtimeState}`);
        runtimeState = "unadopting";
        return { state: "external", turnId: "external-turn" } as const;
      },
    },
    {
      unadopt: async () => {
        seen.push(`release:${runtimeState}`);
        runtimeState = "released";
      },
    },
    {
      isInspectable: () => runtimeState === "managed" || runtimeState === "unadopting",
      onExternal: async () => { seen.push("external"); },
      onReleased: async () => { seen.push("released"); },
    },
  );

  await watcher.reconcileEndpoint("endpoint-a");
  assert.equal(runtimeState, "released");
  assert.deepEqual(seen, ["inspect:managed", "external", "release:unadopting", "released"]);
});

test("managed retry owner retries only exact endpoint mappings and wakes downstream once after restoration", async () => {
  type Timer = { callback: () => void; delayMs: number; cleared: boolean };
  const timers: Timer[] = [];
  const lease: EndpointWorkLease = { endpointId: "endpoint-a", lifecycleGeneration: 1, endpointGeneration: 2, leaseId: "managed-retry" };
  const keyA = managedRetryKey("endpoint-a", "thread-a", "mapping-a");
  const healthyA = managedRetryKey("endpoint-a", "thread-healthy", "mapping-healthy");
  const keyB = managedRetryKey("endpoint-b", "thread-b", "mapping-b");
  const attempts: Array<{ endpointId: string; keys: readonly string[]; lease: EndpointWorkLease }> = [];
  const restored: string[] = [];
  let owner!: ReturnType<typeof createManagedSessionRecoveryOwner>;
  owner = createManagedSessionRecoveryOwner({
    endpoints: {
      withReadyWorkLease: async (endpointId, run) => {
        assert.equal(endpointId, "endpoint-a");
        return run(lease);
      },
    },
    isLeaseCurrent: () => true,
    recover: async (endpointId, keys, actualLease) => {
      attempts.push({ endpointId, keys, lease: actualLease });
      return { restored: keys.length > 0, restoredKeys: keys, settledKeys: [], failures: [] };
    },
    beforeShared: async () => undefined,
    wakeShared: async (endpointId) => { restored.push(endpointId); },
    afterShared: async () => undefined,
    onSafetyFailure: () => assert.fail("unexpected managed retry safety failure"),
    onError: () => assert.fail("unexpected managed retry error"),
    timers: {
      setTimeout: (callback, delayMs) => {
        const timer = { callback, delayMs, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer: Timer) => { timer.cleared = true; },
    },
    retryMs: 50,
  });

  owner.recordFailure(keyA, "retry");
  owner.recordFailure(keyB, "endpoint");
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.delayMs, 50);
  timers[0]!.callback();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.deepEqual(attempts, [{ endpointId: "endpoint-a", keys: [keyA], lease }]);
  assert.equal(attempts[0]!.keys.includes(healthyA), false);
  assert.deepEqual(restored, ["endpoint-a"]);

  const leaseB: EndpointWorkLease = { ...lease, endpointId: "endpoint-b", leaseId: "ready-b" };
  await owner.endpointReady("endpoint-b", leaseB);
  assert.deepEqual(attempts[1], { endpointId: "endpoint-b", keys: [keyB], lease: leaseB });
  assert.deepEqual(restored, ["endpoint-a", "endpoint-b"]);
  await owner.stop();
});

test("managed retry owner cancels endpoint timers and fences endpoint loss, generation failure, and shutdown", async () => {
  type Timer = { callback: () => void; cleared: boolean };
  const timers: Timer[] = [];
  const key = managedRetryKey("endpoint-a", "thread-a", "mapping-a");
  const lease: EndpointWorkLease = { endpointId: "endpoint-a", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "ready-a" };
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let attempts = 0;
  let downstream = 0;
  let endpointLeaseCalls = 0;
  let owner!: ReturnType<typeof createManagedSessionRecoveryOwner>;
  owner = createManagedSessionRecoveryOwner({
    endpoints: {
      withReadyWorkLease: async (_endpointId, run) => {
        endpointLeaseCalls += 1;
        return run(lease);
      },
    },
    isLeaseCurrent: () => true,
    recover: async (_endpointId, keys) => {
      attempts += 1;
      if (attempts === 1) throw new AppError("ENDPOINT_UNAVAILABLE", "generation changed");
      await blocked;
      return { restored: true, restoredKeys: keys, settledKeys: [], failures: [] };
    },
    beforeShared: async () => undefined,
    wakeShared: async () => { downstream += 1; },
    afterShared: async () => undefined,
    onSafetyFailure: () => assert.fail("unexpected managed retry safety failure"),
    onError: () => undefined,
    timers: {
      setTimeout: (callback) => {
        const timer = { callback, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer: Timer) => { timer.cleared = true; },
    },
  });

  owner.recordFailure(key, "retry");
  const stale = timers[0]!;
  owner.endpointUnavailable("endpoint-a");
  assert.equal(stale.cleared, true);
  stale.callback();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(attempts, 0);

  await owner.endpointReady("endpoint-a", lease);
  assert.equal(attempts, 1);
  assert.equal(downstream, 0, "a generation failure cannot publish restoration");
  assert.equal(endpointLeaseCalls, 0, "an existing ready lease is reused without reacquisition");

  const live = owner.endpointReady("endpoint-a", lease);
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  let stopped = false;
  const stopping = owner.stop().then(() => { stopped = true; });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(stopped, false);
  release();
  await Promise.all([live, stopping]);
  assert.equal(downstream, 0, "shutdown suppresses a late success publication");
});

test("managed retry owner rejects a blocked old-generation success and preserves the exact key for replacement", async () => {
  const key = managedRetryKey("endpoint-a", "thread-a", "mapping-a");
  const oldLease: EndpointWorkLease = { endpointId: "endpoint-a", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "old" };
  const newLease: EndpointWorkLease = { ...oldLease, endpointGeneration: 2, leaseId: "new" };
  let signalStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const attempts: string[] = [];
  const downstream: string[] = [];
  let currentLeaseId = oldLease.leaseId;
  let owner!: ReturnType<typeof createManagedSessionRecoveryOwner>;
  owner = createManagedSessionRecoveryOwner({
    endpoints: { withReadyWorkLease: async (_endpointId, run) => run(newLease) },
    isLeaseCurrent: (_endpointId, lease) => lease.leaseId === currentLeaseId,
    recover: async (_endpointId, keys, lease) => {
      attempts.push(lease.leaseId);
      if (lease.leaseId === "old") {
        signalStarted();
        await blocked;
      }
      return { restored: true, restoredKeys: keys, settledKeys: [], failures: [] };
    },
    beforeShared: async () => undefined,
    wakeShared: async (_endpointId, lease) => { downstream.push(lease.leaseId); },
    afterShared: async () => undefined,
    onSafetyFailure: () => assert.fail("unexpected managed retry safety failure"),
    onError: () => undefined,
  });
  owner.recordFailure(key, "endpoint");

  const oldRun = owner.endpointReady("endpoint-a", oldLease);
  await started;
  currentLeaseId = "lost";
  owner.endpointUnavailable("endpoint-a");
  currentLeaseId = newLease.leaseId;
  const replacement = owner.endpointReady("endpoint-a", newLease);
  release();
  await Promise.all([oldRun, replacement]);

  assert.deepEqual(attempts, ["old", "new"]);
  assert.deepEqual(downstream, ["new"]);
  await owner.stop();
});

test("managed retry retains downstream-only work across failures before and after the helper", async () => {
  type Timer = { callback: () => void; cleared: boolean };
  const timers: Timer[] = [];
  const key = managedRetryKey("endpoint-a", "thread-a", "mapping-a");
  const lease: EndpointWorkLease = { endpointId: "endpoint-a", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "ready" };
  let recoveries = 0;
  let beforeCalls = 0;
  let helperCalls = 0;
  let afterCalls = 0;
  let fallbackCalls = 0;
  let owner!: ReturnType<typeof createManagedSessionRecoveryOwner>;
  owner = createManagedSessionRecoveryOwner({
    endpoints: { withReadyWorkLease: async (_endpointId, run) => run(lease) },
    isLeaseCurrent: () => true,
    recover: async (_endpointId, keys) => {
      recoveries += 1;
      return { restored: true, restoredKeys: keys, settledKeys: [], failures: [] };
    },
    beforeShared: async () => {
      beforeCalls += 1;
      if (beforeCalls === 1) throw new RpcRequestTimeoutError("ownership-before-helper");
    },
    wakeShared: async () => { helperCalls += 1; },
    afterShared: async () => {
      afterCalls += 1;
      if (afterCalls === 1) throw new AppError("ENDPOINT_UNAVAILABLE", "ownership-after-helper");
    },
    onSafetyFailure: () => assert.fail("unexpected managed retry safety failure"),
    onError: () => undefined,
    timers: {
      setTimeout: (callback) => {
        const timer = { callback, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer: Timer) => { timer.cleared = true; },
    },
  });
  owner.recordFailure(key, "endpoint");

  const first = await recoverManagedEndpointReady(owner, "endpoint-a", lease, async () => { fallbackCalls += 1; });
  assert.deepEqual(first, { outcome: "pending" });
  assert.equal(timers.length, 1, "a classified pre-helper timeout retains a downstream retry");
  timers[0]!.callback();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(beforeCalls, 2);
  assert.equal(helperCalls, 1);
  assert.equal(afterCalls, 1);
  assert.equal(timers.length, 1, "endpoint loss after helper work sleeps for ready without another timer");

  const final = await recoverManagedEndpointReady(owner, "endpoint-a", lease, async () => { fallbackCalls += 1; });
  assert.deepEqual(final, { outcome: "completed" });
  assert.equal(recoveries, 1, "downstream retry never re-runs a healthy managed mapping");
  assert.equal(beforeCalls, 2);
  assert.equal(helperCalls, 1, "post-helper retry does not wake relay or observations again");
  assert.equal(afterCalls, 2);
  assert.equal(fallbackCalls, 0, "owner-held work never triggers a duplicate composition fallback");
  await owner.stop();
});

test("endpoint loss during a blocked downstream wake retains only the downstream target", async () => {
  const key = managedRetryKey("endpoint-a", "thread-a", "mapping-a");
  const oldLease: EndpointWorkLease = { endpointId: "endpoint-a", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "old-downstream" };
  const newLease: EndpointWorkLease = { ...oldLease, endpointGeneration: 2, leaseId: "new-downstream" };
  let currentLeaseId = oldLease.leaseId;
  let signalStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let recoveries = 0;
  const downstream: string[] = [];
  const owner = createManagedSessionRecoveryOwner({
    endpoints: { withReadyWorkLease: async (_endpointId, run) => run(newLease) },
    isLeaseCurrent: (_endpointId, lease) => lease.leaseId === currentLeaseId,
    recover: async (_endpointId, keys) => {
      recoveries += 1;
      return { restored: true, restoredKeys: keys, settledKeys: [], failures: [] };
    },
    beforeShared: async () => undefined,
    wakeShared: async (_endpointId, lease) => {
      downstream.push(lease.leaseId);
      if (lease.leaseId === oldLease.leaseId) {
        signalStarted();
        await blocked;
      }
    },
    afterShared: async () => undefined,
    onSafetyFailure: () => assert.fail("unexpected managed retry safety failure"),
    onError: () => undefined,
  });
  owner.recordFailure(key, "endpoint");

  const oldRun = owner.endpointReady("endpoint-a", oldLease);
  await started;
  currentLeaseId = "lost";
  owner.endpointUnavailable("endpoint-a");
  currentLeaseId = newLease.leaseId;
  const replacement = owner.endpointReady("endpoint-a", newLease);
  release();
  assert.deepEqual(await oldRun, { outcome: "pending" });
  assert.deepEqual(await replacement, { outcome: "completed" });
  assert.equal(recoveries, 1);
  assert.deepEqual(downstream, [oldLease.leaseId, newLease.leaseId]);
  await owner.stop();
});

test("permanent post-helper failure requests safety once without polling or duplicate shared wakes", async () => {
  type Timer = { callback: () => void };
  const timers: Timer[] = [];
  const key = managedRetryKey("endpoint-a", "thread-a", "mapping-a");
  const lease: EndpointWorkLease = { endpointId: "endpoint-a", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "permanent" };
  let recoveries = 0;
  let sharedWakes = 0;
  let afterCalls = 0;
  let safetyRequests = 0;
  let failAfter = true;
  const owner = createManagedSessionRecoveryOwner({
    endpoints: { withReadyWorkLease: async (_endpointId, run) => run(lease) },
    isLeaseCurrent: () => true,
    recover: async (_endpointId, keys) => {
      recoveries += 1;
      return { restored: true, restoredKeys: keys, settledKeys: [], failures: [] };
    },
    beforeShared: async () => undefined,
    wakeShared: async () => { sharedWakes += 1; },
    afterShared: async () => {
      afterCalls += 1;
      if (failAfter) throw new Error("permanent downstream failure");
    },
    onSafetyFailure: () => { safetyRequests += 1; },
    onError: () => undefined,
    timers: {
      setTimeout: (callback) => {
        const timer = { callback };
        timers.push(timer);
        return timer;
      },
      clearTimeout: () => undefined,
    },
  });
  owner.recordFailure(key, "endpoint");

  assert.deepEqual(await owner.endpointReady("endpoint-a", lease), { outcome: "pending" });
  assert.deepEqual(await owner.endpointReady("endpoint-a", lease), { outcome: "pending" });
  assert.equal(recoveries, 1);
  assert.equal(sharedWakes, 1, "a retained post-helper phase never repeats the shared wake");
  assert.equal(afterCalls, 2);
  assert.equal(safetyRequests, 1, "repeated permanent failures request one controlled safety action");
  assert.equal(timers.length, 0, "permanent downstream failures never poll");

  failAfter = false;
  assert.deepEqual(await owner.endpointReady("endpoint-a", lease), { outcome: "completed" });
  owner.recordFailure(key, "endpoint");
  failAfter = true;
  assert.deepEqual(await owner.endpointReady("endpoint-a", lease), { outcome: "pending" });
  assert.equal(safetyRequests, 2, "completion resets the one-shot safety guard for a later incident");
  assert.equal(sharedWakes, 2);
  assert.equal(timers.length, 0);
  await owner.stop();
});

test("a partial managed restore survives another mapping entering endpoint wait", async () => {
  const keyA = managedRetryKey("endpoint-a", "thread-a", "mapping-a");
  const keyB = managedRetryKey("endpoint-a", "thread-b", "mapping-b");
  const lease: EndpointWorkLease = { endpointId: "endpoint-a", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "partial" };
  const attempts: ManagedRetryKey[][] = [];
  let wakes = 0;
  let fallbacks = 0;
  const owner = createManagedSessionRecoveryOwner({
    endpoints: { withReadyWorkLease: async (_endpointId, run) => run(lease) },
    isLeaseCurrent: () => true,
    recover: async (_endpointId, keys) => {
      attempts.push([...keys]);
      return attempts.length === 1
        ? { restored: true, restoredKeys: [keyA], settledKeys: [], failures: [{ key: keyB, disposition: "endpoint" }] }
        : { restored: true, restoredKeys: [keyB], settledKeys: [], failures: [] };
    },
    beforeShared: async () => undefined,
    wakeShared: async () => { wakes += 1; },
    afterShared: async () => undefined,
    onSafetyFailure: () => assert.fail("unexpected managed retry safety failure"),
    onError: () => undefined,
  });
  owner.recordFailure(keyA, "endpoint");
  owner.recordFailure(keyB, "endpoint");

  assert.deepEqual(
    await recoverManagedEndpointReady(owner, "endpoint-a", lease, async () => { fallbacks += 1; }),
    { outcome: "pending" },
  );
  assert.equal(wakes, 0);
  assert.deepEqual(
    await recoverManagedEndpointReady(owner, "endpoint-a", lease, async () => { fallbacks += 1; }),
    { outcome: "completed" },
  );
  assert.deepEqual(attempts, [[keyA, keyB], [keyB]]);
  assert.equal(wakes, 1);
  assert.equal(fallbacks, 0, "a partial owner-held restore never duplicates the shared wake");
  assert.deepEqual(await owner.endpointReady("endpoint-a", lease), { outcome: "needs_shared_wake" }, "both retained keys eventually clear");
  await owner.stop();
});

test("restored-session downstream owners are isolated and operational reporting cannot throw", async () => {
  const calls: string[] = [];
  await wakeRestoredSessionOwners({
    relay: { endpointReady: async () => { calls.push("relay"); throw new Error("relay failed"); } },
    observations: { endpointReady: async () => { calls.push("observations"); throw new Error("observation failed"); } },
    onError: (owner) => { calls.push(`error:${owner}`); },
  }, "endpoint-a");
  assert.deepEqual(calls, ["relay", "error:relay", "observations", "error:observations"]);

  let reports = 0;
  assert.doesNotThrow(() => reportOperationalSafely(() => {
    reports += 1;
    throw new Error("sink failed");
  }, { level: "warn", code: "background_task_failed", component: "session_observation" }));
  assert.equal(reports, 1);
});

test("classified operation retry is single-flight, capped, endpoint-scoped, and stopped safely", async () => {
  type Timer = { callback: () => void; delay: number; cleared: boolean };
  const timers: Timer[] = [];
  const timerApi = {
    setTimeout: (callback: () => void, delay: number) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer: Timer) => { timer.cleared = true; },
  };
  const ready = new Set(["endpoint-a"]);
  let passes = 0;
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const outcomes: OperationReconciliationPass[] = [
    {
      outcome: { attempted: true, transientRetry: true, waitingForEndpoint: false },
      transientTargets: new Map<string, OperationRecoveryTarget>([
        ["local-op", { policy: "local" }],
        ["a-op", { policy: "ready_endpoint", endpointId: "endpoint-a" }],
        ["b-op", { policy: "ready_endpoint", endpointId: "endpoint-b" }],
      ]),
    },
    { outcome: { attempted: true, transientRetry: false, waitingForEndpoint: true }, transientTargets: new Map() },
  ];
  const loop = createOperationReconciliationLoop({
    reconcileOnce: async () => {
      passes += 1;
      if (passes === 1) await firstBlocked;
      return outcomes.shift()!;
    },
    isEndpointReady: (endpointId) => ready.has(endpointId),
    timers: timerApi,
  });

  const running = loop.request();
  const joined = [loop.request(), loop.request(), loop.request()];
  releaseFirst();
  await Promise.all([running, ...joined]);
  assert.equal(passes, 2, "many concurrent wakes coalesce into one follow-up pass");
  assert.equal(timers.length, 0, "the final conclusive follow-up cancels an older retry intent");

  outcomes.push({
    outcome: { attempted: true, transientRetry: true, waitingForEndpoint: false },
    transientTargets: new Map([["a-op", { policy: "ready_endpoint", endpointId: "endpoint-a" }]]),
  });
  await loop.request();
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.delay, 1_000);
  ready.delete("endpoint-a");
  loop.endpointUnavailable("endpoint-a");
  assert.equal(timers[0]!.cleared, true);

  outcomes.push({ outcome: { attempted: true, transientRetry: false, waitingForEndpoint: false }, transientTargets: new Map() });
  ready.add("endpoint-a");
  await loop.endpointReady("endpoint-a");
  assert.equal(passes, 4);

  const stale = timers[0]!.callback;
  await loop.stop();
  stale();
  await Promise.resolve();
  assert.equal(passes, 4, "a stale timer callback cannot publish work after stop");
});

test("operation retry backoff is capped at thirty seconds", async () => {
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const loop = createOperationReconciliationLoop({
    reconcileOnce: async () => ({
      outcome: { attempted: true, transientRetry: true, waitingForEndpoint: false },
      transientTargets: new Map([["local", { policy: "local" }]]),
    }),
    isEndpointReady: () => false,
    timers: {
      setTimeout: (callback, delay) => { const timer = { callback, delay }; scheduled.push(timer); return timer; },
      clearTimeout: () => undefined,
    },
  });
  await loop.request();
  const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
  for (let index = 0; index < expected.length; index += 1) {
    assert.equal(scheduled[index]!.delay, expected[index]);
    if (index + 1 < expected.length) {
      scheduled[index]!.callback();
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
  }
  await loop.stop();
});

test("worker terminal reconciliation runs outside its endpoint lease and preserves enqueue ordering", async () => {
  const lease: EndpointWorkLease = { endpointId: "endpoint-a", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "terminal" };
  const seen: string[] = [];
  let leaseHeld = false;
  await processWorkerTerminalNotification({
    endpoints: { withReadyWorkLease: async (_endpointId, run) => {
      seen.push("lease:acquired");
      leaseHeld = true;
      try { return await run(lease); }
      finally { leaseHeld = false; seen.push("lease:released"); }
    } },
    ownership: {
      detectEndpoint: async () => { seen.push("ownership"); return []; },
      release: async () => { seen.push("ownership:released"); },
    },
    relay: { handleNotification: async () => { seen.push("relay"); return "retry" as const; } },
    reconcileOperations: async () => { assert.equal(leaseHeld, false); seen.push("operations"); },
    enqueuePendingEvents: async () => { seen.push("events"); },
  }, "endpoint-a", "turn/completed", { threadId: "thread-a", turn: { id: "turn-a" } });
  assert.deepEqual(seen, ["lease:acquired", "ownership", "relay", "ownership", "ownership:released", "lease:released", "operations", "events"]);

  seen.length = 0;
  await assert.rejects(processWorkerTerminalNotification({
    endpoints: { withReadyWorkLease: async (_endpointId, run) => {
      seen.push("lease:acquired");
      leaseHeld = true;
      try { return await run(lease); }
      finally { leaseHeld = false; seen.push("lease:released"); }
    } },
    ownership: {
      detectEndpoint: async () => { seen.push("ownership"); return []; },
      release: async () => undefined,
    },
    relay: { handleNotification: async () => { seen.push("relay"); throw new Error("retry"); } },
    reconcileOperations: async () => { assert.equal(leaseHeld, false); seen.push("operations"); },
    enqueuePendingEvents: async () => { seen.push("events"); },
  }, "endpoint-a", "turn/completed", { threadId: "thread-a", turn: { id: "turn-a" } }), /retry/u);
  assert.deepEqual(seen, ["lease:acquired", "ownership", "relay", "lease:released", "operations"]);
});

test("tool settlement and assistant terminalization request explicit operation recovery", async () => {
  let requests = 0;
  const requested = requestOperationRecoveryForAttempt({
    listRecoverable: () => [{ attemptId: "attempt-a" }] as never,
  }, "attempt-a", async () => { requests += 1; });
  const skipped = requestOperationRecoveryForAttempt({
    listRecoverable: () => [{ attemptId: "attempt-a" }] as never,
  }, "attempt-b", async () => { requests += 1; });
  await Promise.resolve();
  assert.equal(requested, true);
  assert.equal(skipped, false);
  assert.equal(requests, 1);

  const seen: string[] = [];
  await runAssistantTerminalRecovery({
    fenceTools: async () => { seen.push("fence"); },
    reconcileOperations: async () => { seen.push("operations"); },
    finalize: async () => { seen.push("finalize"); },
    hasRecoverableOperations: () => true,
  });
  assert.deepEqual(seen, ["fence", "operations", "finalize", "operations"]);

  seen.length = 0;
  await runAssistantTerminalRecovery({
    fenceTools: async () => { seen.push("fence"); },
    reconcileOperations: async () => { seen.push("operations"); },
    finalize: async () => { seen.push("finalize"); },
    hasRecoverableOperations: () => false,
  });
  assert.deepEqual(seen, ["fence", "operations", "finalize"]);
});

test("assistant uncertainty is preserved even while the endpoint still reports ready", () => {
  assert.equal(isUncertainAssistantTransportFailure(new AppError("OPERATION_UNCERTAIN", "shutdown"), "ready"), true);
  assert.equal(isUncertainAssistantTransportFailure(new Error("ordinary failure"), "ready"), false);
  assert.equal(isUncertainAssistantTransportFailure(new Error("transport failed"), "unavailable"), true);
});

test("assistant terminal failure reports always request one coalesced recovery wake", async () => {
  let wakeScheduled = false;
  let recoveries = 0;
  const dispatcher = {
    requestRecovery: () => {
      if (wakeScheduled) return;
      wakeScheduled = true;
      queueMicrotask(() => { recoveries += 1; });
    },
  };
  const reports: string[] = [];

  reportAssistantTerminalFailure(dispatcher, () => { reports.push("assistant notification"); });
  assert.throws(() => reportAssistantTerminalFailure(dispatcher, () => {
    reports.push("deferred assistant terminal");
    throw new Error("reporter failed");
  }), /reporter failed/u);
  await Promise.resolve();

  assert.deepEqual(reports, ["assistant notification", "deferred assistant terminal"]);
  assert.equal(recoveries, 1);
});

test("assistant notification failure before dispatcher construction still reports safely", () => {
  const reports: string[] = [];
  assert.doesNotThrow(() => reportAssistantTerminalFailure(undefined, () => {
    reports.push("assistant notification");
  }));
  assert.deepEqual(reports, ["assistant notification"]);
});

test("endpoint lifecycle recovery checkpoints require an exact phase and runtime identity", () => {
  const checkpoint = { endpoint: "devbox", phase: "runtime_started", identity: { kind: "ssh", token: "a".repeat(32), pid: 10, linuxStartTime: "20", processGroupId: 10 } };
  assert.deepEqual(parseEndpointLifecycleCheckpoint(checkpoint), checkpoint);
  assert.equal(parseEndpointLifecycleCheckpoint({ ...checkpoint, extra: true }), undefined);
  assert.equal(parseEndpointLifecycleCheckpoint({ ...checkpoint, phase: "unknown" }), undefined);
  assert.equal(parseEndpointLifecycleCheckpoint({ ...checkpoint, identity: { ...checkpoint.identity, token: "bad" } }), undefined);
});

test("removal recovery follows the checkpointed mapping generation across crash windows and nickname reuse", () => {
  const saved = { endpoint: "local", thread_id: "t1", project_dir: "/project", mapping_id: "mapping-old", lifecycle_state: "managed" as const };
  assert.equal(removalRecoveryDecision("unadopt_session", { ...saved, step: "prepared" }, { ...saved, lifecycle_state: "managed" }), "no_effect");
  assert.equal(removalRecoveryDecision("unadopt_session", { ...saved, step: "prepared" }, { ...saved, lifecycle_state: "unadopting" }), "reconcile");
  assert.equal(removalRecoveryDecision("archive_session", { ...saved, step: "prepared" }, { ...saved, lifecycle_state: "unadopting" }), "no_effect");
  assert.equal(removalRecoveryDecision("archive_session", { ...saved, step: "prepared" }, undefined), "no_effect");
  const archiveIntent = { ...saved, lifecycle_state: "archiving" as const, step: "transition_intent" };
  assert.equal(removalRecoveryDecision("archive_session", archiveIntent, { ...saved, lifecycle_state: "managed" }), "no_effect");
  assert.equal(removalRecoveryDecision("archive_session", archiveIntent, undefined), "succeeded");
  const archived = { ...saved, lifecycle_state: "archiving" as const, step: "transitioned" };
  assert.equal(removalRecoveryDecision("archive_session", archived, { ...saved, lifecycle_state: "archiving" }), "reconcile");
  assert.equal(removalRecoveryDecision("archive_session", archived, undefined), "succeeded");
  assert.equal(removalRecoveryDecision("archive_session", archived, { ...saved, mapping_id: "mapping-new", lifecycle_state: "managed" }), "succeeded");
  assert.equal(removalRecoveryDecision("archive_session", undefined, undefined), "no_effect");
});

test("live registry reload permits metadata edits but rejects every worker lifecycle mutation", () => {
  const worker = { endpoint: "local", thread_id: "t1", project_dir: "/project", mapping_id: "mapping-1", lifecycle_state: "managed" as const };
  const current = { version: 3 as const, assistant: { endpoint: "assistant", thread_id: "a1", project_dir: "/assistant" }, sessions: { worker } };
  assert.equal(registryReloadPreservesWorkerMappings(current, {
    ...current,
    assistant: { ...current.assistant, description: "updated metadata" },
  }), true);
  assert.equal(registryReloadPreservesWorkerMappings(current, { ...current, sessions: {} }), false);
  assert.equal(registryReloadPreservesWorkerMappings(current, {
    ...current,
    sessions: { worker: { ...worker, lifecycle_state: "archiving" } },
  }), false);
  assert.equal(registryReloadPreservesWorkerMappings(current, {
    ...current,
    sessions: { worker: { ...worker, mapping_id: "mapping-2" } },
  }), false);
});

test("production chat history resolves the immutable assistant-attempt binding", async () => {
  const binding = { adapterId: "slack", conversationKey: "slack:T1:dm:D1", destination: { workspaceId: "T1", channelId: "D1" } } as const;
  const seen: unknown[] = [];
  const registry = new ChatAdapterRegistry([{
    delivery: { id: "slack", sendMessage: async () => ({ ok: true }) },
    history: { getHistory: async (actualBinding, request) => { seen.push({ actualBinding, request }); return { messages: [] }; } },
  }]);
  const action = createChatHistoryAction(() => registry, (attemptId) => { assert.equal(attemptId, "attempt-1"); return binding; });
  assert.deepEqual(await action({ scope: "channel", count: 5 }, { attemptId: "attempt-1" }), { messages: [] });
  assert.deepEqual(seen, [{ actualBinding: binding, request: { scope: "channel", count: 5 } }]);
});

test("production relay work reuses the identical existing endpoint lease", async () => {
  const existing: EndpointWorkLease = { endpointId: "devbox", lifecycleGeneration: 3, endpointGeneration: 4, leaseId: "relay-existing" };
  const replacement: EndpointWorkLease = { endpointId: "devbox", lifecycleGeneration: 9, endpointGeneration: 9, leaseId: "must-not-replace" };
  const seen: unknown[] = [];
  const result = await withRelayEndpointWorkLease({
    runWithWorkLease: async (endpointId, actual, run) => {
      seen.push({ method: "existing", endpointId, actual });
      return run(actual);
    },
    withReadyWorkLease: async (endpointId, run) => {
      seen.push({ method: "ready", endpointId });
      return run(replacement);
    },
  }, "devbox", existing, async (actual) => {
    assert.equal(actual, existing);
    return "classified";
  });

  assert.equal(result, "classified");
  assert.deepEqual(seen, [{ method: "existing", endpointId: "devbox", actual: existing }]);
});

test("production shutdown drains blocked relay work before endpoint teardown", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const seen: string[] = [];
  const app = composeApp([
    {
      name: "endpoint",
      start: async () => undefined,
      stop: async () => { seen.push("endpoint"); },
    },
    {
      name: "reconciliation",
      start: async () => undefined,
      stop: () => stopRelayRecovery(
        { stop: async () => { seen.push("relay:start"); await blocked; seen.push("relay:end"); } },
        { idle: async () => { seen.push("observations"); } },
        async () => { seen.push("dashboard"); },
      ),
    },
  ]);
  await app.start();
  const stopping = app.stop();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.deepEqual(seen, ["relay:start"]);
  release();
  await stopping;
  assert.deepEqual(seen, ["relay:start", "relay:end", "observations", "dashboard", "endpoint"]);
});

test("production shutdown drains live ready recovery before every owner and endpoint", async () => {
  let signalStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const seen: string[] = [];
  const readyBuffer = createEndpointReadyBuffer({
    recover: async () => {
      seen.push("ready:start");
      signalStarted();
      await blocked;
      seen.push("ready:end");
    },
  });
  await readyBuffer.acceptAndDrain();
  const app = composeApp([
    { name: "endpoint", start: async () => undefined, stop: async () => { seen.push("endpoint"); } },
    {
      name: "recovery-owners",
      start: async () => undefined,
      stop: () => stopRecoveryOwnerSet({
        ready: readyBuffer,
        managed: { stop: async () => { seen.push("managed"); } },
        operations: { stop: async () => { seen.push("operations"); } },
        dispatcher: { stop: async () => { seen.push("dispatcher"); } },
        relay: { stop: async () => { seen.push("relay"); } },
        observations: { stop: async () => { seen.push("observations"); } },
      }),
    },
  ]);
  await app.start();
  const live = readyBuffer.ready("devbox");
  assert.ok(live);
  await started;
  const stopping = app.stop();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.deepEqual(seen, ["ready:start"]);
  assert.equal(readyBuffer.ready("other"), undefined, "shutdown rejects new ready work");
  release();
  await live;
  await stopping;
  assert.deepEqual(seen, ["ready:start", "ready:end", "managed", "relay", "observations", "operations", "dispatcher", "endpoint"]);
});

test("assistant startup failure drains every recovery owner before endpoint teardown", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const seen: string[] = [];
  const app = composeApp([
    { name: "endpoint", start: async () => undefined, stop: async () => { seen.push("endpoint"); } },
    {
      name: "recovery-owners",
      start: async () => undefined,
      stop: () => stopRecoveryOwnerSet({
        managed: { stop: async () => { seen.push("managed"); } },
        operations: { stop: async () => { seen.push("operations:start"); await blocked; seen.push("operations:end"); } },
        dispatcher: { stop: async () => { seen.push("dispatcher"); } },
        relay: { stop: async () => { seen.push("relay"); } },
        observations: { stop: async () => { seen.push("observations"); } },
        finishDashboard: async () => { seen.push("dashboard"); },
      }),
    },
    { name: "assistant", start: async () => { throw new Error("startup failed"); }, stop: async () => undefined },
  ]);
  const starting = app.start();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.deepEqual(seen, ["managed", "relay", "observations", "operations:start"]);
  release();
  await assert.rejects(starting);
  assert.deepEqual(seen, ["managed", "relay", "observations", "operations:start", "operations:end", "dispatcher", "dashboard", "endpoint"]);
});

test("recovery-owner cleanup settles later owners after an earlier cleanup fails", async () => {
  const seen: string[] = [];
  await assert.rejects(stopRecoveryOwnerSet({
    operations: { stop: async () => { seen.push("operations"); throw new Error("operation cleanup failed"); } },
    dispatcher: { stop: async () => { seen.push("dispatcher"); } },
    relay: { stop: async () => { seen.push("relay"); throw new Error("relay cleanup failed"); } },
    observations: { stop: async () => { seen.push("observations"); } },
    finishDashboard: async () => { seen.push("dashboard"); },
  }), /relay cleanup failed/u);
  assert.deepEqual(seen, ["relay", "observations", "operations", "dispatcher", "dashboard"]);
});

test("periodic lifecycle reconciliation supplies per-session failure isolation to both phases", async () => {
  const seen: unknown[] = [];
  const onError = async () => undefined;
  await reconcileLifecycleTransitions({
    reconcileAdopting: async (options) => { seen.push(options); },
    reconcileRemovals: async (options) => { seen.push(options); },
  }, onError);
  assert.deepEqual(seen, [{ onError }, { onError }]);
});

test("lifecycle recovery reconciles durable ownership completion after removal recovery", async () => {
  const seen: string[] = [];
  const registry = { getByIdentity: () => undefined };
  const inserted = await reconcileLifecycleAndOwnership(
    {
      reconcileAdopting: async () => { seen.push("adopting"); },
      reconcileRemovals: async () => { seen.push("removals"); },
    },
    async () => undefined,
    { reconcileReleased: (actual) => { assert.equal(actual, registry); seen.push("ownership-events"); return 1; } },
    registry,
  );
  assert.equal(inserted, 1);
  assert.deepEqual(seen, ["adopting", "removals", "ownership-events"]);
});

test("project reconciliation fences external ownership before reading authoritative history", async () => {
  const seen: string[] = [];
  await reconcileOwnershipBeforeRelay(
    {
      detectEndpoint: async (endpointId) => { seen.push(`detect:${endpointId}`); return []; },
      release: async () => { seen.push("release"); },
    },
    { reconcileEndpoint: async (endpointId) => { seen.push(`relay:${endpointId}`); } },
    "devbox",
  );
  assert.deepEqual(seen, ["detect:devbox", "relay:devbox", "detect:devbox", "release"]);
});

test("startup and reconnect reconciliation hold one endpoint generation lease across scan-read-scan", async () => {
  const lease: EndpointWorkLease = { endpointId: "devbox", lifecycleGeneration: 1, endpointGeneration: 2, leaseId: "lease-2" };
  const seen: unknown[] = [];
  await reconcileOwnershipBeforeRelayWithLease(
    { withWorkLease: async (endpointId, kind, run) => {
      seen.push({ endpointId, kind });
      return run({} as never, lease);
    } },
    {
      detectEndpoint: async (_endpointId, actualLease) => { seen.push(actualLease); return []; },
      release: async (_incidents, actualLease) => { seen.push(actualLease); },
    },
    { reconcileEndpoint: async (_endpointId, actualLease) => { seen.push(actualLease); } },
    "devbox",
  );
  assert.deepEqual(seen, [
    { endpointId: "devbox", kind: "rpc" },
    lease,
    lease,
    lease,
    lease,
  ]);
});

test("periodic managed recovery retries a session left unavailable by a transient ownership boundary", () => {
  assert.equal(managedSessionNeedsRecovery({ managementState: "unavailable" }, true), true);
  assert.equal(managedSessionNeedsRecovery({ managementState: "managed" }, true), false);
  assert.equal(managedSessionNeedsRecovery(undefined, true), false);
  assert.equal(managedSessionNeedsRecovery({ managementState: "managed" }, false), true);
});
