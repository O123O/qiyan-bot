# Isolated Coordinator Profile Design

## Goal

Run the coordinator app-server with its own operating-system home and Codex home so it cannot inherit the user's normal `~/.codex` configuration, global instructions, plugins, session history, or home-scoped skills. Keep the shared local worker app-server unchanged so every managed project session continues to use the user's real home, normal `CODEX_HOME`, project configuration, and project skills.

## Process topology

The existing two-endpoint pool remains the security boundary:

- `local` is the shared worker endpoint. It keeps the current sanitized child environment derived from the bot process and therefore retains the user's real `HOME`, `CODEX_HOME`, authentication, and project discovery behavior.
- `coordinator-local` is the coordinator-only endpoint. It receives the manager MCP capability and an isolated profile environment. The existing backend guard continues to reject project sessions on this endpoint.

No app-server is added per project. Remote worker endpoints remain a later extension of the same pool.

## Profile layout and environment

The backend owns a fixed profile root beneath the canonical data directory:

```text
<DATA_DIR>/coordinator-profile/
  profile.json                 # version, creation nonce, and pending thread receipt
  home/
    .agents/skills/          # optional coordinator-only user skills
  codex/
    auth.json                # when Codex uses file credential storage
    config.toml              # optional coordinator-only Codex configuration
    sessions/
```

`prepareCoordinatorProfile` creates `coordinator-profile`, `home`, and `codex` with mode `0700`, rejects non-directory or symbolic-link replacements, and returns canonical paths with pinned device/inode identities. Profile integrity is revalidated before and after every coordinator app-server start and before marker transitions. Marker reads use a no-follow descriptor and verify that the opened inode is still the named regular file. The coordinator app-server receives these exact overrides:

```text
HOME=<DATA_DIR>/coordinator-profile/home
CODEX_HOME=<DATA_DIR>/coordinator-profile/codex
```

All other existing child-environment filtering remains in force: Telegram secrets are removed, proxy and supported provider credentials may pass through, and the manager MCP token exists only in the coordinator endpoint and remains excluded from model-launched shells. The worker environment is byte-for-byte unchanged by this feature.

The single-user deployment trusts other processes running under the bot's operating-system account. Pinning and validation fail closed for stable path, inode, type, or permission changes at startup/reconnect and marker boundaries; they are not an isolation boundary against a same-UID process deliberately racing pathname changes between those checks. Deploy the bot under a dedicated OS account or container when mutually hostile same-UID processes are in scope. The profile directories are bot-managed and must not be replaced or chmodded while the bot runs.

The managed coordinator policy remains in `<COORDINATOR_WORKDIR>/AGENTS.md`; `AGENTS.override.md` remains user-owned. Coordinator-specific project skills may be placed in `<COORDINATOR_WORKDIR>/.agents/skills`. Home-scoped coordinator skills may instead be placed in `<DATA_DIR>/coordinator-profile/home/.agents/skills`. The user's real home-scoped configuration and skills are not discovered by the coordinator. Codex-bundled or administrator-provided system capabilities are outside this user-profile boundary.

Project discovery remains rooted in the configured coordinator workdir. A standalone workdir sees only its own project guidance and skills. If the user intentionally places it inside a Git worktree, Codex may also discover that repository's parent `AGENTS.md`, `.codex/config.toml`, and `.agents/skills`; startup retains the existing warning and names all three inherited surfaces. This does not reintroduce the user's real home-scoped configuration.

## Authentication

The isolated profile has independent Codex authentication. The bot does not copy, hard-link, symlink, parse, or expose the user's normal `~/.codex/auth.json`; doing so could create refresh-token races or silently weaken the profile boundary.

After both app-servers initialize, startup calls `account/read` on `coordinator-local` before changing coordinator identity. If Codex reports that OpenAI authentication is required and no account is present, startup fails with `CONFIGURATION_ERROR`, identifies the isolated profile paths, and directs the user to the safe `codex-bot coordinator-login` command. Authentication supplied by a supported inherited provider environment remains valid when app-server reports that OpenAI authentication is not required.

The distributable binary provides `codex-bot coordinator-login`. This command needs only `DATA_DIR` and `CODEX_BINARY`, calls the same fail-closed profile preparation code, and then launches `codex login --device-auth` with the isolated environment and inherited terminal. It does not require Telegram secrets, start either app-server, write the activation marker, or use shell-interpreted command text. Documentation never asks the user to create profile directories with `mkdir -p` or to copy credentials manually.

Logging out of the user's normal profile does not log out the isolated file-backed profile, and vice versa.

## Coordinator thread migration

Threads are stored under one app-server's `CODEX_HOME`; consequently, the existing coordinator thread in the user's normal Codex home cannot be resumed by the isolated endpoint. Project threads must never be moved or rewritten.

`profile.json` is a bot-managed activation marker with schema version 1, a cryptographically random bot creation nonce, and an optional pending thread ID. On the first isolated-profile startup:

