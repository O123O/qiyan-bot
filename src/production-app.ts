import { randomBytes } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AttachmentStore } from "./attachments/store.ts";
import type { ChatAdapter } from "./chat/contracts.ts";
import { LocalEndpoint } from "./app-server/local-endpoint.ts";
import { AppServerPool } from "./app-server/pool.ts";
import { SUPPORTED_CODEX_VERSION } from "./app-server/protocol.ts";
import { composeApp, TerminalInbox, type AppPhase, type BotApp } from "./app.ts";
import type { BotConfig } from "./config.ts";
import { AppError } from "./core/errors.ts";
import { CoordinatorNotebook } from "./coordinator/notebook.ts";
import { CoordinatorRuntime } from "./coordinator/runtime.ts";
import { CoordinatorScheduler, type CoordinatorJob } from "./coordinator/scheduler.ts";
import { createCoordinatorTools, type CoordinatorToolName } from "./coordinator/tools.ts";
import { EventRelay } from "./events/relay.ts";
import { buildCodexChildEnvironment, coordinatorTurnConfig, LoopbackMcpServer, secureShellConfig } from "./mcp/server.ts";
import { SessionRegistry, type RegistryDocument } from "./registry/session-registry.ts";
import { SessionDiscovery } from "./sessions/discovery.ts";
import { FinalMessageStore } from "./sessions/final-messages.ts";
import { SessionLifecycle } from "./sessions/lifecycle.ts";
import { SessionService } from "./sessions/service.ts";
import { inTransaction, openDatabase, type Database } from "./storage/database.ts";
import { DeliveryStore } from "./storage/delivery-store.ts";
import { OperationStore } from "./storage/operation-store.ts";
import { RuntimeStore } from "./storage/runtime-store.ts";
import { TelegramChatAdapter } from "./telegram/chat-adapter.ts";
import { DeliveryWorker } from "./telegram/delivery-worker.ts";

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
  let coordinatorEndpoint!: LocalEndpoint;
  let pool!: AppServerPool;
  let discovery!: SessionDiscovery;
  let lifecycle!: SessionLifecycle;
  let sessions!: SessionService;
  let relay!: EventRelay;
  let coordinator!: CoordinatorRuntime;
  let scheduler!: CoordinatorScheduler;
  let mcp!: LoopbackMcpServer;
  let chat!: ChatAdapter;
  let deliveryWorker!: DeliveryWorker;
  let acceptingReadyEvents = false;
  const unsubscribers: Array<() => void> = [];
  const terminalWaiters = new Map<string, { resolve(): void; reject(error: unknown): void; eventIds: string[] }>();
  const earlyCoordinatorTerminals = new TerminalInbox<any>();
  const enqueuedEvents = new Set<string>();
  const enqueuedSources = new Set<string>();
  const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reconnectAttempts = new Map<string, number>();
  let endpointIncident = 0;
  let stopping = false;
  let registryInvalid = false;

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
          coordinator: { endpoint: "coordinator-local", thread_id: "pending", project_dir: coordinatorDir },
          sessions: {},
        });
        for (const [index, warning] of registry.warnings().entries()) {
          deliveries.prepare({ id: `registry-startup-warning:${index}`, kind: "system_warning", destination: String(config.telegramDestinationChatId), body: `[system] ${warning}`, mandatory: true });
        }
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
        mcp = new LoopbackMcpServer(tools, { current: () => coordinator.current() }, { host: config.mcpHost, port: config.mcpPort, token, allowedClientPid: () => coordinatorEndpoint?.pid });
        await mcp.start();
      }, stop: async () => { await mcp.stop(); },
    },
    {
      name: "subscriptions",
      start: async () => {
        endpoint = new LocalEndpoint({ id: "local", codexBinary: config.codexBinary, env: buildCodexChildEnvironment(process.env), expectedVersion: SUPPORTED_CODEX_VERSION });
        coordinatorEndpoint = new LocalEndpoint({ id: "coordinator-local", codexBinary: config.codexBinary, env: buildCodexChildEnvironment(process.env, token), expectedVersion: SUPPORTED_CODEX_VERSION });
        pool = new AppServerPool([endpoint, coordinatorEndpoint], { maxConcurrentTurns: config.maxConcurrentTurns });
        discovery = new SessionDiscovery(db, pool);
        lifecycle = new SessionLifecycle(pool, registry, runtime, { now: () => Date.now() }, { sandboxMode: config.sandboxMode });
        sessions = new SessionService(pool, registry, runtime, finals, deliveries);
        relay = new EventRelay(db, pool, registry, runtime, finals, deliveries, { destination: String(config.telegramDestinationChatId), clock: { now: () => Date.now() } }, attachments);
        scheduler = new CoordinatorScheduler(runCoordinatorJob);
        unsubscribers.push(endpoint.onNotification((method, params) => void onNotification(endpoint.id, method, params)));
        unsubscribers.push(coordinatorEndpoint.onNotification((method, params) => void onNotification(coordinatorEndpoint.id, method, params)));
        unsubscribers.push(endpoint.onPermissionBlocked((event) => void (async () => { await relay.handlePermissionBlocked(endpoint.id, event); await enqueuePendingEvents(); })()));
        unsubscribers.push(endpoint.onReady(() => { if (acceptingReadyEvents) void relay.reconcileEndpoint(endpoint.id); }));
        unsubscribers.push(coordinatorEndpoint.onReady(() => { if (acceptingReadyEvents) void reconcileCoordinatorAttempts(); }));
        unsubscribers.push(endpoint.onUnavailable(() => void handleEndpointUnavailable(endpoint)));
        unsubscribers.push(coordinatorEndpoint.onUnavailable(() => void handleEndpointUnavailable(coordinatorEndpoint)));
      }, stop: async () => { for (const unsubscribe of unsubscribers.splice(0)) unsubscribe(); },
    },
    {
      name: "endpoint",
      start: async () => { stopping = false; await endpoint.start(); await coordinatorEndpoint.start(); },
      stop: async () => {
        stopping = true;
        for (const timer of reconnectTimers.values()) clearTimeout(timer);
        reconnectTimers.clear();
        await Promise.all([coordinatorEndpoint.stop(), endpoint.stop()]);
      },
    },
    {
      name: "reconciliation",
      start: async () => {
        await lifecycle.reconcileStartup();
        await resumeManagedSessions();
        await relay.reconcileEndpoint(endpoint.id);
        deliveries.recoverAfterCrash();
        acceptingReadyEvents = true;
      }, stop: async () => { acceptingReadyEvents = false; },
    },
    {
      name: "coordinator",
      start: async () => {
        await reconcileNotebook();
        await startOrResumeCoordinator();
        await reconcileOperations();
        await reconcileCoordinatorAttempts();
      }, stop: async () => undefined,
    },
    {
      name: "scheduler",
      start: async () => { await enqueuePendingEvents(); await enqueuePendingSources(); },
      stop: async () => {
        stopping = true;
        const active = coordinator.current();
        if (active && !active.turnId.startsWith("pending:")) await pool.interrupt(endpoint.id, registry.snapshot().coordinator.thread_id, active.turnId).catch(() => undefined);
        for (const [turnId, waiter] of terminalWaiters) {
          terminalWaiters.delete(turnId);
          waiter.reject(new Error("bot is stopping"));
        }
        await scheduler.idle();
      },
    },
    {
      name: "delivery",
      start: async () => {
        chat = new TelegramChatAdapter(db, operations, attachments, { token: config.telegramBotToken, ownerId: config.telegramOwnerId, maxMessageBytes: config.attachmentMaxBytes, onAccepted: async (contextId) => { enqueueSource(contextId); } });
        deliveryWorker = new DeliveryWorker(deliveries, chat.delivery, attachments);
        deliveryWorker.start();
      },
      stop: async () => { await deliveryWorker.stop(); },
    },
    { name: "maintenance", start: async () => undefined, stop: async () => undefined },
    {
      name: "polling",
      start: async () => { chat.start(); }, stop: async () => { await chat.stop(); },
    },
  ];

  function buildActions(): Partial<Record<CoordinatorToolName, (args: any, context: any) => Promise<any>>> {
    return {
      list_managed_sessions: async () => registry.snapshot(),
      discover_sessions: async (args) => discovery.list({ endpointId: args.endpoint ?? "local", ...(args.search ? { search: args.search } : {}), ...(args.cwd ? { cwd: args.cwd } : {}), ...(args.limit ? { limit: args.limit } : {}), ...(args.cursor ? { cursor: args.cursor } : {}) }),
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
        const result = await sessions.send(args.nickname, args.content, { mode: args.mode, clientUserMessageId: `${context.sourceContextId}:${context.callId}`, input });
        const worker = registry.get(args.nickname)!;
        if (args.attachment_ids.length > 0 && !result.terminal) {
          attachments.retainForTurn(worker.endpoint, worker.thread_id, result.turnId, context.sourceContextId, args.attachment_ids);
          const history = await pool.request<any>(worker.endpoint, "thread/read", { threadId: worker.thread_id, includeTurns: true });
          const turn = history.thread.turns.find((candidate: any) => candidate.id === result.turnId);
          if (turn && isTerminalStatus(turn.status)) attachments.releaseTurn(worker.endpoint, worker.thread_id, result.turnId);
        }
        return result;
      },
      read_worker_message: async (args) => {
        const session = registry.get(args.nickname);
        if (!session) throw new Error(`unknown session: ${args.nickname}`);
        const message = finals.getById(args.message_id);
        if (!message || message.endpointId !== session.endpoint || message.threadId !== session.thread_id) throw new Error("worker message does not belong to that nickname");
        return message;
      },
      collect_messages: async (args, context) => args.direct
        ? sessions.collect(args.nickname, args.count, { direct: true, destination: String(config.telegramDestinationChatId), deliveryKey: context.sourceContextId })
        : sessions.collect(args.nickname, args.count),
      interrupt_session: async (args) => { await sessions.interrupt(args.nickname, args.turn_id); return { interrupted: true }; },
      list_models: async (args) => sessions.models(args.endpoint ?? "local"),
      set_session_model: async (args) => { await sessions.setModel(args.nickname, args.model); return { pending: true }; },
      set_reasoning_effort: async (args) => { await sessions.setEffort(args.nickname, args.effort); return { pending: true }; },
      get_goal: async (args) => sessions.getGoal(args.nickname),
      set_goal: async (args) => sessions.setGoal(args.nickname, args.objective, args.token_budget),
      pause_goal: async (args) => sessions.pauseGoal(args.nickname), resume_goal: async (args) => sessions.resumeGoal(args.nickname),
      cancel_goal: async (args) => { if (args.interrupt_active_turn) await sessions.interrupt(args.nickname).catch(() => undefined); return sessions.cancelGoal(args.nickname); },
      send_chat_message: async (args, context) => ({ deliveryId: deliveries.prepare({ id: `chat:${context.sourceContextId}:${context.attemptId}:${context.callId}`, kind: "chat", destination: String(config.telegramDestinationChatId), body: args.content, mandatory: false, replyTo: args.reply_to }).id }),
      prepare_chat_attachment: async (args, context) => {
        const ownerRoot = args.owner === "coordinator" ? coordinatorDir : registry.get(args.owner)?.project_dir;
        if (!ownerRoot) throw new Error("unknown attachment owner");
        const prepared = await attachments.prepareOutbound(context.sourceContextId, ownerRoot, args.relative_path);
        return { file_handle: prepared.id, display_name: prepared.displayName, media_type: prepared.mediaType, size: prepared.size, sha256: prepared.sha256 };
      },
      send_chat_attachment: async (args, context) => {
        const attachment = attachments.toUserInput(context.sourceContextId, args.file_handle);
        void attachment;
        const delivery = deliveries.prepareAttachment({
          id: `chat-attachment:${context.sourceContextId}:${context.attemptId}:${context.callId}`,
          kind: "attachment", destination: String(config.telegramDestinationChatId), body: args.caption ?? "", mandatory: false,
          attachmentId: args.file_handle, attachmentScopeId: context.sourceContextId,
          replyTo: args.reply_to,
        });
        return { deliveryId: delivery.id };
      },
    };
  }

  async function reconcileNotebook(): Promise<void> {
    const map = new Map(Object.entries(registry.snapshot().sessions).map(([name, session]) => [session.thread_id, name]));
    await notebook.reconcileNicknames(map);
  }

  async function runCoordinatorJob(job: CoordinatorJob): Promise<void> {
    const isEventBatch = "events" in job;
    const eventIds = isEventBatch ? job.events.map((event) => event.id) : [];
    const contextId = isEventBatch ? `batch:${eventIds.join(",")}` : String((job.payload as any).contextId);
    if (stopping || hasOrphanCoordinatorAttempt()) {
      enqueuedSources.delete(contextId);
      for (const id of eventIds) enqueuedEvents.delete(id);
      return;
    }
    if (isEventBatch) {
      inTransaction(db, () => {
        operations.createSourceContext({ id: contextId, kind: "event_batch", sourceId: job.id, rawText: JSON.stringify(job.payload), attachmentIds: [] });
        db.prepare("INSERT OR IGNORE INTO event_batches(id, event_ids_json, state, created_at) VALUES (?, ?, 'pending', ?)")
          .run(contextId, JSON.stringify(eventIds), Date.now());
      });
    }
    const source = operations.getSourceContext(contextId);
    if (!source) throw new Error(`missing source context ${contextId}`);
    if (source.state !== "pending") {
      enqueuedSources.delete(contextId);
      for (const id of eventIds) enqueuedEvents.delete(id);
      return;
    }
    const isInternal = source.kind !== "telegram";
    const identity = registry.snapshot().coordinator;
    const internalLabel = source.kind === "recovery" ? "Recovery metadata for a previous coordinator attempt" : "Project session event metadata";
    const input: any[] = [{ type: "text", text: isInternal ? `${internalLabel}:\n${source.rawText}` : source.rawText, text_elements: [] }];
    if (!isInternal && source.attachmentIds.length > 0) {
      input.push({ type: "text", text: `Backend attachment handles in source order: ${JSON.stringify(source.attachmentIds)}`, text_elements: [] });
      input.push(...source.attachmentIds.map((id) => attachments.toUserInput(contextId, id as any)));
    }
    const attemptId = `attempt_${crypto.randomUUID()}`;
    coordinator.prepareAttempt(contextId, attemptId, isInternal ? "internal" : "user");
    try {
      const response = await pool.startTurn<any>(identity.endpoint, { threadId: identity.thread_id, clientUserMessageId: contextId, input });
      const turnId = String(response.turn.id);
      coordinator.bindTurn(attemptId, turnId);
      const terminal = new Promise<void>((resolvePromise, rejectPromise) => terminalWaiters.set(turnId, { resolve: resolvePromise, reject: rejectPromise, eventIds }));
      const early = earlyCoordinatorTerminals.take(turnId);
      if (early) await processCoordinatorTerminal(early);
      else if (isTerminalStatus(response.turn.status)) await processCoordinatorTerminal({ threadId: identity.thread_id, turn: response.turn });
      await terminal;
    } catch (error) {
      const active = coordinator.current();
      if (active?.attemptId === attemptId) terminalWaiters.delete(active.turnId);
      const uncertainTransport = coordinatorEndpoint.state !== "ready" || (error instanceof AppError && new Set(["ENDPOINT_UNAVAILABLE", "OPERATION_UNCERTAIN"]).has(error.code));
      if (uncertainTransport && active?.attemptId === attemptId) {
        coordinator.abandonActive(active.turnId);
        enqueuedSources.delete(contextId);
        for (const id of eventIds) enqueuedEvents.delete(id);
        return;
      }
      const recovery = active?.attemptId === attemptId ? coordinator.failAttempt(active.turnId, error) : undefined;
      await requeueFailedContext(contextId, eventIds, recovery);
    }
  }

  async function onNotification(endpointId: string, method: string, params: any): Promise<void> {
    const identity = registry.snapshot().coordinator;
    if (endpointId === identity.endpoint && method === "turn/completed" && params.threadId === identity.thread_id) {
      pool.markTurnTerminal(endpointId, identity.thread_id, params.turn.id);
      if (terminalWaiters.has(params.turn.id) || coordinator.activeAttempts().some((attempt) => attempt.turnId === params.turn.id)) await processCoordinatorTerminal(params);
      else earlyCoordinatorTerminals.publish(params.turn.id, params);
      return;
    }
    await relay.handleNotification(endpointId, method, params);
    await enqueuePendingEvents();
  }

  async function processCoordinatorTerminal(params: any): Promise<void> {
    const identity = registry.snapshot().coordinator;
    const history = await pool.request<any>(identity.endpoint, "thread/read", { threadId: identity.thread_id, includeTurns: true });
    const turn = history.thread.turns.find((candidate: any) => candidate.id === params.turn.id) ?? params.turn;
    const messages = finals.persistTerminalTurn(identity.endpoint, identity.thread_id, turn, Date.now());
    const attempt = coordinator.contextForTurn(turn.id);
    let recovery: ReturnType<CoordinatorRuntime["failAttempt"]>;
    if (turn.status === "completed") {
      coordinator.handleTerminal(turn.id, messages.map((message) => message.body).join("\n") || undefined);
      if (attempt) {
        enqueuedSources.delete(attempt.contextId);
      }
    } else {
      recovery = coordinator.failAttempt(turn.id, turn.error);
    }
    const waiter = terminalWaiters.get(turn.id);
    const durableEventIds = attempt ? eventIdsForContext(attempt.contextId) : [];
    for (const id of durableEventIds) enqueuedEvents.delete(id);
    if (!waiter) {
      if (turn.status !== "completed" && attempt) await requeueFailedContext(attempt.contextId, [], recovery);
      await enqueuePendingEvents();
      await enqueuePendingSources();
      return;
    }
    if (turn.status !== "completed" && attempt) await requeueFailedContext(attempt.contextId, durableEventIds.length > 0 ? durableEventIds : waiter.eventIds, recovery);
    terminalWaiters.delete(turn.id); waiter.resolve();
    await enqueuePendingEvents();
    await enqueuePendingSources();
  }

  async function enqueuePendingEvents(): Promise<void> {
    if (stopping || hasOrphanCoordinatorAttempt()) return;
    const rows = db.prepare("SELECT id, endpoint_id, thread_id, payload_json FROM events WHERE state = 'pending' ORDER BY created_at, id").all() as Array<Record<string, unknown>>;
    const latestTransient = new Map<string, string>();
    for (const row of rows) {
      const payload = JSON.parse(String(row.payload_json));
      if (payload && typeof payload === "object" && "status" in payload && !("final" in payload)) latestTransient.set(`${row.endpoint_id}:${row.thread_id}`, String(row.id));
    }
    for (const row of rows) {
      const id = String(row.id);
      const sessionKey = `${row.endpoint_id}:${row.thread_id}`;
      const payload = JSON.parse(String(row.payload_json));
      if (payload && typeof payload === "object" && "status" in payload && !("final" in payload) && latestTransient.get(sessionKey) !== id) {
        db.prepare("UPDATE events SET state = 'coalesced' WHERE id = ? AND state = 'pending'").run(id);
        enqueuedEvents.delete(id);
        continue;
      }
      if (enqueuedEvents.has(id)) continue;
      enqueuedEvents.add(id);
      scheduler.enqueueEvent({ id, sessionKey, payload });
    }
  }

  async function enqueuePendingSources(): Promise<void> {
    if (stopping || hasOrphanCoordinatorAttempt()) return;
    for (const source of operations.listPendingSourceContexts(["telegram", "recovery"])) enqueueSource(source.id);
  }

  function enqueueSource(contextId: string): void {
    if (stopping || hasOrphanCoordinatorAttempt()) return;
    if (enqueuedSources.has(contextId)) return;
    enqueuedSources.add(contextId);
    scheduler.enqueueUser({ id: contextId, payload: { contextId } });
  }

  async function requeueFailedContext(contextId: string, eventIds: readonly string[], recovery: ReturnType<CoordinatorRuntime["failAttempt"]>): Promise<void> {
    enqueuedSources.delete(contextId);
    for (const id of eventIds) enqueuedEvents.delete(id);
    if (recovery) {
      if (!stopping) enqueueSource(recovery.id);
      return;
    }
    const retry = setTimeout(() => {
      if (stopping) return;
      if (eventIds.length > 0) void enqueuePendingEvents();
      else void enqueuePendingSources();
    }, 1_000);
    retry.unref?.();
  }

  function isTerminalStatus(status: unknown): boolean {
    return typeof status === "string" && new Set(["completed", "failed", "interrupted"]).has(status);
  }

  function eventIdsForContext(contextId: string): string[] {
    const row = db.prepare("SELECT event_ids_json FROM event_batches WHERE id = ?").get(contextId) as { event_ids_json: string } | undefined;
    return row ? JSON.parse(row.event_ids_json) as string[] : [];
  }

  function hasOrphanCoordinatorAttempt(): boolean {
    return coordinator.activeAttempts().length > 0 && coordinator.current() === undefined;
  }

  async function startOrResumeCoordinator(): Promise<void> {
    const identity = registry.snapshot().coordinator;
    const configOverride = coordinatorTurnConfig(mcp.url, token);
    const response = identity.thread_id === "pending"
      ? await coordinatorEndpoint.request<any>("thread/start", { cwd: coordinatorDir, approvalPolicy: "never", sandbox: config.sandboxMode, config: configOverride, ephemeral: false })
      : await coordinatorEndpoint.request<any>("thread/resume", { threadId: identity.thread_id, cwd: coordinatorDir, approvalPolicy: "never", sandbox: config.sandboxMode, config: configOverride });
    const threadId = String(response.thread.id);
    await registry.setCoordinator({ endpoint: coordinatorEndpoint.id, thread_id: threadId, project_dir: coordinatorDir });
    runtime.setSession(coordinatorEndpoint.id, threadId, "managed", response.thread.status?.type ?? "idle");
  }

  async function reconcileCoordinatorAttempts(): Promise<void> {
    const identity = registry.snapshot().coordinator;
    for (const attempt of coordinator.activeAttempts()) {
      let turnId = attempt.turnId;
      if (attempt.turnId.startsWith("pending:")) {
        const pendingHistory = await pool.request<any>(identity.endpoint, "thread/read", { threadId: identity.thread_id, includeTurns: true });
        const matched = [...pendingHistory.thread.turns].reverse().find((candidate: any) => candidate.items.some((item: any) => item.type === "userMessage" && item.clientId === attempt.contextId));
        if (matched) {
          coordinator.bindTurn(attempt.attemptId, matched.id);
          turnId = matched.id;
        } else if (pendingHistory.thread.status?.type === "idle") {
          await requeueFailedContext(attempt.contextId, [], coordinator.failAttempt(attempt.turnId, "restart proved that the unbound turn was never created"));
          continue;
        } else {
          continue;
        }
      }
      let history = await pool.request<any>(identity.endpoint, "thread/read", { threadId: identity.thread_id, includeTurns: true });
      let turn = history.thread.turns.find((candidate: any) => candidate.id === turnId);
      if (!turn || !isTerminalStatus(turn.status)) {
        await pool.interrupt(identity.endpoint, identity.thread_id, turnId).catch(() => undefined);
        const deadline = Date.now() + 30_000;
        do {
          history = await pool.request<any>(identity.endpoint, "thread/read", { threadId: identity.thread_id, includeTurns: true });
          turn = history.thread.turns.find((candidate: any) => candidate.id === turnId);
          if (turn && isTerminalStatus(turn.status)) break;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        } while (Date.now() < deadline);
      }
      if (turn && isTerminalStatus(turn.status)) await processCoordinatorTerminal({ threadId: identity.thread_id, turn });
      // If the exact turn is still not terminal, leave its source and attempt active.
      // A later terminal notification or maintenance pass will reconcile it; rerunning
      // the source now could let the old turn perform effects after the replay starts.
    }
  }

  async function reconcileOperations(): Promise<void> {
    for (const operation of operations.listRecoverable()) {
      const args = operation.args as any;
      try {
        if (operation.kind === "send_chat_message") {
          const id = `chat:${operation.contextId}:${operation.attemptId}:${operation.callId}`;
          if (deliveries.get(id)) operations.succeed(operation.id, { deliveryId: id });
        } else if (operation.kind === "send_chat_attachment") {
          const id = `chat-attachment:${operation.contextId}:${operation.attemptId}:${operation.callId}`;
          if (deliveries.get(id)) operations.succeed(operation.id, { deliveryId: id });
        } else if (operation.kind === "collect_messages") {
          const prefix = `collect:${operation.contextId}:`;
          const ids = (db.prepare("SELECT id FROM deliveries WHERE kind = 'collection' ORDER BY created_at, id").all() as Array<{ id: string }>).map((row) => row.id).filter((id) => id.startsWith(prefix));
          if (ids.length > 0) operations.succeed(operation.id, { deliveries: ids, count: args.count, nickname: args.nickname });
        } else if (operation.kind === "send_to_session") {
          const session = registry.get(args.nickname);
          if (!session) continue;
          const history = await pool.request<any>(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: true });
          const clientId = `${operation.contextId}:${operation.callId}`;
          const turn = history.thread.turns.find((candidate: any) => candidate.items.some((item: any) => item.type === "userMessage" && item.clientId === clientId));
          if (turn) operations.succeed(operation.id, { nickname: args.nickname, mode: args.mode, turnId: turn.id });
        } else if (operation.kind === "set_session_model" || operation.kind === "set_reasoning_effort") {
          const session = registry.get(args.nickname);
          const settings = session ? runtime.settings(session.endpoint, session.thread_id) : {};
          if (operation.kind === "set_session_model" && settings.model === args.model) operations.succeed(operation.id, { pending: true });
          if (operation.kind === "set_reasoning_effort" && settings.effort === args.effort) operations.succeed(operation.id, { pending: true });
        } else if (["create_session", "register_session", "adopt_session"].includes(operation.kind)) {
          const session = registry.get(args.nickname);
          const expectedThread = args.thread_id as string | undefined;
          const expectedDir = args.project_dir ? await realpath(args.project_dir) : undefined;
          if (session && (!expectedThread || session.thread_id === expectedThread) && (!expectedDir || session.project_dir === expectedDir)) operations.succeed(operation.id, { nickname: args.nickname });
        } else if (operation.kind === "rename_session") {
          if (!registry.get(args.old_nickname) && registry.get(args.new_nickname)) operations.succeed(operation.id, { nickname: args.new_nickname });
        } else if (["detach_session", "attach_session", "archive_session"].includes(operation.kind)) {
          const session = registry.get(args.nickname);
          const state = session ? runtime.getSession(session.endpoint, session.thread_id)?.managementState : undefined;
          const expected = operation.kind === "detach_session" ? "detached" : operation.kind === "attach_session" ? "managed" : "archived";
          if (state === expected) operations.succeed(operation.id, { nickname: args.nickname });
        } else if (["set_goal", "pause_goal", "resume_goal", "cancel_goal"].includes(operation.kind)) {
          const current = await sessions.getGoal(args.nickname) as any;
          const goal = current?.goal;
          const proven = operation.kind === "set_goal" ? goal?.objective === args.objective && goal?.status === "active"
            : operation.kind === "pause_goal" ? goal?.status === "paused"
              : operation.kind === "resume_goal" ? goal?.status === "active"
                : goal == null;
          if (proven) operations.succeed(operation.id, current);
        } else if (operation.kind === "interrupt_session" && args.turn_id) {
          const session = registry.get(args.nickname);
          if (!session) continue;
          const history = await pool.request<any>(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: true });
          const turn = history.thread.turns.find((candidate: any) => candidate.id === args.turn_id);
          if (turn && isTerminalStatus(turn.status)) operations.succeed(operation.id, { interrupted: true });
        }
      } catch {
        // Leave the operation uncertain unless authoritative state proves its exact outcome.
      }
    }
  }

  async function resumeManagedSessions(): Promise<void> {
    for (const [nickname, session] of Object.entries(registry.snapshot().sessions)) {
      if (session.endpoint !== endpoint.id) continue;
      const state = runtime.getSession(session.endpoint, session.thread_id);
      if (!state) {
        try {
          const response = await endpoint.request<any>("thread/read", { threadId: session.thread_id, includeTurns: false });
          await verifySessionCwd(response.thread.cwd, session.project_dir);
          runtime.setSession(session.endpoint, session.thread_id, "unavailable", response.thread.status?.type ?? "notLoaded");
        } catch {
          runtime.setSession(session.endpoint, session.thread_id, "unavailable", "notLoaded");
        }
        warnSessionUnavailable(nickname, session.endpoint, session.thread_id);
        continue;
      }
      if (state.managementState === "unavailable" && state.restoreState !== "managed") continue;
      if (state.managementState !== "managed" && state.managementState !== "unavailable") continue;
      try {
        const response = await endpoint.request<any>("thread/resume", {
          threadId: session.thread_id,
          cwd: session.project_dir,
          approvalPolicy: "never",
          sandbox: config.sandboxMode,
          config: secureShellConfig(),
        });
        await verifySessionCwd(response.thread.cwd, session.project_dir);
        const authoritative = await endpoint.request<any>("thread/read", { threadId: session.thread_id, includeTurns: true });
        const activeTurn = [...(authoritative.thread.turns ?? [])].reverse().find((turn: any) => !isTerminalStatus(turn.status));
        const nativeStatus = authoritative.thread.status?.type ?? response.thread.status?.type ?? "idle";
        runtime.setSession(session.endpoint, session.thread_id, "managed", nativeStatus);
        runtime.reconcileNativeState(session.endpoint, session.thread_id, nativeStatus, nativeStatus === "active" ? activeTurn?.id : undefined);
        if (!runtime.currentEpoch(session.endpoint, session.thread_id)) {
          const baseline = [...(authoritative.thread.turns ?? [])].reverse().find((turn: any) => isTerminalStatus(turn.status))?.id;
          runtime.beginEpoch(session.endpoint, session.thread_id, baseline, Date.now());
        }
      } catch {
        runtime.setSession(session.endpoint, session.thread_id, "unavailable", "notLoaded");
        warnSessionUnavailable(nickname, session.endpoint, session.thread_id);
      }
    }
  }

  async function handleEndpointUnavailable(target: LocalEndpoint): Promise<void> {
    if (stopping) return;
    endpointIncident += 1;
    acceptingReadyEvents = false;
    pool.markEndpointUnavailable(target.id);
    for (const session of runtime.listSessions()) {
      if (session.endpointId === target.id && session.managementState === "managed") {
        runtime.setSession(session.endpointId, session.threadId, "unavailable", "notLoaded");
      }
    }
    if (target.id === coordinatorEndpoint.id) {
      for (const [turnId, waiter] of terminalWaiters) {
        terminalWaiters.delete(turnId);
        waiter.reject(new AppError("ENDPOINT_UNAVAILABLE", "coordinator app-server became unavailable"));
      }
    }
    const identity = registry.snapshot().coordinator;
    deliveries.prepare({
      id: `endpoint-unavailable:${target.id}:${endpointIncident}`,
      kind: "system_warning",
      destination: String(config.telegramDestinationChatId),
      body: `[system] ${target.id} app-server is unavailable; reconnecting`,
      mandatory: true,
    });
    db.prepare(`INSERT OR IGNORE INTO events(id, endpoint_id, thread_id, kind, payload_json, state, created_at)
      VALUES (?, ?, ?, 'endpoint_unavailable', ?, 'pending', ?)`)
      .run(`endpoint-unavailable:${target.id}:${endpointIncident}`, target.id, identity.thread_id, JSON.stringify({ endpointId: target.id, status: "unavailable", incident: endpointIncident }), Date.now());
    scheduleReconnect(target);
  }

  function scheduleReconnect(target: LocalEndpoint): void {
    if (stopping || reconnectTimers.has(target.id)) return;
    const attempt = reconnectAttempts.get(target.id) ?? 0;
    const delay = Math.min(1_000 * 2 ** attempt, 30_000);
    reconnectAttempts.set(target.id, attempt + 1);
    const timer = setTimeout(() => {
      reconnectTimers.delete(target.id);
      void recoverEndpoint(target).catch(() => scheduleReconnect(target));
    }, delay);
    reconnectTimers.set(target.id, timer);
    timer.unref?.();
  }

  async function recoverEndpoint(target: LocalEndpoint): Promise<void> {
    if (stopping) return;
    await target.start();
    if (target.id === endpoint.id) {
      await resumeManagedSessions();
      await relay.reconcileEndpoint(endpoint.id);
      await reconcileOperations();
    } else {
      await startOrResumeCoordinator();
      await reconcileOperations();
      await reconcileCoordinatorAttempts();
    }
    acceptingReadyEvents = true;
    reconnectAttempts.set(target.id, 0);
    await enqueuePendingEvents();
    await enqueuePendingSources();
  }

  async function verifySessionCwd(actual: string, expected: string): Promise<void> {
    if (await realpath(actual) !== await realpath(expected)) throw new Error("registered project directory does not match thread cwd");
  }

  function warnSessionUnavailable(nickname: string, endpointId: string, threadId: string): void {
    deliveries.prepare({
      id: `session-unavailable:${endpointId}:${threadId}:${endpointIncident}`,
      kind: "worker_warning",
      destination: String(config.telegramDestinationChatId),
      body: `[${nickname}] unavailable; its registered thread and project directory require verification`,
      mandatory: true,
    });
  }

  return composeApp(phases, { maintenance: { intervalMs: 60_000, run: runMaintenance } });

  async function runMaintenance(): Promise<void> {
    await attachments.cleanupExpired();
    discovery.cleanupExpired();
    if (coordinatorEndpoint.state === "ready") {
      await reconcileCoordinatorAttempts();
      if (!hasOrphanCoordinatorAttempt()) {
        await enqueuePendingEvents();
        await enqueuePendingSources();
      }
    }
    if (endpoint.state !== "ready") return;
    const accepted = await registry.reload(validateRegistryDocument);
    if (!accepted) {
      if (!registryInvalid) {
        deliveries.prepare({
          id: `registry-invalid:${Date.now()}`,
          kind: "system_warning",
          destination: String(config.telegramDestinationChatId),
          body: "[system] sessions.json replacement was rejected; the last valid registry remains active",
          mandatory: true,
        });
      }
      registryInvalid = true;
      return;
    }
    registryInvalid = false;
    await initializeNewRegistryMappings();
    await reconcileNotebook();
  }

  async function validateRegistryDocument(document: RegistryDocument): Promise<void> {
    const currentCoordinator = registry.snapshot().coordinator;
    if (document.coordinator.endpoint !== currentCoordinator.endpoint || document.coordinator.thread_id !== currentCoordinator.thread_id || document.coordinator.project_dir !== currentCoordinator.project_dir) {
      throw new Error("the live coordinator mapping cannot be externally repointed");
    }
    for (const session of Object.values(document.sessions)) {
      if (session.endpoint !== endpoint.id) throw new Error(`unknown endpoint: ${session.endpoint}`);
      const response = await endpoint.request<any>("thread/read", { threadId: session.thread_id, includeTurns: false });
      await verifySessionCwd(response.thread.cwd, session.project_dir);
    }
  }

  async function initializeNewRegistryMappings(): Promise<void> {
    for (const [nickname, session] of Object.entries(registry.snapshot().sessions)) {
      if (runtime.getSession(session.endpoint, session.thread_id)) continue;
      const response = await endpoint.request<any>("thread/read", { threadId: session.thread_id, includeTurns: false });
      runtime.setSession(session.endpoint, session.thread_id, "unavailable", response.thread.status?.type ?? "notLoaded");
      warnSessionUnavailable(nickname, session.endpoint, session.thread_id);
    }
  }
}
