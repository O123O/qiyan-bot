import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { migrations } from "../../src/storage/migrations.ts";
import {
  isDashboardMetadataRecoveryRequired,
  SessionDashboardStore,
} from "../../src/storage/session-dashboard-store.ts";

const identity = { endpointId: "local", threadId: "thread-1" };

test("dashboard metadata health validation identifies only invalid metadata", () => {
  {
    const db = createTestDatabase();
    const store = new SessionDashboardStore(db);
    assert.doesNotThrow(() => store.assertMetadataHealthy());
    db.close();
  }

  {
    const db = createTestDatabase();
    const store = new SessionDashboardStore(db);
    db.prepare("DELETE FROM session_dashboard_meta").run();
    assert.throws(() => store.assertMetadataHealthy(), (error: unknown) => {
      assert.equal(isDashboardMetadataRecoveryRequired(error), true);
      assert.equal(error instanceof Error ? error.message : "", "dashboard metadata requires automatic recovery");
      return true;
    });
    db.close();
  }

  {
    const db = createTestDatabase();
    const store = new SessionDashboardStore(db);
    db.close();
    assert.throws(() => store.assertMetadataHealthy(), (error: unknown) => {
      assert.equal(isDashboardMetadataRecoveryRequired(error), false);
      return true;
    });
  }
});

