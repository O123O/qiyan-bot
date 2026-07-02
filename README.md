# QiYan Bot

QiYan Bot is a single-user, self-hosted, general-purpose personal assistant powered by Codex. It can answer and handle small filesystem tasks directly, or deliberately delegate sustained project work to ordinary, resumable Codex sessions. Telegram is the first chat adapter; Slack and WeChat are planned behind the same transport-neutral backend.

QiYan keeps the assistant and project workers distinct. The assistant has its own HOME, CODEX_HOME, authentication, instructions, and app-server. Workers use your normal HOME, CODEX_HOME, configuration, credentials, skills, and app-server. Before opening a managed thread in another Codex client, run `unadopt_session`; adopt it again afterward if QiYan should resume management.

## Security model

Read this before installing or launching:

- The assistant defaults to `danger-full-access` with approval policy `never`. It can read, write, and execute as your OS user without an interactive confirmation.
- Chat approvals are unsupported. Worker sessions receive no QiYan approval, sandbox, or shell override, so your normal Codex configuration must already be suitable for automatic, non-interactive operation. A remaining permission request is reported as blocked.
- The Telegram adapter accepts only the configured owner and sends only to that owner's private chat. This is not a multi-user service.
- The private `.env` is not propagated to assistant or worker child processes, but full filesystem access under the same OS user means QiYan can technically read it. Filesystem isolation requires a dedicated account or container.
- Use a dedicated OS account or container if other same-account processes are outside your trust boundary.

## Requirements

- Linux
- Node.js 24 or newer
- `codex-cli 0.142.4`
- A Telegram bot token and the numeric user ID of its sole owner

## Install

QiYan is distributed through GitHub Releases, not the npm registry. Require the nonempty GitHub asset digest and verify the downloaded archive before installation:

```bash
workdir=$(mktemp -d)
curl -fsSL https://github.com/O123O/qiyan-bot/releases/latest/download/qiyan-bot.tgz -o "$workdir/qiyan-bot.tgz"
digest=$(curl -fsSL https://api.github.com/repos/O123O/qiyan-bot/releases/latest |
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const a=JSON.parse(s).assets.find(x=>x.name==="qiyan-bot.tgz");if(!a?.digest)process.exit(1);process.stdout.write(a.digest)})')
test -n "$digest"
test "${digest%%:*}" = sha256
printf '%s  %s\n' "${digest#sha256:}" "$workdir/qiyan-bot.tgz" | sha256sum --check --status
npm install --global --prefix "$HOME/.local" "$workdir/qiyan-bot.tgz"
export PATH="$HOME/.local/bin:$PATH"
qiyan-bot --version
```

The Release archive is a bundled runtime with no production dependency tree. For digest verification and a no-Git source build, see the [installation guide](docs/installation.md).

Setup guides:

- [Shared Codex and assistant setup](docs/setup.md)
- [Required fresh cutover for versions before v0.3.0](docs/upgrading-to-v0.3.md)
- [Telegram — implemented](docs/chat-apps/telegram.md)
- [Slack — planned](docs/chat-apps/slack.md)
- [WeChat — planned](docs/chat-apps/wechat.md)

## Configure and run

The normal configuration lives in `~/.qiyan-bot/.env`. Create it as an owner-only file (replace the placeholders; never commit this file):

```bash
mkdir -p "$HOME/.qiyan-bot"
chmod 700 "$HOME/.qiyan-bot"
cat > "$HOME/.qiyan-bot/.env" <<'EOF'
TELEGRAM_BOT_TOKEN=replace-with-botfather-token
TELEGRAM_OWNER_ID=123456789
TELEGRAM_DESTINATION_CHAT_ID=123456789
EOF
chmod 600 "$HOME/.qiyan-bot/.env"
```

See the [Telegram guide](docs/chat-apps/telegram.md) for safe owner-ID discovery. Validate the complete configuration, then authenticate the isolated assistant profile once:

```bash
qiyan-bot config-check
qiyan-bot assistant-login
```

This does not copy or link normal Codex authentication. The assistant starts in `<QIYAN_HOME>/qiyan-workdir`; it does not use the repository or launch directory as user workspace.

