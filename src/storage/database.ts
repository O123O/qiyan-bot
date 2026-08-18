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
  writeFileSync,
  writeSync,
  readFileSync,
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
  /** Skip verification outright. Set only where the caller has already established the file. */
  verifyIntegrity?: false;
}

const integrityFailure = "QiYan Bot state database failed integrity check; restore or recover it before starting";
const inspectionCleanupFailure = "QiYan Bot state database inspection cleanup failed";
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

class DatabaseIntegrityError extends AppError {
  constructor() {
    super("CONFIGURATION_ERROR", integrityFailure);
    this.name = "DatabaseIntegrityError";
  }
}

export function isDatabaseIntegrityFailure(error: unknown): boolean {
  return error instanceof DatabaseIntegrityError;
}

// Written when the database is closed cleanly, and consumed by the next open. It records the
// file the marker describes, so it cannot vouch for a different or later state.
function cleanShutdownMarkerPath(path: string): string { return `${path}.clean`; }

function cleanShutdownMarker(path: string): string | undefined {
  try {
    const stats = statSync(path, { bigint: true });
    return `${stats.size}:${stats.mtimeNs}:${stats.ino}`;
  } catch { return undefined; }
}

/** Records that this database was closed cleanly, so the next open can skip verifying it. */
export function markDatabaseClosedCleanly(path: string): void {
  if (path === ":memory:") return;
  const marker = cleanShutdownMarker(path);
  if (marker === undefined) return;
  try { writeFileSync(cleanShutdownMarkerPath(path), marker, { mode: 0o600 }); }
  catch { /* Best effort: a missing marker only costs the next open its verification. */ }
}

// The integrity check copies the whole database and scans it, which is work proportional to the
// FILE — startup paid it every time, on a network filesystem, for a database that is mostly
// free pages. It exists to catch corruption, and a database closed cleanly by the process that
// owned it is not a plausible place for corruption to have appeared. So the check now runs
// where it earns its cost: after an unclean exit, or when the marker does not describe the file
// actually on disk.
function verifiedByCleanShutdown(path: string): boolean {
  let recorded: string;
  try { recorded = readFileSync(cleanShutdownMarkerPath(path), "utf8").trim(); }
  catch { return false; }
  const actual = cleanShutdownMarker(path);
  return actual !== undefined && recorded === actual;
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Database {
  if (path !== ":memory:") {
    const state = existingFileState(path);
    if (state === "nonempty" && !(options.verifyIntegrity === false || verifiedByCleanShutdown(path))) {
      assertQiYanDatabase(path, options.closeInspector ?? ((inspector) => { inspector.close(); }));
    }
    // Consumed: the database is about to be written, so the marker no longer describes it and
    // a crash from here on must fall back to verifying.
    try { rmSync(cleanShutdownMarkerPath(path), { force: true }); } catch { /* nothing to consume */ }
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
  let verdict: "foreign" | "integrity" | "valid" | "cleanup" = "foreign";
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
        if (verdict === "valid") verdict = "cleanup";
        try { inspector.close(); } catch { /* Preserve the sanitized verdict. */ }
      }
    }
    if (inspection) {
      try { inspection.cleanup(); }
      catch { if (verdict === "valid") verdict = "cleanup"; }
    }
  }
  if (verdict !== "valid") {
    if (verdict === "foreign") throw new AppError("CONFIGURATION_ERROR", "not a QiYan Bot state database");
    if (verdict === "cleanup") throw new AppError("CONFIGURATION_ERROR", inspectionCleanupFailure);
    throw new DatabaseIntegrityError();
  }
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

// Batches many reads into one transaction. On this deployment the database sits on an NFS home so
// it can be shared across nodes, and every implicit transaction there costs a byte-range lock
// cycle plus a change-counter re-read over the wire -- about 16ms per statement, measured. A read
// path built from ~100 small statements therefore took ~1.7s of pure round trips; the same
// statements inside one transaction took 1ms.
//
// DEFERRED, not IMMEDIATE: the batch must not take a write lock, so a concurrent writer still
// acquires RESERVED and buffers its work. Be precise about what this does NOT promise -- once the
// batch's first read has taken SHARED, a writer's COMMIT needs EXCLUSIVE and waits for the batch
// to finish. Within one process that is unreachable, because the batch is synchronous and no other
// JS runs during it; the window equals the event-loop block this exists to shrink. It is reachable
// for a second instance sharing the database, and a batch outlasting that writer's busy_timeout
// fails its write outright -- which is why keeping batches short matters, not just fast.
//
// The reads also become mutually consistent, which is a correctness gain rather than a cost.
//
// Nested use is a no-op so callers can batch without knowing their context. That is sound only
// because no path reaches a batch with a WRITE transaction already open; if one ever does, the
// batch would read that writer's uncommitted rows and lengthen its lock window.
export function inReadTransaction<T>(db: Database, action: () => T): T {
  if (db.isTransaction) return action();
  db.exec("BEGIN DEFERRED");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    // Preserve the read failure, but do not hide a failed rollback: it leaves the transaction open,
    // and every later write on this connection then fails until restart.
    try { db.exec("ROLLBACK"); }
    catch (rollbackFailure) { (error as { rollbackFailed?: unknown }).rollbackFailed = rollbackFailure; }
    throw error;
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
