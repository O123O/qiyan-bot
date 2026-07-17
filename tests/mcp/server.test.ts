import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TOOL_NAMES, createAssistantTools, type AssistantToolName, type ToolHandler } from "../../src/assistant/tools.ts";
import { AssistantRuntime } from "../../src/assistant/runtime.ts";
import { buildAssistantChildEnvironment } from "../../src/assistant/profile.ts";
import { readLinuxProcessIdentity } from "../../src/core/process-identity.ts";
import { buildWorkerChildEnvironment, assistantTurnConfig, LoopbackMcpServer, tcpConnectionInodes, ToolReadinessGate } from "../../src/mcp/server.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";
import { ConversationStore } from "../../src/storage/conversation-store.ts";

test("loopback MCP requires bearer auth, advertises instructions, lists tools, and propagates request IDs", async (t) => {
  const operations = new OperationStore(createTestDatabase());
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "1", rawText: "ordinary", attachmentIds: [] });
  let received: any;
  const tools = createAssistantTools(operations, { list_managed_sessions: async (_args, context) => { received = context; return []; } }, { maxCollectCount: 20 });
  const self = await readLinuxProcessIdentity(process.pid);
  const server = new LoopbackMcpServer(tools, { current: () => ({ contextId: "ctx", attemptId: "a", turnId: "t" }) }, { host: "127.0.0.1", port: 0, token: "secret", allowedClientProcess: () => self });
  await server.start();
  t.after(() => server.stop());
  assert.equal((await fetch(server.url, { method: "POST", body: "{}" })).status, 401);

  const client = new Client({ name: "test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: "Bearer secret" } } });
  await client.connect(transport as any);
  assert.match(client.getInstructions() ?? "", /assistant/i);
  const advertised = (await client.listTools()).tools;
  assert.deepEqual(advertised.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
  const send = advertised.find((tool) => tool.name === "send_to_session");
  assert.deepEqual(new Set(send?.inputSchema.required), new Set(["nickname", "content", "mode"]));
  assert.ok(send?.inputSchema.properties?.nickname);
  const result = await client.callTool({ name: "list_managed_sessions", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(received.sourceContextId, "ctx");
  assert.match(received.callId, /^mcp:/);
  await client.close();
  await server.stop();
});

test("inactive assistant context is rejected and non-loopback binding is refused", async (t) => {
  const operations = new OperationStore(createTestDatabase());
  const tools = createAssistantTools(operations, {}, { maxCollectCount: 20 });
  assert.throws(() => new LoopbackMcpServer(tools, { current: () => undefined }, { host: "0.0.0.0" as "127.0.0.1", port: 0, token: "x" }));
  const server = new LoopbackMcpServer(tools, { current: () => undefined }, { host: "127.0.0.1", port: 0, token: "x" });
  await server.start();
  t.after(() => server.stop());
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: "Bearer x" } } }) as any);
  const result = await client.callTool({ name: "list_managed_sessions", arguments: {} });
  assert.equal(result.isError, true);
  await client.close(); await server.stop();
});

test("assistant tools wait at the MCP boundary until startup reconciliation is ready", async (t) => {
  const operations = new OperationStore(createTestDatabase());
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "1", rawText: "ordinary", attachmentIds: [] });
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  let called = false;
  const tools = createAssistantTools(operations, {
    list_managed_sessions: async () => { called = true; return []; },
  }, { maxCollectCount: 20 });
  const server = new LoopbackMcpServer(
    tools,
    { current: () => ({ contextId: "ctx", attemptId: "a", turnId: "t" }) },
    { host: "127.0.0.1", port: 0, token: "secret", beforeToolCall: () => ready },
  );
  await server.start();
  t.after(() => server.stop());
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: "Bearer secret" } } }) as any);

  const pending = client.callTool({ name: "list_managed_sessions", arguments: {} });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(called, false);
  release();
  assert.equal((await pending).isError, undefined);
  assert.equal(called, true);
  await client.close();
  await server.stop();
});

