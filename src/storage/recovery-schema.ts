import type { Database } from "./database.ts";

export const RECOVERY_TABLES = [
  "activated_chat_conversations",
  "arrival_sequence",
  "assistant_attempt_sources",
  "assistant_attempts",
  "assistant_turn_lease",
  "attachments",
  "conversation_cutover",
  "deliveries",
  "delivery_attachment_releases",
  "directive_consumptions",
  "discovery_snapshots",
  "endpoint_bindings",
  "event_batches",
  "events",
  "latest_owner_route",
  "logical_final_messages",
  "managed_epochs",
  "operation_attachment_refs",
  "operations",
  "qiyan_state",
  "schema_migrations",
  "session_dashboard_facts",
  "session_dashboard_meta",
  "session_dashboard_notifications",
  "session_manager_notes",
  "session_note_operations",
  "session_rollout_owned_turns",
  "session_rollout_ownership",
  "session_runtime",
  "session_turn_order",
  "slack_inbox",
  "slack_inbox_sequence",
  "slack_workspace_identity",
  "source_attachment_releases",
  "source_contexts",
  "telegram_state",
  "terminal_turn_observations",
  "turn_attachment_refs",
  "weixin_account_generations",
  "weixin_auth_incidents",
  "weixin_inbox",
  "weixin_inbox_attachment_refs",
  "weixin_inbox_media",
  "weixin_inbox_sequence",
  "weixin_outbound_steps",
  "weixin_route_tokens",
  "weixin_sync_state",
] as const;

export type RecoveryTable = typeof RECOVERY_TABLES[number];

export function assertRecoverySchema(db: Database): void {
  const expectedTables = [...RECOVERY_TABLES];
  const candidateTables = tableNames(db, "main");
  const damagedTables = tableNames(db, "damaged");
  if (!same(candidateTables, expectedTables) || !same(damagedTables, expectedTables)) throw new Error("unexpected tables");

  const candidateObjects = schemaObjects(db, "main");
  const damagedObjects = schemaObjects(db, "damaged");
  if (!same(candidateObjects, damagedObjects)) throw new Error("unexpected schema objects");

  for (const table of RECOVERY_TABLES) {
    const candidateColumns = tableXinfo(db, "main", table);
    const damagedColumns = tableXinfo(db, "damaged", table);
    if (!same(candidateColumns, damagedColumns)) throw new Error("unexpected columns");
    if (!same(foreignKeys(db, "main", table), foreignKeys(db, "damaged", table))) throw new Error("unexpected foreign keys");

    const candidateIndexes = indexes(db, "main", table);
    const damagedIndexes = indexes(db, "damaged", table);
    if (!same(candidateIndexes, damagedIndexes)) throw new Error("unexpected indexes");
    for (const index of candidateIndexes) {
      if (!same(indexXinfo(db, "main", index.name), indexXinfo(db, "damaged", index.name))) {
        throw new Error("unexpected index columns");
      }
    }
  }
}

export function recoveryColumns(db: Database, table: RecoveryTable): string[] {
  return tableXinfo(db, "main", table).filter((column) => column.hidden === 0).map((column) => column.name);
}

function tableNames(db: Database, schema: "main" | "damaged"): string[] {
  return (db.prepare(`SELECT name FROM ${schema}.sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>).map(({ name }) => name);
}

function schemaObjects(db: Database, schema: "main" | "damaged"): Array<{ type: string; name: string; table: string }> {
  return (db.prepare(`SELECT type, name, tbl_name AS table_name FROM ${schema}.sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all() as Array<{ type: string; name: string; table_name: string }>).map((row) => ({
      type: row.type,
      name: row.name,
      table: row.table_name,
    }));
}

interface ColumnSignature {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  defaultValue: unknown;
  pk: number;
  hidden: number;
}

function tableXinfo(db: Database, schema: "main" | "damaged", table: string): ColumnSignature[] {
  return (db.prepare(`PRAGMA ${schema}.table_xinfo(${quoteString(table)})`).all() as Array<Record<string, unknown>>).map((row) => ({
    cid: Number(row.cid),
    name: String(row.name),
    type: String(row.type),
    notnull: Number(row.notnull),
    defaultValue: row.dflt_value,
    pk: Number(row.pk),
    hidden: Number(row.hidden),
  }));
}

function foreignKeys(db: Database, schema: "main" | "damaged", table: string): Array<Record<string, unknown>> {
  return (db.prepare(`PRAGMA ${schema}.foreign_key_list(${quoteString(table)})`).all() as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id), seq: Number(row.seq), table: String(row.table), from: String(row.from),
    to: row.to == null ? null : String(row.to), onUpdate: String(row.on_update), onDelete: String(row.on_delete), match: String(row.match),
  }));
}

interface IndexSignature { name: string; unique: number; origin: string; partial: number }

function indexes(db: Database, schema: "main" | "damaged", table: string): IndexSignature[] {
  const rows = db.prepare(`PRAGMA ${schema}.index_list(${quoteString(table)})`).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    name: String(row.name), unique: Number(row.unique), origin: String(row.origin), partial: Number(row.partial),
  })).sort((left, right) => left.name.localeCompare(right.name));
}

function indexXinfo(db: Database, schema: "main" | "damaged", index: string): Array<Record<string, unknown>> {
  return (db.prepare(`PRAGMA ${schema}.index_xinfo(${quoteString(index)})`).all() as Array<Record<string, unknown>>).map((row) => ({
    seqno: Number(row.seqno), cid: Number(row.cid), name: row.name == null ? null : String(row.name),
    desc: Number(row.desc), coll: row.coll == null ? null : String(row.coll), key: Number(row.key),
  }));
}

function quoteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
