import assert from "node:assert/strict";
import test from "node:test";
import { createChatHistoryAction, isUncertainAssistantTransportFailure, managedSessionNeedsRecovery, parseEndpointLifecycleCheckpoint, reconcileLifecycleAndOwnership, reconcileLifecycleTransitions, reconcileOwnershipBeforeRelay, reconcileOwnershipBeforeRelayWithLease, registryReloadPreservesWorkerMappings, removalRecoveryDecision, withRecoveredSessionLease, withRelayEndpointWorkLease } from "../src/production-app.ts";
import { AppError } from "../src/core/errors.ts";
import { ChatAdapterRegistry } from "../src/chat/adapter-registry.ts";
import type { EndpointWorkLease } from "../src/endpoints/types.ts";

test("assistant uncertainty is preserved even while the endpoint still reports ready", () => {
  assert.equal(isUncertainAssistantTransportFailure(new AppError("OPERATION_UNCERTAIN", "shutdown"), "ready"), true);
  assert.equal(isUncertainAssistantTransportFailure(new Error("ordinary failure"), "ready"), false);
  assert.equal(isUncertainAssistantTransportFailure(new Error("transport failed"), "unavailable"), true);
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

test("session operation recovery holds one endpoint lease for its complete callback", async () => {
  const lease: EndpointWorkLease = { endpointId: "devbox", lifecycleGeneration: 1, endpointGeneration: 2, leaseId: "lease-1" };
  let acquisitions = 0;
  const result = await withRecoveredSessionLease({
    withWorkLease: async (_id, _kind, run) => { acquisitions += 1; return run({} as never, lease); },
  }, "devbox", async (actual) => {
    assert.equal(actual, lease);
    return "recovered";
  });
  assert.equal(result, "recovered");
  assert.equal(acquisitions, 1);
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
