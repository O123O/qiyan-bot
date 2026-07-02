import { chmod, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AppError } from "../core/errors.ts";

const nicknamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const unsignedDecimalPattern = /^[0-9]+$/u;
const maxUnsigned64 = (1n << 64n) - 1n;

export interface PreparedProjectWorkspace {
  path: string;
  created: boolean;
  fallback: boolean;
  identity: { device: string; inode: string };
}

export function preparedProjectWorkspaceFromCheckpoint(value: unknown): PreparedProjectWorkspace {
  if (!value || typeof value !== "object") throw managedError("project workspace checkpoint is invalid");
  const item = value as Record<string, unknown>;
  if (typeof item.projectDir !== "string" || !isAbsolute(item.projectDir)
    || typeof item.projectDirCreated !== "boolean" || typeof item.projectDirFallback !== "boolean"
    || typeof item.projectDirDevice !== "string" || typeof item.projectDirInode !== "string"
    || !validIdentity(item.projectDirDevice) || !validIdentity(item.projectDirInode)) {
    throw managedError("project workspace checkpoint is invalid");
  }
  return {
    path: resolve(item.projectDir),
    created: item.projectDirCreated,
    fallback: item.projectDirFallback,
    identity: { device: item.projectDirDevice, inode: item.projectDirInode },
  };
}

export class ProjectWorkspacePolicy {
  private readonly requestedUserHome: string;
  private readonly requestedQiYanHome: string;
  private readonly requestedAssistantWorkdir: string;
  private readonly requestedDataDir: string;
  private readonly requestedRegistryDir: string;
  private readonly requestedDefaultProjectsRoot: string;

  constructor(options: {
    userHome: string;
    qiyanHome: string;
    assistantWorkdir: string;
    dataDir: string;
    registryPath: string;
    defaultProjectsRoot?: string;
  }) {
    this.requestedUserHome = resolve(options.userHome);
    this.requestedQiYanHome = resolve(options.qiyanHome);
    this.requestedAssistantWorkdir = resolve(options.assistantWorkdir);
    this.requestedDataDir = resolve(options.dataDir);
    this.requestedRegistryDir = resolve(dirname(options.registryPath));
    this.requestedDefaultProjectsRoot = resolve(options.defaultProjectsRoot ?? join(this.requestedUserHome, "qiyan-projects"));
  }

  async prepareCreate(nickname: string, requested?: string): Promise<PreparedProjectWorkspace> {
    this.assertNickname(nickname);
    if (requested === undefined) return this.prepareFallback(nickname);
    const path = await this.resolveUserPath(requested);
    const existed = await pathExists(path);
    const projected = await this.assertProjectedSafe(path);
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (!existed) await chmod(path, 0o700);
    return this.finalize(path, !existed, false, existed ? undefined : projected);
  }

  async prepareExisting(requested: string): Promise<PreparedProjectWorkspace> {
    const path = await this.resolveUserPath(requested);
    await this.assertProjectedSafe(path);
    return this.finalize(path, false, false);
  }

  async assertDispatchable(prepared: PreparedProjectWorkspace): Promise<void> {
    if (!validIdentity(prepared.identity.device) || !validIdentity(prepared.identity.inode)) {
      throw managedError("project workspace identity is invalid");
    }
    let value;
    try { value = await lstat(prepared.path, { bigint: true }); }
    catch { throw managedError("project workspace changed unexpectedly"); }
    if (!value.isDirectory() || value.isSymbolicLink()) throw managedError("project workspace must remain a real directory");
    const canonical = await realpath(prepared.path).catch(() => undefined);
    if (canonical !== prepared.path) throw managedError("project workspace changed unexpectedly");
    await this.assertSafe(canonical);
    const current = await lstat(prepared.path, { bigint: true }).catch(() => undefined);
    const currentCanonical = await realpath(prepared.path).catch(() => undefined);
    if (!current?.isDirectory() || current.isSymbolicLink() || currentCanonical !== prepared.path
      || current.dev !== value.dev || current.ino !== value.ino
      || current.dev !== BigInt(prepared.identity.device) || current.ino !== BigInt(prepared.identity.inode)) {
      throw managedError("project workspace changed unexpectedly");
    }
  }

