import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { AppError } from "../core/errors.ts";
import { APP_VERSION } from "../version.ts";
import type { PermissionBlockedEvent } from "../app-server/local-endpoint.ts";
import type { RpcRequest } from "../app-server/protocol.ts";
import { RpcClient, type RpcWire } from "../app-server/rpc-client.ts";
import { requireMinimumCodexVersion } from "../app-server/version-compat.ts";
import { buildControlMasterExitArgs, buildSshArgs, type SshConnectionPlan } from "./ssh-config.ts";
import { runBoundedProcess } from "./ssh-process.ts";
import type { SshRuntimeController } from "./ssh-runtime.ts";
import type { EndpointLossKind, RuntimeIdentity } from "./types.ts";

export interface SshTunnel {
  close(): void | Promise<void>;
  onClose(listener: (error?: Error) => void): () => void;
}

export class SshEndpoint {
  readonly id: string;
  state: "starting" | "ready" | "unavailable" | "stopped" = "stopped";
  private generation = 0;
  private client?: RpcClient;
  private tunnel?: SshTunnel;
  private removeTunnelClose?: () => void;
  private removeWireClose?: () => void;
  private readonly events = new EventEmitter();

  constructor(private readonly options: {
    id: string;
    runtime: SshRuntimeController;
    minimumVersion: string;
    openTunnel(remoteSocketPath: string): Promise<SshTunnel>;
    connectWire(): Promise<RpcWire>;
    requestTimeoutMs?: number;
  }) {
    this.id = options.id;
  }

  async start(): Promise<void> {
    if (this.state === "ready") return;
    const generation = ++this.generation;
    await this.disposeConnection();
    this.state = "starting";
    try {
      const identity = await this.options.runtime.ensureStarted();
      if (identity.kind !== "ssh") throw new AppError("ENDPOINT_UNAVAILABLE", "remote runtime returned a non-SSH identity");
      const tunnel = await this.options.openTunnel(this.options.runtime.remoteSocketPath);
      if (this.generation !== generation || this.state !== "starting") { await tunnel.close(); throw this.changed(); }
      this.tunnel = tunnel;
      this.removeTunnelClose = tunnel.onClose(() => { void this.connectionLost(generation); });
      const wire = await this.options.connectWire();
      if (this.generation !== generation || this.state !== "starting") { wire.close(); throw this.changed(); }
      this.removeWireClose = wire.onClose(() => { void this.connectionLost(generation); });
      const client = new RpcClient(wire, { requestTimeoutMs: this.options.requestTimeoutMs ?? 30_000 });
      this.client = client;
      client.onNotification((method, params) => {
        if (this.generation === generation && this.state === "ready") this.events.emit("notification", method, params);
      });
      client.onServerRequest((request) => this.handleServerRequest(request));
      const initialized = await client.request<{ userAgent?: string }>("initialize", {
        clientInfo: { name: "qiyan_bot", title: "QiYan Bot", version: APP_VERSION },
        capabilities: { experimentalApi: true },
      });
      requireMinimumCodexVersion(initialized.userAgent, this.options.minimumVersion);
      client.notify("initialized", {});
      const account = await client.request<{ account: unknown | null; requiresOpenaiAuth: boolean }>("account/read", { refreshToken: false });
      if (account.account === null && account.requiresOpenaiAuth === true) {
        throw new AppError("CONFIGURATION_ERROR", `Codex is not authenticated on SSH endpoint ${this.id}`);
      }
      if (this.generation !== generation || this.state !== "starting") throw this.changed();
      this.state = "ready";
      this.events.emit("ready");
    } catch (error) {
      if (this.generation === generation) {
        this.state = "unavailable";
        await this.disposeConnection();
      }
      throw error;
    }
  }

  async closeConnection(): Promise<void> {
    this.generation += 1;
    this.state = "stopped";
    await this.disposeConnection();
  }

  async shutdownRuntime(): Promise<void> {
    await this.closeConnection();
    await this.options.runtime.stop();
  }

