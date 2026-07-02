# Required fresh cutover to v0.3

This procedure applies to every QiYan installation whose state was created before v0.3.0. v0.3 uses a new database marker and registry generation model. It intentionally does not migrate old managed sessions, operations, assistant history, or generated workspace files.

The cutover is destructive. The only values carried forward are supported adapter configuration and, at your choice, the isolated QiYan assistant profile's own `auth.json`. Never copy or link your normal `~/.codex/auth.json`.

## 1. Stop the whole old process tree

Disable and stop the user service if one exists:

```bash
systemctl --user disable --now qiyan-bot.service
systemctl --user is-active qiyan-bot.service
```

The second command must report `inactive` or `failed`. Confirm that no old `qiyan-bot` process or app-server child remains before continuing. If QiYan was launched from a terminal or another supervisor, stop it there as well. Do not delete state while either app-server is running.

## 2. Stage only configuration and optional isolated authentication

Create a temporary owner-only directory outside `~/.qiyan-bot`:

```bash
stage=$(mktemp -d "$HOME/.qiyan-v03-cutover.XXXXXX")
chmod 700 "$stage"
old_home="$HOME/.qiyan-bot"
```

If the old installation already has a private `.env`, verify that it is a current-user-owned regular file, not a symlink, and has no group/world permissions. Then copy it into staging as mode 0600. If configuration previously came from a service environment, create `$stage/.env` from the supported keys instead; do not carry an old `EnvironmentFile` forward.

```bash
test -f "$old_home/.env" && test ! -L "$old_home/.env"
test "$(stat -c %u "$old_home/.env")" = "$(id -u)"
test $(( 8#$(stat -c %a "$old_home/.env") & 077 )) -eq 0
install -m 600 "$old_home/.env" "$stage/.env"
```

To retain the isolated assistant login, apply the same checks to its own auth file and stage it. Skip this block if the file is absent or if you prefer to authenticate again.

```bash
old_auth="$old_home/data/assistant-profile/codex/auth.json"
if test -e "$old_auth"; then
  test -f "$old_auth" && test ! -L "$old_auth"
  test "$(stat -c %u "$old_auth")" = "$(id -u)"
  test $(( 8#$(stat -c %a "$old_auth") & 077 )) -eq 0
  test "$(stat -c %s "$old_auth")" -le 1048576
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$old_auth"
  install -m 600 "$old_auth" "$stage/auth.json"
fi
```

Abort on any failed check. Do not substitute a symlink, directory, normal Codex auth file, or unvalidated backup.

## 3. Install v0.3, replace state, and validate

Install the verified v0.3 Release using the [installation guide](installation.md). Then remove the old QiYan state and create the fresh private layout:

```bash
rm -rf -- "$old_home"
install -d -m 700 "$old_home" "$old_home/qiyan-workdir" "$old_home/data"
install -m 600 "$stage/.env" "$old_home/.env"

if test -f "$stage/auth.json"; then
  install -d -m 700 "$old_home/data/assistant-profile" \
    "$old_home/data/assistant-profile/home" \
    "$old_home/data/assistant-profile/codex"
  install -m 600 "$stage/auth.json" \
    "$old_home/data/assistant-profile/codex/auth.json"
fi

qiyan-bot config-check --home "$old_home"
```

If authentication was not retained, or if Codex rejects it, run `qiyan-bot assistant-login --home "$old_home"` while QiYan is stopped. Reauthentication is always a user decision; QiYan never copies credentials automatically.

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
UnsetEnvironment=QIYAN_HOME ASSISTANT_WORKDIR DATA_DIR SESSION_REGISTRY_PATH TELEGRAM_BOT_TOKEN TELEGRAM_OWNER_ID TELEGRAM_DESTINATION_CHAT_ID
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
