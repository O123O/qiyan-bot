import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import type { Clock } from "../core/clock.ts";
import { SystemClock } from "../core/clock.ts";
import { AppError } from "../core/errors.ts";
import type { Database } from "../storage/database.ts";
import { inTransaction } from "../storage/database.ts";

export type FileHandleId = `file_${string}`;

export interface StoredAttachment {
  id: FileHandleId;
  displayName: string;
  mediaType: string;
  size: number;
  sha256: string;
}

interface IngestMeta { displayName: string; mediaType: string; declaredSize?: number }
interface IngestPart extends IngestMeta { stream: AsyncIterable<Uint8Array | string> }

export class AttachmentStore {
  private readonly clock: Clock;
  private readonly ttlMs: number;

  constructor(
    private readonly db: Database,
    private readonly root: string,
    private readonly options: { maxFileBytes: number; maxStoreBytes: number; ttlMs?: number; clock?: Clock },
  ) {
    this.clock = options.clock ?? new SystemClock();
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60_000;
  }

  async initialize(): Promise<void> { await mkdir(this.root, { recursive: true, mode: 0o700 }); }

  async ingest(scopeId: string, stream: AsyncIterable<Uint8Array | string>, meta: IngestMeta, requestedId?: FileHandleId): Promise<StoredAttachment> {
    if (meta.declaredSize !== undefined && meta.declaredSize > this.options.maxFileBytes) this.invalid("declared attachment size exceeds limit");
    const id = requestedId ?? `file_${crypto.randomUUID()}` as FileHandleId;
    const path = resolve(this.root, id);
    if (requestedId) {
      const existing = this.get(scopeId, requestedId);
      if (existing) return existing;
      await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const value of stream) {
        const chunk = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
        size += chunk.length;
        if (size > this.options.maxFileBytes) this.invalid("attachment exceeds per-file limit");
        if (this.totalBytes() + size > this.options.maxStoreBytes) this.invalid("attachment store quota exceeded");
        hash.update(chunk);
        await file.write(chunk);
      }
      await file.sync();
    } catch (error) {
      await file.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    }
    await file.close();
    const displayName = this.sanitizeName(meta.displayName);
    const sha256 = hash.digest("hex");
    try {
      const inserted = this.db.prepare(`INSERT INTO attachments
        (id, scope_id, display_name, media_type, local_path, size, sha256, ref_count, expires_at, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, 0, ?, ?
        WHERE (SELECT COALESCE(SUM(size), 0) FROM attachments) + ? <= ?`)
        .run(id, scopeId, displayName, meta.mediaType || "application/octet-stream", path, size, sha256,
          this.clock.now() + this.ttlMs, this.clock.now(), size, this.options.maxStoreBytes).changes;
      if (inserted !== 1) this.invalid("attachment store quota exceeded");
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
    return { id, displayName, mediaType: meta.mediaType || "application/octet-stream", size, sha256 };
  }

  get(scopeId: string, id: FileHandleId): StoredAttachment | undefined {
    const row = this.db.prepare("SELECT id, display_name, media_type, size, sha256 FROM attachments WHERE id = ? AND scope_id = ?").get(id, scopeId) as Record<string, unknown> | undefined;
    return row ? { id: String(row.id) as FileHandleId, displayName: String(row.display_name), mediaType: String(row.media_type), size: Number(row.size), sha256: String(row.sha256) } : undefined;
  }

  async ingestMany(scopeId: string, parts: readonly IngestPart[], maxMessageBytes: number): Promise<StoredAttachment[]> {
    const saved: StoredAttachment[] = [];
    let total = 0;
    try {
      for (const part of parts) {
        const attachment = await this.ingest(scopeId, part.stream, part);
        total += attachment.size;
        saved.push(attachment);
        if (total > maxMessageBytes) this.invalid("attachments exceed per-message limit");
      }
      return saved;
    } catch (error) {
      for (const attachment of saved) await this.remove(attachment.id);
      throw error;
    }
  }

  toUserInput(scopeId: string, id: FileHandleId): { type: "localImage"; path: string } | { type: "mention"; name: string; path: string } {
    const row = this.required(scopeId, id);
    const path = String(row.local_path);
    return String(row.media_type).startsWith("image/")
      ? { type: "localImage", path }
      : { type: "mention", name: String(row.display_name), path };
  }

