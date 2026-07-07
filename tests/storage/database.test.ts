import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openDatabase } from "../../src/storage/database.ts";
import { migrations } from "../../src/storage/migrations.ts";
import { AppError } from "../../src/core/errors.ts";
import { preflightConversationCutover } from "../../src/storage/conversation-cutover.ts";

test("fresh absent and empty databases receive the QiYan identity marker", async () => {
  for (const kind of ["absent", "empty"]) {
    const root = await mkdtemp(join(tmpdir(), `qiyan-bot-db-${kind}-`));
    const path = join(root, "bot.sqlite3");
    if (kind === "empty") await writeFile(path, "");
    const db = openDatabase(path);
    const marker = db.prepare("SELECT product, state_version FROM qiyan_state").get()!;
    assert.equal(marker.product, "qiyan-bot");
    assert.equal(marker.state_version, 2);
    db.close();
  }
});

test("file databases use verified rollback journaling and durable synchronization", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-db-journal-"));
  const path = join(root, "bot.sqlite3");
  const db = openDatabase(path);

  assert.equal(db.prepare("PRAGMA journal_mode").get()!.journal_mode, "delete");
  assert.equal(db.prepare("PRAGMA synchronous").get()!.synchronous, 3);
  assert.equal(db.prepare("PRAGMA busy_timeout").get()!.timeout, 5_000);
  assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  db.close();

  await assertNoArtifacts(path);
});

test("a committed hot WAL survives preflight and conversion to rollback journaling", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-db-hot-wal-"));
  const path = join(root, "bot.sqlite3");
  const initial = openDatabase(path);
  initial.exec("CREATE TABLE preserved(value TEXT NOT NULL); INSERT INTO preserved VALUES ('checkpointed')");
  initial.close();

  const script = `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0;");
    db.prepare("INSERT INTO preserved(value) VALUES (?)").run("wal-only");
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, path], {
    encoding: "utf8",
    env: {},
  });
  assert.equal(child.status, 0, "hot-WAL fixture child must exit successfully");
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
  await access(`${path}-wal`);

  const ignoresWal = new DatabaseSync(`file:${path}?immutable=1`, { readOnly: true });
  assert.equal(ignoresWal.prepare("SELECT COUNT(*) AS count FROM preserved").get()!.count, 1);
  ignoresWal.close();

  const seesWal = new DatabaseSync(path, { readOnly: true });
  assert.equal(seesWal.prepare("SELECT COUNT(*) AS count FROM preserved").get()!.count, 2);
  seesWal.close();

  const reopened = openDatabase(path);
  assert.deepEqual(reopened.prepare("SELECT value FROM preserved ORDER BY rowid").all().map((row) => row.value), ["checkpointed", "wal-only"]);
  assert.equal(reopened.prepare("PRAGMA journal_mode").get()!.journal_mode, "delete");
  reopened.close();
  await assertNoArtifacts(path);
});

test("a hot rollback journal is recovered only after byte-stable copied preflight", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-db-hot-journal-"));
  const path = join(root, "bot.sqlite3");
  const initial = openDatabase(path);
  initial.exec(`
    CREATE TABLE rollback_fixture(id INTEGER PRIMARY KEY, payload BLOB NOT NULL);
    WITH RECURSIVE sequence(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 2000
    ) INSERT INTO rollback_fixture(id, payload) SELECT value, zeroblob(2000) FROM sequence;
  `);
  initial.close();

  const script = `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA cache_size=5; PRAGMA cache_spill=ON; BEGIN IMMEDIATE;");
    db.exec("UPDATE rollback_fixture SET payload = randomblob(2000)");
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, path], { encoding: "utf8", env: {} });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
  await access(`${path}-journal`);
  const before = await databaseArtifactBytes(path);
  assert.deepEqual(Object.keys(before).sort(), ["-journal", "main"]);

  let atPreflightBoundary: Record<string, string> | undefined;
  const reopened = openDatabase(path, {
    closeInspector: (inspector) => {
      atPreflightBoundary = databaseArtifactBytesSync(path);
      inspector.close();
    },
  });
  assert.deepEqual(atPreflightBoundary, before);
  assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM rollback_fixture WHERE payload != zeroblob(2000)").get()!.count, 0);
  assert.equal(reopened.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  reopened.close();
  await assertNoArtifacts(path);
});

