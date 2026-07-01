import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalEndpoint } from "../../src/app-server/local-endpoint.ts";
import { JsonRpcResponseError } from "../../src/app-server/json-rpc-client.ts";
import { AppServerPool } from "../../src/app-server/pool.ts";
import { createCoordinatorTools } from "../../src/coordinator/tools.ts";
import { buildCoordinatorChildEnvironment } from "../../src/coordinator/profile.ts";
import { buildCodexChildEnvironment, coordinatorTurnConfig, LoopbackMcpServer, secureShellConfig } from "../../src/mcp/server.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";

const enabled = process.env.RUN_CODEX_INTEGRATION === "1";

async function writeSkill(root: string, name: string): Promise<void> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: Integration fixture ${name}\n---\n\n# ${name}\n`);
}

test("isolated app-server persists thread provenance and excludes normal-home skills", { skip: !enabled, timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-bot-profile-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const normalHome = join(root, "normal-home");
  const coordinatorHome = join(root, "coordinator-home");
  const coordinatorCodexHome = join(root, "coordinator-codex");
  const workdir = join(root, "coordinator-workdir");
  const repository = join(root, "repository");
  const nestedWorkdir = join(repository, "manager");
  await Promise.all([
    mkdir(coordinatorCodexHome, { recursive: true }), mkdir(workdir, { recursive: true }),
    mkdir(join(repository, ".git"), { recursive: true }), mkdir(nestedWorkdir, { recursive: true }),
    writeSkill(join(normalHome, ".agents/skills"), "normal-user-only"),
    writeSkill(join(coordinatorHome, ".agents/skills"), "coordinator-only"),
    writeSkill(join(workdir, ".agents/skills"), "coordinator-workdir"),
    writeSkill(join(repository, ".agents/skills"), "repository-parent"),
  ]);
  const endpoint = new LocalEndpoint({
    id: "coordinator-local",
    codexBinary: "codex",
    env: buildCoordinatorChildEnvironment({ ...process.env, HOME: normalHome }, { home: coordinatorHome, codexHome: coordinatorCodexHome }),
    expectedCodexHome: coordinatorCodexHome,
    requestTimeoutMs: 30_000,
  });
  await endpoint.start();
  t.after(() => endpoint.stop());

  const skills = await endpoint.request<any>("skills/list", { cwds: [workdir, nestedWorkdir], forceReload: true });
  const names = new Map<string, string[]>(skills.data.map((entry: any) => [entry.cwd, entry.skills.map((skill: any) => skill.name)]));
  assert.equal(names.get(workdir)?.includes("coordinator-only"), true);
  assert.equal(names.get(workdir)?.includes("coordinator-workdir"), true);
  assert.equal(names.get(workdir)?.includes("normal-user-only"), false);
  assert.equal(names.get(nestedWorkdir)?.includes("repository-parent"), true);
  assert.equal(names.get(nestedWorkdir)?.includes("normal-user-only"), false);

  const volatile = await endpoint.request<any>("thread/start", {
    cwd: workdir,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    ephemeral: false,
    threadSource: crypto.randomUUID(),
  });
  await endpoint.stop();
  await endpoint.start();
  await assert.rejects(endpoint.request("thread/read", { threadId: volatile.thread.id, includeTurns: false }),
    (error: unknown) => error instanceof JsonRpcResponseError && error.code === -32600 && error.rpcMessage === `thread not loaded: ${volatile.thread.id}`);

  const nonce = crypto.randomUUID();
  const started = await endpoint.request<any>("thread/start", {
    cwd: workdir,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    ephemeral: false,
    threadSource: nonce,
  });
  const name = `codex-bot-coordinator:${nonce}`;
  await endpoint.request("thread/name/set", { threadId: started.thread.id, name });
  await endpoint.stop();
  await endpoint.start();
  const read = await endpoint.request<any>("thread/read", { threadId: started.thread.id, includeTurns: false });
  const resumed = await endpoint.request<any>("thread/resume", {
    threadId: started.thread.id,
    cwd: workdir,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    config: {},
  });
  assert.deepEqual({
    start: started.thread.threadSource ?? null,
    read: read.thread.threadSource ?? null,
    resume: resumed.thread.threadSource ?? null,
    startSource: started.thread.source,
    readSource: read.thread.source,
    resumeSource: resumed.thread.source,
    name: read.thread.name,
    resumeName: resumed.thread.name,
    cwd: read.thread.cwd,
    resumeCwd: resumed.thread.cwd,
  }, {
    start: nonce,
    read: nonce,
    resume: nonce,
    startSource: started.thread.source,
    readSource: read.thread.source,
    resumeSource: resumed.thread.source,
    name,
    resumeName: name,
    cwd: workdir,
    resumeCwd: workdir,
  });
});

