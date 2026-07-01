# Codex Chat Bot

A single-user, self-hosted Telegram bridge for Codex. One persistent Codex thread acts as the coordinator; ordinary Codex threads remain ordinary project sessions that can also be resumed manually from their project directories.

The MVP runs on one machine. One token-free app-server hosts all project sessions; a second local app-server hosts only the coordinator. The split, plus Linux peer-PID authorization on the loopback manager endpoint, prevents a project session from using manager credentials even if it can inspect same-user process environments. The endpoint pool and registry include endpoint IDs so a later release can add SSH-hosted app-servers without changing chat routing or session identity.

## Requirements

- Linux (race-safe outbound attachment handling uses `O_NOFOLLOW` and `/proc/self/fd`)
- Node.js 24 or newer
- `codex-cli 0.142.4` authenticated for the account that runs the bot
- A Telegram bot token from BotFather
- The numeric Telegram user ID of the only authorized owner

The bot intentionally runs project sessions with approval policy `never` and the configured non-interactive sandbox. Review this trust model before running it: project sessions can modify files and execute commands without chat approval buttons. `workspace-write` is the default; use `danger-full-access` only for projects you trust. The Telegram adapter discards every non-owner update before storing content or invoking a model, and output is restricted to that owner's private chat ID.

## Setup

```bash
npm ci
cp .env.example .env
```

Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, `TELEGRAM_DESTINATION_CHAT_ID`, and `COORDINATOR_WORKDIR`. The destination is normally the owner's private chat ID. The coordinator workdir should be a standalone user-owned directory outside both this repository and `DATA_DIR`, for example `$HOME/.codex-bot/coordinator`. Export the variables with your preferred secret manager; the program does not parse `.env` itself.

`--workdir` overrides `COORDINATOR_WORKDIR`. Relative coordinator, data, and registry paths resolve from the shell launch directory; use absolute paths when the bot must behave identically regardless of where it is launched. Startup rejects any direct, nested, or symlink-aliased overlap between the coordinator workdir and authoritative backend state.

Codex authentication may come from the normal `CODEX_HOME` profile or supported environment credentials such as `OPENAI_API_KEY`. The owned app-servers inherit only the environment needed by Codex and proxy settings. Telegram secrets are removed. A random loopback MCP bearer token exists only in the coordinator app-server, is excluded from model-launched shell commands, and is insufficient without the coordinator process identity.

Run:

```bash
set -a; . ./.env; set +a
npm start
```

Or select the coordinator home explicitly:

```bash
set -a; . ./.env; set +a
npm start -- --workdir "$HOME/.codex-bot/coordinator"
```

Send SIGINT or SIGTERM for graceful shutdown. Startup performs migrations, validates the registry, reconciles missed worker history and uncertain outbox rows, resumes or creates the coordinator, and only then begins Telegram polling.

## How it behaves

Ordinary messages go to the coordinator. It chooses a project nickname, asks when the target is ambiguous, and uses typed manager tools to create, adopt, detach, attach, archive, message, interrupt, and inspect project sessions. It can change the next-turn model or reasoning effort and get, replace, pause, resume, or cancel native goals. Goal completion is controlled by Codex, not by this bot.

Every eligible terminal worker response is automatically sent to Telegram as `[nickname] …`. The coordinator receives only compact metadata and decides whether it needs to read the body or follow up. This avoids duplicating project transcripts in the coordinator context. Failed, interrupted, permission-blocked, and unavailable work produces a labeled warning.

The coordinator keeps durable supervision notes in `<coordinator-workdir>/session-status.json`. The notebook records project status, current objectives, last sent work, last worker event, and pending follow-up so supervision intent survives context compaction. SQLite remains authoritative for execution state. An invalid existing notebook stops startup without replacing or quarantining its contents.

### Coordinator instructions

On first startup the bot installs its management playbook as `<coordinator-workdir>/AGENTS.md` and records the exact digest in `.codex-bot-agents.sha256`. Both files are bot-managed. Do not edit either one: startup refuses a changed or partially missing pair instead of guessing whether user content can be overwritten. An unchanged policy is upgraded automatically when the packaged playbook changes.

For complete prompt customization, copy the current policy and edit the override:

```bash
cp "$COORDINATOR_WORKDIR/AGENTS.md" "$COORDINATOR_WORKDIR/AGENTS.override.md"
```

Codex gives `AGENTS.override.md` precedence in that directory. The bot never creates, reads, updates, or deletes it. Because it replaces the managed prompt completely, retain any routing, automatic-delivery, notebook, exact-directive, goal, attachment, and recovery behavior you still want.

