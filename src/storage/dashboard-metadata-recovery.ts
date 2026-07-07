import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AppError } from "../core/errors.ts";
import { installConversationRoutingGuards } from "./conversation-cutover.ts";
import { openDatabase, type Database } from "./database.ts";
import { acquireDatabaseLease } from "./database-lease.ts";
import { migrations } from "./migrations.ts";
import { assertRecoverySchema, recoveryColumns, RECOVERY_TABLES, type RecoveryTable } from "./recovery-schema.ts";

export { RECOVERY_TABLES } from "./recovery-schema.ts";

const artifactSuffixes = ["", "-wal", "-shm", "-journal"] as const;
const recoveryFailure = "QiYan Bot state database recovery failed; retained backup was not installed";
const unsafeSource = "QiYan Bot state database recovery source is unsafe";
const installValidationFailure = "QiYan Bot state database recovery installation validation failed; candidate was not installed";
const restoredInstallFailure = "QiYan Bot state database recovery installation failed; original state was restored";
const manualRestoreFailure = "QiYan Bot state database recovery installation failed; manual restore is required from retained quarantine";
const installedManifestFailure = "QiYan Bot state database recovery installed the candidate, but final manifest sync failed; keep the service stopped";
const leaseCleanupFailure = "QiYan Bot state database recovery completed, but database lease cleanup failed; keep the service stopped";

interface DirectoryPin {
  path: string;
  dev: bigint;
  ino: bigint;
  uid: bigint;
  mode: bigint;
}

interface ArtifactPin {
  suffix: typeof artifactSuffixes[number];
  name: string;
  path: string;
  dev: bigint;
  ino: bigint;
  uid: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  digest: string;
}

interface RecoveryInternals {
  databasePath: string;
  artifacts: readonly ArtifactPin[];
  candidate: ArtifactPin;
  expectedUid: number;
  manifest: Readonly<Record<string, unknown>>;
  parent: DirectoryPin;
}

export interface PreparedDashboardMetadataRecovery {
  readonly quarantinePath: string;
  readonly candidatePath: string;
  readonly copiedTableCount: number;
  readonly nextObservationSequence: number;
}

interface RecoveryOptions {
  expectedUid?: number;
  afterParentValidation?: () => Promise<void>;
  beforeBackupComplete?: (quarantinePath: string) => Promise<void>;
  onBackupComplete?: (quarantinePath: string) => void;
}

export type RecoveryInstallStep =
  | "write-installing"
  | "move-original"
  | "install-candidate"
  | "sync-installed"
  | "write-installed"
  | "sync-installed-manifest"
  | "restore-candidate"
  | "restore-original"
  | "sync-rolled-back"
  | "write-rolled-back";

export interface RecoveryInstallOptions {
  beforeStep?: (step: RecoveryInstallStep, detail?: string) => Promise<void>;
}

export interface DashboardMetadataRecoveryOptions {
  expectedUid?: number;
  onBackupComplete?: (quarantinePath: string) => void;
  installOptions?: RecoveryInstallOptions;
  acquireLease?: (
    databasePath: string,
    options: { expectedUid?: number },
  ) => Promise<{ release(): Promise<void> }>;
}

const preparedInternals = new WeakMap<PreparedDashboardMetadataRecovery, RecoveryInternals>();

