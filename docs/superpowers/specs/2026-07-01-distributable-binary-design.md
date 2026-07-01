# Distributable Binary Design

## Goal

Produce a real installable `codex-bot` command that runs from packaged build artifacts without TSX, TypeScript source files, repository layout, development dependencies, or a pre-existing `node_modules` directory.

## Distribution artifact

The package exposes `codex-bot` through its `bin` field. The executable is `dist/codex-bot`, an ESM JavaScript bundle with a Node shebang and executable permissions. Esbuild bundles the application and all npm runtime code; Node built-ins remain native. Node 24 or newer and the separately configured Codex executable are the only runtime program requirements.

The bundle continues to resolve the managed coordinator templates relative to its installed package root. The npm package therefore contains only the built executable, `assets/coordinator/AGENTS.md`, `assets/coordinator/session-status.example.json`, package metadata, license/readme material included by npm, and no source or test tree. Shipping two data assets is intentional: they are installed bot-managed templates, not development inputs.

## Build and package metadata

Add esbuild as an explicit development dependency and a deterministic `npm run build` script backed by `scripts/build.mjs`. The build removes stale `dist`, bundles `src/main.ts`, adds the shebang, writes `dist/codex-bot`, and sets mode `0755`.

The package manifest declares the `codex-bot` bin and a restrictive `files` list. Dependencies used only as bundle inputs are development dependencies so installing the packed artifact does not fetch a runtime dependency tree. The normal source-development commands continue to work after `npm install`.

## Verification

An integration test builds and packs the package into a temporary directory, extracts it, and verifies:

- the archive contains the executable and two coordinator assets;
- it excludes `src`, `tests`, and development tooling;
- the executable has a shebang and executable mode; and
- invoking it with an invalid CLI argument returns the stable structural startup error while no `node_modules` directory exists beside it.

The full repository check also runs the package smoke test. The checked-in `dist` directory remains ignored and is rebuilt from source.

## Live restart

After build, pack verification, and code review, install the local package command with `npm link`. Back up the configured data directory, registry, and coordinator workdir while the bot is stopped. Stop the existing TSX process through its current terminal, then start `codex-bot --workdir ~/.codex-bot/coordinator` in that same terminal so its existing secret environment is reused without printing it.

Startup must complete before the backup is discarded. If startup fails, retain the backup, report the structural error, and do not expose credentials or blindly reset state.
