import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TOOL_NAMES, createCoordinatorTools } from "../../src/coordinator/tools.ts";
import { buildCodexChildEnvironment, coordinatorTurnConfig, LoopbackMcpServer } from "../../src/mcp/server.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";

test("loopback MCP requires bearer auth, advertises instructions, lists tools, and propagates request IDs", async (t) => {
  const operations = new OperationStore(createTestDatabase());
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "1", rawText: "ordinary", attachmentIds: [] });
  let received: any;
  const tools = createCoordinatorTools(operations, { list_managed_sessions: async (_args, context) => { received = context; return []; } }, { maxCollectCount: 20 });
  const server = new LoopbackMcpServer(tools, { current: () => ({ contextId: "ctx", attemptId: "a", turnId: "t" }) }, { host: "127.0.0.1", port: 0, token: "secret" });
  await server.start();
  t.after(() => server.stop());
  assert.equal((await fetch(server.url, { method: "POST", body: "{}" })).status, 401);

  const client = new Client({ name: "test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: "Bearer secret" } } });
  await client.connect(transport as any);
  assert.match(client.getInstructions() ?? "", /coordinator/i);
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
  const result = await client.callTool({ name: "list_managed_sessions", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(received.sourceContextId, "ctx");
  assert.match(received.callId, /^mcp:/);
  await client.close();
  await server.stop();
});

test("inactive coordinator context is rejected and non-loopback binding is refused", async (t) => {
  const operations = new OperationStore(createTestDatabase());
  const tools = createCoordinatorTools(operations, {}, { maxCollectCount: 20 });
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

test("child environment keeps Codex auth but strips Telegram secrets and hides the MCP token from shells", () => {
  const env = buildCodexChildEnvironment({ PATH: "/bin", HOME: "/home/u", CODEX_HOME: "/codex", OPENAI_API_KEY: "auth", TELEGRAM_BOT_TOKEN: "leak", OTHER_SECRET: "no" }, "mcp-secret");
  assert.equal(env.OPENAI_API_KEY, "auth");
  assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(env.OTHER_SECRET, undefined);
  assert.equal(env.CODEX_BOT_MCP_TOKEN, "mcp-secret");
  const config = coordinatorTurnConfig("http://127.0.0.1:1/mcp", "mcp-secret");
  assert.deepEqual((config.shell_environment_policy as any).exclude.includes("CODEX_BOT_MCP_TOKEN"), true);
  assert.equal(JSON.stringify(config).includes("mcp-secret"), false);
});
