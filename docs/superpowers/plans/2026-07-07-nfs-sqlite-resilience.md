# NFS SQLite Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for each behavior change and superpowers:verification-before-completion before every completion claim. Keep one persistent reviewer for the edit → review loop requested for this task.

**Goal:** Prevent QiYan database corruption from unsupported WAL-on-NFS use, reject existing corruption before external work starts, and recover the current production state without losing readable authoritative rows.

**Architecture:** File-backed SQLite uses verified DELETE/EXTRA rollback journaling behind the existing storage interface. Production holds a stable adjacent advisory lease for the full database lifetime, and existing state receives a full non-immutable read-only integrity check before mutation. A packaged, explicit command copies every readable authoritative row, rebuilds only the corrupt dashboard metadata table into a verified fresh-schema candidate, retains the complete old artifact set, and performs a verified multi-file swap with rollback.

**Tech Stack:** Strict TypeScript, Node.js 24 built-ins (`node:sqlite`, `node:fs`, `node:child_process`, `node:crypto`), Linux `flock`, Node test runner.

**Review and commit rule:** After each task: run the focused tests, ask the same persistent reviewer to inspect the uncommitted diff, address all valid Critical/Important findings, request re-review until approved, run `npm run check`, and only then commit. Do not include `task_plan.md`, `findings.md`, or `progress.md` in commits.

---

### Task 1: Safe SQLite configuration, full preflight, and hot-WAL conversion

**Files:**
- Modify: `tests/storage/database.test.ts`
- Modify: `src/storage/database.ts`

- [ ] **Step 1: Add a failing file-settings test**

Create a real file database and assert the actual pragma result shapes:

```typescript
assert.equal(db.prepare("PRAGMA journal_mode").get()!.journal_mode, "delete");
assert.equal(db.prepare("PRAGMA synchronous").get()!.synchronous, 3);
assert.equal(db.prepare("PRAGMA busy_timeout").get()!.timeout, 5_000);
assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
```

After close, assert that no candidate `-wal`, `-shm`, or `-journal` remains. Keep `:memory:` compatible instead of requiring DELETE there.

- [ ] **Step 2: Add a failing child-process hot-WAL test**

Create a valid QiYan database and a preserved test table. Spawn a Node child that opens it, selects WAL, checkpoints existing content, disables automatic checkpoints, commits a new preserved row, verifies that the main-file-only view does not contain that row, and exits with `process.exit(0)` without calling `close()`. In the parent require `-wal` to exist, prove a normal non-immutable read-only connection sees the committed row, call `openDatabase`, and require that both rows survive and journal mode becomes DELETE.

The test must fail if preflight uses `immutable=1` or if conversion discards the hot WAL.

- [ ] **Step 3: Add deterministic corruption and sanitized-close tests**

Create a healthy database, obtain a non-marker table root page and page size, close SQLite, and zero only that page. Capture the main file and any pre-existing artifact bytes and stats, then assert `openDatabase` throws exactly:

```typescript
new AppError(
  "CONFIGURATION_ERROR",
  "QiYan Bot state database failed integrity check; restore or recover it before starting",
)
```

Require the main file and every artifact that existed before inspection to remain byte-identical. Newly created read-only WAL/SHM coordination files are permitted and cleaned by the test. Add an injected inspector-close failure seam or equivalent focused unit test proving a raw close error cannot replace the static marker/integrity verdict.

- [ ] **Step 4: Run focused tests and verify RED**

Run: `npm test -- tests/storage/database.test.ts`

Expected: settings, hot-WAL conversion, and full corruption detection fail against the WAL-only implementation.

- [ ] **Step 5: Implement fail-closed open ordering**

Refactor the preflight to calculate a sanitized verdict first and close in a contained cleanup block. For nonempty existing files:

1. open non-immutable read-only;
2. set `busy_timeout=5000`;
3. validate marker/version;
4. require exactly one `integrity_check` row equal to `ok`;
5. close without allowing close exceptions to expose or replace the selected static error.

