# Required fresh cutover to v0.3

This procedure applies to every QiYan installation whose state was created before v0.3.0. v0.3 uses a new database marker and registry generation model. It intentionally does not migrate old managed sessions, operations, assistant history, or generated workspace files. The commands reset v0.3 to its default paths; old custom state paths are used only to locate optional isolated authentication and are not carried into the new configuration.

The cutover is destructive. The only values carried forward are supported adapter configuration and, at your choice, the isolated QiYan assistant profile's own `auth.json`. Never copy or link your normal `~/.codex/auth.json`.

## 1. Stop the whole old process tree

Disable and stop the user service if one exists:

```bash
systemctl --user disable --now qiyan-bot.service
systemctl --user is-active qiyan-bot.service
```

The second command must report `inactive` or `failed`. Confirm that no old `qiyan-bot` process or app-server child remains before continuing. If QiYan was launched from a terminal or another supervisor, stop it there as well. Do not delete state while either app-server is running.

## 2. Install v0.3 and stage only supported values

Install the verified v0.3 Release using the [installation guide](installation.md), not `qiyan-bot --update`. Set `old_home` to the old resolved QiYan home and `old_data_dir` to the old resolved `DATA_DIR`; obtain those paths from the stopped service configuration. The defaults are shown below. If the old installation used external `ASSISTANT_WORKDIR` or `SESSION_REGISTRY_PATH`, leave those old locations stopped and inert; do not copy their overrides into v0.3.

Run all remaining command blocks in the same shell so the fail-fast setting and staged hash variables remain available. Create a temporary owner-only directory outside both the old and new QiYan homes:

```bash
set -euo pipefail
old_home="$HOME/.qiyan-bot"       # replace if the old QIYAN_HOME was custom
old_data_dir="$old_home/data"     # replace if the old DATA_DIR was custom
new_home="$HOME/.qiyan-bot"
stage=$(mktemp -d "$HOME/.qiyan-v03-cutover.XXXXXX")
chmod 700 "$stage"
```

Set `old_config` to the old private `.env` or stopped service `EnvironmentFile`. The following fail-fast block validates the source descriptor and writes a new mode-0600 dotenv containing only adapter values and still-valid non-path settings. It deliberately drops `QIYAN_HOME`, `ASSISTANT_WORKDIR`, `DATA_DIR`, and `SESSION_REGISTRY_PATH` so incompatible external state cannot be reopened.

```bash
set -euo pipefail
old_config="$old_home/.env"       # replace with the old EnvironmentFile if needed
test -f "$old_config" && test ! -L "$old_config"
test "$(stat -c %u "$old_config")" = "$(id -u)"
test $(( 8#$(stat -c %a "$old_config") & 077 )) -eq 0
SOURCE_CONFIG="$old_config" STAGED_ENV="$stage/.env" node <<'NODE'
const fs = require("node:fs");
const { parseEnv } = require("node:util");
const retained = [
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_ID", "TELEGRAM_DESTINATION_CHAT_ID",
  "CODEX_BINARY", "MAX_CONCURRENT_TURNS", "MAX_COLLECT_COUNT", "MCP_HOST", "MCP_PORT",
  "ATTACHMENT_MAX_BYTES", "ATTACHMENT_STORE_MAX_BYTES", "ASSISTANT_SANDBOX_MODE",
];
const values = parseEnv(fs.readFileSync(process.env.SOURCE_CONFIG, "utf8"));
for (const key of retained.slice(0, 3)) if (!values[key]) throw new Error(`missing ${key}`);
const body = retained.filter((key) => values[key] !== undefined)
  .map((key) => `${key}=${JSON.stringify(values[key])}`).join("\n") + "\n";
fs.writeFileSync(process.env.STAGED_ENV, body, { flag: "wx", mode: 0o600 });
NODE
staged_env_sha=$(sha256sum "$stage/.env" | cut -d' ' -f1)
```

To retain the isolated assistant login, apply the same checks to its own auth file and stage it. Skip this block if the file is absent or if you prefer to authenticate again.

