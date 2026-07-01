# Automatic Session Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, superpowers:test-driven-development for every behavior change, and superpowers:verification-before-completion before claiming success.

**Goal:** Replace the coordinator-edited version-1 notebook with a backend-owned version-2 session dashboard, automatically project observed Codex session state into it, expose durable manager notes through a typed tool, and make `get_session_status` return the same complete status view.

**Architecture:** Add a stable-identity SQLite projection store for automatic observations and manager notes, then materialize a complete read-only JSON view keyed by the registry's current nicknames. A `SessionDashboard` service owns migration, observation ordering, snapshots, and serialized rendering; production actions/events feed it only after effects are proven. JSON rendering is deliberately outside app-server/registry transactions: failures leave a durable dirty bit and warning for maintenance retry without changing an already-confirmed operation into an uncertain one.

**Tech Stack:** TypeScript 6, Node.js 24 (`node:test`, `node:fs/promises`, `node:sqlite`), Zod 4, generated Codex app-server protocol types, existing operation ledger/session registry/runtime/event relay.

---

## Invariants to preserve

- SQLite and the session registry are authoritative. `session-status.json` is a replaceable materialized view, never an input after the one-time version-1 import.
- Dashboard facts and notes attach to `(endpoint_id, thread_id)`, not nickname. A rename changes only the rendered key.
- A confirmed external mutation remains successful when rendering fails. Do not let a render exception escape a successful tool action.
- A proven-no-effect action does not update the dashboard. An uncertain send is projected only when reconciliation proves its exact target turn.
- Older notifications cannot overwrite newer settings, token use, goals, sends, or worker events. Replaying the same event is idempotent.
- Lossy app-server observations are accepted into a durable SQLite inbox before asynchronous processing; graceful shutdown drains notification work before rendering and closing storage.
- Recovery applies its idempotent durable projection before marking an operation succeeded; a succeeded operation may never disappear from recovery without its dashboard fact already present.
- Unknown facts are `null`; no model, effort, token usage, context window, goal, or lifecycle fact is inferred.
- The dashboard stores the complete most-recent instruction and attachment identifiers, but no attachment bytes and no worker message bodies.
- `data/sessions.json` and `<coordinator-workdir>/session-status.json` are never modified by the coordinator. All changes use manager tools.

## File structure

- Create `src/coordinator/dashboard-schema.ts`: strict version-1/version-2 schemas, normalized public types, note-patch schema, and token/context derivation.
- Create `src/storage/session-dashboard-store.ts`: migrations-backed stable-identity facts, ordering guards, notes, migration marker, note-operation receipts, and render dirty state.
- Create `src/coordinator/session-dashboard.ts`: one-time version-1 import, complete snapshot assembly, serialized atomic mode-0400 rendering, and safe dirty retry.
- Delete `src/coordinator/notebook.ts`: remove the coordinator-editable notebook implementation.
- Modify `src/storage/migrations.ts`, `src/storage/runtime-store.ts`, and `src/storage/operation-store.ts`: persist projection state, consume pending settings atomically, and expose monotonic operation order for recovery.
- Modify `src/coordinator/workspace.ts`: prepare only the managed policy and a canonical dashboard path; leave dashboard migration/rendering until storage and registry exist.
- Modify `src/sessions/service.ts`: return applied start settings and a normalized live status observation.
- Modify `src/sessions/lifecycle.ts`: expose authoritative model/effort returned by thread start/resume without treating `thread/read` as a settings source.
- Modify `src/events/relay.ts`: report eligible terminal metadata after durable final-message persistence without copying bodies.
- Modify `src/coordinator/tools.ts`: add `update_session_notes` and validate bounded partial nullable patches.
- Modify `src/production-app.ts`: compose the dashboard, feed tool/event/recovery observations, return full status, and retry dirty rendering.
- Modify `assets/coordinator/AGENTS.md` and `assets/coordinator/session-status.example.json`: install the read-only operating contract and worked examples.
- Modify `README.md`: document ownership, status semantics, migration, repair, and manager-note usage.
- Create `tests/coordinator/dashboard-schema.test.ts`, `tests/storage/session-dashboard-store.test.ts`, and `tests/coordinator/session-dashboard.test.ts`.
- Modify focused runtime, session service, relay, tool, policy, workspace, startup, production integration, and recovery tests.

### Task 1: Define the public dashboard contract and durable projection schema

**Files:**
- Create: `tests/coordinator/dashboard-schema.test.ts`
- Create: `tests/storage/session-dashboard-store.test.ts`
- Create: `src/coordinator/dashboard-schema.ts`
- Create: `src/storage/session-dashboard-store.ts`
- Modify: `src/storage/migrations.ts`

- [ ] **Step 1: Write failing schema tests for version 1, version 2, notes, and token calculations**

