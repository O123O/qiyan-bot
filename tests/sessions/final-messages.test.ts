import assert from "node:assert/strict";
import test from "node:test";
import { FinalMessageStore } from "../../src/sessions/final-messages.ts";
import { createTestDatabase } from "../../src/storage/database.ts";

function turn(overrides: Record<string, unknown> = {}) {
  return {
    id: "turn-1", status: "completed", completedAt: 123,
    items: [
      { type: "agentMessage", id: "comment", text: "working", phase: "commentary" },
      { type: "agentMessage", id: "final-1", text: "first", phase: "final_answer" },
      { type: "agentMessage", id: "final-2", text: "second", phase: "final_answer" },
    ],
    ...overrides,
  };
}

test("persists every explicit final while excluding commentary", () => {
  const store = new FinalMessageStore(createTestDatabase());
  const saved = store.persistTerminalTurn("local", "thread", turn(), 999);
  assert.deepEqual(saved.map((message) => message.body), ["first", "second"]);
  assert.deepEqual(saved.map((message) => message.itemOrder), [1, 2]);
  assert.equal(saved[0]?.completedAt, 123);
});

test("phase-unknown compatibility uses only the last unknown agent message", () => {
  const store = new FinalMessageStore(createTestDatabase());
  const saved = store.persistTerminalTurn("local", "thread", turn({
    items: [
      { type: "agentMessage", id: "one", text: "one", phase: null },
      { type: "agentMessage", id: "comment", text: "comment", phase: "commentary" },
      { type: "agentMessage", id: "two", text: "two", phase: null },
    ],
  }), 999);
  assert.deepEqual(saved.map((message) => message.body), ["two"]);
});

test("nullable completion time is observed once and reused across replay", () => {
  const db = createTestDatabase();
  const store = new FinalMessageStore(db);
  const first = store.persistTerminalTurn("local", "thread", turn({ completedAt: null }), 500);
  const replay = store.persistTerminalTurn("local", "thread", turn({ completedAt: null }), 800);
  assert.equal(first[0]?.completedAt, 500);
  assert.equal(replay[0]?.completedAt, 500);
});

test("a repeated final under a new turn is persisted; only same turn+item is idempotent", () => {
  const store = new FinalMessageStore(createTestDatabase());
  const first = store.persistTerminalTurn("local", "thread", turn({
    id: "turn-old",
    items: [{ type: "agentMessage", id: "shared", text: "old answer", phase: "final_answer" }],
  }), 1);
  // Same item id and body but a different turn is a distinct logical final and must not be dropped;
  // idempotency is provided solely by the deterministic per-turn primary key + INSERT OR IGNORE.
  const repeated = store.persistTerminalTurn("local", "thread", turn({
    id: "turn-new",
    items: [{ type: "agentMessage", id: "shared", text: "old answer", phase: "final_answer" }],
  }), 2);
  const changed = store.persistTerminalTurn("local", "thread", turn({
    id: "turn-changed",
    items: [{ type: "agentMessage", id: "shared", text: "new answer", phase: "final_answer" }],
  }), 3);

  assert.deepEqual(first.map((message) => message.body), ["old answer"]);
  assert.deepEqual(repeated.map((message) => ({ turnId: message.turnId, body: message.body })), [{ turnId: "turn-new", body: "old answer" }]);
  assert.deepEqual(changed.map((message) => message.body), ["new answer"]);
  // Re-persisting the same turn+item is idempotent via the primary key: no new row is created.
  const replay = store.persistTerminalTurn("local", "thread", turn({
    id: "turn-old",
    items: [{ type: "agentMessage", id: "shared", text: "old answer", phase: "final_answer" }],
  }), 4);
  assert.deepEqual(replay.map((message) => ({ turnId: message.turnId, body: message.body })), [{ turnId: "turn-old", body: "old answer" }]);
  assert.equal(store.list("local", "thread", 20).length, 3);
});

test("failed and interrupted terminal turns retain eligible text and successful no-message turns remain empty", () => {
  const store = new FinalMessageStore(createTestDatabase());
  assert.equal(store.persistTerminalTurn("local", "thread", turn({ id: "empty", items: [] }), 1).length, 0);
  assert.deepEqual(store.persistTerminalTurn("local", "thread", turn({ id: "failed", status: "failed" }), 2).map((m) => m.terminalStatus), ["failed", "failed"]);
  assert.equal(store.persistTerminalTurn("local", "thread", turn({ id: "running", status: "inProgress" }), 3).length, 0);
});

test("collection sorts by completion, turn id, and item order", () => {
  const store = new FinalMessageStore(createTestDatabase());
  store.persistTerminalTurn("local", "thread", turn({ id: "b", completedAt: 10 }), 0);
  store.persistTerminalTurn("local", "thread", turn({
    id: "a", completedAt: 10,
    items: [
      { type: "agentMessage", id: "a-comment", text: "working", phase: "commentary" },
      { type: "agentMessage", id: "a-final-1", text: "first", phase: "final_answer" },
      { type: "agentMessage", id: "a-final-2", text: "second", phase: "final_answer" },
    ],
  }), 0);
  assert.deepEqual(store.list("local", "thread", 3).map((message) => `${message.turnId}:${message.itemOrder}`), ["a:2", "b:1", "b:2"]);
});

test("normalizes second- and millisecond-scale completion times to millis for ordering", () => {
  const store = new FinalMessageStore(createTestDatabase());
  const one = (id: string) => [{ type: "agentMessage", id, text: id, phase: "final_answer" }];
  store.persistTerminalTurn("local", "thread", turn({ id: "sec", completedAt: 1_700_000_000, items: one("s") }), 0);    // seconds
  store.persistTerminalTurn("local", "thread", turn({ id: "ms", completedAt: 1_700_000_001_000, items: one("m") }), 0); // millis, 1s later
  const list = store.list("local", "thread", 20);
  assert.deepEqual(list.map((m) => m.completedAt), [1_700_000_000_000, 1_700_000_001_000]); // seconds scaled to millis
  assert.deepEqual(list.map((m) => m.turnId), ["sec", "ms"]); // correct chronological order despite mixed units
});

test("reads a logical message by its opaque persisted id", () => {
  const store = new FinalMessageStore(createTestDatabase());
  const [message] = store.persistTerminalTurn("local", "thread", turn(), 0);
  assert.equal(store.getById(message!.id)?.body, "first");
});
