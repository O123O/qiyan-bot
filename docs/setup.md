# Shared setup

This guide prepares QiYan's isolated assistant and the user's ordinary Codex workers. Chat credentials are adapter-specific; currently only [Telegram](chat-apps/telegram.md) is implemented.

## Understand the execution model

The assistant defaults to `danger-full-access` and approval policy `never`. It can use your filesystem non-interactively. Workers inherit your normal HOME, CODEX_HOME, configuration, credentials, skills, proxies, and provider variables; QiYan does not override their sandbox or approval policy.

Chat approvals are unsupported. Configure normal Codex for automatic, non-interactive worker operation before delegating work. Use a dedicated OS account or container if full access is too broad for the host.

## Defaults and optional paths

With no path variables, QiYan uses:

```text
$HOME/.qiyan-bot/assistant
$HOME/.qiyan-bot/data
$HOME/.qiyan-bot/data/sessions.json
$HOME/qiyan-bot-projects
```

For a service, optional absolute overrides are:

```bash
export ASSISTANT_WORKDIR="$HOME/.qiyan-bot/assistant"
export DATA_DIR="$HOME/.qiyan-bot/data"
export SESSION_REGISTRY_PATH="$HOME/.qiyan-bot/data/sessions.json"
export ASSISTANT_SANDBOX_MODE=danger-full-access
```

The assistant workdir must be separate from data and registry state. QiYan creates the directories, managed `AGENTS.md`, read-only `assistant-context.json`, and read-only `session-status.json`. Customize the complete prompt with `AGENTS.override.md`; never edit generated files.

## Authenticate the assistant

Run device authentication once. If `DATA_DIR` is overridden, provide the same value here:

```bash
qiyan-bot assistant-login
```

This starts no bot and needs no chat credentials. The assistant profile is independent; QiYan never copies or symlinks your normal `auth.json`. If authentication later expires, stop the bot, run login again, and restart it yourself.

## Configure an adapter and launch

Set adapter variables from its guide. Before launching, remember: the assistant has non-interactive full filesystem access, and workers must already be configured for auto mode because chat approvals are unsupported.

```bash
qiyan-bot
```

Use `qiyan-bot --workdir "$ASSISTANT_WORKDIR"` only when overriding the HOME-based assistant path. SIGINT and SIGTERM perform graceful shutdown. Put secrets and configuration in your service manager's private environment, not a repository file or shell history.

## Backup

Stop QiYan, then copy `DATA_DIR`, an external `SESSION_REGISTRY_PATH`, and `ASSISTANT_WORKDIR` together. The isolated profile contains authentication and thread history. Do not restore generated JSON independently from SQLite.

See the root [README](../README.md#troubleshooting) for direct/delegated behavior, protected project paths, `/pass`, `/collect`, recovery, and troubleshooting.