Cover these cases:

```ts
test("parses the complete version-2 dashboard and rejects unknown keys", () => { /* identity, auto info, notes */ });
test("parses a legacy version-1 notebook for one-time migration", () => { /* all three manager fields */ });
test("requires at least one manager-note field and accepts null to clear", () => { /* partial patch */ });
test("normalizes exact app-server token usage and clamps derived context values", () => { /* remaining >= 0, percent 0..100 */ });
test("leaves token usage null until an exact notification is observed", () => { /* no estimates */ });
```

Use snake_case only in the rendered document. Define bounded manager-note fields (`project_summary`, `supervision_objective`, `pending_follow_up`) and reject an empty patch. Keep the full last instruction bounded only by the existing accepted chat-message size; do not add a lossy dashboard truncation.

- [ ] **Step 2: Write failing store tests around stable identity and monotonic observations**

Create database fixtures and prove:

- notes survive nickname-independent reads and nullable partial clearing;
- repeated use of the same note operation ID returns the original complete receipt and does not apply a changed patch;
- last sent, terminal worker metadata, current settings, token usage, and goal accept a newer source order and ignore an older one;
- a newer equal-valued settings/goal/lifecycle observation advances its watermark without dirtying an unchanged rendered value; replay of that same sequence does nothing;
- a known goal clear is persisted distinctly from an unobserved goal;
- dirty state is set in the same transaction as every accepted fact/note change and cleared only after a successful render;
- turn ordinals are stable across replay and authoritative history hydration preserves chronological order even when timestamps tie;
- notification acceptance atomically consumes a sequence and persists the normalized payload, while completion occurs only after its projection is durable;
- invalid persisted JSON in a facts/notes row is rejected rather than silently discarded.

- [ ] **Step 3: Run the focused tests to confirm the red state**

Run:

```bash
npm test -- tests/coordinator/dashboard-schema.test.ts tests/storage/session-dashboard-store.test.ts
```

Expected: FAIL because the schemas, tables, and store do not exist.

- [ ] **Step 4: Add one append-only database migration**

Add tables with foreign-key-independent stable keys so historical facts survive registry rename/reload:

```sql
CREATE TABLE session_dashboard_facts (
  endpoint_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  last_sent_json TEXT,
  last_sent_operation_sequence INTEGER,
  last_worker_event_json TEXT,
  last_worker_turn_ordinal INTEGER,
  current_model TEXT,
  current_settings_observation_sequence INTEGER,
  current_effort TEXT,
  token_usage_json TEXT,
  token_turn_id TEXT,
  token_turn_ordinal INTEGER,
  goal_json TEXT,
  goal_observed INTEGER NOT NULL DEFAULT 0,
  goal_source_time INTEGER,
  goal_observation_sequence INTEGER,
  lifecycle_observed_at INTEGER,
  newest_observation_at INTEGER,
  PRIMARY KEY(endpoint_id, thread_id)
);

CREATE TABLE session_manager_notes (
  endpoint_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  project_summary TEXT,
  supervision_objective TEXT,
  pending_follow_up TEXT,
  updated_at INTEGER,
  PRIMARY KEY(endpoint_id, thread_id)
);

CREATE TABLE session_turn_order (
  endpoint_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  started_at INTEGER,
  turn_ordinal INTEGER NOT NULL,
  PRIMARY KEY(endpoint_id, thread_id, turn_id)
);

CREATE TABLE session_note_operations (
  operation_id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  patch_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE session_dashboard_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  coordinator_root TEXT,
  legacy_migration_complete INTEGER NOT NULL DEFAULT 0,
  dirty INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 0,
  next_observation_sequence INTEGER NOT NULL DEFAULT 1,
  last_render_error TEXT,
  render_failure_generation INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE session_dashboard_notifications (
  sequence INTEGER PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  method TEXT NOT NULL,
  params_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  received_at INTEGER NOT NULL,
  error_json TEXT
);
```

Insert the singleton row. Dashboard notifications allocate a durable monotonic sequence and insert a normalized, body-free payload into the inbox in one transaction before launching asynchronous work. Receipt/response observations allocate their sequence immediately before their synchronous projection update. Later focused tasks add the native-runtime and operation sequence columns with their consumers, keeping each migration change paired with its behavioral tests.

Keep order components in typed columns instead of comparing timestamp strings or JSON. Settings compare observation sequence. Goals prefer authoritative `goal.updatedAt` and use observation sequence for clear/ties. Turns use a durable ordinal hydrated from authoritative `thread/read(... includeTurns: true)` order; live `turn/started` appends the next ordinal and replay of the same turn reuses it. Token and terminal observations compare turn ordinal, so a delayed older-turn event cannot replace a newer turn.

