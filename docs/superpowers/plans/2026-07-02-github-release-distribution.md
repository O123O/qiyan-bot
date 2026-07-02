# GitHub Release Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a runtime-only GitHub Release package, safe `--update`/`--version` commands, a no-Git source-build fallback, and focused installation/setup/chat-adapter guides.

**Architecture:** Keep package discovery and update execution in one dependency-injectable module that runs before bot configuration. Derive the user npm prefix from the installed Linux package layout, launch npm without a shell or secret environment, and leave process restart to the operator. Build releases from version tags with the existing npm pack pipeline and document implemented versus planned adapters explicitly.

**Tech Stack:** TypeScript, Node.js 24, npm package/bin, esbuild, Node test runner, GitHub Actions and GitHub CLI

---

### Task 1: Package metadata and CLI commands

**Files:**
- Create: `src/distribution/package-info.ts`
- Modify: `src/cli.ts`
- Modify: `src/main.ts`
- Test: `tests/distribution/package-info.test.ts`
- Test: `tests/cli.test.ts`
- Test: `tests/bin.test.ts`

- [ ] **Step 1: Write failing package discovery and CLI tests**

Create temporary package layouts and assert that `readPackageInfo(moduleUrl)` walks upward to a manifest with exactly the expected package name and a SemVer-like version, while missing/wrong manifests produce a stable `CONFIGURATION_ERROR`. Extend `tests/cli.test.ts` with:

```ts
assert.deepEqual(parseCliArgs(["--version"]), { command: "version" });
assert.deepEqual(parseCliArgs(["--update"]), { command: "update" });
assert.throws(() => parseCliArgs(["--version", "--workdir", "x"]), /unknown argument/);
assert.throws(() => parseCliArgs(["--update", "--version"]), /unknown argument/);
```

