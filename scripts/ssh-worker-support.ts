import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, type Stats } from "node:fs";
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
}

export const DEFAULT_SSH_PORT = 2222;
export const DEFAULT_CODEX_VERSION = "0.142.5";
export const SSH_ALIAS = "qiyan-ssh-worker";

const CONFIG_UNSAFE = /[\u0000-\u0020\u007f#$"'\\%]/u;
const OWNER_ONLY_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const KEY_STAGING_NAME = /^\.keygen-[A-Za-z0-9]{6}$/u;

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
  if ((metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) throw new Error(`${label} must have mode 0700`);
}

async function removeStagingDirectory(
  trust: FixtureTrust,
  stagingDirectory: string,
  expected?: DirectoryIdentity,
): Promise<void> {
  if (dirname(stagingDirectory) !== trust.state.path || !KEY_STAGING_NAME.test(basename(stagingDirectory))) {
    throw new Error("SSH key staging path is invalid");
  }
  await revalidateFixtureTrust(trust);
  const metadata = await optionalMetadata(stagingDirectory);
  if (metadata === undefined) return;
  assertStagingDirectory(metadata, trust.uid);
  if (expected !== undefined && (metadata.dev !== expected.device || metadata.ino !== expected.inode)) {
    throw new Error("SSH key staging directory was replaced");
  }
  await revalidateFixtureTrust(trust);
  await rm(stagingDirectory, { recursive: true, force: false });
  await revalidateFixtureTrust(trust);
}

async function cleanStaleStagingDirectories(trust: FixtureTrust): Promise<void> {
  const names = await readdir(trust.state.path);
  for (const name of names) {
    if (!KEY_STAGING_NAME.test(name)) continue;
    const stagingDirectory = join(trust.state.path, name);
    const metadata = await lstat(stagingDirectory);
    assertStagingDirectory(metadata, trust.uid);
    await removeStagingDirectory(trust, stagingDirectory, identity(stagingDirectory, metadata));
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
  const publicKeyLine = value.trim();
  const fields = publicKeyLine.split(/[\t ]+/u);
  if (fields.length < 2 || fields[0] !== "ssh-ed25519" || fields[1] === undefined || fields[1].length === 0) {
    throw new Error(`${label} is not a valid Ed25519 public key`);
  }
  if (publicKeyLine.includes("\n") || publicKeyLine.includes("\r")) {
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
  const fields = result.stdout.trim().split(/\s+/u);
  if (fields.length !== 2) throw new Error("SSH private key validation produced an invalid public key");
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

async function generateKeyPair(paths: FixturePaths, runner: CommandRunner, trust: FixtureTrust): Promise<void> {
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
      await removeStagingDirectory(trust, stagingDirectory, stagingIdentity);
    }
  }
}

export async function ensureFixtureState(
  paths: FixturePaths,
  runner: CommandRunner,
  options: FixtureOwnershipOptions = {},
): Promise<void> {
  validateFixturePaths(paths);
  const uid = currentUid(options);
  const trust = await establishFixtureTrust(paths, uid);
  await cleanStaleStagingDirectories(trust);
  await validateOptionalFixtureFiles(paths, uid);

  const clientKeyDirectory = dirname(paths.privateKey);
  const clientKeyMetadata = await optionalMetadata(clientKeyDirectory);
  if (clientKeyMetadata === undefined) {
    await generateKeyPair(paths, runner, trust);
    return;
  }
  assertPrivateDirectory(clientKeyMetadata, uid, "SSH client key directory");
  const clientKeyIdentity = identity(clientKeyDirectory, clientKeyMetadata);
  const revalidateKeyState = async (): Promise<void> => {
    await revalidateFixtureTrust(trust);
    await revalidateDirectory(
      clientKeyIdentity,
      uid,
      "SSH client key directory",
      (metadata, currentUser) => assertPrivateDirectory(metadata, currentUser, "SSH client key directory"),
    );
  };
  await validateKeyPair(paths.privateKey, paths.publicKey, runner, uid, false, revalidateKeyState);
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
    await rename(temporaryPath, paths.sshConfig);
    await revalidateFixtureTrust(trust);
    assertConfigFile(await lstat(paths.sshConfig), uid);
  } finally {
    await handle?.close();
    await removeConfigTemporaryFile(trust, temporaryPath, temporaryIdentity);
  }
}

export function buildSshArgs(paths: FixturePaths, remoteCommand: readonly string[]): string[] {
  validateFixturePaths(paths);
  return ["-F", paths.sshConfig, SSH_ALIAS, ...remoteCommand];
}
