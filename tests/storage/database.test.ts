import assert from "node:assert/strict";
import { access, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openDatabase } from "../../src/storage/database.ts";
import { AppError } from "../../src/core/errors.ts";

test("fresh absent and empty databases receive the QiYan identity marker", async () => {
  for (const kind of ["absent", "empty"]) {
    const root = await mkdtemp(join(tmpdir(), `qiyan-bot-db-${kind}-`));
    const path = join(root, "bot.sqlite3");
    if (kind === "empty") await writeFile(path, "");
    const db = openDatabase(path);
    const marker = db.prepare("SELECT product, state_version FROM qiyan_state").get()!;
    assert.equal(marker.product, "qiyan-bot");
    assert.equal(marker.state_version, 1);
    db.close();
  }
});

test("a pre-QiYan database is rejected without mutation or sidecars", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-db-legacy-"));
  const path = join(root, "bot.sqlite3");
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE legacy_state(value TEXT); INSERT INTO legacy_state(value) VALUES ('preserve-me')");
  legacy.close();
  const beforeBytes = await readFile(path);
  const beforeStat = await stat(path);

  assert.throws(() => openDatabase(path), (error: unknown) =>
    error instanceof AppError && error.code === "CONFIGURATION_ERROR" && /not a QiYan Bot state database/.test(error.message));
  assert.deepEqual(await readFile(path), beforeBytes);
  const afterStat = await stat(path);
  assert.equal(afterStat.size, beforeStat.size);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  assert.equal(afterStat.ctimeMs, beforeStat.ctimeMs);
  await assert.rejects(access(`${path}-wal`));
  await assert.rejects(access(`${path}-shm`));

  const unchanged = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(unchanged.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name), ["legacy_state"]);
  assert.equal(unchanged.prepare("SELECT value FROM legacy_state").get()!.value, "preserve-me");
  unchanged.close();
});

test("an existing QiYan database reopens normally", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-db-reopen-"));
  const path = join(root, "bot.sqlite3");
  openDatabase(path).close();
  const reopened = openDatabase(path);
  assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()!.count, 7);
  reopened.close();
});