Every accepted mutation (and every registry/runtime change that affects rendering) increments `revision` and sets `dirty = 1`. A renderer captures the revision used to build its snapshot and clears dirty only with `UPDATE ... WHERE revision = ?`; if state changes during filesystem I/O, the newer revision remains dirty for the next render.

- [ ] **Step 5: Implement strict schemas and normalized public types**

Export:

- `LegacyNotebookDocumentSchema` for migration only;
- `SessionDashboardDocumentSchema` and its entry/identity/auto/note sub-schemas;
- `SessionNotesPatchSchema`, requiring at least one own field;
- `normalizeTokenUsage()` mapping app-server camelCase to rendered snake_case and deriving context remaining/percentage;
- `toIsoTimestamp()` with finite-number validation.

Represent a known cleared goal internally with `goal_observed = 1` plus JSON `null`; do not conflate it with no observation.

- [ ] **Step 6: Implement `SessionDashboardStore` with transactional conditional updates**

Provide focused methods rather than exposing SQL:

```ts
hydrateTurnOrder(identity, turns): void;
observeTurnStarted(identity, turn): number;
allocateObservationSequence(): number;
acceptNotification(endpointId, method, normalizedParams, receivedAt): number;
pendingNotifications(endpointId?): DashboardNotification[];
completeNotification(sequence): void;
failNotification(sequence, safeError): void;
observeLifecycle(identity, observedAt): boolean;
observeLastSent(identity, value, operationSequence): boolean;
observeLastWorkerEvent(identity, value, turnOrdinal): boolean;
observeCurrentSettings(identity, value, observationSequence): boolean;
observeTokenUsage(identity, turnId, value, turnOrdinal): boolean;
observeGoal(identity, valueOrNull, sourceTime, observationSequence): boolean;
updateNotes(identity, operationId, patch, now): ManagerNotes;
facts(identity): StoredSessionFacts;
notes(identity): ManagerNotes;
legacyMigrationComplete(): boolean;
claimCoordinatorRoot(canonicalRoot): void;
importLegacy(entries, registrySnapshot, now): void;
markDirty(): number;
renderState(): { dirty: boolean; revision: number; lastError: string | null; failureGeneration: number };
markRenderSucceeded(renderedRevision: number): void;
markRenderFailed(safeMessage): { warningRequired: boolean; generation: number };
```

Before migration, compare the prepared canonical coordinator root with the already-open registry coordinator identity. A mismatch is `CONFIGURATION_ERROR` before reading or changing the dashboard/marker. `claimCoordinatorRoot` persists that same root in the meta row and rejects a later different root, scoping the singleton migration marker to the coordinator identity.

`importLegacy` requires exactly one registry identity for every legacy entry and at most one legacy entry for an identity. Any unmatched entry, cross-endpoint ambiguity, or duplicate stable-thread mapping fails the whole transaction before setting the marker or replacing bytes. It maps only `project_status`, `current_objective`, and `pending_follow_up`, ignores old `last_sent`/`last_worker_event`, and marks migration complete in the same transaction. Missing legacy files also complete migration. Use operation ID plus canonical patch JSON for idempotent note updates; a reused ID with different identity/patch throws `OPERATION_CONFLICT`.

Observation methods distinguish public-value changes from ordering-watermark changes. Replay of the same assigned sequence is a true no-op. A newer sequence with the same value must still advance the stored watermark, but does not dirty/increment the render revision unless a rendered value or rendered observation timestamp changes. This prevents an older delayed handler from winning after a fresh equal-valued confirmation without causing pointless file rewrites.

- [ ] **Step 7: Run focused tests and commit**

Run the two new test files plus migration tests, then commit:

```bash
git add src/storage/migrations.ts src/storage/session-dashboard-store.ts src/coordinator/dashboard-schema.ts tests/coordinator/dashboard-schema.test.ts tests/storage/session-dashboard-store.test.ts
git commit -m "feat: persist automatic session dashboard state"
```

### Task 2: Replace the editable notebook with a backend-owned renderer and one-time migration

**Files:**
- Create: `tests/coordinator/session-dashboard.test.ts`
- Modify: `tests/coordinator/workspace.test.ts`
- Modify: `tests/production-startup.test.ts`
- Create: `src/coordinator/session-dashboard.ts`
- Modify: `src/coordinator/workspace.ts`
- Delete: `src/coordinator/notebook.ts`
- Delete: `tests/coordinator/notebook.test.ts`
- Modify: `assets/coordinator/session-status.example.json`

- [ ] **Step 1: Write failing migration/rendering tests**

Test all filesystem and migration states:

