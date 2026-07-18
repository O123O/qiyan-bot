import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { JsonRpcResponseError, RpcRequestTimeoutError } from "../../src/app-server/rpc-client.ts";
import type { RuntimeIdentity } from "../../src/endpoints/types.ts";
import { PostTurnActionRetry, type AssistantPostTurnAction } from "../../src/assistant/post-turn-actions.ts";
import { runAssistantCompaction, runAssistantRestart, startAssistantTurnWithPendingSettings } from "../../src/assistant/self-controls.ts";

const action = (kind: "compact" | "restart", payload: Record<string, unknown>): AssistantPostTurnAction => ({
  id: "op-1", kind, payload, state: "running",
});

test("assistant compaction checkpoints a baseline and completes only after new native evidence", async () => {
  const turns = [{ id: "turn-1", status: "completed", itemsView: "notLoaded", items: [] as any[] }];
  const checkpoints: Record<string, unknown>[] = [];
  let requests = 0;
  let compacted = false;

  await runAssistantCompaction(action("compact", { endpointId: "assistant-local", threadId: "assistant" }), {
    identity: () => ({ endpointId: "assistant-local", threadId: "assistant" }),
    readThread: async () => ({ status: { type: "idle" }, turns }),
    compactionItemIdsAfter: async (baseline) => { assert.equal(baseline, "turn-1"); return compacted ? ["compact-1"] : []; },
    compact: async () => { requests += 1; compacted = true; },
  }, (payload) => { checkpoints.push(payload); });

  assert.equal(requests, 1);
  assert.deepEqual(checkpoints, [
    { endpointId: "assistant-local", threadId: "assistant", baselineTurnId: "turn-1", phase: "dispatching" },
    { endpointId: "assistant-local", threadId: "assistant", baselineTurnId: "turn-1", phase: "dispatched" },
  ]);
});

test("assistant compaction recovery accepts new evidence and never blindly redispatches", async () => {
  let requests = 0;
  await runAssistantCompaction(action("compact", {
    endpointId: "assistant-local", threadId: "assistant", baselineTurnId: "turn-1", phase: "dispatching",
  }), {
    identity: () => ({ endpointId: "assistant-local", threadId: "assistant" }),
    readThread: async () => ({ status: { type: "idle" }, turns: [] }),
    compactionItemIdsAfter: async () => ["new"],
    compact: async () => { requests += 1; },
  }, () => undefined);
  assert.equal(requests, 0);

  await assert.rejects(runAssistantCompaction(action("compact", {
    endpointId: "assistant-local", threadId: "assistant", baselineTurnId: "turn-1", phase: "dispatching",
  }), {
    identity: () => ({ endpointId: "assistant-local", threadId: "assistant" }),
    readThread: async () => ({ status: { type: "idle" }, turns: [] }),
    compactionItemIdsAfter: async () => [],
    compact: async () => { requests += 1; },
  }, () => undefined), (error: unknown) => error instanceof PostTurnActionRetry);
  assert.equal(requests, 0);
});

test("assistant compaction keeps a legacy unbounded checkpoint pending without redispatch", async () => {
  await assert.rejects(runAssistantCompaction(action("compact", {
    endpointId: "assistant-local", threadId: "assistant", phase: "dispatching",
  }), {
    identity: () => ({ endpointId: "assistant-local", threadId: "assistant" }),
    readThread: async () => ({ status: { type: "idle" }, turns: [] }),
    compactionItemIdsAfter: async () => assert.fail("legacy recovery has no safe bounded anchor"),
    compact: async () => { assert.fail("legacy recovery must not redispatch"); },
  }, () => undefined), (error: unknown) => error instanceof PostTurnActionRetry);
});

test("assistant compaction keeps an ambiguous dispatch failure pending for evidence recovery", async () => {
  const checkpoints: Record<string, unknown>[] = [];
  await assert.rejects(runAssistantCompaction(action("compact", {
    endpointId: "assistant-local", threadId: "assistant",
  }), {
    identity: () => ({ endpointId: "assistant-local", threadId: "assistant" }),
    readThread: async () => ({ status: { type: "idle" }, turns: [{
      id: "turn-1", status: "completed", itemsView: "notLoaded", items: [],
    }] }),
    compactionItemIdsAfter: async () => [],
    compact: async () => { throw new Error("response lost after dispatch"); },
  }, (payload) => { checkpoints.push(payload); }), (error: unknown) => error instanceof PostTurnActionRetry);
  assert.deepEqual(checkpoints.map((payload) => payload.phase), ["dispatching"]);
});

