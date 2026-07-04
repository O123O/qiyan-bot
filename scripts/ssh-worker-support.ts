import { randomUUID } from "node:crypto";
import { constants as fsConstants, lstatSync, realpathSync, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readLinuxProcessIdentity, type LinuxProcessIdentity } from "../src/core/process-identity.ts";

export interface FixturePaths {
  repositoryRoot: string;
  composeFile: string;
  stateDir: string;
  privateKey: string;
  publicKey: string;
  trustedHostKey: string;
  knownHosts: string;
  sshConfig: string;
}

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface CommandRunnerOptions {
  env?: NodeJS.ProcessEnv;
  inherit?: boolean;
  timeoutMs?: number;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandRunnerOptions,
) => Promise<CommandResult>;

export interface FixtureOwnershipOptions {
  currentUid?: number;
  beforeStaleLeaseClaim?: () => Promise<void>;
}

export type FixtureManagedStateFile = "trustedHostKey" | "knownHosts" | "sshConfig";

export interface FixtureStateTransaction {
  ensureClientKey(runner: CommandRunner): Promise<void>;
  readOwnerOnlyFile(file: FixtureManagedStateFile): Promise<string | undefined>;
  replaceOwnerOnlyFile(file: FixtureManagedStateFile, contents: string): Promise<void>;
  withOwnerOnlyTemporaryFile<T>(contents: string, operation: (path: string) => Promise<T>): Promise<T>;
  preflightGeneratedStateRemoval(): Promise<void>;
  beginReset(): Promise<void>;
  removeGeneratedState(): Promise<void>;
}

export const DEFAULT_SSH_PORT = 2222;
export const DEFAULT_CODEX_VERSION = "0.142.5";
export const SSH_ALIAS = "qiyan-ssh-worker";

const CONFIG_UNSAFE = /[\u0000-\u0020\u007f#$"'\\%]/u;
const OWNER_ONLY_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const KEY_STAGING_NAME = /^\.keygen-[A-Za-z0-9]{6}$/u;
const OPERATION_LEASE_NAME = ".operation-lease";
const OPERATION_LEASE_TEMPORARY_NAME = /^\.operation-lease-[A-Za-z0-9]{6}$/u;
const OPERATION_LEASE_QUARANTINE_NAME = /^\.operation-lease-quarantine-[a-f0-9]{32}$/u;
const OPERATION_LEASE_OWNER = "owner.json";
const MAX_OPERATION_LEASE_OWNER_BYTES = 512;
const HOST_KEY_CANDIDATE_NAME = /^\.host-key-candidate-[a-f0-9]{32}\.tmp$/u;
const CONFIG_TEMPORARY_NAME = /^\.config-[a-f0-9-]{36}\.tmp$/u;
const STATE_FILE_TEMPORARY_NAME = /^\.state-file-[a-f0-9-]{36}\.tmp$/u;
const RESET_INTENT_NAME = ".reset-intent.json";
const RESET_INTENT_CONTENTS = '{"version":1}\n';
const MAX_MANAGED_STATE_BYTES = 1024 * 1024;

interface DirectoryIdentity {
  path: string;
  device: number;
  inode: number;
}

interface FixtureTrust {
  uid: number;
  parent: DirectoryIdentity;
  state: DirectoryIdentity;
}

interface OperationLease {
  directory: DirectoryIdentity;
  ownerFile: DirectoryIdentity;
  owner: LinuxProcessIdentity;
}

function fixturePaths(repositoryRoot: string): FixturePaths {
  const stateDir = join(repositoryRoot, ".tmp", "ssh-worker");
  const privateKey = join(stateDir, "client-key", "id_ed25519");
  return {
    repositoryRoot,
    composeFile: join(repositoryRoot, "docker", "ssh-worker", "compose.yaml"),
    stateDir,
    privateKey,
    publicKey: `${privateKey}.pub`,
    trustedHostKey: join(stateDir, "trusted-host-key.pub"),
    knownHosts: join(stateDir, "known_hosts"),
    sshConfig: join(stateDir, "config"),
  };
}

export function resolveFixturePaths(repositoryRoot: string): FixturePaths {
  if (!isAbsolute(repositoryRoot) || resolve(repositoryRoot) !== repositoryRoot || CONFIG_UNSAFE.test(repositoryRoot)) {
    if (CONFIG_UNSAFE.test(repositoryRoot)) {
      throw new Error("repository root contains unsafe SSH configuration characters");
    }
    throw new Error("repository root must be an absolute canonical repository root");
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(repositoryRoot);
  } catch {
    throw new Error("repository root must be an absolute canonical repository root");
  }
  if (canonicalRoot !== repositoryRoot || !lstatSync(canonicalRoot).isDirectory()) {
    throw new Error("repository root must be an absolute canonical repository root");
  }
  return fixturePaths(canonicalRoot);
}

function validateFixturePaths(paths: FixturePaths): void {
  const expected = resolveFixturePaths(paths.repositoryRoot);
  for (const key of Object.keys(expected) as Array<keyof FixturePaths>) {
    if (paths[key] !== expected[key]) throw new Error("fixture paths do not match the canonical repository root");
  }
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SSH port must be an integer from 1 through 65535");
  }
}

function currentUid(options: FixtureOwnershipOptions): number {
  if (options.currentUid !== undefined) return options.currentUid;
  if (process.getuid === undefined) throw new Error("SSH fixture state requires a platform with user ownership metadata");
  return process.getuid();
}

