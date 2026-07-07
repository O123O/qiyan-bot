import {
  type BigIntStats,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { AppError } from "../core/errors.ts";
import { recoverDashboardMetadataUnderLease } from "./dashboard-metadata-recovery.ts";
import { isDatabaseIntegrityFailure, openDatabase, type Database } from "./database.ts";
import {
  isDashboardMetadataRecoveryRequired,
  SessionDashboardStore,
} from "./session-dashboard-store.ts";

interface AutomaticDashboardRecoveryOptions {
  beforeOpen?: () => void;
  openDatabase?: (path: string) => Database;
  closeDatabase?: (database: Database) => void;
  recoverDatabase?: (path: string) => Promise<unknown>;
}

const incompleteRecovery = "QiYan Bot state database has an incomplete automatic recovery; retained state requires support";
const maximumManifestBytes = 64 * 1024;
const recoveryIdentifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha256Digest = /^[0-9a-f]{64}$/u;

export async function openStateDatabaseWithAutomaticRecovery(
  databasePath: string,
  options: AutomaticDashboardRecoveryOptions = {},
): Promise<{ database: Database; dashboardStore: SessionDashboardStore; recovered: boolean }> {
  const beforeOpen = options.beforeOpen ?? (() => undefined);
  const open = options.openDatabase ?? openDatabase;
  const close = options.closeDatabase ?? ((database: Database) => { database.close(); });
  const recover = options.recoverDatabase ?? recoverDashboardMetadataUnderLease;

  try {
    return { ...openAndValidate(databasePath, beforeOpen, open, close), recovered: false };
  } catch (error) {
    if (!isAutomaticRecoveryCandidate(error)) throw error;
  }

  await recover(databasePath);
  const opened = openAndValidate(databasePath, beforeOpen, open, close);
  return { ...opened, recovered: true };
}

function openAndValidate(
  databasePath: string,
  beforeOpen: () => void,
  open: (path: string) => Database,
  close: (database: Database) => void,
): { database: Database; dashboardStore: SessionDashboardStore } {
  assertAutomaticRecoveryReady(databasePath);
  beforeOpen();
  const database = open(databasePath);
  try {
    const dashboardStore = new SessionDashboardStore(database);
    dashboardStore.assertMetadataHealthy();
    return { database, dashboardStore };
  } catch (error) {
    try { close(database); }
    catch { throw new AppError("CONFIGURATION_ERROR", "state database cleanup failed during automatic recovery"); }
    throw error;
  }
}

export function assertAutomaticRecoveryReady(databasePath: string): void {
  const expectedUid = process.geteuid?.() ?? process.getuid?.();
  if (expectedUid === undefined) throw new AppError("CONFIGURATION_ERROR", incompleteRecovery);
  const parent = dirname(databasePath);
  const canonicalBasename = basename(databasePath);
  const prefix = `.${canonicalBasename}.recovery-`;
  let canonical: BigIntStats | undefined;
  try { canonical = lstatSync(databasePath, { bigint: true }); }
  catch (error) {
    if (isErrno(error, "ENOENT")) canonical = undefined;
    else throw new AppError("CONFIGURATION_ERROR", incompleteRecovery);
  }

  let names: string[];
  try { names = readdirSync(parent).filter((name) => name.startsWith(prefix)); }
  catch (error) {
    if (canonical === undefined && isErrno(error, "ENOENT")) return;
    throw new AppError("CONFIGURATION_ERROR", incompleteRecovery);
  }

  if (names.length === 0) return;

  try {
    if (canonical === undefined || !isSafeCanonical(canonical, expectedUid)) throw new Error("unsafe canonical database");
    for (const name of names) {
      const recoveryRoot = join(parent, name);
      const root = lstatSync(recoveryRoot, { bigint: true });
      if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== BigInt(expectedUid) || (root.mode & 0o022n) !== 0n) {
        throw new Error("unsafe recovery root");
      }
      const manifest = readRecoveryManifest(join(recoveryRoot, "manifest.json"), expectedUid);
      const currentRoot = lstatSync(recoveryRoot, { bigint: true });
      if (!sameDirectoryPin(root, currentRoot) || !isTerminalManifest(manifest, canonicalBasename)) {
        throw new Error("incomplete recovery");
      }
    }
    const currentCanonical = lstatSync(databasePath, { bigint: true });
    if (!sameFilePin(canonical, currentCanonical) || !isSafeCanonical(currentCanonical, expectedUid)) {
      throw new Error("canonical database changed");
    }
  } catch {
    throw new AppError("CONFIGURATION_ERROR", incompleteRecovery);
  }
}

function readRecoveryManifest(path: string, expectedUid: number): Record<string, unknown> {
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const initial = fstatSync(descriptor, { bigint: true });
    if (
      !initial.isFile()
      || initial.isSymbolicLink()
      || initial.uid !== BigInt(expectedUid)
      || initial.nlink !== 1n
      || (initial.mode & 0o022n) !== 0n
      || initial.size <= 0n
      || initial.size > BigInt(maximumManifestBytes)
    ) throw new Error("unsafe recovery manifest");
    const bytes = Buffer.alloc(Number(initial.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read === 0) throw new Error("short recovery manifest");
      offset += read;
    }
    const afterRead = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (!sameFilePin(initial, afterRead) || !sameFilePin(afterRead, current)) {
      throw new Error("recovery manifest changed");
    }
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid recovery manifest");
    return parsed as Record<string, unknown>;
  } finally {
    closeSync(descriptor);
  }
}

function isSafeCanonical(value: BigIntStats, expectedUid: number): boolean {
  return value.isFile()
    && !value.isSymbolicLink()
    && value.uid === BigInt(expectedUid)
    && value.nlink === 1n
    && value.size > 0n;
}

function sameFilePin(left: BigIntStats, right: BigIntStats): boolean {
  return right.isFile()
    && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameDirectoryPin(left: BigIntStats, right: BigIntStats): boolean {
  return right.isDirectory()
    && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function isTerminalManifest(value: Record<string, unknown>, canonicalBasename: string): boolean {
  if (!hasExactKeys(value, ["artifacts", "canonical_basename", "recovery_id", "state", "version"])) return false;
  if (
    value.version !== 1
    || typeof value.recovery_id !== "string"
    || !recoveryIdentifier.test(value.recovery_id)
    || value.canonical_basename !== canonicalBasename
    || (value.state !== "installed" && value.state !== "rolled_back")
    || !Array.isArray(value.artifacts)
    || value.artifacts.length === 0
  ) return false;

  const allowedNames = new Set([
    canonicalBasename,
    `${canonicalBasename}-wal`,
    `${canonicalBasename}-shm`,
    `${canonicalBasename}-journal`,
  ]);
  const names = new Set<string>();
  for (const artifact of value.artifacts) {
    if (!isRecord(artifact) || !hasExactKeys(artifact, ["name", "sha256"])) return false;
    if (
      typeof artifact.name !== "string"
      || !allowedNames.has(artifact.name)
      || names.has(artifact.name)
      || typeof artifact.sha256 !== "string"
      || !sha256Digest.test(artifact.sha256)
    ) return false;
    names.add(artifact.name);
  }
  return names.has(canonicalBasename);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAutomaticRecoveryCandidate(error: unknown): boolean {
  return isDatabaseIntegrityFailure(error) || isDashboardMetadataRecoveryRequired(error);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
