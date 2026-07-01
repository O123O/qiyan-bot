# Codex Chat Bot

A single-user, self-hosted Telegram bridge for Codex. One persistent Codex thread acts as the coordinator; ordinary Codex threads remain ordinary project sessions that can also be resumed manually from their project directories.

The MVP runs on one machine. One token-free app-server hosts all project sessions; a second local app-server hosts only the coordinator. The split, plus Linux peer-PID authorization on the loopback manager endpoint, prevents a project session from using manager credentials even if it can inspect same-user process environments. The endpoint pool and registry include endpoint IDs so a later release can add SSH-hosted app-servers without changing chat routing or session identity.

## Requirements

- Linux (race-safe outbound attachment handling uses `O_NOFOLLOW` and `/proc/self/fd`)
- Node.js 24 or newer
- `codex-cli 0.142.4` authenticated for project work, plus an independently authenticated coordinator profile (setup below)
- A Telegram bot token from BotFather
- The numeric Telegram user ID of the only authorized owner

The bot intentionally runs project sessions with approval policy `never` and the configured non-interactive sandbox. Review this trust model before running it: project sessions can modify files and execute commands without chat approval buttons. `workspace-write` is the default; use `danger-full-access` only for projects you trust. The Telegram adapter discards every non-owner update before storing content or invoking a model, and output is restricted to that owner's private chat ID.

## Build and install

```bash
npm install
npm run build
archive=$(npm pack --silent)
npm install --global --prefix "$HOME/.local" "./$archive"
rm -- "$archive"
```

`npm run build` creates a fully bundled `dist/codex-bot` executable. The installed command needs Node.js 24+, a `codex` executable, and the two Codex profiles described below; it does not need TSX, TypeScript source files, or a runtime dependency tree.

The archive contains the executable and its two coordinator template assets. `$HOME/.local/bin` must be in `PATH`.

Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, `TELEGRAM_DESTINATION_CHAT_ID`, and `COORDINATOR_WORKDIR`. The destination is normally the owner's private chat ID. The coordinator workdir should be a standalone user-owned directory outside both this repository and `DATA_DIR`, for example `$HOME/.codex-bot/coordinator`. Export the variables with your preferred secret manager; the program does not parse `.env` itself.

`--workdir` overrides `COORDINATOR_WORKDIR`. Relative coordinator, data, and registry paths resolve from the shell launch directory; use absolute paths when the bot must behave identically regardless of where it is launched. Startup rejects any direct, nested, or symlink-aliased overlap between the coordinator workdir and authoritative backend state.

Project workers use the account runner's normal `HOME`, `CODEX_HOME`, configuration, and skills. The coordinator uses private `HOME` and `CODEX_HOME` directories below `<DATA_DIR>/coordinator-profile` and never copies or links credentials from the normal profile. Authenticate it once after setting the same `DATA_DIR` used by the bot:

```bash
DATA_DIR="$HOME/.codex-bot/data" codex-bot coordinator-login
```

This starts Codex device authentication in the isolated profile. It does not need Telegram variables or start the bot. Supported provider environment credentials such as `OPENAI_API_KEY` may also satisfy the coordinator app-server when Codex does not require its own login. The owned app-servers otherwise inherit only the environment needed by Codex and proxy settings. Telegram secrets are removed. A random loopback MCP bearer token exists only in the coordinator app-server, is excluded from model-launched shell commands, and is insufficient without the coordinator process identity.

The coordinator profile is bot-managed; do not replace or change permissions on its directories while the bot runs. This single-user design trusts other processes under the bot's OS account and prevents accidental profile inheritance, but it is not a boundary against a same-account process deliberately racing filesystem changes. Use a dedicated OS account or container if that threat is relevant.

After exporting the configuration, run the installed command from any directory:

```bash
codex-bot --workdir "$HOME/.codex-bot/coordinator"
```

For source development, copy the example environment, export it, and use the same executable entry through TSX:

```bash
cp .env.example .env
set -a; . ./.env; set +a
npm start -- --workdir "$HOME/.codex-bot/coordinator"
```

Send SIGINT or SIGTERM for graceful shutdown. Startup performs migrations, validates the registry, reconciles missed worker history and uncertain outbox rows, resumes or creates the coordinator, and only then begins Telegram polling.

On the first startup after upgrading to isolated profiles, the bot creates a new coordinator thread inside the private profile. It preserves all project-session mappings and durable manager state, but does not copy the old coordinator transcript from the normal Codex home. Thread creation uses a durable nonce-tagged receipt so an app-server or process crash cannot silently select an unrelated thread.

## How it behaves

Ordinary messages go to the coordinator. It chooses a project nickname, asks when the target is ambiguous, and uses typed manager tools to create, adopt, detach, attach, archive, message, interrupt, and inspect project sessions. It can change the next-turn model or reasoning effort and get, replace, pause, resume, or cancel native goals. Goal completion is controlled by Codex, not by this bot.

