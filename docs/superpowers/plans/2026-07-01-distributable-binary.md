# Distributable Binary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, pack, install, and run a fully bundled `codex-bot` executable that needs no TypeScript source, TSX, development dependencies, or runtime `node_modules`.

**Architecture:** Split the reusable `main()` function from a single unconditional executable entry, bundle that entry and all npm runtime code with esbuild, and package only the executable plus the two coordinator templates. A pack/extract smoke test executes the installed artifact from an isolated directory without dependencies before the live process is stopped.

**Tech Stack:** TypeScript, Node.js 24, esbuild, npm package/bin, Node test runner

---

### Task 1: Specify the packed artifact

**Files:**
- Create: `tests/bin.test.ts`
- Delete: `tests/main.test.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing package smoke test**

Create `tests/bin.test.ts`:

```ts
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("packed codex-bot runs without source files or installed dependencies", async (context) => {
  const temp = await mkdtemp(join(tmpdir(), "codex-bot-package-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const packed = await execFileAsync("npm", ["pack", "--json", "--pack-destination", temp], { cwd: root });
  const metadata = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  assert.equal(metadata.length, 1);
  const archive = join(temp, metadata[0]!.filename);
  const listing = (await execFileAsync("tar", ["-tzf", archive])).stdout.split("\n").filter(Boolean);
  assert.ok(listing.includes("package/dist/codex-bot"));
  assert.ok(listing.includes("package/assets/coordinator/AGENTS.md"));
  assert.ok(listing.includes("package/assets/coordinator/session-status.example.json"));
  assert.equal(listing.some((path) => /^package\/(?:src|tests|scripts|node_modules)\//u.test(path)), false);

  await execFileAsync("tar", ["-xzf", archive, "-C", temp]);
  const packageRoot = join(temp, "package");
  const executable = join(packageRoot, "dist", "codex-bot");
  assert.equal((await readFile(executable, "utf8")).startsWith("#!/usr/bin/env node\n"), true);
  assert.notEqual((await stat(executable)).mode & 0o111, 0);
  await assert.rejects(stat(join(packageRoot, "node_modules")));

  const result = spawnSync(executable, ["--definitely-invalid"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "codex-bot: startup failed\n");

  const workdir = join(temp, "coordinator");
  const startup = spawnSync(executable, ["--workdir", workdir], {
    cwd: packageRoot,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: temp,
      TELEGRAM_BOT_TOKEN: "pack-test-token",
      TELEGRAM_OWNER_ID: "1",
      TELEGRAM_DESTINATION_CHAT_ID: "1",
      DATA_DIR: join(temp, "data"),
      SESSION_REGISTRY_PATH: join(temp, "registry", "sessions.json"),
      CODEX_BINARY: join(temp, "missing-codex"),
      MCP_PORT: "0",
    },
  });
  assert.equal(startup.status, 1);
  assert.equal(startup.stderr, "codex-bot: startup failed\n");
  assert.equal(await readFile(join(workdir, "AGENTS.md"), "utf8"), await readFile(join(packageRoot, "assets", "coordinator", "AGENTS.md"), "utf8"));
  assert.deepEqual(JSON.parse(await readFile(join(workdir, "session-status.json"), "utf8")), { version: 2, sessions: {} });
});
```

Delete `tests/main.test.ts`; direct-execution URL detection is replaced by the unconditional `src/bin.ts` entry and the packed executable test.

Add this line to `.gitignore` so builds never become source-controlled artifacts:

```gitignore
dist/
```

- [ ] **Step 2: Run the smoke test to verify it fails**

```bash
npm test -- tests/bin.test.ts
```

Expected: FAIL because the manifest has no prepack build, bin entry, or packaged `dist/codex-bot`.

### Task 2: Build the production executable

**Files:**
- Create: `src/bin.ts`
- Create: `scripts/build.mjs`
- Modify: `src/main.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `tests/bin.test.ts`

- [ ] **Step 1: Separate the executable entry from reusable startup**

Replace `src/main.ts` with:

```ts
import { createApp } from "./app.ts";
import { parseCliArgs } from "./cli.ts";
import { loadConfig } from "./config.ts";

export async function main(env = process.env, argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const app = await createApp(loadConfig(env, parseCliArgs(argv)));
  await app.start();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void app.stop().catch(() => { process.exitCode = 1; });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
```

Create `src/bin.ts`:

```ts
import { formatStartupError } from "./cli.ts";
import { main } from "./main.ts";

void main().catch((error) => {
  process.stderr.write(`codex-bot: ${formatStartupError(error)}\n`);
  process.exitCode = 1;
});
```

Change `npm start` to `tsx src/bin.ts`. This makes source execution and the bundled command use the same unconditional entry without symlink-sensitive URL checks.

- [ ] **Step 2: Add the deterministic build script**

Create `scripts/build.mjs`:

```js
import { chmod, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const outfile = resolve(dist, "codex-bot");

await rm(dist, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: ["src/bin.ts"],
  outfile,
  bundle: true,
  packages: "bundle",
  platform: "node",
  format: "esm",
  target: "node24",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "eof",
  logLevel: "info",
});
await chmod(outfile, 0o755);
```

Keep `packages: "bundle"`; runtime npm code must be inside the bundle.

- [ ] **Step 3: Configure the production package**

Update `package.json` to:

```json
{
  "name": "codex-chat-bot",
  "version": "0.1.0",
  "type": "module",
  "bin": { "codex-bot": "dist/codex-bot" },
  "files": [
    "dist/codex-bot",
    "assets/coordinator/AGENTS.md",
    "assets/coordinator/session-status.example.json"
  ],
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "node scripts/build.mjs",
    "prepack": "npm run build",
    "start": "tsx src/bin.ts",
    "test": "node scripts/run-tests.mjs",
    "typecheck": "tsc --noEmit",
    "check": "npm run typecheck && npm test",
    "generate:codex-schema": "node scripts/generate-app-server-schema.mjs"
  },
  "devDependencies": {
    "@modelcontextprotocol/sdk": "1.29.0",
    "@types/node": "26.0.1",
    "esbuild": "0.28.1",
    "tsx": "4.22.4",
    "typescript": "6.0.3",
    "zod": "4.4.3"
  }
}
```

Removing `private` permits ordinary packing/publishing. Moving the two source imports to development dependencies ensures installing the packed bundle does not fetch runtime npm packages.

Run `npm install` to update `package-lock.json` from this manifest.

- [ ] **Step 4: Run build and packed-artifact tests**

```bash
npm run build
npm test -- tests/bin.test.ts
npm run typecheck
git diff --check
```

Expected: the build creates executable `dist/codex-bot`; the extracted archive runs without `node_modules`; typecheck and diff check pass.

- [ ] **Step 5: Commit the executable**

```bash
git add .gitignore package.json package-lock.json scripts/build.mjs src/bin.ts src/main.ts tests/bin.test.ts tests/main.test.ts
git commit -m "feat: build a distributable codex-bot executable"
```

### Task 3: Document distribution and verify the repository

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add build, pack, and install commands**

Replace the development-only launch block near the top of `README.md` with:

````markdown
## Build and install

```bash
npm install
npm run build
npm link
codex-bot --workdir "$HOME/.codex-bot/coordinator"
```

`npm run build` creates a fully bundled `dist/codex-bot` executable. The installed command needs Node.js 24+, Codex authentication, and a `codex` executable; it does not need TSX, TypeScript source files, or runtime `node_modules`.

Create an installable archive with `npm pack`. The archive contains the executable and its two coordinator template assets.

For source development, `npm start -- --workdir "$HOME/.codex-bot/coordinator"` remains available.
````

- [ ] **Step 2: Run full verification**

```bash
npm run check
npm pack --dry-run
git diff --check
```

Expected: typecheck passes; all tests except existing opt-in skips pass; the dry-run package contains no source/tests/scripts tree; diff check is clean.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md
git commit -m "docs: document the distributable binary"
```

### Task 4: Review, integrate, and restart live bot

**Files:**
- Review: all changes since the design commit
- Runtime state: `data/`, `~/.codex-bot/coordinator/`

- [ ] **Step 1: Request two independent reviews**

One reviewer checks packaging/build correctness, artifact isolation, entrypoint behavior, and npm contents. The other checks tests, asset lookup, runtime configuration, secret handling, and restart safety. Resolve all Critical or Important findings test-first and re-review until both are clean.

- [ ] **Step 2: Verify and fast-forward local main**

```bash
npm run check
git diff --check
git status --short
```

Fast-forward `main` to the reviewed feature head, rerun `npm run check` on `main`, and remove the owned feature worktree/branch only after verification succeeds.

- [ ] **Step 3: Build and install the reviewed command**

From `main`:

```bash
npm install
npm run build
npm link
command -v codex-bot
codex-bot --definitely-invalid
```

Expected: `command -v` resolves the linked command and the invalid invocation prints only `codex-bot: startup failed` with exit status 1.

- [ ] **Step 4: Stop and back up live state**

Stop the current `npm start` process with SIGINT through its existing terminal and wait until its Node/Codex children exit. Then create a private timestamped backup:

```bash
backup="$HOME/.codex-bot/backups/$(date +%Y%m%d-%H%M%S)"
install -d -m 700 "$backup"
cp -a /home/xinmm/sources/codex-bot/data "$backup/data"
cp -a "$HOME/.codex-bot/coordinator" "$backup/coordinator"
```

Do not print `/proc/*/environ`, the Telegram token, owner IDs, or message data.

- [ ] **Step 5: Restart through the installed command**

In the same terminal whose exported secret environment launched the old bot:

```bash
codex-bot --workdir "$HOME/.codex-bot/coordinator"
```

Wait for startup, verify the process command is `codex-bot`, verify `~/.codex-bot/coordinator/AGENTS.md` matches the packaged policy and its managed digest, and confirm `session-status.json` is valid version 2. Keep the backup and report its path. Never echo credentials.
