import assert from "node:assert/strict";
import test from "node:test";
import { SessionObservationProcessor } from "../../src/coordinator/session-observer.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { RuntimeStore } from "../../src/storage/runtime-store.ts";
import { SessionDashboardStore } from "../../src/storage/session-dashboard-store.ts";

function fixture(options: { readThread?: () => Promise<any>; readGoal?: () => Promise<any> } = {}) {
  const db = createTestDatabase();
  const store = new SessionDashboardStore(db);
  const runtime = new RuntimeStore(db);
  runtime.setSession("local", "thread-1", "managed", "idle");
  const registry = { snapshot: () => ({
    version: 1 as const,
    coordinator: { endpoint: "coordinator-local", thread_id: "manager", project_dir: "/manager" },
    sessions: { payments: { endpoint: "local", thread_id: "thread-1", project_dir: "/projects/payments" } },
  }) };
  let changes = 0;
  const errors: unknown[] = [];
  const processor = new SessionObservationProcessor(store, registry, runtime, {
    now: () => 1_000,
    readThread: options.readThread ?? (async () => ({ turns: [] })),
    readGoal: options.readGoal ?? (async () => ({ goal: null })),
    onChanged: () => { changes += 1; },
    onError: (error) => { errors.push(error); },
  });
  return { db, store, runtime, processor, changes: () => changes, errors };
}

const usage = {
  total: { totalTokens: 10, inputTokens: 7, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1 },
  last: { totalTokens: 4, inputTokens: 3, cachedInputTokens: 1, outputTokens: 1, reasoningOutputTokens: 0 },
  modelContextWindow: 100,
};

