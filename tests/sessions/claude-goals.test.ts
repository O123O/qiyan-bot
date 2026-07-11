import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "../../src/storage/database.ts";
import { ClaudeGoalStore } from "../../src/sessions/claude-goals.ts";

test("goal store persists set/get, status changes, and clear", () => {
  const db = createTestDatabase();
  const store = new ClaudeGoalStore(db);

  assert.equal(store.get("claude-local", "t1"), null);

  const set = store.set("claude-local", "t1", { objective: "ship it", tokenBudget: 5000 }, 1000);
  assert.deepEqual(set, { objective: "ship it", status: "active", tokenBudget: 5000 });
  assert.deepEqual(store.get("claude-local", "t1"), { objective: "ship it", status: "active", tokenBudget: 5000 });

  // pause / resume via status-only update
  assert.equal(store.setStatus("claude-local", "t1", "paused", 1001)?.status, "paused");
  assert.equal(store.setStatus("claude-local", "t1", "active", 1002)?.status, "active");

  // isolation by (endpoint, thread)
  store.set("claude-local", "t2", { objective: "other" }, 1003);
  assert.equal(store.get("claude-local", "t1")?.objective, "ship it");

  store.clear("claude-local", "t1");
  assert.equal(store.get("claude-local", "t1"), null);
  assert.equal(store.get("claude-local", "t2")?.objective, "other"); // unaffected
});

test("re-setting an objective overwrites in place", () => {
  const db = createTestDatabase();
  const store = new ClaudeGoalStore(db);
  store.set("e", "t", { objective: "first" }, 1);
  const second = store.set("e", "t", { objective: "second", status: "active" }, 2);
  assert.equal(second.objective, "second");
  assert.equal(store.get("e", "t")?.objective, "second");
});
