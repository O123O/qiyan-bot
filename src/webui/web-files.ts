import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// A `path.relative()` result escapes its root only when it is exactly ".." or begins with "../" — NOT
// when a legitimate child name merely starts with ".." (e.g. "..env", "...").
const escapes = (rel: string): boolean => rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);

// Where a session's files live: local (fs) or remote (ssh host). Drives the transport dispatch.
export interface FileTarget { transport: "local" | "remote"; projectDir: string; host?: string }

export interface WebFilesDeps {
  // The managed LOCAL project directory for a session nickname (a root the browser may reach via fs).
  projectDir(nickname: string): string | undefined;
  // Every LOCAL root a mentioned path may resolve against (all local project dirs + the upload store).
  allRoots(): string[];
  // Transport + project dir + ssh host for a session (local or remote), or undefined if not browsable.
  fileTarget(nickname: string): FileTarget | undefined;
  maxFileBytes: number;
}

export type WebFilesResult =
  | { kind: "dir"; path: string; entries: Array<{ name: string; type: "dir" | "file" | "other" }> }
  | { kind: "file"; path: string; content: string; truncated: boolean; encoding: "utf-8" | "base64" }
  | { error: string };

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

// Prove an ABSOLUTE path lives inside one of `roots` (realpath containment). Lets a mentioned absolute
// path (an upload, or any project file) be previewed from any tab without the client guessing the root.
export async function confineAbsolute(roots: string[], absPath: string): Promise<string | undefined> {
  const realTarget = await realpath(absPath).catch(() => undefined);
  if (realTarget === undefined) return undefined;
  for (const root of roots) {
    const realRoot = await realpath(root).catch(() => undefined);
    if (realRoot === undefined) continue;
    if (realTarget === realRoot) return realTarget;
    const rel = relative(realRoot, realTarget);
    if (rel !== "" && !escapes(rel)) return realTarget;
  }
  return undefined;
}

// Resolve a mentioned path to a safe real path: absolute paths against any root; relative paths under
// `sessionRoot` (the current worker's project). Undefined if it can't be confined.
export async function resolvePath(roots: string[], sessionRoot: string | undefined, path: string): Promise<string | undefined> {
  if (isAbsolute(path)) return confineAbsolute(roots, path);
  return sessionRoot ? confine(sessionRoot, path === "" ? "." : path) : undefined;
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