export async function prepareDashboardMetadataRecovery(
  databasePath: string,
  options: RecoveryOptions = {},
): Promise<PreparedDashboardMetadataRecovery> {
  const expectedUid = options.expectedUid ?? process.geteuid?.() ?? process.getuid?.();
  if (expectedUid === undefined) throw configuration(unsafeSource);
  let quarantinePath: string | undefined;
  let candidatePath: string | undefined;
  let backupComplete = false;
  try {
    const parentPin = await validateRecoveryParent(databasePath, expectedUid);
    await options.afterParentValidation?.();
    await assertRecoveryParent(parentPin);
    const parent = parentPin.path;
    const artifacts = await captureArtifactSet(databasePath, expectedUid);
    quarantinePath = join(parent, `.${basename(databasePath)}.recovery-${randomUUID()}`);
    const backupRoot = join(quarantinePath, "backup");
    const workingRoot = join(quarantinePath, "working");
    await mkdir(quarantinePath, { mode: 0o700 });
    await mkdir(backupRoot, { mode: 0o700 });
    await mkdir(workingRoot, { mode: 0o700 });

    for (const artifact of artifacts) {
      const backupDigest = await copyPinnedArtifact(artifact, join(backupRoot, artifact.name));
      const workingDigest = await copyPinnedArtifact(artifact, join(workingRoot, artifact.name));
      if (backupDigest !== artifact.digest || workingDigest !== artifact.digest) throw new Error("copy mismatch");
    }
    await syncDirectory(backupRoot);
    await syncDirectory(workingRoot);

    for (const artifact of artifacts) {
      if (await digestSafeCopy(join(backupRoot, artifact.name), expectedUid) !== artifact.digest) throw new Error("backup changed");
      if (await digestSafeCopy(join(workingRoot, artifact.name), expectedUid) !== artifact.digest) throw new Error("working copy changed");
    }
    await options.beforeBackupComplete?.(quarantinePath);
    const afterCopy = await captureArtifactSet(databasePath, expectedUid);
    if (!sameArtifactSet(artifacts, afterCopy)) throw new Error("source changed during backup");
    await assertRecoveryParent(parentPin);

    const recoveryId = randomUUID();
    const manifest: Record<string, unknown> = {
      version: 1,
      recovery_id: recoveryId,
      canonical_basename: basename(databasePath),
      artifacts: artifacts.map((artifact) => ({ name: artifact.name, sha256: artifact.digest })),
      state: "backup_complete",
    };
    await writeManifest(quarantinePath, manifest);
    await syncDirectory(parent);
    backupComplete = true;
    options.onBackupComplete?.(quarantinePath);

    candidatePath = join(quarantinePath, "candidate.sqlite3");
    const built = buildCandidate(join(workingRoot, basename(databasePath)), candidatePath);
    await assertNoSidecars(candidatePath);
    await setFileModeAndSync(candidatePath, Number(artifacts[0]!.mode & 0o777n));
    await syncDirectory(quarantinePath);
    const candidate = await captureArtifact(candidatePath, "", expectedUid);

    const prepared: PreparedDashboardMetadataRecovery = {
      quarantinePath,
      candidatePath,
      copiedTableCount: built.copiedTableCount,
      nextObservationSequence: built.nextObservationSequence,
    };
    preparedInternals.set(prepared, { databasePath, artifacts, candidate, expectedUid, manifest, parent: parentPin });
    return prepared;
  } catch {
    if (candidatePath) await removeDatabaseArtifacts(candidatePath);
    if (quarantinePath && !backupComplete) await rm(quarantinePath, { recursive: true, force: true }).catch(() => undefined);
    throw configuration(backupComplete ? recoveryFailure : unsafeSource);
  }
}

