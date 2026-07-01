import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
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
  assert.deepEqual(listing.sort(), [
    "package/README.md",
    "package/assets/coordinator/AGENTS.md",
    "package/assets/coordinator/session-status.example.json",
    "package/dist/codex-bot",
    "package/package.json",
  ].sort());

  const installRoot = join(temp, "install");
  await execFileAsync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installRoot, archive]);
  const packageRoot = join(installRoot, "node_modules", "codex-chat-bot");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual((await readdir(packageRoot)).sort(), ["README.md", "assets", "dist", "package.json"]);
  await assert.rejects(stat(join(packageRoot, "node_modules")));
  const tree = JSON.parse((await execFileAsync("npm", ["ls", "--all", "--json", "--prefix", installRoot])).stdout) as {
    dependencies?: Record<string, { dependencies?: Record<string, unknown> }>;
  };
  assert.deepEqual(Object.keys(tree.dependencies ?? {}), ["codex-chat-bot"]);
  assert.deepEqual(tree.dependencies?.["codex-chat-bot"]?.dependencies ?? {}, {});

  const executable = join(installRoot, "node_modules", ".bin", "codex-bot");
  assert.equal((await readFile(join(packageRoot, "dist", "codex-bot"), "utf8")).startsWith("#!/usr/bin/env node\n"), true);
  assert.notEqual((await stat(executable)).mode & 0o111, 0);

  const result = spawnSync(executable, ["--definitely-invalid"], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "codex-bot: CONFIGURATION_ERROR: unknown argument\n");

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