test("post-tool callback follows finish for successful and rejected handlers", async (t) => {
  const events: string[] = [];
  let rejectHandler = false;
  const tools = {} as Record<AssistantToolName, ToolHandler>;
  for (const name of TOOL_NAMES) {
    tools[name] = async () => {
      if (name === "list_managed_sessions") {
        events.push("handler");
        if (rejectHandler) throw new Error("handler rejected");
      }
      return [];
    };
  }
  const server = new LoopbackMcpServer(tools, {
    current: () => ({ contextId: "ctx", attemptId: "attempt", turnId: "turn" }),
    registerTool: () => { events.push("register"); return 0; },
    finishTool: () => { events.push("finish"); },
  }, {
    host: "127.0.0.1",
    port: 0,
    token: "secret",
    afterToolCall: () => { events.push("after"); throw new Error("contained callback failure"); },
  });
  await server.start();
  t.after(() => server.stop());
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: "Bearer secret" } } }) as any);

  assert.equal((await client.callTool({ name: "list_managed_sessions", arguments: {} })).isError, undefined);
  assert.deepEqual(events, ["register", "handler", "finish", "after"]);
  events.length = 0;
  rejectHandler = true;
  assert.equal((await client.callTool({ name: "list_managed_sessions", arguments: {} })).isError, true);
  assert.deepEqual(events, ["register", "handler", "finish", "after"]);

  await client.close();
  await server.stop();
});

test("long SSE tool calls receive heartbeats and still deliver their final response", async (t) => {
  let releaseTool!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseTool = resolve; });
  const tools = {} as Record<AssistantToolName, ToolHandler>;
  for (const name of TOOL_NAMES) {
    tools[name] = async () => {
      if (name === "list_managed_sessions") await blocked;
      return { sessions: {} };
    };
  }
  const server = new LoopbackMcpServer(
    tools,
    { current: () => ({ contextId: "ctx", attemptId: "attempt", turnId: "turn" }) },
    { host: "127.0.0.1", port: 0, token: "secret", sseHeartbeatIntervalMs: 10 },
  );
  await server.start();
  t.after(async () => { releaseTool(); await server.stop(); });

  const url = new URL(server.url);
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "list_managed_sessions", arguments: {} },
  });
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const outgoing = request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        "mcp-protocol-version": "2025-11-25",
      },
    }, resolve);
    outgoing.once("error", reject);
    outgoing.end(payload);
  });
  assert.equal(response.headers["content-type"], "text/event-stream");
  let body = "";
  let observedHeartbeat!: () => void;
  const heartbeat = new Promise<void>((resolve) => { observedHeartbeat = resolve; });
  response.on("data", (chunk: Buffer) => {
    body += chunk.toString("utf8");
    if (body.includes(": qiyan-keepalive\n\n")) observedHeartbeat();
  });
  await Promise.race([
    heartbeat,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("SSE heartbeat was not emitted")), 250)),
  ]);

  releaseTool();
  await once(response, "end");
  const messages = body.split("\n").filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
  assert.deepEqual(messages, [{
    result: { content: [{ type: "text", text: JSON.stringify({ sessions: {} }) }] },
    jsonrpc: "2.0",
    id: 1,
  }]);
});

test("shutdown fences a pending attempt after readiness but before tool registration", async (t) => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const conversations = new ConversationStore(db, new DeliveryStore(db));
  conversations.createInternalSource({ id: "ctx", kind: "event_batch", sourceId: "ctx", rawText: "", attachmentIds: [], receivedAt: 1 });
  const lease = conversations.createAttempt({ kind: "internal", contextId: "ctx" });
  conversations.reserveStart(lease.attemptId, "ctx");
  const runtime = new AssistantRuntime(db, operations, new DeliveryStore(db), {
    binding: { adapterId: "telegram", conversationKey: "telegram:42", destination: { chatId: "42" } },
  });
  runtime.activateAttempt(lease.attemptId);
  assert.equal(runtime.current()?.turnId, undefined);

  const gate = new ToolReadinessGate();
  gate.ready();
  let passedReadiness!: () => void;
  const readyPassed = new Promise<void>((resolve) => { passedReadiness = resolve; });
  let continueRegistration!: () => void;
  const registrationPaused = new Promise<void>((resolve) => { continueRegistration = resolve; });
  let handlerCalled = false;
  const tools = {} as Record<AssistantToolName, ToolHandler>;
  for (const name of TOOL_NAMES) tools[name] = async () => { handlerCalled = true; return []; };
  const server = new LoopbackMcpServer(tools, runtime, {
    host: "127.0.0.1",
    port: 0,
    token: "secret",
    beforeToolCall: async () => {
      await gate.wait();
      passedReadiness();
      await registrationPaused;
    },
  });
  await server.start();
  t.after(() => { continueRegistration(); return server.stop(); });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: "Bearer secret" } } }) as any);

  const pending = client.callTool({ name: "list_managed_sessions", arguments: {} });
  await readyPassed;
  gate.stop();
  runtime.fenceToolAdmission();
  await runtime.waitForTools();
  assert.throws(() => runtime.registerTool(lease.attemptId), /terminal/u);
  continueRegistration();
  assert.equal((await pending).isError, true);
  assert.equal(handlerCalled, false);

  await client.close();
  await server.stop();
});