async function optionalMetadata(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertOwned(metadata: Stats, uid: number, label: string): void {
  if (metadata.uid !== uid) throw new Error(`${label} must be owned by the current user`);
}

function assertOwnedRegularSingleLink(metadata: Stats, uid: number, label: string): void {
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  assertOwned(metadata, uid, label);
  if (metadata.nlink !== 1) throw new Error(`${label} must have exactly one link`);
}

function assertOwnerOnlyFile(metadata: Stats, uid: number, label: string): void {
  assertOwnedRegularSingleLink(metadata, uid, label);
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${label} must not be group- or world-accessible`);
}

function assertPrivateKey(metadata: Stats, uid: number, label: string): void {
  assertOwnerOnlyFile(metadata, uid, label);
  if ((metadata.mode & 0o177) !== 0) throw new Error(`${label} must have mode 0600 or stricter`);
}

function assertConfigFile(metadata: Stats, uid: number): void {
  const label = "SSH config";
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  assertOwned(metadata, uid, label);
  if (metadata.nlink !== 1) throw new Error(`${label} must have exactly one link`);
  if ((metadata.mode & 0o777) !== OWNER_ONLY_FILE_MODE) throw new Error(`${label} must have mode 0600`);
}

function identity(path: string, metadata: Stats): DirectoryIdentity {
  return { path, device: metadata.dev, inode: metadata.ino };
}

function assertStateParent(metadata: Stats, uid: number): void {
  const label = "SSH fixture state parent";
  if (metadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!metadata.isDirectory()) throw new Error(`${label} must be a directory`);
  assertOwned(metadata, uid, label);
  if ((metadata.mode & 0o022) !== 0) throw new Error(`${label} must not be group- or world-writable`);
}

function assertPrivateDirectory(metadata: Stats, uid: number, label: string): void {
  if (metadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!metadata.isDirectory()) throw new Error(`${label} must be a directory`);
  assertOwned(metadata, uid, label);
  if ((metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) throw new Error(`${label} must have mode 0700`);
}

async function ensureStateParent(paths: FixturePaths, uid: number): Promise<Stats> {
  const parent = dirname(paths.stateDir);
  let metadata = await optionalMetadata(parent);
  if (metadata === undefined) {
    try {
      await mkdir(parent, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    metadata = await optionalMetadata(parent);
  }
  if (metadata === undefined) throw new Error("SSH fixture state parent must be a directory");
  assertStateParent(metadata, uid);
  return metadata;
}

async function ensureStateDirectory(paths: FixturePaths, uid: number): Promise<Stats> {
  let metadata = await optionalMetadata(paths.stateDir);
  if (metadata === undefined) {
    try {
      await mkdir(paths.stateDir, { mode: PRIVATE_DIRECTORY_MODE });
      await chmod(paths.stateDir, PRIVATE_DIRECTORY_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    metadata = await optionalMetadata(paths.stateDir);
  }
  if (metadata === undefined) throw new Error("SSH fixture state directory must be a directory");
  assertPrivateDirectory(metadata, uid, "SSH fixture state directory");
  return metadata;
}

async function revalidateDirectory(
  expected: DirectoryIdentity,
  uid: number,
  label: string,
  validate: (metadata: Stats, uid: number) => void,
): Promise<Stats> {
  const metadata = await optionalMetadata(expected.path);
  if (metadata === undefined) throw new Error(`${label} was replaced or removed`);
  validate(metadata, uid);
  if (metadata.dev !== expected.device || metadata.ino !== expected.inode) {
    throw new Error(`${label} was replaced`);
  }
  return metadata;
}

async function establishFixtureTrust(paths: FixturePaths, uid: number): Promise<FixtureTrust> {
  const parentPath = dirname(paths.stateDir);
  const parentMetadata = await ensureStateParent(paths, uid);
  const stateMetadata = await ensureStateDirectory(paths, uid);
  const trust = {
    uid,
    parent: identity(parentPath, parentMetadata),
    state: identity(paths.stateDir, stateMetadata),
  };
  await revalidateDirectory(trust.parent, uid, "SSH fixture state parent", assertStateParent);
  return trust;
}

async function revalidateFixtureTrust(trust: FixtureTrust): Promise<void> {
  await revalidateDirectory(trust.parent, trust.uid, "SSH fixture state parent", assertStateParent);
  await revalidateDirectory(
    trust.state,
    trust.uid,
    "SSH fixture state directory",
    (metadata, uid) => assertPrivateDirectory(metadata, uid, "SSH fixture state directory"),
  );
}

function assertStagingDirectory(metadata: Stats, uid: number): void {
  const label = "stale SSH key staging entry";
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a regular directory`);
  }
  assertOwned(metadata, uid, label);
  if (((metadata.mode & 0o777) & ~PRIVATE_DIRECTORY_MODE) !== 0) {
    throw new Error(`${label} must have mode 0700 or a restrictive subset`);
  }
}

