# QiYan Bot

QiYan Bot is a single-user, self-hosted, general-purpose personal assistant powered by Codex. It can answer and handle small filesystem tasks directly, or deliberately delegate sustained project work to ordinary, resumable Codex sessions. Telegram is the first chat adapter; Slack and WeChat are planned behind the same transport-neutral backend.

QiYan keeps the assistant and project workers distinct. The assistant has its own HOME, CODEX_HOME, authentication, instructions, and app-server. Workers use your normal HOME, CODEX_HOME, configuration, credentials, skills, and app-server, so you can resume a managed thread manually from its project directory.

## Security model

Read this before installing or launching:

- The assistant defaults to `danger-full-access` with approval policy `never`. It can read, write, and execute as your OS user without an interactive confirmation.
- Chat approvals are unsupported. Worker sessions receive no QiYan approval, sandbox, or shell override, so your normal Codex configuration must already be suitable for automatic, non-interactive operation. A remaining permission request is reported as blocked.
- The Telegram adapter accepts only the configured owner and sends only to that owner's private chat. This is not a multi-user service.
- Use a dedicated OS account or container if other same-account processes are outside your trust boundary.

## Requirements

- Linux
- Node.js 24 or newer
- `codex-cli 0.142.4`
- A Telegram bot token and the numeric user ID of its sole owner

## Install

QiYan is distributed through GitHub Releases, not the npm registry. Do not use `npm install -g qiyan-bot` without the Release URL.

```bash
npm install --global \
  --prefix "$HOME/.local" \
  https://github.com/O123O/qiyan-bot/releases/latest/download/qiyan-bot.tgz
export PATH="$HOME/.local/bin:$PATH"
qiyan-bot --version
```

The Release archive is a bundled runtime with no production dependency tree. For digest verification and a no-Git source build, see the [installation guide](docs/installation.md).

Setup guides:

- [Shared Codex and assistant setup](docs/setup.md)
- [Telegram — implemented](docs/chat-apps/telegram.md)
- [Slack — planned](docs/chat-apps/slack.md)
- [WeChat — planned](docs/chat-apps/wechat.md)

## Configure and run

Authenticate the isolated assistant profile once. This does not copy or link your normal Codex authentication:

```bash
qiyan-bot assistant-login
```

Set the Telegram credentials in a private shell or service environment:

```bash
export TELEGRAM_BOT_TOKEN='<botfather-token>'
export TELEGRAM_OWNER_ID='<numeric-user-id>'
export TELEGRAM_DESTINATION_CHAT_ID="$TELEGRAM_OWNER_ID"
```

Before launching, remember that the assistant is non-interactive `danger-full-access`, while workers must be configured in your normal Codex profile for automatic operation because chat approvals are unsupported.

```bash
qiyan-bot
```

The HOME-based defaults are:

- assistant workdir: `$HOME/.qiyan-bot/assistant`
- data and isolated profile: `$HOME/.qiyan-bot/data`
- session registry: `$HOME/.qiyan-bot/data/sessions.json`
- delegated fallback root: `$HOME/qiyan-bot-projects`

`--workdir`, `ASSISTANT_WORKDIR`, `DATA_DIR`, `SESSION_REGISTRY_PATH`, and `ASSISTANT_SANDBOX_MODE` override those defaults independently. Use absolute paths for a service. The assistant sandbox override affects only the assistant; it never changes worker policy.

## Direct work and delegated sessions

QiYan reads `assistant-context.json` to translate phrases such as “my Documents” to your real home, because the assistant's shell `~` points to its isolated HOME. Small, personal, one-off, and cross-project tasks are normally done directly with absolute paths.

For sustained coding or project work, QiYan creates or resumes a worker session. Explicit project paths may be existing or newly created. If no path is appropriate, the backend exclusively creates `$HOME/qiyan-bot-projects/<nickname>`. It rejects broad roots, assistant/bot state overlap, traversal, symlink redirection, fallback collisions, and a directory whose device/inode identity changes before dispatch.

Every eligible worker final is automatically delivered as `[nickname] …`. The assistant receives metadata and reads the full body only when the user or supervision requires it. `session-status.json`, `assistant-context.json`, and the registry are generated, read-only state; do not edit them.

Use exact pass-through when wording must reach a worker unchanged:

```text
tell payments /pass  preserve this leading space
```

Use direct collection when worker finals should bypass assistant summarization:

```text
report payments /collect 3
```

## Assistant instructions and customization

QiYan installs `<assistant-workdir>/AGENTS.md` and records its digest. Startup upgrades an unchanged policy and rejects a modified or partially missing managed pair. Put a complete replacement prompt in `AGENTS.override.md`; the bot never reads or modifies that user-owned file.

The assistant also does not inherit home-scoped user skills. Put assistant-only configuration in `<DATA_DIR>/assistant-profile/codex/config.toml`, home skills in `<DATA_DIR>/assistant-profile/home/.agents/skills`, or project-scoped skills in the assistant workdir. Workers continue to use your normal Codex configuration and skills unchanged.

## State and backup

- `<DATA_DIR>/bot.sqlite3`: operations, outbox, events, runtime, observations, and attachment metadata
- `<DATA_DIR>/sessions.json`: registry v2 with assistant and worker identities
- `<DATA_DIR>/assistant-profile/`: isolated authentication, configuration, and assistant thread storage
- `<assistant-workdir>/AGENTS.md`: managed assistant policy
- `<assistant-workdir>/assistant-context.json`: mode-0400 real-home context
- `<assistant-workdir>/session-status.json`: mode-0400 session dashboard

This is a fresh QiYan state format. Pre-QiYan databases and registries are rejected without migration or mutation. Stop the process and back up the data directory plus external assistant workdir together; the assistant profile contains secrets.

## Attachments and recovery

Inbound files are streamed into a private quota-limited store. Outbound project files are opened beneath a managed root with Linux no-follow checks and snapshotted before upload. Absolute outbound paths, traversal, symlinks, special files, and oversized content are rejected.

Telegram delivery and assistant tool effects are durable. Confirmed effects replay receipts; uncertain effects are reconciled against app-server or outbox state and are never blindly repeated. A visible recovery label identifies a mandatory delivery that must be retried after an ambiguous crash.

## Development

```bash
npm ci
npm run check
RUN_CODEX_INTEGRATION=1 npm test -- tests/integration/app-server.test.ts
RUN_CODEX_INTEGRATION=1 npm test -- tests/integration/mcp-assistant.test.ts
```

## Troubleshooting

- Assistant authentication required: stop QiYan, run `qiyan-bot assistant-login`, complete the device flow, and restart. Do not copy the normal profile's `auth.json`.
- `CONFIGURATION_ERROR`: check HOME/path separation, managed-file guards, registry v2, and the QiYan database marker.
- `CWD_MISMATCH`: the native thread directory differs from the pinned registry path.
- `SESSION_BUSY`: wait, steer the active turn, or explicitly interrupt it.
- `PERMISSION_BLOCKED`: the user's normal worker configuration still requested an approval that chat cannot provide.
- `OPERATION_UNCERTAIN` or `DELIVERY_UNCERTAIN`: inspect status before deciding whether a human-visible retry is safe.
- No Telegram input: verify the numeric owner ID and ensure no second process is polling the same bot token.

SSH endpoints, Slack, WeChat, interactive approval UI, multi-user tenancy, and arbitrary remote recipients are deferred.