Before launching, remember that the assistant is non-interactive `danger-full-access`, while workers must be configured in your normal Codex profile for automatic operation because chat approvals are unsupported.

```bash
qiyan-bot
```

QiYan home is selected by CLI `--home`, then process `QIYAN_HOME`, then `$HOME/.qiyan-bot`. Other settings use CLI, then process environment, then `<QIYAN_HOME>/.env`, then defaults. `QIYAN_HOME` itself is intentionally not allowed inside `.env`.

The defaults are:

- QiYan home: `$HOME/.qiyan-bot`
- assistant workdir: `$HOME/.qiyan-bot/qiyan-workdir`
- data and isolated profile: `$HOME/.qiyan-bot/data`
- session registry: `$HOME/.qiyan-bot/data/sessions.json`
- delegated fallback root: `$HOME/qiyan-projects`

`qiyan-bot --home /private/qiyan`, `--workdir`, `ASSISTANT_WORKDIR`, `DATA_DIR`, `SESSION_REGISTRY_PATH`, and `ASSISTANT_SANDBOX_MODE` override those defaults independently. Use absolute paths for a service. Keep the same home for `config-check`, `assistant-login`, and run. The assistant sandbox override affects only the assistant; it never changes worker policy.

## Direct work and delegated sessions

QiYan reads `assistant-context.json` to translate phrases such as “my Documents” to your real home, because the assistant's shell `~` points to its isolated HOME. Small, personal, one-off, and cross-project tasks are normally done directly with absolute paths.

For sustained coding or project work, QiYan creates or resumes a worker session. It prefers a relevant existing project, a user-specified path, or another semantic user location. Documents is only an example, not a default. If no path is appropriate, the backend exclusively creates `$HOME/qiyan-projects/<nickname>`. It rejects `QIYAN_HOME`, broad roots, state overlap, traversal, symlink redirection, fallback collisions, and directory replacement before dispatch.

QiYan's own replies have no label prefix. Every eligible worker final is automatically delivered as `[nickname] …`, and backend warnings use `[system]`. The assistant receives metadata and reads the full worker body only when needed. `session-status.json`, `assistant-context.json`, and the registry are generated, read-only state; do not edit them.

`adopt_session` preserves an existing Codex thread's native cwd. `unadopt_session` removes it from QiYan without deleting or archiving the Codex thread; `archive_session` invokes Codex archive and then removes the QiYan mapping.

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
- `<DATA_DIR>/sessions.json`: registry v3 with assistant identity and generation-safe worker mappings
- `<DATA_DIR>/assistant-profile/`: isolated authentication, configuration, and assistant thread storage
- `<assistant-workdir>/AGENTS.md`: managed assistant policy
- `<assistant-workdir>/assistant-context.json`: mode-0400 real-home/QiYan-home context
- `<assistant-workdir>/session-status.json`: mode-0400 session dashboard

This is the v0.3 fresh QiYan state format. State created before v0.3.0 is rejected without migration or mutation. Do not use the generic updater for that first transition: follow the [required destructive fresh-cutover guide](docs/upgrading-to-v0.3.md). Stop the process and back up the data directory plus external assistant workdir together; the assistant profile contains secrets.

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
- `CONFIGURATION_ERROR`: run `qiyan-bot config-check` for dotenv and path validation. Startup separately enforces managed-file guards, registry v3, and state marker 2.
- `CWD_MISMATCH`: the native thread directory differs from the pinned registry path.
- `SESSION_BUSY`: wait, steer the active turn, or explicitly interrupt it.
- `PERMISSION_BLOCKED`: the user's normal worker configuration still requested an approval that chat cannot provide.
- `OPERATION_UNCERTAIN` or `DELIVERY_UNCERTAIN`: inspect status before deciding whether a human-visible retry is safe.
- No Telegram input: verify the numeric owner ID and ensure no second process is polling the same bot token.

SSH endpoints, Slack, WeChat, interactive approval UI, multi-user tenancy, and arbitrary remote recipients are deferred.
