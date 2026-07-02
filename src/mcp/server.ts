import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, readdir, readlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { readLinuxProcessIdentity, type LinuxProcessIdentity } from "../core/process-identity.ts";
import type { AssistantToolName, ToolCallContext, ToolHandler } from "../assistant/tools.ts";
import { ASSISTANT_TOOL_SCHEMAS, TOOL_NAMES } from "../assistant/tools.ts";
import { APP_VERSION } from "../version.ts";

export interface AssistantContextProvider {
  current(): { contextId: string; attemptId: string; turnId: string } | undefined;
}

export class LoopbackMcpServer {
  private http: HttpServer | undefined;
  private readonly activeServers = new Set<McpServer>();
  private actualPort = 0;

  constructor(
    private readonly tools: Record<AssistantToolName, ToolHandler>,
    private readonly contexts: AssistantContextProvider,
    private readonly options: { host: "127.0.0.1"; port: number; token: string; allowedClientProcess?: () => LinuxProcessIdentity | undefined },
  ) {
    if (options.host !== "127.0.0.1") throw new Error("MCP server must bind only to 127.0.0.1");
    if (!options.token) throw new Error("MCP bearer token is required");
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
        const close = () => {
          if (closed) return;
          closed = true;
          this.activeServers.delete(mcp);
          void mcp.close().catch(() => undefined);
        };
        response.once("close", close);
        await transport.handleRequest(request, response, body);
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
      mcp.registerTool(name, { description: `QiYan assistant operation: ${name.replaceAll("_", " ")}`, inputSchema: ASSISTANT_TOOL_SCHEMAS[name] as any }, async (args: any, extra: any) => {
        const active = this.contexts.current();
        if (!active) throw new Error("No active assistant source context");
        const context: ToolCallContext = { sourceContextId: active.contextId, attemptId: active.attemptId, turnId: active.turnId, callId: `mcp:${String(extra.requestId)}` };
        const result = await this.tools[name](context, args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result ?? null) }] };
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

const workerCredentialDenylist = new Set([
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_OWNER_ID",
  "TELEGRAM_DESTINATION_CHAT_ID",
  "QIYAN_BOT_MCP_TOKEN",
]);

export function buildWorkerChildEnvironment(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(host)) {
    if (value !== undefined && !workerCredentialDenylist.has(key)) result[key] = value;
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

export function assistantTurnConfig(mcpUrl: string, _mcpToken: string): Record<string, unknown> {
  return {
    mcp_servers: { qiyan_bot_manager: { url: mcpUrl, bearer_token_env_var: "QIYAN_BOT_MCP_TOKEN", default_tools_approval_mode: "approve" } },
    ...secureShellConfig(),
  };
}

export function secureShellConfig(): Record<string, unknown> {
  return {
    allow_login_shell: false,
    "shell_environment_policy.inherit": "core",
    "shell_environment_policy.exclude": ["QIYAN_BOT_MCP_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_ID", "TELEGRAM_DESTINATION_CHAT_ID"],
  };
}