export async function installPreparedDashboardMetadataRecovery(
  prepared: PreparedDashboardMetadataRecovery,
  options: RecoveryInstallOptions = {},
): Promise<void> {
  const internals = preparedInternals.get(prepared);
  if (!internals) throw configuration(restoredInstallFailure);
  preparedInternals.delete(prepared);

  const parent = dirname(internals.databasePath);
  const backupRoot = join(prepared.quarantinePath, "backup");
  const displacedRoot = join(prepared.quarantinePath, "displaced");
  const moved: ArtifactPin[] = [];
  let candidateInstalled = false;
  let installedManifestPublished = false;
  try {
    await mkdir(displacedRoot, { mode: 0o700 });
    for (const artifact of internals.artifacts) {
      const backupPath = join(backupRoot, artifact.name);
      if (await digestSafeCopy(backupPath, internals.expectedUid) !== artifact.digest) throw new Error("backup changed");
      await syncFile(backupPath);
    }
    await syncFile(prepared.candidatePath);
    await syncDirectory(backupRoot);
    await syncDirectory(displacedRoot);
    await syncDirectory(prepared.quarantinePath);
    await syncDirectory(parent);
    const currentArtifacts = await captureArtifactSet(internals.databasePath, internals.expectedUid);
    if (!sameArtifactSet(internals.artifacts, currentArtifacts)) throw new Error("source changed before installation");
    const currentCandidate = await captureArtifact(prepared.candidatePath, "", internals.expectedUid);
    if (
      currentCandidate.digest !== internals.candidate.digest
      || !sameArtifactPinState(internals.candidate, currentCandidate)
    ) throw new Error("candidate changed before installation");
    await assertRecoveryParent(internals.parent);
  } catch {
    await removeDatabaseArtifacts(prepared.candidatePath);
    throw configuration(installValidationFailure);
  }

  try {
    await options.beforeStep?.("write-installing");
    await writeManifest(prepared.quarantinePath, { ...internals.manifest, state: "installing" });

    for (const artifact of internals.artifacts) {
      await options.beforeStep?.("move-original", artifact.name);
      await rename(artifact.path, join(displacedRoot, artifact.name));
      moved.push(artifact);
    }
    await syncDirectory(displacedRoot);
    await syncDirectory(parent);

    await options.beforeStep?.("install-candidate");
    await rename(prepared.candidatePath, internals.databasePath);
    candidateInstalled = true;

    await options.beforeStep?.("sync-installed");
    await syncFile(internals.databasePath);
    await syncDirectory(parent);
    await syncDirectory(displacedRoot);
    await syncDirectory(prepared.quarantinePath);

    await options.beforeStep?.("write-installed");
    await writeManifest(prepared.quarantinePath, { ...internals.manifest, state: "installed" }, async () => {
      installedManifestPublished = true;
      await options.beforeStep?.("sync-installed-manifest");
    });
  } catch {
    if (installedManifestPublished) throw configuration(installedManifestFailure);
    try {
      if (candidateInstalled) {
        await options.beforeStep?.("restore-candidate");
        await rename(internals.databasePath, prepared.candidatePath);
        candidateInstalled = false;
      }
      for (const artifact of moved.reverse()) {
        await options.beforeStep?.("restore-original", artifact.name);
        await rename(join(displacedRoot, artifact.name), artifact.path);
      }
      await options.beforeStep?.("sync-rolled-back");
      await syncDirectory(parent);
      await syncDirectory(displacedRoot);
      await syncDirectory(prepared.quarantinePath);
      await assertRecoveryParent(internals.parent);
      const restoredArtifacts = await captureArtifactSet(internals.databasePath, internals.expectedUid);
      if (!sameRestoredArtifactSet(internals.artifacts, restoredArtifacts)) throw new Error("restored source mismatch");
      await removeDatabaseArtifactsStrict(prepared.candidatePath);
      await options.beforeStep?.("write-rolled-back");
      await writeManifest(prepared.quarantinePath, { ...internals.manifest, state: "rolled_back" });
    } catch {
      throw configuration(manualRestoreFailure);
    }
    throw configuration(restoredInstallFailure);
  }
}

export async function recoverDashboardMetadata(
  databasePath: string,
  options: DashboardMetadataRecoveryOptions = {},
): Promise<{ quarantinePath: string }> {
  const uidOption = options.expectedUid === undefined ? {} : { expectedUid: options.expectedUid };
  const lease = await (options.acquireLease ?? acquireDatabaseLease)(databasePath, uidOption);
  let primaryFailure = false;
  try {
    const prepared = await prepareDashboardMetadataRecovery(databasePath, {
      ...uidOption,
      ...(options.onBackupComplete === undefined ? {} : { onBackupComplete: options.onBackupComplete }),
    });
    await installPreparedDashboardMetadataRecovery(prepared, options.installOptions);
    return { quarantinePath: prepared.quarantinePath };
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    try { await lease.release(); }
    catch {
      if (!primaryFailure) throw configuration(leaseCleanupFailure);
    }
  }
}

