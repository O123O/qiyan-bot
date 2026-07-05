import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, realpath } from "node:fs/promises";
import { AppError } from "../core/errors.ts";
import { readLinuxProcessIdentity, type LinuxProcessIdentity } from "../core/process-identity.ts";
import { JsonRpcClient } from "./json-rpc-client.ts";
import type { RpcRequest } from "./protocol.ts";
import { APP_VERSION } from "../version.ts";
import { requireMinimumCodexVersion } from "./version-compat.ts";
import type { EndpointLossKind, RuntimeIdentity } from "../endpoints/types.ts";

export interface PermissionBlockedEvent {
  method: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  params: unknown;
}

type Spawn = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
type ResolveMcpClientIdentity = (rootPid: number) => Promise<LinuxProcessIdentity>;

async function readDirectChildren(pid: number): Promise<number[]> {
  let value: string;
  try { value = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8"); }
  catch (error) { throw new AppError("UNSUPPORTED_CAPABILITY", "unable to verify Codex launcher topology", { cause: error }); }
  if (!value.trim()) return [];
  const children = value.trim().split(/\s+/u).map(Number);
  if (children.some((child) => !Number.isSafeInteger(child) || child <= 1)) throw new AppError("UNSUPPORTED_CAPABILITY", "invalid Codex launcher topology");
  return children;
}

export async function resolveMcpClientIdentity(
  rootPid: number,
  childrenOf: (pid: number) => Promise<readonly number[]> = readDirectChildren,
  identify: (pid: number) => Promise<LinuxProcessIdentity> = readLinuxProcessIdentity,
): Promise<LinuxProcessIdentity> {
  if (process.platform !== "linux") throw new AppError("UNSUPPORTED_CAPABILITY", "manager MCP process verification requires Linux");
  const children = await childrenOf(rootPid);
  if (children.length === 0) return identify(rootPid);
  if (children.length !== 1) throw new AppError("UNSUPPORTED_CAPABILITY", "unsupported Codex launcher topology");
  const [protocolPid] = children;
  if (!protocolPid || (await childrenOf(protocolPid)).length !== 0) throw new AppError("UNSUPPORTED_CAPABILITY", "unsupported Codex launcher topology");
  return identify(protocolPid);
}

export class LocalEndpoint {
  readonly id: string;
  state: "starting" | "ready" | "unavailable" | "stopped" = "stopped";
  private child?: ChildProcessWithoutNullStreams;
  private client?: JsonRpcClient;
  private protocolIdentity?: LinuxProcessIdentity;
  private readonly events = new EventEmitter();

  constructor(private readonly options: { id?: string; codexBinary: string; spawn?: Spawn; env?: NodeJS.ProcessEnv; requestTimeoutMs?: number; minimumVersion?: string; expectedCodexHome?: string; validateEnvironment?: () => Promise<void>; resolveMcpClientIdentity?: ResolveMcpClientIdentity }) {
    this.id = options.id ?? "local";
  }

  async start(): Promise<void> {
    if (this.state === "ready") return;
    await this.options.validateEnvironment?.();
    this.state = "starting";
    delete this.protocolIdentity;
    const spawn = this.options.spawn ?? nodeSpawn;
    const child = spawn(this.options.codexBinary, ["app-server", "--listen", "stdio://"], {
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.on("data", () => { /* continuously drain; never log potentially sensitive app-server stderr */ });
    const client = new JsonRpcClient(child.stdout, child.stdin, { requestTimeoutMs: this.options.requestTimeoutMs ?? 30_000 });
    this.client = client;
    client.onNotification((method, params) => this.events.emit("notification", method, params));
    client.onServerRequest((request) => this.handleServerRequest(request));
    child.once("error", (error) => {
      client.close(error);
      if (this.child === child) {
        delete this.child;
        delete this.protocolIdentity;
        if (this.client === client) delete this.client;
        if (this.state !== "stopped") {
          this.state = "unavailable";
          this.events.emit("unavailable", "runtime-lost" satisfies EndpointLossKind);
        }
      }
    });
    child.once("exit", () => {
      client.close(new Error("app-server process exited"));
      if (this.child === child) {
        const unexpectedly = this.state !== "stopped";
        delete this.child;
        delete this.protocolIdentity;
        if (this.client === client) delete this.client;
        if (unexpectedly) {
          this.state = "unavailable";
          this.events.emit("unavailable", "runtime-lost" satisfies EndpointLossKind);
        }
      }
    });
    try {
      const initialized = await client.request<{ userAgent?: string; codexHome?: string }>("initialize", {
        clientInfo: { name: "qiyan_bot", title: "QiYan Bot", version: APP_VERSION },
        capabilities: { experimentalApi: true },
      });
      if (this.options.minimumVersion) requireMinimumCodexVersion(initialized.userAgent, this.options.minimumVersion);
      if (this.options.expectedCodexHome) {
        const matches = initialized.codexHome !== undefined
          && await realpath(initialized.codexHome).catch(() => undefined) === this.options.expectedCodexHome;
        if (!matches) throw new AppError("CONFIGURATION_ERROR", "assistant app-server reported an unexpected CODEX_HOME");
      }
      await this.options.validateEnvironment?.();
      const protocolIdentity = child.pid === undefined ? undefined : await (this.options.resolveMcpClientIdentity ?? resolveMcpClientIdentity)(child.pid);
      if (this.child !== child || this.client !== client || this.state !== "starting") throw new AppError("ENDPOINT_UNAVAILABLE", "app-server generation changed during initialization");
      if (protocolIdentity) this.protocolIdentity = protocolIdentity;
      else delete this.protocolIdentity;
      client.notify("initialized", {});
      this.state = "ready";
      this.events.emit("ready");
    } catch (error) {
      if (this.child === child && this.client === client && this.state === "starting") {
        this.state = "unavailable";
        await this.stop();
        this.state = "unavailable";
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.state = "stopped";
    delete this.protocolIdentity;
    const child = this.child;
    this.client?.close();
    if (!child) return;
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const done = () => { if (!settled) { settled = true; if (timeout) clearTimeout(timeout); resolve(); } };
      child.once("exit", done);
      timeout = setTimeout(() => { child.kill("SIGKILL"); done(); }, 5_000);
      timeout.unref?.();
    });
    child.kill();
    await exited;
  }

  closeConnection(): Promise<void> { return this.stop(); }
  shutdownRuntime(): Promise<void> { return this.stop(); }
  async runtimeIdentity(): Promise<RuntimeIdentity | undefined> {
    return this.protocolIdentity ? { kind: "local", pid: this.protocolIdentity.pid, startTime: this.protocolIdentity.startTime } : undefined;
  }

  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.state !== "ready" || !this.client) return Promise.reject(new AppError("ENDPOINT_UNAVAILABLE", "local app-server is unavailable"));
    return this.client.request<T>(method, params, signal);
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.events.on("notification", listener);
    return () => this.events.off("notification", listener);
  }

  onReady(listener: () => void): () => void {
    this.events.on("ready", listener);
    return () => this.events.off("ready", listener);
  }

  onUnavailable(listener: (kind: EndpointLossKind) => void): () => void {
    this.events.on("unavailable", listener);
    return () => this.events.off("unavailable", listener);
  }

  get pid(): number | undefined { return this.child?.pid; }
  get mcpClientIdentity(): LinuxProcessIdentity | undefined { return this.protocolIdentity ? { ...this.protocolIdentity } : undefined; }

  onPermissionBlocked(listener: (event: PermissionBlockedEvent) => void): () => void {
    this.events.on("permissionBlocked", listener);
    return () => this.events.off("permissionBlocked", listener);
  }

  private async handleServerRequest(request: RpcRequest): Promise<unknown> {
    if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval" || request.method === "item/permissions/requestApproval") {
      const params = request.params as Record<string, unknown> | undefined;
      this.events.emit("permissionBlocked", {
        method: request.method,
        ...(typeof params?.threadId === "string" ? { threadId: params.threadId } : {}),
        ...(typeof params?.turnId === "string" ? { turnId: params.turnId } : {}),
        ...(typeof params?.itemId === "string" ? { itemId: params.itemId } : {}),
        params: request.params,
      } satisfies PermissionBlockedEvent);
      if (request.method === "item/permissions/requestApproval") throw new AppError("PERMISSION_BLOCKED", "permission escalation is disabled");
      return { decision: "decline" };
    }
    throw new Error(`Unhandled app-server request: ${request.method}`);
  }
}