```bash
set -euo pipefail
old_auth="$old_data_dir/assistant-profile/codex/auth.json"
if test -e "$old_auth"; then
  test -f "$old_auth" && test ! -L "$old_auth"
  test "$(stat -c %u "$old_auth")" = "$(id -u)"
  test $(( 8#$(stat -c %a "$old_auth") & 077 )) -eq 0
  test "$(stat -c %s "$old_auth")" -le 1048576
  install -m 600 "$old_auth" "$stage/auth.json"
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$stage/auth.json"
  staged_auth_sha=$(sha256sum "$stage/auth.json" | cut -d' ' -f1)
fi
```

Abort on any failed check. Do not substitute a symlink, directory, normal Codex auth file, or unvalidated backup. Before deleting anything, run the actual v0.3 production configuration loader against staging:

```bash
set -euo pipefail
env -i HOME="$HOME" PATH="$PATH" qiyan-bot config-check --home "$stage"
test "$(sha256sum "$stage/.env" | cut -d' ' -f1)" = "$staged_env_sha"
```

## 3. Replace state and validate again

Only after staging passes, remove the old QiYan home and the new default target, then create the fresh private layout. If the old installation used external state directories, they may be deleted separately after you verify their exact resolved paths; v0.3 will not reference them because every path override was dropped.

```bash
set -euo pipefail
rm -rf -- "$old_home"
if test "$new_home" != "$old_home"; then rm -rf -- "$new_home"; fi
install -d -m 700 "$new_home" "$new_home/qiyan-workdir" "$new_home/data"
install -m 600 "$stage/.env" "$new_home/.env"
test "$(sha256sum "$new_home/.env" | cut -d' ' -f1)" = "$staged_env_sha"

if test -f "$stage/auth.json"; then
  install -d -m 700 "$new_home/data/assistant-profile" \
    "$new_home/data/assistant-profile/home" \
    "$new_home/data/assistant-profile/codex"
  install -m 600 "$stage/auth.json" \
    "$new_home/data/assistant-profile/codex/auth.json"
  test "$staged_auth_sha" = \
    "$(sha256sum "$new_home/data/assistant-profile/codex/auth.json" | cut -d' ' -f1)"
fi

env -i HOME="$HOME" PATH="$PATH" qiyan-bot config-check --home "$new_home"
```

If authentication was not retained, or if Codex rejects it, run `qiyan-bot assistant-login --home "$new_home"` while QiYan is stopped. Reauthentication is always a user decision; QiYan never copies credentials automatically.

## 4. Install a clean user service

Use a unit that fixes both the working directory and QiYan home, reads secrets only through QiYan's private `.env`, and removes inherited configuration that could redirect state:

```bash
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/qiyan-bot.service" <<'EOF'
[Unit]
Description=QiYan personal assistant
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/.qiyan-bot/qiyan-workdir
ExecStart=%h/.local/bin/qiyan-bot --home %h/.qiyan-bot
UnsetEnvironment=QIYAN_HOME TELEGRAM_BOT_TOKEN TELEGRAM_OWNER_ID TELEGRAM_DESTINATION_CHAT_ID ASSISTANT_WORKDIR DATA_DIR SESSION_REGISTRY_PATH CODEX_BINARY MAX_CONCURRENT_TURNS MAX_COLLECT_COUNT MCP_HOST MCP_PORT ATTACHMENT_MAX_BYTES ATTACHMENT_STORE_MAX_BYTES ASSISTANT_SANDBOX_MODE QIYAN_BOT_MCP_TOKEN
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now qiyan-bot.service
systemctl --user status qiyan-bot.service
```

Do not add `EnvironmentFile=`. If your executable is installed elsewhere, replace only the absolute `ExecStart` executable path. Keep `--home`, `WorkingDirectory`, and the private `.env` paths consistent.

After the service is healthy and a Telegram round trip succeeds, remove the temporary staging directory:

```bash
rm -rf -- "$stage"
```

The old managed sessions are intentionally not adopted automatically. Ask QiYan to list native Codex sessions and explicitly adopt only the ones you want it to manage.
