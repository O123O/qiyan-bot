import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ConversationBinding } from "../../src/chat/binding.ts";
import { openDatabase } from "../../src/storage/database.ts";
import { migrations } from "../../src/storage/migrations.ts";
import { finalizeConversationCutover, runConversationRoutingBackfill } from "../../src/storage/conversation-cutover.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";

const telegram: ConversationBinding = {
  adapterId: "telegram",
  conversationKey: "telegram:42",
  destination: { chatId: "42" },
};

async function legacyDatabase(): Promise<{ path: string; db: DatabaseSync }> {
  const root = await mkdtemp(join(tmpdir(), "qiyan-conversation-cutover-"));
  const path = join(root, "bot.sqlite3");
  const legacy = new DatabaseSync(path);
  legacy.exec("PRAGMA foreign_keys=ON");
  legacy.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
  const preConversationRoutingVersion = 7;
  assert.ok(migrations.length > preConversationRoutingVersion);
  for (let index = 0; index < preConversationRoutingVersion; index += 1) {
    legacy.exec("BEGIN IMMEDIATE");
    const migration = migrations[index]!;
    if (typeof migration === "function") migration(legacy);
    else legacy.exec(migration);
    legacy.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(index + 1);
    legacy.exec("COMMIT");
  }
  legacy.prepare(`INSERT INTO source_contexts(id, kind, source_id, raw_text, attachment_ids_json, state, created_at)
    VALUES ('chat-pending', 'telegram', '1', 'one', '[]', 'pending', 10),
           ('chat-done', 'telegram', '2', 'two', '[]', 'superseded', 20),
           ('recovery-chat', 'recovery', 'chat-done', '{}', '[]', 'pending', 30),
           ('recovery-internal', 'recovery', 'missing-parent', '{}', '[]', 'completed', 40),
           ('batch', 'event_batch', 'batch-1', '{}', '[]', 'completed', 50)`).run();
  legacy.prepare("UPDATE source_contexts SET superseded_by = 'recovery-chat' WHERE id = 'chat-done'").run();
  for (const [id, state] of [["prepared", "prepared"], ["dispatched", "dispatched"], ["uncertain", "uncertain"], ["confirmed", "confirmed"], ["failed", "failed"]] as const) {
    legacy.prepare(`INSERT INTO deliveries(id, kind, destination, body, mandatory, state, telegram_message_id, created_at, updated_at)
      VALUES (?, 'chat', '42', ?, 1, ?, ?, 1, 1)`).run(`delivery-${id}`, id, state, state === "confirmed" ? "9" : null);
  }
  legacy.close();
  return { path, db: openDatabase(path) };
}

test("routing backfill is complete, constrained, and idempotent", async () => {
  const { db } = await legacyDatabase();
  runConversationRoutingBackfill(db, telegram);
  const before = JSON.stringify(db.prepare("SELECT * FROM source_contexts ORDER BY created_at, id").all());
  runConversationRoutingBackfill(db, telegram);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM source_contexts ORDER BY created_at, id").all()), before);

  const sources = db.prepare(`SELECT id, adapter_id, conversation_key, source_class, arrival_sequence
    FROM source_contexts ORDER BY arrival_sequence`).all() as Array<Record<string, unknown>>;
  assert.deepEqual(sources.map((row) => row.id), ["chat-pending", "chat-done", "recovery-chat", "recovery-internal", "batch"]);
  assert.ok(sources.every((row) => Number.isInteger(row.arrival_sequence)));
  assert.deepEqual(new Set(sources.map((row) => row.arrival_sequence)).size, sources.length);
  assert.deepEqual({ ...sources.find((row) => row.id === "recovery-chat") }, {
    id: "recovery-chat", adapter_id: "telegram", conversation_key: "telegram:42", source_class: "internal", arrival_sequence: 3,
  });
  assert.equal(sources.find((row) => row.id === "recovery-internal")?.adapter_id, null);
  assert.equal(db.prepare("SELECT next_value FROM arrival_sequence WHERE singleton = 1").get()!.next_value, 6);
  assert.throws(() => db.prepare(`INSERT INTO source_contexts
    (id, kind, source_id, raw_text, attachment_ids_json, state, created_at, source_class)
    VALUES ('no-sequence', 'recovery', 'no-sequence', '', '[]', 'pending', 60, 'internal')`).run());
  assert.throws(() => db.prepare("UPDATE source_contexts SET arrival_sequence = 1 WHERE id = 'batch'").run());
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "new-source", kind: "recovery", sourceId: "new-source", rawText: "", attachmentIds: [] });
  assert.equal(db.prepare("SELECT arrival_sequence FROM source_contexts WHERE id = 'new-source'").get()!.arrival_sequence, 6);
  assert.equal(db.prepare("SELECT next_value FROM arrival_sequence WHERE singleton = 1").get()!.next_value, 7);

  const deliveries = db.prepare("SELECT adapter_id, conversation_key, destination_json, receipt_json FROM deliveries ORDER BY id").all() as Array<Record<string, unknown>>;
  assert.ok(deliveries.every((row) => row.adapter_id === "telegram" && row.conversation_key === "telegram:42"));
  assert.equal(JSON.parse(String(deliveries.find((row) => row.receipt_json)?.receipt_json ?? "null"))?.messageId, 9);
  assert.equal(db.prepare("SELECT phase FROM conversation_cutover WHERE singleton = 1").get()!.phase, "routing_backfilled");
  assert.equal(db.prepare("SELECT state_version FROM qiyan_state WHERE product = 'qiyan-bot'").get()!.state_version, 2);
  db.close();
});

