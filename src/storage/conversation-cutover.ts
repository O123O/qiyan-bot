import { AppError } from "../core/errors.ts";
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ConversationBinding, JsonValue } from "../chat/binding.ts";
import type { Database } from "./database.ts";
import { inTransaction } from "./database.ts";

const readOnlyOperations = [
  "list_managed_sessions",
  "discover_sessions",
  "get_session_status",
  "read_worker_message",
  "list_models",
  "get_goal",
  "get_chat_history",
] as const;

export interface FullAssistantThreadSnapshot {
  threadId: string;
  turns: Array<{
    id: string;
    status: string;
    itemsView: "full" | "summary" | "notLoaded";
    items: Array<{ type: string; clientId?: string | null }>;
  }>;
}

export function preflightConversationCutover(path: string, hasLegacyTelegramBinding: boolean): void {
  if (hasLegacyTelegramBinding) return;
  try { if (statSync(path).size === 0) return; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  let inspector: DatabaseSync | undefined;
  try {
    inspector = new DatabaseSync(path, { readOnly: true });
    const tables = new Set((inspector.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!tables.has("source_contexts")) return;
    const sourceColumns = new Set((inspector.prepare("PRAGMA table_info(source_contexts)").all() as Array<{ name: string }>).map(({ name }) => name));
    const telegramSources = sourceColumns.has("adapter_id")
      ? Number((inspector.prepare("SELECT COUNT(*) AS count FROM source_contexts WHERE kind = 'telegram' AND adapter_id IS NULL").get() as { count: number }).count)
      : Number((inspector.prepare("SELECT COUNT(*) AS count FROM source_contexts WHERE kind = 'telegram'").get() as { count: number }).count);
    let legacyDeliveries = 0;
    if (tables.has("deliveries")) {
      const deliveryColumns = new Set((inspector.prepare("PRAGMA table_info(deliveries)").all() as Array<{ name: string }>).map(({ name }) => name));
      legacyDeliveries = deliveryColumns.has("adapter_id")
        ? Number((inspector.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE adapter_id IS NULL").get() as { count: number }).count)
        : Number((inspector.prepare("SELECT COUNT(*) AS count FROM deliveries").get() as { count: number }).count);
    }
    if (telegramSources > 0 || legacyDeliveries > 0) throw configuration("legacy Telegram state requires Telegram configuration before conversation routing cutover");
  } finally {
    inspector?.close();
  }
}

export function runConversationRoutingBackfill(db: Database, telegram?: ConversationBinding): void {
  inTransaction(db, () => {
    const phase = cutoverPhase(db);
    if (phase === "routing_backfilled" || phase === "complete") {
      validateRoutingBackfill(db);
      return;
    }

    let sequence = 1;
    const sources = db.prepare("SELECT id FROM source_contexts ORDER BY created_at, id").all() as Array<{ id: string }>;
    for (const source of sources) db.prepare("UPDATE source_contexts SET arrival_sequence = ? WHERE id = ?").run(sequence++, source.id);
    db.prepare("UPDATE arrival_sequence SET next_value = ? WHERE singleton = 1").run(sequence);

    const legacyTelegramCount = Number((db.prepare(`SELECT COUNT(*) AS count FROM source_contexts
      WHERE kind = 'telegram' AND (adapter_id IS NULL OR conversation_key IS NULL OR destination_json IS NULL)`).get() as { count: number }).count);
    const legacyDeliveryCount = Number((db.prepare(`SELECT COUNT(*) AS count FROM deliveries
      WHERE adapter_id IS NULL OR conversation_key IS NULL OR destination_json IS NULL`).get() as { count: number }).count);
    if ((legacyTelegramCount > 0 || legacyDeliveryCount > 0) && !telegram) {
      throw configuration("legacy Telegram state requires Telegram configuration before conversation routing cutover");
    }
    const destinationJson = telegram ? JSON.stringify(telegram.destination) : undefined;
    const replyJson = telegram?.reply === undefined ? null : JSON.stringify(telegram.reply);
    if (telegram) {
      db.prepare(`UPDATE source_contexts
        SET adapter_id = ?, conversation_key = ?, destination_json = ?, native_reply_json = COALESCE(native_reply_json, ?), source_class = 'chat'
        WHERE kind = 'telegram' AND (adapter_id IS NULL OR conversation_key IS NULL OR destination_json IS NULL)`)
        .run(telegram.adapterId, telegram.conversationKey, destinationJson!, replyJson);
    }

    const recoveryRows = db.prepare(`SELECT recovery.id AS recovery_id, original.adapter_id, original.conversation_key,
        original.destination_json, original.native_reply_json
      FROM source_contexts recovery
      JOIN source_contexts original ON original.id = recovery.source_id
      WHERE recovery.kind = 'recovery' AND original.adapter_id IS NOT NULL`).all() as Array<Record<string, unknown>>;
    for (const row of recoveryRows) {
      db.prepare(`UPDATE source_contexts SET adapter_id = ?, conversation_key = ?, destination_json = ?, native_reply_json = ?, source_class = 'internal'
        WHERE id = ?`).run(String(row.adapter_id), String(row.conversation_key), String(row.destination_json),
          row.native_reply_json == null ? null : String(row.native_reply_json), String(row.recovery_id));
    }
    db.prepare("UPDATE source_contexts SET source_class = 'internal' WHERE kind NOT IN ('telegram', 'slack')").run();

    db.prepare(`UPDATE assistant_attempts
      SET adapter_id = (SELECT adapter_id FROM source_contexts WHERE id = assistant_attempts.context_id),
          conversation_key = (SELECT conversation_key FROM source_contexts WHERE id = assistant_attempts.context_id),
          destination_json = (SELECT destination_json FROM source_contexts WHERE id = assistant_attempts.context_id),
          native_reply_json = (SELECT native_reply_json FROM source_contexts WHERE id = assistant_attempts.context_id)`).run();

    const deliveries = db.prepare("SELECT id, reply_to, telegram_message_id, adapter_id FROM deliveries").all() as Array<Record<string, unknown>>;
    for (const delivery of deliveries) {
      if (delivery.adapter_id != null) continue;
      const nativeReply: JsonValue | undefined = delivery.reply_to == null ? undefined : { messageId: Number(delivery.reply_to) };
      const receipt: JsonValue | undefined = delivery.telegram_message_id == null ? undefined : { messageId: Number(delivery.telegram_message_id) };
      db.prepare(`UPDATE deliveries SET adapter_id = ?, conversation_key = ?, destination_json = ?, reply_json = ?, receipt_json = ? WHERE id = ?`)
        .run(telegram!.adapterId, telegram!.conversationKey, destinationJson!,
          nativeReply === undefined ? null : JSON.stringify(nativeReply),
          receipt === undefined ? null : JSON.stringify(receipt), String(delivery.id));
    }

    if (readOnlyOperations.length > 0) {
      const placeholders = readOnlyOperations.map(() => "?").join(",");
      db.prepare(`UPDATE operations SET effect_class = 'read_only' WHERE kind IN (${placeholders})`).run(...readOnlyOperations);
    }

    installConversationRoutingGuards(db);
    validateRoutingBackfill(db);
    db.prepare("UPDATE conversation_cutover SET phase = 'routing_backfilled' WHERE singleton = 1").run();
  });
}

export function installConversationRoutingGuards(db: Database): void {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS source_context_arrival_sequence_idx ON source_contexts(arrival_sequence);
    CREATE TRIGGER IF NOT EXISTS source_context_arrival_required_insert
      BEFORE INSERT ON source_contexts WHEN NEW.arrival_sequence IS NULL
      BEGIN SELECT RAISE(ABORT, 'source arrival sequence is required'); END;
    CREATE TRIGGER IF NOT EXISTS source_context_arrival_required_update
      BEFORE UPDATE OF arrival_sequence ON source_contexts WHEN NEW.arrival_sequence IS NULL
      BEGIN SELECT RAISE(ABORT, 'source arrival sequence is required'); END;
  `);
}

export function finalizeConversationCutover(db: Database, assistant: FullAssistantThreadSnapshot): void {
  inTransaction(db, () => {
    const phase = cutoverPhase(db);
    if (phase === "schema_added") throw configuration("conversation routing backfill is incomplete");
    validateRoutingBackfill(db);
    if (phase === "complete") {
      validateComplete(db);
      return;
    }

    const active = db.prepare(`SELECT a.id, a.context_id, a.turn_id, a.trigger_kind,
        a.adapter_id, a.conversation_key, a.destination_json, a.native_reply_json
      FROM assistant_attempts a WHERE a.state = 'active' ORDER BY a.created_at, a.id`).all() as Array<Record<string, unknown>>;
    if (active.length > 1) throw configuration("multiple active assistant attempts cannot be cut over safely");
    if (active[0]) finalizeActiveAttempt(db, active[0], assistant);

    db.prepare("UPDATE conversation_cutover SET phase = 'complete' WHERE singleton = 1").run();
    db.prepare("UPDATE qiyan_state SET state_version = 3 WHERE product = 'qiyan-bot'").run();
    validateComplete(db);
  });
}

function finalizeActiveAttempt(db: Database, attempt: Record<string, unknown>, assistant: FullAssistantThreadSnapshot): void {
  const full = assistant.turns.filter((turn) => turn.itemsView === "full");
  const turn = full.find((candidate) => candidate.id === String(attempt.turn_id))
    ?? full.find((candidate) => candidate.items.some((item) => item.type === "userMessage" && item.clientId === String(attempt.context_id)));
  if (!turn) throw configuration("active assistant attempt requires full authoritative turn history");
  const terminal = new Set(["completed", "failed", "interrupted"]).has(turn.status);
  const now = Date.now();
  db.prepare("UPDATE assistant_attempts SET turn_id = ? WHERE id = ?").run(turn.id, String(attempt.id));
  db.prepare(`INSERT OR IGNORE INTO assistant_attempt_sources
    (attempt_id, context_id, source_ordinal, client_user_message_id, submission_kind, state, observed_turn_id, created_at, updated_at)
    VALUES (?, ?, 0, ?, 'start', 'submitted', ?, ?, ?)`)
    .run(String(attempt.id), String(attempt.context_id), String(attempt.context_id), turn.id, now, now);
  db.prepare(`INSERT INTO assistant_turn_lease
    (singleton, phase, attempt_id, primary_context_id, adapter_id, conversation_key, destination_json, native_reply_json,
      client_user_message_id, turn_id, trigger_kind, capacity_claim_id)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(terminal ? "terminalizing" : "active", String(attempt.id), String(attempt.context_id),
      attempt.adapter_id == null ? null : String(attempt.adapter_id), attempt.conversation_key == null ? null : String(attempt.conversation_key),
      attempt.destination_json == null ? null : String(attempt.destination_json), attempt.native_reply_json == null ? null : String(attempt.native_reply_json),
      String(attempt.context_id), turn.id,
      attempt.trigger_kind === "user" ? "chat" : "internal", `cutover:${String(attempt.id)}`);
}

function validateRoutingBackfill(db: Database): void {
  const missingSequence = Number((db.prepare("SELECT COUNT(*) AS count FROM source_contexts WHERE arrival_sequence IS NULL").get() as { count: number }).count);
  if (missingSequence !== 0) throw configuration("retained sources are missing arrival order");
  const invalidChat = Number((db.prepare(`SELECT COUNT(*) AS count FROM source_contexts
    WHERE source_class = 'chat' AND (adapter_id IS NULL OR conversation_key IS NULL OR destination_json IS NULL)`).get() as { count: number }).count);
  if (invalidChat !== 0) throw configuration("retained chat sources are missing conversation bindings");
  const invalidDelivery = Number((db.prepare(`SELECT COUNT(*) AS count FROM deliveries
    WHERE adapter_id IS NULL OR conversation_key IS NULL OR destination_json IS NULL`).get() as { count: number }).count);
  if (invalidDelivery !== 0) throw configuration("retained deliveries are missing adapter bindings");
}

function validateComplete(db: Database): void {
  validateRoutingBackfill(db);
  const version = Number((db.prepare("SELECT state_version FROM qiyan_state WHERE product = 'qiyan-bot'").get() as { state_version: number }).state_version);
  if (version !== 3) throw configuration("conversation cutover marker is inconsistent");
}

function cutoverPhase(db: Database): "schema_added" | "routing_backfilled" | "complete" {
  return String((db.prepare("SELECT phase FROM conversation_cutover WHERE singleton = 1").get() as { phase: string }).phase) as "schema_added" | "routing_backfilled" | "complete";
}

function configuration(message: string): AppError {
  return new AppError("CONFIGURATION_ERROR", message);
}
