import { createServer, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, readdir, readlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { BOT_SECRET_ENV_NAMES } from "../config-source.ts";
import { readLinuxProcessIdentity, type LinuxProcessIdentity } from "../core/process-identity.ts";
import type { AssistantToolName, ToolCallContext, ToolHandler } from "../assistant/tools.ts";
import { ASSISTANT_TOOL_SCHEMAS, TOOL_DESCRIPTIONS, TOOL_NAMES } from "../assistant/tools.ts";
import { APP_VERSION } from "../version.ts";

const DEFAULT_SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export interface AssistantContextProvider {
  current(): { contextId: string; attemptId: string; turnId?: string; toolFence?: number } | undefined;
  registerTool?(attemptId: string): number;
  finishTool?(attemptId: string): void;
}

export class ToolReadinessGate {
  private readyState = false;
  private stopped = false;
  private readonly waiters = new Set<{ resolve(): void; reject(error: Error): void }>();

  async wait(): Promise<void> {
    if (this.readyState) return;
    if (this.stopped) throw new Error("assistant tools are unavailable during shutdown");
    await new Promise<void>((resolve, reject) => this.waiters.add({ resolve, reject }));
  }

  ready(): void {
    if (this.stopped) return;
    this.readyState = true;
    for (const waiter of this.waiters) waiter.resolve();
    this.waiters.clear();
  }

  block(): void { this.readyState = false; }

  stop(): void {
    this.stopped = true;
    this.readyState = false;
    const error = new Error("assistant tools are unavailable during shutdown");
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
  }
}

export class LoopbackMcpServer {
  private http: HttpServer | undefined;
  private readonly activeServers = new Set<McpServer>();
  private actualPort = 0;

  constructor(
    private readonly tools: Record<AssistantToolName, ToolHandler>,
    private readonly contexts: AssistantContextProvider,
    private readonly options: {
      host: "127.0.0.1";
      port: number;
      token: string;
      allowedClientProcess?: () => LinuxProcessIdentity | undefined;
      beforeToolCall?: () => Promise<void>;
      afterToolCall?: (attemptId: string) => void;
      sseHeartbeatIntervalMs?: number;
    },
  ) {
    if (options.host !== "127.0.0.1") throw new Error("MCP server must bind only to 127.0.0.1");
    if (!options.token) throw new Error("MCP bearer token is required");
    if (options.sseHeartbeatIntervalMs !== undefined
      && (!Number.isSafeInteger(options.sseHeartbeatIntervalMs) || options.sseHeartbeatIntervalMs <= 0)) {
      throw new Error("MCP SSE heartbeat interval must be a positive integer");
    }
  }

  get url(): string { return `http://127.0.0.1:${this.actualPort}/mcp`; }

  async start(): Promise<void> {
    if (this.http) return;
    const http = createServer(async (request, response) => {
      try {
        if (request.url !== "/mcp" || request.method !== "POST") {
          response.writeHead(405, { "content-type": "application/json" }).end(JSON.stringify({ error: "method not allowed" }));
          return;
        }
        if (request.headers.authorization !== `Bearer ${this.options.token}`) {
          response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" }).end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        if (this.options.allowedClientProcess && !await requestBelongsToProcess({
          remoteAddress: request.socket.remoteAddress,
          remotePort: request.socket.remotePort,
          localAddress: request.socket.localAddress,
          localPort: request.socket.localPort,
          family: request.socket.remoteFamily,
        }, this.options.allowedClientProcess())) {
          response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "client process is not authorized" }));
          return;
        }
        const body = await readJson(request);
        const { mcp, transport } = await this.createProtocolServer();
        let closed = false;
        let eventStreamResponse = false;
        const writeHead = response.writeHead;
        response.writeHead = function (this: ServerResponse, ...args: any[]) {
          const headers = typeof args[1] === "string" ? args[2] : args[1];
          const contentType = responseHeader(headers, "content-type") ?? response.getHeader("content-type");
          eventStreamResponse = String(contentType ?? "").toLowerCase().startsWith("text/event-stream");
          return Reflect.apply(writeHead, this, args);
        } as typeof response.writeHead;
        const heartbeat = setInterval(() => {
          if (!eventStreamResponse || !response.headersSent || response.writableEnded || response.destroyed) return;
          try { response.write(": qiyan-keepalive\n\n"); }
          catch { clearInterval(heartbeat); }
        }, this.options.sseHeartbeatIntervalMs ?? DEFAULT_SSE_HEARTBEAT_INTERVAL_MS);
        heartbeat.unref?.();
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          this.activeServers.delete(mcp);
          void mcp.close().catch(() => undefined);
        };
        response.once("close", close);
        response.once("finish", () => clearInterval(heartbeat));
        try { await transport.handleRequest(request, response, body); }
        finally { clearInterval(heartbeat); }
      } catch (error) {
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        if (!response.writableEnded) response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: error instanceof Error ? error.message : "internal error" } }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(this.options.port, this.options.host, () => { http.off("error", reject); resolve(); });
    });
    this.actualPort = (http.address() as AddressInfo).port;
    this.http = http;
  }

  async stop(): Promise<void> {
    const http = this.http;
    this.http = undefined;
    if (http) await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    await Promise.all([...this.activeServers].map((server) => server.close()));
    this.activeServers.clear(); this.actualPort = 0;
  }

  private async createProtocolServer(): Promise<{ mcp: McpServer; transport: StreamableHTTPServerTransport }> {
    const mcp = new McpServer(
      { name: "qiyan-bot-manager", version: APP_VERSION },
      { instructions: "Assistant-only manager tools. Choose the correct managed session, ask the user when ambiguous, and use ordinary send/collect tools for /pass and /collect." },
    );
    for (const name of TOOL_NAMES) {
      mcp.registerTool(name, { description: TOOL_DESCRIPTIONS[name] ?? `QiYan assistant operation: ${name.replaceAll("_", " ")}`, inputSchema: ASSISTANT_TOOL_SCHEMAS[name] as any }, async (args: any, extra: any) => {
        await this.options.beforeToolCall?.();
        const active = this.contexts.current();
        if (!active) throw new Error("No active assistant source context");
        const toolFence = this.contexts.registerTool?.(active.attemptId) ?? active.toolFence;
        const context: ToolCallContext = {
          sourceContextId: active.contextId,
          attemptId: active.attemptId,
          callId: `mcp:${String(extra.requestId)}`,
          ...(active.turnId ? { turnId: active.turnId } : {}),
          ...(toolFence === undefined ? {} : { toolFence }),
          ...(extra.signal ? { signal: extra.signal as AbortSignal } : {}),
        };
        try {
          const result = await this.tools[name](context, args);
          return { content: [{ type: "text" as const, text: JSON.stringify(result ?? null) }] };
        } finally {
          this.contexts.finishTool?.(active.attemptId);
          try { this.options.afterToolCall?.(active.attemptId); }
          catch { /* Recovery wake failures are contained at the MCP boundary. */ }
        }
      });
    }
    // SDK 1.29 models stateless mode as an explicitly undefined generator, which
    // conflicts with TypeScript's exactOptionalPropertyTypes despite being its documented API.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as any);
    await mcp.connect(transport as any);
    this.activeServers.add(mcp);
    return { mcp, transport };
  }
}