To recover from a managed-policy guard error, either restore `AGENTS.md` to the exact content represented by the stored digest, or move the desired custom policy to `AGENTS.override.md` and delete both `AGENTS.md` and `.codex-bot-agents.sha256`; the bot then reinstalls a fresh managed pair. A coordinator workdir inside a Git worktree is allowed but produces a warning because Codex may also inherit instructions from that repository's project root.

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

`data/sessions.json` maps coordinator-assigned nicknames to an endpoint, Codex thread ID, and canonical project directory. Writes are atomic and externally edited invalid JSON is rejected while the last-known-good in-memory registry remains active.

Detach before taking over a managed thread manually. Detach requires idle state, unsubscribes the bot, and ends its managed epoch. Work completed while detached is deliberately not auto-forwarded. Attach performs an idle read, resumes with the registered canonical directory, performs a second idle read, and starts a new epoch whose history baseline excludes detached-period turns.

Discovery scans all top-level persisted Codex threads on an endpoint, across archived and non-archived pages and every source kind. It filters ephemeral and child/subagent threads, then returns stable opaque snapshot pages. This lets the coordinator adopt sessions that were created outside the bot.

## Attachments

Inbound Telegram photos and documents are streamed into a mode-0600 private store with actual byte limits, SHA-256 metadata, per-message and total quotas, opaque source-context-scoped handles, retention counts, and expiry cleanup. Images become app-server `localImage` inputs; other files become `mention` inputs.

For outbound project files, the coordinator names a managed owner and a relative path. Linux opens the final component with `O_NOFOLLOW`, verifies the opened descriptor remains beneath the canonical owner root, and snapshots it into the private store before upload. Absolute paths, traversal, symlinks, non-regular files, growing files, cross-context handles, and oversized content are rejected.

## Delivery and recovery

Telegram output uses a durable outbox. Rows move through prepared, dispatched, and confirmed states. A crash after transmission but before confirmation is inherently ambiguous; on restart, mandatory results are retried with a stable label such as `[payments · recovery retry d_ab12]`, so a duplicate is visible rather than silently lost. Optional coordinator tool output reports `DELIVERY_UNCERTAIN` instead of retransmitting automatically.

Coordinator tool effects use a separate operation ledger keyed by source context, attempt, MCP request ID, kind, and canonical arguments. Identical calls replay receipts; changed arguments conflict. After a lost response, operations are reconciled where the app-server exposes proof. Irreconcilable operations become uncertain and are never blindly retransmitted. A failed coordinator attempt with dispatched effects is atomically superseded by one recovery context containing the stored receipts.

## State, backup, and logs

- `data/bot.sqlite3`: offsets, operations, outbox, events, runtime state, epochs, discovery snapshots, and attachment metadata
- `data/sessions.json`: human-editable session identity registry
- `data/attachments/`: private temporary attachment snapshots
- `<coordinator-workdir>/AGENTS.md`: bot-managed coordinator playbook
- `<coordinator-workdir>/.codex-bot-agents.sha256`: installed-playbook digest
- `<coordinator-workdir>/AGENTS.override.md`: optional, entirely user-owned replacement prompt
- `<coordinator-workdir>/session-status.json`: coordinator-maintained management notebook

Back up the SQLite database, registry, and external coordinator workdir together while the bot is stopped. Attachment blobs are transient; include them only if outstanding handles must survive restore. Logs contain structural metadata only and must never include ignored sender content, message bodies, tokens, or attachment bytes.

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

- `ENDPOINT_UNAVAILABLE`: check `codex --version`, Codex authentication, proxy variables, and app-server stderr.
- `CONFIGURATION_ERROR`: check `--workdir`/`COORDINATOR_WORKDIR`, path separation, the managed `AGENTS.md` digest pair, the existing notebook JSON, and the coordinator path stored in the session registry.
- `CWD_MISMATCH`: the persisted thread directory differs from the registry's canonical project path; do not force-attach it.
- `SESSION_BUSY`: wait, steer the exact active turn, or interrupt it before lifecycle changes.
- `PERMISSION_BLOCKED`: the worker requested an approval or permission escalation, which chat auto mode intentionally declines.
- `OPERATION_UNCERTAIN` or `DELIVERY_UNCERTAIN`: inspect the receipt/state before deciding whether a human-visible retry is safe.
- No Telegram input: verify the numeric owner ID. Other senders, edited messages, callbacks, channels, and unsupported media are intentionally ignored while their update offsets still advance.

Slack and WeChat adapters, SSH endpoints, multi-user tenancy, interactive approval UI, and arbitrary remote recipients are deliberately deferred. Chat adapters should normalize into the same canonical message and attachment contracts; SSH endpoints should implement the existing endpoint interface and preserve the same registry and recovery rules.
