import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { AppError } from "../core/errors.ts";
import { APP_VERSION } from "../version.ts";
import type { PermissionBlockedEvent } from "../app-server/local-endpoint.ts";
import type { RpcRequest } from "../app-server/protocol.ts";
import { RpcClient, type RpcWire } from "../app-server/rpc-client.ts";
import { requireMinimumCodexVersion } from "../app-server/version-compat.ts";
import { buildControlMasterExitArgs, buildSshRemoteArgs, type SshConnectionPlan } from "./ssh-config.ts";
import { runBoundedProcess } from "./ssh-process.ts";
import { buildInstalledHelperCommand, type SshRuntimeController } from "./ssh-runtime.ts";
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
      const confirmedIdentity = await this.options.runtime.runtimeIdentity();
      if (!sameRuntimeIdentity(identity, confirmedIdentity)) throw new AppError("ENDPOINT_UNAVAILABLE", `SSH runtime identity changed during connection: ${this.id}`);
      if (this.generation !== generation || this.state !== "starting") throw this.changed();
      this.state = "ready";
      this.events.emit("ready");
    } catch (error) {
      if (this.generation === generation) {
        this.state = "unavailable";
        await this.disposeConnection();
        await this.options.runtime.closeTransport?.();
      }
      throw error;
    }
  }

  async closeConnection(): Promise<void> {
    this.generation += 1;
    this.state = "stopped";
    await this.disposeConnection();
    await this.options.runtime.closeTransport?.();
  }

  async shutdownRuntime(expectedIdentity?: RuntimeIdentity): Promise<void> {
    await this.closeConnection();
    await this.options.runtime.stop(expectedIdentity);
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
    finally { await this.options.runtime.closeTransport?.(); }
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
  const helperPath = join(dirname(options.remoteSocketPath), "qiyan-ssh-helper.mjs");
  const command = buildInstalledHelperCommand(helperPath, "tunnel", [JSON.stringify({ socketPath: options.remoteSocketPath })]);
  const tunnel = new ProcessSshTunnel({
    sshBinary: options.sshBinary ?? "ssh",
    sshArgs: buildSshRemoteArgs(options.plan, command),
    localSocketPath: options.localSocketPath,
    timeoutMs: options.timeoutMs ?? 10_000,
    closeMaster: async () => {
      if (!options.plan.ownsControlMaster) return;
      await runBoundedProcess(options.sshBinary ?? "ssh", buildControlMasterExitArgs(options.plan), {
        timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
      }).catch(() => undefined);
    },
  });
  await tunnel.listen();
  return tunnel;
}

class ProcessSshTunnel implements SshTunnel {
  private readonly events = new EventEmitter();
  private readonly server: Server;
  private intentional = false;
  private emittedClose = false;
  private peer?: Socket;
  private child?: ChildProcessWithoutNullStreams;

  constructor(private readonly options: {
    sshBinary: string;
    sshArgs: readonly string[];
    localSocketPath: string;
    timeoutMs: number;
    closeMaster(): Promise<void>;
  }) {
    this.server = createServer({ allowHalfOpen: true }, (peer) => this.accept(peer));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new AppError("ENDPOINT_UNAVAILABLE", "SSH tunnel did not open in time"));
      }, this.options.timeoutMs);
      timeout.unref?.();
      const cleanup = () => { clearTimeout(timeout); this.server.off("error", failed); };
      const failed = () => { cleanup(); reject(new AppError("ENDPOINT_UNAVAILABLE", "SSH tunnel could not start")); };
      this.server.once("error", failed);
      this.server.listen(this.options.localSocketPath, () => { cleanup(); resolve(); });
    });
    await chmod(this.options.localSocketPath, 0o600);
    this.server.on("error", () => this.fail(new Error("local SSH bridge failed")));
  }

  onClose(listener: (error?: Error) => void): () => void { this.events.on("close", listener); return () => this.events.off("close", listener); }

  async close(): Promise<void> {
    this.intentional = true;
    this.peer?.destroy();
    await this.stopChild();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await unlink(this.options.localSocketPath).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
    await this.options.closeMaster();
  }

  private accept(peer: Socket): void {
    if (this.intentional || this.peer) { peer.destroy(); return; }
    this.peer = peer;
    const child = spawn(this.options.sshBinary, [...this.options.sshArgs], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    this.child = child;
    child.stderr.on("data", () => { /* drain without logging potentially sensitive SSH diagnostics */ });
    child.once("error", () => this.fail(new Error("SSH tunnel could not start")));
    child.once("exit", () => this.fail(new Error("SSH tunnel exited")));
    peer.once("error", () => this.fail(new Error("local SSH bridge failed")));
    peer.once("close", () => { if (!this.intentional) void this.stopChild(); });
    peer.pipe(child.stdin);
    child.stdout.pipe(peer);
  }

  private fail(error: Error): void {
    if (this.intentional || this.emittedClose) return;
    this.emittedClose = true;
    this.events.emit("close", error);
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    delete this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        let hard: ReturnType<typeof setTimeout> | undefined;
        const force = setTimeout(() => {
          child.kill("SIGKILL");
          hard = setTimeout(resolve, 500);
          hard.unref?.();
        }, 2_000);
        force.unref?.();
        child.once("exit", () => { clearTimeout(force); if (hard) clearTimeout(hard); resolve(); });
        child.kill("SIGTERM");
      });
    }
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error && error.code === code; }

function sameRuntimeIdentity(expected: RuntimeIdentity, actual: RuntimeIdentity | undefined): boolean {
  return expected.kind === "ssh" && actual?.kind === "ssh"
    && expected.token === actual.token && expected.pid === actual.pid
    && expected.linuxStartTime === actual.linuxStartTime && expected.processGroupId === actual.processGroupId;
}
