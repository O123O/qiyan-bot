import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfigSource } from "../src/config-source.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "qiyan-config-source-"));
  const home = join(root, "home");
  const qiyanHome = join(home, ".qiyan-bot");
  await mkdir(home, { mode: 0o700 });
  return { root, home, qiyanHome };
}

async function writeDotenv(qiyanHome: string, contents: string, mode = 0o600): Promise<void> {
  await mkdir(qiyanHome, { recursive: true, mode: 0o700 });
  const path = join(qiyanHome, ".env");
  await writeFile(path, contents, { mode });
  await chmod(path, mode);
}

test("loads an owner-only dotenv below host values without mutating process or child host environments", async () => {
  const value = await fixture();
  await writeDotenv(value.qiyanHome, [
    "# private Telegram settings",
    "TELEGRAM_BOT_TOKEN='file-token'",
    "TELEGRAM_OWNER_ID=41",
    "TELEGRAM_DESTINATION_CHAT_ID=41",
    "CODEX_BINARY=/file/codex",
    "",
  ].join("\n"));
  const processTokenBeforeLoad = process.env.TELEGRAM_BOT_TOKEN;
  const host: Record<string, string | undefined> = {
    HOME: value.home,
    TELEGRAM_OWNER_ID: "42",
    TELEGRAM_DESTINATION_CHAT_ID: "42",
    OPENAI_API_KEY: "host-provider-key",
  };

  const loaded = await loadConfigSource(host, { cliHome: value.qiyanHome });

  assert.equal(loaded.qiyanHome, value.qiyanHome);
  assert.equal(loaded.dotenvPath, join(value.qiyanHome, ".env"));
  assert.equal(loaded.values.TELEGRAM_BOT_TOKEN, "file-token");
  assert.equal(loaded.values.TELEGRAM_OWNER_ID, "42");
  assert.equal(loaded.values.TELEGRAM_DESTINATION_CHAT_ID, "42");
  assert.equal(loaded.values.CODEX_BINARY, "/file/codex");
  assert.equal(loaded.values.OPENAI_API_KEY, "host-provider-key");
  assert.deepEqual(loaded.hostEnv, host);
  assert.equal(loaded.hostEnv.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(process.env.TELEGRAM_BOT_TOKEN, processTokenBeforeLoad);
});

test("resolves CLI home over environment home and defaults to the real user home", async () => {
  const value = await fixture();
  const environmentHome = join(value.home, "environment-qiyan");
  const cliHome = join(value.home, "cli-qiyan");

  assert.equal((await loadConfigSource({ HOME: value.home, QIYAN_HOME: environmentHome })).qiyanHome, environmentHome);
  assert.equal((await loadConfigSource({ HOME: value.home, QIYAN_HOME: environmentHome }, { cliHome })).qiyanHome, cliHome);
  assert.equal((await loadConfigSource({ HOME: value.home })).qiyanHome, value.qiyanHome);
});

test("rejects bootstrap and unsupported keys in dotenv without exposing their values", async () => {
  for (const [line, key] of [
    ["QIYAN_HOME=/secret/redirect", "QIYAN_HOME"],
    ["OPENAI_API_KEY=provider-secret", "OPENAI_API_KEY"],
    ["BROKEN_LINE", "dotenv"],
  ] as const) {
    const value = await fixture();
    await writeDotenv(value.qiyanHome, `${line}\n`);
    await assert.rejects(loadConfigSource({ HOME: value.home }), (error: unknown) => {
      assert.match(String(error), new RegExp(key));
      assert.doesNotMatch(String(error), /secret|redirect/u);
      return true;
    });
  }
});

test("rejects relative, broad, project-overlapping, and symlinked QiYan homes", async () => {
  const relative = await fixture();
  await assert.rejects(loadConfigSource({ HOME: relative.home }, { cliHome: "relative/home" }), /absolute|~\//u);
  await assert.rejects(loadConfigSource({ HOME: relative.home }, { cliHome: relative.home }), /user home/iu);

  const overlap = await fixture();
  await assert.rejects(loadConfigSource({ HOME: overlap.home }, { cliHome: join(overlap.home, "qiyan-projects") }), /project/iu);
  await assert.rejects(loadConfigSource({ HOME: overlap.home }, { cliHome: join(overlap.home, "qiyan-projects", "private") }), /project/iu);

  const aliased = await fixture();
  const actual = join(aliased.home, "actual-qiyan");
  const alias = join(aliased.home, "alias-qiyan");
  await mkdir(actual, { mode: 0o700 });
  await symlink(actual, alias, "dir");
  await assert.rejects(loadConfigSource({ HOME: aliased.home }, { cliHome: alias }), /symlink|real directory/iu);
});

test("rejects unsafe dotenv descriptors, ownership, modes, and size", async () => {
  const linked = await fixture();
  await mkdir(linked.qiyanHome, { mode: 0o700 });
  const target = join(linked.root, "target.env");
  await writeFile(target, "TELEGRAM_BOT_TOKEN=x\n", { mode: 0o600 });
  await symlink(target, join(linked.qiyanHome, ".env"));
  await assert.rejects(loadConfigSource({ HOME: linked.home }), /regular|symlink/iu);

  const directory = await fixture();
  await mkdir(join(directory.qiyanHome, ".env"), { recursive: true, mode: 0o700 });
  await assert.rejects(loadConfigSource({ HOME: directory.home }), /regular/iu);

  const permissive = await fixture();
  await writeDotenv(permissive.qiyanHome, "TELEGRAM_BOT_TOKEN=x\n", 0o644);
  await assert.rejects(loadConfigSource({ HOME: permissive.home }), /permission|private|mode/iu);

  const wrongOwner = await fixture();
  await writeDotenv(wrongOwner.qiyanHome, "TELEGRAM_BOT_TOKEN=x\n");
  await assert.rejects(loadConfigSource({ HOME: wrongOwner.home }, { expectedUid: (process.geteuid?.() ?? 0) + 1 }), /own/iu);

  const oversized = await fixture();
  await writeDotenv(oversized.qiyanHome, `TELEGRAM_BOT_TOKEN=${"x".repeat(128)}\n`);
  await assert.rejects(loadConfigSource({ HOME: oversized.home }, { maxDotenvBytes: 64 }), /large|size/iu);
});

test("requires an existing QiYan home to be a private owner directory", async () => {
  const value = await fixture();
  await mkdir(value.qiyanHome, { mode: 0o755 });
  await chmod(value.qiyanHome, 0o755);
  await assert.rejects(loadConfigSource({ HOME: value.home }), /permission|private|mode/iu);
});
