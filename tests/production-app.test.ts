import assert from "node:assert/strict";
import test from "node:test";
import { isUncertainAssistantTransportFailure, registryReloadPreservesWorkerMappings, removalRecoveryDecision } from "../src/production-app.ts";
import { AppError } from "../src/core/errors.ts";

test("assistant uncertainty is preserved even while the endpoint still reports ready", () => {
  assert.equal(isUncertainAssistantTransportFailure(new AppError("OPERATION_UNCERTAIN", "shutdown"), "ready"), true);
  assert.equal(isUncertainAssistantTransportFailure(new Error("ordinary failure"), "ready"), false);
  assert.equal(isUncertainAssistantTransportFailure(new Error("transport failed"), "unavailable"), true);
});

test("removal recovery follows the checkpointed mapping generation across crash windows and nickname reuse", () => {
  const saved = { endpoint: "local", thread_id: "t1", project_dir: "/project", mapping_id: "mapping-old", lifecycle_state: "managed" as const };
  assert.equal(removalRecoveryDecision(saved, { ...saved, lifecycle_state: "managed" }), "no_effect");
  assert.equal(removalRecoveryDecision(saved, { ...saved, lifecycle_state: "unadopting" }), "reconcile");
  assert.equal(removalRecoveryDecision(saved, { ...saved, lifecycle_state: "archiving" }), "reconcile");
  assert.equal(removalRecoveryDecision(saved, undefined), "succeeded");
  assert.equal(removalRecoveryDecision(saved, { ...saved, mapping_id: "mapping-new", lifecycle_state: "managed" }), "succeeded");
  assert.equal(removalRecoveryDecision(undefined, undefined), "pending");
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