Every eligible terminal worker response is automatically sent to Telegram as `[nickname] …`. The coordinator receives only compact metadata and decides whether it needs to read the body or follow up. This avoids duplicating project transcripts in the coordinator context. Failed, interrupted, permission-blocked, and unavailable work produces a labeled warning.

The backend materializes `<coordinator-workdir>/session-status.json` as a mode-0400 session dashboard. It automatically records lifecycle state, active turn, the last instruction, terminal worker metadata, current and pending model/effort, exact observed thread token/context use, and the native goal. The coordinator owns only concise `manager_notes`, updated through `update_session_notes`, so supervision intent survives context compaction without asking the model to maintain JSON. SQLite is authoritative; the JSON file is a replaceable read-only view.

On the first upgraded startup, a version-1 manager notebook is imported exactly once by stable thread identity. `project_status`, `current_objective`, and `pending_follow_up` become manager notes. Legacy last-sent and worker-event fields are not trusted as automatic observations. Invalid, unmatched, ambiguous, or duplicate legacy entries stop startup before the original bytes are replaced. A successful migration is crash-idempotent.

`get_session_status` returns the same complete entry after refreshing live lifecycle and goal state. Token figures describe that Codex thread's context use; they are not account billing, credits, global usage, or rate-limit information.

### Coordinator instructions

On first startup the bot installs its management playbook as `<coordinator-workdir>/AGENTS.md` and records the exact digest in `.codex-bot-agents.sha256`. Both files are bot-managed. Do not edit either one: startup refuses a changed or partially missing pair instead of guessing whether user content can be overwritten. An unchanged policy is upgraded automatically when the packaged playbook changes.

For complete prompt customization, copy the current policy and edit the override:

```bash
cp "$COORDINATOR_WORKDIR/AGENTS.md" "$COORDINATOR_WORKDIR/AGENTS.override.md"
```

Codex gives `AGENTS.override.md` precedence in that directory. The bot never creates, reads, updates, or deletes it. Because it replaces the managed prompt completely, retain the routing, automatic-delivery, read-only dashboard/registry, exact-directive, goal, attachment, and recovery behavior you still want.

To recover from a managed-policy guard error, either restore `AGENTS.md` to the exact content represented by the stored digest, or move the desired custom policy to `AGENTS.override.md` and delete both `AGENTS.md` and `.codex-bot-agents.sha256`; the bot then reinstalls a fresh managed pair. A coordinator workdir inside a Git worktree is allowed but produces a warning because Codex may also inherit instructions from that repository's project root.

The coordinator does not inherit the account runner's home-scoped Codex configuration or skills. Put coordinator-only Codex configuration in `<DATA_DIR>/coordinator-profile/codex/config.toml`, home-scoped skills in `<DATA_DIR>/coordinator-profile/home/.agents/skills`, or project-scoped skills in `<coordinator-workdir>/.agents/skills`. If the coordinator workdir is inside a Git worktree, Codex can also inherit that repository's parent `AGENTS.md`, `.codex/config.toml`, and `.agents/skills`; startup warns about this boundary.

### Exact pass-through

Use `/pass ` when wording must reach a worker unchanged:

```text
tell payments /pass  preserve these two leading spaces
```

The coordinator still selects the nickname and whether to start or steer. The backend verifies the content byte-for-byte against the original Telegram text and preserves attachment order. The authorization is single-use and replay-safe. Text after `/pass ` is opaque, including another `/collect` string.

### Direct collection

Use `/collect` or `/collect N` to send the newest eligible worker finals directly to Telegram:

```text
report payments /collect 3
```

The backend fixes the count from the immutable source message, selects at most 20 messages by stable terminal order, emits them chronologically, and returns only delivery receipts to the coordinator. Without the directive, normal collection returns bodies to the coordinator for inspection or summarization.

## Sessions and manual work

`data/sessions.json` maps coordinator-assigned nicknames to an endpoint, Codex thread ID, and canonical project directory. The coordinator treats it as read-only and uses typed lifecycle/nickname tools. Backend writes are atomic; an invalid operator replacement is rejected while the last-known-good in-memory registry remains active.

Detach before taking over a managed thread manually. Detach requires idle state, unsubscribes the bot, and ends its managed epoch. Work completed while detached is deliberately not auto-forwarded. Attach performs an idle read, resumes with the registered canonical directory, performs a second idle read, and starts a new epoch whose history baseline excludes detached-period turns.

Discovery scans all top-level persisted Codex threads on an endpoint, across archived and non-archived pages and every source kind. It filters ephemeral and child/subagent threads, then returns stable opaque snapshot pages. This lets the coordinator adopt sessions that were created outside the bot.

## Attachments

Inbound Telegram photos and documents are streamed into a mode-0600 private store with actual byte limits, SHA-256 metadata, per-message and total quotas, opaque source-context-scoped handles, retention counts, and expiry cleanup. Images become app-server `localImage` inputs; other files become `mention` inputs.

