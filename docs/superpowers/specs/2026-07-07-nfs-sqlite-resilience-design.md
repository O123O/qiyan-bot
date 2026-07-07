# NFS SQLite Resilience and Recovery Design

## Context

QiYan stores authoritative ingress, delivery, operation, attachment, runtime, and reconciliation state in `<DATA_DIR>/bot.sqlite3`. The current implementation unconditionally enables SQLite WAL mode. The production data directory is on NFSv4.2, and SQLite documents that WAL shared-memory coordination does not work over network filesystems. The production database is now corrupt: full and quick integrity checks fail, while table-by-table inspection localizes the immediately unreadable b-tree to `session_dashboard_meta`.

QiYan cannot copy Codex CLI's behavior of treating SQLite as an optional index. Losing or ignoring QiYan rows could repeat an external delivery or tool effect. The authoritative store must remain fail-closed.

## Chosen approach

Keep one authoritative SQLite database and remove its dependency on WAL:

- File-backed databases use `journal_mode=DELETE`, `synchronous=EXTRA`, `foreign_keys=ON`, and a 5-second busy timeout. QiYan verifies the actual pragma values it relies on.
- Existing nonempty databases receive a full `PRAGMA integrity_check` on a byte-stable disposable copy before canonical journal conversion, migrations, or any application mutation.
- The inspector copy is non-immutable and writable so it sees committed frames from a legacy hot WAL and can recover a legitimate hot rollback journal. Canonical main/WAL/SHM/journal artifacts remain byte-identical through inspection; SQLite coordination and recovery writes occur only inside a private mode-0700 disposable directory.
- A static `CONFIGURATION_ERROR` distinguishes a valid QiYan marker with corrupt contents from a foreign or unsupported database. Raw SQLite diagnostics, database contents, and private paths are never included.
- Production acquires a lifetime advisory lease beside `bot.sqlite3` before cutover preflight or any SQLite open. The stable owner-only lock file is never unlinked. The database closes successfully before the lease is released.
- Automatic repair is forbidden. The one supported repair for this incident is an explicit, packaged, offline `recover-dashboard-metadata` command with a retained byte backup.

This is safer and smaller than filesystem detection: QiYan uses one synchronous connection and does not benefit materially from WAL reader/writer concurrency. Applying rollback mode to every file-backed database avoids platform-specific mount detection and converts healthy legacy WAL databases on first safe open.

## Database open and integrity behavior

For an existing nonempty database:

1. Copy the stable canonical main and existing WAL/SHM/journal set through no-follow handles into a private disposable directory, then open that copy non-immutably and writable so SQLite may recover a hot rollback journal.
2. Validate `qiyan_state(product='qiyan-bot')` and supported state version 2 or 3.
3. Run full `PRAGMA integrity_check` and require exactly one row whose result is `ok`.
4. Close the inspector while containing close failures so they cannot replace the selected sanitized verdict.
5. Open writable state, set the busy timeout first, select and verify DELETE journal mode, select and verify EXTRA synchronization, enable and verify foreign keys, and only then run migrations.

Fresh and empty databases have no prior contents to validate and are initialized normally. In-memory test databases retain a supported in-memory journal mode but still enable foreign keys and the busy timeout.

A foreign or unsupported database retains `not a QiYan Bot state database`. A valid marker whose inspection throws, returns a non-`ok` row, or cannot be closed cleanly returns `QiYan Bot state database failed integrity check; restore or recover it before starting`. The implementation records only the verdict and never forwards SQLite text.

A legacy WAL conversion test uses a child process that creates and checkpoints a valid database, disables automatic checkpointing, commits an additional row to WAL, and exits without closing SQLite. The parent proves the preflight can see the WAL-only row and that DELETE conversion preserves it. A closed-WAL header-only test is insufficient.

## Lifetime process lease

The lease extracts and reuses the repository's Linux `flock` pattern: open an adjacent regular file with `O_NOFOLLOW`, validate ownership, link count, and mode, then pass that descriptor to `/usr/bin/flock` or `/bin/flock` as inherited fd 3. The helper exits after taking the lock; the parent retains the shared open file description for the application lifetime.

The lock file is `<DATA_DIR>/.bot.sqlite3.lock`, mode `0600`. It is not deleted on release because unlinking a live lock allows a second inode to be created and defeats mutual exclusion. The expected owner defaults to `process.geteuid?.() ?? process.getuid?.()` in production. After `flock` succeeds, the helper compares the held descriptor's device, inode, link count, type, owner, and mode with a new `lstat` of the path; path replacement causes a static configuration failure while the held descriptor remains locked until cleanup. Contention, unavailable locking, and unsafe lock state use constant messages.

The storage phase owns the lease. A start attempt keeps all newly opened resources in locals until the phase is fully initialized. On failure it closes only that attempt's database once and then releases only that attempt's lease; cleanup failures never replace the original startup error. The successful values are published to outer state only at the end. Stop closes SQLite before releasing the lease, and retains the lease if close does not succeed. This permits a failed start to be retried without closing a stale handle from an earlier attempt.

