import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantDelegatedTurnStore } from "../../src/storage/assistant-delegated-turn-store.ts";
import { createTestDatabase, openDatabase } from "../../src/storage/database.ts";
import { migrations } from "../../src/storage/migrations.ts";

test("records the exact worker turn delegated by a QiYan start idempotently", () => {
  const store = new AssistantDelegatedTurnStore(createTestDatabase());
  const delegation = {
    endpointId: "remote",
    threadId: "thread-1",
    turnId: "turn-1",
    mappingId: "mapping-1",
    operationId: "operation-1",
    createdAt: 100,
  };

  assert.deepEqual(store.record(delegation), { inserted: true, reactivatedTerminalEvent: false });
  assert.deepEqual(store.record(delegation), { inserted: false, reactivatedTerminalEvent: false });
  assert.equal(store.has("remote", "thread-1", "turn-1"), true);
  assert.equal(store.has("remote", "thread-1", "other-turn"), false);
});

test("origin insertion atomically reactivates a terminal event only once", () => {
  const db = createTestDatabase();
  const store = new AssistantDelegatedTurnStore(db);
  db.prepare(`INSERT INTO events(id, endpoint_id, thread_id, turn_id, kind, payload_json, state, created_at)
    VALUES ('terminal:remote:thread-1:turn-1', 'remote', 'thread-1', 'turn-1', 'turn_terminal', '{}', 'processed', 1)`).run();
  const delegation = {
    endpointId: "remote", threadId: "thread-1", turnId: "turn-1", mappingId: "mapping-1",
    operationId: "operation-1", createdAt: 100,
  };

  assert.deepEqual(store.record(delegation), { inserted: true, reactivatedTerminalEvent: true });
  db.prepare("UPDATE events SET state = 'processed'").run();
  assert.deepEqual(store.record(delegation), { inserted: false, reactivatedTerminalEvent: false });
  assert.equal(db.prepare("SELECT state FROM events").get()!.state, "processed");
});

test("upgrade backfill preserves the latest successful QiYan-started turn for each current mapping", () => {
  const db = createTestDatabase();
  const store = new AssistantDelegatedTurnStore(db);
  db.prepare(`INSERT INTO operations
    (id, context_id, attempt_id, call_id, kind, args_hash, args_json, state, receipt_json, created_at, updated_at, sequence, recovery_protocol)
    VALUES ('operation-1', 'context', 'attempt', 'call', 'send_to_session', 'hash',
      '{"nickname":"worker","content":"work","attachment_ids":[],"mode":"start"}', 'succeeded',
      '{"mode":"start","turnId":"turn-1"}', 10, 10, 1, 1)`).run();
  db.prepare(`INSERT INTO session_dashboard_facts(endpoint_id, thread_id, last_sent_json)
    VALUES ('remote', 'thread-1', '{"text":"work","mode":"start","attachment_ids":[],"turn_id":"turn-1","at":"1970-01-01T00:00:00.010Z"}')`).run();
  db.prepare(`INSERT INTO events(id, endpoint_id, thread_id, turn_id, kind, payload_json, state, created_at)
    VALUES ('terminal:remote:thread-1:turn-1', 'remote', 'thread-1', 'turn-1', 'turn_terminal', '{}', 'coalesced', 1)`).run();

  assert.equal(store.backfillLastSentStarts([{ endpoint: "remote", thread_id: "thread-1", mapping_id: "mapping-1" }]), 1);
  assert.equal(store.backfillLastSentStarts([{ endpoint: "remote", thread_id: "thread-1", mapping_id: "mapping-1" }]), 0);
  assert.equal(store.has("remote", "thread-1", "turn-1"), true);
  assert.equal(db.prepare("SELECT state FROM events").get()!.state, "pending");
});

