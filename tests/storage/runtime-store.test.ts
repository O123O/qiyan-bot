import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "../../src/storage/database.ts";
import { RuntimeStore } from "../../src/storage/runtime-store.ts";

test("consumes pending settings once after a proven start", () => {
  const store = new RuntimeStore(createTestDatabase());
  store.setSession("local", "thread", "mapping-1", "managed", "idle");
  store.setModel("local", "thread", "mapping-1", "gpt-5");
  store.setEffort("local", "thread", "mapping-1", "high");
  const expected = store.settings("local", "thread", "mapping-1");
  assert.deepEqual(store.consumeSettings("local", "thread", "mapping-1", expected), { model: "gpt-5", effort: "high" });
  assert.deepEqual(store.settings("local", "thread", "mapping-1"), {});
  assert.deepEqual(store.consumeSettings("local", "thread", "mapping-1", expected), { model: "gpt-5", effort: "high" });
});

test("compare-and-clear preserves a replacement queued while a turn starts", () => {
  const store = new RuntimeStore(createTestDatabase());
  store.setSession("local", "thread", "mapping-1", "managed", "idle");
  store.setModel("local", "thread", "mapping-1", "old-model");
  const dispatched = store.settings("local", "thread", "mapping-1");
  store.setModel("local", "thread", "mapping-1", "next-model");
  assert.deepEqual(store.consumeSettings("local", "thread", "mapping-1", dispatched), { model: "old-model" });
  assert.deepEqual(store.settings("local", "thread", "mapping-1"), { model: "next-model" });
});

test("older native observations cannot regress status or active turn", () => {
  const store = new RuntimeStore(createTestDatabase());
  store.setSession("local", "thread", "mapping-1", "managed", "idle");
  assert.equal(store.reconcileNativeState("local", "thread", "mapping-1", "active", "turn-2", 2), true);
  assert.equal(store.reconcileNativeState("local", "thread", "mapping-1", "idle", undefined, 1), false);
  assert.equal(store.clearActiveTurn("local", "thread", "mapping-1", "turn-2", 1), false);
  assert.equal(store.activeTurn("local", "thread", "mapping-1"), "turn-2");
  assert.equal(store.clearActiveTurn("local", "thread", "mapping-1", "turn-2", 3), true);
  assert.equal(store.getSession("local", "thread", "mapping-1")?.nativeStatus, "idle");
  assert.equal(store.getSession("local", "thread", "mapping-1")?.nativeObservationSequence, 3);
});

test("a replacement mapping cannot see runtime settings, turns, or epochs from an old generation", () => {
  const store = new RuntimeStore(createTestDatabase());
  store.setSession("local", "thread", "mapping-old", "managed", "active");
  store.setModel("local", "thread", "mapping-old", "old-model");
  store.setActiveTurn("local", "thread", "mapping-old", "old-turn");
  store.beginEpoch("local", "thread", "mapping-old", "old-baseline", 1);

  store.setSession("local", "thread", "mapping-new", "managed", "idle");
  assert.deepEqual(store.settings("local", "thread", "mapping-new"), {});
  assert.equal(store.activeTurn("local", "thread", "mapping-new"), undefined);
  assert.equal(store.currentEpoch("local", "thread", "mapping-new"), undefined);
  assert.equal(store.getSession("local", "thread", "mapping-old")?.nativeStatus, "active");
});

test("goal-turn control is durable and mapping-generation scoped", () => {
  const store = new RuntimeStore(createTestDatabase());
  store.setSession("local", "thread", "mapping-old", "managed", "idle");
  assert.equal(store.goalControlled("local", "thread", "mapping-old"), false);
  assert.deepEqual(store.goalControl("local", "thread", "mapping-old"), { controlled: false, known: true, observationSequence: 0 });
  store.setGoalControlled("local", "thread", "mapping-old", true, 7);
  assert.equal(store.goalControlled("local", "thread", "mapping-old"), true);
  assert.deepEqual(store.goalControl("local", "thread", "mapping-old"), { controlled: true, known: true, observationSequence: 7 });

  assert.equal(store.clearGoalControlledBefore("local", "thread", "mapping-old", 6), false);
  assert.equal(store.goalControlled("local", "thread", "mapping-old"), true);
  assert.equal(store.clearGoalControlledBefore("local", "thread", "mapping-old", 8), true);
  assert.equal(store.goalControlled("local", "thread", "mapping-old"), false);
  store.setGoalControlled("local", "thread", "mapping-old", true, 9);

  store.setSession("local", "thread", "mapping-new", "managed", "idle");
  assert.equal(store.goalControlled("local", "thread", "mapping-new"), false);
  store.setGoalControlled("local", "thread", "mapping-old", false);
  assert.equal(store.goalControlled("local", "thread", "mapping-old"), false);
});