- absent file: complete the migration and render `{ "version": 2, "sessions": {} }`;
- valid version 1: import all manager fields by thread ID, exclude legacy automatic facts, then replace it with version 2;
- a legacy entry with no registry match, two registry identities for one thread ID, or two legacy nicknames for one identity: fail before the marker and preserve exact bytes;
- registry coordinator root versus prepared canonical workdir mismatch: fail before claiming the root or inspecting/migrating either path;
- a database already claimed by a different canonical coordinator root: fail even if the registry file is externally changed to match;
- crash-equivalent restart after the SQLite marker but before replacement: do not import twice; rebuild from SQLite;
- invalid first-upgrade input: throw `CONFIGURATION_ERROR` and preserve the exact bytes;
- existing version-2 generated file: ignore its contents as authority and rebuild from SQLite;
- symlink/directory dashboard path: reject it;
- nickname rename: keep facts/notes on stable identity and render under only the new key;
- renderer writes a sibling temporary regular file, sets `0400`, validates its own version-2 document, and atomically renames it;
- concurrent render requests serialize, a mutation during filesystem I/O cannot be lost, and the latest complete registry snapshot wins;
- injected write/rename failure leaves dirty state, records a safe error, and a later retry succeeds;
- the first failure in an episode requests one warning; repeated retry failures do not flood; success resets the episode.

Inject filesystem operations/clock where needed; never make tests chmod real user files merely to simulate coordinator edits.

- [ ] **Step 2: Run the focused tests to confirm failure**

```bash
npm test -- tests/coordinator/session-dashboard.test.ts tests/coordinator/workspace.test.ts tests/production-startup.test.ts
```

- [ ] **Step 3: Implement `SessionDashboard`**

Construct it from the store, registry, runtime store, dashboard path, clock, and injectable atomic writer. Responsibilities:

- validate the canonical prepared root against the registry coordinator identity and claim that root in SQLite before inspecting any dashboard file;
- inspect only a first-upgrade file while `legacy_migration_complete = 0`;
- migrate valid version 1, accept an already-version-2 file as generated output, or mark an absent file complete;
- refuse invalid/special-file first-upgrade input without replacing it;
- build every registry session with identity, runtime lifecycle/pending settings, stored observations, and stored notes;
- derive `observed_at` as the maximum included observation time;
- validate the fully assembled document before writing;
- serialize renders with a non-poisoning promise tail;
- write a unique sibling with `flag: "wx"`, `mode: 0o400`, sync/close it, atomically rename it, and clean up a leftover temporary on failure;
- provide `initializeAndRender()`, `renderIfDirty()`, `snapshot()`, and `status(nickname)`; `renderIfDirty()` captures and conditionally acknowledges a specific store revision.

Keep rendering errors out of fact mutation methods. Production will call a safe wrapper that records one structural warning per failure generation.

- [ ] **Step 4: Make workspace preparation return a path, not a notebook object**

Change `PreparedCoordinatorWorkspace` to include `dashboardPath: join(root, "session-status.json")`. Remove `notebookTemplatePath`, notebook bootstrapping, and `CoordinatorNotebook` imports. Workspace preparation still owns policy/hash safety and path separation; dashboard initialization occurs after storage and registry phases.

Update startup tests so the dashboard is created by the reconciliation/dashboard phase, not workspace preparation. Keep `assets/coordinator/session-status.example.json` as a validated version-2 documentation/package example, but do not copy it into the live workdir.

- [ ] **Step 5: Run tests, typecheck, and commit**

```bash
npm test -- tests/coordinator/session-dashboard.test.ts tests/coordinator/workspace.test.ts tests/production-startup.test.ts
npm run typecheck
git add -A
git commit -m "feat: render a backend-owned session dashboard"
```

### Task 3: Separate pending/current settings and normalize live session status