async function removeStagingDirectory(
  trust: FixtureTrust,
  stagingDirectory: string,
  expected?: DirectoryIdentity,
  heldLease?: OperationLease,
): Promise<void> {
  if (dirname(stagingDirectory) !== trust.state.path || !KEY_STAGING_NAME.test(basename(stagingDirectory))) {
    throw new Error("SSH key staging path is invalid");
  }
  await revalidateFixtureTrust(trust);
  if (heldLease !== undefined) await revalidateOperationLease(trust, heldLease);
  const metadata = await optionalMetadata(stagingDirectory);
  if (metadata === undefined) return;
  assertStagingDirectory(metadata, trust.uid);
  if (expected !== undefined && (metadata.dev !== expected.device || metadata.ino !== expected.inode)) {
    throw new Error("SSH key staging directory was replaced");
  }
  if ((metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    await chmod(stagingDirectory, PRIVATE_DIRECTORY_MODE);
    const normalized = await lstat(stagingDirectory);
    assertPrivateDirectory(normalized, trust.uid, "stale SSH key staging entry");
    if (normalized.dev !== metadata.dev || normalized.ino !== metadata.ino) {
      throw new Error("SSH key staging directory was replaced");
    }
  }
  await revalidateFixtureTrust(trust);
  if (heldLease !== undefined) await revalidateOperationLease(trust, heldLease);
  await rm(stagingDirectory, { recursive: true, force: false });
  await revalidateFixtureTrust(trust);
  if (heldLease !== undefined) await revalidateOperationLease(trust, heldLease);
}

async function cleanStaleStagingDirectories(trust: FixtureTrust, heldLease: OperationLease): Promise<void> {
  const names = await readdir(trust.state.path);
  for (const name of names) {
    if (!KEY_STAGING_NAME.test(name)) continue;
    const stagingDirectory = join(trust.state.path, name);
    const metadata = await lstat(stagingDirectory);
    await removeStagingDirectory(trust, stagingDirectory, identity(stagingDirectory, metadata), heldLease);
  }
}

function fixedOperationLeasePath(trust: FixtureTrust): string {
  return join(trust.state.path, OPERATION_LEASE_NAME);
}

function assertOperationLeaseDirectory(metadata: Stats, uid: number): void {
  const label = "SSH fixture operation lease";
  if (metadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!metadata.isDirectory()) throw new Error(`${label} must be a directory`);
  assertOwned(metadata, uid, label);
  if ((metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) throw new Error(`${label} must have mode 0700`);
}

function assertOperationLeaseOwner(metadata: Stats, uid: number): void {
  const label = "SSH fixture operation lease owner file";
  assertOwnedRegularSingleLink(metadata, uid, label);
  if ((metadata.mode & 0o777) !== OWNER_ONLY_FILE_MODE) throw new Error(`${label} must have mode 0600`);
  if (metadata.size <= 0 || metadata.size > MAX_OPERATION_LEASE_OWNER_BYTES) {
    throw new Error("SSH fixture operation lease is invalid");
  }
}

function parseOperationLeaseOwner(value: string): LinuxProcessIdentity {
  if (Buffer.byteLength(value, "utf8") > MAX_OPERATION_LEASE_OWNER_BYTES) {
    throw new Error("SSH fixture operation lease is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("SSH fixture operation lease is invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("SSH fixture operation lease is invalid");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "pid" || keys[1] !== "startTime") {
    throw new Error("SSH fixture operation lease is invalid");
  }
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 1) {
    throw new Error("SSH fixture operation lease is invalid");
  }
  if (typeof record.startTime !== "string" || !/^\d+$/u.test(record.startTime)) {
    throw new Error("SSH fixture operation lease is invalid");
  }
  return { pid: record.pid as number, startTime: record.startTime };
}

async function inspectOperationLease(trust: FixtureTrust, leasePath: string): Promise<OperationLease> {
  await revalidateFixtureTrust(trust);
  const directoryMetadata = await optionalMetadata(leasePath);
  if (directoryMetadata === undefined) throw new Error("SSH fixture operation lease was replaced or removed");
  assertOperationLeaseDirectory(directoryMetadata, trust.uid);
  const directory = identity(leasePath, directoryMetadata);
  const ownerPath = join(leasePath, OPERATION_LEASE_OWNER);
  const ownerMetadata = await optionalMetadata(ownerPath);
  if (ownerMetadata === undefined) throw new Error("SSH fixture operation lease is invalid");
  assertOperationLeaseOwner(ownerMetadata, trust.uid);
  const ownerFile = identity(ownerPath, ownerMetadata);
  let ownerBytes: string;
  try {
    ownerBytes = await readFile(ownerPath, "utf8");
  } catch {
    throw new Error("SSH fixture operation lease could not be verified");
  }
  const owner = parseOperationLeaseOwner(ownerBytes);
  const [currentDirectory, currentOwner] = await Promise.all([
    lstat(leasePath),
    lstat(ownerPath),
  ]);
  assertOperationLeaseDirectory(currentDirectory, trust.uid);
  assertOperationLeaseOwner(currentOwner, trust.uid);
  if (
    currentDirectory.dev !== directory.device
    || currentDirectory.ino !== directory.inode
    || currentOwner.dev !== ownerFile.device
    || currentOwner.ino !== ownerFile.inode
  ) {
    throw new Error("SSH fixture operation lease was replaced");
  }
  await revalidateFixtureTrust(trust);
  return { directory, ownerFile, owner };
}

function sameProcess(left: LinuxProcessIdentity, right: LinuxProcessIdentity): boolean {
  return left.pid === right.pid && left.startTime === right.startTime;
}

function sameOperationLease(left: OperationLease, right: OperationLease): boolean {
  return left.directory.device === right.directory.device
    && left.directory.inode === right.directory.inode
    && left.ownerFile.device === right.ownerFile.device
    && left.ownerFile.inode === right.ownerFile.inode
    && sameProcess(left.owner, right.owner);
}

async function revalidateOperationLease(trust: FixtureTrust, expected: OperationLease): Promise<void> {
  const current = await inspectOperationLease(trust, expected.directory.path);
  if (!sameOperationLease(current, expected)) throw new Error("SSH fixture operation lease was replaced");
}

function assertRemovableLeaseTemporary(metadata: Stats, uid: number): void {
  const label = "abandoned SSH fixture operation lease temporary";
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`${label} must be a regular directory`);
  assertOwned(metadata, uid, label);
  if (((metadata.mode & 0o777) & ~PRIVATE_DIRECTORY_MODE) !== 0) {
    throw new Error(`${label} must have mode 0700 or a restrictive subset`);
  }
}

async function removeLeaseTemporary(
  trust: FixtureTrust,
  temporaryPath: string,
  expected: DirectoryIdentity | undefined,
  heldLease?: OperationLease,
): Promise<void> {
  if (dirname(temporaryPath) !== trust.state.path || !OPERATION_LEASE_TEMPORARY_NAME.test(basename(temporaryPath))) {
    throw new Error("SSH fixture operation lease temporary path is invalid");
  }
  await revalidateFixtureTrust(trust);
  if (heldLease !== undefined) await revalidateOperationLease(trust, heldLease);
  const metadata = await optionalMetadata(temporaryPath);
  if (metadata === undefined) return;
  assertRemovableLeaseTemporary(metadata, trust.uid);
  if (expected !== undefined && (metadata.dev !== expected.device || metadata.ino !== expected.inode)) {
    throw new Error("SSH fixture operation lease temporary was replaced");
  }
  if ((metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    await chmod(temporaryPath, PRIVATE_DIRECTORY_MODE);
    const normalized = await lstat(temporaryPath);
    assertOperationLeaseDirectory(normalized, trust.uid);
    if (normalized.dev !== metadata.dev || normalized.ino !== metadata.ino) {
      throw new Error("SSH fixture operation lease temporary was replaced");
    }
  }
  await revalidateFixtureTrust(trust);
  if (heldLease !== undefined) await revalidateOperationLease(trust, heldLease);
  await rm(temporaryPath, { recursive: true, force: false });
  await revalidateFixtureTrust(trust);
  if (heldLease !== undefined) await revalidateOperationLease(trust, heldLease);
}

async function createOperationLeaseCandidate(trust: FixtureTrust): Promise<OperationLease> {
  let owner: LinuxProcessIdentity;
  try {
    owner = await readLinuxProcessIdentity(process.pid);
  } catch {
    throw new Error("SSH fixture operation owner could not be identified");
  }
  let temporaryPath: string | undefined;
  let directoryIdentity: DirectoryIdentity | undefined;
  let ownerHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporaryPath = await mkdtemp(join(trust.state.path, `${OPERATION_LEASE_NAME}-`));
    await chmod(temporaryPath, PRIVATE_DIRECTORY_MODE);
    const directoryMetadata = await lstat(temporaryPath);
    assertOperationLeaseDirectory(directoryMetadata, trust.uid);
    directoryIdentity = identity(temporaryPath, directoryMetadata);
    const ownerPath = join(temporaryPath, OPERATION_LEASE_OWNER);
    ownerHandle = await open(ownerPath, "wx", OWNER_ONLY_FILE_MODE);
    await ownerHandle.chmod(OWNER_ONLY_FILE_MODE);
    await ownerHandle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await ownerHandle.sync();
    await ownerHandle.close();
    ownerHandle = undefined;
    const directoryHandle = await open(temporaryPath, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    const candidate = await inspectOperationLease(trust, temporaryPath);
    if (!sameProcess(candidate.owner, owner)) throw new Error("SSH fixture operation lease is invalid");
    return candidate;
  } catch (error) {
    await ownerHandle?.close();
    if (temporaryPath !== undefined) {
      await removeLeaseTemporary(trust, temporaryPath, directoryIdentity);
    }
    throw error;
  }
}

async function operationLeaseIsStale(owner: LinuxProcessIdentity): Promise<boolean> {
  try {
    return !sameProcess(await readLinuxProcessIdentity(owner.pid), owner);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw new Error("SSH fixture operation lease could not be verified");
  }
}

async function removeFixedOperationLease(trust: FixtureTrust, expected: OperationLease): Promise<void> {
  await revalidateOperationLease(trust, expected);
  await revalidateFixtureTrust(trust);
  await rm(expected.directory.path, { recursive: true, force: false });
  await revalidateFixtureTrust(trust);
}

function relocatedOperationLease(lease: OperationLease, directoryPath: string): OperationLease {
  return {
    directory: { ...lease.directory, path: directoryPath },
    ownerFile: { ...lease.ownerFile, path: join(directoryPath, OPERATION_LEASE_OWNER) },
    owner: lease.owner,
  };
}

async function restoreUnexpectedQuarantine(trust: FixtureTrust, quarantinePath: string): Promise<never> {
  await revalidateFixtureTrust(trust);
  const fixedPath = fixedOperationLeasePath(trust);
  if (await optionalMetadata(fixedPath) === undefined) {
    try {
      await rename(quarantinePath, fixedPath);
    } catch {
      // The unexpected entry remains quarantined when safe restoration loses a race.
    }
  }
  await revalidateFixtureTrust(trust);
  throw new Error("SSH fixture operation lease was replaced during stale recovery");
}

async function removeQuarantinedOperationLease(
  trust: FixtureTrust,
  expected: OperationLease,
  heldLease?: OperationLease,
): Promise<void> {
  if (!OPERATION_LEASE_QUARANTINE_NAME.test(basename(expected.directory.path))) {
    throw new Error("SSH fixture operation lease quarantine path is invalid");
  }
  if (heldLease !== undefined) await revalidateOperationLease(trust, heldLease);
  await revalidateOperationLease(trust, expected);
  if (heldLease !== undefined) await revalidateOperationLease(trust, heldLease);
  await revalidateFixtureTrust(trust);
  await rm(expected.directory.path, { recursive: true, force: false });
  await revalidateFixtureTrust(trust);
  if (heldLease !== undefined) await revalidateOperationLease(trust, heldLease);
}

async function claimAndRemoveStaleOperationLease(
  trust: FixtureTrust,
  stale: OperationLease,
  beforeStaleLeaseClaim?: () => Promise<void>,
): Promise<boolean> {
  await beforeStaleLeaseClaim?.();
  await revalidateFixtureTrust(trust);
  const quarantinePath = join(
    trust.state.path,
    `.operation-lease-quarantine-${randomUUID().replaceAll("-", "")}`,
  );
  try {
    await rename(stale.directory.path, quarantinePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    await revalidateFixtureTrust(trust);
    if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") return false;
    throw new Error("SSH fixture operation lease could not be claimed for recovery");
  }
  await revalidateFixtureTrust(trust);
  const quarantineMetadata = await optionalMetadata(quarantinePath);
  if (
    quarantineMetadata === undefined
    || quarantineMetadata.dev !== stale.directory.device
    || quarantineMetadata.ino !== stale.directory.inode
  ) {
    return restoreUnexpectedQuarantine(trust, quarantinePath);
  }

  const expected = relocatedOperationLease(stale, quarantinePath);
  let quarantined: OperationLease;
  try {
    quarantined = await inspectOperationLease(trust, quarantinePath);
  } catch {
    return restoreUnexpectedQuarantine(trust, quarantinePath);
  }
  if (!sameOperationLease(quarantined, expected)) {
    return restoreUnexpectedQuarantine(trust, quarantinePath);
  }
  await removeQuarantinedOperationLease(trust, expected);
  return true;
}

async function installOperationLeaseCandidate(
  trust: FixtureTrust,
  candidate: OperationLease,
): Promise<OperationLease | undefined> {
  const fixedPath = fixedOperationLeasePath(trust);
  await revalidateFixtureTrust(trust);
  if (await optionalMetadata(fixedPath) !== undefined) return undefined;
  try {
    await rename(candidate.directory.path, fixedPath);
  } catch {
    await revalidateFixtureTrust(trust);
    if (await optionalMetadata(fixedPath) !== undefined) return undefined;
    throw new Error("SSH fixture operation lease could not be acquired");
  }
  const installed = await inspectOperationLease(trust, fixedPath);
  const relocatedCandidate: OperationLease = {
    directory: { ...candidate.directory, path: fixedPath },
    ownerFile: { ...candidate.ownerFile, path: join(fixedPath, OPERATION_LEASE_OWNER) },
    owner: candidate.owner,
  };
  if (!sameOperationLease(installed, relocatedCandidate)) {
    throw new Error("SSH fixture operation lease was replaced during acquisition");
  }
  return installed;
}

async function acquireOperationLease(
  trust: FixtureTrust,
  beforeStaleLeaseClaim?: () => Promise<void>,
): Promise<OperationLease> {
  const candidate = await createOperationLeaseCandidate(trust);
  let installed: OperationLease | undefined;
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      installed = await installOperationLeaseCandidate(trust, candidate);
      if (installed !== undefined) return installed;

      const fixedPath = fixedOperationLeasePath(trust);
      let existing: OperationLease;
      try {
        existing = await inspectOperationLease(trust, fixedPath);
      } catch (error) {
        await revalidateFixtureTrust(trust);
        if (await optionalMetadata(fixedPath) === undefined) continue;
        throw error;
      }
      if (!await operationLeaseIsStale(existing.owner)) {
        throw new Error("SSH fixture operation already running");
      }
      await claimAndRemoveStaleOperationLease(trust, existing, beforeStaleLeaseClaim);
    }
    throw new Error("SSH fixture operation lease could not be acquired");
  } finally {
    if (installed === undefined) {
      await removeLeaseTemporary(trust, candidate.directory.path, candidate.directory);
    }
  }
}

async function cleanAbandonedLeaseTemporaries(trust: FixtureTrust, heldLease: OperationLease): Promise<void> {
  const names = await readdir(trust.state.path);
  for (const name of names) {
    if (!OPERATION_LEASE_TEMPORARY_NAME.test(name)) continue;
    const temporaryPath = join(trust.state.path, name);
    const metadata = await lstat(temporaryPath);
    await removeLeaseTemporary(trust, temporaryPath, identity(temporaryPath, metadata), heldLease);
  }
}

async function cleanAbandonedLeaseQuarantines(trust: FixtureTrust, heldLease: OperationLease): Promise<void> {
  const names = await readdir(trust.state.path);
  for (const name of names) {
    if (!OPERATION_LEASE_QUARANTINE_NAME.test(name)) continue;
    const quarantinePath = join(trust.state.path, name);
    const quarantined = await inspectOperationLease(trust, quarantinePath);
    await removeQuarantinedOperationLease(trust, quarantined, heldLease);
  }
}

async function withOperationLease<T>(
  trust: FixtureTrust,
  operation: (lease: OperationLease) => Promise<T>,
  beforeStaleLeaseClaim?: () => Promise<void>,
): Promise<T> {
  const lease = await acquireOperationLease(trust, beforeStaleLeaseClaim);
  try {
    await cleanAbandonedLeaseTemporaries(trust, lease);
    await cleanAbandonedLeaseQuarantines(trust, lease);
    await revalidateOperationLease(trust, lease);
    return await operation(lease);
  } finally {
    await removeFixedOperationLease(trust, lease);
  }
}

async function validateOptionalFixtureFiles(paths: FixturePaths, uid: number): Promise<void> {
  const optionalFiles: ReadonlyArray<readonly [string, string, "config" | "owner-only"]> = [
    [paths.trustedHostKey, "trusted host key", "owner-only"],
    [paths.knownHosts, "known hosts file", "owner-only"],
    [paths.sshConfig, "SSH config", "config"],
  ];
  for (const [path, label, kind] of optionalFiles) {
    const metadata = await optionalMetadata(path);
    if (metadata === undefined) continue;
    if (kind === "config") assertConfigFile(metadata, uid);
    else assertOwnerOnlyFile(metadata, uid, label);
  }
}

function parsePublicKey(value: string, label: string): readonly [string, string] {
  let publicKeyLine = value;
  if (publicKeyLine.endsWith("\r\n")) publicKeyLine = publicKeyLine.slice(0, -2);
  else if (publicKeyLine.endsWith("\n")) publicKeyLine = publicKeyLine.slice(0, -1);
  if (publicKeyLine.includes("\n") || publicKeyLine.includes("\r")) {
    throw new Error(`${label} is not a valid Ed25519 public key`);
  }
  const fields = publicKeyLine.trim().split(/[\t ]+/u);
  if (fields.length < 2 || fields[0] !== "ssh-ed25519" || fields[1] === undefined || fields[1].length === 0) {
    throw new Error(`${label} is not a valid Ed25519 public key`);
  }
  return [fields[0], fields[1]];
}

async function runSshKeygen(
  runner: CommandRunner,
  args: readonly string[],
  afterCommand: () => Promise<void>,
  failureMessage: string,
): Promise<CommandResult> {
  let result: CommandResult | undefined;
  let runnerFailed = false;
  try {
    result = await runner("ssh-keygen", args);
  } catch {
    runnerFailed = true;
  }
  await afterCommand();
  if (runnerFailed || result === undefined || result.code !== 0 || result.signal !== null) {
    throw new Error(failureMessage);
  }
  return result;
}

async function derivePublicKey(
  privateKey: string,
  runner: CommandRunner,
  afterCommand: () => Promise<void>,
): Promise<readonly [string, string]> {
  const result = await runSshKeygen(
    runner,
    ["-y", "-f", privateKey],
    afterCommand,
    "SSH private key validation failed",
  );
  return parsePublicKey(result.stdout, "derived SSH public key");
}

async function validateKeyFiles(privateKey: string, publicKey: string, uid: number, generated: boolean): Promise<void> {
  const [privateMetadata, publicMetadata] = await Promise.all([
    optionalMetadata(privateKey),
    optionalMetadata(publicKey),
  ]);
  const prefix = generated ? "generated " : "";
  if (privateMetadata === undefined || publicMetadata === undefined) {
    throw new Error(`${prefix}SSH keypair is incomplete`);
  }
  assertPrivateKey(privateMetadata, uid, `${prefix}private key`);
  assertOwnerOnlyFile(publicMetadata, uid, `${prefix}public key`);
}

async function validateKeyPair(
  privateKey: string,
  publicKey: string,
  runner: CommandRunner,
  uid: number,
  generated: boolean,
  afterCommand: () => Promise<void>,
): Promise<void> {
  await validateKeyFiles(privateKey, publicKey, uid, generated);

  const derived = await derivePublicKey(privateKey, runner, afterCommand);
  await validateKeyFiles(privateKey, publicKey, uid, generated);
  const prefix = generated ? "generated " : "";
  let stored: readonly [string, string];
  try {
    stored = parsePublicKey(await readFile(publicKey, "utf8"), `${prefix}public key`);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("public key")) throw error;
    throw new Error(`${prefix}public key could not be read`);
  }
  if (derived[0] !== stored[0] || derived[1] !== stored[1]) {
    throw new Error(`${prefix}SSH public key does not match its private key`);
  }
}

