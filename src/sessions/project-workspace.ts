import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path/posix";
import { AppError } from "../core/errors.ts";
import { LocalWorkspaceHost, type WorkspaceHost } from "../endpoints/ssh-host.ts";

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
  private readonly host: WorkspaceHost;
  // projectedCanonical() of the CONSTANT paths (user home + protected QiYan dirs) memoized for the
  // life of this policy instance — one endpoint generation, where those paths are stable. This turns
  // assertSafe()/resolveUserPath() from per-call ssh round-trips into cached string comparisons on a
  // remote host. Only successful resolutions are cached (projectedCanonical can walk-up/throw).
  private readonly resolvedConstants = new Map<string, string>();

  constructor(options: {
    userHome: string;
    qiyanHome: string;
    assistantWorkdir: string;
    dataDir: string;
    registryPath: string;
    defaultProjectsRoot?: string;
    host?: WorkspaceHost;
  }) {
    this.requestedUserHome = resolve(options.userHome);
    this.requestedQiYanHome = resolve(options.qiyanHome);
    this.requestedAssistantWorkdir = resolve(options.assistantWorkdir);
    this.requestedDataDir = resolve(options.dataDir);
    this.requestedRegistryDir = resolve(dirname(options.registryPath));
    this.requestedDefaultProjectsRoot = resolve(options.defaultProjectsRoot ?? join(this.requestedUserHome, "qiyan-projects"));
    this.host = options.host ?? new LocalWorkspaceHost(this.requestedUserHome);
  }

  async prepareCreate(nickname: string, requested?: string): Promise<PreparedProjectWorkspace> {
    this.assertNickname(nickname);
    if (requested === undefined) return this.prepareFallback(nickname);
    const path = await this.resolveUserPath(requested);
    const existed = await pathExists(this.host, path);
    const projected = await this.assertProjectedSafe(path);
    await this.host.mkdir(path, { recursive: true, mode: 0o700 });
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
    // `prepared.path` is already canonical and was validated safe when it was prepared. The only
    // pre-dispatch risk is the directory being swapped/removed/symlinked — a single lstat + device/
    // inode compare detects all of those: a swap or symlink changes `kind` or `inode`, and an
    // ancestor-symlink swap makes `lstat(path)` resolve a different inode. Re-`realpath` and the
    // paranoid double-read are redundant given the identity check (the residual race vs. the actual
    // dispatch is unchanged by read count), so drop them. One ssh round-trip.
    const value = await optionalWorkspaceEvidence(() => this.host.lstat(prepared.path));
    if (value?.kind !== "directory" || value.device !== prepared.identity.device || value.inode !== prepared.identity.inode) {
      throw managedError("project workspace changed unexpectedly");
    }
    // Retained (ssh-free after the constant-path cache): re-check the canonical path doesn't overlap
    // protected QiYan state. This is the SOLE safety re-validation on the recovery dispatch path
    // (a checkpoint-reconstructed workspace never goes through prepareExisting).
    await this.assertSafe(prepared.path);
  }

  private async prepareFallback(nickname: string): Promise<PreparedProjectWorkspace> {
    const root = this.requestedDefaultProjectsRoot;
    await this.assertProjectedSafe(root);
    await this.host.mkdir(root, { recursive: true, mode: 0o700 });
    const canonicalRoot = await this.host.realpath(root);
    await this.assertSafe(canonicalRoot);
    const leaf = join(canonicalRoot, nickname);
    await this.assertProjectedSafe(leaf);
    try { await this.host.mkdir(leaf, { recursive: false, mode: 0o700 }); }
    catch (error) {
      if (isErrno(error, "EEXIST")) throw new AppError("OPERATION_CONFLICT", `fallback project directory already exists for nickname: ${nickname}`);
      throw error;
    }
    return this.finalize(leaf, true, true);
  }

  // projectedCanonical() of a CONSTANT path (user home / protected dir), memoized per policy instance.
  // Only successful resolutions are cached — projectedCanonical can walk-up/throw for a missing path.
  private async projectedConstant(path: string): Promise<string> {
    const cached = this.resolvedConstants.get(path);
    if (cached !== undefined) return cached;
    const resolved = await projectedCanonical(this.host, path);
    this.resolvedConstants.set(path, resolved);
    return resolved;
  }

  private async resolveUserPath(requested: string): Promise<string> {
    const userHome = await this.projectedConstant(this.requestedUserHome);
    if (requested.startsWith("~/")) return resolve(userHome, requested.slice(2));
    if (!isAbsolute(requested)) throw managedError("project directory must be absolute or begin with ~/");
    return resolve(requested);
  }

  private async finalize(path: string, created: boolean, fallback: boolean, expectedCanonical?: string): Promise<PreparedProjectWorkspace> {
    const value = await optionalWorkspaceEvidence(() => this.host.lstat(path));
    if (value?.kind !== "directory") throw managedError("project workspace must be a real directory");
    const canonical = await optionalWorkspaceEvidence(() => this.host.realpath(path));
    if (!canonical) throw managedError("project workspace must be a real directory");
    if (expectedCanonical !== undefined && canonical !== expectedCanonical) {
      throw managedError("project workspace changed unexpectedly during creation");
    }
    await this.assertSafe(canonical);
    const canonicalValue = await optionalWorkspaceEvidence(() => this.host.lstat(canonical));
    if (canonicalValue?.kind !== "directory" || canonicalValue.device === undefined || canonicalValue.inode === undefined) throw managedError("project workspace identity is unavailable");
    return {
      path: canonical,
      created,
      fallback,
      identity: { device: canonicalValue.device, inode: canonicalValue.inode },
    };
  }

  private async assertProjectedSafe(path: string): Promise<string> {
    const projected = await projectedCanonical(this.host, path);
    await this.assertSafe(projected);
    return projected;
  }

  private async assertSafe(candidate: string): Promise<void> {
    const userHome = await this.projectedConstant(this.requestedUserHome);
    if (contains(candidate, userHome)) throw managedError("project workspace cannot be a broad parent of the user home");
    const protectedPaths = await Promise.all([...new Set([
      this.requestedQiYanHome,
      this.requestedAssistantWorkdir,
      this.requestedDataDir,
      this.requestedRegistryDir,
    ])].map((path) => this.projectedConstant(path)));
    for (const path of protectedPaths) {
      if (overlaps(candidate, path)) throw managedError("project workspace overlaps protected QiYan state");
    }
  }

  private assertNickname(nickname: string): void {
    if (!nicknamePattern.test(nickname)) throw managedError("session nickname must match ^[a-z0-9][a-z0-9_-]{0,63}$");
  }
}

async function projectedCanonical(host: WorkspaceHost, path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const value = await host.lstat(current);
      if (value.kind === "missing") throw Object.assign(new Error("missing"), { code: "ENOENT" });
      if (value.kind !== "directory" && missing.length > 0) throw managedError("project workspace parent must be a directory");
      const canonical = await host.realpath(current);
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

async function pathExists(host: WorkspaceHost, path: string): Promise<boolean> {
  return (await host.lstat(path)).kind !== "missing";
}

async function optionalWorkspaceEvidence<T>(read: () => Promise<T>): Promise<T | undefined> {
  try { return await read(); }
  catch (error) {
    if (error instanceof AppError) throw error;
    return undefined;
  }
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
