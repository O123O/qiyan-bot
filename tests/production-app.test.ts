import assert from "node:assert/strict";
import test from "node:test";
import {
  createOperationReconciliationLoop,
  createAttachmentCleanupOwner,
  createManagedSessionRecoveryOwner,
  createEndpointReadyBuffer,
  EndpointRecoveryIncidents,
  createDurableEventWakeBoundary,
  createDurableEventSourceCallbacks,
  createExternalOwnershipCycleReporter,
  createChatHistoryAction,
  hasEarlierEndpointOperation,
  hasEarlierSessionCreation,
  isMissingUnmaterializedThread,
  isSettledPathlessThreadLoss,
  isUncertainAssistantTransportFailure,
  managedRecoveryDisposition,
  managedRecoveryManagementState,
  managedRetryKey,
  managedSessionNeedsRecovery,
  markEndpointOwnersUnavailable,
  operationRecoveryAction,
  operationRecoveryFailureDisposition,
  operationRecoveryPreflight,
  recoverableCreateHasNoDispatch,
  projectReadyRecoveryDisposition,
  parseEndpointLifecycleCheckpoint,
  processWorkerTerminalNotification,
  stopOperationRecoveryBeforeTools,
  reconcileLifecycleAndOwnership,
  reconcileLifecycleTransitions,
  reconcileOwnershipBeforeRelay,
  reconcileOwnershipBeforeRelayWithLease,
  recoverManagedEndpointReady,
  recoverStartupManagedEndpoint,
  recoverReadyEndpointOwners,
  releaseRestoredOwnershipIncidents,
  recoverRemovalOperation,
  recoverableLifecycleEndpointReferences,
  recoverableOperationActivationReferences,
  recoverableOperationEndpointReferences,
  recoverableOperationTarget,
  removalRecoveryDecision,
  reportAssistantTerminalFailure,
  reportOperationalSafely,
  requestOperationRecoveryForAttempt,
  settleAssistantTerminalTools,
  startupProjectEndpointReferences,
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

test("every production durable event source forwards only successful inserts to one wake boundary", async () => {
  let accepting = false;
  let stopping = false;
  let enqueues = 0;
  let restarts = 0;
  const boundary = createDurableEventWakeBoundary({
    schedulerAccepting: () => accepting,
    stopping: () => stopping,
    enqueuePendingEvents: async () => { enqueues += 1; },
    requestRestart: () => { restarts += 1; },
  });
  const next = <T>(values: T[]) => (): T => {
    const value = values.shift();
    assert.notEqual(value, undefined);
    return value!;
  };
  const ownershipStatuses: string[] = [];
  const nextOwnership = next([true, false, true, false]);
  const nextLifecycle = next([1, 0]);
  const sources = createDurableEventSourceCallbacks({
    wakeAfterDurableCommit: boundary.wakeAfterDurableCommit,
    persistDeliveryState: next([true, true, false]),
    reconcileDeliveryStates: next([1, 0]),
    recordOwnership: (_incident, status) => {
      ownershipStatuses.push(status);
      return nextOwnership();
    },
    reconcileOwnership: next([1, 0]),
    persistEndpointUnavailable: next([true, false]),
    recordBackgroundFailure: () => undefined,
    reconcileLifecycle: async () => nextLifecycle(),
  });
  const delivery = { id: "delivery" } as never;
  const incident = { endpoint: "project", thread_id: "thread", mapping_id: "mapping", turnId: "turn", nickname: "worker" };
  const endpointEvent = { id: "endpoint:1", endpointId: "project", threadId: "assistant", incident: 1, createdAt: 1 };

  await sources.deliveryState(delivery);
  assert.equal(enqueues, 0, "startup enqueue owns commits made before scheduler acceptance");
  assert.equal(restarts, 0);

  accepting = true;
  const awaitedSources: Array<() => Promise<unknown>> = [
    () => sources.relayCommitted(),
    () => sources.deliveryState(delivery),
    () => sources.deliveryState(delivery),
    () => sources.reconcileDeliveryStates(),
    () => sources.reconcileDeliveryStates(),
    () => sources.ownership(incident, "pending"),
    () => sources.ownership(incident, "pending"),
    () => sources.ownership(incident, "completed"),
    () => sources.ownership(incident, "completed"),
    () => sources.reconcileOwnership(),
    () => sources.reconcileOwnership(),
    () => sources.endpointUnavailable(endpointEvent),
    () => sources.endpointUnavailable(endpointEvent),
    () => sources.reconcileLifecycle({ endpointId: "project" }),
    () => sources.reconcileLifecycle({ endpointId: "project" }),
  ];
  const expectedEnqueues = [1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8];
  for (const [index, invoke] of awaitedSources.entries()) {
    await invoke();
    assert.equal(enqueues, expectedEnqueues[index], `source ${index} forwards its exact insertion result`);
  }
  sources.backgroundFailure({ id: "background:1", label: "fixed", incident: 1 });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(enqueues, 9);
  assert.deepEqual(ownershipStatuses, ["pending", "pending", "completed", "completed"]);
  stopping = true;
  await sources.relayCommitted();
  assert.equal(enqueues, 9);
  assert.equal(restarts, 0);
});

test("all production event sources share one restart after asynchronous wake loss", async () => {
  let restarts = 0;
  let dispatcherCalls = 0;
  const dispatcher = {
    enqueueInternal: async (kind: string): Promise<void> => {
      assert.equal(kind, "events");
      dispatcherCalls += 1;
      await Promise.resolve();
      throw new Error("asynchronous dispatcher rejection");
    },
  };
  const boundary = createDurableEventWakeBoundary({
    schedulerAccepting: () => true,
    stopping: () => false,
    enqueuePendingEvents: () => dispatcher.enqueueInternal("events"),
    requestRestart: () => { restarts += 1; },
  });
  const sources = createDurableEventSourceCallbacks({
    wakeAfterDurableCommit: boundary.wakeAfterDurableCommit,
    persistDeliveryState: () => true,
    reconcileDeliveryStates: () => 1,
    recordOwnership: () => true,
    reconcileOwnership: () => 1,
    persistEndpointUnavailable: () => true,
    recordBackgroundFailure: () => undefined,
    reconcileLifecycle: async () => 1,
  });
  const delivery = { id: "delivery" } as never;
  const incident = { endpoint: "project", thread_id: "thread", mapping_id: "mapping", turnId: "turn", nickname: "worker" };
  const endpointEvent = { id: "endpoint:1", endpointId: "project", threadId: "assistant", incident: 1, createdAt: 1 };

  await sources.relayCommitted();
  assert.equal(restarts, 1, "the first lost wake requests restart without later traffic");
  await sources.deliveryState(delivery);
  await sources.reconcileDeliveryStates();
  await sources.ownership(incident, "pending");
  await sources.ownership(incident, "completed");
  await sources.reconcileOwnership();
  await sources.endpointUnavailable(endpointEvent);
  await sources.reconcileLifecycle({ endpointId: "project" });
  sources.backgroundFailure({ id: "background:1", label: "fixed", incident: 1 });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(dispatcherCalls, 9);
  assert.equal(restarts, 1);
});

test("successful durable event wake settles only after enqueueInternal settles", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let settled = false;
  const boundary = createDurableEventWakeBoundary({
    schedulerAccepting: () => true,
    stopping: () => false,
    enqueuePendingEvents: async () => { await barrier; },
    requestRestart: () => { throw new Error("unexpected restart"); },
  });

  const waking = boundary.wakeAfterDurableCommit(true).then(() => { settled = true; });
  try {
    await Promise.resolve();
    assert.equal(settled, false);
  } finally {
    release();
  }
  await waking;
  assert.equal(settled, true);
});

