import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { APP_VERSION } from "../src/version.ts";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("packed qiyan-bot runs without source files or installed dependencies", async (context) => {
  const temp = await mkdtemp(join(tmpdir(), "qiyan-bot-package-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const packed = await execFileAsync("npm", ["pack", "--json", "--pack-destination", temp], { cwd: root });
  const parsedMetadata = JSON.parse(packed.stdout) as Array<{ filename: string }> | Record<string, { filename: string }>;
  // npm 12 keys pack metadata by package name; earlier supported npm versions
  // return the same entries as an array.
  const metadata = Array.isArray(parsedMetadata) ? parsedMetadata : Object.values(parsedMetadata);
  assert.equal(metadata.length, 1);
  const archive = join(temp, metadata[0]!.filename);
  const listing = (await execFileAsync("tar", ["-tzf", archive])).stdout.split("\n").filter(Boolean);
  const requiredFiles = new Set([
    "package/README.md",
    "package/assets/brand/qiyan-logo.png",
    "package/assets/brand/qiyan-overview.svg",
    "package/assets/assistant/AGENTS.md",
    "package/assets/assistant/session-status.example.json",
    "package/assets/endpoints.example.jsonc",
    "package/assets/slack/manifest.yaml",
    "package/docs/chat-apps/wechat.md",
    "package/docs/sqlite.md",
    "package/docs/ssh-workers.md",
    "package/assets/remote/qiyan-app-server-launcher.sh",
    "package/assets/remote/qiyan-ssh-helper.mjs",
    "package/dist/qiyan-bot",
    "package/package.json",
  ]);
  for (const path of requiredFiles) assert.equal(listing.includes(path), true, `missing packed file: ${path}`);
  assert.deepEqual(listing.filter((path) => !requiredFiles.has(path) && !/^package\/(?:licen[cs]e|notice)(?:\.[^/]*)?$/iu.test(path)), []);

  const installRoot = join(temp, "install");
  await execFileAsync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installRoot, archive]);
  const packageRoot = join(installRoot, "node_modules", "qiyan-bot");
  const retiredRole = ["coor", "dinator"].join("");
  const retiredSandbox = ["SAND", "BOX_MODE"].join("");
  const retired = [
    ["codex", "-chat-bot"].join(""),
    ["codex", "-bot"].join(""),
    [".", "codex", "-bot"].join(""),
    ["Codex", " Chat Bot"].join(""),
    ["codex", "_chat_bot"].join(""),
    ["COOR", "DINATOR", "_"].join(""),
    ["CODEX", "_BOT_"].join(""),
    [retiredRole, "-local"].join(""),
    ["codex", "_bot_manager"].join(""),
    ["codex", "bot"].join(""),
    ["Codex", " bot"].join(""),
  ];
  const identityFailures: string[] = [];
  for (const path of await collectFiles(packageRoot)) {
    const name = relative(packageRoot, path);
    inspectIdentity(name, name, identityFailures, retiredRole, retiredSandbox, retired);
    inspectIdentity(name, await readFile(path, "utf8"), identityFailures, retiredRole, retiredSandbox, retired);
  }
  assert.deepEqual(identityFailures, []);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  assert.deepEqual(manifest.dependencies ?? {}, {});
  const installedEntries = await readdir(packageRoot);
  const requiredEntries = ["README.md", "assets", "dist", "docs", "package.json"];
  for (const entry of requiredEntries) assert.equal(installedEntries.includes(entry), true, `missing installed entry: ${entry}`);
  assert.deepEqual(installedEntries.filter((entry) => !requiredEntries.includes(entry) && !/^(?:licen[cs]e|notice)(?:\..*)?$/iu.test(entry)), []);
  await assert.rejects(stat(join(packageRoot, "node_modules")));
  const tree = JSON.parse((await execFileAsync("npm", ["ls", "--all", "--json", "--prefix", installRoot])).stdout) as {
    dependencies?: Record<string, { dependencies?: Record<string, unknown> }>;
  };
  assert.deepEqual(Object.keys(tree.dependencies ?? {}), ["qiyan-bot"]);
  assert.deepEqual(tree.dependencies?.["qiyan-bot"]?.dependencies ?? {}, {});

  const executable = join(installRoot, "node_modules", ".bin", "qiyan-bot");
  assert.equal((await readFile(join(packageRoot, "dist", "qiyan-bot"), "utf8")).startsWith("#!/usr/bin/env node\n"), true);
  assert.notEqual((await stat(executable)).mode & 0o111, 0);

  const version = spawnSync(executable, ["--version"], {
    cwd: temp,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(version.status, 0);
  assert.equal(version.stdout, `${APP_VERSION}\n`);
  assert.equal(version.stderr, "");

  const help = spawnSync(executable, ["--help"], {
    cwd: temp,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^QiYan personal assistant bot\n/u);
  assert.match(help.stdout, /qiyan-bot assistant-login/u);
  assert.equal(help.stderr, "");

  const serviceHome = join(temp, "service-home");
  const serviceQiyanHome = join(serviceHome, ".qiyan-bot");
  const serviceBin = join(temp, "service-bin");
  await mkdir(serviceQiyanHome, { recursive: true, mode: 0o700 });
  await mkdir(serviceBin, { mode: 0o700 });
  await writeFile(join(serviceQiyanHome, ".env"), [
    "TELEGRAM_BOT_TOKEN=private-file-token",
    "TELEGRAM_OWNER_ID=7",
    "TELEGRAM_DESTINATION_CHAT_ID=7",
    "",
  ].join("\n"), { mode: 0o600 });
  const fakeSystemctl = join(serviceBin, "systemctl");
  await writeFile(fakeSystemctl, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
appendFileSync(join(process.env.HOME, "systemctl-calls.jsonl"), JSON.stringify({ argv, leaked: Boolean(process.env.TELEGRAM_BOT_TOKEN || process.env.OTHER_SECRET) }) + "\\n");
if (argv[1] === "is-active") process.stdout.write("active\\n");
if (argv[1] === "is-enabled") process.stdout.write("enabled\\n");
`);
  await chmod(fakeSystemctl, 0o755);
  const fakeJournalctl = join(serviceBin, "journalctl");
  await writeFile(fakeJournalctl, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
writeFileSync(join(process.env.HOME, "journalctl-call.json"), JSON.stringify({ argv: process.argv.slice(2), leaked: Boolean(process.env.TELEGRAM_BOT_TOKEN || process.env.OTHER_SECRET) }));
process.stdout.write("safe journal output\\n");
`);
  await chmod(fakeJournalctl, 0o755);
  const serviceEnv = {
    PATH: `${serviceBin}:${process.env.PATH ?? ""}`,
    HOME: serviceHome,
    TELEGRAM_BOT_TOKEN: "process-secret",
    OTHER_SECRET: "other-secret",
  };
  const shellOnlyHome = join(temp, "shell-only-service-home");
  const shellOnlyQiyanHome = join(shellOnlyHome, ".qiyan-bot");
  await mkdir(shellOnlyQiyanHome, { recursive: true, mode: 0o700 });
  await writeFile(join(shellOnlyQiyanHome, ".env"), [
    "TELEGRAM_OWNER_ID=7",
    "TELEGRAM_DESTINATION_CHAT_ID=7",
    "",
  ].join("\n"), { mode: 0o600 });
  const shellOnlyInstall = spawnSync(executable, ["service", "install"], {
    cwd: temp,
    encoding: "utf8",
    env: { ...serviceEnv, HOME: shellOnlyHome },
  });
  assert.equal(shellOnlyInstall.status, 1);
  assert.equal(shellOnlyInstall.stdout, "");
  assert.match(shellOnlyInstall.stderr, /CONFIGURATION_ERROR/u);
  assert.doesNotMatch(shellOnlyInstall.stderr, /process-secret|other-secret/u);
  await assert.rejects(lstat(join(shellOnlyHome, ".config", "systemd", "user", "qiyan-bot.service")),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  const invalidPathHome = join(temp, "invalid-path-service-home");
  await mkdir(invalidPathHome, { mode: 0o700 });
  const invalidPathInstall = spawnSync(process.execPath, [executable, "service", "install"], {
    cwd: temp,
    encoding: "utf8",
    env: { ...serviceEnv, HOME: invalidPathHome, PATH: "relative:/usr/bin" },
  });
  assert.equal(invalidPathInstall.status, 1);
  assert.equal(invalidPathInstall.stdout, "");
  assert.match(invalidPathInstall.stderr, /CONFIGURATION_ERROR.*PATH/u);
  await assert.rejects(lstat(join(invalidPathHome, ".qiyan-bot")),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  await assert.rejects(lstat(join(invalidPathHome, ".config")),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  const serviceInstall = spawnSync(process.execPath, [executable, "service", "install"], { cwd: temp, encoding: "utf8", env: serviceEnv });
  assert.equal(serviceInstall.status, 0);
  assert.equal(serviceInstall.stdout, "Installed and started qiyan-bot.service.\n");
  assert.equal(serviceInstall.stderr, "");
  const installedUnitPath = join(serviceHome, ".config", "systemd", "user", "qiyan-bot.service");
  const installedUnit = await readFile(installedUnitPath, "utf8");
  const expectedNodeExecutable = `"${process.execPath.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("%", "%%")}"`;
  assert.equal(installedUnit.includes(`ExecStart=${expectedNodeExecutable} `), true);
  assert.match(installedUnit, /ExecStart=.*qiyan-bot.* --home .*\.qiyan-bot/u);
  assert.equal(installedUnit.includes(`Environment="PATH=${serviceEnv.PATH}"`), true);
  assert.doesNotMatch(installedUnit, /process-secret|private-file-token|other-secret/u);
  const serviceStatus = spawnSync(executable, ["service", "status"], { cwd: temp, encoding: "utf8", env: serviceEnv });
  assert.equal(serviceStatus.status, 0);
  assert.equal(serviceStatus.stdout, "qiyan-bot.service is active and enabled.\nRecent logs: qiyan-bot service logs\n");
  assert.equal(serviceStatus.stderr, "");
  const serviceLogs = spawnSync(executable, ["service", "logs"], { cwd: temp, encoding: "utf8", env: serviceEnv });
  assert.equal(serviceLogs.status, 0);
  assert.equal(serviceLogs.stdout, "safe journal output\n");
  assert.equal(serviceLogs.stderr, "");
  assert.deepEqual(JSON.parse(await readFile(join(serviceHome, "journalctl-call.json"), "utf8")), {
    argv: ["--user", "--unit", "qiyan-bot.service", "--lines", "100", "--no-pager", "--output", "short-iso"],
    leaked: false,
  });
  const serviceUninstall = spawnSync(executable, ["service", "uninstall"], { cwd: temp, encoding: "utf8", env: serviceEnv });
  assert.equal(serviceUninstall.status, 0);
  assert.equal(serviceUninstall.stdout, "Stopped and removed qiyan-bot.service.\n");
  assert.equal(serviceUninstall.stderr, "");
  await assert.rejects(lstat(installedUnitPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  const serviceCalls = (await readFile(join(serviceHome, "systemctl-calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { argv: string[]; leaked: boolean });
  assert.deepEqual(serviceCalls.map(({ argv }) => argv), [
    ["--user", "daemon-reload"],
    ["--user", "enable", "qiyan-bot.service"],
    ["--user", "restart", "qiyan-bot.service"],
    ["--user", "is-active", "qiyan-bot.service"],
    ["--user", "is-enabled", "qiyan-bot.service"],
    ["--user", "disable", "--now", "qiyan-bot.service"],
    ["--user", "daemon-reload"],
  ]);
  assert.equal(serviceCalls.some(({ leaked }) => leaked), false);

  const checkedHome = join(temp, "checked-qiyan-home");
  await mkdir(checkedHome, { mode: 0o700 });
  await writeFile(join(checkedHome, ".env"), [
    "TELEGRAM_BOT_TOKEN=private-file-token",
    "TELEGRAM_OWNER_ID=7",
    "TELEGRAM_DESTINATION_CHAT_ID=7",
    "",
  ].join("\n"), { mode: 0o600 });
  const configCheck = spawnSync(executable, ["config-check", "--home", checkedHome], {
    cwd: temp,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: temp },
  });
  assert.equal(configCheck.status, 0);
  assert.equal(configCheck.stdout, "Configuration OK.\n");
  assert.equal(configCheck.stderr, "");

  const weixinLogin = spawnSync(executable, ["weixin-login", "--home", "relative-home"], {
    cwd: temp,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: temp },
  });
  assert.equal(weixinLogin.status, 1);
  assert.equal(weixinLogin.stdout, "");
  assert.match(weixinLogin.stderr, /QIYAN_HOME must be absolute/u);

  const overlappingHome = join(temp, "overlapping-qiyan-home");
  const overlappingState = join(overlappingHome, "shared-state");
  await mkdir(overlappingHome, { mode: 0o700 });
  await writeFile(join(overlappingHome, ".env"), [
    "TELEGRAM_BOT_TOKEN=private-file-token",
    "TELEGRAM_OWNER_ID=7",
    "TELEGRAM_DESTINATION_CHAT_ID=7",
    `ASSISTANT_WORKDIR=${overlappingState}`,
    `DATA_DIR=${overlappingState}`,
    "",
  ].join("\n"), { mode: 0o600 });
  const rejectedConfig = spawnSync(executable, ["config-check", "--home", overlappingHome], {
    cwd: temp,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: temp },
  });
  assert.equal(rejectedConfig.status, 1);
  assert.equal(rejectedConfig.stdout, "");
  assert.match(rejectedConfig.stderr, /must be separate from backend state/);
  await assert.rejects(stat(overlappingState), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");

  const result = spawnSync(executable, ["--definitely-invalid"], {
    cwd: temp,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "qiyan-bot: CONFIGURATION_ERROR: unknown argument\n");

  const workdir = join(temp, "assistant");
  const startup = spawnSync(executable, ["--workdir", workdir], {
    cwd: temp,
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
  assert.equal(startup.stdout, "");
  assert.equal(startup.stderr, "qiyan-bot: STARTUP_ERROR: Codex App Server startup failed; verify CODEX_BINARY, Codex version, and assistant authentication\n");
  assert.equal(await readFile(join(workdir, "AGENTS.md"), "utf8"), await readFile(join(packageRoot, "assets", "assistant", "AGENTS.md"), "utf8"));
  assert.deepEqual(JSON.parse(await readFile(join(workdir, "session-status.json"), "utf8")), { version: 2, sessions: {} });
  assert.deepEqual(JSON.parse(await readFile(join(workdir, "assistant-context.json"), "utf8")), {
    version: 2,
    user_home: temp,
    qiyan_home: join(temp, ".qiyan-bot"),
    default_projects_root: join(temp, "qiyan-projects"),
  });
  assert.equal(listing.includes("package/assets/assistant/assistant-context.json"), false);

  const legacyRoot = join(temp, "legacy-state");
  await mkdir(join(legacyRoot, "data"), { recursive: true });
  const legacyDatabasePath = join(legacyRoot, "data", "bot.sqlite3");
  const legacyDatabase = new DatabaseSync(legacyDatabasePath);
  legacyDatabase.exec("CREATE TABLE old_state(value TEXT)");
  legacyDatabase.close();
  const rejectedState = spawnSync(executable, [], {
    cwd: temp,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: legacyRoot,
      TELEGRAM_BOT_TOKEN: "pack-test-token",
      TELEGRAM_OWNER_ID: "1",
      TELEGRAM_DESTINATION_CHAT_ID: "1",
      DATA_DIR: join(legacyRoot, "data"),
      SESSION_REGISTRY_PATH: join(legacyRoot, "registry", "sessions.json"),
      ASSISTANT_WORKDIR: join(legacyRoot, "assistant"),
      MCP_PORT: "0",
    },
  });
  assert.equal(rejectedState.status, 1);
  assert.equal(rejectedState.stderr, "qiyan-bot: CONFIGURATION_ERROR: not a QiYan Bot state database\n");

  const globalRoot = join(temp, "global");
  await execFileAsync("npm", ["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", globalRoot, archive]);
  const fakeHome = join(temp, "update-home");
  const fakeBin = join(temp, "fake-bin");
  await mkdir(fakeHome);
  await mkdir(fakeBin);
  const fakeNpm = join(fakeBin, "npm");
  await writeFile(fakeNpm, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
writeFileSync(join(process.env.HOME, "update-record.json"), JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
`);
  await chmod(fakeNpm, 0o755);
  const globalExecutable = join(globalRoot, "bin", "qiyan-bot");
  const update = spawnSync(globalExecutable, ["--update"], {
    cwd: temp,
    encoding: "utf8",
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      HOME: fakeHome,
      TELEGRAM_BOT_TOKEN: "telegram-secret",
      OPENAI_API_KEY: "openai-secret",
      CODEX_HOME: "/secret/codex-home",
      QIYAN_BOT_MCP_TOKEN: "mcp-secret",
      NPM_TOKEN: "npm-secret",
      OTHER_SECRET: "other-secret",
    },
  });
  assert.equal(update.status, 0);
  assert.equal(update.stderr, "");
  assert.equal(update.stdout, `Updated qiyan-bot to ${APP_VERSION} in ${globalRoot}.\nRestart any running qiyan-bot process to use this version.\n`);
  const updateRecord = JSON.parse(await readFile(join(fakeHome, "update-record.json"), "utf8")) as {
    argv: string[];
    env: NodeJS.ProcessEnv;
  };
  assert.deepEqual(updateRecord.argv, [
    "install", "--global", "--prefix", globalRoot, "--ignore-scripts", "--no-audit", "--no-fund",
    "https://github.com/O123O/qiyan-bot/releases/latest/download/qiyan-bot.tgz",
  ]);
  assert.equal(updateRecord.env.HOME, fakeHome);
  assert.match(updateRecord.env.PATH ?? "", new RegExp(`^${fakeBin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:`));
  for (const key of ["TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY", "CODEX_HOME", "QIYAN_BOT_MCP_TOKEN", "NPM_TOKEN", "OTHER_SECRET"]) {
    assert.equal(updateRecord.env[key], undefined, `leaked update environment key: ${key}`);
  }
});

async function collectFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const paths = new Array<string>();
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) paths.push(...await collectFiles(child));
    else if (entry.isFile()) paths.push(child);
  }
  return paths;
}

function inspectIdentity(
  name: string,
  content: string,
  failures: string[],
  retiredRole: string,
  retiredSandbox: string,
  retired: string[],
): void {
  if (content.toLowerCase().includes(retiredRole)) failures.push(`${name}: retired role`);
  for (const value of retired) {
    if (content.includes(value)) failures.push(`${name}: ${value}`);
  }
  const environmentNames: string[] = content.match(/[A-Z][A-Z0-9_]+/gu) ?? [];
  if (environmentNames.includes(retiredSandbox)) failures.push(`${name}: retired sandbox variable`);
}