test("preflight reads a WAL-only unsupported state marker without mutating legacy state", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-db-hot-wal-marker-"));
  const path = join(root, "bot.sqlite3");
  openDatabase(path).close();

  const script = `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0;");
    db.prepare("UPDATE qiyan_state SET state_version = 4 WHERE product = ?").run("qiyan-bot");
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, path], {
    encoding: "utf8",
    env: {},
  });
  assert.equal(child.status, 0, "hot-WAL marker fixture child must exit successfully");
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
  await access(`${path}-wal`);

  const ignoresWal = new DatabaseSync(`file:${path}?immutable=1`, { readOnly: true });
  assert.equal(ignoresWal.prepare("SELECT state_version FROM qiyan_state WHERE product = 'qiyan-bot'").get()!.state_version, 2);
  ignoresWal.close();
  const before = await databaseArtifactBytes(path);
  assert.deepEqual(Object.keys(before).sort(), ["-shm", "-wal", "main"]);
  assert.throws(() => openDatabase(path), (error: unknown) => error instanceof AppError
    && error.code === "CONFIGURATION_ERROR" && error.message === "not a QiYan Bot state database");
  assert.deepEqual(await databaseArtifactBytes(path), before);
  await removeArtifacts(path);
});

test("a corrupt legacy-WAL database is rejected without mutating pre-existing bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-db-corrupt-"));
  const path = join(root, "bot.sqlite3");
  const db = openDatabase(path);
  const rootPage = Number(db.prepare("SELECT rootpage FROM sqlite_schema WHERE type = 'table' AND name = 'session_dashboard_meta'").get()!.rootpage);
  const pageSize = Number(db.prepare("PRAGMA page_size").get()!.page_size);
  db.close();
  const legacy = new DatabaseSync(path);
  assert.equal(legacy.prepare("PRAGMA journal_mode=WAL").get()!.journal_mode, "wal");
  legacy.close();

  const handle = await open(path, "r+");
  try { await handle.write(Buffer.alloc(pageSize), 0, pageSize, (rootPage - 1) * pageSize); }
  finally { await handle.close(); }
  const beforeBytes = await readFile(path);
  const beforeStat = await stat(path);

  let failure: unknown;
  let unexpectedlyOpened: DatabaseSync | undefined;
  try { unexpectedlyOpened = openDatabase(path); }
  catch (error) { failure = error; }
  finally { unexpectedlyOpened?.close(); }

  assert.equal(failure instanceof AppError && failure.code === "CONFIGURATION_ERROR"
    && failure.message === "QiYan Bot state database failed integrity check; restore or recover it before starting", true);
  assert.deepEqual(await readFile(path), beforeBytes);
  const afterStat = await stat(path);
  assert.equal(afterStat.size, beforeStat.size);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  await removeArtifacts(path);
});

test("an inspector close failure cannot expose its raw error", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-db-inspector-close-"));
  const path = join(root, "bot.sqlite3");
  openDatabase(path).close();

  let failure: unknown;
  let capturedInspector: DatabaseSync | undefined;
  let unexpectedlyOpened: DatabaseSync | undefined;
  try {
    unexpectedlyOpened = openDatabase(path, {
      closeInspector: (inspector) => {
        capturedInspector = inspector;
        throw new Error("secret close diagnostic");
      },
    });
  } catch (error) { failure = error; }
  finally { unexpectedlyOpened?.close(); }

  assert.equal(failure instanceof AppError && failure.code === "CONFIGURATION_ERROR"
    && failure.message === "QiYan Bot state database failed integrity check; restore or recover it before starting", true);
  assert.doesNotMatch(failure instanceof Error ? failure.message : "", /secret close diagnostic/u);
  assert.throws(() => capturedInspector!.prepare("SELECT 1"));
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

test("legacy Telegram cutover is rejected read-only when Telegram configuration is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-db-telegram-preflight-"));
  const path = join(root, "bot.sqlite3");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE qiyan_state(product TEXT PRIMARY KEY, state_version INTEGER NOT NULL);
    INSERT INTO qiyan_state VALUES ('qiyan-bot', 2);
    CREATE TABLE source_contexts(id TEXT PRIMARY KEY, kind TEXT NOT NULL);
    INSERT INTO source_contexts VALUES ('one', 'telegram');
    CREATE TABLE deliveries(id TEXT PRIMARY KEY);
  `);
  legacy.close();
  const bytes = await readFile(path);
  assert.throws(() => preflightConversationCutover(path, false), (error: unknown) =>
    error instanceof AppError && error.code === "CONFIGURATION_ERROR" && /Telegram configuration/i.test(error.message));
  assert.deepEqual(await readFile(path), bytes);
  await assert.rejects(access(`${path}-wal`));
  await assert.rejects(access(`${path}-shm`));
});

