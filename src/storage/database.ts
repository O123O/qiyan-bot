import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "./migrations.ts";

export type Database = DatabaseSync;

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
  migrate(db);
  return db;
}

export function createTestDatabase(): Database {
  return openDatabase(":memory:");
}

function migrate(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
  const current = Number((db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number }).version);
  for (let index = current; index < migrations.length; index += 1) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const migration = migrations[index];
      if (typeof migration === "function") migration(db);
      else db.exec(migration ?? "");
      db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(index + 1);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function inTransaction<T>(db: Database, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
