import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openDatabase } from "../../src/storage/database.ts";

test("a version-1 database upgrades delivery attachment and reply columns", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "codex-bot-db-")), "bot.sqlite3");
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
    INSERT INTO schema_migrations(version) VALUES (1);
    CREATE TABLE deliveries (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, destination TEXT NOT NULL, body TEXT NOT NULL,
      mandatory INTEGER NOT NULL, state TEXT NOT NULL, telegram_message_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  old.close();

  const upgraded = openDatabase(path);
  const columns = upgraded.prepare("PRAGMA table_info(deliveries)").all().map((row: any) => row.name);
  assert.ok(columns.includes("attachment_id"));
  assert.ok(columns.includes("attachment_scope_id"));
  assert.ok(columns.includes("reply_to"));
  assert.equal((upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as any).version, 3);
  assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE name = 'turn_attachment_refs'").get());
  upgraded.close();
});