test("operation recovery waits only for the exact in-process tool handler", () => {
  assert.equal(operationRecoveryAction({ state: "dispatched", activeHandler: true }), "wait_for_tool");
  assert.equal(operationRecoveryAction({ state: "uncertain", activeHandler: true }), "wait_for_tool");
  assert.equal(operationRecoveryAction({ state: "dispatched", activeHandler: true, recoveryOwned: true }), "wait_for_tool");
  assert.equal(operationRecoveryAction({ state: "uncertain", activeHandler: true, recoveryOwned: true }), "attempt");
  assert.equal(operationRecoveryAction({ state: "uncertain", activeHandler: false }), "attempt");
  assert.equal(operationRecoveryAction({ state: "dispatched", activeHandler: false }), "attempt");
});

test("shutdown stops operation waits before waiting for MCP handlers", async () => {
  const events: string[] = [];
  let releaseRecovery!: () => void;
  const recoveryStopped = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  const stopping = stopOperationRecoveryBeforeTools({
    stopOperationRecovery: () => { events.push("operation:stop"); return recoveryStopped; },
    waitForTools: async () => { events.push("tools:wait"); releaseRecovery(); },
  });
  await stopping;
  assert.deepEqual(events, ["operation:stop", "tools:wait"]);

  let releaseTools!: () => void;
  const toolsFinished = new Promise<void>((resolve) => { releaseTools = resolve; });
  const rejected = stopOperationRecoveryBeforeTools({
    stopOperationRecovery: async () => { throw new Error("recovery stop failed"); },
    waitForTools: () => toolsFinished,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseTools();
  await assert.rejects(rejected, /recovery stop failed/u);
});

test("create recovery terminalizes only exact no-dispatch and lost-empty-thread proofs", () => {
  assert.equal(recoverableCreateHasNoDispatch(undefined, 1), true);
  assert.equal(recoverableCreateHasNoDispatch(undefined, 0), false);
  assert.equal(recoverableCreateHasNoDispatch({ dispatchStarted: false }, 0), true);
  assert.equal(recoverableCreateHasNoDispatch({ dispatchStarted: true }, 1), false);
  assert.equal(recoverableCreateHasNoDispatch({}, 1), false);
  assert.equal(recoverableCreateHasNoDispatch(null, 1), false);

  const exact = new AppError("THREAD_NOT_FOUND", "thread is no longer restorable", {
    recovery: "thread_not_durable", threadId: "thread-1",
  });
  assert.equal(isMissingUnmaterializedThread(exact, "thread-1"), true);
  assert.equal(isMissingUnmaterializedThread(exact, "thread-2"), false);
  assert.equal(isMissingUnmaterializedThread(new AppError("THREAD_NOT_FOUND", "other absence"), "thread-1"), false);
  assert.equal(isMissingUnmaterializedThread(new Error("thread_not_durable: thread-1"), "thread-1"), false);
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
  assert.deepEqual(target("create_session", { endpoint: "endpoint-a" }, { endpoint: "endpoint-a", dispatchStarted: false }), { policy: "local" });
  assert.deepEqual(target("create_session", { endpoint: "endpoint-a" }, { endpoint: "endpoint-b", dispatchStarted: true }), { policy: "ready_endpoint", endpointId: "endpoint-b" });
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
    { kind: "create_session", args: { endpoint: "endpoint-a" }, receipt: { endpoint: "endpoint-a", dispatchStarted: false } },
    { kind: "create_session", args: {}, receipt: undefined },
    { kind: "restart_endpoint", args: { endpoint: "endpoint-b" }, receipt: undefined },
    { kind: "future_operation", args: { endpoint: "endpoint-a" }, receipt: undefined },
    { kind: "adopt_session", args: { endpoint: "endpoint-b" }, receipt: undefined },
  ], resolve), ["endpoint-b"]);
  assert.deepEqual(recoverableOperationActivationReferences([
    { kind: "create_session", args: { endpoint: "endpoint-a" }, receipt: { endpoint: "endpoint-a", dispatchStarted: false } },
    { kind: "restart_endpoint", args: { endpoint: "endpoint-b" }, receipt: undefined },
    { kind: "disconnect_endpoint", args: { endpoint: "endpoint-a" }, receipt: undefined },
    { kind: "future_operation", args: { endpoint: "endpoint-a" }, receipt: undefined },
  ], resolve), []);
  assert.deepEqual(recoverableOperationEndpointReferences([
    { kind: "restart_endpoint", args: { endpoint: "endpoint-a" }, receipt: undefined },
  ], resolve), ["endpoint-a"], "lifecycle targets pin identity without eager activation");
  assert.deepEqual(recoverableLifecycleEndpointReferences([
    { kind: "create_session", args: { endpoint: "endpoint-a" }, receipt: { endpoint: "endpoint-a", dispatchStarted: false } },
    { kind: "disconnect_endpoint", args: {}, receipt: undefined },
    { kind: "restart_endpoint", args: { endpoint: "endpoint-a" }, receipt: undefined },
  ], resolve), ["endpoint-a", "local"]);
});

