import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "../../src/storage/database.ts";
import { SessionControlStore } from "../../src/storage/session-control-store.ts";
import { SessionDeliveryProgressStore } from "../../src/storage/session-delivery-progress-store.ts";
import { ManagedEpochStore } from "../../src/storage/managed-epoch-store.ts";

const identity = ["prenyx", "thread-1", "mapping-1"] as const;

test("session controls persist only pending settings and goal-control intent", () => {
  const db = createTestDatabase();
  const controls = new SessionControlStore(db);
  controls.setModel(...identity, "gpt-5.4");
  controls.setEffort(...identity, "xhigh");
  controls.setGoalControlled(...identity, true, 9);

  assert.deepEqual(controls.settings(...identity), { model: "gpt-5.4", effort: "xhigh" });
  assert.deepEqual(controls.goalControl(...identity), { controlled: true, known: true, observationSequence: 9 });
  assert.deepEqual(controls.consumeSettings(...identity), { model: "gpt-5.4", effort: "xhigh" });
  assert.deepEqual(controls.settings(...identity), {});
  assert.equal(controls.clearGoalControlledBefore(...identity, 10), true);
  assert.deepEqual(controls.goalControl(...identity), { controlled: false, known: true, observationSequence: 9 });
});

test("delivery progress and managed epochs have focused durable stores", () => {
  const db = createTestDatabase();
  const progress = new SessionDeliveryProgressStore(db);
  const epochs = new ManagedEpochStore(db);

  progress.setCursor(...identity, "turn-7");
  assert.equal(progress.cursor(...identity), "turn-7");
  assert.equal(progress.markRecoveryIncident(...identity, "history budget exhausted"), true);
  assert.equal(progress.markRecoveryIncident(...identity, "duplicate"), false);
  assert.deepEqual(progress.recoveryIncident(...identity), { reason: "history budget exhausted" });

  const epochId = epochs.begin(...identity, "turn-6", 100);
  assert.deepEqual(epochs.current(...identity), { id: epochId, baselineTurnId: "turn-6", startedAt: 100 });
  epochs.end(...identity, 200);
  assert.equal(epochs.current(...identity), undefined);
  assert.deepEqual(epochs.latest(...identity), { id: epochId, baselineTurnId: "turn-6", startedAt: 100, endedAt: 200 });
});

test("focused stores contain no native status, active turn, or management state columns", () => {
  const db = createTestDatabase();
  for (const table of ["session_controls", "session_delivery_progress", "managed_epochs"]) {
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
    for (const forbidden of ["native_status", "active_turn_id", "management_state", "restore_state"]) {
      assert.equal(columns.has(forbidden), false, `${table}.${forbidden}`);
    }
  }
});
