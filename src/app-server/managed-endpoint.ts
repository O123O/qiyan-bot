import { EventEmitter } from "node:events";
import type { LinuxProcessIdentity } from "../core/process-identity.ts";
import { AppError } from "../core/errors.ts";
import { parseRuntimeIdentity, type EndpointLossKind, type EndpointLossReason, type RuntimeIdentity } from "../endpoints/types.ts";
import { APP_VERSION } from "../version.ts";
import type { DynamicToolCallResponse } from "./generated/v2/DynamicToolCallResponse.ts";
import type { RpcRequest } from "./protocol.ts";
import { RpcClient, type RpcWire } from "./rpc-client.ts";
import { requireMinimumCodexVersion } from "./version-compat.ts";

export interface PermissionBlockedEvent {
  method: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  params: unknown;
}

export interface AppServerInitializeResult {
  userAgent?: string;
  codexHome?: string;
}

export interface AppServerConnectionIdentity {
  runtime: RuntimeIdentity;
  allowedClientProcess?: LinuxProcessIdentity;
}

export interface AppServerConnection {
  readonly wire: RpcWire;
  onClose(listener: (error?: Error) => void): () => void;
  confirmInitialized(result: AppServerInitializeResult): Promise<AppServerConnectionIdentity>;
  close(): Promise<void>;
}

export interface AppServerRuntimeService {
  open(): Promise<AppServerConnection>;
  runtimeIdentity(): Promise<RuntimeIdentity | undefined>;
  classifyLoss(): Promise<EndpointLossKind>;
  shutdownRuntime(expected: RuntimeIdentity): Promise<void>;
  closeTransport?(): Promise<void>;
}

export class EndpointAuthenticationRequiredError extends AppError {
  readonly reason = "authentication_required";
  constructor(readonly endpointId: string) {
    super("CONFIGURATION_ERROR", `Codex authentication is required for endpoint ${endpointId}`, {
      reason: "authentication_required",
      endpointId,
    });
    this.name = "EndpointAuthenticationRequiredError";
  }
}

export class ManagedAppServerEndpoint {
  readonly id: string;
  state: "starting" | "ready" | "unavailable" | "stopped" = "stopped";
  private generation = 0;
  private connection?: AppServerConnection;
  private client?: RpcClient;
  private removeConnectionClose?: () => void;
  private connectionIdentity?: AppServerConnectionIdentity;
  private readonly events = new EventEmitter();

  constructor(private readonly options: {
    id: string;
    runtime: AppServerRuntimeService;
    minimumVersion?: string;
    requestTimeoutMs?: number;
  }) {
    this.id = options.id;
  }

  async start(): Promise<void> {
    if (this.state === "ready") return;
    const generation = ++this.generation;
    this.state = "starting";
    try {
      await this.disposeConnection();
      if (!this.current(generation, "starting")) throw this.changed();
      const connection = await this.options.runtime.open();
      if (!this.current(generation, "starting")) {
        await connection.close();
        throw this.changed();
      }
      this.connection = connection;
      this.removeConnectionClose = connection.onClose((error) => { void this.connectionLost(generation, error); });
      const client = new RpcClient(connection.wire, { requestTimeoutMs: this.options.requestTimeoutMs ?? 30_000 });
      this.client = client;
      client.onNotification((method, params) => {
        if (this.current(generation, "ready")) this.events.emit("notification", method, params);
      });
      client.onServerRequest((request) => this.handleServerRequest(request));
      const initialized = await client.request<AppServerInitializeResult>("initialize", {
        clientInfo: { name: "qiyan_bot", title: "QiYan Bot", version: APP_VERSION },
        capabilities: { experimentalApi: true },
      });
      if (this.options.minimumVersion) requireMinimumCodexVersion(initialized.userAgent, this.options.minimumVersion);
      const identity = validConnectionIdentity(await connection.confirmInitialized(initialized));
      if (!this.currentConnection(generation, connection, client)) throw this.changed();
      client.notify("initialized", {});
      const account = await client.request<unknown>("account/read", { refreshToken: false });
      if (!validAccountResponse(account)) throw new AppError("CONFIGURATION_ERROR", "App Server returned an invalid account response");
      if (account.account === null && account.requiresOpenaiAuth) throw new EndpointAuthenticationRequiredError(this.id);
      if (!this.currentConnection(generation, connection, client)) throw this.changed();
      this.connectionIdentity = identity;
      this.state = "ready";
      this.events.emit("ready");
    } catch (error) {
      if (generation === this.generation) {
        this.state = "unavailable";
        await this.disposeConnection().catch(() => undefined);
      }
      throw error;
    }
  }