test("accepts body-free observations durably and processes settings, status, tokens, and goals", async () => {
  const value = fixture({ readThread: async () => ({ turns: [{ id: "turn-1", startedAt: 1 }] }) });
  assert.equal(value.processor.accept("local", "turn/started", { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress", startedAt: 1, items: [{ type: "agentMessage", text: "secret body" }] } }), true);
  assert.equal(value.processor.accept("local", "thread/settings/updated", { threadId: "thread-1", threadSettings: { model: "gpt-5", effort: "high", cwd: "/ignored" } }), true);
  assert.equal(value.processor.accept("local", "thread/tokenUsage/updated", { threadId: "thread-1", turnId: "turn-1", tokenUsage: usage }), true);
  assert.equal(value.processor.accept("local", "thread/goal/updated", { threadId: "thread-1", turnId: null, goal: { threadId: "thread-1", objective: "finish", status: "active", tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2 } }), true);
  assert.equal(value.processor.accept("local", "thread/status/changed", { threadId: "thread-1", status: { type: "idle" } }), true);
  await value.processor.idle();

  const persisted = value.db.prepare("SELECT params_json FROM session_dashboard_notifications ORDER BY sequence").all() as Array<{ params_json: string }>;
  assert.equal(persisted.some((row) => row.params_json.includes("secret body")), false);
  assert.equal(value.store.pendingNotifications().length, 0);
  const facts = value.store.facts({ endpointId: "local", threadId: "thread-1" });
  assert.equal(facts.currentSettings.model, "gpt-5");
  assert.equal(facts.tokenUsage?.total.total_tokens, 10);
  assert.equal(facts.goal?.objective, "finish");
  assert.equal(value.runtime.getSession("local", "thread-1")?.nativeStatus, "idle");
  assert.ok(value.changes() >= 1);
});

test("replays a token notification accepted before a crash", async () => {
  const value = fixture({ readThread: async () => ({ turns: [{ id: "turn-1", startedAt: 1 }] }) });
  value.store.acceptNotification("local", "thread/tokenUsage/updated", { threadId: "thread-1", turnId: "turn-1", tokenUsage: usage }, 1_000);
  assert.equal(value.store.facts({ endpointId: "local", threadId: "thread-1" }).tokenUsage, null);
  await value.processor.drain();
  assert.equal(value.store.facts({ endpointId: "local", threadId: "thread-1" }).tokenUsage?.total.total_tokens, 10);
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
  value.runtime.setSession("local", "thread-1", "unavailable", "notLoaded");
  const resumeSequence = value.store.allocateObservationSequence();
  value.processor.accept("local", "thread/settings/updated", { threadId: "thread-1", threadSettings: { model: "new", effort: "high" } });
  await value.processor.idle();
  value.runtime.setSession("local", "thread-1", "managed", "idle");

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

test("resume orders native state at the later authoritative thread response", async () => {
  const value = fixture();
  value.runtime.setSession("local", "thread-1", "unavailable", "notLoaded");
  const settingsSequence = value.store.allocateObservationSequence();
  value.processor.accept("local", "thread/status/changed", { threadId: "thread-1", status: { type: "idle" } });
  await value.processor.idle();
  const nativeSequence = value.store.allocateObservationSequence();
  value.runtime.setSession("local", "thread-1", "managed", "notLoaded");

  value.processor.observeResume("local", "thread-1", {
    model: "gpt-5",
    reasoningEffort: "high",
    thread: { status: { type: "active" }, turns: [{ id: "active-turn", status: "inProgress", startedAt: 2 }] },
  }, 300, { settings: settingsSequence, native: nativeSequence });
  await value.processor.drain("local");

  assert.equal(value.runtime.getSession("local", "thread-1")?.nativeStatus, "active");
  assert.equal(value.runtime.activeTurn("local", "thread-1"), "active-turn");
});

test("idle waits for a blocked handler and leaves endpoint failures pending for retry", async () => {
  let reject!: (error: Error) => void;
  const blocked = new Promise<any>((_resolve, rejectPromise) => { reject = rejectPromise; });
  const value = fixture({ readThread: async () => blocked });
  value.processor.accept("local", "thread/tokenUsage/updated", { threadId: "thread-1", turnId: "unknown", tokenUsage: usage });
  let settled = false;
  const idle = value.processor.idle().then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  reject(new Error("endpoint stopped"));
  await idle;
  assert.equal(value.store.pendingNotifications().length, 1);
  assert.equal(value.errors.length, 1);
});

test("defers observations for an unavailable session that will be restored as managed", async () => {
  const value = fixture();
  value.runtime.setSession("local", "thread-1", "unavailable", "notLoaded");
  value.processor.accept("local", "thread/settings/updated", { threadId: "thread-1", threadSettings: { model: "gpt-5", effort: "high" } });
  await value.processor.idle();

  assert.equal(value.store.pendingNotifications().length, 1);
  assert.equal(value.store.facts({ endpointId: "local", threadId: "thread-1" }).currentSettings.model, null);
  value.runtime.setSession("local", "thread-1", "managed", "idle");
  await value.processor.drain("local");
  assert.equal(value.store.pendingNotifications().length, 0);
  assert.equal(value.store.facts({ endpointId: "local", threadId: "thread-1" }).currentSettings.model, "gpt-5");
});

test("quarantines an invalid durable observation without starving later rows", async () => {
  const value = fixture();
  assert.equal(value.processor.accept("local", "thread/tokenUsage/updated", {
    threadId: "thread-1", turnId: "turn-1", tokenUsage: { total: { totalTokens: -1 } },
  }), true);
  value.processor.accept("local", "thread/settings/updated", { threadId: "thread-1", threadSettings: { model: "gpt-5", effort: "high" } });
  await value.processor.idle();

  assert.equal(value.store.pendingNotifications().length, 0);
  assert.equal(value.store.facts({ endpointId: "local", threadId: "thread-1" }).currentSettings.model, "gpt-5");
  assert.equal(value.errors.length, 1);
  const invalid = value.db.prepare("SELECT state, error_json FROM session_dashboard_notifications WHERE sequence = 1").get() as { state: string; error_json: string };
  assert.equal(invalid.state, "failed");
  assert.deepEqual(JSON.parse(invalid.error_json), { message: "invalid thread/tokenUsage/updated notification" });
});

test("an unorderable token observation stays pending without starving later rows", async () => {
  const value = fixture({ readThread: async () => ({ turns: [] }) });
  value.processor.accept("local", "thread/tokenUsage/updated", { threadId: "thread-1", turnId: "not-visible-yet", tokenUsage: usage });
  value.processor.accept("local", "thread/settings/updated", { threadId: "thread-1", threadSettings: { model: "gpt-5", effort: "high" } });
  await value.processor.idle();

  assert.deepEqual(value.store.pendingNotifications().map((item) => item.method), ["thread/tokenUsage/updated"]);
  assert.equal(value.store.facts({ endpointId: "local", threadId: "thread-1" }).currentSettings.model, "gpt-5");
});

test("terminal observation stores only metadata and cannot clear a newer active turn", async () => {
  const value = fixture({ readThread: async () => ({ turns: [{ id: "old", startedAt: 1 }, { id: "new", startedAt: 2 }] }) });
  value.runtime.setActiveTurn("local", "thread-1", "new");
  await value.processor.observeTerminal({ endpointId: "local", threadId: "thread-1", turnId: "old", status: "completed", startedAt: 1, completedAt: 2, finalMessageId: "message-1" });
  assert.equal(value.runtime.activeTurn("local", "thread-1"), "new");
  assert.deepEqual(value.store.facts({ endpointId: "local", threadId: "thread-1" }).lastWorkerEvent, {
    message_id: "message-1", turn_id: "old", status: "completed", at: "1970-01-01T00:00:02.000Z",
  });
});