For the writable connection, set `busy_timeout=5000` before journal conversion, select and verify DELETE for file databases, set and verify `synchronous=EXTRA`, enable and verify foreign keys, and only then migrate. Close the writable handle on any configuration/migration failure. Do not pass SQLite error text to `AppError`.

- [ ] **Step 6: Verify, review, and commit**

Run focused tests, complete persistent review to approval, run `npm run check`, then commit only Task 1 files:

```bash
git commit -m "fix: make sqlite startup fail safe"
```

### Task 2: Reusable advisory lock and lifetime database lease

**Files:**
- Create: `src/core/advisory-lock.ts`
- Create: `src/storage/database-lease.ts`
- Create: `tests/storage/database-lease.test.ts`
- Modify: `src/weixin/credential-store.ts`

- [ ] **Step 1: Add failing lease tests**

Cover stable mode-0600 lock creation, contention, idempotent release, reacquisition, symlink/type/link rejection, wrong owner through injected `expectedUid`, and a default UID resolved from `process.geteuid?.() ?? process.getuid?.()`.

Add a race seam that replaces the path after `flock` succeeds. Require the held handle's device/inode/type/owner/link/mode to match a fresh `lstat`; mismatch returns a static error and closes the still-locked descriptor. Assert the stable path is never unlinked during ordinary release.

- [ ] **Step 2: Run lease tests and verify RED**

Run: `npm test -- tests/storage/database-lease.test.ts`

Expected: the module import fails because the lease does not exist.

- [ ] **Step 3: Extract the inherited-fd flock helper**

Move the existing `/usr/bin/flock` then `/bin/flock` logic from `src/weixin/credential-store.ts` to `src/core/advisory-lock.ts`:

```typescript
export async function tryAcquireAdvisoryLock(fd: number): Promise<boolean>;
```

Return `false` only for lock contention status 1. Keep `env: {}` and ignored output. Update the credential store to preserve its existing static error boundary.

- [ ] **Step 4: Implement the stable database lease**

Open `<dirname(databasePath)>/.<basename(databasePath)>.lock` with `O_RDWR | O_CREAT | O_NOFOLLOW`. Validate the held handle, repair mode only after safe owner/type/link validation, acquire `flock`, then compare held `fstat` with post-lock path `lstat`. Retain the `FileHandle` until idempotent release and never unlink the stable path.

- [ ] **Step 5: Verify, review, and commit**

Run:

```bash
npm test -- tests/storage/database-lease.test.ts tests/weixin/credential-store.test.ts
npm run check
```

Complete persistent review before the full gate and commit:

```bash
git commit -m "feat: serialize database ownership"
```

### Task 3: Own the lease safely in production storage startup

**Files:**
- Modify: `src/production-app.ts`
- Modify: `tests/production-startup.test.ts`

- [ ] **Step 1: Add failing storage-contention and retry tests**

Hold the database lease before `app.start()`. Assert startup fails in storage before adapter initialization. Release the held lease and call `app.start()` again on the same app; it must progress to the existing deliberate later failure, proving no stale outer database or lease was closed/reused by the failed attempt.

- [ ] **Step 2: Add failing in-phase and later-phase cleanup tests**

Force an actual storage failure after SQLite opens, such as an unsafe endpoint catalog entry. Require subsequent lease acquisition to succeed. Separately use the existing missing-Codex production path so storage starts successfully and a later phase fails; require lease reacquisition afterward.

Use narrow injected wrappers or event hooks to record `database-close` and `lease-release`, then require that exact order. Also test that a simulated close failure does not release the lease and that cleanup failures do not replace the original startup error.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `npm test -- tests/production-startup.test.ts`

- [ ] **Step 4: Implement attempt-local ownership**

Acquire a local lease before cutover preflight. Keep the opened DB, stores, and endpoint catalog in locals. Publish them and the lease to outer phase state only after routing backfill succeeds. On failure, close only the local DB once; release the local lease only after successful close; contain cleanup errors and rethrow the original startup error.

