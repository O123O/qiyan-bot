// Worker-facing scheduling MCP surface (Phase 2.4). Exposes the five provider-neutral
// scheduling tools to WORKER sessions (Codex or Claude), attached per-invocation via
// --mcp-config. Each worker turn carries a per-session bearer token that resolves to
// the calling session, so a tool call records a durable schedule for THAT session.
// The tool logic runs here (local QiYan); a remote worker reaches this over the
// session's own ssh reverse-tunnel (impl-plan §2.4) — out of scope for the local
// surface below.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { ScheduleStore } from "./schedule-store.ts";

export interface WorkerScheduleSession {
  nickname: string;
  endpointId: string;
  threadId: string;
}

export interface WorkerScheduleMcpOptions {
  store: ScheduleStore;
  // Resolve a per-session bearer token to the calling worker session.
  resolveToken(token: string): WorkerScheduleSession | undefined;
  now(): number;
  host?: "127.0.0.1";
  port?: number;
}

const SCHEDULE_TOOLS = ["schedule_wakeup", "schedule_cron", "monitor", "list_schedules", "cancel_schedule"] as const;
export const WORKER_SCHEDULE_TOOL_NAMES: readonly string[] = SCHEDULE_TOOLS;

export class WorkerScheduleMcpServer {
  private http: Server | undefined;
  private actualPort = 0;

  constructor(private readonly options: WorkerScheduleMcpOptions) {}

  get port(): number { return this.actualPort; }
  get url(): string { return `http://127.0.0.1:${this.actualPort}/mcp`; }

  async start(): Promise<void> {
    if (this.http) return;
    // Bind ONLY to loopback: this surface is bearer-token-authenticated (no peer-PID
    // check like the assistant LoopbackMcpServer), which is acceptable precisely
    // because loopback is not reachable across the a1..a8 NFS nodes. A non-loopback
    // bind would expose worker scheduling to the network — refuse it.
    if ((this.options.host ?? "127.0.0.1") !== "127.0.0.1") throw new Error("worker scheduling MCP must bind only to 127.0.0.1");
    const http = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(this.options.port ?? 0, this.options.host ?? "127.0.0.1", () => { http.off("error", reject); resolve(); });
    });
    this.actualPort = (http.address() as AddressInfo).port;
    this.http = http;
  }

  async stop(): Promise<void> {
    const http = this.http;
    this.http = undefined;
    if (http) await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  }

  private async handle(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    try {
      if (request.url !== "/mcp" || request.method !== "POST") {
        response.writeHead(405).end(JSON.stringify({ error: "method not allowed" })); return;
      }
      const auth = request.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const session = token ? this.options.resolveToken(token) : undefined;
      if (!session) { response.writeHead(401, { "www-authenticate": "Bearer" }).end(JSON.stringify({ error: "unauthorized" })); return; }
      const body = await readJson(request);
      const { transport } = await this.protocolServer(session);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500).end(JSON.stringify({ error: String((error as Error)?.message) }));
    }
  }

  private async protocolServer(session: WorkerScheduleSession): Promise<{ transport: StreamableHTTPServerTransport }> {
    const mcp = new McpServer({ name: "qiyan-worker-scheduling", version: "1" });
    const common = { nickname: session.nickname, endpointId: session.endpointId, threadId: session.threadId };

    mcp.registerTool("schedule_wakeup", {
      description: "Schedule a one-time wakeup: after delay_seconds, QiYan sends you `message` as a new turn so you can continue. Use for reminders / deferred work.",
      inputSchema: { delay_seconds: z.number().int().positive(), message: z.string().min(1) },
    }, async (args) => {
      const row = this.options.store.create({ ...common, kind: "wakeup", spec: String(args.delay_seconds), message: args.message, nextFireAt: this.options.now() + args.delay_seconds * 1000 }, this.options.now());
      return text(`scheduled wakeup ${row.id} in ${args.delay_seconds}s`);
    });

    mcp.registerTool("schedule_cron", {
      description: "Schedule a recurring wakeup every interval_seconds: QiYan repeatedly sends you `message` as a new turn. Use for periodic checks.",
      inputSchema: { interval_seconds: z.number().int().min(1), message: z.string().min(1) },
    }, async (args) => {
      const ms = args.interval_seconds * 1000;
      const row = this.options.store.create({ ...common, kind: "cron", spec: String(args.interval_seconds), message: args.message, nextFireAt: this.options.now() + ms, intervalMs: ms }, this.options.now());
      return text(`scheduled recurring ${row.id} every ${args.interval_seconds}s`);
    });

    mcp.registerTool("monitor", {
      description: "Watch a condition: QiYan runs `check` (a shell command) every poll_seconds on your session's host; when it exits 0, QiYan sends you `message` as a new turn. Use to wait for a build, a file, a job.",
      inputSchema: { check: z.string().min(1), message: z.string().min(1), poll_seconds: z.number().int().min(1).optional() },
    }, async (args) => {
      const ms = (args.poll_seconds ?? 30) * 1000;
      const row = this.options.store.create({ ...common, kind: "monitor", spec: args.check, message: args.message, nextFireAt: this.options.now() + ms, intervalMs: ms }, this.options.now());
      return text(`monitoring ${row.id}: fires when \`${args.check}\` succeeds`);
    });

    mcp.registerTool("list_schedules", {
      description: "List your active schedules (wakeups, crons, monitors).",
      inputSchema: {},
    }, async () => {
      const rows = this.options.store.listForSession(session.endpointId, session.threadId);
      return text(rows.length === 0 ? "no active schedules" : rows.map((r) => `${r.id} [${r.kind}] ${r.spec}`).join("\n"));
    });

    mcp.registerTool("cancel_schedule", {
      description: "Cancel one of your schedules by id (from list_schedules).",
      inputSchema: { id: z.string().min(1) },
    }, async (args) => {
      return text(this.options.store.cancel(session.endpointId, session.threadId, args.id)
        ? `cancelled ${args.id}`
        : `no such active schedule: ${args.id}`);
    });

    // SDK 1.29 models stateless mode as an explicitly-undefined generator, which
    // conflicts with exactOptionalPropertyTypes despite being the documented API
    // (same workaround as LoopbackMcpServer).
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as any);
    await mcp.connect(transport as any);
    return { transport };
  }
}

function text(message: string) { return { content: [{ type: "text" as const, text: message }] }; }

async function readJson(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}