**Files:**
- Create: `tests/storage/runtime-store.test.ts`
- Modify: `tests/sessions/service.test.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `src/storage/runtime-store.ts`
- Modify: `src/sessions/service.ts`

- [ ] **Step 1: Write failing tests for one-shot pending settings**

Prove:

- `setModel`/`setEffort` appear in pending settings;
- `consumeSettings` returns both and clears both atomically;
- a started turn returns `appliedSettings`, while steer does not consume or claim settings;
- a terminal-at-start response still consumes and reports its applied settings;
- a failed `turn/start` keeps pending settings for a safe retry;
- an explicitly supplied/checkpointed pending-settings snapshot is the exact snapshot sent and compare-cleared after proof;
- status reports normalized thread status/current goal without treating pending values as current or pretending that `thread/read` contains model settings.
- native status/active-turn writes accept a newer durable observation sequence and ignore an older one, including after restart.

- [ ] **Step 2: Run the focused tests to confirm failure**

```bash
npm test -- tests/storage/runtime-store.test.ts tests/sessions/service.test.ts
```

- [ ] **Step 3: Implement atomic consumption only after a proven start**

Add a nullable/defaulted `native_observation_sequence` column to `session_runtime`, then make native status/active-turn reconciliation conditional on it. Keep management transitions explicit, but ensure an older app-server notification cannot regress native state written by a newer response.

Keep `runtime.settings()` as a read. Let the caller supply the already-checkpointed settings snapshot to `SessionService.send`; do not re-read and silently change it immediately before dispatch. Change `consumeSettings(expected)` to compare-and-clear in a database transaction after `turn/start` proves creation: clear only values equal to the settings actually sent, and leave a concurrently replaced value pending for the next turn. Return the settings that were applied to the proven turn:

```ts
{ mode: "start", turnId, terminal, appliedSettings: consumedSettings }
```

Do not throw after a proven external start merely because a pending value changed concurrently; that would incorrectly turn a known effect into an uncertain operation. The compare-and-clear result separates the applied old value from the still-pending replacement.

- [ ] **Step 4: Return a typed normalized live observation from `SessionService.status`**

Use `thread/read` and `thread/goal/get`, normalize `thread.status.type` and the exact raw goal fields needed by the dashboard. `ThreadReadResponse.thread` does not contain current model/effort, so leave those to durable `thread/settings/updated` and thread start/resume observations. Do not expose account billing/rate-limit data. Missing protocol fields remain `null`; production merges the live lifecycle/goal result with durable settings/token observations.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- tests/storage/runtime-store.test.ts tests/sessions/service.test.ts
git add src/storage/migrations.ts src/storage/runtime-store.ts src/sessions/service.ts tests/storage/runtime-store.test.ts tests/sessions/service.test.ts
git commit -m "fix: distinguish current and pending session settings"
```

### Task 4: Observe app-server state and terminal worker metadata

**Files:**
- Modify: `tests/events/relay.test.ts`
- Create or modify: `tests/coordinator/session-dashboard-notifications.test.ts`
- Modify: `src/events/relay.ts`
- Modify: `src/production-app.ts`

- [ ] **Step 1: Write failing event tests**

Cover generated-protocol payloads for:

- `turn/started`: record the turn's source time/order, active turn, and active status;
- `thread/status/changed`: update native status without inventing an active turn;
- `thread/settings/updated`: update current model and effort in durable receive order while preserving pending values;
- `thread/tokenUsage/updated`: store exact total/last/window against its turn and reject an older turn after a newer one;
- `thread/goal/updated` and `thread/goal/cleared`: distinguish current, cleared, stale, and replayed observations;
- `turn/completed`: record terminal status/time and the last persisted logical final message ID (or `null`), never its body;
- events for coordinator/unknown/detached sessions do not create project dashboard facts.

Also prove terminal replay via `reconcileEndpoint()` does not regress or duplicate the worker event. Add these queue/recovery cases:

- notification A is received first but its asynchronous work finishes after notification B: the durable sequence and serialized project-notification queue leave B's settings/lifecycle state current;
- settings A is stored at sequence 1, old queued B has sequence 2, and a fresh resume confirms equal-valued A at sequence 3: A advances the watermark without dirtying the unchanged view and delayed B is rejected;
- crash after accepting a token-usage notification but before processing: restart replays its pending inbox row and preserves the otherwise unrecoverable token data;
- crash after projection but before marking the inbox row complete: replay is idempotent and completes the row;
- shutdown with a blocked notification handler does not close SQLite underneath it; work either finishes before close or remains pending for restart.

- [ ] **Step 2: Run event tests to confirm failure**

```bash
npm test -- tests/events/relay.test.ts tests/coordinator/session-dashboard-notifications.test.ts
```

- [ ] **Step 3: Add a terminal-observation callback after durable persistence**

Extend `EventRelay` with an optional callback receiving:

```ts
{
  endpointId, threadId, turnId, status,
  completedAt,
  finalMessageId: messages.at(-1)?.id ?? null
}
```

Invoke it after `persistTerminalTurn` and the terminal event are durable. The callback receives metadata only. Existing relay tests without a callback must remain valid.

- [ ] **Step 4: Add typed project-notification observation in production**

Before/alongside relay handling, accept each supported project observation by atomically allocating a sequence and inserting a normalized inbox row, then process pending rows through one non-poisoning per-endpoint promise tail. Mark a row complete only after its runtime/dashboard projection commits. This preserves JSON-RPC receive order even when a handler awaits history, survives a crash before processing, and lets a projection-before-completion crash replay safely. The persisted sequence prevents a late older handler or reconnect boundary from overwriting a newer observation. Apply the same conditional sequence to runtime native status/active-turn updates, not only the rendered facts.

Persist only the fields needed for dashboard observation. In particular, never copy terminal turn items or worker bodies into the inbox. `turn/completed` remains recoverable through the existing authoritative `EventRelay.reconcileEndpoint()` path; settings, status, goal, turn-order, and token payloads are normalized and safe to retain. Invalid inbox payloads are marked failed with a structural warning and cannot mutate automatic state.

