import assert from "node:assert/strict";
import test from "node:test";
import { SessionObservationProcessor } from "../../src/assistant/session-observer.ts";
import { RpcRequestTimeoutError } from "../../src/app-server/rpc-client.ts";
import { AppError } from "../../src/core/errors.ts";
import { reportOperationalSafely } from "../../src/production-app.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { SessionControlStore } from "../../src/storage/session-control-store.ts";
import { SessionDashboardStore } from "../../src/storage/session-dashboard-store.ts";

const mappingId = "mapping-1";

function fixture(options: {
  readGoal?: () => Promise<any>;
  classifyFailure?: (error: unknown) => "retry" | "endpoint" | "sleep";
  retryMs?: number;
  timers?: {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: any): void;
  };
  onError?: (error: unknown) => void;
} = {}) {
  const db = createTestDatabase();
  const store = new SessionDashboardStore(db);
  const controls = new SessionControlStore(db);
  const registry = { snapshot: () => ({
    version: 3 as const,
    assistant: { endpoint: "assistant-local", thread_id: "manager", project_dir: "/manager" },
    sessions: { payments: { endpoint: "local", thread_id: "thread-1", project_dir: "/projects/payments", mapping_id: mappingId, lifecycle_state: "managed" as const } },
  }) };
  let changes = 0;
  const errors: unknown[] = [];
  const processor = new SessionObservationProcessor(store, registry, controls, {
    now: () => 1_000,
    readGoal: options.readGoal ?? (async () => ({ goal: null })),
    onChanged: () => { changes += 1; },
    onError: (error) => {
      errors.push(error);
      options.onError?.(error);
    },
    ...(options.classifyFailure ? { classifyFailure: options.classifyFailure } : {}),
    ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
    ...(options.timers ? { timers: options.timers } : {}),
  });
  return { db, store, controls, processor, changes: () => changes, errors };
}

test("lifecycle status is rejected by the facts projector instead of becoming durable state", async () => {
  const value = fixture();
  assert.equal(value.processor.accept("local", "thread/status/changed", {
    threadId: "thread-1", status: { type: "active" }, activeTurnId: "turn-1",
  }), false);
  await value.processor.idle();
  assert.equal(value.store.pendingNotifications().length, 0);
  assert.equal(value.store.facts({ endpointId: "local", threadId: "thread-1" }).newestObservationAt, null);
});

interface FakeTimer {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
}