test("reconnect blocks tool readiness until the owning recovery pipeline reopens it", async () => {
  const gate = new ToolReadinessGate();
  gate.ready();
  await gate.wait();
  gate.block();
  let released = false;
  const pending = gate.wait().then(() => { released = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(released, false);
  gate.ready();
  await pending;
  assert.equal(released, true);
});

test("a bearer token alone is rejected outside the authorized process tree", async (t) => {
  const operations = new OperationStore(createTestDatabase());
  const tools = createAssistantTools(operations, {}, { maxCollectCount: 20 });
  const server = new LoopbackMcpServer(tools, { current: () => undefined }, { host: "127.0.0.1", port: 0, token: "secret", allowedClientProcess: () => ({ pid: -1, startTime: "0" }) });
  await server.start(); t.after(() => server.stop());
  assert.equal((await fetch(server.url, { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" })).status, 403);
});

test("a token-bearing child of the exact MCP client process is rejected", async (t) => {
  const operations = new OperationStore(createTestDatabase());
  const tools = createAssistantTools(operations, {}, { maxCollectCount: 20 });
  let allowedProcess: { pid: number; startTime: string } | undefined;
  const server = new LoopbackMcpServer(tools, { current: () => undefined }, {
    host: "127.0.0.1", port: 0, token: "secret", allowedClientProcess: () => allowedProcess,
  });
  await server.start(); t.after(() => server.stop());

  const requester = `setTimeout(async () => {
    const response = await fetch(process.env.MCP_URL, { method: "POST", headers: { authorization: "Bearer " + process.env.MCP_TOKEN }, body: "{}" });
    process.stdout.write(String(response.status));
  }, 50);`;
  const run = async (nested: boolean, wrongStartTime = false): Promise<number> => {
    const source = nested
      ? `const { spawnSync } = require("node:child_process"); const result = spawnSync(process.execPath, ["-e", ${JSON.stringify(requester)}], { env: process.env, encoding: "utf8" }); process.stdout.write(result.stdout); process.exitCode = result.status ?? 1;`
      : requester;
    const child = spawn(process.execPath, ["-e", source], {
      env: { MCP_URL: server.url, MCP_TOKEN: "secret", PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    allowedProcess = await readLinuxProcessIdentity(child.pid!);
    if (wrongStartTime) allowedProcess = { ...allowedProcess, startTime: `${allowedProcess.startTime}-wrong` };
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
    return Number(stdout);
  };

  assert.equal(await run(false), 406, "the exact live socket owner must reach the MCP transport");
  assert.equal(await run(false, true), 403, "PID reuse must be rejected by process start time");
  assert.equal(await run(true), 403, "a descendant must be rejected even when it has the bearer token");
});

test("client socket lookup matches the complete IPv4 tuple instead of only its ports", () => {
  const table = `
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:C350 0100007F:1234 01 00000000:00000000 00:00000000 00000000 1000 0 11111 1
   1: 0200007F:C350 0100007F:1234 01 00000000:00000000 00:00000000 00000000 1000 0 22222 1
  `;
  assert.deepEqual(tcpConnectionInodes(table, {
    remoteAddress: "127.0.0.2",
    remotePort: 0xc350,
    localAddress: "127.0.0.1",
    localPort: 0x1234,
    family: "IPv4",
  }), ["22222"]);
});

test("worker environment preserves user configuration while removing only exact bot credentials", () => {
  const env = buildWorkerChildEnvironment({
    PATH: "/bin",
    HOME: "/home/u",
    CODEX_HOME: "/codex",
    OPENAI_API_KEY: "auth",
    USER_MCP_TOKEN: "user-tool-auth",
    CUSTOM_TOOL_HOME: "/custom/tools",
    TELEGRAM_THEME: "dark",
    TELEGRAM_BOT_TOKEN: "bot-secret",
    TELEGRAM_OWNER_ID: "42",
    TELEGRAM_DESTINATION_CHAT_ID: "42",
    SLACK_APP_TOKEN: "xapp-secret",
    SLACK_BOT_TOKEN: "xoxb-secret",
    SLACK_USER_TOKEN: "xoxp-secret",
    SLACK_TEAM_ID: "T123",
    SLACK_OWNER_USER_ID: "U123",
    PRIMARY_CHAT_APP: "telegram",
    QIYAN_BOT_MCP_TOKEN: "manager-secret",
  });
  assert.equal(env.OPENAI_API_KEY, "auth");
  assert.equal(env.USER_MCP_TOKEN, "user-tool-auth");
  assert.equal(env.CUSTOM_TOOL_HOME, "/custom/tools");
  assert.equal(env.TELEGRAM_THEME, "dark");
  for (const key of [
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_ID", "TELEGRAM_DESTINATION_CHAT_ID",
    "SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "SLACK_USER_TOKEN", "SLACK_TEAM_ID", "SLACK_OWNER_USER_ID", "PRIMARY_CHAT_APP",
    "QIYAN_BOT_MCP_TOKEN",
  ]) {
    assert.equal(env[key], undefined);
  }
  const config = assistantTurnConfig("http://127.0.0.1:1/mcp", "mcp-secret", {
    userHome: "/home/user",
    codexHome: "/private/manager-codex",
  });
  const manager = (config.mcp_servers as { qiyan_bot_manager: Record<string, unknown> }).qiyan_bot_manager;
  assert.equal(manager.default_tools_approval_mode, "approve");
  assert.equal(manager.tool_timeout_sec, 600);
  assert.deepEqual((config["shell_environment_policy.exclude"] as any).includes("QIYAN_BOT_MCP_TOKEN"), true);
  assert.deepEqual(config["shell_environment_policy.set"], {
    HOME: "/home/user",
    CODEX_HOME: "/private/manager-codex",
  });
  assert.equal(config.allow_login_shell, false);
  assert.equal(JSON.stringify(config).includes("mcp-secret"), false);
});

test("assistant child is allowlisted while the worker retains the complete user environment", () => {
  const host = {
    PATH: "/bin", HOME: "/home/user", CODEX_HOME: "/home/user/.codex", OPENAI_API_KEY: "auth",
    USER_MCP_TOKEN: "worker-only", TELEGRAM_THEME: "dark", TELEGRAM_BOT_TOKEN: "secret",
    SLACK_APP_TOKEN: "xapp-secret", SLACK_BOT_TOKEN: "xoxb-secret", SLACK_USER_TOKEN: "xoxp-secret",
    SLACK_TEAM_ID: "T123", SLACK_OWNER_USER_ID: "U123", PRIMARY_CHAT_APP: "slack",
    SSL_CERT_FILE: "/custom/ca.pem", SSL_CERT_DIR: "/custom/ca", NODE_EXTRA_CA_CERTS: "/custom/node-ca.pem",
  };
  const worker = buildWorkerChildEnvironment(host);
  const assistant = buildAssistantChildEnvironment(host, { home: "/private/manager-home", codexHome: "/private/manager-codex" }, "manager-token");
  assert.equal(worker.HOME, "/home/user");
  assert.equal(worker.CODEX_HOME, "/home/user/.codex");
  assert.equal(worker.QIYAN_BOT_MCP_TOKEN, undefined);
  assert.equal(worker.USER_MCP_TOKEN, "worker-only");
  assert.equal(worker.TELEGRAM_THEME, "dark");
  assert.equal(assistant.HOME, "/private/manager-home");
  assert.equal(assistant.CODEX_HOME, "/private/manager-codex");
  assert.equal(assistant.QIYAN_BOT_MCP_TOKEN, "manager-token");
  assert.equal(assistant.OPENAI_API_KEY, "auth");
  assert.equal(assistant.SSL_CERT_FILE, "/custom/ca.pem");
  assert.equal(assistant.SSL_CERT_DIR, "/custom/ca");
  assert.equal(assistant.NODE_EXTRA_CA_CERTS, "/custom/node-ca.pem");
  assert.equal(assistant.USER_MCP_TOKEN, undefined);
  assert.equal(assistant.TELEGRAM_THEME, undefined);
  assert.equal(assistant.TELEGRAM_BOT_TOKEN, undefined);
  for (const key of ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "SLACK_USER_TOKEN", "SLACK_TEAM_ID", "SLACK_OWNER_USER_ID", "PRIMARY_CHAT_APP"]) {
    assert.equal(worker[key], undefined);
    assert.equal(assistant[key], undefined);
  }
});
