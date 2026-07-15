import { mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

// A backend-owned store for files sent from the web UI. The UI uploads a file, the backend writes it
// here and returns its path, and the UI appends that path to the message — so the assistant/worker
// reads the file by path (the assistant never handles the bytes). Files auto-expire after `ttlMs`.
export interface WebUploadsConfig {
  dir: string;      // storage directory (created on demand)
  maxBytes: number; // per-file cap
  ttlMs: number;    // delete files older than this
}

export type UploadResult = { path: string } | { error: string };

// Persist an uploaded file under the storage dir with a unique, sanitized name; return its abs path.
export async function storeUpload(config: WebUploadsConfig, filename: string, bytes: Buffer, now: number): Promise<UploadResult> {
  if (bytes.length === 0) return { error: "empty file" };
  if (bytes.length > config.maxBytes) return { error: "file exceeds the size limit" };
  const safe = (basename(filename).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._]+/, "") || "file").slice(-96);
  await mkdir(config.dir, { recursive: true, mode: 0o700 });
  // `now`+random keeps names unique; `wx` refuses to clobber if a collision somehow occurs.
  const path = join(config.dir, `${now}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
  const handle = await open(path, "wx");
  try { await handle.write(bytes); } finally { await handle.close(); }
  return { path };
}

// Delete uploads older than the TTL. Returns how many were removed. Best-effort per file.
export async function cleanupUploads(config: WebUploadsConfig, now: number): Promise<number> {
  const names = await readdir(config.dir).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    const full = join(config.dir, name);
    const info = await stat(full).catch(() => undefined);
    if (info?.isFile() && now - info.mtimeMs > config.ttlMs) { await unlink(full).catch(() => {}); removed += 1; }
  }
  return removed;
}