export interface TcpConnectionTuple {
  remoteAddress: string | undefined;
  remotePort: number | undefined;
  localAddress: string | undefined;
  localPort: number | undefined;
  family: string | undefined;
}

export function tcpConnectionInodes(table: string, connection: TcpConnectionTuple): string[] {
  if (connection.family !== "IPv4" || !connection.remotePort || !connection.localPort) return [];
  const sourceAddress = ipv4ProcHex(connection.remoteAddress);
  const destinationAddress = ipv4ProcHex(connection.localAddress);
  if (!sourceAddress || !destinationAddress) return [];
  const source = `${sourceAddress}:${connection.remotePort.toString(16).toUpperCase().padStart(4, "0")}`;
  const destination = `${destinationAddress}:${connection.localPort.toString(16).toUpperCase().padStart(4, "0")}`;
  const inodes: string[] = [];
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/u);
    if (fields[1] === source && fields[2] === destination && fields[3] === "01" && fields[9]) inodes.push(fields[9]);
  }
  return inodes;
}

async function requestBelongsToProcess(connection: TcpConnectionTuple, expected: LinuxProcessIdentity | undefined): Promise<boolean> {
  if (!expected || process.platform !== "linux" || connection.family !== "IPv4") return false;
  try {
    if (!sameProcess(await readLinuxProcessIdentity(expected.pid), expected)) return false;
    const table = await readFile("/proc/net/tcp", "utf8").catch(() => "");
    const inodes = new Set(tcpConnectionInodes(table, connection));
    if (inodes.size === 0) return false;
    let ownsSocket = false;
    for (const fd of await readdir(`/proc/${expected.pid}/fd`).catch(() => [])) {
      const target = await readlink(`/proc/${expected.pid}/fd/${fd}`).catch(() => "");
      if (target.startsWith("socket:[") && inodes.has(target.slice(8, -1))) { ownsSocket = true; break; }
    }
    return ownsSocket && sameProcess(await readLinuxProcessIdentity(expected.pid), expected);
  } catch {
    return false;
  }
}

