import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AssistantToolName, ToolHandler } from "../../src/assistant/tools.ts";
import { READ_ONLY_TOOLS, TOOL_NAMES } from "../../src/assistant/tools.ts";
import type { ConversationBinding, JsonValue } from "../../src/chat/binding.ts";
import type { ChatAdapter, ChatHistoryRequest } from "../../src/chat/contracts.ts";
import type { BotConfig } from "../../src/config.ts";
import { readLinuxProcessIdentity } from "../../src/core/process-identity.ts";
import { LoopbackMcpServer } from "../../src/mcp/server.ts";
import { buildProductionApp } from "../../src/production-app.ts";
import { openDatabase } from "../../src/storage/database.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";

const enabled = process.env.RUN_QIYAN_MCP_ACCEPTANCE === "1";
const operationTimeoutMs = 600_000;
const workerTimeoutMs = 240_000;

type OperationRow = {
  kind: AssistantToolName;
  state: string;
  effect_class: "read_only" | "side_effecting";
  recovery_protocol: number;
  receipt_json: string | null;
};

class AcceptanceAdapter implements ChatAdapter {
  readonly primaryBinding: ConversationBinding = {
    adapterId: "slack",
    conversationKey: "slack:acceptance:dm",
    destination: { workspaceId: "acceptance", channelId: "acceptance-dm" },
  };
  readonly messages: Array<{ destination: JsonValue; body: string }> = [];
  readonly documents: Array<{ size: number; caption?: string }> = [];
  readonly historyRequests: ChatHistoryRequest[] = [];
  readonly searches: Array<{ query: string; dateFrom?: string; dateTo?: string }> = [];
  readonly mentions: string[] = [];
  readonly delivery = {
    id: "slack",
    sendMessage: async (destination: JsonValue, body: string) => {
      this.messages.push({ destination, body });
      return { id: `message-${this.messages.length}` };
    },
    sendDocument: async (_destination: JsonValue, file: {
      stream: AsyncIterable<Uint8Array | string>;
      size: number;
      caption?: string;
    }) => {
      let size = 0;
      for await (const chunk of file.stream) size += Buffer.byteLength(chunk);
      assert.equal(size, file.size);
      this.documents.push({ size, ...(file.caption === undefined ? {} : { caption: file.caption }) });
      return { id: `document-${this.documents.length}` };
    },
    isSafeToRetry: () => true,
  };
  readonly history = {
    getHistory: async (_binding: ConversationBinding, request: ChatHistoryRequest): Promise<JsonValue> => {
      this.historyRequests.push(request);
      return { messages: [{ id: "history-fixture" }], scope: request.scope };
    },
  };
  readonly context = {
    search: async (query: string, dateFrom?: string, dateTo?: string) => {
      this.searches.push({ query, ...(dateFrom === undefined ? {} : { dateFrom }), ...(dateTo === undefined ? {} : { dateTo }) });
      return { results: [{ id: "search-fixture" }] };
    },
    mentions: async (dateFrom: string) => {
      this.mentions.push(dateFrom);
      return { results: [{ id: "mention-fixture" }] };
    },
  };