async function generateKeyPair(
  paths: FixturePaths,
  runner: CommandRunner,
  trust: FixtureTrust,
  heldLease: OperationLease,
): Promise<void> {
  let stagingDirectory: string | undefined;
  let stagingIdentity: DirectoryIdentity | undefined;
  try {
    stagingDirectory = await mkdtemp(join(paths.stateDir, ".keygen-"));
    await chmod(stagingDirectory, PRIVATE_DIRECTORY_MODE);
    const stagingMetadata = await lstat(stagingDirectory);
    assertPrivateDirectory(stagingMetadata, trust.uid, "SSH key staging directory");
    stagingIdentity = identity(stagingDirectory, stagingMetadata);
    const stagedPrivateKey = join(stagingDirectory, "id_ed25519");
    const stagedPublicKey = `${stagedPrivateKey}.pub`;
    const revalidateStaging = async (): Promise<void> => {
      await revalidateFixtureTrust(trust);
      await revalidateOperationLease(trust, heldLease);
      if (stagingIdentity === undefined) throw new Error("SSH key staging directory was not pinned");
      await revalidateDirectory(
        stagingIdentity,
        trust.uid,
        "SSH key staging directory",
        (metadata, uid) => assertPrivateDirectory(metadata, uid, "SSH key staging directory"),
      );
    };

    await runSshKeygen(
      runner,
      [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        SSH_ALIAS,
        "-f",
        stagedPrivateKey,
      ],
      revalidateStaging,
      "SSH key generation failed",
    );

    const stagedPublicMetadata = await optionalMetadata(stagedPublicKey);
    if (stagedPublicMetadata === undefined) throw new Error("generated SSH keypair is incomplete");
    assertOwnedRegularSingleLink(stagedPublicMetadata, trust.uid, "generated public key");
    const stagedPublicMode = stagedPublicMetadata.mode & 0o777;
    if ((stagedPublicMode & ~0o644) !== 0) {
      throw new Error("generated public key mode must not contain permission bits outside 0644");
    }
    await chmod(stagedPublicKey, OWNER_ONLY_FILE_MODE);
    await validateKeyPair(stagedPrivateKey, stagedPublicKey, runner, trust.uid, true, revalidateStaging);

    const clientKeyDirectory = dirname(paths.privateKey);
    if (await optionalMetadata(clientKeyDirectory) !== undefined) {
      throw new Error("SSH client key directory already exists");
    }
    await revalidateStaging();
    await rename(stagingDirectory, clientKeyDirectory);

    const clientKeyMetadata = await lstat(clientKeyDirectory);
    assertPrivateDirectory(clientKeyMetadata, trust.uid, "SSH client key directory");
    if (clientKeyMetadata.dev !== stagingIdentity.device || clientKeyMetadata.ino !== stagingIdentity.inode) {
      throw new Error("SSH client key directory was replaced during installation");
    }
    await revalidateFixtureTrust(trust);
    await validateKeyFiles(paths.privateKey, paths.publicKey, trust.uid, false);
  } finally {
    if (stagingDirectory !== undefined) {
      await removeStagingDirectory(trust, stagingDirectory, stagingIdentity, heldLease);
    }
  }
}