function fakeTimers(): { timers: FakeTimer[]; api: { setTimeout(callback: () => void, delayMs: number): FakeTimer; clearTimeout(timer: FakeTimer): void } } {
  const timers: FakeTimer[] = [];
  return {
    timers,
    api: {
      setTimeout: (callback, delayMs) => {
        const timer = { callback, delayMs, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => { timer.cleared = true; },
    },
  };
}

async function settleTimer(timer: FakeTimer): Promise<void> {
  timer.callback();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

const usage = {
  total: { totalTokens: 10, inputTokens: 7, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1 },
  last: { totalTokens: 4, inputTokens: 3, cachedInputTokens: 1, outputTokens: 1, reasoningOutputTokens: 0 },
  modelContextWindow: 100,
};

test("projects body-free fact observations and ignores lifecycle status", async () => {
  const value = fixture();
  assert.equal(value.processor.accept("local", "turn/started", { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress", startedAt: 1, items: [{ type: "agentMessage", text: "secret body" }] } }), true);
  assert.equal(value.processor.accept("local", "thread/settings/updated", { threadId: "thread-1", threadSettings: { model: "gpt-5", effort: "high", cwd: "/ignored" } }), true);
  assert.equal(value.processor.accept("local", "thread/tokenUsage/updated", { threadId: "thread-1", turnId: "turn-1", tokenUsage: usage }), true);
  assert.equal(value.processor.accept("local", "thread/goal/updated", { threadId: "thread-1", turnId: null, goal: { threadId: "thread-1", objective: "finish", status: "active", tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2 } }), true);
  assert.equal(value.processor.accept("local", "thread/status/changed", { threadId: "thread-1", status: { type: "idle" } }), false);
  await value.processor.idle();

  const persisted = value.db.prepare("SELECT params_json FROM session_dashboard_notifications ORDER BY sequence").all() as Array<{ params_json: string }>;
  assert.equal(persisted.some((row) => row.params_json.includes("secret body")), false);
  assert.equal(value.store.pendingNotifications().length, 0);
  const facts = value.store.facts({ endpointId: "local", threadId: "thread-1" });
  assert.equal(facts.currentSettings.model, "gpt-5");
  assert.equal(facts.tokenUsage?.total.total_tokens, 10);
  assert.equal(facts.goal?.objective, "finish");
  assert.ok(value.changes() >= 1);
});

test("projects valid token telemetry without writing the durable inbox", async () => {
  const value = fixture();
  assert.equal(value.processor.accept("local", "thread/tokenUsage/updated", {
    threadId: "thread-1", turnId: "turn-1", tokenUsage: usage,
  }), true);

  assert.equal((value.db.prepare("SELECT COUNT(*) AS count FROM session_dashboard_notifications").get() as { count: number }).count, 0);
  assert.equal(value.store.facts({ endpointId: "local", threadId: "thread-1" }).tokenUsage?.total.total_tokens, 10);
  assert.equal(value.changes(), 1);
  await value.processor.idle();
});

test("an exact terminal goal notification revokes goal control", async () => {
  const value = fixture();
  value.controls.setGoalControlled("local", "thread-1", mappingId, true, value.store.allocateObservationSequence());

  value.processor.accept("local", "thread/goal/updated", {
    threadId: "thread-1",
    turnId: "completed-goal-turn",
    goal: { objective: "finish", status: "complete", tokenBudget: null, updatedAt: 2 },
  });
  await value.processor.idle();

  assert.equal(value.controls.goalControlled("local", "thread-1", mappingId), false);
});

test("a fast idle cannot clear a newly armed goal before its ordered goal update", async () => {
  const value = fixture();
  value.controls.setGoalControlled("local", "thread-1", mappingId, true, value.store.allocateObservationSequence());
  value.processor.accept("local", "thread/status/changed", { threadId: "thread-1", status: { type: "idle" } });
  await value.processor.idle();
  assert.equal(value.controls.goalControlled("local", "thread-1", mappingId), true);

  value.processor.accept("local", "thread/goal/updated", {
    threadId: "thread-1",
    turnId: null,
    goal: { objective: "finish", status: "paused", tokenBudget: null, updatedAt: 2 },
  });

  await value.processor.idle();

  assert.equal(value.controls.goalControlled("local", "thread-1", mappingId), false);
});

test("a stale non-active goal update cannot clear a newer activation", async () => {
  const value = fixture();
  value.processor.accept("local", "thread/goal/updated", {
    threadId: "thread-1",
    turnId: null,
    goal: { objective: "finish", status: "paused", tokenBudget: null, updatedAt: 2 },
  });
  value.controls.setGoalControlled("local", "thread-1", mappingId, true, value.store.allocateObservationSequence());

  await value.processor.idle();

  assert.equal(value.controls.goalControlled("local", "thread-1", mappingId), true);
});

test("an unknown goal status cannot revoke controlled-goal state", async () => {
  const value = fixture();
  value.controls.setGoalControlled("local", "thread-1", mappingId, true, value.store.allocateObservationSequence());

  assert.equal(value.processor.accept("local", "thread/goal/updated", {
    threadId: "thread-1",
    turnId: null,
    goal: { objective: "finish", status: "future-status", tokenBudget: null, updatedAt: 2 },
  }), false);
  await value.processor.idle();

  assert.equal(value.controls.goalControlled("local", "thread-1", mappingId), true);
});

test("replays a token notification accepted before a crash", async () => {
  const value = fixture();
  value.store.acceptNotification("local", "thread/tokenUsage/updated", { threadId: "thread-1", turnId: "turn-1", tokenUsage: usage }, 1_000);
  assert.equal(value.store.facts({ endpointId: "local", threadId: "thread-1" }).tokenUsage, null);
  await value.processor.drain();
  assert.equal(value.store.facts({ endpointId: "local", threadId: "thread-1" }).tokenUsage?.total.total_tokens, 10);
  assert.equal(value.store.pendingNotifications().length, 0);
});

test("a live token update queues behind older durable observations", async () => {
  const value = fixture();
  value.store.acceptNotification("local", "thread/tokenUsage/updated", {
    threadId: "thread-1", turnId: "old-turn", tokenUsage: usage,
  }, 900);
  const newerUsage = {
    ...usage,
    total: { ...usage.total, totalTokens: 20 },
    last: { ...usage.last, totalTokens: 8 },
  };

  assert.equal(value.processor.accept("local", "thread/tokenUsage/updated", {
    threadId: "thread-1", turnId: "new-turn", tokenUsage: newerUsage,
  }), true);
  await value.processor.drain();

  const identity = { endpointId: "local", threadId: "thread-1" };
  assert.equal(value.store.facts(identity).tokenUsage?.total.total_tokens, 20);
  assert.equal(value.store.turnOrdinal(identity, "old-turn"), 1);
  assert.equal(value.store.turnOrdinal(identity, "new-turn"), 2);
  assert.equal(value.store.pendingNotifications().length, 0);
});

test("projection-before-inbox-completion is idempotent after a crash", async () => {
  const value = fixture();
  const sequence = value.store.acceptNotification("local", "thread/settings/updated", { threadId: "thread-1", threadSettings: { model: "gpt-5", effort: "high" } }, 1_000);
  value.store.observeCurrentSettings({ endpointId: "local", threadId: "thread-1" }, { model: "gpt-5", effort: "high", observedAt: 1_000 }, sequence);
  await value.processor.drain();
  assert.equal(value.store.pendingNotifications().length, 0);
  assert.equal(value.store.facts({ endpointId: "local", threadId: "thread-1" }).currentSettings.observationSequence, sequence);
});

test("a fresh equal resume watermark rejects an older delayed settings observation", async () => {
  const value = fixture();
  const first = value.store.allocateObservationSequence();
  value.store.observeCurrentSettings({ endpointId: "local", threadId: "thread-1" }, { model: "A", effort: "high", observedAt: 100 }, first);
  const old = value.store.acceptNotification("local", "thread/settings/updated", { threadId: "thread-1", threadSettings: { model: "B", effort: "low" } }, 200);
  const revision = value.store.renderState().revision;
  value.store.markRenderSucceeded(revision);
  value.processor.observeResume("local", "thread-1", { model: "A", reasoningEffort: "high", thread: { status: { type: "idle" }, turns: [] } }, 300);
  await value.processor.drain();
  const current = value.store.facts({ endpointId: "local", threadId: "thread-1" }).currentSettings;
  assert.equal(old, 2);
  assert.equal(current.model, "A");
  assert.ok(current.observationSequence > old);
});

test("a resume response keeps its receipt order so a later settings notification wins", async () => {
  const value = fixture();
  const resumeSequence = value.store.allocateObservationSequence();
  value.processor.accept("local", "thread/settings/updated", { threadId: "thread-1", threadSettings: { model: "new", effort: "high" } });
  await value.processor.idle();

  value.processor.observeResume("local", "thread-1", {
    model: "old",
    reasoningEffort: "low",
    thread: { status: { type: "idle" }, turns: [] },
  }, 300, { settings: resumeSequence });
  await value.processor.drain("local");

  const current = value.store.facts({ endpointId: "local", threadId: "thread-1" }).currentSettings;
  assert.equal(current.model, "new");
  assert.equal(current.effort, "high");
});

test("resume projects settings and turn order but never persists native liveness", async () => {
  const value = fixture();
  const settingsSequence = value.store.allocateObservationSequence();

  value.processor.observeResume("local", "thread-1", {
    model: "gpt-5",
    reasoningEffort: "high",
    thread: { status: { type: "active" }, turns: [{ id: "active-turn", status: "inProgress", startedAt: 2 }] },
  }, 300, { settings: settingsSequence });
  await value.processor.drain("local");

  assert.equal(value.store.facts({ endpointId: "local", threadId: "thread-1" }).currentSettings.model, "gpt-5");
  assert.equal(value.store.turnOrdinal({ endpointId: "local", threadId: "thread-1" }, "active-turn"), 1);
});

test("idle waits for a blocked handler and leaves endpoint failures pending for retry", async () => {
  let reject!: (error: Error) => void;
  const blocked = new Promise<any>((_resolve, rejectPromise) => { reject = rejectPromise; });
  const value = fixture({ readGoal: async () => blocked });
  value.processor.accept("local", "thread/goal/cleared", { threadId: "thread-1" });
  let settled = false;
  const idle = value.processor.idle().then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  reject(new Error("endpoint stopped"));
  await idle;
  assert.equal(value.store.pendingNotifications().length, 1);
  assert.equal(value.errors.length, 1);
});

test("observation retries only classified RPC timeouts and clears the durable row after success", async () => {
  const clock = fakeTimers();
  let reads = 0;
  const value = fixture({
    readGoal: async () => {
      reads += 1;
      if (reads === 1) throw new RpcRequestTimeoutError("thread/goal/get");
      return { goal: null };
    },
    classifyFailure: (error) => error instanceof RpcRequestTimeoutError ? "retry" : "sleep",
    retryMs: 25,
    timers: clock.api,
  });

  value.processor.accept("local", "thread/goal/cleared", { threadId: "thread-1" });
  await value.processor.idle();
  assert.equal(value.store.pendingNotifications().length, 1);
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0]!.delayMs, 25);

  await settleTimer(clock.timers[0]!);
  await value.processor.idle();
  assert.equal(reads, 2);
  assert.equal(value.store.pendingNotifications().length, 0);
});

test("endpoint loss or stop before queued observation work fences native reads and projection", async () => {
  for (const action of ["loss", "stop"] as const) {
    let reads = 0;
    const value = fixture({ readGoal: async () => { reads += 1; return { goal: null }; } });
    value.processor.accept("local", "thread/goal/cleared", { threadId: "thread-1" });
    if (action === "loss") value.processor.endpointUnavailable("local");
    else await value.processor.stop();
    await value.processor.idle();
    assert.equal(reads, 0, action);
    assert.equal(value.store.pendingNotifications().length, 1, action);
    assert.equal(value.changes(), 0, action);
  }
});

test("endpoint loss during an observation RPC cannot project or complete the stale row", async () => {
  let signalStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const value = fixture({
    readGoal: async () => {
      reads += 1;
      if (reads === 1) {
        signalStarted();
        await blocked;
        return { goal: { objective: "stale", status: "active", tokenBudget: null, updatedAt: 2 } };
      }
      return { goal: null };
    },
  });
  value.processor.accept("local", "thread/goal/cleared", { threadId: "thread-1" });
  value.processor.accept("local", "thread/settings/updated", {
    threadId: "thread-1", threadSettings: { model: "new-model", effort: "high" },
  });
  await started;
  value.processor.endpointUnavailable("local");
  release();
  await value.processor.idle();

  assert.equal(value.store.pendingNotifications().length, 2);
  assert.equal(value.store.facts({ endpointId: "local", threadId: "thread-1" }).goal, null);
  assert.equal(value.store.facts({ endpointId: "local", threadId: "thread-1" }).currentSettings.model, null);
  assert.equal(value.changes(), 0);
  await value.processor.endpointReady("local");
  assert.equal(reads, 2);
  assert.equal(value.store.pendingNotifications().length, 0);
  assert.equal(value.store.facts({ endpointId: "local", threadId: "thread-1" }).currentSettings.model, "new-model");
});

test("ordinary observation success clears only its still-current retry timer", async () => {
  const clock = fakeTimers();
  let reads = 0;
  const value = fixture({
    readGoal: async () => {
      reads += 1;
      if (reads === 1) throw new RpcRequestTimeoutError("thread/goal/get");
      return { goal: null };
    },
    classifyFailure: (error) => error instanceof RpcRequestTimeoutError ? "retry" : "sleep",
    timers: clock.api,
  });
  value.processor.accept("local", "thread/goal/cleared", { threadId: "thread-1" });
  await value.processor.idle();
  const stale = clock.timers[0]!;
  value.processor.accept("local", "thread/settings/updated", {
    threadId: "thread-1", threadSettings: { model: "gpt-5", effort: "high" },
  });
  await value.processor.idle();
  assert.equal(stale.cleared, true);
  assert.equal(value.store.pendingNotifications().length, 0);
  stale.callback();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(reads, 2);
});

test("throwing operational reporting cannot suppress repeated observation retries or create user-visible rows", async () => {
  const clock = fakeTimers();
  let reads = 0;
  let reports = 0;
  const value = fixture({
    readGoal: async () => {
      reads += 1;
      if (reads <= 3) throw new RpcRequestTimeoutError("thread/goal/get");
      return { goal: null };
    },
    classifyFailure: (error) => error instanceof RpcRequestTimeoutError ? "retry" : "sleep",
    timers: clock.api,
    onError: () => reportOperationalSafely(() => {
      reports += 1;
      throw new Error("operational sink failed");
    }, { level: "warn", code: "background_task_failed", component: "session_observation" }),
  });

  value.processor.accept("local", "thread/goal/cleared", { threadId: "thread-1" });
  await value.processor.idle();
  for (let index = 0; index < 3; index += 1) {
    assert.ok(clock.timers[index]);
    await settleTimer(clock.timers[index]!);
    await value.processor.idle();
  }
  assert.equal(reads, 4);
  assert.equal(reports, 3);
  assert.equal(value.store.pendingNotifications().length, 0);
  assert.equal((value.db.prepare("SELECT COUNT(*) AS count FROM deliveries").get() as { count: number }).count, 0);
  assert.equal((value.db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count, 0);
});

test("endpoint failures sleep until an explicit endpoint-ready wake", async () => {
  const endpointClock = fakeTimers();
  let endpointReads = 0;
  const endpoint = fixture({
    readGoal: async () => {
      endpointReads += 1;
      if (endpointReads === 1) throw new AppError("ENDPOINT_UNAVAILABLE", "offline");
      return { goal: null };
    },
    classifyFailure: (error) => error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE" ? "endpoint" : "sleep",
    timers: endpointClock.api,
  });
  endpoint.processor.accept("local", "thread/goal/cleared", { threadId: "thread-1" });
  await endpoint.processor.idle();
  assert.equal(endpointClock.timers.length, 0);
  assert.equal(endpoint.store.pendingNotifications().length, 1);
  await endpoint.processor.endpointReady("local");
  assert.equal(endpointReads, 2);
  assert.equal(endpoint.store.pendingNotifications().length, 0);

});

test("unknown and permanent observation failures remain asleep", async () => {
  for (const error of [new Error("unknown"), new AppError("CWD_MISMATCH", "permanent")]) {
    const clock = fakeTimers();
    const value = fixture({
      readGoal: async () => { throw error; },
      classifyFailure: () => "sleep",
      timers: clock.api,
    });
    value.processor.accept("local", "thread/goal/cleared", { threadId: "thread-1" });
    await value.processor.idle();
    assert.equal(clock.timers.length, 0);
    assert.equal(value.store.pendingNotifications().length, 1);
  }
});

test("endpoint loss cancels observation retry and ready drains immediately", async () => {
  const clock = fakeTimers();
  let reads = 0;
  const value = fixture({
    readGoal: async () => {
      reads += 1;
      if (reads === 1) throw new RpcRequestTimeoutError("thread/goal/get");
      return { goal: null };
    },
    classifyFailure: (error) => error instanceof RpcRequestTimeoutError ? "retry" : "sleep",
    timers: clock.api,
  });
  value.processor.accept("local", "thread/goal/cleared", { threadId: "thread-1" });
  await value.processor.idle();
  const stale = clock.timers[0]!;
  value.processor.endpointUnavailable("local");
  assert.equal(stale.cleared, true);
  await settleTimer(stale);
  assert.equal(reads, 1);

  await value.processor.endpointReady("local");
  assert.equal(reads, 2);
  assert.equal(value.store.pendingNotifications().length, 0);
});

test("observation stop cancels timers, awaits tails, and fences stale callbacks", async () => {
  const clock = fakeTimers();
  let reads = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const value = fixture({
    readGoal: async () => {
      reads += 1;
      if (reads === 1) throw new RpcRequestTimeoutError("thread/goal/get");
      await blocked;
      return { goal: null };
    },
    classifyFailure: (error) => error instanceof RpcRequestTimeoutError ? "retry" : "sleep",
    timers: clock.api,
  });
  value.processor.accept("local", "thread/goal/cleared", { threadId: "thread-1" });
  await value.processor.idle();
  const stale = clock.timers[0]!;
  const live = value.processor.endpointReady("local");
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  let stopped = false;
  const stopping = value.processor.stop().then(() => { stopped = true; });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(stopped, false);
  release();
  await Promise.all([live, stopping]);
  assert.equal(value.store.pendingNotifications().length, 1);
  stale.callback();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(reads, 2);
});

test("quarantines an invalid durable observation without starving later rows", async () => {
  const clock = fakeTimers();
  const value = fixture({ timers: clock.api });
  value.store.acceptNotification("local", "thread/tokenUsage/updated", {
    threadId: "thread-1", turnId: "turn-1", tokenUsage: { total: { totalTokens: -1 } },
  }, 1_000);
  value.processor.accept("local", "thread/settings/updated", { threadId: "thread-1", threadSettings: { model: "gpt-5", effort: "high" } });
  await value.processor.idle();

  assert.equal(value.store.pendingNotifications().length, 0);
  assert.equal(value.store.facts({ endpointId: "local", threadId: "thread-1" }).currentSettings.model, "gpt-5");
  assert.equal(value.errors.length, 1);
  assert.equal(clock.timers.length, 0);
  const invalid = value.db.prepare("SELECT state, error_json FROM session_dashboard_notifications WHERE sequence = 1").get() as { state: string; error_json: string };
  assert.equal(invalid.state, "failed");
  assert.deepEqual(JSON.parse(invalid.error_json), { message: "invalid thread/tokenUsage/updated notification" });
});

test("rejects invalid live token usage before writing the durable inbox", async () => {
  const value = fixture();
  assert.equal(value.processor.accept("local", "thread/tokenUsage/updated", {
    threadId: "thread-1", turnId: "turn-1", tokenUsage: { total: { totalTokens: -1 } },
  }), false);
  await value.processor.idle();

  assert.equal((value.db.prepare("SELECT COUNT(*) AS count FROM session_dashboard_notifications").get() as { count: number }).count, 0);
  assert.equal(value.errors.length, 0);
});

test("a token observation with a missed start event is ordered locally without a history read", async () => {
  const value = fixture();
  value.processor.accept("local", "thread/tokenUsage/updated", { threadId: "thread-1", turnId: "not-visible-yet", tokenUsage: usage });
  value.processor.accept("local", "thread/settings/updated", { threadId: "thread-1", threadSettings: { model: "gpt-5", effort: "high" } });
  await value.processor.idle();

  assert.deepEqual(value.store.pendingNotifications(), []);
  assert.equal(value.store.turnOrdinal({ endpointId: "local", threadId: "thread-1" }, "not-visible-yet"), 1);
  assert.equal(value.store.facts({ endpointId: "local", threadId: "thread-1" }).tokenUsage?.total.total_tokens, 10);
  assert.equal(value.store.facts({ endpointId: "local", threadId: "thread-1" }).currentSettings.model, "gpt-5");
});

test("terminal observation stores only metadata and has no lifecycle side effect", async () => {
  const value = fixture();
  await value.processor.observeTerminal({ endpointId: "local", threadId: "thread-1", turnId: "old", status: "completed", startedAt: 1, completedAt: 2, finalMessageId: "message-1" });
  assert.deepEqual(value.store.facts({ endpointId: "local", threadId: "thread-1" }).lastWorkerEvent, {
    message_id: "message-1", turn_id: "old", status: "completed", at: "1970-01-01T00:00:02.000Z",
  });
});

test("terminal observation assigns a local ordinal even when its start event was missed", async () => {
  const value = fixture();

  await value.processor.observeTerminal({
    endpointId: "local",
    threadId: "thread-1",
    turnId: "terminal",
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    finalMessageId: "message-terminal",
  }, { endpointId: "local", lifecycleGeneration: 2, endpointGeneration: 3, leaseId: "terminal-observation" });

  assert.equal(value.store.turnOrdinal({ endpointId: "local", threadId: "thread-1" }, "terminal"), 1);
});