On stop, close the published DB first. Release and clear the published lease only after close succeeds. Do not let an old outer `db` from a prior attempt participate in cleanup.

- [ ] **Step 5: Verify, review, and commit**

Run focused storage/production tests, complete persistent review, run `npm run check`, and commit:

```bash
git commit -m "fix: hold database lease for runtime"
```

### Task 4: Tested dashboard-metadata recovery core

**Files:**
- Create: `src/storage/dashboard-metadata-recovery.ts`
- Create: `src/storage/recovery-schema.ts`
- Create: `tests/storage/dashboard-metadata-recovery.test.ts`
- Modify: `src/storage/conversation-cutover.ts`

- [ ] **Step 1: Add recovery fixture helpers and failing exact-copy test**

Create a current state-version-3 source with completed cutover, populated private test values, and rows in both migration-seeded and ordinary tables. Corrupt only the closed `session_dashboard_meta` root page. The recovery build API must:

- create a separate candidate from current migrations;
- leave the canonical main and every pre-existing sidecar byte-identical;
- copy every allowlisted table except metadata exactly;
- rebuild one metadata row with safe defaults;
- return only aggregate metadata, never a row or raw error payload.

Compare test data internally, while asserting public result/error/output strings do not contain seeded private values.

- [ ] **Step 2: Add failing schema and source-safety tests**

Require static rejection and candidate cleanup for an added/removed table, changed/extra column or exposed constraint such as NOT NULL/foreign key, unexpected index/trigger or changed index column, unreadable rows in a copied table, write attempts through the attached source, or source-artifact change before install. Assert the attached database URI uses `mode=ro`, and demonstrate that a hot-WAL working copy is read without immutable mode. Also prove harmless formatting differences in stored CREATE SQL neither bypass nor falsely fail validation.

The static recovery schema defines every expected application table using ordered `table_xinfo` fields (name, type, nullability, default, primary-key position, hidden flag), `foreign_key_list`, index name/uniqueness/partial flags with ordered `index_xinfo`, and exact allowed trigger names. Do not compare raw `sqlite_schema.sql` text or claim to inspect CHECK expressions, expression-index expressions, or partial-index predicates that these PRAGMAs do not expose. Current candidate schema is authoritative; exact copy and candidate constraints/integrity/FK checks validate the output. The two known routing guard triggers are installed from exported product code rather than damaged schema SQL. Schema checks may return only booleans and static metadata.

- [ ] **Step 3: Add failing seed-clearing and watermark tests**

Prove migration-seeded singleton/sequence rows do not conflict. For each of the five watermark sources in a subtest, make it uniquely highest and assert `next_observation_sequence` is exactly one greater. Add negative, non-integer, and `Number.MAX_SAFE_INTEGER` cases that fail statically before candidate installation.

Watermarks are queried individually with `COALESCE(MAX(column), 0)` and validated as nonnegative safe integers before addition; do not use multi-argument SQL `MAX` across separate aggregate expressions.

- [ ] **Step 4: Run recovery tests and verify RED**

Run: `npm test -- tests/storage/dashboard-metadata-recovery.test.ts`

- [ ] **Step 5: Implement the schema-gated copy**

Require a normalized absolute database path and a canonical (`realpath(parent) === parent`), owner-controlled, non-group/world-writable parent. Require main plus existing `-wal`, `-shm`, and `-journal` to be owner regular files with one link; open them with `O_NOFOLLOW`, capture device/inode/size/mode/link/hash, and copy from the handles. Create a private same-filesystem quarantine and fsynced backup. Re-enumerate and reopen the live set with `O_NOFOLLOW`, require every captured identity/hash to match, and verify every backup-copy hash before writing/fsyncing the non-sensitive `backup_complete` manifest or reporting its path. Build and read a separate working copy so SQLite coordination cannot mutate originals. Initialize a DELETE/EXTRA candidate, then attach the working database with a bound `file:` URI using `mode=ro`.

