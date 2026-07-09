import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { resolve } from "node:path/posix";
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
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void> { return mkdirAbsoluteNoFollow(path, options); }
  chmod(path: string, mode: number): Promise<void> { return chmod(path, mode); }
}

const stateSchema = z.object({
  kind: z.enum(["directory", "file", "symlink", "other", "missing"]),
  device: z.string().regex(/^\d+$/u).optional(),
  inode: z.string().regex(/^\d+$/u).optional(),
}).strict();
const workspaceErrorSchema = z.object({
  error: z.object({ code: z.enum(["ENOENT", "EEXIST"]) }).strict(),
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

  private async call<T = unknown>(value: unknown): Promise<T> {
    const result = await this.remote.invoke<unknown>("workspace", [JSON.stringify(value)], this.helperPath);
    const failure = workspaceErrorSchema.safeParse(result);
    if (failure.success) {
      throw Object.assign(new Error(`SSH workspace operation failed (${failure.data.error.code})`), {
        code: failure.data.error.code,
      });
    }
    if (result && typeof result === "object" && !Array.isArray(result) && Object.hasOwn(result, "error")) throw this.invalid();
    return result as T;
  }
  private invalid(): AppError { return new AppError("ENDPOINT_UNAVAILABLE", `SSH workspace helper returned invalid data: ${this.endpointId}`); }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error && error.code === code; }

async function mkdirAbsoluteNoFollow(path: string, options: { recursive: boolean; mode: number }): Promise<void> {
  const normalized = resolve(path);
  if (normalized !== path || options.mode !== 0o700) throw new Error("invalid workspace mkdir request");
  const components = normalized.split("/").filter(Boolean);
  let parent = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (components.length === 0 && !options.recursive) throw Object.assign(new Error("workspace exists"), { code: "EEXIST" });
    for (let index = 0; index < components.length; index += 1) {
      const childPath = `/proc/self/fd/${parent.fd}/${components[index]}`;
      const last = index === components.length - 1;
      let exists = true;
      try { await lstat(childPath); } catch (error) { if (isErrno(error, "ENOENT")) exists = false; else throw error; }
      if (exists && last && !options.recursive) throw Object.assign(new Error("workspace exists"), { code: "EEXIST" });
      if (!exists) {
        if (!options.recursive && !last) throw Object.assign(new Error("workspace parent is missing"), { code: "ENOENT" });
        await mkdir(childPath, { mode: options.mode });
      }
      const child = await open(childPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await parent.close();
      parent = child;
    }
  } finally { await parent.close().catch(() => undefined); }
}
