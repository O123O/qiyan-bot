export const migrations = [
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
] as const;