async function validateRecoveryParent(databasePath: string, expectedUid: number): Promise<DirectoryPin> {
  if (!isAbsolute(databasePath) || resolve(databasePath) !== databasePath) throw new Error("path is not normalized");
  const parent = dirname(databasePath);
  if (await realpath(parent) !== parent) throw new Error("parent is not canonical");
  const initial = await lstat(parent, { bigint: true });
  if (!initial.isDirectory() || initial.isSymbolicLink() || initial.uid !== BigInt(expectedUid) || (initial.mode & 0o022n) !== 0n) {
    throw new Error("unsafe parent");
  }
  const directory = await open(parent, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await directory.stat({ bigint: true });
    if (
      !opened.isDirectory()
      || opened.dev !== initial.dev
      || opened.ino !== initial.ino
      || opened.uid !== initial.uid
      || opened.mode !== initial.mode
    ) throw new Error("parent changed");
  } finally {
    await directory.close();
  }
  const pin = { path: parent, dev: initial.dev, ino: initial.ino, uid: initial.uid, mode: initial.mode };
  await assertRecoveryParent(pin);
  return pin;
}

async function assertRecoveryParent(pin: DirectoryPin): Promise<void> {
  const current = await lstat(pin.path, { bigint: true });
  if (
    !current.isDirectory()
    || current.isSymbolicLink()
    || current.dev !== pin.dev
    || current.ino !== pin.ino
    || current.uid !== pin.uid
    || current.mode !== pin.mode
    || (current.mode & 0o022n) !== 0n
  ) throw new Error("parent changed");
}

async function captureArtifactSet(databasePath: string, expectedUid: number): Promise<ArtifactPin[]> {
  const artifacts: ArtifactPin[] = [];
  for (const suffix of artifactSuffixes) {
    const path = `${databasePath}${suffix}`;
    if (suffix !== "" && !(await pathExists(path))) continue;
    artifacts.push(await captureArtifact(path, suffix, expectedUid));
  }
  return artifacts;
}

async function captureArtifact(
  path: string,
  suffix: typeof artifactSuffixes[number],
  expectedUid: number,
): Promise<ArtifactPin> {
  const initial = await lstat(path, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink() || initial.uid !== BigInt(expectedUid) || initial.nlink !== 1n) {
    throw new Error("unsafe artifact");
  }
  const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const opened = await file.stat({ bigint: true });
    assertArtifactIdentity(initial, opened);
    const digest = await digestHandle(file, opened.size);
    const after = await file.stat({ bigint: true });
    assertArtifactIdentity(opened, after);
    const current = await lstat(path, { bigint: true });
    assertArtifactIdentity(after, current);
    return {
      suffix,
      name: basename(path),
      path,
      dev: after.dev,
      ino: after.ino,
      uid: after.uid,
      mode: after.mode,
      nlink: after.nlink,
      size: after.size,
      mtimeNs: after.mtimeNs,
      ctimeNs: after.ctimeNs,
      digest,
    };
  } finally {
    await file.close();
  }
}

function assertArtifactIdentity(left: BigIntStats, right: BigIntStats): void {
  if (
    !right.isFile()
    || right.isSymbolicLink()
    || left.dev !== right.dev
    || left.ino !== right.ino
    || left.uid !== right.uid
    || left.mode !== right.mode
    || left.nlink !== 1n
    || right.nlink !== 1n
    || left.size !== right.size
    || left.mtimeNs !== right.mtimeNs
    || left.ctimeNs !== right.ctimeNs
  ) throw new Error("artifact changed");
}

