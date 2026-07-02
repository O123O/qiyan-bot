# QiYan Bot Hard-Rename and Assistant Workspace Design

## Goal

Turn the project into **QiYan Bot**, a single-user, self-hosted general assistant powered by Codex. The assistant can answer directly, work across the user's filesystem, and manage ordinary Codex project sessions when delegation is useful. Telegram is the first implemented chat adapter, not the product identity.

This is an intentional pre-user hard cutover. No deprecated executable, environment variable, state schema, profile path, package name, or internal `coordinator` alias remains. The current development deployment starts with fresh QiYan state after its old state is backed up.

## Canonical identity

- Display name: `QiYan Bot`
- GitHub repository: `O123O/qiyan-bot`
- npm package name: `qiyan-bot`
- installed executable: `qiyan-bot`
- next release: `v0.2.0`
- internal role name: `assistant`
- login command: `qiyan-bot assistant-login`
- assistant workdir variable: `ASSISTANT_WORKDIR`
- assistant sandbox variable: `ASSISTANT_SANDBOX_MODE`
- default data directory: `$HOME/.qiyan-bot/data`
- default session registry: `$HOME/.qiyan-bot/data/sessions.json`
- default assistant workdir: `$HOME/.qiyan-bot/assistant`
- default delegated-project root: `$HOME/qiyan-bot-projects`

The generic `--workdir` option remains and overrides `ASSISTANT_WORKDIR`. `DATA_DIR` and `SESSION_REGISTRY_PATH` remain generic configuration names, but their defaults move below `$HOME/.qiyan-bot`. All package assets, source directories, classes, functions, endpoint IDs, MCP identifiers, registry fields, dashboard terminology, active documentation, tests, and user-facing errors use `assistant` or `qiyan-bot` instead of the old role/product names.

Historical design and implementation records under `docs/superpowers` remain immutable records of earlier architecture. New active docs and runtime code do not direct users to the old product name.

## Assistant execution model

The assistant remains an ordinary persistent Codex thread on its own dedicated local app-server. It retains an independent operating-system `HOME`, `CODEX_HOME`, authentication, configuration, skills, and thread store under `<DATA_DIR>/assistant-profile`. This prevents accidental inheritance of the project worker profile.

The assistant defaults to:

```text
approvalPolicy: never
sandbox: danger-full-access
```

`ASSISTANT_SANDBOX_MODE` may reduce the sandbox to `workspace-write` or `read-only`, but defaults to `danger-full-access`. Approval policy is always `never` because supported chat adapters have no interactive Codex approval UI.

The README, setup guide, example environment, startup warning, and managed assistant policy state plainly that the default assistant can read, create, modify, execute, and delete anything accessible to the operating-system user. Separate profile directories prevent implicit configuration inheritance; they are not a filesystem security boundary once danger-full-access is enabled. The assistant must use typed QiYan management tools rather than directly editing bot-owned database, registry, dashboard, profile, or policy files.

## Project worker execution model

Project app-servers run with the account runner's real `HOME` and `CODEX_HOME`. Their child environment inherits the runner environment except for a narrow denylist owned by QiYan: Telegram credentials, the QiYan management MCP bearer token, and assistant-only internal credentials. Arbitrary user variables, provider credentials, proxy/CA configuration, and user MCP variables survive. Assistant-profile environment construction remains separate.

QiYan does not supply project-thread `approvalPolicy`, `sandbox`, or per-thread shell-policy configuration during create, resume, attach, recovery, or work turns. Codex reads the user's normal home configuration, skills, MCP definitions, and relevant environment as it would for a manually started project app-server, except for the explicitly denied QiYan/chat secrets.

QiYan cannot approve a worker request through chat. Endpoint approval callbacks continue to decline requests safely and produce a visible `PERMISSION_BLOCKED` result. Active documentation therefore says project workers are supported only when the user's Codex configuration is suitable for automatic, non-interactive operation. QiYan neither rewrites that configuration nor silently changes a worker's requested security policy.

## Management MCP authorization boundary

Renaming does not weaken the existing manager-tool boundary. The QiYan management MCP server:

- binds only to IPv4 loopback;
- requires a fresh random bearer token;
- authorizes the exact attested assistant app-server process using PID, Linux process start time, and the complete live socket tuple;
- rejects unrelated workers, stale/replaced endpoint generations, and token-bearing descendants of the assistant process;
- exposes the renamed management MCP configuration only to the assistant app-server; and
- excludes `QIYAN_BOT_MCP_TOKEN` from every model-launched shell environment and all logs.

The bearer token is necessary but insufficient. This matters after the assistant receives danger-full-access: same-user processes may be able to inspect `/proc`, but possession of copied environment bytes does not grant management-tool access without the exact authorized process/socket identity.

## Direct work versus delegated sessions

The managed `AGENTS.md` presents the primary role as general assistant, with project-session management as one capability:

