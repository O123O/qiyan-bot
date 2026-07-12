# Claude manager/worker tool parity — plan

Goal: every manager + worker tool that "returns success" on a Claude session must do the right
thing, at parity with Codex, OR be honestly reported as having no Claude equivalent. Driven by an
adversarial per-tool audit (all findings code-evidenced). Principle: simple, robust, modular —
mirror the existing `ClaudeGoalStore` emulation pattern; do not over-build.

## Audit outcome (evidence)

WORKS today (keep; add real behavioral tests): list_managed_sessions, create_session, adopt_session,
rename_session (registry-only), unadopt_session, interrupt_session (SIGKILLs the child), disconnect/
restart (daemonless), get_goal/set_goal/pause/resume/cancel_goal (QiYan-driven), read_worker_message,
collect_messages, chat/slack tools; worker schedule_wakeup/schedule_cron/monitor(local-gated)/
list_schedules/cancel_schedule/set_goal_status.

GAPS to FIX:
1. **`list_models` — shape bug (root cause).** Claude `model/list` returns `{models:[{id}]}`, but the
   consumer reads `{data, nextCursor}` (`service.ts:338-347`) → always empty. This breaks model/effort
   validation downstream.
2. **`set_session_model` — throws / no-op.** Empty list ⇒ every model fails `unknown model`
   (`service.ts:187-191`); even if it passed, `turnStart` ignores per-turn model (uses endpoint-wide
   `launchFlags.model`).
3. **`set_reasoning_effort` — silent no-op.** No `effort` in `ClaudeLaunchFlags`, no `--effort` arg,
   `turnStart` ignores it, and validation is bypassed (accepts garbage). Claude DOES support
   `--effort {low,medium,high,xhigh,max}` (verified via `claude --help`; transcript shows `thinking`).
4. **`discover_sessions` — throws UNSUPPORTED.** `thread/list` isn't implemented (`claude-runtime.ts:115`).
5. **`archive_session` — weaker (≈ unadopt).** `thread/archive` only kills the turn + drops the in-memory
   map; the transcript survives and is re-discoverable. Claude has no native archive.
6. **`get_session_status` nativeStatus — weaker.** Derived from `thread/read` reconstruction, which
   ignores the in-memory `state.running`; can report `idle` while the child runs.

REPORT (no easy Claude equivalent — do NOT fake):
- **`send_to_session` mode=steer.** `claude -p` is one-shot; there is no mid-turn injection API. We
  already emulate it as a durable next-turn enqueue (user-confirmed acceptable). Keep, and make sure the
  tool result does not imply mid-turn correction.

## Design (modular)

New module `src/endpoints/claude-models.ts` — a single source of the curated Claude model catalog
(aliases `opus`/`sonnet`/`fable`/`haiku` + their full ids) each with
`supportedReasoningEfforts: ["low","medium","high","xhigh","max"]` and one `isDefault`. Small, static,
documented as non-dynamic (Claude has no list API). Used by `model/list`.

New store `src/sessions/claude-archives.ts` — `ClaudeArchiveStore` mirroring `ClaudeGoalStore`
(table `claude_archived_threads(endpoint_id, thread_id, archived_at)`; `add`/`has`/`remove`/`list`).
Always constructed (like the goal store).

