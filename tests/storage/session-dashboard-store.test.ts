import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { SessionDashboardStore } from "../../src/storage/session-dashboard-store.ts";

const identity = { endpointId: "local", threadId: "thread-1" };

test("manager notes are stable by thread identity and operation-idempotent", () => {
  const store = new SessionDashboardStore(createTestDatabase());
  const first = store.updateNotes(identity, "op-1", { project_summary: "Payments", pending_follow_up: "check migration" }, 1_000);
  assert.deepEqual(first, {
    project_summary: "Payments",
    supervision_objective: null,
    pending_follow_up: "check migration",
    updated_at: "1970-01-01T00:00:01.000Z",
  });
  assert.deepEqual(store.updateNotes(identity, "op-1", { project_summary: "Payments", pending_follow_up: "check migration" }, 2_000), first);
  assert.throws(
    () => store.updateNotes(identity, "op-1", { project_summary: "Changed" }, 2_000),
    (error: unknown) => error instanceof AppError && error.code === "OPERATION_CONFLICT",
  );
  const cleared = store.updateNotes(identity, "op-2", { pending_follow_up: null }, 3_000);
  assert.equal(cleared.pending_follow_up, null);
  assert.equal(cleared.project_summary, "Payments");
});

test("newer equal settings advance their watermark without dirtying the rendered view", () => {
  const store = new SessionDashboardStore(createTestDatabase());
  assert.deepEqual(store.observeCurrentSettings(identity, { model: "gpt-5", effort: "high", observedAt: 100 }, 1), { valueChanged: true, watermarkAdvanced: true });
  const revision = store.renderState().revision;
  store.markRenderSucceeded(revision);

  assert.deepEqual(store.observeCurrentSettings(identity, { model: "gpt-5", effort: "high", observedAt: 300 }, 3), { valueChanged: false, watermarkAdvanced: true });
  assert.deepEqual(store.observeCurrentSettings(identity, { model: "old", effort: "low", observedAt: 200 }, 2), { valueChanged: false, watermarkAdvanced: false });
  assert.deepEqual(store.observeCurrentSettings(identity, { model: "gpt-5", effort: "high", observedAt: 300 }, 3), { valueChanged: false, watermarkAdvanced: false });
  assert.equal(store.renderState().dirty, false);
  assert.equal(store.renderState().revision, revision);
  assert.deepEqual(store.facts(identity).currentSettings, { model: "gpt-5", effort: "high", observedAt: 100, observationSequence: 3 });
});

test("orders sends, terminal events, token usage, and goals monotonically", () => {
  const store = new SessionDashboardStore(createTestDatabase());
  assert.equal(store.observeLastSent(identity, { text: "new", mode: "start", attachment_ids: [], turn_id: "t2", at: "1970-01-01T00:00:02.000Z" }, 2), true);
  assert.equal(store.observeLastSent(identity, { text: "old", mode: "start", attachment_ids: [], turn_id: "t1", at: "1970-01-01T00:00:01.000Z" }, 1), false);

  store.hydrateTurnOrder(identity, [
    { id: "t1", startedAt: 1 },
    { id: "t2", startedAt: 2 },
  ]);
  assert.equal(store.observeLastWorkerEvent(identity, { message_id: null, turn_id: "t2", status: "failed", at: "1970-01-01T00:00:02.000Z" }, 2), true);
  assert.equal(store.observeLastWorkerEvent(identity, { message_id: "m1", turn_id: "t1", status: "completed", at: "1970-01-01T00:00:01.000Z" }, 1), false);

  const usage = { total: { total_tokens: 10, input_tokens: 7, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 }, last_turn: { total_tokens: 2, input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }, model_context_window: 100, context_remaining: 90, context_used_percent: 10, observed_at: "1970-01-01T00:00:02.000Z" };
  assert.equal(store.observeTokenUsage(identity, "t2", usage, 2, 4), true);
  assert.equal(store.observeTokenUsage(identity, "t1", { ...usage, observed_at: "1970-01-01T00:00:03.000Z" }, 1, 5), false);
  assert.equal(store.observeTokenUsage(identity, "t2", { ...usage, context_remaining: 89 }, 2, 6), true);

  assert.equal(store.observeGoal(identity, { objective: "new", status: "active", token_budget: null }, 200, 7, 200), true);
  assert.equal(store.observeGoal(identity, { objective: "old", status: "paused", token_budget: null }, 100, 8, 300), false);
  assert.equal(store.observeGoal(identity, null, 300, 9, 300), true);
  assert.equal(store.facts(identity).goalObserved, true);
  assert.equal(store.facts(identity).goal, null);
});