test("a proven no-dispatch create recovery terminalizes without an endpoint lease", async () => {
  const store = new OperationStore(createTestDatabase());
  const operation = store.prepare({
    contextId: "ctx", attemptId: "attempt", callId: "call", kind: "create_session",
    args: { nickname: "worker", endpoint: "devbox", project_dir: "/project" },
  });
  store.markDispatched(operation.id);
  store.checkpoint(operation.id, { endpoint: "devbox", mappingId: "mapping", dispatchStarted: false });
  const recovered = store.listRecoverable()[0]!;
  const target = recoverableOperationTarget(recovered, { defaultProjectEndpointId: "local", session: () => undefined });
  let endpointCalls = 0;

  await runOperationRecoveryTarget(target, {
    withReadyWorkLease: async () => { endpointCalls += 1; throw new Error("endpoint must not be touched"); },
  } as never, async () => {
    store.failAndUnbind(operation.id, { message: "worker dispatch was never started" });
  });

  assert.equal(endpointCalls, 0);
  assert.equal(store.get(operation.id)?.state, "failed");
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

test("startup requires only durably referenced project endpoints", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const localCreate = operations.prepare({
    contextId: "ctx", attemptId: "attempt", callId: "local-create", kind: "create_session",
    args: { nickname: "local-worker", project_dir: "/project" },
  });
  operations.markDispatched(localCreate.id);
  operations.checkpoint(localCreate.id, {
    endpoint: "local", dispatchStarted: true, projectDir: "/project",
  });
  const operationEndpointIds = recoverableOperationActivationReferences(operations.listRecoverable(), {
    defaultProjectEndpointId: "local",
    session: () => undefined,
  });

  assert.deepEqual(startupProjectEndpointReferences({
    sessionEndpoints: [],
    recoveredEndpointIds: [],
    operationEndpointIds,
    lifecycleOwnedEndpointIds: new Set(),
    assistantEndpointId: "assistant-local",
  }), ["local"], "an uncertain local creation is a durable startup reference");

  assert.deepEqual(startupProjectEndpointReferences({
    sessionEndpoints: ["local", "devbox", "devbox"],
    recoveredEndpointIds: ["recovery-box"],
    operationEndpointIds: ["operation-box", "assistant-local", ...operationEndpointIds],
    lifecycleOwnedEndpointIds: new Set(["recovery-box"]),
    assistantEndpointId: "assistant-local",
  }), ["local", "devbox", "operation-box"], "durable references activate once unless lifecycle recovery owns them");

  db.close();
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

  const uncertainCreateBeforeRestart = [
    entry("create-a", 1, "ready_endpoint", "a"),
    entry("restart-a", 2, "endpoint_lifecycle", "a"),
    entry("ordinary-b", 3, "ready_endpoint", "b"),
  ];
  const fencedSeen: string[] = [];
  await runOperationRecoveryChains(uncertainCreateBeforeRestart, (item) => item.target, async ({ operation }) => {
    fencedSeen.push(operation.id);
    return operation.id === "create-a";
  });
  assert.deepEqual(fencedSeen, ["create-a", "ordinary-b"], "a later restart cannot overtake an earlier uncertain create");

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

test("terminalizing a proven no-effect operation lets the next same-endpoint recovery run", async () => {
  const store = new OperationStore(createTestDatabase());
  const first = store.prepare({ contextId: "ctx", attemptId: "attempt", callId: "first", kind: "create_session", args: {} });
  const second = store.prepare({ contextId: "ctx", attemptId: "attempt", callId: "second", kind: "create_session", args: {} });
  store.markDispatched(first.id);
  store.markDispatched(second.id);
  const seen: string[] = [];

  await runOperationRecoveryChains(
    store.listRecoverable().map((operation) => ({ operation })),
    () => ({ policy: "ready_endpoint", endpointId: "devbox" }),
    async ({ operation }) => {
      seen.push(operation.id);
      if (operation.id === first.id) store.failAndUnbind(operation.id, { message: "proven no effect" });
      return store.get(operation.id)?.state === "dispatched" || store.get(operation.id)?.state === "uncertain";
    },
  );

  assert.deepEqual(seen, [first.id, second.id]);
  assert.equal(store.get(first.id)?.state, "failed");
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
  assert.equal(operationRecoveryFailureDisposition(new RpcRequestTimeoutError("thread/read"), ordinaryTarget, false), "wait_for_endpoint");
  assert.equal(operationRecoveryFailureDisposition(new RpcRequestTimeoutError("thread/read"), ordinaryTarget, true), "retry");
  assert.equal(operationRecoveryFailureDisposition(new AppError("OPERATION_UNCERTAIN", "temporary", { recovery: "ownership_unclassified" })), "retry");
  assert.equal(operationRecoveryFailureDisposition(
    new AppError("OPERATION_UNCERTAIN", "temporary", { recovery: "ownership_unclassified" }), ordinaryTarget, false,
  ), "wait_for_endpoint");
  assert.equal(operationRecoveryFailureDisposition(new AppError("ENDPOINT_UNAVAILABLE", "offline"), lifecycleTarget), "retry");
  assert.equal(operationRecoveryFailureDisposition(new AppError("ENDPOINT_UNAVAILABLE", "offline"), ordinaryTarget), "wait_for_endpoint");
  assert.equal(operationRecoveryFailureDisposition(new AppError("ENDPOINT_UNAVAILABLE", "helper"), ordinaryTarget, true), "retry");
  assert.equal(operationRecoveryFailureDisposition(new AppError("OPERATION_UNCERTAIN", "permanent")), "sleep");
  assert.equal(operationRecoveryFailureDisposition(new Error("unknown")), "sleep");
});

test("project ready failures retry only the exact still-current generation and never require process restart", () => {
  const endpointFailure = new AppError("ENDPOINT_UNAVAILABLE", "workspace helper failed");
  assert.equal(projectReadyRecoveryDisposition(endpointFailure, 4, {
    generation: 4, ready: true, automatic: true,
  }), "retry");
  assert.equal(projectReadyRecoveryDisposition(endpointFailure, 4, {
    generation: 5, ready: true, automatic: true,
  }), "publication");
  assert.equal(projectReadyRecoveryDisposition(endpointFailure, 4, {
    generation: 4, ready: true, automatic: false,
  }), "publication");
  assert.equal(projectReadyRecoveryDisposition(new Error("permanent project failure"), 4, {
    generation: 4, ready: true, automatic: true,
  }), "retain");
  assert.equal(projectReadyRecoveryDisposition(new RpcRequestTimeoutError("thread/read"), 4, {
    generation: 4, ready: true, automatic: true,
  }), "retry");
});

test("durable overlap fences are endpoint-sequenced and nickname/thread exact", () => {
  const resolver = { defaultProjectEndpointId: "local", session: () => undefined };
  const operations = [
    {
      sequence: 1, kind: "create_session", args: { nickname: "worker", endpoint: "endpoint-a" },
      receipt: { endpoint: "endpoint-a", threadId: "thread-a" },
    },
    {
      sequence: 2, kind: "adopt_session", args: { nickname: "other", endpoint: "endpoint-a", thread_id: "thread-b" },
      receipt: { endpoint: "endpoint-a", threadId: "thread-b" },
    },
  ];

  assert.equal(hasEarlierEndpointOperation(operations, 3, "endpoint-a", resolver), true);
  assert.equal(hasEarlierEndpointOperation(operations, 3, "endpoint-b", resolver), false);
  assert.equal(hasEarlierSessionCreation(operations, 3, {
    nickname: "worker", endpointId: "endpoint-b", threadId: "new-thread",
  }, resolver), true, "nickname identity is global across endpoints");
  assert.equal(hasEarlierSessionCreation(operations, 3, {
    nickname: "third", endpointId: "endpoint-a", threadId: "thread-b",
  }, resolver), true, "native endpoint/thread identity cannot be adopted twice");
  assert.equal(hasEarlierSessionCreation(operations, 3, {
    nickname: "third", endpointId: "endpoint-b", threadId: "thread-c",
  }, resolver), false);
});

test("reconnection incidents compare-delete per endpoint and preserve a newer loss", () => {
  const incidents = new EndpointRecoveryIncidents();
  assert.equal(incidents.pending("endpoint-a"), undefined, "initial activation has no recovery incident");
  const first = incidents.record("endpoint-a");
  const other = incidents.record("endpoint-b");
  assert.equal(incidents.pending("endpoint-a"), first);
  assert.equal(incidents.pending("endpoint-b"), other);
  const newer = incidents.record("endpoint-a");
  assert.equal(incidents.consume("endpoint-a", first), false);
  assert.equal(incidents.pending("endpoint-a"), newer);
  assert.equal(incidents.consume("endpoint-a", newer), true);
  assert.equal(incidents.pending("endpoint-a"), undefined);
  assert.equal(incidents.pending("endpoint-b"), other);
});

test("managed recovery uses only source-specific transient and external dispositions", () => {
  assert.equal(managedRecoveryDisposition(new RpcRequestTimeoutError("thread/read")), "retry");
  assert.equal(managedRecoveryDisposition(new AppError("ENDPOINT_UNAVAILABLE", "x")), "endpoint");
  assert.equal(managedRecoveryDisposition(new AppError("ENDPOINT_UNAVAILABLE", "x"), true), "retry");
  assert.equal(managedRecoveryDisposition(new AppError("OPERATION_UNCERTAIN", "x", { recovery: "ownership_unclassified" })), "retry");
  assert.equal(managedRecoveryDisposition(new AppError("SESSION_BUSY", "x", { recovery: "external_turn" })), "external");
  assert.equal(managedRecoveryDisposition(new AppError("OPERATION_UNCERTAIN", "changed rollout path")), "permanent");
  assert.equal(managedRecoveryDisposition(new AppError("CWD_MISMATCH", "x")), "permanent");
  assert.equal(managedRecoveryDisposition(new Error("unknown")), "permanent");
  assert.equal(managedRecoveryManagementState("unavailable", "external"), "managed");
  assert.equal(managedRecoveryManagementState("unadopting", "external"), "unadopting");
  assert.equal(managedRecoveryManagementState("managed", "retry"), "unavailable");
});

test("pathless thread loss is settled only after the exact registry generation is removed", () => {
  const expected = {
    endpoint: "endpoint-a",
    thread_id: "thread-a",
    project_dir: "/project",
    mapping_id: "mapping-a",
    lifecycle_state: "managed" as const,
  };
  const lost = new AppError("THREAD_NOT_FOUND", "lost", { recovery: "pathless_thread_lost" });

  assert.equal(isSettledPathlessThreadLoss(lost, undefined, expected), true);
  assert.equal(isSettledPathlessThreadLoss(lost, { ...expected, mapping_id: "mapping-b" }, expected), true);
  assert.equal(isSettledPathlessThreadLoss(lost, expected, expected), false);
  assert.equal(isSettledPathlessThreadLoss(new AppError("THREAD_NOT_FOUND", "ordinary"), undefined, expected), false);
});

test("managed endpoint-ready composition supplies any shared wake the owner has not completed", async () => {
  const lease: EndpointWorkLease = { endpointId: "endpoint-a", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "ready" };
  for (const [recovery, sharedWake, expectedFallbacks, expectedSharedWake] of [
    ["none", "needed", 1, "completed"],
    ["pending", "needed", 1, "completed"],
    ["pending", "completed", 0, "completed"],
    ["completed", "completed", 0, "completed"],
    ["pending", "stale", 0, "stale"],
  ] as const) {
    let fallbacks = 0;
    const result = await recoverManagedEndpointReady({
      endpointReady: async () => ({ recovery, sharedWake }),
    }, "endpoint-a", lease, async () => { fallbacks += 1; });
    assert.deepEqual(result, { recovery, sharedWake: expectedSharedWake });
    assert.equal(fallbacks, expectedFallbacks, `${recovery}:${sharedWake}`);
  }
});

test("ready endpoint recovery wakes each owner once and reconciles operations after shared work", async () => {
  const calls: string[] = [];
  let readyLeaseHeld = false;
  await recoverReadyEndpointOwners({
    recoverManaged: async (wakeShared) => {
      calls.push("managed");
      readyLeaseHeld = true;
      try {
        await wakeShared();
        await wakeShared();
        return { recovery: "completed", sharedWake: "completed" };
      } finally { readyLeaseHeld = false; }
    },
    relay: async () => { calls.push("relay"); },
    observations: async () => { calls.push("observations"); },
    operations: async () => {
      assert.equal(readyLeaseHeld, false, "endpoint lifecycle recovery runs only after ready work releases");
      calls.push("operations");
    },
    onError: () => assert.fail("unexpected endpoint owner failure"),
  });
  assert.deepEqual(calls, ["managed", "relay", "observations", "operations"]);
});

test("ready endpoint recovery isolates downstream owner failures and still reaches later owners", async () => {
  const calls: string[] = [];
  await recoverReadyEndpointOwners({
    recoverManaged: async () => {
      calls.push("managed");
      return { recovery: "none", sharedWake: "needed" };
    },
    relay: async () => { calls.push("relay"); throw new Error("relay failed"); },
    observations: async () => { calls.push("observations"); throw new Error("observations failed"); },
    operations: async () => { calls.push("operations"); throw new Error("operations failed"); },
    onError: (owner) => { calls.push(`error:${owner}`); },
  });
  assert.deepEqual(calls, [
    "managed",
    "relay", "error:relay",
    "observations", "error:observations",
    "operations", "error:operations",
  ]);
});

test("ready-generation loss remains buffered without a process restart or recovered publication", async () => {
  const listeners = () => () => undefined;
  let endpointState: "stopped" | "ready" | "unavailable" = "stopped";
  const endpoint = {
    id: "local",
    get state() { return endpointState; },
    start: async () => { endpointState = "ready"; },
    closeConnection: async () => { endpointState = "stopped"; },
    shutdownRuntime: async () => { endpointState = "stopped"; },
    runtimeIdentity: async () => ({ kind: "local" as const, pid: 1, startTime: "1" }),
    request: async () => ({}),
    onNotification: listeners,
    onReady: listeners,
    onUnavailable: listeners,
    onPermissionBlocked: listeners,
  };
  const manager = new EndpointManager({
    localEndpoint: endpoint as never,
    catalog: { reload: async () => undefined, require: () => { throw new Error("unexpected remote endpoint"); } },
    createRemote: async () => { throw new Error("unexpected remote endpoint"); },
    hasIdentityReferences: () => true,
    managedThreadIds: () => [],
  });
  await manager.ensureReady("local");

  let managedAdmissions = 0;
  let recoveredPublications = 0;
  let restarts = 0;
  const readyBuffer = createEndpointReadyBuffer({
    recover: async (endpointId) => {
      try {
        await recoverReadyEndpointOwners({
          recoverManaged: (wakeShared) => manager.withReadyWorkLease(endpointId, async () => {
            managedAdmissions += 1;
            await wakeShared();
            return { recovery: "completed", sharedWake: "completed" };
          }),
          relay: async () => undefined,
          observations: async () => undefined,
          operations: async () => undefined,
          onError: () => undefined,
        });
        recoveredPublications += 1;
      } catch (error) {
        assert.equal(projectReadyRecoveryDisposition(error, 1, {
          generation: 1, ready: endpointState === "ready", automatic: true,
        }), "publication");
        throw error;
      }
    },
  });
  readyBuffer.ready("local");
  endpointState = "unavailable";

  await assert.rejects(
    readyBuffer.acceptAndDrain(),
    (error: unknown) => error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE",
  );
  assert.deepEqual({ managedAdmissions, recoveredPublications, restarts }, {
    managedAdmissions: 0,
    recoveredPublications: 0,
    restarts: 0,
  });
});

test("endpoint loss notifies only the four local recovery owners", () => {
  const calls: string[] = [];
  markEndpointOwnersUnavailable({
    relay: { endpointUnavailable: (endpointId) => { calls.push(`relay:${endpointId}`); } },
    observations: { endpointUnavailable: (endpointId) => { calls.push(`observations:${endpointId}`); } },
    managed: { endpointUnavailable: (endpointId) => { calls.push(`managed:${endpointId}`); } },
    operations: { endpointUnavailable: (endpointId) => { calls.push(`operations:${endpointId}`); } },
  }, "endpoint-a");
  assert.deepEqual(calls, [
    "relay:endpoint-a", "observations:endpoint-a", "managed:endpoint-a", "operations:endpoint-a",
  ]);
});

test("external ownership degradation warns on the third failed cycle and resets after success", () => {
  const warnings: string[] = [];
  const reportCycle = createExternalOwnershipCycleReporter({
    runId: "ownership-test",
    onOperational: () => undefined,
    onDegraded: (notice) => { warnings.push(notice.id); },
  });
  const failed = [{ endpointId: "endpoint-a", outcome: "failed" as const }];
  const succeeded = [{ endpointId: "endpoint-a", outcome: "succeeded" as const }];
  const inconclusive = [{ endpointId: "endpoint-a", outcome: "inconclusive" as const }];

  reportCycle(failed);
  reportCycle(failed);
  reportCycle(failed);
  reportCycle(failed);
  reportCycle(inconclusive);
  assert.deepEqual(warnings, ["background-failure:ownership-test:1"]);
  reportCycle(succeeded);
  reportCycle(failed);
  reportCycle(failed);
  reportCycle(failed);
  assert.deepEqual(warnings, ["background-failure:ownership-test:1", "background-failure:ownership-test:2"]);
});

test("production attachment cleanup reports bounded metadata and keeps its daily retry after a throwing sink", async () => {
  type Timer = { callback: () => void; delay: number };
  const timers: Timer[] = [];
  const reports: unknown[] = [];
  const db = createTestDatabase();
  let attempts = 0;
  const cleanup = createAttachmentCleanupOwner(
    async () => { attempts += 1; throw new Error("private attachment path"); },
    (event) => { reports.push(event); throw new Error("private reporting failure"); },
    {
      setTimeout: (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer as never;
      },
      clearTimeout: () => undefined,
    },
  );

  await cleanup.start();
  assert.equal(attempts, 1);
  assert.deepEqual(reports, [{ level: "warn", code: "background_task_failed", component: "attachment_cleanup" }]);
  assert.equal(timers[0]?.delay, 24 * 60 * 60_000);
  timers.shift()!.callback();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(attempts, 2);
  assert.equal(reports.length, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM deliveries").get()!.count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events").get()!.count, 0);
  await cleanup.stop();
});

test("managed pending failures still wake unrelated shared owners exactly once per ready generation", async () => {
  const lease: EndpointWorkLease = { endpointId: "endpoint-a", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "shared-independent" };
  const retryKey = managedRetryKey("endpoint-a", "thread-retry", "mapping-retry");
  const endpointKey = managedRetryKey("endpoint-a", "thread-endpoint", "mapping-endpoint");
  let recoveries = 0;
  const shared: string[] = [];
  const wakeOwners = (owner: "managed" | "unrelated"): Promise<void> => wakeRestoredSessionOwners({
    relay: { endpointReady: async () => { shared.push(`${owner}:relay`); } },
    observations: { endpointReady: async () => { shared.push(`${owner}:observations`); } },
    onError: () => assert.fail("unexpected shared owner failure"),
  }, "endpoint-a", lease);
  const owner = createManagedSessionRecoveryOwner({
    endpoints: { withReadyWorkLease: async (_endpointId, run) => run(lease) },
    isLeaseCurrent: () => true,
    recover: async (_endpointId, keys) => {
      recoveries += 1;
      return recoveries === 1
        ? {
            restored: false,
            restoredKeys: [],
            settledKeys: [],
            failures: [
              { key: retryKey, disposition: "retry" as const },
              { key: endpointKey, disposition: "endpoint" as const },
            ],
          }
        : { restored: true, restoredKeys: keys, settledKeys: [], failures: [] };
    },
    beforeShared: async () => [],
    wakeShared: async () => wakeOwners("managed"),
    afterShared: async () => undefined,
    onSafetyFailure: () => assert.fail("unexpected safety failure"),
    onError: () => undefined,
  });
  owner.recordFailure(retryKey, "endpoint");
  owner.recordFailure(endpointKey, "endpoint");
  const wakeUnrelated = (): Promise<void> => wakeOwners("unrelated");

  assert.deepEqual(
    await recoverManagedEndpointReady(owner, "endpoint-a", lease, wakeUnrelated),
    { recovery: "pending", sharedWake: "completed" },
  );
  assert.deepEqual(shared, ["unrelated:relay", "unrelated:observations"]);

  assert.deepEqual(
    await recoverManagedEndpointReady(owner, "endpoint-a", lease, wakeUnrelated),
    { recovery: "completed", sharedWake: "completed" },
  );
  assert.deepEqual(shared, [
    "unrelated:relay", "unrelated:observations",
    "managed:relay", "managed:observations",
  ]);
  await owner.stop();
});

test("after-stage retry retains the first ownership receipt and releases it exactly once", async () => {
  type Timer = { callback: () => void };
  const timers: Timer[] = [];
  const lease: EndpointWorkLease = { endpointId: "endpoint-a", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "incident-retry" };
  const key = managedRetryKey("endpoint-a", "thread-a", "mapping-a");
  const firstIncident = {
    nickname: "payments", endpoint: "endpoint-a", thread_id: "thread-a", mapping_id: "mapping-a", turnId: "turn-external",
  };
  let beforeScans = 0;
  let sharedWakes = 0;
  let afterScans = 0;
  const released: string[] = [];
  const owner = createManagedSessionRecoveryOwner({
    endpoints: { withReadyWorkLease: async (_endpointId, run) => run(lease) },
    isLeaseCurrent: () => true,
    recover: async (_endpointId, keys) => ({ restored: true, restoredKeys: keys, settledKeys: [], failures: [] }),
    beforeShared: async () => { beforeScans += 1; return [firstIncident, firstIncident]; },
    wakeShared: async () => { sharedWakes += 1; },
    afterShared: (endpointId, actualLease, beforeIncidents, isCurrent) => releaseRestoredOwnershipIncidents({
      ownership: {
        detectEndpoint: async () => { afterScans += 1; return []; },
        release: async (incidents) => {
          assert.deepEqual(incidents, [firstIncident], "the empty later scan cannot erase or duplicate the first receipt");
          if (afterScans === 1) throw new RpcRequestTimeoutError("release-before-commit");
          released.push(...incidents.map((incident) => incident.turnId));
        },
      },
    }, endpointId, actualLease, beforeIncidents, isCurrent),
    onSafetyFailure: () => assert.fail("unexpected safety failure"),
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

  assert.deepEqual(await owner.endpointReady("endpoint-a", lease), { recovery: "pending", sharedWake: "completed" });
  assert.equal(timers.length, 1);
  timers[0]!.callback();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(beforeScans, 1);
  assert.equal(sharedWakes, 1);
  assert.equal(afterScans, 2);
  assert.deepEqual(released, ["turn-external"]);
  assert.deepEqual(await owner.endpointReady("endpoint-a", lease), { recovery: "none", sharedWake: "needed" });
  await owner.stop();
});

test("endpoint loss during a blocked relay wake fences observations and ownership release", async () => {
  const lease: EndpointWorkLease = { endpointId: "endpoint-a", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "blocked-relay" };
  const key = managedRetryKey("endpoint-a", "thread-a", "mapping-a");
  const incident = {
    nickname: "payments", endpoint: "endpoint-a", thread_id: "thread-a", mapping_id: "mapping-a", turnId: "turn-external",
  };
  let relayStarted!: () => void;
  let releaseRelay!: () => void;
  const started = new Promise<void>((resolve) => { relayStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseRelay = resolve; });
  let observations = 0;
  let after = 0;
  const owner = createManagedSessionRecoveryOwner({
    endpoints: { withReadyWorkLease: async (_endpointId, run) => run(lease) },
    isLeaseCurrent: () => true,
    recover: async (_endpointId, keys) => ({ restored: true, restoredKeys: keys, settledKeys: [], failures: [] }),
    beforeShared: async () => [incident],
    wakeShared: async (endpointId, actualLease, isCurrent) => wakeRestoredSessionOwners({
      relay: { endpointReady: async () => { relayStarted(); await blocked; } },
      observations: { endpointReady: async () => { observations += 1; } },
      onError: () => assert.fail("unexpected shared owner failure"),
    }, endpointId, actualLease, isCurrent),
    afterShared: async () => { after += 1; },
    onSafetyFailure: () => assert.fail("unexpected safety failure"),
    onError: () => undefined,
  });
  owner.recordFailure(key, "endpoint");

  const recovering = owner.endpointReady("endpoint-a", lease);
  await started;
  owner.endpointUnavailable("endpoint-a");
  releaseRelay();

  assert.deepEqual(await recovering, { recovery: "pending", sharedWake: "stale" });
  assert.equal(observations, 0);
  assert.equal(after, 0);
  await owner.stop();
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
    beforeShared: async () => [],
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
    beforeShared: async () => [],
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
    beforeShared: async () => [],
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
      return [];
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

  const first = await recoverManagedEndpointReady(owner, "endpoint-a", lease, async () => { helperCalls += 1; });
  assert.deepEqual(first, { recovery: "pending", sharedWake: "completed" });
  assert.equal(timers.length, 1, "a classified pre-helper timeout retains a downstream retry");
  timers[0]!.callback();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(beforeCalls, 2);
  assert.equal(helperCalls, 1, "the timer retry acknowledges the successful independent shared wake");
  assert.equal(afterCalls, 1);
  assert.equal(timers.length, 2, "a current-generation helper failure keeps endpoint-local retry ownership");
  timers[1]!.callback();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(afterCalls, 2);

  const final = await owner.endpointReady("endpoint-a", lease);
  assert.deepEqual(final, { recovery: "none", sharedWake: "needed" });
  assert.equal(recoveries, 1, "downstream retry never re-runs a healthy managed mapping");
  assert.equal(beforeCalls, 2);
  assert.equal(helperCalls, 1, "pre- and post-helper retries do not duplicate relay or observation wakes");
  assert.equal(afterCalls, 2);
  await owner.stop();
});

test("a fallback shared wake blocks its retry timer until the wake receipt is recorded", async () => {
  type Timer = { callback: () => void };
  const timers: Timer[] = [];
  const key = managedRetryKey("endpoint-a", "thread-a", "mapping-a");
  const lease: EndpointWorkLease = { endpointId: "endpoint-a", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "fallback-barrier" };
  let beforeCalls = 0;
  let sharedWakes = 0;
  let afterCalls = 0;
  let fallbackStarted!: () => void;
  let releaseFallback!: () => void;
  const started = new Promise<void>((resolve) => { fallbackStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseFallback = resolve; });
  const owner = createManagedSessionRecoveryOwner({
    endpoints: { withReadyWorkLease: async (_endpointId, run) => run(lease) },
    isLeaseCurrent: () => true,
    recover: async (_endpointId, keys) => ({ restored: true, restoredKeys: keys, settledKeys: [], failures: [] }),
    beforeShared: async () => {
      beforeCalls += 1;
      if (beforeCalls === 1) throw new RpcRequestTimeoutError("before-shared-timeout");
      return [];
    },
    wakeShared: async () => { sharedWakes += 1; },
    afterShared: async () => { afterCalls += 1; },
    onSafetyFailure: () => assert.fail("unexpected safety failure"),
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

  const ready = recoverManagedEndpointReady(owner, "endpoint-a", lease, async () => {
    sharedWakes += 1;
    fallbackStarted();
    await blocked;
  });
  await started;
  assert.equal(timers.length, 1);
  timers[0]!.callback();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(beforeCalls, 1, "the retry cannot overtake an in-flight fallback");
  assert.equal(sharedWakes, 1);

  releaseFallback();
  assert.deepEqual(await ready, { recovery: "pending", sharedWake: "completed" });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(beforeCalls, 2);
  assert.equal(sharedWakes, 1, "the acknowledged fallback is the only shared wake");
  assert.equal(afterCalls, 1);
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
    beforeShared: async () => [],
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
  assert.deepEqual(await oldRun, { recovery: "pending", sharedWake: "stale" });
  assert.deepEqual(await replacement, { recovery: "completed", sharedWake: "completed" });
  assert.equal(recoveries, 1);
  assert.deepEqual(downstream, [oldLease.leaseId, newLease.leaseId]);
  await owner.stop();
});

test("production endpoint-loss recording preserves an after-stage incident receipt", async () => {
  const key = managedRetryKey("endpoint-a", "thread-a", "mapping-a");
  const oldLease: EndpointWorkLease = { endpointId: "endpoint-a", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "old-after" };
  const newLease: EndpointWorkLease = { ...oldLease, endpointGeneration: 2, leaseId: "new-after" };
  const incident = {
    nickname: "payments", endpoint: "endpoint-a", thread_id: "thread-a", mapping_id: "mapping-a", turnId: "external-turn",
  };
  let currentLeaseId = oldLease.leaseId;
  let signalAfterStarted!: () => void;
  let releaseAfter!: () => void;
  const afterStarted = new Promise<void>((resolve) => { signalAfterStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseAfter = resolve; });
  let recoveries = 0;
  let beforeScans = 0;
  let sharedWakes = 0;
  let afterCalls = 0;
  const released: string[] = [];
  const owner = createManagedSessionRecoveryOwner({
    endpoints: { withReadyWorkLease: async (_endpointId, run) => run(newLease) },
    isLeaseCurrent: (_endpointId, lease) => lease.leaseId === currentLeaseId,
    recover: async (_endpointId, keys) => {
      recoveries += 1;
      return { restored: true, restoredKeys: keys, settledKeys: [], failures: [] };
    },
    beforeShared: async () => { beforeScans += 1; return [incident]; },
    wakeShared: async () => { sharedWakes += 1; },
    afterShared: async (_endpointId, lease, receipts, isCurrent) => {
      afterCalls += 1;
      assert.deepEqual(receipts, [incident]);
      if (lease.leaseId === oldLease.leaseId) {
        signalAfterStarted();
        await blocked;
      }
      if (isCurrent()) released.push(...receipts.map((receipt) => receipt.turnId));
    },
    onSafetyFailure: () => assert.fail("unexpected safety failure"),
    onError: () => undefined,
  });
  owner.recordFailure(key, "endpoint");

  const oldRun = owner.endpointReady("endpoint-a", oldLease);
  await afterStarted;
  currentLeaseId = "lost";
  owner.endpointUnavailable("endpoint-a");
  owner.recordFailure(key, "endpoint");
  currentLeaseId = newLease.leaseId;
  const replacement = recoverManagedEndpointReady(owner, "endpoint-a", newLease, async () => { sharedWakes += 1; });
  releaseAfter();

  assert.deepEqual(await oldRun, { recovery: "pending", sharedWake: "stale" });
  assert.deepEqual(await replacement, { recovery: "completed", sharedWake: "completed" });
  assert.equal(recoveries, 1, "endpoint-loss recording cannot restart a restored mapping from managed stage");
  assert.equal(beforeScans, 1);
  assert.equal(sharedWakes, 2, "the replacement generation gets one independent wake without replaying managed before/shared work");
  assert.equal(afterCalls, 2);
  assert.deepEqual(released, ["external-turn"]);
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
    beforeShared: async () => [],
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

  assert.deepEqual(await owner.endpointReady("endpoint-a", lease), { recovery: "pending", sharedWake: "completed" });
  assert.deepEqual(await owner.endpointReady("endpoint-a", lease), { recovery: "pending", sharedWake: "needed" });
  assert.equal(recoveries, 1);
  assert.equal(sharedWakes, 1, "a retained post-helper phase never repeats the shared wake");
  assert.equal(afterCalls, 2);
  assert.equal(safetyRequests, 1, "repeated permanent failures request one controlled safety action");
  assert.equal(timers.length, 0, "permanent downstream failures never poll");

  failAfter = false;
  assert.deepEqual(await owner.endpointReady("endpoint-a", lease), { recovery: "completed", sharedWake: "needed" });
  owner.recordFailure(key, "endpoint");
  failAfter = true;
  assert.deepEqual(await owner.endpointReady("endpoint-a", lease), { recovery: "pending", sharedWake: "completed" });
  assert.equal(safetyRequests, 2, "completion resets the one-shot safety guard for a later incident");
  assert.equal(sharedWakes, 2);
  assert.equal(timers.length, 0);
  await owner.stop();
});

test("permanent managed failure remains non-polling until the next explicit ready edge", async () => {
  type Timer = { callback: () => void };
  const timers: Timer[] = [];
  const key = managedRetryKey("endpoint-a", "thread-a", "mapping-a");
  const lease: EndpointWorkLease = { endpointId: "endpoint-a", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "permanent-managed" };
  let attempts = 0;
  let isolated = 0;
  const owner = createManagedSessionRecoveryOwner({
    endpoints: { withReadyWorkLease: async (_endpointId, run) => run(lease) },
    isLeaseCurrent: () => true,
    recover: async (_endpointId, keys) => {
      attempts += 1;
      return attempts === 1
        ? { restored: false, restoredKeys: [], settledKeys: [], failures: [{ key, disposition: "permanent" as const }] }
        : { restored: true, restoredKeys: keys, settledKeys: [], failures: [] };
    },
    beforeShared: async () => [],
    wakeShared: async () => undefined,
    afterShared: async () => undefined,
    onSafetyFailure: () => { isolated += 1; },
    onError: () => undefined,
    timers: {
      setTimeout: (callback) => { const timer = { callback }; timers.push(timer); return timer; },
      clearTimeout: () => undefined,
    },
  });
  owner.recordFailure(key, "endpoint");

  assert.deepEqual(await owner.endpointReady("endpoint-a", lease), { recovery: "pending", sharedWake: "needed" });
  assert.equal(attempts, 1);
  assert.equal(isolated, 1);
  assert.equal(timers.length, 0, "permanent managed failures do not poll");

  assert.deepEqual(await owner.endpointReady("endpoint-a", lease), { recovery: "completed", sharedWake: "completed" });
  assert.equal(attempts, 2);
  assert.equal(timers.length, 0);
  await owner.stop();
});

test("settled managed recovery removes the target without safety isolation or later retries", async () => {
  const key = managedRetryKey("endpoint-a", "thread-a", "mapping-a");
  const lease: EndpointWorkLease = {
    endpointId: "endpoint-a", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "settled-managed",
  };
  let attempts = 0;
  let safetyFailures = 0;
  let errors = 0;
  const owner = createManagedSessionRecoveryOwner({
    endpoints: { withReadyWorkLease: async (_endpointId, run) => run(lease) },
    isLeaseCurrent: () => true,
    recover: async (_endpointId, keys) => {
      attempts += 1;
      return { restored: false, restoredKeys: [], settledKeys: keys, failures: [] };
    },
    beforeShared: async () => assert.fail("settled mappings have no ownership scan"),
    wakeShared: async () => assert.fail("settled mappings have no managed shared wake"),
    afterShared: async () => assert.fail("settled mappings have no ownership release"),
    onSafetyFailure: () => { safetyFailures += 1; },
    onError: () => { errors += 1; },
  });
  owner.recordFailure(key, "endpoint");

  assert.deepEqual(await owner.endpointReady("endpoint-a", lease), { recovery: "none", sharedWake: "needed" });
  assert.deepEqual(await owner.endpointReady("endpoint-a", lease), { recovery: "none", sharedWake: "needed" });
  assert.equal(attempts, 1);
  assert.equal(safetyFailures, 0);
  assert.equal(errors, 0);
  await owner.stop();
});

test("a directly recorded permanent managed failure waits without polling for an explicit ready edge", async () => {
  type Timer = { callback: () => void };
  const timers: Timer[] = [];
  const key = managedRetryKey("endpoint-a", "thread-a", "mapping-a");
  const lease: EndpointWorkLease = { endpointId: "endpoint-a", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "recorded-permanent" };
  let attempts = 0;
  const owner = createManagedSessionRecoveryOwner({
    endpoints: { withReadyWorkLease: async (_endpointId, run) => run(lease) },
    isLeaseCurrent: () => true,
    recover: async (_endpointId, keys) => {
      attempts += 1;
      return { restored: true, restoredKeys: keys, settledKeys: [], failures: [] };
    },
    beforeShared: async () => [],
    wakeShared: async () => undefined,
    afterShared: async () => undefined,
    onSafetyFailure: () => undefined,
    onError: () => undefined,
    timers: {
      setTimeout: (callback) => { const timer = { callback }; timers.push(timer); return timer; },
      clearTimeout: () => undefined,
    },
  });

  owner.recordFailure(key, "permanent");
  assert.equal(timers.length, 0, "permanent startup failures never poll");
  assert.deepEqual(await owner.endpointReady("endpoint-a", lease), { recovery: "completed", sharedWake: "completed" });
  assert.equal(attempts, 1, "the next explicit ready edge retries the retained mapping");
  await owner.stop();
});

test("startup managed recovery acknowledges only the exact ready generation", async () => {
  const lease: EndpointWorkLease = { endpointId: "endpoint-a", lifecycleGeneration: 1, endpointGeneration: 4, leaseId: "startup-managed" };
  let currentGeneration = 4;
  let acknowledged = 0;
  let capturedLease: EndpointWorkLease | undefined;

  assert.equal(await recoverStartupManagedEndpoint({
    endpointId: "endpoint-a",
    withReadyLease: (run) => run(lease),
    isLeaseCurrent: (candidate) => candidate.endpointGeneration === currentGeneration,
    recover: async (candidate, isCurrent) => {
      capturedLease = candidate;
      assert.equal(isCurrent(), true);
      return {
        restored: false,
        restoredKeys: [],
        settledKeys: [],
        failures: [{
          key: managedRetryKey("endpoint-a", "thread-a", "mapping-a"),
          disposition: managedRecoveryDisposition(new AppError("ENDPOINT_UNAVAILABLE", "helper failed"), isCurrent()),
        }],
      };
    },
    reconcile: async () => assert.fail("nothing was restored"),
    acknowledge: () => { acknowledged += 1; },
  }), "acknowledged");

  assert.equal(capturedLease, lease);
  assert.equal(acknowledged, 1, "the retained owner retry supersedes the buffered startup edge");

  assert.equal(await recoverStartupManagedEndpoint({
    endpointId: "endpoint-a",
    withReadyLease: (run) => run(lease),
    isLeaseCurrent: (candidate) => candidate.endpointGeneration === currentGeneration,
    recover: async () => {
      currentGeneration = 5;
      return { restored: false, restoredKeys: [], settledKeys: [], failures: [] };
    },
    reconcile: async () => assert.fail("nothing was restored"),
    acknowledge: () => { acknowledged += 1; },
  }), "publication");
  assert.equal(acknowledged, 1, "a replacement generation keeps its buffered manager publication");
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
    beforeShared: async () => [],
    wakeShared: async () => { wakes += 1; },
    afterShared: async () => undefined,
    onSafetyFailure: () => assert.fail("unexpected managed retry safety failure"),
    onError: () => undefined,
  });
  owner.recordFailure(keyA, "endpoint");
  owner.recordFailure(keyB, "endpoint");

  assert.deepEqual(
    await recoverManagedEndpointReady(owner, "endpoint-a", lease, async () => { fallbacks += 1; }),
    { recovery: "pending", sharedWake: "completed" },
  );
  assert.equal(wakes, 0);
  assert.deepEqual(
    await recoverManagedEndpointReady(owner, "endpoint-a", lease, async () => { fallbacks += 1; }),
    { recovery: "completed", sharedWake: "completed" },
  );
  assert.deepEqual(attempts, [[keyA, keyB], [keyB]]);
  assert.equal(wakes, 1);
  assert.equal(fallbacks, 1, "the pending endpoint failure still wakes unrelated shared work once");
  assert.deepEqual(
    await owner.endpointReady("endpoint-a", lease),
    { recovery: "none", sharedWake: "needed" },
    "both retained keys eventually clear",
  );
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

test("operation terminal waiters settle after reconciliation and reject on shutdown", async () => {
  const states = new Map<string, "uncertain" | "succeeded" | "failed">([
    ["success", "uncertain"],
    ["shutdown", "uncertain"],
  ]);
  let passes = 0;
  const loop = createOperationReconciliationLoop({
    reconcileOnce: async () => {
      passes += 1;
      states.set("success", "succeeded");
      return { outcome: { attempted: true, transientRetry: false, waitingForEndpoint: false }, transientTargets: new Map() };
    },
    isEndpointReady: () => true,
    operationState: (operationId) => states.get(operationId),
  });

  await Promise.all([loop.waitForTerminal("success"), loop.waitForTerminal("success")]);
  assert.equal(passes, 1);

  states.set("already-failed", "failed");
  await loop.waitForTerminal("already-failed");
  assert.equal(passes, 1, "an already terminal operation does not start another pass");

  const shutdown = loop.waitForTerminal("shutdown");
  await loop.stop();
  await assert.rejects(shutdown, /operation reconciliation stopped/u);
});

test("a canceled terminal waiter detaches without canceling exact durable recovery", async () => {
  const states = new Map<string, "uncertain" | "succeeded">([["create", "uncertain"]]);
  let passes = 0;
  const loop = createOperationReconciliationLoop({
    reconcileOnce: async () => {
      passes += 1;
      return {
        outcome: { attempted: false, transientRetry: false, waitingForEndpoint: true },
        transientTargets: new Map<string, OperationRecoveryTarget>([["create", { policy: "ready_endpoint", endpointId: "remote" }]]),
      };
    },
    isEndpointReady: () => false,
    operationState: (operationId) => states.get(operationId),
  });
  const abort = new AbortController();
  const waiting = loop.waitForTerminal("create", abort.signal);
  abort.abort(new Error("HTTP request closed"));
  await assert.rejects(waiting, /HTTP request closed/u);
  assert.equal(loop.recoveryOwns("create"), true, "request cancellation does not return durable ownership to an active handler");

  states.set("create", "succeeded");
  await loop.endpointReady("remote");
  assert.equal(passes >= 1, true);
  assert.equal(loop.recoveryOwns("create"), false);
  await loop.stop();
});

test("a thrown reconciliation pass retains its terminal waiter and retries", async () => {
  const scheduled: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
  let state: "uncertain" | "succeeded" = "uncertain";
  let passes = 0;
  const loop = createOperationReconciliationLoop({
    reconcileOnce: async () => {
      passes += 1;
      if (passes === 1) throw new Error("temporary reconciliation failure");
      state = "succeeded";
      return { outcome: { attempted: true, transientRetry: false, waitingForEndpoint: false }, transientTargets: new Map() };
    },
    isEndpointReady: () => true,
    operationState: () => state,
    timers: {
      setTimeout: (callback, delay) => { const timer = { callback, delay, cleared: false }; scheduled.push(timer); return timer; },
      clearTimeout: (timer: { cleared: boolean }) => { timer.cleared = true; },
    },
  });

  const waiting = loop.waitForTerminal("create");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(loop.recoveryOwns("create"), true);
  assert.equal(scheduled[0]?.delay, 1_000);
  loop.endpointUnavailable("remote");
  assert.equal(scheduled[0]?.cleared, false, "endpoint pruning cannot cancel the only retry after a thrown pass");
  scheduled[0]!.callback();
  await waiting;
  assert.equal(passes, 2);
  assert.equal(loop.recoveryOwns("create"), false);
  await loop.stop();
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

test("worker terminal reconciliation runs outside its endpoint lease after relay projection", async () => {
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
  }, "endpoint-a", "turn/completed", { threadId: "thread-a", turn: { id: "turn-a" } });
  assert.deepEqual(seen, ["lease:acquired", "ownership", "relay", "ownership", "ownership:released", "lease:released", "operations"]);

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
  }, "endpoint-a", "turn/completed", { threadId: "thread-a", turn: { id: "turn-a" } }), /retry/u);
  assert.deepEqual(seen, ["lease:acquired", "ownership", "relay", "lease:released", "operations"]);
});

test("tool settlement requests explicit operation recovery", async () => {
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
});

test("assistant terminal tool settlement restarts on timeout and reconciles only after settlement", async () => {
  const timedOut: string[] = [];
  assert.equal(await settleAssistantTerminalTools({
    fenceTools: async () => { timedOut.push("fence"); return "timed_out"; },
    reconcileOperations: async () => { timedOut.push("operations"); },
    requestRestartOnce: () => { timedOut.push("restart"); },
  }), false);
  assert.deepEqual(timedOut, ["fence", "restart"]);

  const settled: string[] = [];
  assert.equal(await settleAssistantTerminalTools({
    fenceTools: async () => { settled.push("fence"); return "settled"; },
    reconcileOperations: async () => { settled.push("operations"); },
    requestRestartOnce: () => { settled.push("restart"); },
  }), true);
  assert.deepEqual(settled, ["fence", "operations"]);
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

test("lifecycle reconciliation supplies per-session failure isolation to both phases", async () => {
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

test("managed recovery retains a session left unavailable by a transient ownership boundary", () => {
  assert.equal(managedSessionNeedsRecovery({ managementState: "unavailable" }, true), true);
  assert.equal(managedSessionNeedsRecovery({ managementState: "managed" }, true), false);
  assert.equal(managedSessionNeedsRecovery(undefined, true), false);
  assert.equal(managedSessionNeedsRecovery({ managementState: "managed" }, false), true);
});