Runner (`ClaudeCommandRunner` interface + local + ssh): add `listThreads(cwd): Promise<ThreadMeta[]>`
where `ThreadMeta = {id, cwd, updatedAt, preview}`. Local = readdir `<home>/.claude/projects/<cwd-hash>/`,
read the head/tail of each `<id>.jsonl` for `updatedAt`+`preview`. Remote = a new ssh helper op
`claude-list-threads` (parallels `claude-rollout-scan`), returning the same shape. No message bodies
leave the host beyond a short preview (match Codex discovery's preview semantics).

### Per-gap changes
- **list_models (1):** `ClaudeCodeRuntime.request("model/list")` → `{ data: CLAUDE_MODELS, nextCursor: null }`.
  `CLAUDE_MODELS` from the new module; the endpoint's configured `launchFlags.model` (if any) is marked
  `isDefault`, else the module's default alias.
- **model + effort (2,3):**
  - `ClaudeLaunchFlags`: add `effort?: string`; `buildClaudeArgs`: emit `--effort <effort>`.
  - `ClaudeCodeRuntime.turnStart`: prefer `params.model`/`params.effort` over `launchFlags.*` when present
    (they are already spread into `turn/start` by `service.send`).
  - Persistence: Claude has no server to hold the setting, so it must stay sticky. Inject a predicate
    `settingsPersistNatively(endpointId): boolean` into `SessionService` (default `true` ⇒ current Codex
    behavior). `send()` calls `consumeSettings` only when true. production-app passes
    `id => sessionProvider(id) !== "claude"`. Result: `set_session_model`/`set_reasoning_effort` write the
    sticky value, every subsequent Claude turn re-applies it, and `get_session_status` shows it.
- **discover_sessions (4):** `ClaudeCodeRuntime.request("thread/list", {archived, cwd, ...})` →
  `runner.listThreads(cwd)`, filter by the archive store to honor `archived`, page it into
  `{data, nextCursor}`. (Cursor can be a simple offset; Codex-style.)
- **archive_session (5):** `thread/archive` also `archiveStore.add(id)`; `thread/list` excludes/includes by
  it; adopting an archived thread (or a fresh turn) clears it (`archiveStore.remove`). So archive → the
  thread stops appearing in default discovery and is tombstoned, matching Codex.
- **get_session_status (6):** `ClaudeCodeRuntime` thread reconstruction overlays `state.running`: when a
  turn is in flight, report the thread `status:"active"` with the running turn id as an open in-progress
  turn, regardless of what the transcript has flushed.

## Tests (assert ACTUAL behavior, local + remote)

Extend the gated acceptance harness (`mcp-production-actions.test.ts`) Claude block, for BOTH
`claude-local` and `dfw-claude`:
- `list_models` returns a non-empty catalog incl. `supportedReasoningEfforts`.
- `set_session_model <alias>` then a turn → the delivered turn's transcript records the matching model id
  (assert via the DB/transcript, not `appliedSettings`).
- `set_reasoning_effort high` then a turn → the turn runs (and, where observable, the transcript shows
  thinking); an INVALID effort is rejected.
- `discover_sessions` lists the live session; after `archive_session` it no longer appears (or appears
  `archived:true`) and is absent from the default (non-archived) listing.
- `get_session_status` reports `active` while a long turn runs, `idle` after.
- Unit tests: `claude-models` catalog shape; `ClaudeArchiveStore`; runner `listThreads` (local dir scan +
  remote helper op); `buildClaudeArgs` emits `--model`/`--effort`; `turnStart` prefers per-turn settings.

## Out of scope / reported, not fixed
- Mid-turn steer (no Claude equivalent).
- Remote per-endpoint launch flags from the catalog definition (separate follow-up; catalog has no such
  fields yet) — but note: once model/effort are per-session, the "remote inherits local model" concern is
  largely moot (model is chosen per session, not per endpoint).
- Tunnel teardown on disconnect + master re-check (prior review nits; separate change).

## Folded review corrections (BLOCKING — do these)
1. **Two consume sites.** Guard BOTH `SessionService.send`'s `consumeSettings` (service.ts:79) AND the
   send_to_session recovery consume (`production-app.ts:3728`) — factor one `maybeConsumeSettings(endpoint,…)`
   helper used by both, skipping when `sessionProvider(endpoint)==="claude"`. Missing the recovery site
   silently wipes the sticky Claude model/effort on any restart (the exact failure under audit).
2. **Remote `listThreads` = raw ssh on `SshClaudeCommandRunner`** (NOT a helper op — that needs a
   `RemoteRuntimeClient` + a `REMOTE_HELPER_SHA256` re-pin + asset edit, all over-built). Mirror the runner's
   existing `readTranscript`/`transcriptPath`: `attest()` the ControlMaster first, then one
   `find ~/.claude/projects -maxdepth 2 -name '*.jsonl' -printf '%T@\t%p\n'`, head-read each candidate's first
   records for `cwd`+preview in-runtime. Local runner: enumerate ALL `~/.claude/projects/*/` dirs and derive
   `cwd` from each transcript's records (do NOT reproduce Claude's cwd-hashing — the runner deliberately avoids
   it); filter by the requested cwd.
3. **Archive tombstone durability.** Register `claude_archived_threads` in BOTH `migrations.ts` AND
   `recovery-schema.ts` (like `claude_session_goals`), else recovery wipes it. Clear the tombstone on
   `turnStart` AND `thread/resume` (adopt path), not just turnStart. A never-materialized thread never calls
   `thread/archive` (lifecycle.ts:232 `if (native)`) — fine, nothing to rediscover.
4. **Discover shape.** Return everything in ONE page (`nextCursor:null`); the outer `SessionDiscovery`
   snapshot handles caller paging. `ThreadMeta` must NOT carry `ephemeral`/`parentThreadId` (else discovery
   skips them). Filter archived via the store (honor discovery's `archived∈[false,true]` loop).
5. **Security — preview is a NEW exfil surface** (the remote scan today emits only ownership metadata). Cap
   preview ≤200 chars, first USER message only (never assistant/tool output). Enumerate only
   `~/.claude/projects/*/*.jsonl`; derive cwd from the record, never a caller path.
6. **Catalog invariant.** All curated models share identical `supportedReasoningEfforts` (setEffort validates
   against the resolved model); if that ever diverges, effort validation breaks — note it. Dedup a
   configured `launchFlags.model` against the alias entries; mark it (or the default alias) `isDefault`.
7. **get_session_status** does NOT surface model/effort today (only nativeStatus/activeTurnId/goal). Either add
   `settings: runtime.settings(...)` to `service.status`, or drop the "status shows it" claim. Tests assert the
   applied model via the TRANSCRIPT regardless.
8. **Tests.** Assert the RESOLVED full model id in the transcript (`--model opus` records the full id, not
   "opus") — or assert it differs from the endpoint default. Add a GAP-1 recovery test (set model/effort →
   drive the recovery consume path → sticky settings survive). Keep the explicit invalid-effort rejection test.

## Sequencing (dev loop, one squashed PR: "claude tool parity")
1. list_models shape + curated catalog module (unblocks validation).
2. model + effort application + persistence predicate.
3. get_session_status running overlay.
4. discover (runner.listThreads local+remote) + archive store.
5. Acceptance simulation (local + remote) asserting real behavior; unit tests. Review → squash-merge → redeploy.
