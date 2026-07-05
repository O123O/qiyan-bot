import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { z } from "zod";
import { AppError } from "../core/errors.ts";
import type { RemoteRuntimeClient } from "./ssh-runtime.ts";

export interface WorkspacePathState {
  kind: "directory" | "file" | "symlink" | "other" | "missing";
  device?: string;
  inode?: string;
}

export interface WorkspaceHost {
  readonly endpointId: string;
  home(): Promise<string>;
  lstat(path: string): Promise<WorkspacePathState>;
  realpath(path: string): Promise<string>;
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

export class LocalWorkspaceHost implements WorkspaceHost {
  readonly endpointId = "local";
  constructor(private readonly userHome: string) {}
  async home(): Promise<string> { return realpath(this.userHome); }
  async lstat(path: string): Promise<WorkspacePathState> {
    let state;
    try { state = await lstat(path, { bigint: true }); }
    catch (error) { if (isErrno(error, "ENOENT")) return { kind: "missing" }; throw error; }
    const kind = state.isSymbolicLink() ? "symlink" : state.isDirectory() ? "directory" : state.isFile() ? "file" : "other";
    return { kind, device: state.dev.toString(10), inode: state.ino.toString(10) };
  }
  realpath(path: string): Promise<string> { return realpath(path); }
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void> { return mkdir(path, options).then(() => undefined); }
  chmod(path: string, mode: number): Promise<void> { return chmod(path, mode); }
}

const stateSchema = z.object({
  kind: z.enum(["directory", "file", "symlink", "other", "missing"]),
  device: z.string().regex(/^\d+$/u).optional(),
  inode: z.string().regex(/^\d+$/u).optional(),
}).strict();

export class SshHost implements WorkspaceHost {
  constructor(
    readonly endpointId: string,
    private readonly remote: RemoteRuntimeClient,
    private readonly helperPath: string,
  ) {}

  async home(): Promise<string> {
    const value = await this.call<{ path: string }>({ action: "home" });
    if (typeof value.path !== "string" || !value.path.startsWith("/")) throw this.invalid();
    return value.path;
  }

  async lstat(path: string): Promise<WorkspacePathState> {
    const value = stateSchema.parse(await this.call({ action: "lstat", path }));
    return { kind: value.kind, ...(value.device === undefined ? {} : { device: value.device }), ...(value.inode === undefined ? {} : { inode: value.inode }) };
  }
  async realpath(path: string): Promise<string> {
    const value = await this.call<{ path: string }>({ action: "realpath", path });
    if (typeof value.path !== "string" || !value.path.startsWith("/")) throw this.invalid();
    return value.path;
  }
  async mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void> {
    await this.call({ action: "mkdir", path, recursive: options.recursive, mode: options.mode });
  }
  async chmod(path: string, mode: number): Promise<void> { await this.call({ action: "chmod", path, mode }); }

  private call<T = unknown>(value: unknown): Promise<T> {
    return this.remote.invoke<T>("workspace", [JSON.stringify(value)], this.helperPath);
  }
  private invalid(): AppError { return new AppError("ENDPOINT_UNAVAILABLE", `SSH workspace helper returned invalid data: ${this.endpointId}`); }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error && error.code === code; }
