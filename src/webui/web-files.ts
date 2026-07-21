import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// A `path.relative()` result escapes its root only when it is exactly ".." or begins with "../" — NOT
// when a legitimate child name merely starts with ".." (e.g. "..env", "...").
const escapes = (rel: string): boolean => rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);

// Where a session's files live: local (fs) or remote (ssh host). Drives the transport dispatch.
export interface FileTarget { transport: "local" | "remote"; projectDir: string; host?: string }

export interface WebFilesDeps {
  // The managed LOCAL project directory for a session nickname (a root the browser may reach via fs).
  projectDir(nickname: string): string | undefined;
  // Transport + project dir + ssh host for a session (local or remote), or undefined if not browsable.
  fileTarget(nickname: string): FileTarget | undefined;
  // Home of the OS user running QiYan. Enables the owner-only, read-only filesystem browser.
  userHome?: string;
  maxFileBytes: number;
}

export type WebFilesResult =
  | { kind: "dir"; path: string; entries: Array<{ name: string; type: "dir" | "file" | "other" }> }
  | { kind: "file"; path: string; content: string; truncated: boolean; encoding: "utf-8" | "base64" }
  | { error: string };

export type WebFileWriteResult = { ok: true; path: string } | { error: string };

export function validFileName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

// Resolve `relPath` under `root` and PROVE (via realpath) the result stays inside the real root —
// so no `..`, absolute path, or symlink can escape. There is no OS sandbox on this process, so this
// confinement is the whole security boundary for file browsing.
export async function confine(root: string, relPath: string): Promise<string | undefined> {
  if (isAbsolute(relPath) || relPath.split(/[\\/]+/u).includes("..")) return undefined;
  const realRoot = await realpath(root).catch(() => undefined);
  if (realRoot === undefined) return undefined;
  const realTarget = await realpath(resolve(realRoot, relPath)).catch(() => undefined);
  if (realTarget === undefined) return undefined;
  if (realTarget === realRoot) return realRoot;
  const rel = relative(realRoot, realTarget);
  return rel === "" || escapes(rel) ? undefined : realTarget;
}

// Resolve a mentioned/preview path for streaming. The web UI is owner-only (token-gated) and the file
// process runs as the user, so a PREVIEW may open ANY file the user can read — the OS's read permission
// is the boundary (serveRaw still enforces regular-file + existence). Deliberately NOT confined to
// project roots, unlike browse/git: a worker legitimately references files outside its project dir
// (configs, logs, ~/.…), and the user asked to preview those. An absolute path is used as-is; a relative
// path is joined under `sessionRoot` (the current worker's project). Undefined if relative with no root.
export function resolvePath(sessionRoot: string | undefined, path: string): string | undefined {
  if (isAbsolute(path)) return path;
  return sessionRoot ? join(sessionRoot, path === "" ? "." : path) : undefined;
}

// Read a confined regular file (rejecting symlinks), capped at maxBytes. Binary → base64.
export async function readConfinedFile(target: string, displayPath: string, maxBytes: number): Promise<WebFilesResult> {
  const info = await stat(target).catch(() => undefined);
  if (info === undefined) return { error: "not found" };
  if (!info.isFile()) return { error: "not a regular file" };
  const linkInfo = await lstat(target).catch(() => undefined);
  if (linkInfo?.isSymbolicLink()) return { error: "path not allowed" };
  const truncated = info.size > maxBytes;
  const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
  const handle = await open(target, "r");
  try { await handle.read(buffer, 0, buffer.length, 0); } finally { await handle.close(); }
  return buffer.includes(0)
    ? { kind: "file", path: displayPath, content: buffer.toString("base64"), truncated, encoding: "base64" }
    : { kind: "file", path: displayPath, content: buffer.toString("utf-8"), truncated, encoding: "utf-8" };
}

// Create an empty file or a directory under a session's project, confined. The PARENT must already
// exist inside the root (confine requires existence); the new leaf name must be a plain name.
export async function createEntry(deps: WebFilesDeps, nickname: string, relPath: string, kind: "file" | "dir"): Promise<{ ok: true; path: string } | { error: string }> {
  const root = deps.projectDir(nickname);
  if (root === undefined) return { error: "unknown session" };
  const name = basename(relPath);
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) return { error: "invalid name" };
  const parentRel = dirname(relPath);
  const parent = await confine(root, parentRel === "." || parentRel === "" ? "." : parentRel);
  if (parent === undefined) return { error: "path not allowed" };
  const target = join(parent, name);
  if (await stat(target).catch(() => undefined)) return { error: "already exists" };
  try {
    if (kind === "dir") await mkdir(target);
    else { const handle = await open(target, "wx"); await handle.close(); }
    return { ok: true, path: relPath };
  } catch (error) { return { error: error instanceof Error ? error.message : "create failed" }; }
}

