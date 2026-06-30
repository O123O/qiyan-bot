import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { AppError } from "../core/errors.ts";
import { JsonRpcClient } from "./json-rpc-client.ts";
import type { RpcRequest } from "./protocol.ts";

export interface PermissionBlockedEvent {
  method: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  params: unknown;
}

type Spawn = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

export class LocalEndpoint {
  readonly id: string;
  state: "starting" | "ready" | "unavailable" | "stopped" = "stopped";
  private child?: ChildProcessWithoutNullStreams;
  private client?: JsonRpcClient;
  private readonly events = new EventEmitter();

  constructor(private readonly options: { id?: string; codexBinary: string; spawn?: Spawn; env?: NodeJS.ProcessEnv; requestTimeoutMs?: number; expectedVersion?: string }) {
    this.id = options.id ?? "local";
  }

  async start(): Promise<void> {
    if (this.state === "ready") return;
    this.state = "starting";
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
        if (this.client === client) delete this.client;
        if (this.state !== "stopped") {
          this.state = "unavailable";
          this.events.emit("unavailable");
        }
      }
    });
    child.once("exit", () => {
      client.close(new Error("app-server process exited"));
      if (this.child === child) {
        const unexpectedly = this.state !== "stopped";
        delete this.child;
        if (this.client === client) delete this.client;
        if (unexpectedly) {
          this.state = "unavailable";
          this.events.emit("unavailable");
        }
      }
    });
    try {
      const initialized = await client.request<{ userAgent?: string }>("initialize", {
        clientInfo: { name: "codex_chat_bot", title: "Codex Chat Bot", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      if (this.options.expectedVersion) {
        const actual = /\/(\d+\.\d+\.\d+)(?:\s|\()/u.exec(initialized.userAgent ?? "")?.[1];
        if (actual !== this.options.expectedVersion) throw new AppError("UNSUPPORTED_CAPABILITY", `expected Codex app-server ${this.options.expectedVersion}, received ${actual ?? "unknown"}`);
      }
      client.notify("initialized", {});
      this.state = "ready";
      this.events.emit("ready");
    } catch (error) {
      this.state = "unavailable";
      child.kill();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.state = "stopped";
    const child = this.child;
    this.client?.close();
    if (!child) return;
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      const timeout = setTimeout(resolve, 5_000);
      timeout.unref?.();
    });
    child.kill();
    await exited;
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

  onUnavailable(listener: () => void): () => void {
    this.events.on("unavailable", listener);
    return () => this.events.off("unavailable", listener);
  }

  get pid(): number | undefined { return this.child?.pid; }

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
