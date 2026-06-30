import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AttachmentStore } from "./attachments/store.ts";
import { LocalEndpoint } from "./app-server/local-endpoint.ts";
import { AppServerPool } from "./app-server/pool.ts";
import { composeApp, type AppPhase, type BotApp } from "./app.ts";
import type { BotConfig } from "./config.ts";
import { CoordinatorNotebook } from "./coordinator/notebook.ts";
import { CoordinatorRuntime } from "./coordinator/runtime.ts";
import { CoordinatorScheduler, type CoordinatorJob } from "./coordinator/scheduler.ts";
import { createCoordinatorTools, type CoordinatorToolName } from "./coordinator/tools.ts";
import { EventRelay } from "./events/relay.ts";
import { buildCodexChildEnvironment, coordinatorTurnConfig, LoopbackMcpServer } from "./mcp/server.ts";
import { SessionRegistry } from "./registry/session-registry.ts";
import { SessionDiscovery } from "./sessions/discovery.ts";
import { FinalMessageStore } from "./sessions/final-messages.ts";
import { SessionLifecycle } from "./sessions/lifecycle.ts";
import { SessionService } from "./sessions/service.ts";
import { openDatabase, type Database } from "./storage/database.ts";
import { DeliveryStore } from "./storage/delivery-store.ts";
import { OperationStore } from "./storage/operation-store.ts";
import { RuntimeStore } from "./storage/runtime-store.ts";
import { TelegramApi } from "./telegram/api.ts";
import { DeliveryWorker } from "./telegram/delivery-worker.ts";
import { TelegramPoller } from "./telegram/poller.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function buildProductionApp(config: BotConfig): Promise<BotApp> {
  const coordinatorDir = join(repositoryRoot, "coordinator");
  const notebookPath = join(coordinatorDir, "session-status.json");
  const notebookExample = join(coordinatorDir, "session-status.example.json");
  const token = randomBytes(32).toString("base64url");

  let db!: Database;
  let registry!: SessionRegistry;
  let notebook!: CoordinatorNotebook;
  let attachments!: AttachmentStore;
  let operations!: OperationStore;
  let deliveries!: DeliveryStore;
  let runtime!: RuntimeStore;
  let finals!: FinalMessageStore;
  let endpoint!: LocalEndpoint;
  let pool!: AppServerPool;
  let discovery!: SessionDiscovery;
  let lifecycle!: SessionLifecycle;
  let sessions!: SessionService;
  let relay!: EventRelay;
  let coordinator!: CoordinatorRuntime;
  let scheduler!: CoordinatorScheduler;
  let mcp!: LoopbackMcpServer;
  let api!: TelegramApi;
  let poller!: TelegramPoller;
  let deliveryWorker!: DeliveryWorker;
  let acceptingReadyEvents = false;
  const unsubscribers: Array<() => void> = [];
  const terminalWaiters = new Map<string, { resolve(): void; reject(error: unknown): void; eventIds: string[] }>();
  const enqueuedEvents = new Set<string>();

  const phases: AppPhase[] = [
    {
      name: "storage",
      start: async () => {
        await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
        await mkdir(coordinatorDir, { recursive: true, mode: 0o700 });
        db = openDatabase(join(config.dataDir, "bot.sqlite3"));
        operations = new OperationStore(db); deliveries = new DeliveryStore(db); runtime = new RuntimeStore(db); finals = new FinalMessageStore(db);
      },
      stop: async () => { db.close(); },
    },
    {
      name: "registry",
      start: async () => {
        registry = await SessionRegistry.open(config.sessionRegistryPath, {
          version: 1,
          coordinator: { endpoint: "local", thread_id: "pending", project_dir: coordinatorDir },
          sessions: {},
        });
        notebook = await CoordinatorNotebook.bootstrap(notebookPath, notebookExample);
      }, stop: async () => undefined,
    },
    {
      name: "attachments",
      start: async () => {
        attachments = new AttachmentStore(db, join(config.dataDir, "attachments"), { maxFileBytes: config.attachmentMaxBytes, maxStoreBytes: config.attachmentStoreMaxBytes });
        await attachments.initialize();
      }, stop: async () => undefined,
    },
    {
      name: "mcp",
      start: async () => {
        coordinator = new CoordinatorRuntime(db, operations, deliveries, { destination: String(config.telegramDestinationChatId) });
        const actions = buildActions();
        const tools = createCoordinatorTools(operations, actions, { maxCollectCount: config.maxCollectCount });
        mcp = new LoopbackMcpServer(tools, { current: () => coordinator.current() }, { host: config.mcpHost, port: config.mcpPort, token });
        await mcp.start();
      }, stop: async () => { await mcp.stop(); },
    },
    {
      name: "subscriptions",
      start: async () => {
        endpoint = new LocalEndpoint({ codexBinary: config.codexBinary, env: buildCodexChildEnvironment(process.env, token) });
        pool = new AppServerPool([endpoint], { maxConcurrentTurns: config.maxConcurrentTurns });
        discovery = new SessionDiscovery(db, pool);
        lifecycle = new SessionLifecycle(pool, registry, runtime, { now: () => Date.now() });
        sessions = new SessionService(pool, registry, runtime, finals, deliveries);
        relay = new EventRelay(db, pool, registry, runtime, finals, deliveries, { destination: String(config.telegramDestinationChatId), clock: { now: () => Date.now() } });
        scheduler = new CoordinatorScheduler(runCoordinatorJob);
        unsubscribers.push(endpoint.onNotification((method, params) => void onNotification(method, params)));
        unsubscribers.push(endpoint.onPermissionBlocked((event) => void relay.handlePermissionBlocked(endpoint.id, event)));
        unsubscribers.push(endpoint.onReady(() => { if (acceptingReadyEvents) void relay.reconcileEndpoint(endpoint.id); }));
      }, stop: async () => { for (const unsubscribe of unsubscribers.splice(0)) unsubscribe(); },
    },
    { name: "endpoint", start: async () => { await endpoint.start(); }, stop: async () => { await endpoint.stop(); } },
    {
      name: "reconciliation",
      start: async () => {
        await lifecycle.reconcileStartup();
        await relay.reconcileEndpoint(endpoint.id);
        deliveries.recoverAfterCrash();
        acceptingReadyEvents = true;
      }, stop: async () => { acceptingReadyEvents = false; },
    },
    {
      name: "coordinator",
      start: async () => {
        const identity = registry.snapshot().coordinator;
        const configOverride = coordinatorTurnConfig(mcp.url, token);
        const response = identity.thread_id === "pending"
          ? await endpoint.request<any>("thread/start", { cwd: coordinatorDir, approvalPolicy: "never", sandbox: "danger-full-access", config: configOverride, ephemeral: false })
          : await endpoint.request<any>("thread/resume", { threadId: identity.thread_id, cwd: coordinatorDir, approvalPolicy: "never", sandbox: "danger-full-access", config: configOverride });
        const threadId = String(response.thread.id);
        await registry.setCoordinator({ endpoint: endpoint.id, thread_id: threadId, project_dir: coordinatorDir });
        runtime.setSession(endpoint.id, threadId, "managed", response.thread.status?.type ?? "idle");
      }, stop: async () => undefined,
    },
    { name: "scheduler", start: async () => { await enqueuePendingEvents(); }, stop: async () => { await scheduler.idle(); } },
    {
      name: "delivery",
      start: async () => { api = new TelegramApi(config.telegramBotToken); deliveryWorker = new DeliveryWorker(deliveries, api); deliveryWorker.start(); },
      stop: async () => { deliveryWorker.stop(); },
    },
    { name: "maintenance", start: async () => undefined, stop: async () => undefined },
    {
      name: "polling",
      start: async () => {
        poller = new TelegramPoller(db, api, operations, attachments, {
          ownerId: config.telegramOwnerId,
          maxMessageBytes: config.attachmentMaxBytes,
          onAccepted: async (contextId) => { scheduler.enqueueUser({ id: contextId, payload: { contextId } }); },
        });
        poller.start();
      }, stop: async () => { await poller.stop(); },
    },
  ];

  function buildActions(): Partial<Record<CoordinatorToolName, (args: any, context: any) => Promise<any>>> {
    return {
      list_managed_sessions: async () => registry.snapshot(),
      discover_sessions: async (args) => discovery.list({ endpointId: args.endpoint ?? "local", ...(args.cwd ? { cwd: args.cwd } : {}), ...(args.limit ? { limit: args.limit } : {}), ...(args.cursor ? { cursor: args.cursor } : {}) }),
      get_session_status: async (args) => sessions.status(args.nickname),
      create_session: async (args) => { await lifecycle.create(args.nickname, args.endpoint ?? "local", args.project_dir); return { nickname: args.nickname }; },
      register_session: async (args) => { await lifecycle.register(args.nickname, args.endpoint ?? "local", args.thread_id, args.project_dir); return { nickname: args.nickname }; },
      adopt_session: async (args) => {
        const endpointId = args.endpoint ?? "local";
        const projectDir = args.project_dir ?? String((await pool.request<any>(endpointId, "thread/read", { threadId: args.thread_id, includeTurns: false })).thread.cwd);
        await lifecycle.adopt(args.nickname, endpointId, args.thread_id, projectDir); return { nickname: args.nickname };
      },
      rename_session: async (args) => { await registry.rename(args.old_nickname, args.new_nickname); await reconcileNotebook(); return { nickname: args.new_nickname }; },
      detach_session: async (args) => { await lifecycle.detach(args.nickname); return { nickname: args.nickname }; },
      attach_session: async (args) => { await lifecycle.attach(args.nickname); return { nickname: args.nickname }; },
      archive_session: async (args) => { await lifecycle.archive(args.nickname); return { nickname: args.nickname }; },
      send_to_session: async (args, context) => {
        const files = args.attachment_ids.map((id: any) => attachments.toUserInput(context.sourceContextId, id));
        const input = [...(args.content.length > 0 ? [{ type: "text", text: args.content, text_elements: [] }] : []), ...files];
        return sessions.send(args.nickname, args.content, { mode: args.mode, clientUserMessageId: `${context.sourceContextId}:${context.callId}`, input });
      },
      read_worker_message: async (args) => {
        const message = finals.getById(args.message_id); if (!message) throw new Error("unknown worker message"); return message;
      },
      collect_messages: async (args) => args.direct
        ? sessions.collect(args.nickname, args.count, { direct: true, destination: String(config.telegramDestinationChatId) })
        : sessions.collect(args.nickname, args.count),
      interrupt_session: async (args) => { await sessions.interrupt(args.nickname, args.turn_id); return { interrupted: true }; },
      list_models: async (args) => sessions.models(args.endpoint ?? "local"),
      set_session_model: async (args) => { await sessions.setModel(args.nickname, args.model); return { pending: true }; },
      set_reasoning_effort: async (args) => { await sessions.setEffort(args.nickname, args.effort); return { pending: true }; },
      get_goal: async (args) => sessions.getGoal(args.nickname),
      set_goal: async (args) => sessions.setGoal(args.nickname, args.objective, args.token_budget),
      pause_goal: async (args) => sessions.pauseGoal(args.nickname), resume_goal: async (args) => sessions.resumeGoal(args.nickname),
      cancel_goal: async (args) => { if (args.interrupt_active_turn) await sessions.interrupt(args.nickname).catch(() => undefined); return sessions.cancelGoal(args.nickname); },
      send_chat_message: async (args) => ({ deliveryId: deliveries.prepare({ kind: "chat", destination: String(config.telegramDestinationChatId), body: args.content, mandatory: false }).id }),
      prepare_chat_attachment: async (args, context) => {
        const ownerRoot = args.owner === "coordinator" ? coordinatorDir : registry.get(args.owner)?.project_dir;
        if (!ownerRoot) throw new Error("unknown attachment owner");
        return attachments.prepareOutbound(context.sourceContextId, ownerRoot, args.relative_path);
      },
      send_chat_attachment: async (args, context) => {
        const upload = await attachments.openForUpload(context.sourceContextId, args.file_handle);
        try { return await api.sendDocument(config.telegramDestinationChatId, upload); } finally { await upload.close(); }
      },
    };
  }

  async function reconcileNotebook(): Promise<void> {
    const map = new Map(Object.entries(registry.snapshot().sessions).map(([name, session]) => [session.thread_id, name]));
    await notebook.reconcileNicknames(map);
  }

  async function runCoordinatorJob(job: CoordinatorJob): Promise<void> {
    const isInternal = "events" in job;
    const eventIds = isInternal ? job.events.map((event) => event.id) : [];
    const contextId = isInternal ? `batch:${eventIds.join(",")}` : String((job.payload as any).contextId);
    if (isInternal && !operations.getSourceContext(contextId)) operations.createSourceContext({ id: contextId, kind: "event_batch", sourceId: job.id, rawText: JSON.stringify(job.payload), attachmentIds: [] });
    const source = operations.getSourceContext(contextId);
    if (!source) throw new Error(`missing source context ${contextId}`);
    const identity = registry.snapshot().coordinator;
    const input: any[] = [{ type: "text", text: isInternal ? `Project session event metadata:\n${source.rawText}` : source.rawText, text_elements: [] }];
    if (!isInternal) input.push(...source.attachmentIds.map((id) => attachments.toUserInput(contextId, id as any)));
    const attemptId = `attempt_${crypto.randomUUID()}`;
    const response = await pool.startTurn<any>(identity.endpoint, { threadId: identity.thread_id, clientUserMessageId: contextId, input });
    const turnId = String(response.turn.id);
    if (isInternal) coordinator.beginInternalAttempt(contextId, attemptId, turnId); else coordinator.beginUserAttempt(contextId, attemptId, turnId);
    await new Promise<void>((resolvePromise, rejectPromise) => terminalWaiters.set(turnId, { resolve: resolvePromise, reject: rejectPromise, eventIds }));
  }

  async function onNotification(method: string, params: any): Promise<void> {
    const identity = registry.snapshot().coordinator;
    if (method === "turn/completed" && params.threadId === identity.thread_id) {
      const messages = finals.persistTerminalTurn(endpoint.id, identity.thread_id, params.turn, Date.now());
      if (params.turn.status === "completed") coordinator.handleTerminal(params.turn.id, messages.map((message) => message.body).join("\n") || undefined);
      else coordinator.failAttempt(params.turn.id, params.turn.error);
      pool.markTurnTerminal(endpoint.id, identity.thread_id, params.turn.id);
      const waiter = terminalWaiters.get(params.turn.id);
      if (waiter) {
        if (waiter.eventIds.length > 0) {
          const placeholders = waiter.eventIds.map(() => "?").join(",");
          db.prepare(`UPDATE events SET state = 'processed' WHERE id IN (${placeholders})`).run(...waiter.eventIds);
          for (const id of waiter.eventIds) enqueuedEvents.delete(id);
        }
        terminalWaiters.delete(params.turn.id); waiter.resolve();
      }
      return;
    }
    await relay.handleNotification(endpoint.id, method, params);
    await enqueuePendingEvents();
  }

  async function enqueuePendingEvents(): Promise<void> {
    const rows = db.prepare("SELECT id, endpoint_id, thread_id, payload_json FROM events WHERE state = 'pending' ORDER BY created_at, id").all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const id = String(row.id); if (enqueuedEvents.has(id)) continue;
      enqueuedEvents.add(id);
      scheduler.enqueueEvent({ id, sessionKey: `${row.endpoint_id}:${row.thread_id}`, payload: JSON.parse(String(row.payload_json)) });
    }
  }

  return composeApp(phases, { maintenance: { intervalMs: 60_000, run: async () => { await attachments.cleanupExpired(); discovery.cleanupExpired(); } } });
}