test("upgrade backfill never requeues an already processed historical completion", () => {
  const db = createTestDatabase();
  const store = new AssistantDelegatedTurnStore(db);
  db.prepare(`INSERT INTO operations
    (id, context_id, attempt_id, call_id, kind, args_hash, args_json, state, receipt_json, created_at, updated_at, sequence, recovery_protocol)
    VALUES ('operation-1', 'context', 'attempt', 'call', 'send_to_session', 'hash',
      '{"nickname":"worker","content":"work","attachment_ids":[],"mode":"start"}', 'succeeded',
      '{"mode":"start","turnId":"turn-1"}', 10, 10, 1, 1)`).run();
  db.prepare(`INSERT INTO session_dashboard_facts(endpoint_id, thread_id, last_sent_json)
    VALUES ('remote', 'thread-1', '{"text":"work","mode":"start","attachment_ids":[],"turn_id":"turn-1","at":"1970-01-01T00:00:00.010Z"}')`).run();
  db.prepare(`INSERT INTO events(id, endpoint_id, thread_id, turn_id, kind, payload_json, state, created_at)
    VALUES ('terminal:remote:thread-1:turn-1', 'remote', 'thread-1', 'turn-1', 'turn_terminal', '{}', 'processed', 1)`).run();

  assert.equal(store.backfillLastSentStarts([{ endpoint: "remote", thread_id: "thread-1", mapping_id: "mapping-1" }]), 1);
  assert.equal(store.has("remote", "thread-1", "turn-1"), true);
  assert.equal(db.prepare("SELECT state FROM events").get()!.state, "processed");
});

test("replaying the installed migration preserves current pending terminal work", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-delegation-replay-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "bot.sqlite3");
  const db = openDatabase(path);
  db.prepare(`INSERT INTO events(id, endpoint_id, thread_id, turn_id, kind, payload_json, state, created_at)
    VALUES ('terminal:remote:thread-1:turn-1', 'remote', 'thread-1', 'turn-1', 'turn_terminal', '{}', 'pending', 1)`).run();
  db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(migrations.length);
  db.close();

  const reopened = openDatabase(path);
  assert.equal(reopened.prepare("SELECT state FROM events WHERE id = 'terminal:remote:thread-1:turn-1'").get()!.state, "pending");
  reopened.close();
});

// A steer joins a turn that is already running, and the turn can finish before the steer's
// receipt is recorded. Its terminal has then already been settled -- with no wake, because at
// that moment nothing marked the turn as QiYan's. Recording late has to reopen it, or
// supervising a turn by steering into it would be a silent way to never hear it end.
test("recording a steered turn late reopens a terminal that already settled", () => {
  const db = createTestDatabase();
  const store = new AssistantDelegatedTurnStore(db);
  db.prepare(`INSERT INTO events(id, endpoint_id, thread_id, turn_id, kind, payload_json, state, created_at)
    VALUES ('terminal:remote:thread-1:turn-1', 'remote', 'thread-1', 'turn-1', 'turn_terminal', '{}', 'processed', 1)`).run();

  const outcome = store.record({
    endpointId: "remote", threadId: "thread-1", turnId: "turn-1",
    mappingId: "mapping-1", operationId: "operation-steer", createdAt: 2,
  });

  assert.equal(outcome.inserted, true);
  assert.equal(outcome.reactivatedTerminalEvent, true, "the settled terminal must be reopened");
  assert.equal(db.prepare("SELECT state FROM events WHERE id = 'terminal:remote:thread-1:turn-1'").get()!.state, "pending");
  assert.equal(store.has("remote", "thread-1", "turn-1"), true, "and the turn now wakes QiYan");
});

// The delegation record is what separates a turn QiYan is supervising from one the owner sent
// directly with /to. The latter must stay silent.
test("a turn QiYan never sent is not delegated and does not wake it", () => {
  const store = new AssistantDelegatedTurnStore(createTestDatabase());
  assert.equal(store.has("remote", "thread-1", "owner-sent-turn"), false);
});