test("metadata-dependent boundaries request recovery once before mutating durable state", () => {
  const db = createTestDatabase();
  let recoveryRequests = 0;
  const store = new SessionDashboardStore(db, {
    onMetadataRecoveryRequired: () => {
      recoveryRequests += 1;
      throw new Error("private restart failure");
    },
  });
  store.observeCurrentSettings(identity, { model: "initial", observedAt: 1 }, 1);
  store.updateNotes(identity, "notes-before-loss", { project_summary: "preserved" }, 1);
  store.acceptNotification("local", "thread/settings/updated", { threadId: identity.threadId }, 1);
  const factsBefore = store.facts(identity);
  const notesBefore = store.notes(identity);
  const noteOperationsBefore = db.prepare("SELECT * FROM session_note_operations ORDER BY operation_id").all();
  const notificationsBefore = db.prepare("SELECT * FROM session_dashboard_notifications ORDER BY sequence").all();
  db.prepare("DELETE FROM session_dashboard_meta").run();

  const usage = {
    total: { total_tokens: 10, input_tokens: 7, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 },
    last_turn: { total_tokens: 2, input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
    model_context_window: 100,
    context_remaining: 90,
    context_used_percent: 10,
    observed_at: "1970-01-01T00:00:02.000Z",
  };
  const boundaries: Array<() => unknown> = [
    () => store.allocateObservationSequence(),
    () => store.acceptNotification("local", "thread/settings/updated", { threadId: identity.threadId }, 2),
    () => store.observeLastSent(identity, {
      text: "new", mode: "start", attachment_ids: [], turn_id: "turn-1", at: "1970-01-01T00:00:02.000Z",
    }, 1),
    () => store.observeLastWorkerEvent(identity, {
      message_id: "message-1", turn_id: "turn-1", status: "completed", at: "1970-01-01T00:00:02.000Z",
    }, 1),
    () => store.observeCurrentSettings(identity, { model: "gpt-5", observedAt: 2 }, 1),
    () => store.observeTokenUsage(identity, "turn-1", usage, 1, 1),
    () => store.observeGoal(identity, { objective: "new", status: "active", token_budget: null }, 2, 1, 2),
    () => store.updateNotes(identity, "notes-after-loss", { project_summary: "changed" }, 2),
    () => store.claimAssistantRoot("/assistant"),
    () => store.markDirty(),
    () => store.renderState(),
    () => store.markRenderSucceeded(1),
    () => store.markRenderFailed("render failed"),
  ];

  for (const boundary of boundaries) {
    assert.throws(boundary, (error: unknown) => isDashboardMetadataRecoveryRequired(error));
  }
  assert.equal(recoveryRequests, 1);
  assert.deepEqual(store.facts(identity), factsBefore);
  assert.deepEqual(store.notes(identity), notesBefore);
  assert.deepEqual(db.prepare("SELECT * FROM session_note_operations ORDER BY operation_id").all(), noteOperationsBefore);
  assert.deepEqual(db.prepare("SELECT * FROM session_dashboard_notifications ORDER BY sequence").all(), notificationsBefore);
});

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

test("dashboard view changes publish one coalesced event after durable writes", async () => {
  const store = new SessionDashboardStore(createTestDatabase());
  let changes = 0;
  const unsubscribe = store.onChange(() => { changes += 1; });

  store.observeCurrentSettings(identity, { model: "gpt-5", effort: "high", observedAt: 100 }, 1);
  store.observeGoal(identity, { objective: "ship", status: "active", token_budget: null }, 100, 2, 100);
  assert.equal(changes, 0, "listeners must not read from inside a storage transaction");
  await Promise.resolve();
  assert.equal(changes, 1);

  store.observeCurrentSettings(identity, { model: "gpt-5", effort: "high", observedAt: 200 }, 3);
  await Promise.resolve();
  assert.equal(changes, 1, "watermark-only writes do not change the projected dashboard");

  unsubscribe();
  store.markDirty();
  await Promise.resolve();
  assert.equal(changes, 1);
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

test("live token telemetry projects atomically with its sequence and turn order", () => {
  const db = createTestDatabase();
  const store = new SessionDashboardStore(db);
  const usage = { total: { total_tokens: 10, input_tokens: 7, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 }, last_turn: { total_tokens: 2, input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }, model_context_window: 100, context_remaining: 98, context_used_percent: 2, observed_at: "1970-01-01T00:00:02.000Z" };
  db.exec(`CREATE TRIGGER fail_token_revision BEFORE UPDATE OF revision ON session_dashboard_meta
    WHEN NEW.revision > OLD.revision BEGIN SELECT RAISE(ABORT, 'injected'); END;`);

  assert.throws(() => store.observeTokenUsageNotification(identity, "turn-1", usage, 2), /injected/);
  assert.equal(store.turnOrdinal(identity, "turn-1"), undefined);
  assert.equal(store.facts(identity).tokenUsage, null);
  assert.equal(store.renderState().revision, 0);
  assert.equal((db.prepare("SELECT next_observation_sequence AS value FROM session_dashboard_meta").get() as { value: number }).value, 1);
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
  assert.equal(db.prepare("SELECT 1 FROM session_dashboard_notifications WHERE sequence = ?").get(first), undefined);
  store.failNotification(second, { message: "invalid payload" });
  assert.deepEqual(store.pendingNotifications(), []);
});

test("dashboard inbox cleanup removes terminal rows but preserves unresolved work", () => {
  const db = createTestDatabase();
  const store = new SessionDashboardStore(db);
  const processed = store.acceptNotification("local", "thread/settings/updated", { threadId: "processed" }, 100);
  const failed = store.acceptNotification("local", "thread/settings/updated", { threadId: "failed" }, 101);
  const pending = store.acceptNotification("local", "thread/settings/updated", { threadId: "pending" }, 102);
  db.prepare("UPDATE session_dashboard_notifications SET state = 'processed' WHERE sequence = ?").run(processed);
  store.failNotification(failed, { message: "invalid payload" });

  const cleanup = migrations.find((migration) => typeof migration === "string"
    && migration.includes("DELETE FROM session_dashboard_notifications WHERE state <> 'pending'"));
  assert.equal(typeof cleanup, "string");
  db.exec(cleanup as string);

  assert.deepEqual(
    (db.prepare("SELECT sequence, state FROM session_dashboard_notifications ORDER BY sequence").all() as Array<{ sequence: number; state: string }>)
      .map((row) => ({ sequence: row.sequence, state: row.state })),
    [{ sequence: pending, state: "pending" }],
  );
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

test("claims exactly one assistant root", () => {
  const store = new SessionDashboardStore(createTestDatabase());
  store.claimAssistantRoot("/manager");
  store.claimAssistantRoot("/manager");
  assert.throws(() => store.claimAssistantRoot("/other"), /assistant root/);
});

test("rejects invalid persisted fact JSON instead of discarding it", () => {
  const db = createTestDatabase();
  const store = new SessionDashboardStore(db);
  db.prepare("INSERT INTO session_dashboard_facts(endpoint_id, thread_id, last_sent_json, last_sent_operation_sequence) VALUES (?, ?, ?, ?)").run("local", "thread-1", "{}", 1);
  assert.throws(() => store.facts(identity));
});
