# Installation

The supported runtime is Linux with Node.js 24 or newer. The `codex` command must also be installed, but it does not need to be running during installation.

## Install the latest GitHub Release

The normal installation downloads the prebuilt, runtime-only npm package:

```bash
npm install --global \
  --prefix "$HOME/.local" \
  https://github.com/O123O/codex-bot/releases/latest/download/codex-bot.tgz
```

Make the user bin directory available in new and current shells:

```bash
grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.profile" || \
  printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.profile"
export PATH="$HOME/.local/bin:$PATH"
codex-bot --version
```

The archive contains the bundled command and coordinator templates. It does not install TypeScript source, build tools, or production npm dependencies.

The first versioned GitHub Release must exist before the stable `releases/latest/download/codex-bot.tgz` URL works. Until then, use the source-archive path below.

## Build from the source archive without Git

This path needs `curl`, `tar`, Node.js 24+, and network access to download the locked development dependencies. It does not need Git:

```bash
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

curl -fsSL https://github.com/O123O/codex-bot/archive/refs/heads/main.tar.gz |
  tar -xz -C "$workdir" --strip-components=1

cd "$workdir"
npm ci
archive=$(npm pack --silent)
npm install --global --prefix "$HOME/.local" "./$archive"
codex-bot --version
```

Do not pass `main.tar.gz` directly to a global `npm install`. GitHub's archive is a source snapshot: it deliberately has no ignored `dist/` bundle, and a global archive installation does not install the development dependencies needed to build it. `npm ci` followed by `npm pack` creates the same runtime-only package used by Releases.

## Update

For a command installed from a package under a Linux global npm prefix, run:

```bash
codex-bot --update
```

The updater derives the prefix that owns the running executable and installs the latest Release there. It does not need Telegram or Codex configuration, and it does not restart a running bot. After a successful update, stop and restart the existing bot process yourself so in-memory code changes versions cleanly.

The update command intentionally refuses a source checkout or an unfamiliar package layout. Build and install a package first if that happens.

## Uninstall

Removing the package does not remove bot state or coordinator authentication:

```bash
npm uninstall --global --prefix "$HOME/.local" codex-chat-bot
```

State remains in the separately configured data, registry, and coordinator directories until you explicitly remove it.

Continue with [shared setup](setup.md), then configure the [Telegram adapter](chat-apps/telegram.md).