Normalize protocol seconds/milliseconds in one helper. Hydrate turn ordinals from authoritative history on startup/reconnect. For token usage, use the stored turn ordinal; when a notification references an unknown turn, read authoritative thread history to establish its order before allowing it to replace a known newer turn. If ordering still cannot be proved, do not promote it over a known newer token row.

There is no app-server settings-read method: `thread/read` contains neither model nor effort. Current settings come only from top-level thread start/resume responses and receive-ordered `thread/settings/updated` notifications. Goal updates use `goal.updatedAt`; goal-clear/tool reconciliation may use the existing goal get endpoint. Replay of the same inbox sequence is a no-op; an identical payload accepted at a newer sequence still advances the ordering watermark.

Runtime lifecycle updates and durable fact writes happen before scheduling the safe renderer. Notification handlers remain idempotent and must not generate chat messages solely for routine dashboard changes.

On startup, after the endpoint is ready and managed sessions are resumed, drain all pending observation rows before final dashboard rendering and coordinator startup. During graceful stop, stop accepting callbacks, await the notification tail, then await the render tail before SQLite closes. If endpoint-dependent processing can no longer finish after endpoint shutdown, leave the row pending for the next startup rather than touching a closed database.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- tests/events/relay.test.ts tests/coordinator/session-dashboard-notifications.test.ts
git add src/events/relay.ts src/production-app.ts tests/events/relay.test.ts tests/coordinator/session-dashboard-notifications.test.ts
git commit -m "feat: observe codex session status events"
```

### Task 5: Integrate tools, receipts, recovery, and complete status

**Files:**
- Modify: `tests/coordinator/tools.test.ts`
- Modify: `tests/storage/operation-store.test.ts`
- Create: `tests/production-dashboard.test.ts`
- Modify: `tests/integration/recovery.test.ts`
- Modify: `src/coordinator/tools.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `src/storage/operation-store.ts`
- Modify: `src/sessions/lifecycle.ts`
- Modify: `src/production-app.ts`

- [ ] **Step 1: Write failing tool schema/idempotency tests**

Add `update_session_notes` to `COORDINATOR_TOOL_SCHEMAS`:

```ts
{
  nickname: string,
  project_summary?: string | null,
  supervision_objective?: string | null,
  pending_follow_up?: string | null
}
```

Require at least one note field, strict keys, and bounded strings. Verify the tool is side-effecting, is present in `TOOL_NAMES`, returns complete notes, replays the same operation receipt, and rejects a changed retry. Do not rename or alias `get_session_status`.

- [ ] **Step 2: Write failing production integration tests for every action source**

Prove automatic projection after:

- create/register/adopt and attach/detach/archive receipts;
- rename, with stable facts and notes under the new key;
- successful start/steer sends, preserving exact text, attachment order, actual mode, turn ID, confirmation time, and monotonic operation order;
- proven-no-effect send failure, leaving `last_sent` unchanged;
- model/effort tools as pending, then a started turn as current with pending cleared;
- set/replace/pause/resume/cancel goal receipts, without any manager-complete operation;
- interrupt/lifecycle status changes;
- `update_session_notes`, including null clearing and restart persistence;
- `get_session_status`, which refreshes live thread/goal state and returns `{ nickname, identity, auto_session_info, manager_notes }` matching the materialized entry.

Token status tests must call it thread context usage and verify it never exposes account usage, billing, credits, or rate-limit fields.

- [ ] **Step 3: Write failing operation recovery tests**

Add exact crash-window cases:

- two sends created in the same millisecond with reverse-sorting random IDs still select the later monotonic operation sequence as `last_sent`;
- a dispatched start/steer whose client message is found in history records `last_sent` once using the operation's original monotonic sequence;
- a send proven absent does not record it;
- recovered settings/goals/lifecycle operations refresh the dashboard only after proof;
- a note mutation committed before operation success is recovered from `session_note_operations` by operation ID—even if the nickname has since changed—and succeeds with the stored result;
- a crash after an idempotent projection but before `operations.succeed` replays the projection harmlessly and then succeeds;
- a crash immediately after `operations.succeed` cannot leave the operation succeeded without its projection because projection was durably committed first;
- a recovered start compare-clears and promotes the exact pre-dispatch settings checkpoint, so already-applied settings are not left pending for another turn;
- a render failure after any confirmed operation leaves that operation succeeded and the dashboard dirty.

- [ ] **Step 4: Expose monotonic operation order and add the notes action**

