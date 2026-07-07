import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "./migrations.ts";
import { AppError } from "../core/errors.ts";

export type Database = DatabaseSync;

interface OpenDatabaseOptions {
  closeInspector?: (inspector: DatabaseSync) => void;
}

const integrityFailure = "QiYan Bot state database failed integrity check; restore or recover it before starting";
const journalingFailure = "QiYan Bot state database could not enable safe journaling";
const inspectionSuffixes = ["", "-wal", "-shm", "-journal"] as const;

interface InspectionArtifact {
  suffix: typeof inspectionSuffixes[number];
  dev: bigint;
  ino: bigint;
  uid: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

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
  let inspection: { path: string; cleanup(): void } | undefined;
  let verdict: "foreign" | "integrity" | "valid" = "foreign";
  try {
    inspection = createInspectionCopy(path);
    // Writable access is confined to the disposable copy so SQLite can recover
    // a legitimate hot rollback journal without touching canonical state.
    inspector = new DatabaseSync(inspection.path);
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
    if (inspection) {
      try { inspection.cleanup(); }
      catch { if (verdict === "valid") verdict = "integrity"; }
    }
  }
  if (verdict !== "valid") throw new AppError("CONFIGURATION_ERROR", verdict === "foreign" ? "not a QiYan Bot state database" : integrityFailure);
}

function createInspectionCopy(path: string): { path: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "qiyan-bot-db-inspection-"));
  const copyPath = join(root, basename(path));
  try {
    chmodSync(root, 0o700);
    const copied: InspectionArtifact[] = [];
    for (const suffix of inspectionSuffixes) {
      try { copied.push(copyInspectionArtifact(`${path}${suffix}`, `${copyPath}${suffix}`, suffix)); }
      catch (error) {
        if (suffix !== "" && isErrno(error, "ENOENT")) continue;
        throw error;
      }
    }
    const current = captureInspectionArtifacts(path);
    if (!sameInspectionArtifacts(copied, current)) throw new Error("database changed during inspection copy");
    return { path: copyPath, cleanup: () => { rmSync(root, { recursive: true, force: true }); } };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function copyInspectionArtifact(
  sourcePath: string,
  destinationPath: string,
  suffix: typeof inspectionSuffixes[number],
): InspectionArtifact {
  const initial = lstatSync(sourcePath, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("unsafe database artifact");
  const source = openSync(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  let destination: number | undefined;
  try {
    const opened = fstatSync(source, { bigint: true });
    assertInspectionIdentity(initial, opened);
    destination = openSync(
      destinationPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const size = Number(opened.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("unsafe database artifact size");
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < size) {
      const bytesRead = readSync(source, buffer, 0, Math.min(buffer.length, size - position), position);
      if (bytesRead === 0) throw new Error("unexpected database artifact eof");
      let written = 0;
      while (written < bytesRead) {
        const bytesWritten = writeSync(destination, buffer, written, bytesRead - written, position + written);
        if (bytesWritten === 0) throw new Error("short database artifact write");
        written += bytesWritten;
      }
      position += bytesRead;
    }
    fsyncSync(destination);
    const after = fstatSync(source, { bigint: true });
    assertInspectionIdentity(opened, after);
    assertInspectionIdentity(after, lstatSync(sourcePath, { bigint: true }));
    return inspectionArtifact(suffix, after);
  } finally {
    try { if (destination !== undefined) closeSync(destination); }
    finally { closeSync(source); }
  }
}

function captureInspectionArtifacts(path: string): InspectionArtifact[] {
  const artifacts: InspectionArtifact[] = [];
  for (const suffix of inspectionSuffixes) {
    try {
      const value = lstatSync(`${path}${suffix}`, { bigint: true });
      if (!value.isFile() || value.isSymbolicLink()) throw new Error("unsafe database artifact");
      artifacts.push(inspectionArtifact(suffix, value));
    } catch (error) {
      if (suffix !== "" && isErrno(error, "ENOENT")) continue;
      throw error;
    }
  }
  return artifacts;
}

function inspectionArtifact(suffix: typeof inspectionSuffixes[number], value: BigIntStats): InspectionArtifact {
  return {
    suffix,
    dev: value.dev,
    ino: value.ino,
    uid: value.uid,
    mode: value.mode,
    nlink: value.nlink,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  };
}

function assertInspectionIdentity(left: BigIntStats, right: BigIntStats): void {
  if (
    !right.isFile()
    || right.isSymbolicLink()
    || left.dev !== right.dev
    || left.ino !== right.ino
    || left.uid !== right.uid
    || left.mode !== right.mode
    || left.nlink !== right.nlink
    || left.size !== right.size
    || left.mtimeNs !== right.mtimeNs
    || left.ctimeNs !== right.ctimeNs
  ) throw new Error("database artifact changed");
}

function sameInspectionArtifacts(left: readonly InspectionArtifact[], right: readonly InspectionArtifact[]): boolean {
  return left.length === right.length && left.every((artifact, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && artifact.suffix === candidate.suffix
      && artifact.dev === candidate.dev
      && artifact.ino === candidate.ino
      && artifact.uid === candidate.uid
      && artifact.mode === candidate.mode
      && artifact.nlink === candidate.nlink
      && artifact.size === candidate.size
      && artifact.mtimeNs === candidate.mtimeNs
      && artifact.ctimeNs === candidate.ctimeNs;
  });
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
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
