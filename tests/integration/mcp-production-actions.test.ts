import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AssistantToolName, ToolHandler } from "../../src/assistant/tools.ts";
import { EPHEMERAL_READ_TOOLS, READ_ONLY_TOOLS, TOOL_NAMES } from "../../src/assistant/tools.ts";
import type { ConversationBinding, JsonValue } from "../../src/chat-apps/shared/binding.ts";
import type { ChatAdapter, ChatHistoryRequest } from "../../src/chat-apps/shared/contracts.ts";
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
  const claudeRemoteAlias = process.env.QIYAN_ACCEPTANCE_CLAUDE_REMOTE; // e.g. dfw-claude
  await writeFile(join(qiyanHome, "endpoints.json"), `${JSON.stringify({
    version: 1,
    endpoints: {
      // The local Claude endpoint is now an endpoints.json entry (was config.claudeCode / env).
      "claude-local": { provider: "claude", transport: "local" },
      "dfw-vscode": { provider: "codex", transport: "ssh", host: "dfw-vscode", projects_root: "~/qiyan-projects" },
      ...(claudeRemoteAlias ? { [claudeRemoteAlias]: { provider: "claude", transport: "ssh", host: claudeRemoteAlias, projects_root: "~/qiyan-projects" } } : {}),
    },
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
    webUi: { host: "127.0.0.1", port: 0 },
    // The local Claude endpoint (`claude-local`) is declared in endpoints.json above, so the
    // Claude lifecycle runs through the same real manager/service/ownership stack as Codex.
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
      if (project.endpoint === "local" || project.endpoint === "claude-local") {
        if (project.path === join(userHome, "qiyan-projects", project.nickname)) {
          await rm(project.path, { recursive: true, force: true });
        }
      } else if (project.path.endsWith(`/qiyan-projects/${project.nickname}`) && project.path.startsWith("/")) {
        const sshHost = project.endpoint === claudeRemoteAlias ? claudeRemoteAlias : project.endpoint;
        spawnSync("ssh", [sshHost, "rm", "-rf", "--", project.path], { stdio: "ignore" });
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
          const controls = mapping ? db.prepare(`SELECT model, effort, goal_controlled, goal_control_known, goal_control_sequence
            FROM session_controls WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
            .get(mapping.endpoint, mapping.thread_id, mapping.mapping_id) : undefined;
          throw new Error(`${name} returned an MCP error: ${text?.text ?? "no structured detail"}; durable=${JSON.stringify(durable)}; mapping=${JSON.stringify(mapping)}; controls=${JSON.stringify(controls)}`);
        }
        const result = JSON.parse(text?.text ?? "null");
        if (EPHEMERAL_READ_TOOLS.has(name)) {
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
  // Codex coverage is the default; a focused Claude run can skip it to keep a maintenance
  // window short (QIYAN_ACCEPTANCE_SKIP_CODEX=1). The committed default exercises both.
  const includeCodex = process.env.QIYAN_ACCEPTANCE_SKIP_CODEX !== "1";
  const fixtures: ReadonlyArray<{ endpoint: string; nickname: string }> = includeCodex ? [
    { endpoint: "local", nickname: `mcp-local-${suffix}` },
    { endpoint: "dfw-vscode", nickname: `mcp-dfw-${suffix}` },
  ] : [];
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
    const read = await call("read_worker_message", { nickname: fixture.nickname, message_id: firstFinal.id }, fixture.endpoint);
    assert.equal(read.endpointId, fixture.endpoint);
    assert.equal(read.threadId, session.thread_id);
    assert.equal(read.turnId, firstSend.turnId);
    assert.match(read.body, new RegExp(marker, "u"));
    const history = await call("read_worker_messages", { nickname: fixture.nickname, count: 20 }, fixture.endpoint);
    assert.ok(history.messages.some((message: any) => message.role === "worker" && new RegExp(marker, "u").test(message.body)));
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
    const ownedBeforeResume = ownedTurnCount();
    await call("resume_goal", { nickname: fixture.nickname }, fixture.endpoint);
    await waitFor(() => ownedTurnCount() > ownedBeforeResume, workerTimeoutMs, `${fixture.nickname} resumed goal turn ownership`);
    await call("cancel_goal", { nickname: fixture.nickname, interrupt_active_turn: true }, fixture.endpoint);
    await call("compact_session", { nickname: fixture.nickname }, fixture.endpoint);

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

    const beforeRestart = (await registryDocument(config.sessionRegistryPath)).sessions[fixture.nickname];
    db.prepare(`UPDATE session_controls SET goal_controlled = 1, goal_control_sequence = 0
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
      .run(fixture.endpoint, session.thread_id, session.mapping_id);
    await call("restart_endpoint", { endpoint: fixture.endpoint }, fixture.endpoint);
    const afterRestart = (await registryDocument(config.sessionRegistryPath)).sessions[fixture.nickname];
    assert.deepEqual(afterRestart, beforeRestart, `${fixture.endpoint} restart changed the mapping`);
    const postRestartStatus = await call("get_session_status", { nickname: fixture.nickname }, fixture.endpoint);
    assert.equal(postRestartStatus.auto_session_info.native_status, "idle", `${fixture.endpoint} restart did not restore an idle managed thread`);
    const goalMarker = db.prepare(`SELECT goal_controlled FROM session_controls
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

  // ---- Claude endpoint lifecycle: the coverage gap (local claude-local + optional remote) ----
  // Drives the exact path that shipped bugs live: create (workspace routing) → send (unstarted
  // first-turn dispatch) → deliver (ownership commits the Claude <id>.jsonl path) → collect →
  // unadopt → adopt → archive, plus a never-materialized archive and a daemonless restart.
  const claudeFixtures = [
    { endpoint: "claude-local", nickname: `mcp-claude-local-${suffix}` },
    ...(claudeRemoteAlias ? [{ endpoint: claudeRemoteAlias, nickname: `mcp-claude-remote-${suffix}` }] : []),
  ] as const;

  // Ground-truth check that a per-session model actually reached `claude -p`: the resolved model
  // id is recorded on the transcript's assistant records (NOT the appliedSettings echo that
  // masked the original no-op). Reads the transcript on the host (local fs / remote ssh).
  const claudeTranscriptModels = async (endpoint: string, threadId: string): Promise<string[]> => {
    let text = "";
    if (endpoint === "claude-local") {
      const projects = join(userHome, ".claude", "projects");
      for (const dir of await readdir(projects).catch(() => [] as string[])) {
        const candidate = join(projects, dir, `${threadId}.jsonl`);
        try { text = await readFile(candidate, "utf8"); break; } catch { /* keep looking */ }
      }
    } else {
      const result = spawnSync("ssh", [endpoint, `find ~/.claude/projects -name ${threadId}.jsonl -exec cat {} +`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      text = result.stdout ?? "";
    }
    const models = new Set<string>();
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      try { const record = JSON.parse(line); const model = record?.message?.model; if (typeof model === "string") models.add(model); } catch { /* partial */ }
    }
    return [...models];
  };
  for (const fixture of claudeFixtures) {
    const created = await call("create_session", { nickname: fixture.nickname, endpoint: fixture.endpoint }, fixture.endpoint);
    assert.equal(created.nickname, fixture.nickname, `${fixture.endpoint} create`);
    const session = (await registryDocument(config.sessionRegistryPath)).sessions[fixture.nickname];
    assert.ok(session, `${fixture.nickname} was not committed`);
    createdProjects.push({ endpoint: fixture.endpoint, nickname: fixture.nickname, path: session.project_dir });

    const managed = await call("list_managed_sessions", {}, fixture.endpoint);
    assert.equal(managed.sessions[fixture.nickname]?.provider, "claude", `${fixture.nickname} provider not claude`);

    const marker = `QIYAN_CLAUDE_${fixture.endpoint === "claude-local" ? "LOCAL" : "REMOTE"}_OK`;
    const content = `Reply with exactly ${marker} and nothing else.`;
    const send = await call("send_to_session", { nickname: fixture.nickname, content, attachment_ids: [], mode: "start" }, fixture.endpoint, `/pass ${content}`);
    const final = await waitForValue(() => db.prepare(`SELECT id FROM logical_final_messages
      WHERE endpoint_id = ? AND thread_id = ? AND turn_id = ? ORDER BY item_order DESC LIMIT 1`)
      .get(fixture.endpoint, session.thread_id, send.turnId) as { id: string } | undefined, workerTimeoutMs, `${fixture.nickname} first final delivered`);
    const read = await call("read_worker_message", { nickname: fixture.nickname, message_id: final.id }, fixture.endpoint);
    assert.match(read.body, new RegExp(marker, "u"), `${fixture.nickname} reply not delivered`);
    const history = await call("read_worker_messages", { nickname: fixture.nickname }, fixture.endpoint);
    assert.ok(history.messages.some((message: any) => message.role === "worker" && new RegExp(marker, "u").test(message.body)));
    const collected = await call("collect_messages", { nickname: fixture.nickname, count: 1 }, fixture.endpoint);
    assert.equal(collected.length, 1);
    // the QiYan-driven turn must commit as OWNED (Claude <id>.jsonl path accepted, not external)
    const ownRow = db.prepare(`SELECT external_turn_id FROM session_rollout_ownership WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
      .get(fixture.endpoint, session.thread_id, session.mapping_id) as { external_turn_id: string | null } | undefined;
    assert.ok(ownRow && !ownRow.external_turn_id, `${fixture.nickname} first turn was misclassified external`);
    await call("get_session_status", { nickname: fixture.nickname }, fixture.endpoint);

    const deliverTurn = (turnId: string, label: string): Promise<{ id: string }> => waitForValue(() => db.prepare(`SELECT id FROM logical_final_messages
      WHERE endpoint_id = ? AND thread_id = ? AND turn_id = ? LIMIT 1`).get(fixture.endpoint, session.thread_id, turnId) as { id: string } | undefined, workerTimeoutMs, label);

    // ---- discover_sessions must enumerate Claude sessions (regression: threw UNSUPPORTED).
    // Model-independent (no turn), so it runs here while the session is live. ----
    const discovered = await call("discover_sessions", { endpoint: fixture.endpoint, cwd: session.project_dir, limit: 20 }, fixture.endpoint);
    assert.ok(discovered.sessions.some((item: any) => item.id === session.thread_id), `${fixture.nickname} discover_sessions missing the live session`);

    // Goals + auto-drive (Tier A — same for local and remote): set_goal enqueues a pursuit
    // turn via the driver, which the schedule engine fires as an autonomous send (recorded
    // 'sent' in the send outbox). That outbox row is the deterministic, QiYan-side proof the
    // goal is being driven; cancel then bounds it. (This is exactly what regressed when the
    // worker/goal engine was gated behind holdAssistantScheduler.)
    const drives = db.prepare(`SELECT COUNT(*) AS count FROM scheduled_sends WHERE nickname = ? AND state = 'sent'`);
    const driveCount = (): number => (drives.get(fixture.nickname) as { count: number }).count;
    const beforeGoal = driveCount();
    const objective = "Reply with the single word CONTINUE, nothing else.";
    await call("set_goal", { nickname: fixture.nickname, objective }, fixture.endpoint);
    await waitFor(() => driveCount() > beforeGoal, workerTimeoutMs, `${fixture.nickname} goal auto-drive did not fire a pursuit turn`);
    assert.equal((await call("get_goal", { nickname: fixture.nickname }, fixture.endpoint)).goal.objective, objective);
    await call("cancel_goal", { nickname: fixture.nickname, interrupt_active_turn: true }, fixture.endpoint);

    // Worker self-scheduling: instruct the worker to call its own schedule_wakeup MCP tool →
    // a durable schedule persists. Local reaches the loopback MCP directly; remote reaches it
    // over the ssh -R reverse tunnel. A far-future delay so it never fires during the test.
    const schedules = db.prepare(`SELECT COUNT(*) AS count FROM session_schedules WHERE endpoint_id = ? AND thread_id = ?`);
    const scheduleCount = (): number => (schedules.get(fixture.endpoint, session.thread_id) as { count: number }).count;
    const beforeSchedule = scheduleCount();
    const scheduleAsk = "Use your schedule_wakeup tool with delay_seconds 3600 and message CONTINUE. Then reply exactly SCHEDULEDOK.";
    const scheduleSend = await call("send_to_session", { nickname: fixture.nickname, content: scheduleAsk, attachment_ids: [], mode: "start" }, fixture.endpoint, `/pass ${scheduleAsk}`);
    await waitFor(() => scheduleCount() > beforeSchedule, workerTimeoutMs, `${fixture.nickname} worker schedule_wakeup did not persist (MCP unreachable?)`);
    await deliverTurn(scheduleSend.turnId, `${fixture.nickname} post-schedule final`);

    // Worker `monitor`: the check must run on the SESSION's OWN host — locally here, over ssh
    // for a remote worker (previously `monitor` was gated OFF for remote). Prove routing AND
    // host by seeding a marker file on the fixture's host, then having the worker monitor
    // `test -f <marker>`. It fires ONLY if the check evaluated on THAT host and saw the marker,
    // which delivers `message` as a durable send (a new 'sent' row). Deleting the marker after
    // the first fire makes the recurring check fail again, so it stops re-firing.
    const markerFile = `/tmp/qiyan-monitor-${suffix}-${session.thread_id}`;
    const seedMarker = fixture.endpoint === "claude-local"
      ? async () => { await writeFile(markerFile, "ok"); }
      : async () => { assert.equal(spawnSync("ssh", [fixture.endpoint, "touch", "--", markerFile]).status, 0, `seed marker on ${fixture.endpoint}`); };
    const removeMarker = fixture.endpoint === "claude-local"
      ? async () => { await rm(markerFile, { force: true }); }
      : async () => { assert.equal(spawnSync("ssh", [fixture.endpoint, "rm", "-f", "--", markerFile]).status, 0, `remove marker on ${fixture.endpoint}`); };
    await seedMarker();
    const monitorSpec = `test -f ${markerFile}`;
    const monitors = db.prepare(`SELECT COUNT(*) AS count FROM session_schedules WHERE endpoint_id = ? AND thread_id = ? AND kind = 'monitor' AND spec = ?`);
    const monitorCount = (): number => (monitors.get(fixture.endpoint, session.thread_id, monitorSpec) as { count: number }).count;
    const sends = db.prepare(`SELECT COUNT(*) AS count FROM scheduled_sends WHERE nickname = ? AND state = 'sent'`);
    const sendCount = (): number => (sends.get(fixture.nickname) as { count: number }).count;
    const finals = db.prepare(`SELECT COUNT(*) AS count FROM logical_final_messages WHERE endpoint_id = ? AND thread_id = ?`);
    const finalCount = (): number => (finals.get(fixture.endpoint, session.thread_id) as { count: number }).count;
    const beforeFire = sendCount();
    const beforeMonitorFinals = finalCount();
    const monitorAsk = `Use your monitor tool with check ${JSON.stringify(monitorSpec)}, poll_seconds 2, and message MONITORFIRED. Then reply exactly MONITOROK.`;
    await call("send_to_session", { nickname: fixture.nickname, content: monitorAsk, attachment_ids: [], mode: "start" }, fixture.endpoint, `/pass ${monitorAsk}`);
    await waitFor(() => monitorCount() > 0, workerTimeoutMs, `${fixture.nickname} worker monitor did not persist (tool missing for this host?)`);
    // The monitor polls its host-specific check; it fires ONLY if the check evaluated on the
    // fixture's OWN host and saw the marker → a durable autonomous send (a new 'sent' row) that
    // delivers MONITORFIRED as its own turn.
    await waitFor(() => sendCount() > beforeFire, workerTimeoutMs, `${fixture.nickname} monitor check never fired (did it run on ${fixture.endpoint}'s host?)`);
    // Stop the recurring monitor and remove the marker so it never re-fires. Exactly two turns run
    // in this step — the monitor-set turn (MONITOROK) and the one MONITORFIRED delivery — so wait
    // for BOTH final messages (a durable, order-independent completion signal, unlike a bare idle
    // check which could observe the brief pre-start idle and let a delivery collide with the next
    // step's send).
    db.prepare(`UPDATE session_schedules SET state = 'cancelled' WHERE endpoint_id = ? AND thread_id = ? AND kind = 'monitor' AND state = 'armed'`).run(fixture.endpoint, session.thread_id);
    await removeMarker();
    await waitFor(() => finalCount() >= beforeMonitorFinals + 2, workerTimeoutMs, `${fixture.nickname} monitor set + delivery turns did not both complete`);

    // ---- Per-session model + effort must ACTUALLY reach `claude -p` (regressions: set_session_model
    // threw on empty list_models; set_reasoning_effort was a silent no-op). Proof is the resolved
    // model id on the transcript, NOT the appliedSettings echo. Runs AFTER the tool-dependent goal/
    // scheduling steps because it sets a STICKY smaller model that would degrade tool-calling. ----
    const catalog = await call("list_models", { endpoint: fixture.endpoint }, fixture.endpoint);
    assert.ok(catalog.data.length > 0, `${fixture.nickname} list_models is empty`);
    await call("set_reasoning_effort", { nickname: fixture.nickname, effort: "high" }, fixture.endpoint);
    await call("set_session_model", { nickname: fixture.nickname, model: "haiku" }, fixture.endpoint);
    const modelAsk = "Reply with exactly MODELSET.";
    const modelSend = await call("send_to_session", { nickname: fixture.nickname, content: modelAsk, attachment_ids: [], mode: "start" }, fixture.endpoint, `/pass ${modelAsk}`);
    await deliverTurn(modelSend.turnId, `${fixture.nickname} model turn delivered`);
    assert.ok((await claudeTranscriptModels(fixture.endpoint, session.thread_id)).some((m) => /haiku/iu.test(m)),
      `${fixture.nickname} set_session_model not applied to claude -p`);
    // Sticky: a SECOND turn without re-setting still runs on haiku (Claude settings are NOT consumed).
    const stickyAsk = "Reply with exactly MODELSTICK.";
    const stickySend = await call("send_to_session", { nickname: fixture.nickname, content: stickyAsk, attachment_ids: [], mode: "start" }, fixture.endpoint, `/pass ${stickyAsk}`);
    await deliverTurn(stickySend.turnId, `${fixture.nickname} sticky turn delivered`);
    assert.ok((await claudeTranscriptModels(fixture.endpoint, session.thread_id)).some((m) => /haiku/iu.test(m)),
      `${fixture.nickname} sticky model lost on the next turn (settings were consumed)`);
    // An invalid effort is rejected, not silently accepted.
    await assert.rejects(call("set_reasoning_effort", { nickname: fixture.nickname, effort: "ludicrous" }, fixture.endpoint),
      /effort|not supported|unknown/iu, `${fixture.nickname} invalid effort not rejected`);

    // daemonless restart/disconnect with the session still managed: must not strand the
    // endpoint "draining" and must restore the managed session (no runtime identity to prove).
    await call("restart_endpoint", { endpoint: fixture.endpoint }, fixture.endpoint);
    const afterRestart = await call("get_session_status", { nickname: fixture.nickname }, fixture.endpoint);
    assert.equal(afterRestart.identity.thread_id, session.thread_id, `${fixture.endpoint} restart lost the session`);
    await call("disconnect_endpoint", { endpoint: fixture.endpoint }, fixture.endpoint);
    await call("restart_endpoint", { endpoint: fixture.endpoint }, fixture.endpoint);

    await call("unadopt_session", { nickname: fixture.nickname }, fixture.endpoint);
    assert.equal((await registryDocument(config.sessionRegistryPath)).sessions[fixture.nickname], undefined, `${fixture.nickname} unadopt`);
    await call("adopt_session", { nickname: fixture.nickname, thread_id: session.thread_id, endpoint: fixture.endpoint }, fixture.endpoint);
    assert.ok((await registryDocument(config.sessionRegistryPath)).sessions[fixture.nickname], `${fixture.nickname} re-adopt`);
    await call("archive_session", { nickname: fixture.nickname }, fixture.endpoint);
    assert.equal((await registryDocument(config.sessionRegistryPath)).sessions[fixture.nickname], undefined, `${fixture.nickname} archive`);
    // Real archive (not just unadopt): the transcript survives on disk but discover now tombstones
    // it — the emulated archived state, matching Codex's native archive.
    const postArchive = await call("discover_sessions", { endpoint: fixture.endpoint, cwd: session.project_dir, limit: 20 }, fixture.endpoint);
    const archivedEntry = postArchive.sessions.find((item: any) => item.id === session.thread_id);
    assert.ok(archivedEntry && archivedEntry.archived === true, `${fixture.nickname} archived Claude thread not tombstoned in discover (archive ≈ unadopt)`);

    // never-materialized: create then archive with no turn (no transcript / no rollout).
    const ephemeral = `${fixture.nickname}-empty`;
    await call("create_session", { nickname: ephemeral, endpoint: fixture.endpoint }, fixture.endpoint);
    const ephSession = (await registryDocument(config.sessionRegistryPath)).sessions[ephemeral];
    assert.ok(ephSession, `${ephemeral} was not committed`);
    createdProjects.push({ endpoint: fixture.endpoint, nickname: ephemeral, path: ephSession.project_dir });
    await call("archive_session", { nickname: ephemeral }, fixture.endpoint);
    assert.equal((await registryDocument(config.sessionRegistryPath)).sessions[ephemeral], undefined, `${ephemeral} never-materialized archive`);
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
    "send_to_session", "read_worker_message", "read_worker_messages", "collect_messages", "interrupt_session", "compact_session", "list_models", "disconnect_endpoint", "restart_endpoint",
    "set_session_model", "set_reasoning_effort", "get_goal", "set_goal", "pause_goal", "resume_goal", "cancel_goal", "update_session_notes",
    "prepare_chat_attachment", "send_chat_attachment",
  ];
  if (includeCodex) for (const name of endpointScoped) {
    const covered = endpointCoverage.get(name) ?? new Set<string>();
    for (const required of ["dfw-vscode", "local"]) assert.ok(covered.has(required), `${name} lacks ${required} evidence`);
  }
  // The Claude lifecycle must have exercised the create/send/deliver/adopt/unadopt/archive/restart
  // path on the local Claude endpoint (the coverage that was previously missing entirely).
  for (const name of ["create_session", "send_to_session", "read_worker_message", "read_worker_messages", "collect_messages", "unadopt_session", "adopt_session", "archive_session", "restart_endpoint"] as const) {
    assert.ok((endpointCoverage.get(name) ?? new Set()).has("claude-local"), `${name} lacks Claude evidence`);
  }
  if (includeCodex) assert.deepEqual([...coverage].sort(), [...TOOL_NAMES].sort());
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
