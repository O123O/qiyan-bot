import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalEndpoint } from "../../src/app-server/local-endpoint.ts";
import { AppServerPool } from "../../src/app-server/pool.ts";
import { createCoordinatorTools } from "../../src/coordinator/tools.ts";
import { buildCodexChildEnvironment, coordinatorTurnConfig, LoopbackMcpServer } from "../../src/mcp/server.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";

const enabled = process.env.RUN_CODEX_INTEGRATION === "1";

test("real coordinator can call manager MCP while its shell cannot read the bearer token", { skip: !enabled, timeout: 180_000 }, async (t) => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "1", rawText: "integration", attachmentIds: [] });
  let calls = 0;
  const tools = createCoordinatorTools(operations, { list_managed_sessions: async () => { calls += 1; return { sessions: [] }; } }, { maxCollectCount: 20 });
  const token = "integration-secret-token";
  let active = { contextId: "ctx", attemptId: "attempt", turnId: "pending" };
  const mcp = new LoopbackMcpServer(tools, { current: () => active }, { host: "127.0.0.1", port: 0, token });
  await mcp.start(); t.after(() => mcp.stop());
  const endpoint = new LocalEndpoint({ codexBinary: "codex", env: buildCodexChildEnvironment(process.env, token), requestTimeoutMs: 30_000 });
  await endpoint.start(); t.after(() => endpoint.stop());
  const cwd = await mkdtemp(join(tmpdir(), "codex-bot-real-mcp-"));
  const thread = await endpoint.request<any>("thread/start", {
    cwd, approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: false,
    config: coordinatorTurnConfig(mcp.url, token),
  });
  const terminal = new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MCP integration timed out")), 120_000);
    const unsubscribe = endpoint.onNotification((method, params: any) => {
      if (method === "turn/completed" && params.threadId === thread.thread.id) { clearTimeout(timeout); unsubscribe(); resolve(params.turn); }
    });
  });
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  const started = await pool.startTurn<any>(endpoint.id, {
    threadId: thread.thread.id,
    clientUserMessageId: "mcp-integration",
    input: [{ type: "text", text: "Call list_managed_sessions once. Then run `if printenv CODEX_BOT_MCP_TOKEN >/dev/null; then echo TOKEN_VISIBLE; else echo TOKEN_HIDDEN; fi`. Reply with exactly MCP_OK only if the tool succeeds and the command prints TOKEN_HIDDEN.", text_elements: [] }],
  });
  active = { ...active, turnId: started.turn.id };
  const completed = await terminal;
  pool.markTurnTerminal(endpoint.id, thread.thread.id, started.turn.id);
  assert.equal(completed.status, "completed");
  assert.equal(calls, 1);
  const history = await endpoint.request<any>("thread/read", { threadId: thread.thread.id, includeTurns: true });
  const completedFromHistory = history.thread.turns.find((turn: any) => turn.id === started.turn.id);
  assert.ok(completedFromHistory.items.some((item: any) => item.type === "agentMessage" && item.text.includes("MCP_OK")));
  assert.equal(JSON.stringify(completedFromHistory).includes(token), false);
});