async function copyPinnedArtifact(pin: ArtifactPin, destination: string): Promise<string> {
  const source = await open(pin.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  let target: FileHandle | undefined;
  try {
    const sourceState = await source.stat({ bigint: true });
    if (!sameArtifactPinState(pin, sourceState)) throw new Error("source changed");
    target = await open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const digest = await copyHandle(source, target, pin.size);
    await target.sync();
    const after = await source.stat({ bigint: true });
    if (!sameArtifactPinState(pin, after)) throw new Error("source changed");
    return digest;
  } finally {
    await target?.close().catch(() => undefined);
    await source.close();
  }
}

async function digestSafeCopy(path: string, expectedUid: number): Promise<string> {
  return (await captureArtifact(path, "", expectedUid)).digest;
}

function sameArtifactSet(left: readonly ArtifactPin[], right: readonly ArtifactPin[]): boolean {
  return left.length === right.length && left.every((artifact, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && artifact.suffix === candidate.suffix
      && artifact.digest === candidate.digest
      && sameArtifactPinState(artifact, candidate);
  });
}

function sameRestoredArtifactSet(left: readonly ArtifactPin[], right: readonly ArtifactPin[]): boolean {
  return left.length === right.length && left.every((artifact, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && artifact.suffix === candidate.suffix
      && artifact.digest === candidate.digest
      && artifact.dev === candidate.dev
      && artifact.ino === candidate.ino
      && artifact.uid === candidate.uid
      && artifact.mode === candidate.mode
      && artifact.nlink === candidate.nlink
      && artifact.size === candidate.size
      && artifact.mtimeNs === candidate.mtimeNs;
  });
}

function sameArtifactPinState(pin: ArtifactPin, value: Pick<ArtifactPin, "dev" | "ino" | "uid" | "mode" | "nlink" | "size" | "mtimeNs" | "ctimeNs">): boolean {
  return pin.dev === value.dev
    && pin.ino === value.ino
    && pin.uid === value.uid
    && pin.mode === value.mode
    && pin.nlink === value.nlink
    && pin.size === value.size
    && pin.mtimeNs === value.mtimeNs
    && pin.ctimeNs === value.ctimeNs;
}

async function copyHandle(source: FileHandle, target: FileHandle, size: bigint): Promise<string> {
  const total = safeSize(size);
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  while (position < total) {
    const length = Math.min(buffer.length, total - position);
    const read = await source.read(buffer, 0, length, position);
    if (read.bytesRead === 0) throw new Error("unexpected eof");
    const bytes = buffer.subarray(0, read.bytesRead);
    hash.update(bytes);
    let written = 0;
    while (written < bytes.length) {
      const result = await target.write(bytes, written, bytes.length - written, position + written);
      if (result.bytesWritten === 0) throw new Error("short write");
      written += result.bytesWritten;
    }
    position += read.bytesRead;
  }
  return hash.digest("hex");
}

async function digestHandle(file: FileHandle, size: bigint): Promise<string> {
  const total = safeSize(size);
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  while (position < total) {
    const length = Math.min(buffer.length, total - position);
    const read = await file.read(buffer, 0, length, position);
    if (read.bytesRead === 0) throw new Error("unexpected eof");
    hash.update(buffer.subarray(0, read.bytesRead));
    position += read.bytesRead;
  }
  return hash.digest("hex");
}

function safeSize(size: bigint): number {
  const value = Number(size);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("unsafe size");
  return value;
}

function buildCandidate(workingDatabasePath: string, candidatePath: string): { copiedTableCount: number; nextObservationSequence: number } {
  const db = openDatabase(candidatePath);
  let attached = false;
  let transaction = false;
  try {
    // A v3-complete source must contain these guards, so install the product-owned
    // definitions before structural comparison; copied rows still pass them.
    installConversationRoutingGuards(db);
    const uri = pathToFileURL(workingDatabasePath);
    uri.searchParams.set("mode", "ro");
    db.prepare("ATTACH DATABASE ? AS damaged").run(uri.href);
    attached = true;
    assertAttachedReadOnly(db);
    assertCurrentSourceState(db);
    assertRecoverySchema(db);
    const nextObservationSequence = nextSequence(db);

    db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    transaction = true;
    for (const table of RECOVERY_TABLES) db.exec(`DELETE FROM main.${quoteIdentifier(table)}`);
    for (const table of RECOVERY_TABLES) {
      if (table === "session_dashboard_meta") continue;
      const columns = recoveryColumns(db, table);
      const columnSql = columns.map(quoteIdentifier).join(", ");
      db.exec(`INSERT INTO main.${quoteIdentifier(table)} (${columnSql}) SELECT ${columnSql} FROM damaged.${quoteIdentifier(table)}`);
    }
    db.prepare(`INSERT INTO main.session_dashboard_meta
      (singleton, assistant_root, dirty, revision, next_observation_sequence, last_render_error, render_failure_generation)
      VALUES (1, NULL, 1, 0, ?, NULL, 0)`).run(nextObservationSequence);
    db.exec("COMMIT");
    transaction = false;
    db.exec("PRAGMA foreign_keys=ON");
    if ((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: unknown }).foreign_keys !== 1) throw new Error("foreign keys disabled");

    for (const table of RECOVERY_TABLES) {
      if (table === "session_dashboard_meta") continue;
      assertCopiedTable(db, table);
    }
    assertCurrentCandidateState(db);
    assertRecoverySchema(db);
    db.exec("DETACH DATABASE damaged");
    attached = false;
    db.close();
    return { copiedTableCount: RECOVERY_TABLES.length - 1, nextObservationSequence };
  } catch (error) {
    if (transaction) try { db.exec("ROLLBACK"); } catch { /* Preserve the recovery failure. */ }
    if (attached) try { db.exec("DETACH DATABASE damaged"); } catch { /* Preserve the recovery failure. */ }
    try { db.close(); } catch { /* Preserve the recovery failure. */ }
    throw error;
  }
}

