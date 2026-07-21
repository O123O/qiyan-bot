# Shared setup

This guide prepares QiYan's isolated assistant and the user's ordinary Codex workers. [Telegram](chat-apps/telegram.md) and [Slack](chat-apps/slack.md) are implemented and live-tested. [Personal WeChat](chat-apps/wechat.md) is experimental: implemented with automated-test coverage but not successfully live-tested. All three adapters may run together.

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

The assistant workdir must be separate from data and registry state and is the process working directory after startup. QiYan creates managed `AGENTS.md`, read-only `assistant-context.json`, and read-only `session-status.json`. Put additions in the optional user-owned `AGENTS.append.md`; QiYan composes them after its packaged policy on every startup. Use `AGENTS.override.md` for a complete replacement, which Codex gives precedence normally. Never edit generated files.

Worker projects use relevant/user-specified semantic locations, with `~/qiyan-projects/<nickname>` as the backend fallback. QiYan home, its descendants, and ancestors containing it are never worker projects.

## Authenticate the assistant

Run device authentication once after configuring the home:

```bash
qiyan-bot config-check
qiyan-bot assistant-login
```

`config-check` requires at least one configured adapter and validates every configured adapter. Multi-adapter setups require `PRIMARY_CHAT_APP=telegram`, `PRIMARY_CHAT_APP=slack`, or `PRIMARY_CHAT_APP=weixin`. `assistant-login` itself starts no bot and does not need chat credentials. The assistant profile is independent; QiYan never copies or symlinks your normal `auth.json`. If authentication later expires, stop the bot, run login again, and restart it yourself.

## Configure an adapter and launch

Store Telegram and Slack adapter variables in `<QIYAN_HOME>/.env` as their guides describe. Personal WeChat is different: run `qiyan-bot weixin-login --home <QIYAN_HOME>` while the service is stopped; it creates the managed owner-only `<QIYAN_HOME>/credentials/weixin.json`, not an environment variable. Before launching, remember: the assistant has non-interactive full filesystem access, and workers must already be configured for auto mode because chat approvals are unsupported. Child processes do not inherit bot secrets from `.env`, but QiYan has the same OS-user filesystem access and can technically read that file.

```bash
qiyan-bot
```

This starts a long-lived foreground process; the terminal remains occupied while QiYan serves chat traffic. Successful startup prints `QiYan is running in the foreground. Press Ctrl+C to stop.` Use Ctrl+C, SIGINT, or SIGTERM for graceful shutdown.

For unattended operation on systemd-based Linux, install an enabled user service after configuration and assistant login:

```bash
qiyan-bot service install
qiyan-bot service status
qiyan-bot service logs
```

Use `qiyan-bot service start|stop|restart` for normal control and `qiyan-bot service uninstall` to stop, disable, and remove the generated unit. The service runs the same foreground process under systemd, so tmux is unnecessary. `qiyan-bot service logs` prints the latest 100 entries; follow them live with `journalctl --user -u qiyan-bot.service -f`. Runtime events distinguish adapter startup, accepted or safely ignored input, assistant turn submission and completion, ingress or reconnect failure and recovery, delivery failure, and contained background failure without recording message bodies, attachment contents, tokens, or Codex credentials. Read-only `status` and `logs` remain available even when a stale service-operation lock blocks mutations. Whether a user service remains active after logout is a host policy; an administrator or the user may enable lingering separately with `loginctl enable-linger "$USER"` when appropriate. QiYan does not change lingering policy.

`qiyan-bot service install` captures the invoking terminal's exact `PATH` in the generated unit. Run it from the normally initialized terminal whose command path QiYan should use; systemd does not source `config.fish`, `.bashrc`, or other shell startup files. If your PATH changes, run `qiyan-bot service uninstall` and then `qiyan-bot service install` again. A restart alone retains the captured PATH. PATH entries must be nonempty, absolute, and normalized; aliases and shell functions are not executables and are not captured.

Use `qiyan-bot --home /absolute/private/home` consistently for validation, login, run, and `service install` when overriding the default. Put service configuration in the private `.env`; temporary shell-only bot variables are deliberately ignored when `service install` validates what the service will actually read. The generated unit starts in the private QiYan home, and QiYan changes to `qiyan-workdir` before starting either Codex App Server. Do not use an external `EnvironmentFile`; QiYan reads its private mode-0600 `.env` itself.

Service management currently requires the default systemd user configuration directory at `$HOME/.config/systemd/user`; a non-default `XDG_CONFIG_HOME` is rejected rather than writing a unit that systemd may not discover. The unit contains the captured non-secret PATH but no credential values, and it refuses to overwrite or remove an existing unit that was not generated by this command. Reinstalling an identical generated unit is safe; if a future generated unit differs, run `service uninstall` before `service install`. Operations use a cross-process lock. If a service-management process is killed and leaves `.qiyan-bot.service.lock`, first verify that no service command is running, then remove only that stale lock file.

QiYan's own replies have no prefix. Worker finals use `[nickname]`, and backend warnings use `[system]`.

The backend permits one active QiYan conversation globally. Messages and attachments from the same conversation use Codex-native `turn/steer` while that turn is active. Each message from another conversation is durably queued and receives `[system] queued`; it starts only after the current ownership period ends. The backend owns this routing, so QiYan never chooses a platform or destination and never broadcasts a reply across adapters.

`/pass` and `/collect` are ordinary messages for scheduling purposes. They follow the same start, steering, queue, and recovery path as other text. The backend only uses them later as FIFO safeguards: `/pass` verifies exact worker text and attachment order, while `/collect` verifies the requested count before direct delivery.

## Backup

Stop QiYan, then copy `DATA_DIR`, an external `SESSION_REGISTRY_PATH`, `ASSISTANT_WORKDIR`, and `<QIYAN_HOME>/credentials/weixin.json` (when present) together. The isolated profile and WeChat credential contain secrets. Do not restore generated JSON or one credential independently from the matching SQLite state.

See the root [README](../README.md#troubleshooting) for direct/delegated behavior, protected project paths, `/pass`, `/collect`, recovery, and troubleshooting.