async function ensureFixtureStateLocked(
  paths: FixturePaths,
  runner: CommandRunner,
  trust: FixtureTrust,
  heldLease: OperationLease,
): Promise<void> {
  await cleanStaleStagingDirectories(trust, heldLease);
  await revalidateOperationLease(trust, heldLease);
  await validateOptionalFixtureFiles(paths, trust.uid);
  const resetIntent = await optionalMetadata(join(paths.stateDir, RESET_INTENT_NAME));
  if (resetIntent !== undefined) {
    assertManagedStateFile(resetIntent, trust.uid, "SSH fixture reset intent");
    throw new Error("SSH worker reset is incomplete; run reset again");
  }

  const clientKeyDirectory = dirname(paths.privateKey);
  const clientKeyMetadata = await optionalMetadata(clientKeyDirectory);
  if (clientKeyMetadata === undefined) {
    await generateKeyPair(paths, runner, trust, heldLease);
    return;
  }
  assertPrivateDirectory(clientKeyMetadata, trust.uid, "SSH client key directory");
  const clientKeyIdentity = identity(clientKeyDirectory, clientKeyMetadata);
  const revalidateKeyState = async (): Promise<void> => {
    await revalidateFixtureTrust(trust);
    await revalidateOperationLease(trust, heldLease);
    await revalidateDirectory(
      clientKeyIdentity,
      trust.uid,
      "SSH client key directory",
      (metadata, currentUser) => assertPrivateDirectory(metadata, currentUser, "SSH client key directory"),
    );
  };
  await validateKeyPair(paths.privateKey, paths.publicKey, runner, trust.uid, false, revalidateKeyState);
}

