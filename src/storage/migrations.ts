import type { DatabaseSync } from "node:sqlite";

export type Migration = string | ((db: DatabaseSync) => void);

export const migrations: readonly Migration[] = [
  `
  CREATE TABLE qiyan_state (
    product TEXT PRIMARY KEY,
    state_version INTEGER NOT NULL
  );
  INSERT INTO qiyan_state(product, state_version) VALUES ('qiyan-bot', 2);

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

  CREATE TABLE IF NOT EXISTS assistant_attempts (
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
    mapping_id TEXT NOT NULL,
    management_state TEXT NOT NULL,
    restore_state TEXT,
    native_status TEXT NOT NULL DEFAULT 'notLoaded',
    delivery_cursor TEXT,
    model TEXT,
    effort TEXT,
    active_turn_id TEXT,
    last_error TEXT,
    PRIMARY KEY(endpoint_id, thread_id, mapping_id)
  );
  CREATE TABLE IF NOT EXISTS managed_epochs (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    mapping_id TEXT NOT NULL,
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
    assistant_root TEXT,
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
  `
  ALTER TABLE source_contexts ADD COLUMN adapter_id TEXT;
  ALTER TABLE source_contexts ADD COLUMN conversation_key TEXT;
  ALTER TABLE source_contexts ADD COLUMN destination_json TEXT;
  ALTER TABLE source_contexts ADD COLUMN native_reply_json TEXT;
  ALTER TABLE source_contexts ADD COLUMN arrival_sequence INTEGER;
  ALTER TABLE source_contexts ADD COLUMN source_class TEXT NOT NULL DEFAULT 'internal'
    CHECK(source_class IN ('chat', 'internal'));
  ALTER TABLE source_contexts ADD COLUMN queue_notice_required INTEGER NOT NULL DEFAULT 0
    CHECK(queue_notice_required IN (0, 1));

  DROP INDEX source_context_source_idx;
  CREATE UNIQUE INDEX source_context_adapter_source_idx ON source_contexts(adapter_id, source_id)
    WHERE adapter_id IS NOT NULL;
  CREATE UNIQUE INDEX source_context_internal_source_idx ON source_contexts(kind, source_id)
    WHERE adapter_id IS NULL;

  CREATE TABLE arrival_sequence (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    next_value INTEGER NOT NULL
  );
  INSERT INTO arrival_sequence(singleton, next_value) VALUES (1, 1);

  CREATE TABLE conversation_cutover (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    phase TEXT NOT NULL CHECK(phase IN ('schema_added', 'routing_backfilled', 'complete'))
  );
  INSERT INTO conversation_cutover(singleton, phase) VALUES (1, 'schema_added');

  ALTER TABLE assistant_attempts ADD COLUMN adapter_id TEXT;
  ALTER TABLE assistant_attempts ADD COLUMN conversation_key TEXT;
  ALTER TABLE assistant_attempts ADD COLUMN destination_json TEXT;
  ALTER TABLE assistant_attempts ADD COLUMN native_reply_json TEXT;
  ALTER TABLE assistant_attempts ADD COLUMN tool_fence INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE assistant_attempts ADD COLUMN accepting_tools INTEGER NOT NULL DEFAULT 1;

  CREATE TABLE assistant_turn_lease (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    phase TEXT NOT NULL CHECK(phase IN ('starting', 'active', 'terminalizing')),
    attempt_id TEXT NOT NULL UNIQUE REFERENCES assistant_attempts(id),
    primary_context_id TEXT NOT NULL REFERENCES source_contexts(id),
    adapter_id TEXT,
    conversation_key TEXT,
    destination_json TEXT,
    native_reply_json TEXT,
    client_user_message_id TEXT NOT NULL,
    turn_id TEXT,
    trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('chat', 'internal')),
    capacity_claim_id TEXT NOT NULL,
    steer_paused INTEGER NOT NULL DEFAULT 0 CHECK(steer_paused IN (0, 1)),
    pause_reason TEXT
  );

  CREATE TABLE assistant_attempt_sources (
    attempt_id TEXT NOT NULL REFERENCES assistant_attempts(id),
    context_id TEXT NOT NULL REFERENCES source_contexts(id),
    source_ordinal INTEGER NOT NULL,
    client_user_message_id TEXT NOT NULL,
    submission_kind TEXT NOT NULL CHECK(submission_kind IN ('start', 'steer')),
    state TEXT NOT NULL CHECK(state IN ('pending', 'start_submitting', 'steer_submitting', 'uncertain', 'submitted', 'completed', 'failed', 'superseded')),
    expected_turn_id TEXT,
    observed_turn_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(attempt_id, context_id),
    UNIQUE(attempt_id, source_ordinal)
  );
  CREATE UNIQUE INDEX assistant_source_nonterminal_idx ON assistant_attempt_sources(context_id)
    WHERE state IN ('start_submitting', 'steer_submitting', 'uncertain', 'submitted');
  CREATE UNIQUE INDEX assistant_single_unresolved_input_idx ON assistant_attempt_sources((1))
    WHERE state IN ('start_submitting', 'steer_submitting', 'uncertain');

  ALTER TABLE operations ADD COLUMN effect_class TEXT NOT NULL DEFAULT 'side_effecting'
    CHECK(effect_class IN ('read_only', 'side_effecting'));

  ALTER TABLE deliveries ADD COLUMN adapter_id TEXT;
  ALTER TABLE deliveries ADD COLUMN conversation_key TEXT;
  ALTER TABLE deliveries ADD COLUMN destination_json TEXT;
  ALTER TABLE deliveries ADD COLUMN reply_json TEXT;
  ALTER TABLE deliveries ADD COLUMN receipt_json TEXT;
  `,
  `
  CREATE UNIQUE INDEX operations_attempt_call_kind_idx
    ON operations(attempt_id, call_id, kind);
  `,
  `
  ALTER TABLE source_contexts ADD COLUMN failed_attachments_json TEXT NOT NULL DEFAULT '[]';

  CREATE TABLE slack_inbox_sequence (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    next_value INTEGER NOT NULL
  );
  INSERT INTO slack_inbox_sequence(singleton, next_value) VALUES (1, 1);

  CREATE TABLE slack_inbox (
    event_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_ts TEXT NOT NULL,
    thread_ts TEXT,
    user_id TEXT NOT NULL,
    text TEXT NOT NULL,
    files_json TEXT NOT NULL,
    file_state_json TEXT NOT NULL DEFAULT '{}',
    arrival_sequence INTEGER NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('pending', 'processing', 'processed', 'retry')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    received_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX slack_inbox_state_sequence_idx ON slack_inbox(state, arrival_sequence);

  CREATE TABLE activated_chat_conversations (
    adapter_id TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    destination_json TEXT NOT NULL,
    activated_at INTEGER NOT NULL,
    PRIMARY KEY(adapter_id, conversation_key)
  );

  CREATE TABLE latest_owner_route (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    adapter_id TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    destination_json TEXT NOT NULL,
    reply_json TEXT,
    source_context_id TEXT NOT NULL REFERENCES source_contexts(id),
    accepted_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE slack_workspace_identity (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    team_id TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE weixin_account_generations (
    generation_id TEXT PRIMARY KEY,
    credential_revision_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    api_base_url TEXT NOT NULL,
    authorization_state TEXT NOT NULL
      CHECK(authorization_state IN ('active', 'relogin_required', 'credential_changed')),
    active INTEGER NOT NULL CHECK(active IN (0, 1)),
    activated_at INTEGER NOT NULL,
    retired_at INTEGER
  );
  CREATE UNIQUE INDEX weixin_single_active_generation_idx
    ON weixin_account_generations(active) WHERE active = 1;

  CREATE TABLE weixin_auth_incidents (
    incident_id TEXT PRIMARY KEY,
    generation_id TEXT NOT NULL REFERENCES weixin_account_generations(generation_id),
    authorization_state TEXT NOT NULL
      CHECK(authorization_state IN ('relogin_required', 'credential_changed')),
    category TEXT NOT NULL,
    warning_delivery_id TEXT REFERENCES deliveries(id),
    no_route INTEGER NOT NULL DEFAULT 0 CHECK(no_route IN (0, 1)),
    created_at INTEGER NOT NULL,
    CHECK(no_route = 0 OR warning_delivery_id IS NULL)
  );
  CREATE INDEX weixin_auth_incidents_unwarned_idx
    ON weixin_auth_incidents(created_at, incident_id)
    WHERE warning_delivery_id IS NULL;

  CREATE TABLE weixin_sync_state (
    generation_id TEXT PRIMARY KEY REFERENCES weixin_account_generations(generation_id),
    cursor TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE weixin_inbox_sequence (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    next_value INTEGER NOT NULL CHECK(next_value > 0)
  );
  INSERT INTO weixin_inbox_sequence(singleton, next_value) VALUES (1, 1);

  CREATE TABLE weixin_route_tokens (
    id TEXT PRIMARY KEY,
    generation_id TEXT NOT NULL REFERENCES weixin_account_generations(generation_id),
    token TEXT NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 0 CHECK(is_current IN (0, 1)),
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX weixin_current_route_token_idx
    ON weixin_route_tokens(generation_id) WHERE is_current = 1;
  CREATE UNIQUE INDEX weixin_route_token_generation_idx
    ON weixin_route_tokens(generation_id, id);

  CREATE TABLE weixin_inbox (
    generation_id TEXT NOT NULL REFERENCES weixin_account_generations(generation_id),
    identity_kind TEXT NOT NULL CHECK(identity_kind IN ('message', 'client')),
    identity_value TEXT NOT NULL,
    arrival_sequence INTEGER NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('pending', 'processing', 'retry', 'processed', 'fenced')),
    normalized_json TEXT NOT NULL,
    route_token_id TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    last_error_category TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(generation_id, identity_kind, identity_value),
    FOREIGN KEY(generation_id, route_token_id)
      REFERENCES weixin_route_tokens(generation_id, id)
  );
  CREATE INDEX weixin_inbox_state_sequence_idx
    ON weixin_inbox(generation_id, state, arrival_sequence);
  CREATE UNIQUE INDEX weixin_single_processing_head_idx
    ON weixin_inbox(generation_id) WHERE state = 'processing';

  CREATE TABLE weixin_inbox_media (
    generation_id TEXT NOT NULL,
    identity_kind TEXT NOT NULL,
    identity_value TEXT NOT NULL,
    item_ordinal INTEGER NOT NULL CHECK(item_ordinal >= 0),
    hold_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending', 'completed', 'failed')),
    descriptor_json TEXT NOT NULL,
    attachment_id TEXT REFERENCES attachments(id),
    attachment_scope_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(generation_id, identity_kind, identity_value, item_ordinal),
    FOREIGN KEY(generation_id, identity_kind, identity_value)
      REFERENCES weixin_inbox(generation_id, identity_kind, identity_value)
  );
  CREATE UNIQUE INDEX weixin_single_media_attachment_idx
    ON weixin_inbox_media(attachment_id) WHERE attachment_id IS NOT NULL;

  CREATE TABLE weixin_inbox_attachment_refs (
    hold_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    identity_kind TEXT NOT NULL,
    identity_value TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL REFERENCES attachments(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(hold_id, attachment_id),
    FOREIGN KEY(generation_id, identity_kind, identity_value)
      REFERENCES weixin_inbox(generation_id, identity_kind, identity_value)
  );
  CREATE UNIQUE INDEX weixin_single_inbox_attachment_hold_idx
    ON weixin_inbox_attachment_refs(attachment_id);

  CREATE TABLE weixin_outbound_steps (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    generation_id TEXT NOT NULL REFERENCES weixin_account_generations(generation_id),
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    kind TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('prepared', 'dispatching', 'succeeded', 'uncertain')),
    request_hash TEXT NOT NULL,
    request_json TEXT NOT NULL,
    receipt_json TEXT,
    route_token_id TEXT,
    client_id TEXT,
    plan_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(delivery_id, ordinal),
    FOREIGN KEY(generation_id, route_token_id)
      REFERENCES weixin_route_tokens(generation_id, id)
  );
  CREATE INDEX weixin_outbound_generation_idx
    ON weixin_outbound_steps(generation_id, delivery_id, ordinal);
  `,
  `
  CREATE TABLE delivery_attachment_releases (
    delivery_id TEXT PRIMARY KEY REFERENCES deliveries(id),
    released_at INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO delivery_attachment_releases(delivery_id, released_at)
    SELECT id, updated_at FROM deliveries
    WHERE attachment_id IS NOT NULL
      AND (state IN ('confirmed', 'failed') OR (state = 'uncertain' AND mandatory = 0));
  `,
  `
  CREATE TABLE endpoint_bindings (
    endpoint_id TEXT PRIMARY KEY,
    destination_sha256 TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE session_rollout_ownership (
    endpoint_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    mapping_id TEXT NOT NULL,
    rollout_path TEXT NOT NULL,
    device TEXT NOT NULL,
    inode TEXT NOT NULL,
    byte_offset INTEGER NOT NULL CHECK(byte_offset >= 0),
    external_turn_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(endpoint_id, thread_id, mapping_id)
  );
  CREATE TABLE session_rollout_owned_turns (
    endpoint_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    mapping_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY(endpoint_id, thread_id, mapping_id, turn_id),
    FOREIGN KEY(endpoint_id, thread_id, mapping_id)
      REFERENCES session_rollout_ownership(endpoint_id, thread_id, mapping_id)
      ON DELETE CASCADE
  );
  `,
  `
  ALTER TABLE session_rollout_ownership
    ADD COLUMN materialized INTEGER NOT NULL DEFAULT 1 CHECK(materialized IN (0, 1));
  `,
  (db) => {
    const columns = new Set((db.prepare("PRAGMA table_info(operations)").all() as Array<{ name: string }>).map((row) => row.name));
    if (!columns.has("recovery_protocol")) {
      db.exec(`ALTER TABLE operations ADD COLUMN recovery_protocol INTEGER NOT NULL DEFAULT 0
        CHECK(recovery_protocol IN (0, 1))`);
    }
  },
  (db) => {
    const columns = new Set((db.prepare("PRAGMA table_info(session_runtime)").all() as Array<{ name: string }>).map((row) => row.name));
    if (!columns.has("goal_controlled")) {
      db.exec(`ALTER TABLE session_runtime ADD COLUMN goal_controlled INTEGER NOT NULL DEFAULT 0
        CHECK(goal_controlled IN (0, 1))`);
    }
  },
  (db) => {
    const columns = new Set((db.prepare("PRAGMA table_info(session_runtime)").all() as Array<{ name: string }>).map((row) => row.name));
    if (!columns.has("goal_control_sequence")) {
      db.exec(`ALTER TABLE session_runtime ADD COLUMN goal_control_sequence INTEGER NOT NULL DEFAULT 0
        CHECK(goal_control_sequence >= 0)`);
    }
  },
  (db) => {
    const columns = new Set((db.prepare("PRAGMA table_info(session_runtime)").all() as Array<{ name: string }>).map((row) => row.name));
    if (!columns.has("goal_control_known")) {
      db.exec(`ALTER TABLE session_runtime ADD COLUMN goal_control_known INTEGER NOT NULL DEFAULT 0
        CHECK(goal_control_known IN (0, 1))`);
    }
  },
  // Emulated goal state for Claude sessions (Phase 1.5). Codex persists goals inside
  // its app-server; a headless Claude session has no native goal engine, so QiYan
  // stores the objective/status/budget here and the thread/goal/* handlers read it.
  `
  CREATE TABLE IF NOT EXISTS claude_session_goals (
    endpoint_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL,
    token_budget INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (endpoint_id, thread_id)
  );`,
  // Provider-agnostic durable schedules (Phase 2.1). Net-new additive table: on any
  // trigger (wakeup timer / cron / monitor condition) the engine drives a turn via
  // the unified send_to_session. single_fire_key makes each fire idempotent across
  // restart. Codex and Claude sessions share this.
  `
  CREATE TABLE IF NOT EXISTS session_schedules (
    id TEXT PRIMARY KEY,
    nickname TEXT NOT NULL,
    endpoint_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    spec TEXT NOT NULL,
    message TEXT NOT NULL,
    state TEXT NOT NULL,
    next_fire_at INTEGER,
    interval_ms INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_schedules_due ON session_schedules(state, next_fire_at);`,
];
