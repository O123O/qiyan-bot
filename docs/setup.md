# Shared setup

This guide prepares QiYan's isolated assistant and the user's ordinary Codex workers. Chat credentials are adapter-specific; currently only [Telegram](chat-apps/telegram.md) is implemented.

## Understand the execution model

The assistant defaults to `danger-full-access` and approval policy `never`. It can use your filesystem non-interactively. Workers inherit your normal HOME, CODEX_HOME, configuration, credentials, skills, proxies, and provider variables; QiYan does not override their sandbox or approval policy.

Chat approvals are unsupported. Configure normal Codex for automatic, non-interactive worker operation before delegating work. Use a dedicated OS account or container if full access is too broad for the host.

## Defaults and optional paths

With no path variables, QiYan uses:

```text
$HOME/.qiyan-bot/qiyan-workdir
$HOME/.qiyan-bot/data
$HOME/.qiyan-bot/data/sessions.json
$HOME/qiyan-projects
```

QiYan home precedence is CLI `--home`, then process environment `QIYAN_HOME`, then `$HOME/.qiyan-bot`. Other values use CLI, process environment, `<QIYAN_HOME>/.env`, then defaults. Do not put `QIYAN_HOME` inside `.env`.

Optional settings in the private `.env` include:

```dotenv
ASSISTANT_WORKDIR=/absolute/path/to/qiyan-workdir
DATA_DIR=/absolute/path/to/qiyan-data
SESSION_REGISTRY_PATH=/absolute/path/to/qiyan-data/sessions.json
ASSISTANT_SANDBOX_MODE=danger-full-access
```

The assistant workdir must be separate from data and registry state and is the process working directory after startup. QiYan creates managed `AGENTS.md`, read-only `assistant-context.json`, and read-only `session-status.json`. Customize the prompt with `AGENTS.override.md`; never edit generated files.

Worker projects use relevant/user-specified semantic locations, with `~/qiyan-projects/<nickname>` as the backend fallback. QiYan home, its descendants, and ancestors containing it are never worker projects.

## Authenticate the assistant

Run device authentication once after configuring the home:

```bash
qiyan-bot config-check
qiyan-bot assistant-login
```

`config-check` validates the complete adapter configuration, including required Telegram values. `assistant-login` itself starts no bot and does not need chat credentials. The assistant profile is independent; QiYan never copies or symlinks your normal `auth.json`. If authentication later expires, stop the bot, run login again, and restart it yourself.

## Configure an adapter and launch

Store adapter variables in `<QIYAN_HOME>/.env` as its guide describes. Before launching, remember: the assistant has non-interactive full filesystem access, and workers must already be configured for auto mode because chat approvals are unsupported. Child processes do not inherit bot secrets from `.env`, but QiYan has the same OS-user filesystem access and can technically read that file.

```bash
qiyan-bot
```

Use `qiyan-bot --home /absolute/private/home` consistently for validation, login, and run when overriding the default. SIGINT and SIGTERM perform graceful shutdown. For a service, start directly in `qiyan-workdir`; do not use an external `EnvironmentFile`. QiYan reads its private mode-0600 `.env` itself.

QiYan's own replies have no prefix. Worker finals use `[nickname]`, and backend warnings use `[system]`.

## Backup

Stop QiYan, then copy `DATA_DIR`, an external `SESSION_REGISTRY_PATH`, and `ASSISTANT_WORKDIR` together. The isolated profile contains authentication and thread history. Do not restore generated JSON independently from SQLite.

See the root [README](../README.md#troubleshooting) for direct/delegated behavior, protected project paths, `/pass`, `/collect`, recovery, and troubleshooting.