Extend the installed-package smoke test to run `codex-bot --version` with no bot environment and expect `0.1.0\n`.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
npm test -- tests/distribution/package-info.test.ts tests/cli.test.ts tests/bin.test.ts
```

Expected: failure because the package-info module and CLI command variants do not exist.

- [ ] **Step 3: Implement package discovery and early CLI dispatch**

Define:

```ts
export interface PackageInfo { root: string; name: "codex-chat-bot"; version: string }
export async function readPackageInfo(moduleUrl?: string): Promise<PackageInfo>;
```

Walk from the module file's directory to the filesystem root, parse `package.json` without module caching, and accept only `name === "codex-chat-bot"` with a nonempty version. Add exclusive `{ command: "version" }` and `{ command: "update" }` variants to `CliCommand`. In `main()`, print the discovered version and return before `loadConfig` for `--version`; reserve the early `--update` branch for Task 2.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the Step 2 command. Expected: package discovery, CLI, and binary package tests pass.

- [ ] **Step 5: Commit the command boundary**

```bash
git add src/distribution/package-info.ts src/cli.ts src/main.ts tests/distribution/package-info.test.ts tests/cli.test.ts tests/bin.test.ts
git commit -m "feat: expose package version command"
```

### Task 2: Safe latest-Release updater

**Files:**
- Create: `src/distribution/update.ts`
- Modify: `src/main.ts`
- Test: `tests/distribution/update.test.ts`
- Test: `tests/bin.test.ts`

- [ ] **Step 1: Write failing updater layout and environment tests**

Test the public boundary:

```ts
export const LATEST_RELEASE_URL: string;
export function globalPrefixForPackage(packageRoot: string): string;
export function buildUpdateEnvironment(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export async function updateFromLatestRelease(options?: UpdateOptions): Promise<{ version: string; prefix: string }>;
```

Use temporary `<prefix>/lib/node_modules/codex-chat-bot` fixtures. Assert exact prefix derivation; reject source, local `node_modules`, wrong package-name, and malformed layouts. Feed an environment containing PATH/HOME/locale/proxy/CA settings plus Telegram, OpenAI, Codex, MCP, npm-token, and arbitrary secrets. Assert only the documented operational allowlist survives.

Inject a fake child runner and assert the call is exactly:

```ts
["install", "--global", "--prefix", prefix,
 "--ignore-scripts", "--no-audit", "--no-fund", LATEST_RELEASE_URL]
```

Assert `shell` is absent/false, stdio is inherited, status/signal/start errors are safely wrapped, and a successful fake update re-reads the manifest version.

- [ ] **Step 2: Run updater tests and confirm RED**

```bash
npm test -- tests/distribution/update.test.ts
```

Expected: failure because `src/distribution/update.ts` is missing.

- [ ] **Step 3: Implement prefix detection, allowlisting, and child execution**

Require the exact resolved suffix `lib/node_modules/codex-chat-bot`. Build a fresh environment containing only PATH, HOME, USER, LOGNAME, SHELL, TMPDIR/TMP/TEMP, LANG, TERM, locale keys, upper/lower proxy keys, SSL certificate paths, and `NODE_EXTRA_CA_CERTS`. Spawn `npm` directly, listen for `error` and `exit`, and convert nonzero/signal outcomes to an `AppError("CONFIGURATION_ERROR", ...)` that contains no child environment or source error text.

After success, re-read package metadata and return its version and detected prefix. In `main()`, execute this branch before `loadConfig`, then print:

```text
Updated codex-bot to <version> in <prefix>.
Restart any running codex-bot process to use this version.
```

- [ ] **Step 4: Add an installed-binary updater smoke test**

In `tests/bin.test.ts`, place a fake executable named `npm` first in `PATH`, install the packed bot in the standard `<prefix>/lib/node_modules` global layout, and invoke its `.bin/codex-bot --update` without Telegram/Codex variables. The fake npm records argv and selected environment keys to private temporary files. Assert exact arguments, absence of sentinel bot/Codex secrets, and the restart notice.

- [ ] **Step 5: Run focused tests and confirm GREEN**

```bash
npm test -- tests/distribution/update.test.ts tests/bin.test.ts tests/cli.test.ts
```

Expected: all focused tests pass with no warnings.

- [ ] **Step 6: Commit the updater**

```bash
git add src/distribution/update.ts src/main.ts tests/distribution/update.test.ts tests/bin.test.ts
git commit -m "feat: update from latest GitHub release"
```

### Task 3: Version-tagged GitHub Release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `tests/distribution/release-workflow.test.ts`

- [ ] **Step 1: Write a failing workflow contract test**

Read `.github/workflows/release.yml` as text and assert it contains the `v*` tag trigger, `contents: write`, Node 24 setup, `npm ci`, a tag-versus-package-version guard, `npm run check`, `npm pack`, the normalized `codex-bot.tgz` filename, and `gh release upload --clobber`. Assert it contains neither `npm publish` nor npm-token variables.

- [ ] **Step 2: Run the workflow test and confirm RED**

```bash
npm test -- tests/distribution/release-workflow.test.ts
```

Expected: ENOENT for the missing workflow.

- [ ] **Step 3: Implement the least-privilege workflow**

Create a tag-only workflow with one Ubuntu job. Checkout, set up Node 24 with npm cache, run `npm ci`, compare `GITHUB_REF_NAME` with `v$(node -p "require('./package.json').version")`, run `npm run check`, pack into a temporary filename, move it to `codex-bot.tgz`, inspect the final archive for the executable/assets and forbidden source/dependency paths, create the GitHub Release if absent, and upload the asset with `--clobber` using `GH_TOKEN: ${{ github.token }}`.

- [ ] **Step 4: Run the workflow test and confirm GREEN**

Run the Step 2 command. Expected: pass.

- [ ] **Step 5: Commit release automation**

```bash
git add .github/workflows/release.yml tests/distribution/release-workflow.test.ts
git commit -m "ci: publish versioned GitHub release package"
```

### Task 4: Installation and chat-adapter tutorials

**Files:**
- Create: `docs/installation.md`
- Create: `docs/setup.md`
- Create: `docs/chat-apps/telegram.md`
- Create: `docs/chat-apps/slack.md`
- Create: `docs/chat-apps/wechat.md`
- Modify: `README.md`
- Create: `tests/docs.test.ts`

- [ ] **Step 1: Write failing documentation contract tests**

Assert every README relative documentation link resolves. Assert the installation guide contains the latest-Release URL, `$HOME/.local`, source `main.tar.gz`, `npm ci`, `npm pack`, `--update`, and `--version`. Assert Telegram is labeled implemented and includes BotFather, numeric owner ID, private destination equality, coordinator login, start, and smoke-test instructions. Assert Slack and WeChat each contain both `Planned` and `not implemented` and contain no token/configuration recipe.

- [ ] **Step 2: Run documentation tests and confirm RED**

```bash
npm test -- tests/docs.test.ts
```

Expected: failure because the guides are absent.

- [ ] **Step 3: Write the focused guides and README quick start**

Lead the README with the Release install command and links. Preserve the existing architecture, security, operation, recovery, and troubleshooting reference; replace the old local-source-only installation section with short links. Put the complete no-Git extraction/build sequence in `docs/installation.md`, including `trap` cleanup and the statement that a Release must exist before the latest URL works. Never place real credentials in examples.

Put shared profile/state configuration in `docs/setup.md`. Put Telegram-specific BotFather/owner-ID/private-chat steps and a basic coordinator/project-session/attachment smoke test in the Telegram guide. Keep Slack and WeChat as short, explicit roadmap stubs.

- [ ] **Step 4: Run documentation tests and confirm GREEN**

Run the Step 2 command. Expected: pass.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/installation.md docs/setup.md docs/chat-apps tests/docs.test.ts
git commit -m "docs: add install and chat app tutorials"
```

### Task 5: End-to-end packaging verification and integration

**Files:**
- Modify only files required by failures discovered through the red-green cycle

- [ ] **Step 1: Run the complete repository check**

```bash
npm run check
git diff --check
```

Expected: typecheck and all tests pass; no whitespace errors.

- [ ] **Step 2: Exercise the Release artifact in a temporary global prefix**

Pack the repository, rename the result to `codex-bot.tgz`, install with:

```bash
npm install --global --prefix "$release_prefix" ./codex-bot.tgz
"$release_prefix/bin/codex-bot" --version
```

Expected: `0.1.0`, no installed production dependency tree, and no source files.

- [ ] **Step 3: Exercise a no-Git source snapshot**

Create a tar archive from tracked source bytes while excluding `.git`, `.worktrees`, `node_modules`, and `dist`; extract with `--strip-components=1`; run `npm ci`, `npm pack --silent`, install the resulting package into another temporary global prefix, and run its `codex-bot --version`. Expected: `0.1.0` and the same runtime-only installed file set.

- [ ] **Step 4: Self-review against the approved design**

Check every design section against the diff: both install paths, source-archive warning, version/update-before-config behavior, exact prefix derivation, secret-free child environment, no implicit restart, tag/version matching, runtime-only release, docs split, and planned-provider labels. Inspect `git diff main...HEAD` and fix any gap test-first.

- [ ] **Step 5: Merge, reinstall, restart, and push**

After fresh verification, merge the feature branch into `main`, pack/install it under the existing `$HOME/.local` prefix, and gracefully restart the existing bot without printing its environment. Verify one bot process and its two app-server children. Push `main` to `origin`.

Do not create a version tag or GitHub Release in this task. Report that the new public install URL becomes usable after the first separately authorized version release.