test("real coordinator can call its approved manager MCP while a project worker cannot enumerate it", { skip: !enabled, timeout: 180_000 }, async (t) => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "1", rawText: "integration", attachmentIds: [] });
  let calls = 0;
  const tools = createCoordinatorTools(operations, { list_managed_sessions: async () => { calls += 1; return { sessions: [] }; } }, { maxCollectCount: 20 });
  const token = "integration-secret-token";
  const workerCodexHome = await mkdtemp(join(tmpdir(), "codex-bot-worker-home-"));
  t.after(() => rm(workerCodexHome, { recursive: true, force: true }));
  const endpoint = new LocalEndpoint({ id: "coordinator-local", codexBinary: "codex", env: buildCodexChildEnvironment(process.env, token), requestTimeoutMs: 30_000 });
  const worker = new LocalEndpoint({ id: "local", codexBinary: "codex", env: buildCodexChildEnvironment({ ...process.env, CODEX_HOME: workerCodexHome }), requestTimeoutMs: 30_000 });
  let active = { contextId: "ctx", attemptId: "attempt", turnId: "pending" };
  const mcp = new LoopbackMcpServer(tools, { current: () => active }, { host: "127.0.0.1", port: 0, token, allowedClientProcess: () => endpoint.mcpClientIdentity });
  await mcp.start(); t.after(() => mcp.stop());
  await endpoint.start(); t.after(() => endpoint.stop());
  await worker.start(); t.after(() => worker.stop());
  const workerThread = await worker.request<any>("thread/start", {
    cwd: await mkdtemp(join(tmpdir(), "codex-bot-worker-mcp-")), approvalPolicy: "never", sandbox: "workspace-write", ephemeral: true,
    config: secureShellConfig(),
  });
  const workerServerNames: string[] = [];
  let cursor: string | null | undefined;
  do {
    const page = await worker.request<any>("mcpServerStatus/list", { threadId: workerThread.thread.id, cursor, limit: 100, detail: "toolsAndAuthOnly" });
    workerServerNames.push(...page.data.map((server: any) => server.name));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(workerServerNames.includes("codex_bot_manager"), false);
  assert.equal((await fetch(mcp.url, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" })).status, 403, "a valid token is insufficient outside the coordinator app-server process");
  const cwd = await mkdtemp(join(tmpdir(), "codex-bot-real-mcp-"));
  const thread = await endpoint.request<any>("thread/start", {
    cwd, approvalPolicy: "never", sandbox: "workspace-write", ephemeral: false,
    config: coordinatorTurnConfig(mcp.url, token),
  });
  const terminal = new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MCP integration timed out")), 120_000);
    const unsubscribe = endpoint.onNotification((method, params: any) => {
      if (method === "turn/completed" && params.threadId === thread.thread.id) { clearTimeout(timeout); unsubscribe(); resolve(params.turn); }
    });
  });
  const pool = new AppServerPool([endpoint, worker], { maxConcurrentTurns: 1 });
  const started = await pool.startTurn<any>(endpoint.id, {
    threadId: thread.thread.id,
    clientUserMessageId: "mcp-integration",
    input: [{ type: "text", text: "Call list_managed_sessions once. Reply with exactly MCP_OK only if the tool succeeds.", text_elements: [] }],
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