  private async prepareFallback(nickname: string): Promise<PreparedProjectWorkspace> {
    const root = this.requestedDefaultProjectsRoot;
    await this.assertProjectedSafe(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(root);
    await this.assertSafe(canonicalRoot);
    const leaf = join(canonicalRoot, nickname);
    await this.assertProjectedSafe(leaf);
    try { await mkdir(leaf, { mode: 0o700 }); }
    catch (error) {
      if (isErrno(error, "EEXIST")) throw new AppError("OPERATION_CONFLICT", `fallback project directory already exists for nickname: ${nickname}`);
      throw error;
    }
    await chmod(leaf, 0o700);
    return this.finalize(leaf, true, true);
  }

  private async resolveUserPath(requested: string): Promise<string> {
    const userHome = await realpath(this.requestedUserHome);
    if (requested.startsWith("~/")) return resolve(userHome, requested.slice(2));
    if (!isAbsolute(requested)) throw managedError("project directory must be absolute or begin with ~/");
    return resolve(requested);
  }

  private async finalize(path: string, created: boolean, fallback: boolean, expectedCanonical?: string): Promise<PreparedProjectWorkspace> {
    const value = await lstat(path, { bigint: true }).catch(() => undefined);
    if (!value?.isDirectory() || value.isSymbolicLink()) throw managedError("project workspace must be a real directory");
    const canonical = await realpath(path);
    if (expectedCanonical !== undefined && canonical !== expectedCanonical) {
      throw managedError("project workspace changed unexpectedly during creation");
    }
    await this.assertSafe(canonical);
    const canonicalValue = await stat(canonical, { bigint: true });
    return {
      path: canonical,
      created,
      fallback,
      identity: { device: canonicalValue.dev.toString(10), inode: canonicalValue.ino.toString(10) },
    };
  }

  private async assertProjectedSafe(path: string): Promise<string> {
    const projected = await projectedCanonical(path);
    await this.assertSafe(projected);
    return projected;
  }

  private async assertSafe(candidate: string): Promise<void> {
    const userHome = await projectedCanonical(this.requestedUserHome);
    if (contains(candidate, userHome)) throw managedError("project workspace cannot be a broad parent of the user home");
    const protectedPaths = await Promise.all([
      this.requestedQiYanHome,
      this.requestedAssistantWorkdir,
      this.requestedDataDir,
      this.requestedRegistryDir,
    ].map(projectedCanonical));
    for (const path of protectedPaths) {
      if (overlaps(candidate, path)) throw managedError("project workspace overlaps protected QiYan state");
    }
  }

  private assertNickname(nickname: string): void {
    if (!nicknamePattern.test(nickname)) throw managedError("session nickname must match ^[a-z0-9][a-z0-9_-]{0,63}$");
  }
}

async function projectedCanonical(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const value = await lstat(current);
      if (!value.isDirectory() && missing.length > 0) throw managedError("project workspace parent must be a directory");
      const canonical = await realpath(current);
      return join(canonical, ...missing);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      const parent = dirname(current);
      if (parent === current) throw managedError("project workspace has no existing filesystem root");
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (isErrno(error, "ENOENT")) return false; throw error; }
}

function overlaps(left: string, right: string): boolean {
  return contains(left, right) || contains(right, left);
}

function contains(parent: string, child: string): boolean {
  const candidate = relative(resolve(parent), resolve(child));
  return candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate));
}

function managedError(message: string): AppError {
  return new AppError("CONFIGURATION_ERROR", message);
}

function validIdentity(value: string): boolean {
  if (!unsignedDecimalPattern.test(value)) return false;
  try { return BigInt(value) <= maxUnsigned64; } catch { return false; }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