  retain(scopeId: string, id: FileHandleId): void {
    this.required(scopeId, id);
    this.db.prepare("UPDATE attachments SET ref_count = ref_count + 1 WHERE id = ?").run(id);
  }

  retainAcceptedSourceInTransaction(scopeId: string, ids: readonly FileHandleId[]): void {
    for (const id of ids) {
      this.required(scopeId, id);
      this.db.prepare("UPDATE attachments SET ref_count = ref_count + 1 WHERE id = ? AND scope_id = ?").run(id, scopeId);
    }
  }

  release(scopeId: string, id: FileHandleId): void {
    this.required(scopeId, id);
    this.db.prepare("UPDATE attachments SET ref_count = MAX(ref_count - 1, 0) WHERE id = ?").run(id);
  }

  retainForTurn(endpointId: string, threadId: string, turnId: string, scopeId: string, ids: readonly FileHandleId[]): void {
    inTransaction(this.db, () => {
      for (const id of ids) {
        this.required(scopeId, id);
        const inserted = this.db.prepare(`INSERT OR IGNORE INTO turn_attachment_refs
          (endpoint_id, thread_id, turn_id, scope_id, attachment_id) VALUES (?, ?, ?, ?, ?)`)
          .run(endpointId, threadId, turnId, scopeId, id).changes;
        if (inserted) this.db.prepare("UPDATE attachments SET ref_count = ref_count + 1 WHERE id = ?").run(id);
      }
    });
  }

  retainForOperation(holdId: string, scopeId: string, ids: readonly FileHandleId[]): void {
    inTransaction(this.db, () => {
      for (const id of ids) {
        this.required(scopeId, id);
        const inserted = this.db.prepare(`INSERT OR IGNORE INTO operation_attachment_refs
          (hold_id, scope_id, attachment_id, created_at) VALUES (?, ?, ?, ?)`)
          .run(holdId, scopeId, id, this.clock.now()).changes;
        if (inserted) this.db.prepare("UPDATE attachments SET ref_count = ref_count + 1 WHERE id = ?").run(id);
      }
    });
  }

  transferOperationToTurn(holdId: string, endpointId: string, threadId: string, turnId: string): void {
    inTransaction(this.db, () => {
      const rows = this.db.prepare("SELECT scope_id, attachment_id FROM operation_attachment_refs WHERE hold_id = ?").all(holdId) as Array<{ scope_id: string; attachment_id: string }>;
      for (const row of rows) {
        const inserted = this.db.prepare(`INSERT OR IGNORE INTO turn_attachment_refs
          (endpoint_id, thread_id, turn_id, scope_id, attachment_id) VALUES (?, ?, ?, ?, ?)`)
          .run(endpointId, threadId, turnId, row.scope_id, row.attachment_id).changes;
        if (!inserted) this.db.prepare("UPDATE attachments SET ref_count = MAX(ref_count - 1, 0) WHERE id = ?").run(row.attachment_id);
      }
      this.db.prepare("DELETE FROM operation_attachment_refs WHERE hold_id = ?").run(holdId);
    });
  }

  releaseOperation(holdId: string): void {
    inTransaction(this.db, () => {
      const rows = this.db.prepare("SELECT attachment_id FROM operation_attachment_refs WHERE hold_id = ?").all(holdId) as Array<{ attachment_id: string }>;
      for (const row of rows) this.db.prepare("UPDATE attachments SET ref_count = MAX(ref_count - 1, 0) WHERE id = ?").run(row.attachment_id);
      this.db.prepare("DELETE FROM operation_attachment_refs WHERE hold_id = ?").run(holdId);
    });
  }

  releaseTurn(endpointId: string, threadId: string, turnId: string): void {
    inTransaction(this.db, () => {
      const rows = this.db.prepare("SELECT attachment_id FROM turn_attachment_refs WHERE endpoint_id = ? AND thread_id = ? AND turn_id = ?")
        .all(endpointId, threadId, turnId) as Array<{ attachment_id: string }>;
      for (const row of rows) this.db.prepare("UPDATE attachments SET ref_count = MAX(ref_count - 1, 0) WHERE id = ?").run(row.attachment_id);
      this.db.prepare("DELETE FROM turn_attachment_refs WHERE endpoint_id = ? AND thread_id = ? AND turn_id = ?").run(endpointId, threadId, turnId);
    });
  }

