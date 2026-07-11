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
import type { WorkspaceRouter } from "./workspace-router.ts";

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
    endpoints: Pick<EndpointManager, "validateWorkLease" | "withWorkLease" | "runWithWorkLease">;
    workspaces: Pick<WorkspaceRouter, "prepareExisting" | "assertDispatchable">;
    remote(endpointId: string): RemoteFileContext | undefined;
    // Whether an endpoint runs on QiYan's own host (files handled in-process, not over ssh).
    // Defaults to the Codex `"local"` id; production also passes the local Claude endpoint id
    // so its files aren't mis-sent through the (nonexistent) ssh transport.
    isLocal?(endpointId: string): boolean;
    maxFileBytes: number;
  }) {}

  private isLocal(endpointId: string): boolean {
    return this.options.isLocal?.(endpointId) ?? endpointId === "local";
  }

  async toWorkerInput(input: {
    lease: EndpointWorkLease;
    mapping: MappingIdentity;
    projectRoot: string;
    scopeId: string;
    attachmentId: FileHandleId;
  }): Promise<{ type: "localImage"; path: string } | { type: "mention"; name: string; path: string }> {
    this.assertCurrent(input.mapping, input.projectRoot);
    this.assertLease(input.lease, input.mapping.endpoint);
    if (this.isLocal(input.mapping.endpoint)) return this.options.attachments.toUserInput(input.scopeId, input.attachmentId);
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
    lease?: EndpointWorkLease;
    scopeId: string;
    relativePath: string;
    requestedId: FileHandleId;
  }): Promise<StoredAttachment> {
    this.assertCurrent(input.mapping, input.projectRoot);
    if (input.mapping.endpoint !== input.endpointId) throw new AppError("SESSION_DETACHED", "managed session endpoint changed");
    const existing = this.options.attachments.get(input.scopeId, input.requestedId);
    if (existing) return existing;
    if (this.isLocal(input.endpointId)) {
      return this.withFileLease(input.endpointId, input.lease, async (lease) => {
        this.assertCurrent(input.mapping, input.projectRoot);
        this.assertLease(lease, input.endpointId);
        const project = await this.prepareProject(input.endpointId, input.projectRoot, lease);
        return this.options.attachments.prepareOutbound(
          input.scopeId, project.path, input.relativePath, undefined, undefined, input.requestedId,
          async () => {
            await this.options.workspaces.assertDispatchable(input.endpointId, project, lease);
            this.assertCurrent(input.mapping, input.projectRoot);
            this.assertLease(lease, input.endpointId);
          },
          project.identity,
        );
      });
    }
    return this.withFileLease(input.endpointId, input.lease, async (lease) => {
      this.assertCurrent(input.mapping, input.projectRoot);
      this.assertLease(lease, input.endpointId);
      const project = await this.prepareProject(input.endpointId, input.projectRoot, lease);
      const candidate = this.projectPath(input.projectRoot, input.relativePath);
      const context = this.requireRemote(input.endpointId);
      const result = remoteFileSchema.parse(await context.remote.invokeTransfer("read-file", [JSON.stringify({
        path: candidate, root: project.path, rootDevice: project.identity.device, rootInode: project.identity.inode, maxBytes: this.options.maxFileBytes,
      })], { maxOutputBytes: Math.ceil(this.options.maxFileBytes * 4 / 3) + 64 * 1024 }, context.helperPath));
      if (result.size > this.options.maxFileBytes) throw new AppError("ATTACHMENT_INVALID", "remote file exceeds limit");
      const data = Buffer.from(result.dataBase64, "base64");
      if (data.toString("base64") !== result.dataBase64 || data.byteLength !== result.size
        || createHash("sha256").update(data).digest("hex") !== result.sha256) {
        throw new AppError("ATTACHMENT_INVALID", "remote file digest mismatch");
      }
      this.assertCurrent(input.mapping, input.projectRoot);
      this.assertLease(lease, input.endpointId);
      await this.options.workspaces.assertDispatchable(input.endpointId, project, lease);
      const staged = await this.options.attachments.stage(input.scopeId, Readable.from([data]), {
        displayName: basename(input.relativePath), mediaType: "application/octet-stream", declaredSize: result.size,
      }, input.requestedId);
      try {
        return await staged.promote(async () => {
          await this.options.workspaces.assertDispatchable(input.endpointId, project, lease);
          this.assertCurrent(input.mapping, input.projectRoot);
          this.assertLease(lease, input.endpointId);
        });
      } catch (error) {
        await staged.discard();
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

  private withFileLease<T>(
    endpointId: string,
    existing: EndpointWorkLease | undefined,
    run: (lease: EndpointWorkLease) => Promise<T>,
  ): Promise<T> {
    if (!existing) return this.options.endpoints.withWorkLease(endpointId, "file-transfer", (_endpoint, lease) => run(lease));
    return this.options.endpoints.runWithWorkLease(endpointId, existing, (lease) => {
      if (!lease) throw new AppError("ENDPOINT_UNAVAILABLE", "endpoint file recovery lease is unavailable");
      return run(lease);
    });
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

  private async prepareProject(endpointId: string, projectRoot: string, lease: EndpointWorkLease) {
    const project = await this.options.workspaces.prepareExisting(endpointId, projectRoot, lease);
    if (project.path !== projectRoot) throw new AppError("CWD_MISMATCH", "managed project directory changed during file transfer");
    await this.options.workspaces.assertDispatchable(endpointId, project, lease);
    return project;
  }
}