async function writeNewFile(parent: string, name: string, bytes: Buffer, displayPath: string): Promise<WebFileWriteResult> {
  if (!validFileName(name)) return { error: "invalid name" };
  const info = await stat(parent).catch(() => undefined);
  if (!info?.isDirectory()) return { error: "destination is not a directory" };
  const target = join(parent, name);
  const temporary = join(parent, `.qiyan-upload-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(temporary, "wx", 0o600);
  } catch {
    return { error: "upload failed" };
  }
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    try { await link(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return { error: "already exists" };
      return { error: "upload failed" };
    }
    return { ok: true, path: displayPath };
  } catch {
    await handle.close().catch(() => {});
    return { error: "upload failed" };
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

// Store one browser upload beneath a worker's project. The parent must already exist and resolve
// inside the project; a hard link publishes the staged inode atomically and refuses overwrites.
export async function uploadConfinedFile(deps: WebFilesDeps, nickname: string, relPath: string, bytes: Buffer): Promise<WebFileWriteResult> {
  if (bytes.length > deps.maxFileBytes) return { error: "file exceeds the size limit" };
  if (isAbsolute(relPath) || relPath.split(/[\\/]+/u).includes("..")) return { error: "path not allowed" };
  const root = deps.projectDir(nickname);
  if (root === undefined) return { error: "unknown session" };
  const name = basename(relPath);
  const parentRel = dirname(relPath);
  const parent = await confine(root, parentRel === "." || parentRel === "" ? "." : parentRel);
  if (parent === undefined) return { error: "path not allowed" };
  return writeNewFile(parent, name, bytes, relPath);
}

// QiYan's owner-only filesystem browser uses OS permissions as its boundary, so uploads follow the
// same policy: resolve the existing destination directory, then create one new non-overwriting file.
export async function uploadReadableFile(home: string, requestedPath: string, bytes: Buffer, maxBytes: number): Promise<WebFileWriteResult> {
  if (bytes.length > maxBytes) return { error: "file exceeds the size limit" };
  const candidate = requestedPath.startsWith("~/")
    ? resolve(home, requestedPath.slice(2))
    : isAbsolute(requestedPath) ? requestedPath : resolve(home, requestedPath);
  const name = basename(candidate);
  const parent = await realpath(dirname(candidate)).catch(() => undefined);
  if (parent === undefined) return { error: "destination is not accessible" };
  return writeNewFile(parent, name, bytes, join(parent, name));
}

// List a directory or read a file, confined to the named session's project directory (the file tree).
export async function browse(deps: WebFilesDeps, nickname: string, relPath: string): Promise<WebFilesResult> {
  const root = deps.projectDir(nickname);
  if (root === undefined) return { error: "unknown session" };
  const target = await confine(root, relPath === "" ? "." : relPath);
  if (target === undefined) return { error: "path not allowed" };

  const info = await stat(target).catch(() => undefined);
  if (info === undefined) return { error: "not found" };

  if (info.isDirectory()) {
    const dirents = await readdir(target, { withFileTypes: true }).catch(() => []);
    const entries = dirents.map((entry) => ({
      name: entry.name,
      // Symlinks/sockets/etc. are "other" (never followed for listing) so the client doesn't
      // present them as traversable directories.
      type: entry.isDirectory() ? "dir" as const : entry.isFile() ? "file" as const : "other" as const,
    })).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return { kind: "dir", path: relPath, entries };
  }
  return readConfinedFile(target, relPath, deps.maxFileBytes);
}

// Browse any path readable by the OS user running QiYan. This is intentionally separate from the
// project-confined worker browser: the token-gated QiYan tab is read-only and defaults to `home`,
// while file creation, command execution, and Git operations remain session-scoped.
export async function browseReadablePath(home: string, requestedPath: string, maxFileBytes: number): Promise<WebFilesResult> {
  const candidate = requestedPath === "" || requestedPath === "~"
    ? home
    : requestedPath.startsWith("~/")
      ? resolve(home, requestedPath.slice(2))
      : isAbsolute(requestedPath) ? requestedPath : resolve(home, requestedPath);
  const target = await realpath(candidate).catch(() => undefined);
  if (target === undefined) return { error: "not found" };
  const info = await stat(target).catch(() => undefined);
  if (info === undefined) return { error: "not readable" };
  if (!info.isDirectory()) return readConfinedFile(target, target, maxFileBytes);
  try {
    const dirents = await readdir(target, { withFileTypes: true });
    const entries = (await Promise.all(dirents.map(async (entry) => {
      const linkedInfo = entry.isSymbolicLink()
        ? await stat(join(target, entry.name)).catch(() => undefined)
        : undefined;
      return {
        name: entry.name,
        type: entry.isDirectory() || linkedInfo?.isDirectory()
          ? "dir" as const
          : entry.isFile() || linkedInfo?.isFile() ? "file" as const : "other" as const,
      };
    }))).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return { kind: "dir", path: target, entries };
  } catch {
    return { error: "not readable" };
  }
}