- answer questions and perform small, personal, or cross-project filesystem tasks directly when delegation adds no value;
- use an ordinary project worker for sustained coding, a repository-specific task, isolated project context, parallel work, or when the user explicitly requests a session;
- never create, adopt, register, attach, or root a project worker in the assistant workdir or bot-owned state;
- do not use the assistant workdir as a convenient default merely because it is the assistant thread's current directory.

The automatic-delivery, compact metadata, read-only dashboard/registry, supervision, goal, exact `/pass`, exact `/collect`, and attachment rules remain intact. Examples remain concentrated on the exceptional exact-directive behavior; ordinary tool schemas describe ordinary calls.

## Delegated project-directory selection

`create_session.project_dir` becomes optional. The backend, not the model, supplies a safe fallback and creates missing directories.

Directory selection follows this order:

1. If the user names an existing project or explicit path, use that path.
2. If the task has an obvious personal file category and the user asked for a new session, use a task-specific directory such as `~/Documents/<task-slug>`.
3. For new coding or project work, prefer a clear project-specific directory under a location selected by the user or assistant.
4. If no location is reasonably implied, omit `project_dir`; the backend creates `~/qiyan-bot-projects/<nickname>`.

The backend expands only a leading `~/` against the account runner's real home, never the assistant's isolated `HOME`. Absolute paths are accepted. Other relative paths are rejected so launch-directory changes cannot redirect a project. Nicknames become safe single path segments: lowercase ASCII letters or digits first, followed by lowercase ASCII letters, digits, `_`, or `-`, with a 64-character maximum.

For `create_session`, the backend validates a projected canonical path through its nearest existing ancestor, rejects protected overlap, creates a missing directory recursively with owner-only permissions, resolves the final canonical directory, validates again, then starts the Codex thread. If directory creation succeeds but thread creation becomes uncertain, the directory remains; QiYan does not delete a path that may have acquired user data.

`register_session` and `adopt_session` require an existing canonical directory and apply the same protected-overlap rule. Discovery may show a protected thread, but it cannot be adopted as a project worker.

## Protected path policy

A project root is rejected when it is equal to, contains, or is contained by any of:

- the canonical assistant workdir;
- the canonical data directory, including the assistant profile and database;
- the canonical session-registry path or its containing QiYan-owned directory when configured separately.

Independently of where QiYan state is configured, a project root is also rejected when it equals or is an ancestor of the runner's canonical real home. Descendants such as `~/Documents/report` remain allowed. Filesystem root, the exact real home, and any parent of that home are therefore always invalid project roots.

Checks run lexically, against the projected canonical path through the nearest existing ancestor, after directory creation, and immediately before thread dispatch. They account for existing symlink aliases and revalidate after directory creation. This prevents accidental project roots such as `/`, `$HOME`, the assistant directory, or a parent containing all QiYan state. It is an application-level placement guard, not an operating-system security boundary: a worker configured by the user with unrestricted filesystem access can still deliberately reach other user-owned paths.

Path validation failures are proven-no-effect configuration errors before an app-server thread request. Missing-directory creation followed by an uncertain app-server result remains an uncertain operation and is reconciled using the existing operation ledger rules.

## Fresh state and schemas

The registry document replaces its `coordinator` identity with `assistant` and increments its schema version. Assistant contexts, inboxes, dashboard projections, endpoint identifiers, profile receipts, and related database names use assistant terminology. There is no runtime parser or migrator for old QiYan-incompatible state.

For the current development deployment:

1. inspect the live process without printing environment values and capture its effective canonical data, registry, workdir, executable, working directory, and launch mechanism;
2. choose a non-overlapping timestamped backup root below a mode-0700 parent;
3. stop the old bot cleanly and confirm its app-server descendants exit; abort without installing or creating new state if shutdown fails;
4. copy the complete old data directory, external workdir, and separately located registry without dereferencing symlinks or duplicating a registry already contained by data; preserve modes and write a structural backup manifest;
5. verify the manifest, copied roots, and file counts before proceeding; leave that backup untouched and record it for manual rollback;
6. rewrite the actual launcher/service environment to remove old workdir/sandbox variables and use `qiyan-bot`, `ASSISTANT_WORKDIR`, `ASSISTANT_SANDBOX_MODE`, fresh data/registry paths, and the intended working directory; disable any old autostart entry before uninstalling;
7. create fresh `$HOME/.qiyan-bot/data` and `$HOME/.qiyan-bot/assistant` state without opening old state under the new schema;
8. uninstall the old npm package and install the verified local `qiyan-bot` release tarball;
9. run `qiyan-bot assistant-login` for a new isolated authentication profile;
10. start exactly one QiYan Bot process from the rewritten launcher and verify only fresh canonical paths are active; then rediscover/adopt any desired normal Codex project threads from the user's unchanged real Codex home.

Authentication is user-controlled. Implementation may launch the new login command, but it does not copy, symlink, or transform the old authentication file.

Rollback is a manual operator action: stop QiYan, restore the old executable/launcher and the complete verified backup together, and do not point either version at the other version's state. Implementation never deletes the backup.

## Repository, package, update, and release cutover