  async closeConnection(): Promise<void> {
    this.generation += 1;
    this.state = "stopped";
    let firstError: unknown;
    try { await this.disposeConnection(); } catch (error) { firstError = error; }
    try { await this.options.runtime.closeTransport?.(); } catch (error) { firstError ??= error; }
    if (firstError !== undefined) throw firstError;
  }

  async shutdownRuntime(expected: RuntimeIdentity): Promise<void> {
    this.generation += 1;
    this.state = "stopped";
    let cleanupError: unknown;
    try { await this.disposeConnection(); } catch (error) { cleanupError = error; }
    await this.options.runtime.shutdownRuntime(expected);
    if (cleanupError !== undefined) throw cleanupError;
  }

  runtimeIdentity(): Promise<RuntimeIdentity | undefined> { return this.options.runtime.runtimeIdentity(); }

  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.state !== "ready" || !this.client) {
      return Promise.reject(new AppError("ENDPOINT_UNAVAILABLE", `app-server endpoint is unavailable: ${this.id}`));
    }
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
  onUnavailable(listener: (kind: EndpointLossKind, reason?: EndpointLossReason) => void): () => void {
    this.events.on("unavailable", listener);
    return () => this.events.off("unavailable", listener);
  }
  onPermissionBlocked(listener: (event: PermissionBlockedEvent) => void): () => void {
    this.events.on("permissionBlocked", listener);
    return () => this.events.off("permissionBlocked", listener);
  }

  get mcpClientIdentity(): LinuxProcessIdentity | undefined {
    const identity = this.connectionIdentity?.allowedClientProcess;
    return identity ? { ...identity } : undefined;
  }

  private async connectionLost(generation: number, error?: Error): Promise<void> {
    if (generation !== this.generation || (this.state !== "ready" && this.state !== "starting")) return;
    this.state = "unavailable";
    await this.disposeConnection().catch(() => undefined);
    if (generation !== this.generation || this.state !== "unavailable") return;
    let kind: EndpointLossKind = "connection-lost";
    try { kind = await this.options.runtime.classifyLoss(); }
    catch { /* Unknown loss remains reconnectable connection loss. */ }
    if (generation === this.generation && this.state === "unavailable") {
      this.events.emit("unavailable", kind, classifyTransportLoss(error));
    }
  }

  private async disposeConnection(): Promise<void> {
    this.removeConnectionClose?.();
    delete this.removeConnectionClose;
    const client = this.client;
    const connection = this.connection;
    delete this.client;
    delete this.connection;
    delete this.connectionIdentity;
    client?.close();
    await connection?.close();
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
    if (request.method === "item/tool/call") {
      return {
        success: false,
        contentItems: [{ type: "inputText", text: "Interactive client tools are unavailable in this managed session. Continue without this tool." }],
      } satisfies DynamicToolCallResponse;
    }
    throw new Error(`Unhandled app-server request: ${request.method}`);
  }

  private current(generation: number, state: ManagedAppServerEndpoint["state"]): boolean {
    return generation === this.generation && this.state === state;
  }
  private currentConnection(generation: number, connection: AppServerConnection, client: RpcClient): boolean {
    return this.current(generation, "starting") && this.connection === connection && this.client === client;
  }
  private changed(): AppError {
    return new AppError("ENDPOINT_UNAVAILABLE", `app-server endpoint generation changed while starting: ${this.id}`);
  }
}

function classifyTransportLoss(error?: Error): EndpointLossReason {
  if (!error) return "transport_closed";
  const code = (error as Error & { code?: unknown }).code;
  if (code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") return "frame_too_large";
  if (error.message === "invalid App Server WebSocket frame") return "invalid_frame";
  return "transport_error";
}

function validAccountResponse(value: unknown): value is { account: unknown | null; requiresOpenaiAuth: boolean } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.hasOwn(value, "account") && Object.hasOwn(value, "requiresOpenaiAuth")
    && ((value as Record<string, unknown>).account === null
      || (typeof (value as Record<string, unknown>).account === "object" && !Array.isArray((value as Record<string, unknown>).account)))
    && typeof (value as Record<string, unknown>).requiresOpenaiAuth === "boolean";
}

function validConnectionIdentity(value: AppServerConnectionIdentity): AppServerConnectionIdentity {
  let runtime: RuntimeIdentity;
  try { runtime = parseRuntimeIdentity(value?.runtime); }
  catch { throw new AppError("ENDPOINT_UNAVAILABLE", "App Server connection returned an invalid runtime identity"); }
  const allowed = value?.allowedClientProcess;
  if (allowed !== undefined && (!Number.isSafeInteger(allowed.pid) || allowed.pid <= 1 || !/^\d+$/u.test(allowed.startTime))) {
    throw new AppError("ENDPOINT_UNAVAILABLE", "App Server connection returned an invalid client process identity");
  }
  return { runtime, ...(allowed === undefined ? {} : { allowedClientProcess: { ...allowed } }) };
}
