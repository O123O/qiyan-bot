import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "../../src/storage/database.ts";

test("conversation steering schema has one lease and ordered attempt members", () => {
  const db = createTestDatabase();
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
  for (const name of ["assistant_turn_lease", "assistant_attempt_sources", "arrival_sequence", "conversation_cutover"]) assert.ok(tables.has(name), name);
  const sourceColumns = new Set((db.prepare("PRAGMA table_info(source_contexts)").all() as Array<{ name: string }>).map((row) => row.name));
  for (const name of ["adapter_id", "conversation_key", "destination_json", "native_reply_json", "arrival_sequence", "source_class", "queue_notice_required"]) assert.ok(sourceColumns.has(name), name);
  const deliveryColumns = new Set((db.prepare("PRAGMA table_info(deliveries)").all() as Array<{ name: string }>).map((row) => row.name));
  for (const name of ["adapter_id", "conversation_key", "destination_json", "reply_json", "receipt_json"]) assert.ok(deliveryColumns.has(name), name);
  const operationColumns = new Set((db.prepare("PRAGMA table_info(operations)").all() as Array<{ name: string }>).map((row) => row.name));
  assert.ok(operationColumns.has("effect_class"));
  const operationIndexes = new Set((db.prepare("PRAGMA index_list(operations)").all() as Array<{ name: string }>).map((row) => row.name));
  assert.ok(operationIndexes.has("operations_attempt_call_kind_idx"));
});

test("only one assistant lease row is allowed and it references an attempt", () => {
  const db = createTestDatabase();
  db.prepare(`INSERT INTO source_contexts(id, kind, source_id, raw_text, attachment_ids_json, state, created_at, source_class)
    VALUES ('c', 'recovery', 'c', '', '[]', 'active', 1, 'internal'),
           ('d', 'recovery', 'd', '', '[]', 'active', 2, 'internal')`).run();
  db.prepare(`INSERT INTO assistant_attempts(id, context_id, turn_id, trigger_kind, state, created_at)
    VALUES ('a', 'c', 'pending:a', 'internal', 'active', 1),
           ('b', 'd', 'pending:b', 'internal', 'active', 2)`).run();
  db.prepare(`INSERT INTO assistant_turn_lease
    (singleton, phase, attempt_id, primary_context_id, client_user_message_id, trigger_kind, capacity_claim_id)
    VALUES (1, 'starting', 'a', 'c', 'm', 'internal', 'claim-a')`).run();
  assert.throws(() => db.prepare(`INSERT INTO assistant_turn_lease
    (singleton, phase, attempt_id, primary_context_id, client_user_message_id, trigger_kind, capacity_claim_id)
    VALUES (2, 'starting', 'b', 'd', 'n', 'internal', 'claim-b')`).run());
  assert.throws(() => db.prepare("UPDATE assistant_turn_lease SET attempt_id = 'missing' WHERE singleton = 1").run());
});

test("only one unresolved assistant input may exist globally", () => {
  const db = createTestDatabase();
  db.prepare(`INSERT INTO source_contexts(id, kind, source_id, raw_text, attachment_ids_json, state, created_at, source_class)
    VALUES ('c', 'recovery', 'c', '', '[]', 'active', 1, 'internal'),
           ('d', 'recovery', 'd', '', '[]', 'active', 2, 'internal')`).run();
  db.prepare(`INSERT INTO assistant_attempts(id, context_id, turn_id, trigger_kind, state, created_at)
    VALUES ('a', 'c', 'pending:a', 'internal', 'active', 1),
           ('b', 'd', 'pending:b', 'internal', 'active', 2)`).run();
  db.prepare(`INSERT INTO assistant_attempt_sources
    (attempt_id, context_id, source_ordinal, client_user_message_id, submission_kind, state, created_at, updated_at)
    VALUES ('a', 'c', 0, 'c', 'start', 'start_submitting', 1, 1)`).run();
  assert.throws(() => db.prepare(`INSERT INTO assistant_attempt_sources
    (attempt_id, context_id, source_ordinal, client_user_message_id, submission_kind, state, created_at, updated_at)
    VALUES ('b', 'd', 0, 'd', 'start', 'uncertain', 2, 2)`).run());
});