For outbound project files, the coordinator names a managed owner and a relative path. Linux opens the final component with `O_NOFOLLOW`, verifies the opened descriptor remains beneath the canonical owner root, and snapshots it into the private store before upload. Absolute paths, traversal, symlinks, non-regular files, growing files, cross-context handles, and oversized content are rejected.

## Delivery and recovery

Telegram output uses a durable outbox. Rows move through prepared, dispatched, and confirmed states. A crash after transmission but before confirmation is inherently ambiguous; on restart, mandatory results are retried with a stable label such as `[payments · recovery retry d_ab12]`, so a duplicate is visible rather than silently lost. Optional coordinator tool output reports `DELIVERY_UNCERTAIN` instead of retransmitting automatically.

Coordinator tool effects use a separate operation ledger keyed by source context, attempt, MCP request ID, kind, and canonical arguments. Identical calls replay receipts; changed arguments conflict. After a lost response, operations are reconciled where the app-server exposes proof. Irreconcilable operations become uncertain and are never blindly retransmitted. A failed coordinator attempt with dispatched effects is atomically superseded by one recovery context containing the stored receipts.

## State, backup, and logs

- `data/bot.sqlite3`: offsets, operations, outbox, events, runtime state, dashboard observations/notes, notification inbox, epochs, discovery snapshots, and attachment metadata
- `data/sessions.json`: backend session identity registry (read-only to the coordinator)
- `data/attachments/`: private temporary attachment snapshots
- `<DATA_DIR>/coordinator-profile/profile.json`: isolated coordinator activation and crash-recovery receipt
- `<DATA_DIR>/coordinator-profile/codex/`: isolated coordinator Codex configuration, authentication, and thread storage
- `<DATA_DIR>/coordinator-profile/home/`: isolated coordinator operating-system home and optional home-scoped skills
- `<coordinator-workdir>/AGENTS.md`: bot-managed coordinator playbook
- `<coordinator-workdir>/.codex-bot-agents.sha256`: installed-playbook digest
- `<coordinator-workdir>/AGENTS.override.md`: optional, entirely user-owned replacement prompt
- `<coordinator-workdir>/session-status.json`: backend-generated mode-0400 session dashboard

Back up the SQLite database, registry, complete coordinator profile, and external coordinator workdir together while the bot is stopped. The coordinator profile contains authentication secrets and thread history; protect the backup accordingly. Do not restore `session-status.json` independently from SQLite; it is rebuilt at startup. Attachment blobs are transient; include them only if outstanding handles must survive restore. Logs contain structural metadata only and must never include ignored sender content, message bodies, tokens, or attachment bytes.

If dashboard rendering fails after a confirmed action, the action remains confirmed. SQLite keeps the projection dirty, emits one structural warning for the failure episode, and maintenance retries without replaying the app-server action. Repair the coordinator directory/path permissions, then wait for maintenance or restart. Startup will not run the coordinator until a complete dashboard has been written.

## Verification

```bash
npm run check
RUN_CODEX_INTEGRATION=1 npm test -- tests/integration/app-server.test.ts
RUN_CODEX_INTEGRATION=1 npm test -- tests/integration/mcp-coordinator.test.ts
npm test -- tests/integration/recovery.test.ts
```

The real-app-server tests pin the generated protocol to Codex 0.142.4 and make a small model request. The Telegram live test is additionally gated and sends a real message:

```bash
RUN_TELEGRAM_LIVE=1 npm test -- tests/integration/telegram-live.test.ts
```

## Troubleshooting

- `ENDPOINT_UNAVAILABLE`: check `codex --version`, the applicable project or coordinator authentication, proxy variables, and app-server stderr.
- Coordinator authentication required: run `DATA_DIR="<the bot's data directory>" codex-bot coordinator-login`, complete device authentication, then restart the bot. Do not copy the normal profile's `auth.json`.
- `CONFIGURATION_ERROR`: check `--workdir`/`COORDINATOR_WORKDIR`, path separation, the managed `AGENTS.md` digest pair, a legacy dashboard awaiting migration, and the coordinator path stored in the session registry.
- `CWD_MISMATCH`: the persisted thread directory differs from the registry's canonical project path; do not force-attach it.
- `SESSION_BUSY`: wait, steer the exact active turn, or interrupt it before lifecycle changes.
- `PERMISSION_BLOCKED`: the worker requested an approval or permission escalation, which chat auto mode intentionally declines.
- `OPERATION_UNCERTAIN` or `DELIVERY_UNCERTAIN`: inspect the receipt/state before deciding whether a human-visible retry is safe.
- No Telegram input: verify the numeric owner ID. Other senders, edited messages, callbacks, channels, and unsupported media are intentionally ignored while their update offsets still advance.

Slack and WeChat adapters, SSH endpoints, multi-user tenancy, interactive approval UI, and arbitrary remote recipients are deliberately deferred. Chat adapters should normalize into the same canonical message and attachment contracts; SSH endpoints should implement the existing endpoint interface and preserve the same registry and recovery rules.
