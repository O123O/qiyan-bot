# Installation

The supported runtime is Linux with Node.js 24 or newer. Install `codex` separately. QiYan packages are published only as GitHub Release assets; there is no supported npm-registry package.

Before installing, understand that the assistant defaults to non-interactive `danger-full-access` with approvals disabled. Workers use your normal Codex policy unchanged and must support automatic operation because chat approvals are unavailable.

## Install the latest GitHub Release

The Release must exist and expose a nonempty GitHub `sha256:` asset digest. Download and verify the asset before npm installs the local file:

```bash
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

curl -fsSL \
  https://github.com/O123O/qiyan-bot/releases/latest/download/qiyan-bot.tgz \
  -o "$workdir/qiyan-bot.tgz"

digest=$(curl -fsSL https://api.github.com/repos/O123O/qiyan-bot/releases/latest |
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const a=JSON.parse(s).assets.find(x=>x.name==="qiyan-bot.tgz");if(!a?.digest)process.exit(1);process.stdout.write(a.digest)})')
test -n "$digest"
test "${digest%%:*}" = sha256
printf '%s  %s\n' "${digest#sha256:}" "$workdir/qiyan-bot.tgz" | sha256sum --check --status

npm install --global --prefix "$HOME/.local" "$workdir/qiyan-bot.tgz"
export PATH="$HOME/.local/bin:$PATH"
qiyan-bot --version
```

Never use bare `npm install -g qiyan-bot`: that asks the npm registry rather than installing the reviewed GitHub asset. The runtime archive contains README, assistant templates, package metadata, and the bundled executable, with no production dependency tree.

## Build from the source archive without Git

This path needs `curl`, `tar`, Node.js 24+, and network access for locked development dependencies. It does not need Git:

```bash
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

curl -fsSL https://github.com/O123O/qiyan-bot/archive/refs/heads/main.tar.gz |
  tar -xz -C "$workdir" --strip-components=1
cd "$workdir"
npm ci
archive=$(npm pack --silent)
npm install --global --prefix "$HOME/.local" "./$archive"
qiyan-bot --version
```

Do not install `main.tar.gz` globally. It is source without `dist/`; `npm ci` and `npm pack` produce the runtime package.

## Update

If the installed version is older than v0.3.0, do **not** use the generic updater and restart against its existing state. v0.3 intentionally rejects that database and registry. Follow the [required fresh v0.3 cutover](upgrading-to-v0.3.md) first.

```bash
qiyan-bot --update
```

The updater locates the Linux global prefix that owns the running executable and installs the latest GitHub Release. It does not need bot/Codex secrets and does not restart a running process. Stop and restart QiYan yourself after success. The updater refuses source checkouts and unfamiliar package layouts.

## Uninstall

```bash
npm uninstall --global --prefix "$HOME/.local" qiyan-bot
```

Uninstalling leaves state and assistant authentication untouched. Continue with [shared setup](setup.md), then the [Telegram adapter](chat-apps/telegram.md).
