# GitHub Release Distribution Design

## Goal

Make `codex-bot` installable without a Git checkout or a runtime dependency tree, provide an explicit self-update command, and document setup per chat adapter. npm publication remains deferred; GitHub Releases are the authoritative binary-package channel for now.

## Supported installation paths

The primary path installs a prebuilt npm package tarball attached to the latest GitHub Release:

```bash
npm install --global \
  --prefix "$HOME/.local" \
  https://github.com/O123O/codex-bot/releases/latest/download/codex-bot.tgz
```

The release asset is the output of `npm pack`, renamed to the stable asset name `codex-bot.tgz`. It contains the bundled `dist/codex-bot` command, coordinator assets, README, and package metadata. It contains no TypeScript source and installs no production dependency tree.

The fallback path needs neither Git nor a prebuilt Release. It downloads GitHub's source archive into a temporary directory, runs `npm ci`, creates the same runtime-only package with `npm pack`, and installs that local package globally. The temporary build does require the Node development dependencies and network access to the npm registry. Directly installing the GitHub source archive is unsupported because `dist/` is intentionally ignored and the source archive cannot build itself during a global install without development dependencies.

Both paths target Linux, Node.js 24 or newer, and a user-owned prefix. `$HOME/.local/bin` must be on `PATH`.

## CLI update and version commands

`codex-bot --version` prints the package version and exits before bot configuration is loaded.

`codex-bot --update` installs the stable latest-Release URL into the prefix that owns the running executable. It exits before Telegram or Codex configuration is loaded. On this Linux-only release, a valid installed package has the layout:

```text
<prefix>/lib/node_modules/codex-chat-bot/dist/codex-bot
```

The updater locates the nearest `package.json`, verifies the package name, requires that exact global layout, and derives `<prefix>` from it. It never uses `npm prefix --global`, because that value may differ from the prefix of the installed command. A source checkout or any ambiguous layout is rejected with an actionable error instead of updating a guessed location.

The child command is equivalent to:

```bash
npm install --global --prefix <detected-prefix> \
  --ignore-scripts --no-audit --no-fund \
  https://github.com/O123O/codex-bot/releases/latest/download/codex-bot.tgz
```

Arguments are passed directly rather than through a shell. The npm child inherits only a small operational allowlist: executable lookup, home/user identity, temporary-directory settings, locale, proxy settings, and CA-certificate settings. Telegram, Codex, OpenAI, MCP, npm-token, and unrelated environment values are not forwarded. npm output remains attached to the terminal.

A successful update prints the installed version and says that any running bot process must be restarted. It does not restart, signal, or discover bot processes. npm failures become stable structural errors and do not expose environment values.

## Release automation

A GitHub Actions workflow runs for tags matching `v*`. It uses Node.js 24, installs exactly the lockfile with `npm ci`, verifies the tag equals `v` plus `package.json`'s version, runs `npm run check`, and creates the package with `npm pack`. Before publication it verifies that the archive contains the expected bundled runtime files and no source or dependency tree. It copies the generated archive to `codex-bot.tgz` and attaches that asset to the tag's GitHub Release.

The workflow has only `contents: write` permission. It does not publish to npm, consume npm credentials, or mutate package versions. A release maintainer must update `package.json` and `package-lock.json`, merge that change, then create the matching version tag. Re-running a tag workflow replaces only the normalized release asset through the release action's documented behavior.

## Documentation layout

The root README provides the shortest supported install and start path and links to focused guides:

- `docs/installation.md`: latest Release install, no-Git source build, updating, version checks, PATH, and release availability;
- `docs/setup.md`: shared Codex/coordinator profile, state paths, safety model, startup, backup, and troubleshooting;
- `docs/chat-apps/telegram.md`: BotFather token creation, owner-ID discovery, private-chat configuration, start, and a functional smoke test;
- `docs/chat-apps/slack.md` and `docs/chat-apps/wechat.md`: explicit roadmap pages stating that no adapter is implemented yet.

Provider documentation must never imply that Slack or WeChat can already be configured. Secret examples use placeholders and discourage command-history or repository storage.

## Verification

Unit tests cover CLI exclusivity, version output, package-root discovery, global-prefix validation, the exact npm arguments, environment allowlisting, child failure, and restart guidance. Package tests continue to prove that the packed artifact contains only runtime files and that its installed command runs without source or production dependencies.

A release-workflow test checks the tag trigger, restricted permission, Node version, lockfile install, full check, tag/version guard, normalized asset name, and absence of npm publication. Documentation link tests verify that the README's guide targets exist and that planned adapters are labeled unavailable.

Before merge, two real install exercises are required in temporary prefixes:

1. pack the current tree as the Release artifact, install it from the tarball, and run `codex-bot --version`;
2. construct/extract a source snapshot without `dist` or `node_modules`, run `npm ci`, `npm pack`, install the result, and run the installed command.

No real GitHub Release or version tag is created as part of implementation. That is a separate externally visible release action after the code is merged and reviewed.