Add an append-only migration that gives existing operations a unique monotonic `sequence` in actual insertion order (use existing SQLite row order for the one-time backfill), and allocates all new sequences transactionally. Extend operation records/recovery queries with `createdAt` and `sequence`, and pass `operationSequence` through `ToolActionContext`. Never use random operation IDs to break chronological ties. Use the sequence as the stable ordering source for send receipts so recovery of an older send cannot replace a newer one, even when timestamps tie. Add `update_session_notes` action resolving nickname through the current registry and passing `context.operationId` into `SessionDashboardStore.updateNotes`.

The action's SQLite mutation is idempotent. A validation/identity/database failure before commit is `OPERATION_CONFLICT` (proven no effect). A render failure after commit is swallowed by the safe render scheduler; return the durable complete note receipt.

Reconciliation checks `session_note_operations` by operation ID before resolving the original nickname, so a crash followed by rename cannot strand an already-committed note mutation.

For `send_to_session` start mode, checkpoint the exact pending `{model, effort}` snapshot before calling app-server and pass that same snapshot into `SessionService.send`. Combine it with any existing steer target-turn checkpoint rather than overwriting receipt fields. Normal success compare-clears and promotes those exact values. Recovery uses the checkpoint when client-message history proves the start, doing the same compare-clear/promotion before operation success. If no settings checkpoint exists, history cannot prove settings were dispatched and recovery must not consume arbitrary current pending values.

- [ ] **Step 5: Centralize safe projection/render scheduling in production**

Add helpers such as:

```ts
function observeConfirmed(effect: () => void): void { effect(); scheduleDashboardRender(); }
async function renderDashboardSafely(): Promise<void> { /* dirty retry + one warning/episode */ }
```

Call them only after a tool effect is proven. Do not scatter direct `await dashboard.render()` calls through external actions. For registry changes, render the current complete registry view. For endpoint unavailability/recovery and registry reload, update runtime first and then schedule rendering.

When a recovered operation is proven, feed the same idempotent receipt observer used by the normal action path **before** calling `operations.succeed`. Only after the projection transaction commits may the operation leave `listRecoverable`. A crash in between safely replays the projection; a crash after success finds the fact already durable. Avoid updating the dashboard in both branches with different shapes. Schedule filesystem rendering after operation success—the durable dirty bit already guarantees eventual materialization if the process stops first.

- [ ] **Step 6: Compose startup in the safe order**

After storage and registry are open, construct the store/dashboard in a dedicated phase before MCP/coordinator startup. Capture model/effort from the top-level `thread/start` and `thread/resume` responses exposed by `SessionLifecycle`; never read them from `Thread`. During reconciliation:

1. validate registry coordinator root, claim that root in SQLite, and only then migrate version 1;
2. reconcile lifecycle/runtime and resume managed sessions;
3. seed current model/effort from thread start/resume responses, while fresh thread reads seed lifecycle and turn order only;
4. drain the durable notification inbox, including token/settings/goal/status observations accepted before a crash;
5. reconcile terminal events and uncertain operations;
6. render the complete version-2 view successfully;
7. only then start/resume the coordinator so it cannot read stale version-1 content.

On endpoint resume, record fresh current settings/status before draining/rendering. On shutdown, stop notification acceptance, drain the notification tail, and then await the render tail before closing SQLite.

- [ ] **Step 7: Run focused tests, typecheck, and commit**

```bash
npm test -- tests/coordinator/tools.test.ts tests/storage/operation-store.test.ts tests/production-dashboard.test.ts tests/integration/recovery.test.ts tests/production-startup.test.ts
npm run typecheck
git add src/coordinator/tools.ts src/storage/migrations.ts src/storage/operation-store.ts src/sessions/lifecycle.ts src/production-app.ts tests
git commit -m "feat: connect manager tools to the session dashboard"
```

### Task 6: Replace the coordinator notebook instructions with a detailed tool-driven playbook

**Files:**
- Modify: `tests/coordinator/policy.test.ts`
- Modify: `assets/coordinator/AGENTS.md`
- Modify: `assets/coordinator/session-status.example.json`

- [ ] **Step 1: Expand policy tests before changing prose**

Require the managed policy to state:

- `session-status.json` and `data/sessions.json` are read-only to the coordinator and must never be edited, patched, replaced, deleted, or regenerated;
- facts are automatic and missing values must not be invented;
- manager judgment changes only through `update_session_notes`;
- worker finals are already delivered automatically, while metadata notifications only trigger decisions;
- no `watch_session` tool exists;
- status uses the exact `get_session_status` name and explains thread context usage versus account/billing usage;
- every manager tool name appears in the catalog.

Assert recognizable worked examples for create/name, discover/adopt, status, note update, exact `/pass`, and direct `/collect`. The `/pass` fixture must prove parser semantics:

```text
User: tell payments /pass  preserve this leading space
send_to_session content: " preserve this leading space"
```