With foreign keys disabled outside the transaction, clear all allowlisted candidate tables, copy every non-metadata table using explicit quoted column lists, insert the rebuilt metadata row, commit, restore and verify foreign keys, and install known routing guards. Verify copied counts and bidirectional `EXISTS(SELECT ... EXCEPT SELECT ...)` booleans without returning private values to JavaScript. Require exact marker/migrations, DELETE/EXTRA on the recovery connection, `integrity_check=ok`, and empty `foreign_key_check`; fixed QiYan verifies connection-scoped EXTRA again when it opens the installed file.

Close and fsync the candidate. On every failure, detach/close best-effort, delete candidate main and candidate sidecars, retain every complete manifest-backed quarantine, delete only incomplete pre-boundary scratch directories, and throw a constant `AppError`.

- [ ] **Step 6: Verify, review, and commit**

Run focused recovery/storage tests, complete persistent review, run `npm run check`, and commit:

```bash
git commit -m "feat: rebuild corrupt dashboard metadata"
```

### Task 5: Sidecar-safe installation and packaged recovery command

**Files:**
- Modify: `src/storage/dashboard-metadata-recovery.ts`
- Modify: `src/cli.ts`
- Modify: `src/main.ts`
- Modify: `tests/storage/dashboard-metadata-recovery.test.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/main.test.ts`

- [ ] **Step 1: Add failing artifact-swap tests**

Add unsafe-input tests for group/world-writable or replaced parent directories; main/sidecar FIFO, symlink, hard link, wrong owner, or multiple links; and replacement with same bytes after initial validation. Require static failure. Inject mutation, addition, and removal of a sidecar during sequential backup copying; require no `backup_complete` manifest/path report and allow deletion of the incomplete scratch directory. Add a stable-copy control that does publish `backup_complete`. Seed distinct safe main, WAL, SHM, and journal artifacts and require a second pre-displacement path revalidation against captured device/inode/size/type/owner/link/hash.

Require the installer to fsync candidate/backup/directories, write a non-sensitive manifest containing recovery ID, canonical basename, artifact names/hashes, and `backup_complete`, and report the quarantine path immediately after that boundary. Require transition to `installing`, move the complete old set into quarantine, rename only the verified candidate main to canonical, fsync, transition to `installed`, and leave no old-generation sidecar beside it. Assert the manifest contains no absolute paths, rows, configuration, or credentials.

Inject a failure at every move/rename/sync/manifest boundary. Require restoration of the complete original set, candidate cleanup, and durable `rolled_back` state. If injected rollback also fails, require a distinct static manual-restore error and retention of the fsynced quarantine copies. Simulate interruption after `backup_complete` and `installing` and prove the manifest plus backup hashes identify the complete set for manual restore. Do not claim the multi-file swap is crash-atomic.

- [ ] **Step 2: Add failing CLI and output-privacy tests**

Parse only:

```text
qiyan-bot recover-dashboard-metadata --database <absolute-path>
qiyan-bot recover-dashboard-metadata --help
```