The implementation is completed and verified while the repository still has its current remote name. The local checkout directory is not renamed: Git linked-worktree metadata contains absolute paths, and a local directory name is not product identity. Before remote cutover, remove or resolve stale project-owned linked worktrees, require clean `main`, verify authenticated ownership, confirm that repository slug `O123O/qiyan-bot` is available, and prove that `v0.2.0` is absent locally, remotely, and from Releases.

Immediately before final push/release:

1. use authenticated GitHub CLI to rename the repository to `O123O/qiyan-bot`;
2. update the local `origin` URL to `git@github.com:O123O/qiyan-bot.git` and verify the remote identity;
3. push the reviewed `main` commit;
4. create and push annotated tag `v0.2.0`;
5. watch the Release workflow to completion;
6. verify that pushed `main`, annotated tag, workflow checkout, and release tag all resolve to the reviewed commit SHA;
7. download the public `https://github.com/O123O/qiyan-bot/releases/latest/download/qiyan-bot.tgz` artifact, compare its SHA-256 with the digest published by the GitHub Release asset API, and install that verified local file in a clean prefix.

GitHub Releases are the only package authority in this version; QiYan is not published to the npm registry. Documentation forbids bare `npm install --global qiyan-bot` and always installs the GitHub URL or a downloaded, digest-verified local tarball. The workflow requires the exact `qiyan-bot.tgz` asset and GitHub's asset digest must be present before deployment proceeds.

The package contains only `dist/qiyan-bot`, assistant policy/dashboard assets, README, and package metadata. The updater recognizes only package `qiyan-bot`, derives the owning Linux global prefix, downloads only the new stable QiYan release URL, and prints a restart requirement. Old executables and package names are neither installed nor removed by compatibility code; the one development deployment explicitly uninstalls them.

## Public documentation

The README leads with QiYan Bot as a general-purpose personal assistant. It explains direct assistance, filesystem work, delegation to resumable Codex project sessions, automatic result delivery, and multiple future chat adapters before describing Telegram. Telegram is labeled the currently implemented adapter; Slack and WeChat remain planned.

The README and setup guide place the full-auto warning before installation/start commands. They distinguish:

- assistant default: full filesystem access, `never` approvals;
- workers: unmodified user Codex configuration, with auto/non-interactive operation required because chat approvals are unsupported.

Installation, update, setup, provider guides, examples, troubleshooting, backup paths, command names, environment variables, repository links, release URLs, and package names all use QiYan terminology.

## Verification

Automated tests must prove:

- all canonical QiYan package, binary, command, environment, asset, profile, endpoint, registry, and release names;
- absence of an enumerated retired-identifier denylist from runtime code, active docs, package contents, workflow, and tests. The denylist includes `codex-chat-bot`, `codex-bot`, `.codex-bot`, `COORDINATOR_`, `SANDBOX_MODE`, `CODEX_BOT_`, `coordinator-local`, `codex_bot_manager`, old client/package/binary names, old source/asset/profile paths, old registry fields, and old release URLs;
- the rename scan covers `src`, `assets`, `tests`, `scripts`, `.github`, `.env.example`, `package.json`, `package-lock.json`, `README.md`, and active guides under `docs` except `docs/superpowers`. The entire `docs/superpowers` tree is explicitly archival engineering history, including this transition spec and its implementation plan, and is the only excluded documentation subtree;
- assistant default danger-full-access and `never` approvals, with a lower-sandbox override;
- project thread start/resume/attach/recovery/turn calls contain no QiYan-supplied approval, sandbox, or shell-policy overrides;
- arbitrary runner and user-MCP environment sentinels survive in workers while Telegram and assistant MCP secrets remain absent;
- loopback-only management MCP rejects ordinary workers, bearer-only callers, token-bearing assistant descendants, stale endpoint identities, and incomplete socket-tuple matches while accepting only the exact attested assistant app-server process;
- optional `project_dir`, real-home `~/` expansion, absolute-path enforcement, safe fallback naming, directory creation, and owner-only mode;
- rejection of `/`, exact real home, parents of real home, equal/parent/child protected paths, and symlink aliases before thread dispatch even when QiYan state is configured outside home;
- register/adopt rejection for protected directories;
- managed policy rules for general direct assistance, deliberate delegation, semantic/fallback directories, and no assistant-workdir workers;
- general-assistant README positioning and the two full-auto warnings;
- runtime-only package filename and contents, `qiyan-bot --version`, secret-free `qiyan-bot --update`, and absence of retired identifiers inside both archive paths and file bytes;
- exact GitHub asset name, nonempty published SHA-256 digest, digest verification before local-file installation, and installed manifest name/version/executable;
- fresh-state production startup with registry/database schema using assistant terminology.

Before merge, run the complete unit/integration suite and the real app-server tests. After repository rename and release, download the stable latest asset, verify its published digest, install it into a clean global prefix, and run `qiyan-bot --version`. The live development bot is restarted only after the user completes the fresh `assistant-login` flow.
