import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface WebFilesDeps {
  // The managed project directory for a session nickname (a root the browser may reach).
  projectDir(nickname: string): string | undefined;
  // Every root a mentioned path may resolve against (all local project dirs + the upload store).
  allRoots(): string[];
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
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? undefined : realTarget;
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
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return realTarget;
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
