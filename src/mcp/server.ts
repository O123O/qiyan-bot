import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { CoordinatorToolName, ToolCallContext, ToolHandler } from "../coordinator/tools.ts";
import { TOOL_NAMES } from "../coordinator/tools.ts";

export interface CoordinatorContextProvider {
  current(): { contextId: string; attemptId: string; turnId: string } | undefined;
}

export class LoopbackMcpServer {
  private http: HttpServer | undefined;
  private readonly activeServers = new Set<McpServer>();
  private actualPort = 0;

  constructor(
    private readonly tools: Record<CoordinatorToolName, ToolHandler>,
    private readonly contexts: CoordinatorContextProvider,
    private readonly options: { host: "127.0.0.1"; port: number; token: string },
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
        const body = await readJson(request);
        const { mcp, transport } = await this.createProtocolServer();
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          this.activeServers.delete(mcp);
          void mcp.close();
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
      { name: "codex-chat-bot-manager", version: "0.1.0" },
      { instructions: "Coordinator-only manager tools. Choose the correct managed session, ask the user when ambiguous, and use ordinary send/collect tools for /pass and /collect." },
    );
    for (const name of TOOL_NAMES) {
      mcp.registerTool(name, { description: `Codex bot coordinator operation: ${name}`, inputSchema: z.object({}).catchall(z.unknown()) }, async (args, extra) => {
        const active = this.contexts.current();
        if (!active) throw new Error("No active coordinator source context");
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
]);

export function buildCodexChildEnvironment(host: NodeJS.ProcessEnv, mcpToken: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(host)) {
    if (value !== undefined && (inheritedEnvironmentKeys.has(key) || key.startsWith("LC_"))) result[key] = value;
  }
  result.CODEX_BOT_MCP_TOKEN = mcpToken;
  return result;
}

export function coordinatorTurnConfig(mcpUrl: string, _mcpToken: string): Record<string, unknown> {
  return {
    mcp_servers: { codex_bot_manager: { url: mcpUrl, bearer_token_env_var: "CODEX_BOT_MCP_TOKEN" } },
    shell_environment_policy: { exclude: ["CODEX_BOT_MCP_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_ID", "TELEGRAM_DESTINATION_CHAT_ID"] },
  };
}