test("assistant restart shuts down only the scheduled runtime identity", async () => {
  const scheduled: RuntimeIdentity = { kind: "local", pid: 10, startTime: "10" };
  let current: any = scheduled;
  const shutdowns: unknown[] = [];
  const checkpoints: Record<string, unknown>[] = [];
  await runAssistantRestart(action("restart", { endpointId: "assistant-local", runtimeIdentity: scheduled }), {
    endpointId: "assistant-local",
    runtimeIdentity: async () => current,
    shutdownRuntime: async (identity) => { shutdowns.push(identity); current = undefined; },
    startAndResume: async () => { current = { kind: "local", pid: 11, startTime: "11" }; },
  }, (payload) => { checkpoints.push(payload); });
  assert.deepEqual(shutdowns, [scheduled]);
  assert.deepEqual(checkpoints.map((value) => value.phase), ["shutting_down", "starting"]);

  current = { kind: "local", pid: 12, startTime: "12" };
  const replacementShutdowns: unknown[] = [];
  await runAssistantRestart(action("restart", { endpointId: "assistant-local", runtimeIdentity: scheduled, phase: "shutting_down" }), {
    endpointId: "assistant-local",
    runtimeIdentity: async () => current,
    shutdownRuntime: async (identity) => { replacementShutdowns.push(identity); },
    startAndResume: async () => { throw new Error("replacement must not be restarted"); },
  }, () => undefined);
  assert.deepEqual(replacementShutdowns, []);
});

test("assistant restart keeps a failed replacement start pending after exact shutdown", async () => {
  const scheduled: RuntimeIdentity = { kind: "local", pid: 10, startTime: "10" };
  let current: RuntimeIdentity | undefined = scheduled;
  const checkpoints: Record<string, unknown>[] = [];
  await assert.rejects(runAssistantRestart(action("restart", {
    endpointId: "assistant-local", runtimeIdentity: scheduled,
  }), {
    endpointId: "assistant-local",
    runtimeIdentity: async () => current,
    shutdownRuntime: async () => { current = undefined; },
    startAndResume: async () => { throw new RpcRequestTimeoutError("thread/resume"); },
  }, (payload) => { checkpoints.push(payload); }), (error: unknown) => error instanceof PostTurnActionRetry);
  assert.deepEqual(checkpoints.map((payload) => payload.phase), ["shutting_down", "starting"]);
});

test("assistant self-control lets authoritative and configuration failures become failed actions", async () => {
  const compactRejection = new JsonRpcResponseError(-32602, "invalid compact request");
  await assert.rejects(runAssistantCompaction(action("compact", {
    endpointId: "assistant-local", threadId: "assistant",
  }), {
    identity: () => ({ endpointId: "assistant-local", threadId: "assistant" }),
    readThread: async () => ({ status: { type: "idle" }, turns: [{
      id: "turn-1", status: "completed", itemsView: "full", items: [],
    }] }),
    compactionItemIdsAfter: async () => [],
    compact: async () => { throw compactRejection; },
  }, () => undefined), (error: unknown) => error === compactRejection);

  const scheduled: RuntimeIdentity = { kind: "local", pid: 10, startTime: "10" };
  const configurationFailure = new AppError("CONFIGURATION_ERROR", "assistant profile is invalid");
  await assert.rejects(runAssistantRestart(action("restart", {
    endpointId: "assistant-local", runtimeIdentity: scheduled, phase: "starting",
  }), {
    endpointId: "assistant-local",
    runtimeIdentity: async () => undefined,
    shutdownRuntime: async () => undefined,
    startAndResume: async () => { throw configurationFailure; },
  }, () => undefined), (error: unknown) => error === configurationFailure);
});

test("assistant restart recovery resumes a replacement created before start-and-resume failed", async () => {
  const scheduled: RuntimeIdentity = { kind: "local", pid: 10, startTime: "10" };
  const replacement: RuntimeIdentity = { kind: "local", pid: 11, startTime: "11" };
  let resumes = 0;
  await runAssistantRestart(action("restart", {
    endpointId: "assistant-local", runtimeIdentity: scheduled, phase: "starting",
  }), {
    endpointId: "assistant-local",
    runtimeIdentity: async () => replacement,
    shutdownRuntime: async () => { assert.fail("the replacement must not be shut down"); },
    startAndResume: async () => { resumes += 1; },
  }, () => undefined);
  assert.equal(resumes, 1);
});

test("assistant self-control rejects a changed thread identity", async () => {
  await assert.rejects(runAssistantCompaction(action("compact", {
    endpointId: "assistant-local", threadId: "old-thread",
  }), {
    identity: () => ({ endpointId: "assistant-local", threadId: "new-thread" }),
    readThread: async () => ({ status: { type: "idle" }, turns: [] }),
    compactionItemIdsAfter: async () => [],
    compact: async () => undefined,
  }, () => undefined), (error: unknown) => error instanceof AppError && error.code === "OPERATION_CONFLICT");
});

test("assistant pending settings apply only after a successful native turn start", async () => {
  const applied: Array<{ model?: string; effort?: string }> = [];
  const params = { threadId: "assistant", input: [] };
  await assert.rejects(startAssistantTurnWithPendingSettings(params, { model: "gpt-5.4", effort: "xhigh" },
    async (request) => { assert.equal(request.model, "gpt-5.4"); throw new Error("start failed"); },
    (settings) => { applied.push(settings); }), /start failed/u);
  assert.equal(applied.length, 0);

  const result = await startAssistantTurnWithPendingSettings(params, { model: "gpt-5.4", effort: "xhigh" },
    async (request) => ({ request, turn: { id: "turn-1" } }),
    (settings) => { applied.push(settings); });
  assert.equal(result.turn.id, "turn-1");
  assert.deepEqual(result.request, { ...params, model: "gpt-5.4", effort: "xhigh" });
  assert.deepEqual(applied, [{ model: "gpt-5.4", effort: "xhigh" }]);
});