test("a fresh Slack-only database completes routing backfill without a Telegram binding", () => {
  const db = openDatabase(":memory:");
  runConversationRoutingBackfill(db);
  assert.equal(db.prepare("SELECT phase FROM conversation_cutover WHERE singleton = 1").get()!.phase, "routing_backfilled");
  db.close();
});

test("finalization reconciles one active attempt from full history", async () => {
  const { db } = await legacyDatabase();
  db.prepare(`INSERT INTO assistant_attempts(id, context_id, turn_id, trigger_kind, state, created_at)
    VALUES ('attempt-active', 'chat-pending', 'turn-1', 'user', 'active', 60)`).run();
  runConversationRoutingBackfill(db, telegram);
  finalizeConversationCutover(db, {
    threadId: "assistant",
    turns: [{ id: "turn-1", status: "inProgress", itemsView: "full", items: [{ type: "userMessage", clientId: "chat-pending" }] }],
  });
  const lease = db.prepare("SELECT phase, attempt_id, turn_id, conversation_key, trigger_kind FROM assistant_turn_lease").get()!;
  assert.deepEqual({ ...lease }, { phase: "active", attempt_id: "attempt-active", turn_id: "turn-1", conversation_key: "telegram:42", trigger_kind: "chat" });
  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources").get()!.state, "submitted");
  assert.equal(db.prepare("SELECT phase FROM conversation_cutover WHERE singleton = 1").get()!.phase, "complete");
  assert.equal(db.prepare("SELECT state_version FROM qiyan_state WHERE product = 'qiyan-bot'").get()!.state_version, 3);
  db.close();
});

test("client-correlated cutover history cannot replace a provisional attempt identity", async () => {
  const { db } = await legacyDatabase();
  db.prepare(`INSERT INTO assistant_attempts(id, context_id, turn_id, trigger_kind, state, created_at)
    VALUES ('attempt-active', 'chat-pending', 'pending:attempt-active', 'user', 'active', 60)`).run();
  runConversationRoutingBackfill(db, telegram);
  assert.throws(() => finalizeConversationCutover(db, {
    threadId: "assistant",
    turns: [{ id: "rollout-1874", status: "completed", itemsView: "full", items: [{ type: "userMessage", clientId: "chat-pending" }] }],
  }), /exact|authoritative|identity/iu);
  assert.equal(db.prepare("SELECT turn_id FROM assistant_attempts WHERE id = 'attempt-active'").get()!.turn_id, "pending:attempt-active");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM assistant_turn_lease").get()!.count, 0);
  assert.equal(db.prepare("SELECT phase FROM conversation_cutover WHERE singleton = 1").get()!.phase, "routing_backfilled");
  db.close();
});

test("summary history cannot finalize an active legacy attempt", async () => {
  const { db } = await legacyDatabase();
  db.prepare(`INSERT INTO assistant_attempts(id, context_id, turn_id, trigger_kind, state, created_at)
    VALUES ('attempt-active', 'chat-pending', 'turn-1', 'user', 'active', 60)`).run();
  runConversationRoutingBackfill(db, telegram);
  assert.throws(() => finalizeConversationCutover(db, {
    threadId: "assistant",
    turns: [{ id: "turn-1", status: "inProgress", itemsView: "summary", items: [] }],
  }), /full/i);
  assert.equal(db.prepare("SELECT phase FROM conversation_cutover WHERE singleton = 1").get()!.phase, "routing_backfilled");
  assert.equal(db.prepare("SELECT state_version FROM qiyan_state WHERE product = 'qiyan-bot'").get()!.state_version, 2);
  db.close();
});