function assertAttachedReadOnly(db: Database): void {
  db.exec("SAVEPOINT verify_damaged_read_only");
  let writeSucceeded = false;
  try {
    db.exec("UPDATE damaged.qiyan_state SET state_version = state_version WHERE 0");
    writeSucceeded = true;
  } catch {
    // A mode=ro attachment must reject even a zero-row write statement.
  } finally {
    db.exec("ROLLBACK TO verify_damaged_read_only; RELEASE verify_damaged_read_only");
  }
  if (writeSucceeded) throw new Error("damaged database is writable");
}

function assertCurrentSourceState(db: Database): void {
  const marker = db.prepare("SELECT product, state_version FROM damaged.qiyan_state WHERE product = 'qiyan-bot'").get() as
    { product?: unknown; state_version?: unknown } | undefined;
  const cutover = db.prepare("SELECT phase FROM damaged.conversation_cutover WHERE singleton = 1").get() as { phase?: unknown } | undefined;
  if (marker?.product !== "qiyan-bot" || marker.state_version !== 3 || cutover?.phase !== "complete") throw new Error("unsupported source state");
  assertMigrationSet(db, "damaged");
}

function assertCurrentCandidateState(db: Database): void {
  const marker = db.prepare("SELECT product, state_version FROM main.qiyan_state WHERE product = 'qiyan-bot'").get() as
    { product?: unknown; state_version?: unknown } | undefined;
  if (marker?.product !== "qiyan-bot" || marker.state_version !== 3) throw new Error("candidate marker mismatch");
  assertMigrationSet(db, "main");
  const integrity = db.prepare("PRAGMA main.integrity_check").all() as Array<{ integrity_check?: unknown }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error("candidate integrity failed");
  const foreignKeyFailures = (db.prepare("SELECT COUNT(*) AS count FROM pragma_foreign_key_check").get() as { count?: unknown }).count;
  if (foreignKeyFailures !== 0) throw new Error("candidate foreign keys failed");
  if ((db.prepare("PRAGMA main.journal_mode").get() as { journal_mode?: unknown }).journal_mode !== "delete") throw new Error("candidate journal mismatch");
  if ((db.prepare("PRAGMA synchronous").get() as { synchronous?: unknown }).synchronous !== 3) throw new Error("candidate sync mismatch");
}