export async function ensureFixtureState(
  paths: FixturePaths,
  runner: CommandRunner,
  options: FixtureOwnershipOptions = {},
): Promise<void> {
  validateFixturePaths(paths);
  const uid = currentUid(options);
  const trust = await establishFixtureTrust(paths, uid);
  await withOperationLease(
    trust,
    (heldLease) => ensureFixtureStateLocked(paths, runner, trust, heldLease),
    options.beforeStaleLeaseClaim,
  );
}

export function formatSshConfig(paths: FixturePaths, port = DEFAULT_SSH_PORT): string {
  validateFixturePaths(paths);
  validatePort(port);
  return [
    `Host ${SSH_ALIAS}`,
    "  HostName 127.0.0.1",
    `  Port ${port}`,
    "  User codex",
    `  IdentityFile ${paths.privateKey}`,
    "  IdentitiesOnly yes",
    `  UserKnownHostsFile ${paths.knownHosts}`,
    "  StrictHostKeyChecking yes",
    "  BatchMode yes",
    "  PasswordAuthentication no",
    "  KbdInteractiveAuthentication no",
    "  ForwardAgent no",
    "  ClearAllForwardings yes",
    "",
  ].join("\n");
}

async function removeConfigTemporaryFile(
  trust: FixtureTrust,
  temporaryPath: string,
  expected: DirectoryIdentity | undefined,
): Promise<void> {
  if (expected === undefined) return;
  try {
    await revalidateFixtureTrust(trust);
  } catch {
    return;
  }
  const metadata = await optionalMetadata(temporaryPath);
  if (metadata === undefined) return;
  assertConfigFile(metadata, trust.uid);
  if (metadata.dev !== expected.device || metadata.ino !== expected.inode) {
    throw new Error("SSH config temporary file was replaced");
  }
  await revalidateFixtureTrust(trust);
  await rm(temporaryPath, { force: true });
}

