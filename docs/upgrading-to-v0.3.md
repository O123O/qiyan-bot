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

Set `old_config` to the old private `.env` or stopped service `EnvironmentFile`. The following fail-fast block opens it once with no-follow semantics, validates that descriptor, and writes a new mode-0600 dotenv containing only adapter values and still-valid non-path settings. It deliberately drops `QIYAN_HOME`, `ASSISTANT_WORKDIR`, `DATA_DIR`, and `SESSION_REGISTRY_PATH` so incompatible external state cannot be reopened.

```bash
set -euo pipefail
old_config="$old_home/.env"       # replace with the old EnvironmentFile if needed
SOURCE_CONFIG="$old_config" STAGED_ENV="$stage/.env" node <<'NODE'
const fs = require("node:fs");
const { parseEnv } = require("node:util");
const retained = [
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_ID", "TELEGRAM_DESTINATION_CHAT_ID",
  "CODEX_BINARY", "MAX_CONCURRENT_TURNS", "MAX_COLLECT_COUNT", "MCP_HOST", "MCP_PORT",
  "ATTACHMENT_MAX_BYTES", "ATTACHMENT_STORE_MAX_BYTES", "ASSISTANT_SANDBOX_MODE",
];
const fd = fs.openSync(process.env.SOURCE_CONFIG,
  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
let contents;
try {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 65536) {
    throw new Error("old configuration is not a private current-user regular file");
  }
  contents = fs.readFileSync(fd, "utf8");
} finally {
  fs.closeSync(fd);
}
const values = parseEnv(contents);
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
  SOURCE_AUTH="$old_auth" STAGED_AUTH="$stage/auth.json" node <<'NODE'
const fs = require("node:fs");
const fd = fs.openSync(process.env.SOURCE_AUTH,
  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
let bytes;
try {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 1048576) {
    throw new Error("old auth is not a private current-user regular file");
  }
  bytes = fs.readFileSync(fd);
} finally {
  fs.closeSync(fd);
}
JSON.parse(bytes.toString("utf8"));
fs.writeFileSync(process.env.STAGED_AUTH, bytes, { flag: "wx", mode: 0o600 });
NODE
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

First run this mandatory path gate. It rejects symlink aliases, `/`, the user home, non-private or foreign directories, a modified new-home target, and any overlap among distinct old home, new home, and staging paths:

```bash
set -euo pipefail
OLD_HOME="$old_home" NEW_HOME="$new_home" STAGE="$stage" USER_HOME="$HOME" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const uid = process.getuid();
function realDirectory(label, input, requirePrivate = false) {
  const resolved = path.resolve(input);
  if (input !== resolved) throw new Error(`${label} must use its exact absolute normalized path`);
  const value = fs.lstatSync(resolved);
  if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== uid || (requirePrivate && (value.mode & 0o077) !== 0)) {
    throw new Error(`${label} must be a${requirePrivate ? " private" : ""} current-user real directory`);
  }
  const canonical = fs.realpathSync(resolved);
  if (canonical !== resolved) throw new Error(`${label} must use its exact canonical path without a symlink alias`);
  return canonical;
}
function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function overlaps(left, right) { return contains(left, right) || contains(right, left); }
const home = realDirectory("HOME", process.env.USER_HOME);
const oldHome = realDirectory("old_home", process.env.OLD_HOME, true);
const stage = realDirectory("stage", process.env.STAGE, true);
const requiredNewHome = path.join(home, ".qiyan-bot");
if (process.env.NEW_HOME !== requiredNewHome) throw new Error("new_home must be the exact $HOME/.qiyan-bot path");
let newHome = requiredNewHome;
if (fs.existsSync(requiredNewHome)) newHome = realDirectory("new_home", requiredNewHome, true);
if (oldHome === path.parse(oldHome).root || oldHome === home || contains(oldHome, home)) {
  throw new Error("old_home cannot be a filesystem root, HOME, or an ancestor of HOME");
}
if (overlaps(stage, oldHome) || overlaps(stage, newHome)) throw new Error("staging must be outside both QiYan homes");
if (oldHome !== newHome && overlaps(oldHome, newHome)) throw new Error("distinct old and new QiYan homes must not overlap");
NODE

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
UnsetEnvironment=QIYAN_HOME TELEGRAM_BOT_TOKEN TELEGRAM_OWNER_ID TELEGRAM_DESTINATION_CHAT_ID SLACK_APP_TOKEN SLACK_BOT_TOKEN SLACK_USER_TOKEN SLACK_TEAM_ID SLACK_OWNER_USER_ID PRIMARY_CHAT_APP ASSISTANT_WORKDIR DATA_DIR SESSION_REGISTRY_PATH CODEX_BINARY MAX_CONCURRENT_TURNS MAX_COLLECT_COUNT MCP_HOST MCP_PORT ATTACHMENT_MAX_BYTES ATTACHMENT_STORE_MAX_BYTES ASSISTANT_SANDBOX_MODE QIYAN_BOT_MCP_TOKEN
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
