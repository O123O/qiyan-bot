import assert from "node:assert/strict";
import test from "node:test";
import { createChatHistoryAction, isUncertainAssistantTransportFailure, registryReloadPreservesWorkerMappings, removalRecoveryDecision } from "../src/production-app.ts";
import { AppError } from "../src/core/errors.ts";
import { ChatAdapterRegistry } from "../src/chat/adapter-registry.ts";

test("assistant uncertainty is preserved even while the endpoint still reports ready", () => {
  assert.equal(isUncertainAssistantTransportFailure(new AppError("OPERATION_UNCERTAIN", "shutdown"), "ready"), true);
  assert.equal(isUncertainAssistantTransportFailure(new Error("ordinary failure"), "ready"), false);
  assert.equal(isUncertainAssistantTransportFailure(new Error("transport failed"), "unavailable"), true);
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