Reject missing, relative, non-normalized, repeated, and unknown arguments without echoing them. Require command output to be constant phase/success phrases plus the quarantine path and prove seeded rows and injected raw errors are absent from stdout/stderr formatting.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
npm test -- tests/storage/dashboard-metadata-recovery.test.ts tests/cli.test.ts tests/main.test.ts
```

- [ ] **Step 4: Implement replacement and command dispatch**

The command acquires the database lease, validates and pins all filesystem inputs, builds/verifies the candidate, revalidates each live artifact path identity, performs manifest-backed complete-set displacement and candidate rename, fsyncs the data directory, and releases after all database handles are closed. Ordinary installation failure rolls the complete set back. Print the quarantine path as soon as `backup_complete` is durable, then only constant phase/success text.

- [ ] **Step 5: Verify, review, and commit**

Run focused tests, complete persistent review, run `npm run check`, build the bundle, inspect its help, and commit:

```bash
git commit -m "feat: add offline sqlite recovery command"
```

### Task 6: Operator documentation

**Files:**
- Modify: `README.md`
- Modify: `tests/docs.test.ts`

- [ ] **Step 1: Add failing documentation assertions**

Require documentation of rollback journaling, one process per data directory, full startup integrity validation, stopped consistent backups, the narrow recovery command, retained manifest-backed quarantine, interrupted-run manual restore, and NFS's remaining lock/sync dependency without claiming NFS is fully safe.

- [ ] **Step 2: Run docs test and verify RED**

Run: `npm test -- tests/docs.test.ts`

- [ ] **Step 3: Document operation and recovery boundaries**

Explain that backups must stop QiYan and preserve main plus any `-wal`, `-shm`, and `-journal` together, or use SQLite's online backup API. State that recovery exactly preserves all readable authoritative rows, rebuilds dashboard metadata and derived database structure, is never automatic, and must not be used when authoritative rows are unreadable. For `backup_complete` or `installing` after interruption: keep the service stopped, verify manifest hashes, restore the complete set, fsync, then retry.

- [ ] **Step 4: Verify, review, and commit**

Run docs/CLI tests, complete persistent review, run `npm run check`, and commit:

```bash
git commit -m "docs: explain sqlite recovery boundary"
```

### Task 7: Final review, exact package installation, and production recovery

**Files:**
- Review all files changed from `origin/main`
- Operationally replace `/home/mxin/.qiyan-bot/data/bot.sqlite3`; never commit private state

- [ ] **Step 1: Obtain final persistent review approval**

Give the same persistent reviewer the design, plan, base SHA, head SHA, and complete diff. Ask separately for spec compliance and code quality, including lock lifetime, all cleanup paths, hot-WAL visibility, structural schema validation, filesystem identity pinning, source immutability, manifest-backed whole-artifact rollback, privacy, and test strength. Resolve every valid Critical/Important item and repeat until approved.

- [ ] **Step 2: Run fresh final verification**

Run:

```bash
npm run check
npm run build
npm pack --dry-run
git diff --check origin/main...HEAD
git status --short
```

Inspect the package allowlist and ensure only intended source/docs/tests are committed.

- [ ] **Step 3: Stop and snapshot production safely**

Stop `qiyan-bot.service`, require inactive state, enumerate the production main and all existing sidecars without opening SQLite, and hash them. Do not print database contents. Keep the old service stopped for the remainder of recovery.

- [ ] **Step 4: Pack and install the exact reviewed branch**

Create a tarball from the verified HEAD, inspect its contents, install that exact tarball into the existing user prefix, verify `qiyan-bot --version`/help, and confirm the managed unit still points to the expected executable without printing environment secrets.

- [ ] **Step 5: Run the packaged offline recovery**

Run the exact installed `recover-dashboard-metadata` command against `/home/mxin/.qiyan-bot/data/bot.sqlite3`. Record the reported manifest-backed quarantine as soon as backup completion is durable. Require unchanged backup hashes for the complete original artifact set, one rebuilt metadata row with the computed watermark, and a canonical candidate with persistent DELETE mode, connection-verified EXTRA, `integrity_check=ok`, zero foreign-key failures, exact structural schema/migrations, and no stale WAL/SHM/journal.

- [ ] **Step 6: Restart and verify production**

Restart the managed service. Verify active status, lease ownership, no integrity/startup failure, and no repeated `background_task_failed component=maintenance` with metadata-only journal filters. Never display chat bodies, attachment contents, bot tokens, or Codex credentials.

- [ ] **Step 7: Preserve handoff state**

Remove uncommitted planning working files, leave the approved branch/worktree intact, report the branch, commits, test evidence, quarantine path, service health, and any remaining NFS caveat. Do not merge unless asked.