function assertMigrationSet(db: Database, schema: "main" | "damaged"): void {
  const row = db.prepare(`SELECT COUNT(*) AS count, MIN(version) AS minimum, MAX(version) AS maximum
    FROM ${schema}.schema_migrations`).get() as { count?: unknown; minimum?: unknown; maximum?: unknown };
  if (row.count !== migrations.length || row.minimum !== 1 || row.maximum !== migrations.length) throw new Error("migration set mismatch");
}

function nextSequence(db: Database): number {
  const queries = [
    "SELECT COALESCE(MAX(sequence), 0) AS value FROM damaged.session_dashboard_notifications",
    "SELECT COALESCE(MAX(current_settings_observation_sequence), 0) AS value FROM damaged.session_dashboard_facts",
    "SELECT COALESCE(MAX(token_observation_sequence), 0) AS value FROM damaged.session_dashboard_facts",
    "SELECT COALESCE(MAX(goal_observation_sequence), 0) AS value FROM damaged.session_dashboard_facts",
    "SELECT COALESCE(MAX(native_observation_sequence), 0) AS value FROM damaged.session_runtime",
  ];
  let maximum = 0;
  for (const query of queries) {
    const value = (db.prepare(query).get() as { value?: unknown }).value;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("unsafe observation sequence");
    maximum = Math.max(maximum, value);
  }
  if (!Number.isSafeInteger(maximum + 1)) throw new Error("unsafe next observation sequence");
  return maximum + 1;
}

function assertCopiedTable(db: Database, table: RecoveryTable): void {
  const columns = recoveryColumns(db, table);
  const columnSql = columns.map(quoteIdentifier).join(", ");
  const candidateCount = (db.prepare(`SELECT COUNT(*) AS count FROM main.${quoteIdentifier(table)}`).get() as { count?: unknown }).count;
  const sourceCount = (db.prepare(`SELECT COUNT(*) AS count FROM damaged.${quoteIdentifier(table)}`).get() as { count?: unknown }).count;
  if (candidateCount !== sourceCount) throw new Error("copy count mismatch");
  const forward = db.prepare(`SELECT EXISTS(
    SELECT ${columnSql} FROM main.${quoteIdentifier(table)}
    EXCEPT SELECT ${columnSql} FROM damaged.${quoteIdentifier(table)}
  ) AS differs`).get() as { differs?: unknown };
  const reverse = db.prepare(`SELECT EXISTS(
    SELECT ${columnSql} FROM damaged.${quoteIdentifier(table)}
    EXCEPT SELECT ${columnSql} FROM main.${quoteIdentifier(table)}
  ) AS differs`).get() as { differs?: unknown };
  if (forward.differs !== 0 || reverse.differs !== 0) throw new Error("copy content mismatch");
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function writeManifest(
  quarantinePath: string,
  manifest: Record<string, unknown>,
  afterRename?: () => Promise<void>,
): Promise<void> {
  const temporary = join(quarantinePath, `.manifest.${randomUUID()}.tmp`);
  const target = join(quarantinePath, "manifest.json");
  const file = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, target);
  await afterRename?.();
  await syncDirectory(quarantinePath);
}

async function setFileModeAndSync(path: string, mode: number): Promise<void> {
  const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await file.chmod(mode);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function syncFile(path: string): Promise<void> {
  const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { await file.sync(); }
  finally { await file.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try { await directory.sync(); }
  finally { await directory.close(); }
}

async function assertNoSidecars(path: string): Promise<void> {
  for (const suffix of artifactSuffixes.slice(1)) if (await pathExists(`${path}${suffix}`)) throw new Error("candidate sidecar remains");
}

async function removeDatabaseArtifacts(path: string): Promise<void> {
  for (const suffix of artifactSuffixes) await rm(`${path}${suffix}`, { force: true }).catch(() => undefined);
}

async function removeDatabaseArtifactsStrict(path: string): Promise<void> {
  for (const suffix of artifactSuffixes) await rm(`${path}${suffix}`, { force: true });
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function configuration(message: string): AppError {
  return new AppError("CONFIGURATION_ERROR", message);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