  async initialize(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async close(): Promise<void> {}
}

test("the exact production MCP map succeeds for every local and remote manager action", { skip: !enabled, timeout: 3_600_000 }, async (t) => {
  assertExclusiveAcceptanceEnvironment();
  const userHome = process.env.HOME;
  if (!userHome) throw new Error("HOME is required for acceptance testing");
  const root = await mkdtemp(join(tmpdir(), "qiyan-production-actions-"));
  const qiyanHome = join(root, "qiyan-home");
  const dataDir = join(root, "data");
  const assistantWorkdir = join(root, "assistant");
  const authTarget = join(dataDir, "assistant-profile", "codex", "auth.json");
  await mkdir(join(dataDir, "assistant-profile", "codex"), { recursive: true, mode: 0o700 });
  await mkdir(qiyanHome, { recursive: true, mode: 0o700 });
  await copyFile(join(userHome, ".qiyan-bot", "data", "assistant-profile", "codex", "auth.json"), authTarget);
  await chmod(authTarget, 0o600);
  await writeFile(join(qiyanHome, "endpoints.json"), `${JSON.stringify({
    version: 1,
    endpoints: { "dfw-vscode": { type: "ssh", projects_root: "~/qiyan-projects" } },
  }, null, 2)}\n`, { mode: 0o600 });

  const config: BotConfig = {
    qiyanHome,
    chat: {
      primary: "slack",
      slack: { appToken: "xapp-acceptance", botToken: "xoxb-acceptance", userToken: "xoxp-acceptance", ownerUserId: "UACCEPTANCE" },
    },
    userHome,
    assistantWorkdir,
    dataDir,
    sessionRegistryPath: join(dataDir, "sessions.json"),
    endpointCatalogPath: join(qiyanHome, "endpoints.json"),
    codexBinary: "codex",
    maxConcurrentTurns: 4,
    maxCollectCount: 20,
    mcpHost: "127.0.0.1",
    mcpPort: 0,
    attachmentMaxBytes: 1024 * 1024,
    attachmentStoreMaxBytes: 8 * 1024 * 1024,
    assistantSandboxMode: "read-only",
  };
  const adapter = new AcceptanceAdapter();
  let tools: Readonly<Record<AssistantToolName, ToolHandler>> | undefined;
  let toolActivity: { registerTool(attemptId: string): number; finishTool(attemptId: string): void } | undefined;
  let acceptanceStage = "startup";
  const operationalFailures: Array<{ code: string; component?: string; stage: string }> = [];
  const createdProjects: Array<{ endpoint: string; nickname: string; path: string }> = [];
  const app = await buildProductionApp(config, {
    chdir: () => undefined,
    chatAdapters: [adapter],
    onOperationalEvent: (event) => {
      if (event.level === "warn") {
        operationalFailures.push({
          code: event.code,
          ...(typeof event.component === "string" ? { component: event.component } : {}),
          stage: acceptanceStage,
        });
      }
    },
    requestRestart: () => { throw new Error("acceptance app requested restart"); },
    testing: {
      holdAssistantScheduler: true,
      onManagerToolsBuilt: (value, activity) => { tools = value; toolActivity = activity; },
    },
  });
  let dbCleanup: ReturnType<typeof openDatabase> | undefined;
  let serverCleanup: LoopbackMcpServer | undefined;
  let clientCleanup: Client | undefined;
  t.after(async () => {
    await clientCleanup?.close().catch(() => undefined);
    await serverCleanup?.stop().catch(() => undefined);
    if (dbCleanup) {
      const rows = dbCleanup.prepare("SELECT args_json, receipt_json FROM operations WHERE kind = 'create_session' AND receipt_json IS NOT NULL")
        .all() as Array<{ args_json: string; receipt_json: string }>;
      for (const row of rows) {
        const args = JSON.parse(row.args_json) as Record<string, unknown>;
        const receipt = JSON.parse(row.receipt_json) as Record<string, unknown>;
        if (typeof args.nickname !== "string" || !args.nickname.startsWith("mcp-")
          || typeof receipt.endpoint !== "string" || typeof receipt.projectDir !== "string"
          || !receipt.projectDir.endsWith(`/qiyan-projects/${args.nickname}`)) continue;
        createdProjects.push({ endpoint: receipt.endpoint, nickname: args.nickname, path: receipt.projectDir });
      }
    }
    dbCleanup?.close();
    await app.stop().catch(() => undefined);
    for (const project of new Map(createdProjects.map((value) => [`${value.endpoint}\0${value.path}`, value])).values()) {
      if (project.endpoint === "local") {
        if (project.path === join(userHome, "qiyan-projects", project.nickname)) {
          await rm(project.path, { recursive: true, force: true });
        }
      } else if (project.path.endsWith(`/qiyan-projects/${project.nickname}`) && project.path.startsWith("/")) {
        spawnSync("ssh", [project.endpoint, "rm", "-rf", "--", project.path], { stdio: "ignore" });
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  await app.start();
  assert.ok(tools);
  assert.ok(toolActivity);
  await writeFile(join(assistantWorkdir, "acceptance-attachment.txt"), "qiyan MCP attachment acceptance\n");

  const db = openDatabase(join(dataDir, "bot.sqlite3"));
  dbCleanup = db;
  const operations = new OperationStore(db);
  let active: { contextId: string; attemptId: string; turnId: string } | undefined;
  const self = await readLinuxProcessIdentity(process.pid);
  const token = `acceptance-${process.pid}`;
  const server = new LoopbackMcpServer(tools as Record<AssistantToolName, ToolHandler>, {
    current: () => active,
    registerTool: (attemptId) => toolActivity!.registerTool(attemptId),
    finishTool: (attemptId) => toolActivity!.finishTool(attemptId),
  }, {
    host: "127.0.0.1", port: 0, token, allowedClientProcess: () => self,
  });
  await server.start();
  serverCleanup = server;
  const client = new Client({ name: "qiyan-production-acceptance", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }) as any);
  clientCleanup = client;
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());

  let scopeSequence = 0;
  const coverage = new Set<AssistantToolName>();
  const endpointCoverage = new Map<AssistantToolName, Set<string>>();
  const createScope = async (rawText = "ordinary acceptance source") => {
    await waitFor(() => Number((db.prepare("SELECT COUNT(*) AS count FROM assistant_turn_lease").get() as { count: number }).count) === 0,
      operationTimeoutMs, "assistant lease availability");
    const sequence = ++scopeSequence;
    const contextId = `acceptance:${sequence}`;
    const attemptId = `acceptance-attempt:${sequence}`;
    const turnId = `acceptance-turn:${sequence}`;
    operations.createSourceContext({
      id: contextId,
      kind: "slack",
      sourceId: String(sequence),
      rawText,
      attachmentIds: [],
      binding: adapter.primaryBinding,
    });
    const now = Date.now();
    db.prepare(`INSERT INTO assistant_attempts
      (id, context_id, turn_id, trigger_kind, state, created_at, adapter_id, conversation_key, destination_json, accepting_tools)
      VALUES (?, ?, ?, 'user', 'active', ?, ?, ?, ?, 1)`)
      .run(attemptId, contextId, turnId, now, adapter.primaryBinding.adapterId, adapter.primaryBinding.conversationKey, JSON.stringify(adapter.primaryBinding.destination));
    db.prepare(`INSERT INTO assistant_attempt_sources
      (attempt_id, context_id, source_ordinal, client_user_message_id, submission_kind, state, observed_turn_id, created_at, updated_at)
      VALUES (?, ?, 1, ?, 'start', 'submitted', ?, ?, ?)`)
      .run(attemptId, contextId, `acceptance-client:${sequence}`, turnId, now, now);
    db.prepare(`INSERT INTO assistant_turn_lease
      (singleton, phase, attempt_id, primary_context_id, adapter_id, conversation_key, destination_json,
        client_user_message_id, turn_id, trigger_kind, capacity_claim_id, steer_paused)
      VALUES (1, 'active', ?, ?, ?, ?, ?, ?, ?, 'chat', ?, 0)`)
      .run(attemptId, contextId, adapter.primaryBinding.adapterId, adapter.primaryBinding.conversationKey,
        JSON.stringify(adapter.primaryBinding.destination), `acceptance-client:${sequence}`, turnId, `acceptance-capacity:${sequence}`);
    db.prepare("UPDATE source_contexts SET state = 'active' WHERE id = ?").run(contextId);
    active = { contextId, attemptId, turnId };
    return {
      async call(name: AssistantToolName, args: Record<string, unknown>, endpoint?: string): Promise<any> {
        acceptanceStage = `${name}:${endpoint ?? "chat"}`;
        active = { contextId, attemptId, turnId };
        let response;
        try {
          response = await client.callTool({ name, arguments: args }, undefined, { timeout: operationTimeoutMs });
        } catch (error) {
          const durable = db.prepare(`SELECT state, error_json, receipt_json FROM operations
            WHERE attempt_id = ? AND kind = ? ORDER BY sequence DESC LIMIT 1`).get(attemptId, name);
          throw new Error(`${name} MCP transport failed${endpoint ? ` on ${endpoint}` : ""}; durable=${JSON.stringify(durable)}`, { cause: error });
        }
        const text = (response.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text");
        if (response.isError) {
          const durable = db.prepare(`SELECT state, error_json, receipt_json FROM operations
            WHERE attempt_id = ? AND kind = ? ORDER BY sequence DESC LIMIT 1`).get(attemptId, name);
          const nickname = typeof args.nickname === "string" ? args.nickname : undefined;
          const mapping = nickname ? (await registryDocument(config.sessionRegistryPath)).sessions[nickname] : undefined;
          const runtimeState = mapping ? db.prepare(`SELECT management_state, restore_state, native_status, active_turn_id, goal_controlled
            FROM session_runtime WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
            .get(mapping.endpoint, mapping.thread_id, mapping.mapping_id) : undefined;
          throw new Error(`${name} returned an MCP error: ${text?.text ?? "no structured detail"}; durable=${JSON.stringify(durable)}; mapping=${JSON.stringify(mapping)}; runtime=${JSON.stringify(runtimeState)}`);
        }
        const result = JSON.parse(text?.text ?? "null");
        if (name === "search_slack" || name === "get_slack_mentions") {
          assert.equal(db.prepare("SELECT COUNT(*) AS count FROM operations WHERE attempt_id = ? AND kind = ?").get(attemptId, name)!.count, 0);
        } else {
          const row = db.prepare(`SELECT kind, state, effect_class, recovery_protocol, receipt_json FROM operations
            WHERE attempt_id = ? AND kind = ? ORDER BY sequence DESC LIMIT 1`).get(attemptId, name) as OperationRow | undefined;
          assert.ok(row, `${name} did not create a durable operation`);
          assert.equal(row.state, "succeeded", `${name} did not durably succeed`);
          const expectedEffect = name === "collect_messages"
            ? rawText.trimStart().startsWith("/collect") ? "side_effecting" : "read_only"
            : READ_ONLY_TOOLS.has(name) ? "read_only" : "side_effecting";
          assert.equal(row.effect_class, expectedEffect, `${name} used the wrong durable effect class`);
          assert.equal(row.recovery_protocol, 1, `${name} used a stale recovery protocol`);
          assert.deepEqual(JSON.parse(row.receipt_json ?? "null"), result, `${name} MCP result differs from its durable receipt`);
        }
        coverage.add(name);
        if (endpoint) {
          const endpoints = endpointCoverage.get(name) ?? new Set<string>();
          endpoints.add(endpoint);
          endpointCoverage.set(name, endpoints);
        }
        return result;
      },
      close(): void {
        db.prepare("DELETE FROM assistant_turn_lease WHERE attempt_id = ?").run(attemptId);
        db.prepare("UPDATE assistant_attempts SET state = 'completed', accepting_tools = 0 WHERE id = ?").run(attemptId);
        db.prepare("UPDATE assistant_attempt_sources SET state = 'completed', updated_at = ? WHERE attempt_id = ?").run(Date.now(), attemptId);
        db.prepare("UPDATE source_contexts SET state = 'completed' WHERE id = ?").run(contextId);
        if (active?.attemptId === attemptId) active = undefined;
      },
    };
  };
  const call = async (name: AssistantToolName, args: Record<string, unknown>, endpoint?: string, rawText?: string): Promise<any> => {
    const scope = await createScope(rawText);
    try { return await scope.call(name, args, endpoint); }
    finally { scope.close(); }
  };

  const suffix = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
  const fixtures = [
    { endpoint: "local", nickname: `mcp-local-${suffix}` },
    { endpoint: "dfw-vscode", nickname: `mcp-dfw-${suffix}` },
  ] as const;
  const workerAttachmentSource = join(root, "acceptance-worker.txt");
  await writeFile(workerAttachmentSource, "worker attachment acceptance\n");
  const sessions = new Map<string, RegistryDocument["sessions"][string]>();
  for (const fixture of fixtures) {
    const created = await call("create_session", { nickname: fixture.nickname, endpoint: fixture.endpoint }, fixture.endpoint);
    assert.equal(created.nickname, fixture.nickname);
    const registryAfterCreate = await registryDocument(config.sessionRegistryPath);
    const session = registryAfterCreate.sessions[fixture.nickname];
    assert.ok(session, `${fixture.nickname} was not committed`);
    assert.match(session.project_dir, new RegExp(`/${fixture.nickname}$`, "u"));
    sessions.set(fixture.nickname, session);
    createdProjects.push({ endpoint: fixture.endpoint, nickname: fixture.nickname, path: session.project_dir });
  }

  for (const fixture of fixtures) {
    const session = sessions.get(fixture.nickname)!;
    const target = `${session.project_dir}/acceptance-worker.txt`;
    if (fixture.endpoint === "local") await writeFile(target, "worker attachment acceptance\n");
    else {
      const copied = spawnSync("scp", ["-q", workerAttachmentSource, `${fixture.endpoint}:${target}`], { stdio: "ignore" });
      assert.equal(copied.status, 0, `failed to stage the ${fixture.endpoint} attachment fixture`);
    }
  }

  for (const fixture of fixtures) {
    const managed = await call("list_managed_sessions", {}, fixture.endpoint);
    for (const expected of fixtures) {
      const session = sessions.get(expected.nickname)!;
      assert.equal(managed.sessions[expected.nickname]?.thread_id, session.thread_id);
      assert.equal(managed.sessions[expected.nickname]?.endpoint, expected.endpoint);
    }
  }

  for (const fixture of fixtures) {
    const session = sessions.get(fixture.nickname)!;
    const ownedTurns = db.prepare(`SELECT COUNT(*) AS count FROM session_rollout_owned_turns
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`);
    const ownedTurnCount = (): number => (ownedTurns.get(
      fixture.endpoint, session.thread_id, session.mapping_id,
    ) as { count: number }).count;
    const discovered = await call("discover_sessions", { endpoint: fixture.endpoint, cwd: session.project_dir, limit: 10 }, fixture.endpoint);
    assert.ok(Array.isArray(discovered.sessions));
    const status = await call("get_session_status", { nickname: fixture.nickname }, fixture.endpoint);
    assert.equal(status.identity.thread_id, session.thread_id);
    const models = await call("list_models", { endpoint: fixture.endpoint }, fixture.endpoint);
    assert.ok(models.data.length > 0);
    const model = models.data.find((item: any) => item.id === "gpt-5.5") ?? models.data[0];
    const selectedModel = model.id ?? model.model;
    await call("set_session_model", { nickname: fixture.nickname, model: selectedModel }, fixture.endpoint);
    const effort = model.supportedReasoningEfforts?.find((item: any) => (item.reasoningEffort ?? item) === "low")
      ? "low" : model.defaultReasoningEffort ?? model.supportedReasoningEfforts?.[0]?.reasoningEffort ?? model.supportedReasoningEfforts?.[0] ?? "medium";
    await call("set_reasoning_effort", { nickname: fixture.nickname, effort }, fixture.endpoint);
    await call("update_session_notes", { nickname: fixture.nickname, project_summary: "MCP acceptance fixture" }, fixture.endpoint);

    const marker = `QIYAN_${fixture.endpoint === "local" ? "LOCAL" : "REMOTE"}_MCP_OK`;
    const firstContent = `Reply with exactly ${marker}`;
    const firstSend = await call("send_to_session", {
      nickname: fixture.nickname, content: firstContent, attachment_ids: [], mode: "start",
    }, fixture.endpoint, `/pass ${firstContent}`);
    assert.equal(firstSend.mode, "start");
    assert.equal(firstSend.appliedSettings.model, selectedModel);
    assert.equal(firstSend.appliedSettings.effort, effort);
    const firstFinal = await waitForValue(() => db.prepare(`SELECT id FROM logical_final_messages
      WHERE endpoint_id = ? AND thread_id = ? AND turn_id = ? ORDER BY item_order DESC LIMIT 1`)
      .get(fixture.endpoint, session.thread_id, firstSend.turnId) as { id: string } | undefined, workerTimeoutMs, `${fixture.nickname} first final`);
    await waitFor(() => {
      const row = db.prepare(`SELECT native_status FROM session_runtime WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
        .get(fixture.endpoint, session.thread_id, session.mapping_id) as { native_status: string } | undefined;
      return row?.native_status === "idle";
    }, workerTimeoutMs, `${fixture.nickname} first turn to become idle`);
    const read = await call("read_worker_message", { nickname: fixture.nickname, message_id: firstFinal.id }, fixture.endpoint);
    assert.equal(read.endpointId, fixture.endpoint);
    assert.equal(read.threadId, session.thread_id);
    assert.equal(read.turnId, firstSend.turnId);
    assert.match(read.body, new RegExp(marker, "u"));
    const ordinaryCollected = await call("collect_messages", { nickname: fixture.nickname, count: 1 }, fixture.endpoint);
    assert.equal(ordinaryCollected.length, 1);
    assert.equal(ordinaryCollected[0].id, read.id);
    const directScope = await createScope(`/collect 1`);
    try {
      const messagesBefore = adapter.messages.length;
      const delivered = await directScope.call("collect_messages", { nickname: fixture.nickname, count: 1 }, fixture.endpoint);
      assert.equal(delivered.deliveries.length, 1);
      assert.match(delivered.deliveries[0], /^collect:/u);
      assert.equal(delivered.count, 1);
      assert.equal(delivered.nickname, fixture.nickname);
      await waitFor(() => adapter.messages.length > messagesBefore, operationTimeoutMs, `${fixture.nickname} direct collection delivery`);
      assert.match(adapter.messages.at(-1)!.body, new RegExp(marker, "u"));
    }
    finally { directScope.close(); }

    const workerAttachmentScope = await createScope();
    try {
      const prepared = await workerAttachmentScope.call("prepare_chat_attachment", {
        owner: fixture.nickname, relative_path: "acceptance-worker.txt",
      }, fixture.endpoint);
      assert.equal(prepared.display_name, "acceptance-worker.txt");
      assert.ok(prepared.size > 0);
      const documentsBefore = adapter.documents.length;
      await workerAttachmentScope.call("send_chat_attachment", {
        file_handle: prepared.file_handle, caption: fixture.endpoint,
      }, fixture.endpoint);
      await waitFor(() => adapter.documents.length > documentsBefore, operationTimeoutMs, `${fixture.nickname} attachment delivery`);
    } finally { workerAttachmentScope.close(); }

    const configuredStatus = await call("get_session_status", { nickname: fixture.nickname }, fixture.endpoint);
    assert.equal(configuredStatus.auto_session_info.model.current, selectedModel);
    assert.equal(configuredStatus.auto_session_info.reasoning_effort.current, effort);
    assert.equal(configuredStatus.manager_notes.project_summary, "MCP acceptance fixture");

    const ownedBeforeGoal = ownedTurnCount();
    await call("set_goal", { nickname: fixture.nickname, objective: "MCP acceptance goal" }, fixture.endpoint);
    await waitFor(() => ownedTurnCount() > ownedBeforeGoal, workerTimeoutMs, `${fixture.nickname} autonomous goal turn ownership`);
    const goal = await call("get_goal", { nickname: fixture.nickname }, fixture.endpoint);
    assert.equal(goal.goal.objective, "MCP acceptance goal");
    await call("pause_goal", { nickname: fixture.nickname }, fixture.endpoint);
    await call("interrupt_session", { nickname: fixture.nickname }, fixture.endpoint);
    await waitFor(() => {
      const row = db.prepare(`SELECT native_status FROM session_runtime WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
        .get(fixture.endpoint, session.thread_id, session.mapping_id) as { native_status: string } | undefined;
      return row?.native_status === "idle";
    }, workerTimeoutMs, `${fixture.nickname} paused goal turn to become idle`);
    const ownedBeforeResume = ownedTurnCount();
    await call("resume_goal", { nickname: fixture.nickname }, fixture.endpoint);
    await waitFor(() => ownedTurnCount() > ownedBeforeResume, workerTimeoutMs, `${fixture.nickname} resumed goal turn ownership`);
    await call("cancel_goal", { nickname: fixture.nickname, interrupt_active_turn: true }, fixture.endpoint);
    await waitFor(() => {
      const row = db.prepare(`SELECT native_status FROM session_runtime WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
        .get(fixture.endpoint, session.thread_id, session.mapping_id) as { native_status: string } | undefined;
      return row?.native_status === "idle";
    }, workerTimeoutMs, `${fixture.nickname} cancelled goal turn to become idle`);

    const longContent = "Run a shell command that sleeps for 120 seconds, then reply done.";
    const longStart = await call("send_to_session", {
      nickname: fixture.nickname, content: longContent, attachment_ids: [], mode: "start",
    }, fixture.endpoint, `/pass ${longContent}`);
    const steered = await call("send_to_session", {
      nickname: fixture.nickname, content: "After the sleep, also say steered.", attachment_ids: [], mode: "steer",
    }, fixture.endpoint);
    assert.equal(steered.mode, "steer");
    assert.equal(steered.turnId, longStart.turnId);
    await call("interrupt_session", { nickname: fixture.nickname }, fixture.endpoint);
    await waitFor(() => {
      const row = db.prepare(`SELECT native_status FROM session_runtime WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
        .get(fixture.endpoint, session.thread_id, session.mapping_id) as { native_status: string } | undefined;
      return row?.native_status === "idle";
    }, workerTimeoutMs, `${fixture.nickname} interruption`);

    const beforeRestart = (await registryDocument(config.sessionRegistryPath)).sessions[fixture.nickname];
    db.prepare(`UPDATE session_runtime SET goal_controlled = 1, goal_control_sequence = 0
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
      .run(fixture.endpoint, session.thread_id, session.mapping_id);
    await call("restart_endpoint", { endpoint: fixture.endpoint }, fixture.endpoint);
    const afterRestart = (await registryDocument(config.sessionRegistryPath)).sessions[fixture.nickname];
    assert.deepEqual(afterRestart, beforeRestart, `${fixture.endpoint} restart changed the mapping`);
    const postRestartStatus = await call("get_session_status", { nickname: fixture.nickname }, fixture.endpoint);
    assert.equal(postRestartStatus.auto_session_info.native_status, "idle", `${fixture.endpoint} restart did not restore an idle managed thread`);
    const goalMarker = db.prepare(`SELECT goal_controlled FROM session_runtime
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
      .get(fixture.endpoint, session.thread_id, session.mapping_id) as { goal_controlled: number };
    assert.equal(goalMarker.goal_controlled, 0, `${fixture.endpoint} restart retained a stale goal marker`);
    await call("disconnect_endpoint", { endpoint: fixture.endpoint }, fixture.endpoint);
    await call("restart_endpoint", { endpoint: fixture.endpoint }, fixture.endpoint);
    const recovered = await call("get_session_status", { nickname: fixture.nickname }, fixture.endpoint);
    assert.equal(recovered.identity.thread_id, session.thread_id);

    const renamed = `${fixture.nickname}-r`;
    await call("rename_session", { old_nickname: fixture.nickname, new_nickname: renamed }, fixture.endpoint);
    const renamedSession = (await registryDocument(config.sessionRegistryPath)).sessions[renamed];
    assert.ok(renamedSession);
    assert.equal(renamedSession.mapping_id, session.mapping_id);
    await call("unadopt_session", { nickname: renamed }, fixture.endpoint);
    assert.equal((await registryDocument(config.sessionRegistryPath)).sessions[renamed], undefined);
    const preserved = await call("discover_sessions", { endpoint: fixture.endpoint, cwd: session.project_dir, limit: 10 }, fixture.endpoint);
    assert.ok(preserved.sessions.some((item: any) => item.id === session.thread_id), "unadopt removed the native thread");
    await call("adopt_session", { nickname: renamed, thread_id: session.thread_id, endpoint: fixture.endpoint }, fixture.endpoint);
    await call("archive_session", { nickname: renamed }, fixture.endpoint);
    assert.equal((await registryDocument(config.sessionRegistryPath)).sessions[renamed], undefined);
    const archived = await call("discover_sessions", { endpoint: fixture.endpoint, cwd: session.project_dir, limit: 10 }, fixture.endpoint);
    assert.ok(archived.sessions.some((item: any) => item.id === session.thread_id && item.archived === true), "native thread was not archived");
    assert.equal(archived.sessions.some((item: any) => item.id === session.thread_id && item.archived === false), false);
  }

  const messagesBefore = adapter.messages.length;
  await call("send_chat_message", { content: "QIYAN_CHAT_MCP_OK" });
  await waitFor(() => adapter.messages.length > messagesBefore, operationTimeoutMs, "chat delivery");
  const attachmentScope = await createScope();
  try {
    const prepared = await attachmentScope.call("prepare_chat_attachment", { owner: "assistant", relative_path: "acceptance-attachment.txt" });
    const documentsBefore = adapter.documents.length;
    await attachmentScope.call("send_chat_attachment", { file_handle: prepared.file_handle, caption: "acceptance" });
    await waitFor(() => adapter.documents.length > documentsBefore, operationTimeoutMs, "attachment delivery");
  } finally { attachmentScope.close(); }
  await call("get_chat_history", { scope: "conversation", count: 5 });
  await call("search_slack", { query: "acceptance" });
  await call("get_slack_mentions", { date_from: "2026-07-01" });
  assert.equal(adapter.historyRequests.length, 1);
  assert.equal(adapter.searches.length, 1);
  assert.equal(adapter.mentions.length, 1);

  const endpointScoped: readonly AssistantToolName[] = [
    "list_managed_sessions", "discover_sessions", "get_session_status", "create_session", "adopt_session", "rename_session", "unadopt_session", "archive_session",
    "send_to_session", "read_worker_message", "collect_messages", "interrupt_session", "list_models", "disconnect_endpoint", "restart_endpoint",
    "set_session_model", "set_reasoning_effort", "get_goal", "set_goal", "pause_goal", "resume_goal", "cancel_goal", "update_session_notes",
    "prepare_chat_attachment", "send_chat_attachment",
  ];
  for (const name of endpointScoped) {
    assert.deepEqual([...endpointCoverage.get(name) ?? []].sort(), ["dfw-vscode", "local"], `${name} lacks local/remote evidence`);
  }
  assert.deepEqual([...coverage].sort(), [...TOOL_NAMES].sort());
  assert.deepEqual(operationalFailures, []);
});

interface RegistryDocument {
  sessions: Record<string, {
    endpoint: string;
    thread_id: string;
    project_dir: string;
    mapping_id: string;
  }>;
}

async function registryDocument(path: string): Promise<RegistryDocument> {
  return JSON.parse(await readFile(path, "utf8")) as RegistryDocument;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForValue<T>(read: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  let value: T | undefined;
  await waitFor(() => {
    value = read();
    return value !== undefined;
  }, timeoutMs, label);
  return value!;
}

function assertExclusiveAcceptanceEnvironment(): void {
  const service = spawnSync("systemctl", ["--user", "is-active", "qiyan-bot.service"], { encoding: "utf8" });
  assert.equal(service.stdout.trim(), "inactive", "qiyan-bot.service must be stopped before real endpoint acceptance");

  const processes = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  assert.equal(processes.status, 0, "cannot verify the exclusive QiYan process boundary");
  const competingPids = processes.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/u);
    if (!match) return [];
    const command = match[2]!;
    return /(?:^|\s)(?:\S*\/)?qiyan-bot(?:\s|$)|\/src\/cli\.ts(?:\s|$)|\/dist\/cli\.js(?:\s|$)/u.test(command)
      ? [Number(match[1])]
      : [];
  }).filter((pid) => pid !== process.pid);
  assert.deepEqual(competingPids, [], "another QiYan process is using the real endpoint namespace");

  const controlMaster = spawnSync("ssh", ["-o", "ConnectTimeout=10", "-O", "check", "dfw-vscode"], {
    stdio: "ignore", timeout: 15_000, killSignal: "SIGKILL",
  });
  if (controlMaster.status !== 0) {
    const direct = spawnSync("ssh", [
      "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
      "dfw-vscode", "true",
    ], { stdio: "ignore", timeout: 15_000, killSignal: "SIGKILL" });
    assert.equal(direct.status, 0, "dfw-vscode requires either a live user ControlMaster or direct BatchMode authentication");
  }
}