export async function writeSshConfig(
  paths: FixturePaths,
  port = DEFAULT_SSH_PORT,
  options: FixtureOwnershipOptions = {},
): Promise<void> {
  validateFixturePaths(paths);
  validatePort(port);
  const uid = currentUid(options);
  const trust = await establishFixtureTrust(paths, uid);
  await withOperationLease(trust, async (heldLease) => {
    const existing = await optionalMetadata(paths.sshConfig);
    if (existing !== undefined) assertConfigFile(existing, uid);
    const existingIdentity = existing === undefined ? undefined : identity(paths.sshConfig, existing);

    const temporaryPath = join(paths.stateDir, `.config-${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let temporaryIdentity: DirectoryIdentity | undefined;
    try {
      handle = await open(temporaryPath, "wx", OWNER_ONLY_FILE_MODE);
      temporaryIdentity = identity(temporaryPath, await handle.stat());
      await handle.chmod(OWNER_ONLY_FILE_MODE);
      await handle.writeFile(formatSshConfig(paths, port), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      const temporaryMetadata = await lstat(temporaryPath);
      assertConfigFile(temporaryMetadata, uid);
      if (temporaryMetadata.dev !== temporaryIdentity.device || temporaryMetadata.ino !== temporaryIdentity.inode) {
        throw new Error("SSH config temporary file was replaced");
      }

      const currentConfig = await optionalMetadata(paths.sshConfig);
      if (existingIdentity === undefined) {
        if (currentConfig !== undefined) throw new Error("SSH config appeared during replacement");
      } else {
        if (currentConfig === undefined) throw new Error("SSH config was replaced or removed");
        assertConfigFile(currentConfig, uid);
        if (currentConfig.dev !== existingIdentity.device || currentConfig.ino !== existingIdentity.inode) {
          throw new Error("SSH config was replaced");
        }
      }
      await revalidateFixtureTrust(trust);
      await revalidateOperationLease(trust, heldLease);
      await rename(temporaryPath, paths.sshConfig);
      await revalidateFixtureTrust(trust);
      await revalidateOperationLease(trust, heldLease);
      assertConfigFile(await lstat(paths.sshConfig), uid);
    } finally {
      await handle?.close();
      await removeConfigTemporaryFile(trust, temporaryPath, temporaryIdentity);
    }
  }, options.beforeStaleLeaseClaim);
}

function managedStatePath(paths: FixturePaths, file: FixtureManagedStateFile): string {
  return paths[file];
}

function assertManagedStateFile(metadata: Stats, uid: number, label: string): void {
  assertOwnedRegularSingleLink(metadata, uid, label);
  if ((metadata.mode & 0o777) !== OWNER_ONLY_FILE_MODE) {
    throw new Error(`${label} must have mode 0600`);
  }
  if (metadata.size < 0 || metadata.size > MAX_MANAGED_STATE_BYTES) {
    throw new Error(`${label} is too large`);
  }
}

async function readManagedStateFile(
  trust: FixtureTrust,
  lease: OperationLease,
  path: string,
  label: string,
): Promise<string | undefined> {
  await revalidateFixtureTrust(trust);
  await revalidateOperationLease(trust, lease);
  const pathMetadata = await optionalMetadata(path);
  if (pathMetadata === undefined) return undefined;
  assertManagedStateFile(pathMetadata, trust.uid, label);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    assertManagedStateFile(opened, trust.uid, label);
    if (opened.dev !== pathMetadata.dev || opened.ino !== pathMetadata.ino) {
      throw new Error(`${label} was replaced`);
    }
    const contents = await handle.readFile("utf8");
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(path)]);
    assertManagedStateFile(afterHandle, trust.uid, label);
    assertManagedStateFile(afterPath, trust.uid, label);
    if (
      afterHandle.dev !== pathMetadata.dev
      || afterHandle.ino !== pathMetadata.ino
      || afterPath.dev !== pathMetadata.dev
      || afterPath.ino !== pathMetadata.ino
    ) throw new Error(`${label} was replaced`);
    await revalidateFixtureTrust(trust);
    await revalidateOperationLease(trust, lease);
    return contents;
  } finally {
    await handle?.close();
  }
}

async function syncFixtureStateDirectory(trust: FixtureTrust, lease: OperationLease): Promise<void> {
  await revalidateFixtureTrust(trust);
  await revalidateOperationLease(trust, lease);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      trust.state.path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    assertPrivateDirectory(metadata, trust.uid, "SSH fixture state directory");
    if (metadata.dev !== trust.state.device || metadata.ino !== trust.state.inode) {
      throw new Error("SSH fixture state directory was replaced");
    }
    await handle.sync();
  } finally {
    await handle?.close();
  }
  await revalidateFixtureTrust(trust);
  await revalidateOperationLease(trust, lease);
}

async function removeManagedTemporary(
  trust: FixtureTrust,
  lease: OperationLease,
  path: string,
  expected: DirectoryIdentity | undefined,
): Promise<void> {
  if (expected === undefined) return;
  await revalidateFixtureTrust(trust);
  await revalidateOperationLease(trust, lease);
  const metadata = await optionalMetadata(path);
  if (metadata === undefined) return;
  assertManagedStateFile(metadata, trust.uid, "SSH fixture temporary state file");
  if (metadata.dev !== expected.device || metadata.ino !== expected.inode) {
    throw new Error("SSH fixture temporary state file was replaced");
  }
  await rm(path, { force: true });
  await revalidateFixtureTrust(trust);
  await revalidateOperationLease(trust, lease);
}

async function replaceOwnerOnlyStatePath(
  paths: FixturePaths,
  trust: FixtureTrust,
  lease: OperationLease,
  target: string,
  label: string,
  contents: string,
): Promise<void> {
  const existing = await optionalMetadata(target);
  if (existing !== undefined) assertManagedStateFile(existing, trust.uid, label);
  const existingIdentity = existing === undefined ? undefined : identity(target, existing);
  const temporaryPath = join(paths.stateDir, `.state-file-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryIdentity: DirectoryIdentity | undefined;
  try {
    handle = await open(temporaryPath, "wx", OWNER_ONLY_FILE_MODE);
    temporaryIdentity = identity(temporaryPath, await handle.stat());
    await handle.chmod(OWNER_ONLY_FILE_MODE);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const closedTemporary = await lstat(temporaryPath);
    assertManagedStateFile(closedTemporary, trust.uid, "SSH fixture temporary state file");
    if (
      temporaryIdentity === undefined
      || closedTemporary.dev !== temporaryIdentity.device
      || closedTemporary.ino !== temporaryIdentity.inode
    ) throw new Error("SSH fixture temporary state file was replaced");

    const current = await optionalMetadata(target);
    if (existingIdentity === undefined) {
      if (current !== undefined) throw new Error(`${label} appeared during replacement`);
    } else {
      if (current === undefined) throw new Error(`${label} was replaced or removed`);
      assertManagedStateFile(current, trust.uid, label);
      if (current.dev !== existingIdentity.device || current.ino !== existingIdentity.inode) {
        throw new Error(`${label} was replaced`);
      }
    }
    await revalidateFixtureTrust(trust);
    await revalidateOperationLease(trust, lease);
    const beforeRename = await lstat(temporaryPath);
    assertManagedStateFile(beforeRename, trust.uid, "SSH fixture temporary state file");
    if (beforeRename.dev !== temporaryIdentity.device || beforeRename.ino !== temporaryIdentity.inode) {
      throw new Error("SSH fixture temporary state file was replaced");
    }
    await rename(temporaryPath, target);
    await syncFixtureStateDirectory(trust, lease);
    await revalidateFixtureTrust(trust);
    await revalidateOperationLease(trust, lease);
    const installed = await lstat(target);
    assertManagedStateFile(installed, trust.uid, label);
    if (installed.dev !== temporaryIdentity.device || installed.ino !== temporaryIdentity.inode) {
      throw new Error(`${label} was replaced during installation`);
    }
  } finally {
    await handle?.close();
    await removeManagedTemporary(trust, lease, temporaryPath, temporaryIdentity);
  }
}

async function replaceManagedStateFile(
  paths: FixturePaths,
  trust: FixtureTrust,
  lease: OperationLease,
  file: FixtureManagedStateFile,
  contents: string,
): Promise<void> {
  return replaceOwnerOnlyStatePath(
    paths,
    trust,
    lease,
    managedStatePath(paths, file),
    `SSH fixture ${file}`,
    contents,
  );
}

async function cleanupManagedTemporaries(trust: FixtureTrust, lease: OperationLease): Promise<void> {
  for (const name of await readdir(trust.state.path)) {
    if (!HOST_KEY_CANDIDATE_NAME.test(name)
      && !CONFIG_TEMPORARY_NAME.test(name)
      && !STATE_FILE_TEMPORARY_NAME.test(name)) continue;
    const path = join(trust.state.path, name);
    const metadata = await lstat(path);
    await removeManagedTemporary(trust, lease, path, identity(path, metadata));
  }
}

async function preflightGeneratedStateRemoval(
  paths: FixturePaths,
  trust: FixtureTrust,
  lease: OperationLease,
): Promise<void> {
  await cleanStaleStagingDirectories(trust, lease);
  await cleanupManagedTemporaries(trust, lease);
  await revalidateFixtureTrust(trust);
  await revalidateOperationLease(trust, lease);
  const allowed = new Set([
    OPERATION_LEASE_NAME,
    RESET_INTENT_NAME,
    basename(paths.trustedHostKey),
    basename(paths.knownHosts),
    basename(paths.sshConfig),
    basename(dirname(paths.privateKey)),
  ]);
  const unexpected = (await readdir(paths.stateDir)).filter((name) => !allowed.has(name));
  if (unexpected.length !== 0) throw new Error("SSH fixture state contains unexpected files");

  await validateOptionalFixtureFiles(paths, trust.uid);
  const resetIntentPath = join(paths.stateDir, RESET_INTENT_NAME);
  const resetIntent = await readManagedStateFile(trust, lease, resetIntentPath, "SSH fixture reset intent");
  if (resetIntent !== undefined && resetIntent !== RESET_INTENT_CONTENTS) {
    throw new Error("SSH fixture reset intent is invalid");
  }

  const keyDirectory = dirname(paths.privateKey);
  const keyDirectoryMetadata = await optionalMetadata(keyDirectory);
  if (keyDirectoryMetadata !== undefined) {
    assertPrivateDirectory(keyDirectoryMetadata, trust.uid, "SSH client key directory");
    const names = (await readdir(keyDirectory)).sort();
    if (names.length !== 2 || names[0] !== "id_ed25519" || names[1] !== "id_ed25519.pub") {
      throw new Error("SSH client key directory contains unexpected state");
    }
    await validateKeyFiles(paths.privateKey, paths.publicKey, trust.uid, false);
  }
  await revalidateFixtureTrust(trust);
  await revalidateOperationLease(trust, lease);
}

async function beginReset(paths: FixturePaths, trust: FixtureTrust, lease: OperationLease): Promise<void> {
  await preflightGeneratedStateRemoval(paths, trust, lease);
  const resetIntentPath = join(paths.stateDir, RESET_INTENT_NAME);
  const existing = await readManagedStateFile(trust, lease, resetIntentPath, "SSH fixture reset intent");
  if (existing === RESET_INTENT_CONTENTS) return;
  await replaceOwnerOnlyStatePath(
    paths,
    trust,
    lease,
    resetIntentPath,
    "SSH fixture reset intent",
    RESET_INTENT_CONTENTS,
  );
}

async function removeGeneratedState(
  paths: FixturePaths,
  trust: FixtureTrust,
  lease: OperationLease,
): Promise<void> {
  await preflightGeneratedStateRemoval(paths, trust, lease);
  for (const [file, label] of [
    [paths.trustedHostKey, "trusted host key"],
    [paths.knownHosts, "known hosts file"],
    [paths.sshConfig, "SSH config"],
  ] as const) {
    const metadata = await optionalMetadata(file);
    if (metadata === undefined) continue;
    assertManagedStateFile(metadata, trust.uid, label);
    await revalidateFixtureTrust(trust);
    await revalidateOperationLease(trust, lease);
    await rm(file, { force: false });
  }

  const keyDirectory = dirname(paths.privateKey);
  const keyDirectoryMetadata = await optionalMetadata(keyDirectory);
  if (keyDirectoryMetadata !== undefined) {
    await revalidateFixtureTrust(trust);
    await revalidateOperationLease(trust, lease);
    await rm(keyDirectory, { recursive: true, force: false });
  }

  const resetIntentPath = join(paths.stateDir, RESET_INTENT_NAME);
  const resetIntent = await optionalMetadata(resetIntentPath);
  if (resetIntent !== undefined) {
    assertManagedStateFile(resetIntent, trust.uid, "SSH fixture reset intent");
    await revalidateFixtureTrust(trust);
    await revalidateOperationLease(trust, lease);
    await rm(resetIntentPath, { force: false });
    await syncFixtureStateDirectory(trust, lease);
  }

  const remaining = (await readdir(paths.stateDir)).filter((name) => name !== OPERATION_LEASE_NAME);
  if (remaining.length !== 0) throw new Error("SSH fixture state contains unexpected files");
}

export async function withFixtureStateTransaction<T>(
  paths: FixturePaths,
  operation: (transaction: FixtureStateTransaction) => Promise<T>,
  options: FixtureOwnershipOptions = {},
): Promise<T> {
  validateFixturePaths(paths);
  const uid = currentUid(options);
  const trust = await establishFixtureTrust(paths, uid);
  return withOperationLease(trust, async (lease) => {
    await cleanStaleStagingDirectories(trust, lease);
    await cleanupManagedTemporaries(trust, lease);
    await validateOptionalFixtureFiles(paths, uid);
    const transaction: FixtureStateTransaction = {
      ensureClientKey: (runner) => ensureFixtureStateLocked(paths, runner, trust, lease),
      readOwnerOnlyFile: (file) => readManagedStateFile(
        trust,
        lease,
        managedStatePath(paths, file),
        `SSH fixture ${file}`,
      ),
      replaceOwnerOnlyFile: (file, contents) => replaceManagedStateFile(paths, trust, lease, file, contents),
      withOwnerOnlyTemporaryFile: async (contents, temporaryOperation) => {
        const temporaryPath = join(
          paths.stateDir,
          `.host-key-candidate-${randomUUID().replaceAll("-", "")}.tmp`,
        );
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        let temporaryIdentity: DirectoryIdentity | undefined;
        try {
          handle = await open(temporaryPath, "wx", OWNER_ONLY_FILE_MODE);
          temporaryIdentity = identity(temporaryPath, await handle.stat());
          await handle.chmod(OWNER_ONLY_FILE_MODE);
          await handle.writeFile(contents, "utf8");
          await handle.sync();
          await handle.close();
          handle = undefined;
          await revalidateFixtureTrust(trust);
          await revalidateOperationLease(trust, lease);
          const beforeOperation = await lstat(temporaryPath);
          assertManagedStateFile(beforeOperation, uid, "SSH host key candidate");
          if (
            temporaryIdentity === undefined
            || beforeOperation.dev !== temporaryIdentity.device
            || beforeOperation.ino !== temporaryIdentity.inode
          ) throw new Error("SSH host key candidate was replaced");
          const result = await temporaryOperation(temporaryPath);
          const afterOperation = await lstat(temporaryPath);
          assertManagedStateFile(afterOperation, uid, "SSH host key candidate");
          if (afterOperation.dev !== temporaryIdentity.device || afterOperation.ino !== temporaryIdentity.inode) {
            throw new Error("SSH host key candidate was replaced");
          }
          await revalidateFixtureTrust(trust);
          await revalidateOperationLease(trust, lease);
          return result;
        } finally {
          await handle?.close();
          await removeManagedTemporary(trust, lease, temporaryPath, temporaryIdentity);
        }
      },
      preflightGeneratedStateRemoval: () => preflightGeneratedStateRemoval(paths, trust, lease),
      beginReset: () => beginReset(paths, trust, lease),
      removeGeneratedState: () => removeGeneratedState(paths, trust, lease),
    };
    return operation(transaction);
  }, options.beforeStaleLeaseClaim);
}

export function buildSshArgs(paths: FixturePaths, remoteCommand: readonly string[]): string[] {
  validateFixturePaths(paths);
  return ["-F", paths.sshConfig, SSH_ALIAS, ...remoteCommand];
}