1. Validate that the registry's coordinator endpoint and canonical workdir still match the configured coordinator. This preserves the current fail-closed path checks.
2. Reconcile every recoverable manager operation using durable backend and worker state.
3. Read the old coordinator thread through the normal-profile worker endpoint. Require the returned thread ID to equal the registered legacy ID and its canonical cwd to equal the configured coordinator workdir before inspecting any turn. For each active SQLite attempt, bind a provisional attempt to its persisted turn by client message ID when possible. Apply already-terminal turns through the normal final-message and attempt-completion path so a completed answer is delivered rather than replayed.
4. Fail only the remaining unresolved active coordinator attempts through the existing recovery rules. Attempts without dispatched effects return their source context to the pending queue; attempts with proven or uncertain effects create one recovery context and are not blindly replayed.
5. Atomically replace only the coordinator registry identity with `thread_id: "pending"`; preserve every project-session mapping exactly.
6. Atomically write `profile.json` with a new `creation_nonce` and null `pending_thread_id`, then start a new in-memory coordinator with `threadSource` set to that nonce. A zero-turn Codex thread is not durable, listable, or resumable after its app-server exits.
7. Immediately after `thread/start` returns, atomically record its ID as `pending_thread_id`, then call `thread/name/set` with the exact name `codex-bot-coordinator:<nonce>`. This metadata operation materializes the thread without a model turn. Only after its success does the bot atomically store the registry identity and clear the matching pending receipt.

When the marker exists and the registry remains pending, `pending_thread_id` is the durable creation receipt. Recovery reads that exact ID after a new app-server generation. Exact structured JSON-RPC `-32600` “thread not loaded” from that initial read means the crash occurred before materialization, so the bot clears only that matching receipt and starts again. Every later resume error and every other read error preserves the receipt and fails closed. Pending and stale-receipt recovery must match the ID, canonical cwd, `threadSource` nonce, and nonce-tagged name. After receipt clearance, ordinary registered resumes require the immutable ID, canonical cwd, and `threadSource` nonce but tolerate Codex's supported user-facing thread rename. A successful registry resume clears any matching stale receipt left by a crash after registry commit.

This ordering closes every creation window: a crash before the receipt leaves no durable Codex thread; a crash before metadata materialization leaves a safely replaceable receipt; a crash after materialization recovers by exact ID and provenance; and a crash after registry commit resumes the registered thread. A missing, malformed, unsupported, symbolic-link, or non-regular marker fails closed except that a genuinely absent marker selects first activation. Deleting the entire profile deliberately causes a new isolated coordinator identity on the next successful authenticated startup.

The coordinator's durable knowledge does not depend solely on its old transcript: the authoritative session registry, SQLite operation/outbox/runtime state, generated session dashboard, and managed policy survive the migration. The first new coordinator turn therefore sees current management state without copying the old rollout into the isolated profile.

## Startup and recovery ordering

Workspace/profile preparation happens before storage and endpoint startup. The isolated directories are therefore available even when authentication is missing. Endpoint initialization and coordinator authentication verification happen before profile activation, registry reset, or scheduler/polling startup.

The first-profile attempt reconciliation happens after worker lifecycle and delivery reconciliation, because manager operations may need authoritative worker histories and durable delivery state. It happens before starting the isolated coordinator. Scheduler and Telegram polling remain disabled until the migration and coordinator identity are complete.

Ordinary restarts do not execute migration recovery again because `profile.json` is durable. Endpoint restarts during a running bot retain the same isolated environment and resume the same coordinator thread. Every initial start and reconnect of `coordinator-local` repeats Codex-home attestation and `account/read` before resuming or accepting coordinator work. Authentication failure keeps the endpoint unavailable and creates one actionable system warning per endpoint incident for the Telegram outbox while bounded reconnect continues.

## User-visible behavior and documentation

README setup and troubleshooting document:

- the two distinct app-server profiles;
- the exact isolated profile paths;
- the safe `codex-bot coordinator-login` command;
- where coordinator-only configuration and skills belong;
- that the first upgraded startup creates a new coordinator conversation but preserves worker sessions and backend management state;
- that backups must include `coordinator-profile`, especially its credentials and coordinator rollout state.

No Telegram command, manager tool, registry field, or worker-session behavior changes.

## Verification

Automated tests prove:

- profile directories and marker are private regular filesystem objects and symbolic-link substitutions fail closed;
- the coordinator child receives isolated `HOME` and `CODEX_HOME`, while the worker child retains the original values;
- Telegram secrets remain stripped and only the coordinator receives the manager capability;
- missing coordinator authentication stops startup before identity migration and reports the login paths;
- first activation validates the existing identity, reconciles active attempts, resets only the coordinator identity, persists the marker in crash-safe order, and creates a new coordinator thread;
- a completed legacy turn recorded only in the old rollout is terminalized and delivered rather than replayed;
- zero-turn creation records the ID before metadata materialization and recovers every crash boundary without a model turn;
- pending recovery clears only the structured `-32600` thread-not-loaded result and otherwise requires exact ID, cwd, nonce, and nonce-tagged name;
- subsequent startup resumes the isolated thread without resetting it;
- coordinator endpoint reconnect repeats authentication preflight and surfaces one actionable warning for an unauthenticated incident;
- project registry entries and worker endpoint/session discovery remain unchanged;
- coordinator skill discovery can see its own workdir/home skill roots but cannot see a fixture skill from the user's normal home; a nested Git fixture explicitly demonstrates and documents inherited repository skills;
- package/build checks and the real app-server manager-MCP integration continue to pass.

The live upgrade is performed only after a stopped-state backup. The installed bundle is restarted after the isolated profile has been authenticated, then verified structurally through app-server process environments, registry identity, dashboard parsing, and a real coordinator response.