- [ ] **Step 2: Run the policy test to confirm failure**

```bash
npm test -- tests/coordinator/policy.test.ts
```

- [ ] **Step 3: Rewrite the manager-memory section and add examples**

Call the file a backend-owned session dashboard, not a notebook. Explain `auto_session_info` versus `manager_notes`, stable nickname/thread behavior, compaction recovery, when to read a worker body, and how to clear a pending follow-up with `null`.

Examples must show exact tool arguments and the automatic outcome:

1. choose `payments`, create in `/projects/payments`, then start work;
2. discover an ordinary thread by cwd and adopt only when unambiguous;
3. call `get_session_status({"nickname":"payments"})` and interpret model/effort/token/goal/status;
4. call `update_session_notes` for an ongoing supervision objective;
5. preserve the second post-`/pass` space as the first payload character and preserve attachment IDs/order;
6. call `collect_messages({"nickname":"payments","count":3})` and do not repeat the directly delivered bodies.

- [ ] **Step 4: Update and validate the packaged example**

Make it exactly:

```json
{
  "version": 2,
  "sessions": {}
}
```

Parse it with `SessionDashboardDocumentSchema` in the policy/schema test.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- tests/coordinator/policy.test.ts tests/coordinator/dashboard-schema.test.ts
git add assets/coordinator tests/coordinator
git commit -m "docs: teach the coordinator automatic session management"
```

### Task 7: Document migration and exercise full restart/retry behavior

**Files:**
- Modify: `README.md`
- Modify: `.env.example` only if comments mention notebook ownership
- Modify: production/restart tests as required

- [ ] **Step 1: Update operator documentation**

Document:

- backend-owned mode-0400 `session-status.json` and authoritative SQLite state;
- one-time version-1 manager-field migration and invalid-input startup behavior;
- `manager_notes` updates through the coordinator tool, never manual JSON edits;
- `get_session_status` fields and thread-context token semantics;
- automatic facts and event sources;
- dirty-render retry/warning behavior and safe repair (fix filesystem permissions/path, then restart or wait for maintenance);
- `AGENTS.override.md` must preserve the same read-only/tool rules if a user replaces the managed prompt;
- `data/sessions.json` is backend registry state, not coordinator-editable memory.

- [ ] **Step 2: Add a restart integration scenario**

Start from a realistic version-1 file, run production startup through migration, mutate notes/facts, rename the session, close/reopen the database and registry, and verify the identical version-2 semantic snapshot returns under the new nickname. Include a simulated render failure followed by maintenance retry and prove no duplicate send/goal/lifecycle request occurred.

- [ ] **Step 3: Run the complete local verification suite**

```bash
npm run check
git diff --check
git status --short
```

Review test output for skipped dashboard/recovery tests; skips are not acceptable unless they are pre-existing platform-only cases unrelated to this feature.

- [ ] **Step 4: Commit documentation and integration coverage**

```bash
git add README.md .env.example tests
git commit -m "docs: explain the automatic session dashboard"
```

### Task 8: Review, fix, and live-upgrade verification

**Files:**
- Modify: any files identified by review

- [ ] **Step 1: Request two independent code reviews**

Ask one reviewer to focus on requirements/data ownership/migration and one on concurrency/idempotency/recovery/security. Require only Critical and Important findings, each with file/line evidence and a concrete failure scenario.

- [ ] **Step 2: Verify every finding before changing code**

Use `superpowers:receiving-code-review`. Reproduce or trace each finding, add a failing regression test for valid findings, implement the smallest correction, and explain rejected findings with evidence. Re-run each focused test immediately.

- [ ] **Step 3: Repeat review until both reviewers report no Critical or Important findings**

Do not stop at one clean review if the other still has unresolved findings. Commit fixes in coherent groups.

- [ ] **Step 4: Run final verification from a clean process**

Use `superpowers:verification-before-completion` and run:

```bash
npm run check
git diff --check
git status --short --branch
```

Then stop the old live bot process, start the built code against a backup of the real coordinator workdir/data, and verify:

- the real version-1 file migrates to version 2;
- its mode is `0400`;
- the coordinator starts only after the new dashboard exists;
- a Telegram status request returns model/effort/context/goal/lifecycle data;
- an exact `/pass` updates `last_sent` exactly once;
- a worker terminal updates `last_worker_event` without storing its body;
- a manager-note request survives restart;
- no secret/token appears in logs or test output.

If the live upgrade fails, restore the backup and old process before further diagnosis. Do not print or commit the Telegram token.

- [ ] **Step 5: Present the verified diff and integration choice**

Summarize behavior, migrations, tests, review rounds, live verification, and any remaining non-critical limitations. Do not merge or push until the user asks, unless their standing instruction for this development loop explicitly includes that action.
