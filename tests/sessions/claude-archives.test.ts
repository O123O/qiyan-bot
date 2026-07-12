import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "../../src/storage/database.ts";
import { ClaudeArchiveStore } from "../../src/sessions/claude-archives.ts";

test("archive tombstones are per (endpoint, thread), idempotent, and clearable", () => {
  const store = new ClaudeArchiveStore(createTestDatabase());
  assert.equal(store.has("claude-local", "t1"), false);
  store.add("claude-local", "t1");
  store.add("claude-local", "t1"); // idempotent
  assert.equal(store.has("claude-local", "t1"), true);
  assert.equal(store.has("dfw-claude", "t1"), false, "scoped by endpoint");
  assert.equal(store.has("claude-local", "t2"), false, "scoped by thread");
  store.remove("claude-local", "t1");
  assert.equal(store.has("claude-local", "t1"), false);
});
