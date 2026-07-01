import type { DatabaseSync } from "node:sqlite";

export type Migration = string | ((db: DatabaseSync) => void);

export const migrations: readonly Migration[] = [
  `
  CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS telegram_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    next_update_id INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO telegram_state(singleton, next_update_id) VALUES (1, 0);

  CREATE TABLE IF NOT EXISTS source_contexts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    attachment_ids_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    superseded_by TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS source_context_source_idx ON source_contexts(kind, source_id);

  CREATE TABLE IF NOT EXISTS coordinator_attempts (
    id TEXT PRIMARY KEY,
    context_id TEXT NOT NULL REFERENCES source_contexts(id),
    turn_id TEXT,
    trigger_kind TEXT NOT NULL DEFAULT 'user',
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    context_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    args_hash TEXT NOT NULL,
    args_json TEXT NOT NULL,
    state TEXT NOT NULL,
    receipt_json TEXT,
    error_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(context_id, attempt_id, call_id, kind)
  );
  CREATE TABLE IF NOT EXISTS directive_consumptions (
    context_id TEXT PRIMARY KEY REFERENCES source_contexts(id),
    kind TEXT NOT NULL,
    binding_hash TEXT NOT NULL,
    operation_id TEXT NOT NULL REFERENCES operations(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    destination TEXT NOT NULL,
    body TEXT NOT NULL,
    mandatory INTEGER NOT NULL,
    state TEXT NOT NULL,
    telegram_message_id TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    turn_id TEXT,
    item_id TEXT,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS event_batches (
    id TEXT PRIMARY KEY,
    event_ids_json TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS logical_final_messages (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    completed_at INTEGER NOT NULL,
    item_order INTEGER NOT NULL,
    body TEXT NOT NULL,
    terminal_status TEXT NOT NULL,
    UNIQUE(endpoint_id, thread_id, turn_id, item_id)
  );
  CREATE TABLE IF NOT EXISTS terminal_turn_observations (
    endpoint_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY(endpoint_id, thread_id, turn_id)
  );

  CREATE TABLE IF NOT EXISTS session_runtime (
    endpoint_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    management_state TEXT NOT NULL,
    restore_state TEXT,
    native_status TEXT NOT NULL DEFAULT 'notLoaded',
    delivery_cursor TEXT,
    model TEXT,
    effort TEXT,
    active_turn_id TEXT,
    last_error TEXT,
    PRIMARY KEY(endpoint_id, thread_id)
  );
  CREATE TABLE IF NOT EXISTS managed_epochs (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    baseline_turn_id TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS discovery_snapshots (
    id TEXT PRIMARY KEY,
    query_hash TEXT NOT NULL,
    rows_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    local_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    ref_count INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  (db) => {
    const columns = new Set((db.prepare("PRAGMA table_info(deliveries)").all() as Array<{ name: string }>).map((row) => row.name));
    if (!columns.has("attachment_id")) db.exec("ALTER TABLE deliveries ADD COLUMN attachment_id TEXT");
    if (!columns.has("attachment_scope_id")) db.exec("ALTER TABLE deliveries ADD COLUMN attachment_scope_id TEXT");
    if (!columns.has("reply_to")) db.exec("ALTER TABLE deliveries ADD COLUMN reply_to INTEGER");
  },
  `
  CREATE TABLE IF NOT EXISTS source_attachment_releases (
    context_id TEXT PRIMARY KEY REFERENCES source_contexts(id),
    released_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS turn_attachment_refs (
    endpoint_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL REFERENCES attachments(id),
    PRIMARY KEY(endpoint_id, thread_id, turn_id, attachment_id)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS operation_attachment_refs (
    hold_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL REFERENCES attachments(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(hold_id, attachment_id)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS session_dashboard_facts (
    endpoint_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    last_sent_json TEXT,
    last_sent_operation_sequence INTEGER,
    last_worker_event_json TEXT,
    last_worker_turn_ordinal INTEGER,
    current_model TEXT,
    current_effort TEXT,
    current_settings_observed_at INTEGER,
    current_settings_observation_sequence INTEGER,
    token_usage_json TEXT,
    token_turn_id TEXT,
    token_turn_ordinal INTEGER,
    token_observation_sequence INTEGER,
    goal_json TEXT,
    goal_observed INTEGER NOT NULL DEFAULT 0,
    goal_source_time INTEGER,
    goal_observation_sequence INTEGER,
    lifecycle_observed_at INTEGER,
    newest_observation_at INTEGER,
    PRIMARY KEY(endpoint_id, thread_id)
  );
  CREATE TABLE IF NOT EXISTS session_manager_notes (
    endpoint_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    project_summary TEXT,
    supervision_objective TEXT,
    pending_follow_up TEXT,
    updated_at INTEGER,
    PRIMARY KEY(endpoint_id, thread_id)
  );
  CREATE TABLE IF NOT EXISTS session_turn_order (
    endpoint_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    started_at INTEGER,
    turn_ordinal INTEGER NOT NULL,
    PRIMARY KEY(endpoint_id, thread_id, turn_id),
    UNIQUE(endpoint_id, thread_id, turn_ordinal)
  );
  CREATE TABLE IF NOT EXISTS session_note_operations (
    operation_id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    patch_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_dashboard_meta (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    coordinator_root TEXT,
    legacy_migration_complete INTEGER NOT NULL DEFAULT 0,
    dirty INTEGER NOT NULL DEFAULT 1,
    revision INTEGER NOT NULL DEFAULT 0,
    next_observation_sequence INTEGER NOT NULL DEFAULT 1,
    last_render_error TEXT,
    render_failure_generation INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO session_dashboard_meta(singleton) VALUES (1);
  CREATE TABLE IF NOT EXISTS session_dashboard_notifications (
    sequence INTEGER PRIMARY KEY,
    endpoint_id TEXT NOT NULL,
    method TEXT NOT NULL,
    params_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    received_at INTEGER NOT NULL,
    error_json TEXT
  );
  CREATE INDEX IF NOT EXISTS session_dashboard_notifications_state_idx
    ON session_dashboard_notifications(state, sequence);
  `,
  (db) => {
    const columns = new Set((db.prepare("PRAGMA table_info(session_runtime)").all() as Array<{ name: string }>).map((row) => row.name));
    if (!columns.has("native_observation_sequence")) db.exec("ALTER TABLE session_runtime ADD COLUMN native_observation_sequence INTEGER NOT NULL DEFAULT 0");
  },
  (db) => {
    const columns = new Set((db.prepare("PRAGMA table_info(operations)").all() as Array<{ name: string }>).map((row) => row.name));
    if (!columns.has("sequence")) db.exec("ALTER TABLE operations ADD COLUMN sequence INTEGER");
    db.exec("UPDATE operations SET sequence = rowid WHERE sequence IS NULL");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS operations_sequence_idx ON operations(sequence)");
  },
];