test("authoritative history atomically remaps provisional turn ordinals and dependent facts", () => {
  const store = new SessionDashboardStore(createTestDatabase());
  const newOrdinal = store.observeTurnStarted(identity, { id: "new", startedAt: 3 });
  assert.equal(newOrdinal, 1);
  const usage = { total: { total_tokens: 10, input_tokens: 7, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 }, last_turn: { total_tokens: 2, input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }, model_context_window: 100, context_remaining: 90, context_used_percent: 10, observed_at: "1970-01-01T00:00:03.000Z" };
  store.observeLastWorkerEvent(identity, { message_id: "new-message", turn_id: "new", status: "completed", at: "1970-01-01T00:00:03.000Z" }, newOrdinal);
  store.observeTokenUsage(identity, "new", usage, newOrdinal, 1);

  store.hydrateTurnOrder(identity, [
    { id: "old-1", startedAt: 1 },
    { id: "old-2", startedAt: 2 },
    { id: "new", startedAt: 3 },
  ]);

  assert.equal(store.turnOrdinal(identity, "old-1"), 1);
  assert.equal(store.turnOrdinal(identity, "old-2"), 2);
  assert.equal(store.turnOrdinal(identity, "new"), 3);
  store.observeLastWorkerEvent(identity, { message_id: "old-message", turn_id: "old-2", status: "completed", at: "1970-01-01T00:00:04.000Z" }, 2);
  store.observeTokenUsage(identity, "old-2", { ...usage, observed_at: "1970-01-01T00:00:04.000Z" }, 2, 2);
  assert.equal(store.facts(identity).lastWorkerEvent?.turn_id, "new");
  assert.equal(store.facts(identity).tokenUsage?.observed_at, "1970-01-01T00:00:03.000Z");
});

test("notification receipt and completion are durable and sequence ordered", () => {
  const db = createTestDatabase();
  const store = new SessionDashboardStore(db);
  const first = store.acceptNotification("local", "thread/tokenUsage/updated", { threadId: "thread-1", tokenUsage: { total: 1 } }, 100);
  const second = store.acceptNotification("local", "thread/settings/updated", { threadId: "thread-1", model: "gpt-5" }, 101);
  assert.deepEqual([first, second], [1, 2]);
  assert.deepEqual(store.pendingNotifications().map((item) => item.sequence), [1, 2]);
  store.completeNotification(first);
  assert.deepEqual(store.pendingNotifications().map((item) => item.sequence), [2]);
  store.failNotification(second, { message: "invalid payload" });
  assert.deepEqual(store.pendingNotifications(), []);
});

test("render dirty acknowledgements cannot erase a concurrent revision", () => {
  const store = new SessionDashboardStore(createTestDatabase());
  const before = store.renderState().revision;
  store.observeLastSent(identity, { text: "one", mode: "start", attachment_ids: [], turn_id: "t1", at: "1970-01-01T00:00:01.000Z" }, 1);
  const rendered = store.renderState().revision;
  store.observeLastSent(identity, { text: "two", mode: "start", attachment_ids: [], turn_id: "t2", at: "1970-01-01T00:00:02.000Z" }, 2);
  store.markRenderSucceeded(rendered);
  assert.equal(store.renderState().dirty, true);
  assert.ok(store.renderState().revision > rendered && rendered > before);
  store.markRenderSucceeded(store.renderState().revision);
  assert.equal(store.renderState().dirty, false);
});

test("claims one assistant root and migrates every legacy entry exactly once", () => {
  const store = new SessionDashboardStore(createTestDatabase());
  store.claimAssistantRoot("/manager");
  store.claimAssistantRoot("/manager");
  assert.throws(() => store.claimAssistantRoot("/other"), /assistant root/);
  const registry = {
    version: 2 as const,
    assistant: { endpoint: "assistant-local", thread_id: "manager", project_dir: "/manager" },
    sessions: { payments: { endpoint: "local", thread_id: "thread-1", project_dir: "/payments" } },
  };
  store.importLegacy({ version: 1, sessions: { old: { thread_id: "thread-1", project_status: "working", current_objective: "finish", pending_follow_up: "check", updated_at: "old" } } }, registry, 1_000);
  assert.equal(store.legacyMigrationComplete(), true);
  assert.deepEqual(store.notes(identity), {
    project_summary: "working",
    supervision_objective: "finish",
    pending_follow_up: "check",
    updated_at: "1970-01-01T00:00:01.000Z",
  });
  store.importLegacy({ version: 1, sessions: {} }, registry, 2_000);
  assert.equal(store.notes(identity).updated_at, "1970-01-01T00:00:01.000Z");
});

test("legacy migration rejects unmatched and duplicate stable identities atomically", () => {
  const store = new SessionDashboardStore(createTestDatabase());
  const registry = {
    version: 2 as const,
    assistant: { endpoint: "assistant-local", thread_id: "manager", project_dir: "/manager" },
    sessions: { payments: { endpoint: "local", thread_id: "thread-1", project_dir: "/payments" } },
  };
  assert.throws(() => store.importLegacy({ version: 1, sessions: { stale: { thread_id: "missing", project_status: "x", updated_at: "old" } } }, registry, 1), /exactly one/);
  assert.equal(store.legacyMigrationComplete(), false);
  assert.throws(() => store.importLegacy({ version: 1, sessions: {
    one: { thread_id: "thread-1", project_status: "x", updated_at: "old" },
    two: { thread_id: "thread-1", project_status: "y", updated_at: "old" },
  } }, registry, 1), /more than once/);
  assert.equal(store.notes(identity).updated_at, null);
});

test("rejects invalid persisted fact JSON instead of discarding it", () => {
  const db = createTestDatabase();
  const store = new SessionDashboardStore(db);
  db.prepare("INSERT INTO session_dashboard_facts(endpoint_id, thread_id, last_sent_json, last_sent_operation_sequence) VALUES (?, ?, ?, ?)").run("local", "thread-1", "{}", 1);
  assert.throws(() => store.facts(identity));
});