Storage remains earlier than registry, dashboard, attachments, chat adapters, endpoints, reconciliation, delivery, and ingress. Tests cover both failure inside storage and a real later missing-Codex failure, then prove the lease can be reacquired and that database close occurred before release.

## Offline recovery command

`qiyan-bot recover-dashboard-metadata --database <absolute-path>` is intentionally narrow. It requires the current expected schema, copies every readable authoritative row exactly, rebuilds only `session_dashboard_meta`, and recreates derived indexes/triggers/freelist structure through current product schema. It does not prove that the damaged file had no unrelated derived-structure damage; unreadable rows in any copied table make recovery fail. It acquires the lifetime lease and emits only constant phase text plus the operator-owned quarantine path. It never emits rows or raw caught errors.

The service must already be stopped. The lease excludes fixed QiYan versions and concurrent recovery commands; it cannot coordinate with an older running QiYan version that does not yet take this lease.

### Stable source and schema gate

Before opening an artifact, recovery requires a normalized absolute database path whose parent is already canonical (`realpath(parent) === parent`), owner-controlled, and neither group- nor world-writable. The canonical main file and each existing `-wal`, `-shm`, and `-journal` must be owner-owned regular files with one link. Recovery opens them through `O_NOFOLLOW` handles, captures device, inode, size, mode, link count, and hash, and copies from those handles. Unsafe sidecar types, symlinks, hard links, ownership, or path replacement fail statically.

Recovery treats the validated files as one artifact set. It creates a mode-0700, same-filesystem quarantine directory and makes fsynced byte copies of that entire set. Before declaring the backup complete, it re-enumerates the canonical artifact names, reopens each with `O_NOFOLLOW`, requires every captured identity field and hash to remain unchanged, and verifies every backup-copy hash against the initial captured hash. A mutation, addition, removal, or replacement during the sequential copy leaves no `backup_complete` manifest and no reported backup. A second working copy is used for all SQLite reads. The canonical source and its pre-existing sidecars therefore remain unchanged during candidate construction even if a read-only SQLite open creates or updates working-copy coordination files.

The candidate is initialized through current migrations with DELETE/EXTRA settings. Recovery then attaches the working main file using a bound `file:` URI with `mode=ro`; immutable mode is forbidden because it can ignore a hot WAL. Before copying, it rejects mismatches against explicit product-owned structural signatures: ordered `table_xinfo` fields (name, type, nullability, default, primary-key position, hidden flag), `foreign_key_list`, index names/uniqueness/partial flags and ordered `index_xinfo`, plus an exact trigger-name allowlist. Stored `sqlite_schema.sql` text is never compared because harmless formatting may differ between SQLite versions. These PRAGMAs do not expose every CHECK expression, expression-index expression, or partial-index predicate, so the design does not claim to compare those source expressions; current candidate schema is authoritative, and exact copy plus candidate constraint, integrity, and foreign-key validation proves the recovered output. The supported source is current state version 3 with completed conversation cutover. Known routing guard triggers are created from product-owned definitions rather than copied SQL from the damaged database. Checks return only booleans and static schema metadata, never stored rows.

### Exact copy and metadata rebuild

Migration-created singleton/sequence rows mean blind inserts are unsafe. Recovery applies this exact algorithm:

1. Set candidate foreign keys off outside a transaction.
2. Begin an immediate candidate transaction.
3. Delete every row from every allowlisted candidate table, including migration seeds, with the corrupt metadata table handled separately.
4. For each table except `session_dashboard_meta`, execute one `INSERT INTO main.<table> (<explicit quoted columns>) SELECT <same columns> FROM damaged.<table>` statement.
5. Query each watermark independently with bounded aggregate-only SQL. Accept only nonnegative safe integers, require that adding one remains safe, and take the maximum of:
   - `session_dashboard_notifications.sequence`
   - `session_dashboard_facts.current_settings_observation_sequence`
   - `session_dashboard_facts.token_observation_sequence`
   - `session_dashboard_facts.goal_observation_sequence`
   - `session_runtime.native_observation_sequence`
6. Insert exactly one metadata row with `singleton=1`, `assistant_root=NULL`, `dirty=1`, `revision=0`, `last_render_error=NULL`, `render_failure_generation=0`, and `next_observation_sequence=max+1`.
7. Commit, restore and verify foreign keys outside the transaction, and install the known current routing guards.

Identifier quoting is centralized and every identifier originates from the static allowlist. For each copied table, verification compares counts and runs `EXISTS` around `EXCEPT` in both directions; only counts and booleans enter JavaScript. No private row is formatted or logged. Recovery then verifies `foreign_keys=ON`, the expected marker and exact migration set, `integrity_check=ok`, zero `foreign_key_check` rows, and DELETE/EXTRA on the recovery connection. DELETE persists in the file; EXTRA is connection-scoped and is verified again when fixed QiYan opens the installed database. No candidate WAL/SHM/journal may remain after close. Any source row read, structural-schema, value-bound, copy, or verification failure deletes the candidate and returns a static failure.