function sameProcess(left: LinuxProcessIdentity, right: LinuxProcessIdentity): boolean {
  return left.pid === right.pid && left.startTime === right.startTime;
}

function responseHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  if (Array.isArray(headers)) {
    for (let index = 0; index + 1 < headers.length; index += 2) {
      if (String(headers[index]).toLowerCase() === name) return String(headers[index + 1]);
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && value !== undefined) return Array.isArray(value) ? value.join(", ") : String(value);
  }
  return undefined;
}

function ipv4ProcHex(address: string | undefined): string | undefined {
  const octets = address?.split(".").map(Number);
  if (!octets || octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
  return [...octets].reverse().map((octet) => octet.toString(16).toUpperCase().padStart(2, "0")).join("");
}

async function readJson(request: AsyncIterable<Uint8Array>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("MCP request too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const inheritedEnvironmentKeys = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM", "CODEX_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "OPENAI_API_KEY", "CODEX_API_KEY", "AZURE_OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);

export function buildWorkerChildEnvironment(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(host)) {
    if (value !== undefined && !BOT_SECRET_ENV_NAMES.has(key)) result[key] = value;
  }
  return result;
}

export function buildAssistantBaseEnvironment(host: NodeJS.ProcessEnv, mcpToken?: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(host)) {
    if (value !== undefined && (inheritedEnvironmentKeys.has(key) || key.startsWith("LC_"))) result[key] = value;
  }
  if (mcpToken) result.QIYAN_BOT_MCP_TOKEN = mcpToken;
  return result;
}

export function assistantTurnConfig(
  mcpUrl: string,
  _mcpToken: string,
  shellEnvironment: { userHome: string; codexHome: string },
): Record<string, unknown> {
  return {
    mcp_servers: {
      qiyan_bot_manager: {
        url: mcpUrl,
        bearer_token_env_var: "QIYAN_BOT_MCP_TOKEN",
        default_tools_approval_mode: "approve",
        tool_timeout_sec: 600,
      },
    },
    ...secureShellConfig(shellEnvironment),
  };
}

export function secureShellConfig(shellEnvironment: { userHome: string; codexHome: string }): Record<string, unknown> {
  return {
    allow_login_shell: false,
    "shell_environment_policy.inherit": "core",
    "shell_environment_policy.exclude": [...BOT_SECRET_ENV_NAMES],
    "shell_environment_policy.set": {
      HOME: shellEnvironment.userHome,
      CODEX_HOME: shellEnvironment.codexHome,
    },
  };
}
