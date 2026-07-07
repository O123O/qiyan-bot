import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "./migrations.ts";
import { AppError } from "../core/errors.ts";

export type Database = DatabaseSync;

interface OpenDatabaseOptions {
  closeInspector?: (inspector: DatabaseSync) => void;
}

const integrityFailure = "QiYan Bot state database failed integrity check; restore or recover it before starting";
const journalingFailure = "QiYan Bot state database could not enable safe journaling";

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Database {
  if (path !== ":memory:") {
    const state = existingFileState(path);
    if (state === "nonempty") assertQiYanDatabase(path, options.closeInspector ?? ((inspector) => { inspector.close(); }));
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(path);
  try {
    configureDatabase(db, path !== ":memory:");
    migrate(db);
    return db;
  } catch (error) {
    try { db.close(); } catch { /* Preserve the configuration or migration failure. */ }
    throw error;
  }
}

function existingFileState(path: string): "missing" | "empty" | "nonempty" {
  try { return statSync(path).size === 0 ? "empty" : "nonempty"; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
    throw error;
  }
}

function assertQiYanDatabase(path: string, closeInspector: (inspector: DatabaseSync) => void): void {
  let inspector: DatabaseSync | undefined;
  let verdict: "foreign" | "integrity" | "valid" = "foreign";
  try {
    inspector = new DatabaseSync(path, { readOnly: true });
    inspector.exec("PRAGMA busy_timeout=5000");
    const marker = inspector.prepare("SELECT product, state_version FROM qiyan_state WHERE product = 'qiyan-bot'").get() as
      { product?: unknown; state_version?: unknown } | undefined;
    if (marker?.product !== "qiyan-bot" || (marker.state_version !== 2 && marker.state_version !== 3)) throw new Error("invalid marker");
    verdict = "integrity";
    const rows = inspector.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check?: unknown }>;
    if (rows.length === 1 && rows[0]?.integrity_check === "ok") verdict = "valid";
  } catch {
    // Map all SQLite diagnostics to the selected static verdict below.
  } finally {
    if (inspector) {
      try { closeInspector(inspector); }
      catch {
        if (verdict === "valid") verdict = "integrity";
        try { inspector.close(); } catch { /* Preserve the sanitized verdict. */ }
      }
    }
  }
  if (verdict !== "valid") throw new AppError("CONFIGURATION_ERROR", verdict === "foreign" ? "not a QiYan Bot state database" : integrityFailure);
}

function configureDatabase(db: Database, fileBacked: boolean): void {
  try {
    db.exec("PRAGMA busy_timeout=5000");
    if (fileBacked) {
      const journal = db.prepare("PRAGMA journal_mode=DELETE").get() as { journal_mode?: unknown };
      if (journal.journal_mode !== "delete") throw new Error("journal mode rejected");
    }
    db.exec("PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON");
    const synchronous = db.prepare("PRAGMA synchronous").get() as { synchronous?: unknown };
    const busyTimeout = db.prepare("PRAGMA busy_timeout").get() as { timeout?: unknown };
    const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: unknown };
    if (synchronous.synchronous !== 3 || busyTimeout.timeout !== 5_000 || foreignKeys.foreign_keys !== 1) {
      throw new Error("database pragmas rejected");
    }
  } catch {
    throw new AppError("CONFIGURATION_ERROR", journalingFailure);
  }
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