test("a QiYan state-version-1 database is rejected read-only without mutation or sidecars", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-db-v1-"));
  const path = join(root, "bot.sqlite3");
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE qiyan_state(product TEXT PRIMARY KEY, state_version INTEGER NOT NULL); INSERT INTO qiyan_state VALUES ('qiyan-bot', 1)");
  legacy.close();
  const before = await readFile(path);

  assert.throws(() => openDatabase(path), /not a QiYan Bot state database/);
  assert.deepEqual(await readFile(path), before);
  await assert.rejects(access(`${path}-wal`));
  await assert.rejects(access(`${path}-shm`));
});

test("an existing QiYan database reopens normally", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-db-reopen-"));
  const path = join(root, "bot.sqlite3");
  openDatabase(path).close();
  const reopened = openDatabase(path);
  assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()!.count, migrations.length);
  reopened.close();
});

test("a cut-over QiYan state-version-3 database reopens normally", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-db-v3-"));
  const path = join(root, "bot.sqlite3");
  const db = openDatabase(path);
  db.prepare("UPDATE qiyan_state SET state_version = 3 WHERE product = 'qiyan-bot'").run();
  db.close();
  const reopened = openDatabase(path);
  assert.equal(reopened.prepare("SELECT state_version FROM qiyan_state WHERE product = 'qiyan-bot'").get()!.state_version, 3);
  reopened.close();
});

test("an unknown future QiYan state version is rejected read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-db-v4-"));
  const path = join(root, "bot.sqlite3");
  const db = openDatabase(path);
  db.prepare("UPDATE qiyan_state SET state_version = 4 WHERE product = 'qiyan-bot'").run();
  db.close();
  const before = await readFile(path);
  assert.throws(() => openDatabase(path), /not a QiYan Bot state database/);
  assert.deepEqual(await readFile(path), before);
});

async function assertNoArtifacts(path: string): Promise<void> {
  for (const suffix of ["-wal", "-shm", "-journal"]) await assert.rejects(access(`${path}${suffix}`));
}

async function removeArtifacts(path: string): Promise<void> {
  for (const suffix of ["-wal", "-shm", "-journal"]) await rm(`${path}${suffix}`, { force: true });
}

async function databaseArtifactBytes(path: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try { result[suffix || "main"] = (await readFile(`${path}${suffix}`)).toString("base64"); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return result;
}

function databaseArtifactBytesSync(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try { result[suffix || "main"] = readFileSync(`${path}${suffix}`).toString("base64"); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return result;
}