### Replacement and rollback

Only after the post-copy live-set identity/hash revalidation and backup-copy hash verification succeed does recovery write and fsync a small non-sensitive manifest containing a random recovery ID, canonical basename, artifact names/hashes, and `state="backup_complete"`, then fsync the quarantine and parent directories. Only this manifest-backed directory is a valid backup. The command reports its path immediately after this durable boundary so an operator can find it even if a later step is interrupted. Incomplete pre-boundary scratch directories may be deleted; every complete manifest-backed quarantine is retained on success and on later source/candidate validation failure.

Before replacement, recovery fsyncs the candidate and data directory, then reopens every canonical artifact with `O_NOFOLLOW` and revalidates its path against the captured device, inode, size, type, owner, link count, and hash. A missing, added, replaced, or changed artifact aborts installation.

The command atomically rewrites and fsyncs the manifest to `state="installing"`, then moves the old main file and every old `-wal`, `-shm`, and `-journal` together into a `displaced` directory inside quarantine before renaming the candidate to the canonical main path. It fsyncs the data directory and atomically advances the manifest to `state="installed"`. If any ordinary move, rename, or sync operation fails, it removes or moves aside the candidate generation, restores the complete displaced artifact set, fsyncs it, and records `state="rolled_back"` before returning a static failure. Rollback failure returns a distinct static message directing the operator to the retained quarantine.

SQLite provides no single filesystem rename for a main file and all sidecars. The fsynced manifest-backed quarantine is therefore the crash-recovery boundary; the stopped-service requirement prevents a process from observing the deliberate swap window. After an interrupted run, the operator keeps the service stopped, finds a `backup_complete` or `installing` manifest, verifies the backup hashes, restores the complete artifact set, and fsyncs the data directory before retrying. `-wal` and `-journal` may contain durable transaction data. `-shm` is coordination state, not a durable database payload, but it is still quarantined to prevent stale generation pairing and diagnostic confusion. The manifest contains no rows, configuration values, credentials, or absolute paths.

## Error handling and privacy

- Startup and recovery errors are constant, actionable, and contain no SQLite text or persisted values.
- Recovery returns aggregate counts/booleans internally and prints only static phase/success lines and the quarantine path after the backup becomes durable.
- A corrupt authoritative database is never ignored, retried indefinitely, or partially opened for chat ingress.
- The existing maintenance warning behavior is not changed; after recovery and the root-cause fix, the repeated corruption-triggered warning path is no longer reached.

## Testing

Automated tests cover:

- real file pragma values and absence of persistent WAL/SHM files after a normal close;
- a child-process hot-WAL crash fixture whose WAL-only committed row survives preflight and DELETE conversion;
- deterministic corruption of a non-marker page, sanitized rejection before canonical writable mutation, byte identity of the complete canonical artifact set, and a crash-generated hot rollback journal recovered only on the disposable inspection copy;
- unchanged foreign/unsupported database behavior and close-error containment;
- lease contention, idempotent release, UID/type/link/mode checks, post-lock inode replacement detection, and reacquisition;
- failed storage start, retry after failed start, and cleanup after a real later startup failure, including close-before-release ordering;
- recovery with populated and migration-seeded tables, metadata omission, exact copied-table equivalence, each possible highest watermark, source artifact immutability, and candidate cleanup on failure;
- recovery rejection for unexpected structural table/foreign-key/index/trigger signatures, unreadable rows outside metadata, unsafe integer watermarks, and changed artifact identities;
- harmless stored-SQL formatting variance, while changed constraints or index columns fail structural validation;
- unsafe parent permissions, artifact ownership/type/link state, sidecar symlinks/hard links, and path-replacement races;
- mutation, addition, and removal during sequential backup copy, proving no quarantine is published until live-set and copy hashes are revalidated;
- complete artifact replacement, durable manifest transitions, injected install rollback, retained backup equivalence, interrupted-run identification, and static output that contains no seeded private values or raw injected errors;
- the full repository gate via `npm run check`.

Production recovery additionally verifies the retained artifact hashes, physical integrity, foreign keys, table equivalence, observation watermark, journal settings, service state, and metadata-only logs.

## Rejected alternatives

- **Ignore corruption like Codex:** unsafe because QiYan's DB is authoritative rather than a rebuildable index.
- **Keep WAL and rely on one host:** contradicted by SQLite's network-filesystem requirements and the observed corruption.
- **Use immutable read-only inspection:** it can ignore committed hot-WAL frames and produce an incomplete candidate.
- **Split dashboard state now:** broader migration and cross-database consistency risk without fixing authoritative-store journaling.
- **Automatically choose by filesystem type:** mount detection is platform-specific and still cannot prove NFS lock/sync correctness.
- **Automatically repair during startup:** risks silent data loss and duplicated effects; the repair is an explicit stopped-service operation.
