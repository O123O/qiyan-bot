import { createHash } from "node:crypto";
import { basename, isAbsolute, posix } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import type { AttachmentStore, FileHandleId, StoredAttachment } from "../attachments/store.ts";
import { AppError } from "../core/errors.ts";
import type { MappingIdentity, SessionRegistry } from "../registry/session-registry.ts";
import type { EndpointManager } from "./manager.ts";
import type { RemoteTransferClient } from "./ssh-runtime.ts";
import type { EndpointWorkLease } from "./types.ts";

interface RemoteFileContext {
  remote: RemoteTransferClient;
  helperPath: string;
  runtimeDir: string;
}

const remoteFileSchema = z.object({
  device: z.string().regex(/^\d+$/u),
  inode: z.string().regex(/^\d+$/u),
  size: z.number().int().nonnegative(),
  mtimeNs: z.string().regex(/^\d+$/u),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  dataBase64: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
}).strict();
const uploadedFileSchema = z.object({ path: z.string(), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

export class WorkerFileBridge {
  constructor(private readonly options: {
    attachments: AttachmentStore;
    registry: Pick<SessionRegistry, "getByIdentity">;
    endpoints: Pick<EndpointManager, "validateWorkLease" | "withWorkLease">;
    remote(endpointId: string): RemoteFileContext | undefined;
    maxFileBytes: number;
  }) {}

  async toWorkerInput(input: {
    lease: EndpointWorkLease;
    mapping: MappingIdentity;
    projectRoot: string;
    scopeId: string;
    attachmentId: FileHandleId;
  }): Promise<{ type: "localImage"; path: string } | { type: "mention"; name: string; path: string }> {
    this.assertCurrent(input.mapping, input.projectRoot);
    this.assertLease(input.lease, input.mapping.endpoint);
    if (input.mapping.endpoint === "local") return this.options.attachments.toUserInput(input.scopeId, input.attachmentId);
    const context = this.requireRemote(input.mapping.endpoint);
    const stored = this.options.attachments.get(input.scopeId, input.attachmentId);
    if (!stored) throw new AppError("ATTACHMENT_INVALID", "unknown or out-of-scope attachment handle");
    const upload = await this.options.attachments.openForUpload(input.scopeId, input.attachmentId);
    try {
      const result = uploadedFileSchema.parse(await context.remote.invokeTransfer("write-file", [JSON.stringify({
        runtimeDir: context.runtimeDir, size: stored.size, sha256: stored.sha256,
      })], { input: upload.stream, maxOutputBytes: 64 * 1024 }, context.helperPath));
      const expectedPath = posix.join(context.runtimeDir, "files", stored.sha256);
      if (result.path !== expectedPath || result.size !== stored.size || result.sha256 !== stored.sha256) {
        throw new AppError("ATTACHMENT_INVALID", "remote upload integrity check failed");
      }
      this.assertCurrent(input.mapping, input.projectRoot);
      this.assertLease(input.lease, input.mapping.endpoint);
      return stored.mediaType.startsWith("image/")
        ? { type: "localImage", path: result.path }
        : { type: "mention", name: stored.displayName, path: result.path };
    } finally { await upload.close(); }
  }

  async prepareProjectFile(input: {
    endpointId: string;
    projectRoot: string;
    mapping: MappingIdentity;
    scopeId: string;
    relativePath: string;
    requestedId: FileHandleId;
  }): Promise<StoredAttachment> {
    this.assertCurrent(input.mapping, input.projectRoot);
    const existing = this.options.attachments.get(input.scopeId, input.requestedId);
    if (existing) return existing;
    if (input.endpointId === "local") {
      return this.options.endpoints.withWorkLease(input.endpointId, "file-transfer", async (_endpoint, lease) => {
        this.assertCurrent(input.mapping, input.projectRoot);
        this.assertLease(lease, input.endpointId);
        let promoted = false;
        try {
          const stored = await this.options.attachments.prepareOutbound(input.scopeId, input.projectRoot, input.relativePath, undefined, undefined, input.requestedId);
          promoted = true;
          this.assertCurrent(input.mapping, input.projectRoot);
          this.assertLease(lease, input.endpointId);
          return stored;
        } catch (error) {
          if (promoted) await this.options.attachments.discard(input.scopeId, input.requestedId).catch(() => undefined);
          throw error;
        }
      });
    }
    if (input.mapping.endpoint !== input.endpointId) throw new AppError("SESSION_DETACHED", "managed session endpoint changed");
    return this.options.endpoints.withWorkLease(input.endpointId, "file-transfer", async (_endpoint, lease) => {
      this.assertCurrent(input.mapping, input.projectRoot);
      this.assertLease(lease, input.endpointId);
      const candidate = this.projectPath(input.projectRoot, input.relativePath);
      const context = this.requireRemote(input.endpointId);
      const result = remoteFileSchema.parse(await context.remote.invokeTransfer("read-file", [JSON.stringify({
        path: candidate, root: input.projectRoot, maxBytes: this.options.maxFileBytes,
      })], { maxOutputBytes: Math.ceil(this.options.maxFileBytes * 4 / 3) + 64 * 1024 }, context.helperPath));
      if (result.size > this.options.maxFileBytes) throw new AppError("ATTACHMENT_INVALID", "remote file exceeds limit");
      const data = Buffer.from(result.dataBase64, "base64");
      if (data.toString("base64") !== result.dataBase64 || data.byteLength !== result.size
        || createHash("sha256").update(data).digest("hex") !== result.sha256) {
        throw new AppError("ATTACHMENT_INVALID", "remote file digest mismatch");
      }
      this.assertCurrent(input.mapping, input.projectRoot);
      this.assertLease(lease, input.endpointId);
      let promoted = false;
      try {
        const stored = await this.options.attachments.ingest(input.scopeId, Readable.from([data]), {
          displayName: basename(input.relativePath), mediaType: "application/octet-stream", declaredSize: result.size,
        }, input.requestedId);
        promoted = true;
        this.assertCurrent(input.mapping, input.projectRoot);
        this.assertLease(lease, input.endpointId);
        return stored;
      } catch (error) {
        if (promoted) await this.options.attachments.discard(input.scopeId, input.requestedId).catch(() => undefined);
        throw error;
      }
    });
  }

  private assertCurrent(mapping: MappingIdentity, projectRoot: string): void {
    const found = this.options.registry.getByIdentity(mapping.endpoint, mapping.thread_id);
    if (!found || found.session.mapping_id !== mapping.mapping_id || found.session.lifecycle_state !== "managed" || found.session.project_dir !== projectRoot) {
      throw new AppError("SESSION_DETACHED", "managed session mapping changed during file transfer");
    }
  }

  private assertLease(lease: EndpointWorkLease, endpointId: string): void {
    if (!this.options.endpoints.validateWorkLease(lease, endpointId)) throw new AppError("ENDPOINT_UNAVAILABLE", "endpoint generation changed during file transfer");
  }

  private requireRemote(endpointId: string): RemoteFileContext {
    const context = this.options.remote(endpointId);
    if (!context) throw new AppError("ENDPOINT_UNAVAILABLE", `SSH file transport is unavailable: ${endpointId}`);
    return context;
  }

  private projectPath(root: string, relativePath: string): string {
    if (isAbsolute(relativePath) || relativePath.split(/[\\/]+/u).includes("..")) throw new AppError("ATTACHMENT_INVALID", "outbound path must remain below the project root");
    const candidate = posix.resolve(root, relativePath);
    const projected = posix.relative(root, candidate);
    if (projected === ".." || projected.startsWith("../") || posix.isAbsolute(projected)) throw new AppError("ATTACHMENT_INVALID", "outbound path escapes the project root");
    return candidate;
  }
}