  runtimeIdentity(): Promise<RuntimeIdentity | undefined> { return this.options.runtime.runtimeIdentity(); }

  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.state !== "ready" || !this.client) return Promise.reject(new AppError("ENDPOINT_UNAVAILABLE", `SSH endpoint is unavailable: ${this.id}`));
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

  onPermissionBlocked(listener: (event: PermissionBlockedEvent) => void): () => void {
    this.events.on("permissionBlocked", listener);
    return () => this.events.off("permissionBlocked", listener);
  }

  private async connectionLost(generation: number): Promise<void> {
    if (this.generation !== generation || (this.state !== "ready" && this.state !== "starting")) return;
    this.state = "unavailable";
    await this.disposeConnection();
    if (this.generation !== generation || this.state !== "unavailable") return;
    let kind: EndpointLossKind = "connection-lost";
    try {
      if (this.options.runtime.classifyLoss) kind = await this.options.runtime.classifyLoss();
      else if (await this.options.runtime.runtimeIdentity() === undefined) kind = "runtime-lost";
    } catch { /* inability to prove loss remains connection-only */ }
    if (this.generation === generation && this.state === "unavailable") this.events.emit("unavailable", kind);
  }

  private async disposeConnection(): Promise<void> {
    this.removeTunnelClose?.();
    this.removeWireClose?.();
    delete this.removeTunnelClose;
    delete this.removeWireClose;
    const client = this.client;
    const tunnel = this.tunnel;
    delete this.client;
    delete this.tunnel;
    client?.close();
    await tunnel?.close();
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

  private changed(): AppError { return new AppError("ENDPOINT_UNAVAILABLE", `SSH endpoint generation changed while starting: ${this.id}`); }
}

export async function openSshUnixTunnel(options: {
  plan: SshConnectionPlan;
  localSocketPath: string;
  remoteSocketPath: string;
  sshBinary?: string;
  timeoutMs?: number;
}): Promise<SshTunnel> {
  await mkdir(dirname(options.localSocketPath), { recursive: true, mode: 0o700 });
  if (options.plan.ownsControlMaster) await mkdir(dirname(options.plan.controlPath!), { recursive: true, mode: 0o700 });
  await unlink(options.localSocketPath).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
  let processError: Error | undefined;
  const child = spawn(options.sshBinary ?? "ssh", buildSshArgs(options.plan, [
    "-N", "-o", "ExitOnForwardFailure=yes", "-o", "StreamLocalBindUnlink=yes",
    "-L", `${options.localSocketPath}:${options.remoteSocketPath}`,
  ]), { stdio: ["pipe", "pipe", "pipe"], shell: false });
  child.stdout.on("data", () => { /* tunnel stdout is not part of the protocol */ });
  child.stderr.on("data", () => { /* drain without logging potentially sensitive SSH diagnostics */ });
  child.on("error", (error) => { processError = error; });
  try {
    await waitForTunnelSocket(child, options.localSocketPath, options.timeoutMs ?? 10_000, () => processError);
    return new ProcessSshTunnel(child, async () => {
      if (!options.plan.ownsControlMaster) return;
      await runBoundedProcess(options.sshBinary ?? "ssh", buildControlMasterExitArgs(options.plan), {
        timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
      }).catch(() => undefined);
    });
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

class ProcessSshTunnel implements SshTunnel {
  private readonly events = new EventEmitter();
  private intentional = false;
  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly closeMaster: () => Promise<void>) {
    child.once("error", (error) => { if (!this.intentional) this.events.emit("close", error); });
    child.once("exit", () => { if (!this.intentional) this.events.emit("close", new Error("SSH tunnel exited")); });
  }
  onClose(listener: (error?: Error) => void): () => void { this.events.on("close", listener); return () => this.events.off("close", listener); }
  async close(): Promise<void> {
    this.intentional = true;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await new Promise<void>((resolve) => {
        let hard: ReturnType<typeof setTimeout> | undefined;
        const force = setTimeout(() => {
          this.child.kill("SIGKILL");
          hard = setTimeout(resolve, 500);
          hard.unref?.();
        }, 2_000);
        force.unref?.();
        this.child.once("exit", () => { clearTimeout(force); if (hard) clearTimeout(hard); resolve(); });
        this.child.kill("SIGTERM");
      });
    }
    await this.closeMaster();
  }
}

async function waitForTunnelSocket(child: ChildProcessWithoutNullStreams, path: string, timeoutMs: number, processError: () => Error | undefined): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processError()) throw new AppError("ENDPOINT_UNAVAILABLE", "SSH tunnel could not start");
    if (child.exitCode !== null || child.signalCode !== null) throw new AppError("ENDPOINT_UNAVAILABLE", "SSH tunnel exited before opening");
    const state = await lstat(path).catch(() => undefined);
    if (state?.isSocket()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new AppError("ENDPOINT_UNAVAILABLE", "SSH tunnel did not open in time");
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error && error.code === code; }