  async cleanupExpired(): Promise<number> {
    const rows = this.db.prepare("SELECT id, local_path FROM attachments WHERE ref_count = 0 AND expires_at <= ?").all(this.clock.now()) as Array<{ id: string; local_path: string }>;
    for (const row of rows) {
      await unlink(row.local_path).catch(() => undefined);
      this.db.prepare("DELETE FROM attachments WHERE id = ?").run(row.id);
    }
    return rows.length;
  }

  async prepareOutbound(scopeId: string, ownerRoot: string, relativePath: string, displayName = basename(relativePath), mediaType = "application/octet-stream", requestedId?: FileHandleId): Promise<StoredAttachment> {
    if (process.platform !== "linux") this.invalid("race-safe outbound attachments require Linux");
    if (isAbsolute(relativePath) || relativePath.split(/[\\/]+/u).includes("..")) this.invalid("outbound path must remain below the project root");
    const canonicalRoot = await realpath(ownerRoot);
    const candidate = resolve(canonicalRoot, relativePath);
    if (!this.isWithin(canonicalRoot, candidate)) this.invalid("outbound path escapes the project root");
    if (requestedId) {
      const existing = this.get(scopeId, requestedId);
      if (existing) return existing;
    }
    let source: FileHandle;
    try { source = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch { return this.invalid("outbound path must be a non-symlink file"); }
    try {
      const stat = await source.stat();
      if (!stat.isFile()) this.invalid("outbound path is not a regular file");
      if (stat.size > this.options.maxFileBytes) this.invalid("outbound file exceeds limit");
      const actual = await realpath(`/proc/self/fd/${source.fd}`);
      if (!this.isWithin(canonicalRoot, actual)) this.invalid("opened file escapes the project root");
      return await this.ingest(scopeId, source.createReadStream({ autoClose: false }), { displayName, mediaType, declaredSize: stat.size }, requestedId);
    } finally {
      await source.close().catch(() => undefined);
    }
  }

  async openForUpload(scopeId: string, id: FileHandleId): Promise<{ stream: Readable; size: number; displayName: string; mediaType: string; close(): Promise<void> }> {
    const row = this.required(scopeId, id);
    const file = await open(String(row.local_path), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > this.options.maxFileBytes) {
      await file.close();
      return this.invalid("stored attachment changed or exceeds limit");
    }
    let consumed = 0;
    const source = file.createReadStream({ autoClose: false });
    const stream = Readable.from((async function* () {
      for await (const chunk of source) {
        consumed += Buffer.byteLength(chunk);
        if (consumed > stat.size) throw new AppError("ATTACHMENT_INVALID", "attachment grew during upload");
        yield chunk;
      }
    })());
    return {
      stream, size: stat.size, displayName: String(row.display_name), mediaType: String(row.media_type),
      close: async () => { source.destroy(); await file.close().catch(() => undefined); },
    };
  }

  totalBytes(): number {
    return Number((this.db.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM attachments").get() as { total: number }).total);
  }

  pathForTesting(id: FileHandleId): string { return resolve(this.root, id); }

  private required(scopeId: string, id: FileHandleId): Record<string, unknown> {
    const row = this.db.prepare("SELECT * FROM attachments WHERE id = ? AND scope_id = ?").get(id, scopeId) as Record<string, unknown> | undefined;
    if (!row) this.invalid("unknown or out-of-scope attachment handle");
    return row;
  }

  private async remove(id: string): Promise<void> {
    const row = this.db.prepare("SELECT local_path FROM attachments WHERE id = ?").get(id) as { local_path: string } | undefined;
    if (row) await unlink(row.local_path).catch(() => undefined);
    this.db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
  }

  private sanitizeName(value: string): string {
    const clean = basename(value.replace(/[\u0000-\u001f\u007f]/gu, "")).trim().slice(0, 180);
    return clean || "attachment";
  }

  private isWithin(root: string, candidate: string): boolean {
    const path = relative(root, candidate);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
  }

  private invalid(message: string): never { throw new AppError("ATTACHMENT_INVALID", message); }
}
