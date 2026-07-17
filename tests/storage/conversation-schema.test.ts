import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "../../src/storage/database.ts";

test("conversation steering schema has per-input reconciliation and no singleton lease", () => {
  const db = createTestDatabase();
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
  for (const name of ["assistant_input_reconciliation", "assistant_terminal_reconciliation", "assistant_attempt_sources", "arrival_sequence", "conversation_cutover"]) assert.ok(tables.has(name), name);
  assert.equal(tables.has("assistant_turn_lease"), false);
  const sourceColumns = new Set((db.prepare("PRAGMA table_info(source_contexts)").all() as Array<{ name: string }>).map((row) => row.name));
  for (const name of ["adapter_id", "conversation_key", "destination_json", "native_reply_json", "arrival_sequence", "source_class", "queue_notice_required"]) assert.ok(sourceColumns.has(name), name);
  const deliveryColumns = new Set((db.prepare("PRAGMA table_info(deliveries)").all() as Array<{ name: string }>).map((row) => row.name));
  for (const name of ["adapter_id", "conversation_key", "destination_json", "reply_json", "receipt_json"]) assert.ok(deliveryColumns.has(name), name);
  const operationColumns = new Set((db.prepare("PRAGMA table_info(operations)").all() as Array<{ name: string }>).map((row) => row.name));
  assert.ok(operationColumns.has("effect_class"));
  const operationIndexes = new Set((db.prepare("PRAGMA index_list(operations)").all() as Array<{ name: string }>).map((row) => row.name));
  assert.ok(operationIndexes.has("operations_attempt_call_kind_idx"));
});

test("unresolved assistant inputs are independent records", () => {
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
  assert.doesNotThrow(() => db.prepare(`INSERT INTO assistant_attempt_sources
    (attempt_id, context_id, source_ordinal, client_user_message_id, submission_kind, state, created_at, updated_at)
    VALUES ('b', 'd', 0, 'd', 'start', 'uncertain', 2, 2)`).run());
});
