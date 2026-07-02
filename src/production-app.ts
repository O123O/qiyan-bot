import { createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AttachmentStore, type FileHandleId } from "./attachments/store.ts";
import type { ChatAdapter } from "./chat/contracts.ts";
import { LocalEndpoint } from "./app-server/local-endpoint.ts";
import { AppServerPool } from "./app-server/pool.ts";
import { SUPPORTED_CODEX_VERSION } from "./app-server/protocol.ts";
import { composeApp, TerminalInbox, type AppPhase, type BotApp } from "./app.ts";
import type { BotConfig } from "./config.ts";
import { AppError } from "./core/errors.ts";
import { runBackground } from "./core/background.ts";
import { SessionDashboard } from "./assistant/session-dashboard.ts";
import { activateAssistantProfileIdentity, resumeAssistantIdentity } from "./assistant/identity.ts";
import { recordAssistantAuthenticationFailure } from "./assistant/auth-recovery.ts";
import { buildAssistantChildEnvironment, prepareAssistantProfile, startAuthenticatedAssistantEndpoint, type PreparedAssistantProfile } from "./assistant/profile.ts";
import { AssistantRuntime } from "./assistant/runtime.ts";
import { AssistantScheduler, type AssistantJob } from "./assistant/scheduler.ts";
import { SessionObservationProcessor } from "./assistant/session-observer.ts";
import { createAssistantTools, type AssistantToolName } from "./assistant/tools.ts";
import { prepareAssistantWorkspace } from "./assistant/workspace.ts";
import { EventRelay } from "./events/relay.ts";
import { persistDeliveryStateEvent, reconcileDeliveryStateEvents } from "./events/delivery-status.ts";
import { buildWorkerChildEnvironment, assistantTurnConfig, LoopbackMcpServer } from "./mcp/server.ts";
import { SessionRegistry, type RegistryDocument } from "./registry/session-registry.ts";
import { SessionDiscovery } from "./sessions/discovery.ts";
import { FinalMessageStore } from "./sessions/final-messages.ts";
import { SessionLifecycle, workerThreadResumeParams } from "./sessions/lifecycle.ts";
import { preparedProjectWorkspaceFromCheckpoint, ProjectWorkspacePolicy, type PreparedProjectWorkspace } from "./sessions/project-workspace.ts";
import { SessionService } from "./sessions/service.ts";
import { inTransaction, openDatabase, type Database } from "./storage/database.ts";
import { DeliveryStore, type DeliveryRecord } from "./storage/delivery-store.ts";
import { OperationStore } from "./storage/operation-store.ts";
import { RuntimeStore } from "./storage/runtime-store.ts";
import { SessionDashboardStore } from "./storage/session-dashboard-store.ts";
import { TelegramChatAdapter } from "./telegram/chat-adapter.ts";
import { DeliveryWorker } from "./telegram/delivery-worker.ts";

const assistantAssetRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/assistant");
const fullAccessWarning = "QiYan assistant is running non-interactively with full filesystem access and approvals disabled.";

export function assistantAccessWarning(mode: BotConfig["assistantSandboxMode"]): string | undefined {
  return mode === "danger-full-access" ? fullAccessWarning : undefined;
}

export async function buildProductionApp(
  config: BotConfig,
  options: { chdir?: (path: string) => void } = {},
): Promise<BotApp> {
  const token = randomBytes(32).toString("base64url");

  let assistantDir = config.assistantWorkdir;
  let dataDir = config.dataDir;
  let registryPath = config.sessionRegistryPath;
  let dashboardPath = join(assistantDir, "session-status.json");
  let assistantWarnings: string[] = [];
  let assistantProfile!: PreparedAssistantProfile;
  let db!: Database;
  let registry!: SessionRegistry;
  let dashboardStore!: SessionDashboardStore;
  let dashboard!: SessionDashboard;
  let observations!: SessionObservationProcessor;
  let attachments!: AttachmentStore;
  let operations!: OperationStore;
  let deliveries!: DeliveryStore;
  let runtime!: RuntimeStore;
  let finals!: FinalMessageStore;
  let endpoint!: LocalEndpoint;
  let assistantEndpoint!: LocalEndpoint;
  let pool!: AppServerPool;
  let discovery!: SessionDiscovery;
  let lifecycle!: SessionLifecycle;
  let projectWorkspaces!: ProjectWorkspacePolicy;
  let sessions!: SessionService;
  let relay!: EventRelay;
  let assistant!: AssistantRuntime;
  let scheduler!: AssistantScheduler;
  let mcp!: LoopbackMcpServer;
  let chat!: ChatAdapter;
  let deliveryWorker!: DeliveryWorker;
  let acceptingReadyEvents = false;
  let schedulerAccepting = false;
  const unsubscribers: Array<() => void> = [];
  const terminalWaiters = new Map<string, { resolve(): void; reject(error: unknown): void; eventIds: string[] }>();
  const earlyAssistantTerminals = new TerminalInbox<any>();
  const enqueuedEvents = new Set<string>();
  const enqueuedSources = new Set<string>();
  const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reconnectAttempts = new Map<string, number>();
  let endpointIncident = 0;
  let stopping = false;
  let registryInvalid = false;
  let endpointsCommitted = false;
  let backgroundIncident = 0;
  let operationReconciliationTail: Promise<void> = Promise.resolve();

  const phases: AppPhase[] = [
    {
      name: "assistant-workspace",
      start: async () => {
        const prepared = await prepareAssistantWorkspace({
          workdir: config.assistantWorkdir,
          dataDir: config.dataDir,
          registryPath: config.sessionRegistryPath,
          policyTemplatePath: join(assistantAssetRoot, "AGENTS.md"),
          userHome: config.userHome,
          qiyanHome: config.qiyanHome,
        });
        assistantDir = prepared.root;
        dataDir = prepared.dataRoot;
        registryPath = prepared.registryPath;
        dashboardPath = prepared.dashboardPath;
        assistantWarnings = prepared.warnings;
        projectWorkspaces = new ProjectWorkspacePolicy({
          userHome: prepared.userHome,
          qiyanHome: prepared.qiyanHome,
          assistantWorkdir: prepared.root,
          dataDir: prepared.dataRoot,
          registryPath: prepared.registryPath,
          defaultProjectsRoot: prepared.defaultProjectsRoot,
        });
        assistantProfile = await prepareAssistantProfile(dataDir);
      },
      stop: async () => undefined,
    },
    {
      name: "assistant-working-directory",
      start: async () => { (options.chdir ?? ((path: string) => process.chdir(path)))(assistantDir); },
      stop: async () => undefined,
    },
    {
      name: "storage",
      start: async () => {
        db = openDatabase(join(dataDir, "bot.sqlite3"));
        operations = new OperationStore(db); deliveries = new DeliveryStore(db); runtime = new RuntimeStore(db); finals = new FinalMessageStore(db);
        dashboardStore = new SessionDashboardStore(db);
      },
      stop: async () => { db.close(); },
    },
    {
      name: "registry",
      start: async () => {
        registry = await SessionRegistry.open(registryPath, {
          version: 2,
          assistant: { endpoint: "assistant-local", thread_id: "pending", project_dir: assistantDir },
          sessions: {},
        });
        for (const [index, warning] of registry.warnings().entries()) {
          deliveries.prepare({ id: `registry-startup-warning:${index}`, kind: "system_warning", destination: String(config.telegramDestinationChatId), body: `[system] ${warning}`, mandatory: true });
        }
        for (const [index, warning] of assistantWarnings.entries()) {
          deliveries.prepare({ id: `assistant-workspace-warning:${index}`, kind: "system_warning", destination: String(config.telegramDestinationChatId), body: `[system] ${warning}`, mandatory: true });
        }
        const accessWarning = assistantAccessWarning(config.assistantSandboxMode);
        if (accessWarning) {
          deliveries.prepare({
            id: "assistant-full-access-warning",
            kind: "system_warning",
            destination: String(config.telegramDestinationChatId),
            body: `[system] ${accessWarning}`,
            mandatory: true,
          });
        }
      }, stop: async () => undefined,
    },
    {
      name: "dashboard",
      start: async () => {
        dashboard = new SessionDashboard(dashboardStore, registry, runtime, { root: assistantDir, path: dashboardPath });
        try { await dashboard.initializeAndRender(); }
        catch (error) { queueDashboardWarning(); throw error; }
      },
      stop: async () => { await dashboard.idle(); },
    },
    {
      name: "attachments",
      start: async () => {
        attachments = new AttachmentStore(db, join(dataDir, "attachments"), { maxFileBytes: config.attachmentMaxBytes, maxStoreBytes: config.attachmentStoreMaxBytes });
        await attachments.initialize();
      }, stop: async () => undefined,
    },
    {
      name: "mcp",
      start: async () => {
        assistant = new AssistantRuntime(db, operations, deliveries, { destination: String(config.telegramDestinationChatId) });
        const actions = buildActions();
        const tools = createAssistantTools(operations, actions, { maxCollectCount: config.maxCollectCount });
        mcp = new LoopbackMcpServer(tools, { current: () => assistant.current() }, { host: config.mcpHost, port: config.mcpPort, token, allowedClientProcess: () => assistantEndpoint?.mcpClientIdentity });
        await mcp.start();
      }, stop: async () => { await mcp.stop(); },
    },
    {
      name: "subscriptions",
      start: async () => {
        endpoint = new LocalEndpoint({ id: "local", codexBinary: config.codexBinary, env: buildWorkerChildEnvironment(process.env), expectedVersion: SUPPORTED_CODEX_VERSION });
        assistantEndpoint = new LocalEndpoint({
          id: "assistant-local",
          codexBinary: config.codexBinary,
          env: buildAssistantChildEnvironment(process.env, assistantProfile, token),
          expectedCodexHome: assistantProfile.codexHome,
          validateEnvironment: () => assistantProfile.assertIntact(),
          expectedVersion: SUPPORTED_CODEX_VERSION,
        });
        pool = new AppServerPool([endpoint, assistantEndpoint], { maxConcurrentTurns: config.maxConcurrentTurns });
        discovery = new SessionDiscovery(db, pool);
        lifecycle = new SessionLifecycle(pool, registry, runtime, { now: () => Date.now() }, projectWorkspaces);
        sessions = new SessionService(pool, registry, runtime, finals, deliveries);
        observations = new SessionObservationProcessor(dashboardStore, registry, runtime, {
          now: () => Date.now(),
          readThread: async (endpointId, threadId) => (await pool.request<any>(endpointId, "thread/read", { threadId, includeTurns: true })).thread,
          readGoal: (endpointId, threadId) => pool.request(endpointId, "thread/goal/get", { threadId }),
          onChanged: () => runBackground(() => renderDashboardSafely(), () => recordBackgroundFailure("dashboard rendering")),
          onError: () => recordBackgroundFailure("session observation"),
        });
        relay = new EventRelay(db, pool, registry, runtime, finals, deliveries, {
          destination: String(config.telegramDestinationChatId),
          clock: { now: () => Date.now() },
          onTerminal: (event) => observations.observeTerminal(event),
        }, attachments);
        scheduler = new AssistantScheduler(runAssistantJob, { onError: handleSchedulerFailure });
        unsubscribers.push(endpoint.onNotification((method, params) => {
          if (!observations.accept(endpoint.id, method, params)) runBackground(() => onNotification(endpoint.id, method, params), () => recordBackgroundFailure("project notification"));
        }));
        unsubscribers.push(assistantEndpoint.onNotification((method, params) => runBackground(() => onNotification(assistantEndpoint.id, method, params), () => recordBackgroundFailure("assistant notification"))));
        unsubscribers.push(endpoint.onPermissionBlocked((event) => runBackground(async () => {
          await relay.handlePermissionBlocked(endpoint.id, event);
          if (event.threadId && runtime.getSession(endpoint.id, event.threadId)?.managementState === "managed") {
            const state = runtime.getSession(endpoint.id, event.threadId)!;
            runtime.reconcileNativeState(endpoint.id, event.threadId, state.nativeStatus, runtime.activeTurn(endpoint.id, event.threadId), dashboardStore.allocateObservationSequence());
            dashboardStore.observeLifecycle({ endpointId: endpoint.id, threadId: event.threadId }, Date.now());
            await renderDashboardSafely();
          }
          enqueuePendingEvents();
        }, () => recordBackgroundFailure("permission notification"))));
        unsubscribers.push(endpoint.onReady(() => { if (acceptingReadyEvents) runBackground(() => relay.reconcileEndpoint(endpoint.id), () => recordBackgroundFailure("project ready reconciliation")); }));
        unsubscribers.push(assistantEndpoint.onReady(() => { if (acceptingReadyEvents) runBackground(() => reconcileAssistantAttempts(), () => recordBackgroundFailure("assistant ready reconciliation")); }));
        unsubscribers.push(endpoint.onUnavailable(() => runBackground(() => handleEndpointUnavailable(endpoint), () => recordBackgroundFailure("project unavailable handling"))));
        unsubscribers.push(assistantEndpoint.onUnavailable(() => runBackground(() => handleEndpointUnavailable(assistantEndpoint), () => recordBackgroundFailure("assistant unavailable handling"))));
      }, stop: async () => { for (const unsubscribe of unsubscribers.splice(0)) unsubscribe(); await observations.idle(); },
    },
    {
      name: "endpoint",
      start: async () => {
        stopping = false;
        endpointsCommitted = false;
        try {
          await endpoint.start();
          await startAuthenticatedAssistantEndpoint(assistantEndpoint, assistantProfile);
          if (endpoint.state !== "ready" || assistantEndpoint.state !== "ready") throw new AppError("ENDPOINT_UNAVAILABLE", "an app-server became unavailable during initial startup");
          endpointsCommitted = true;
        } catch (error) {
          stopping = true;
          for (const timer of reconnectTimers.values()) clearTimeout(timer);
          reconnectTimers.clear();
          await Promise.all([assistantEndpoint.stop(), endpoint.stop()]).catch(() => undefined);
          throw error;
        }
      },
      stop: async () => {
        stopping = true;
        endpointsCommitted = false;
        for (const timer of reconnectTimers.values()) clearTimeout(timer);
        reconnectTimers.clear();
        await Promise.all([assistantEndpoint.stop(), endpoint.stop()]);
      },
    },
    {
      name: "reconciliation",
      start: async () => {
        await lifecycle.reconcileStartup();
        await resumeManagedSessions();
        await observations.drain(endpoint.id);
        await relay.reconcileEndpoint(endpoint.id);
        deliveries.recoverAfterCrash();
        reconcileDeliveryEvents();
        acceptingReadyEvents = true;
      }, stop: async () => { acceptingReadyEvents = false; await observations.idle(); await renderDashboardSafely(); },
    },
    {
      name: "assistant",
      start: async () => {
        await reconcileDashboard(true);
        await activateAssistantProfileIdentity({
          registry,
          endpointId: assistantEndpoint.id,
          assistantDir,
          activationRequired: assistantProfile.activationRequired,
          markActivated: () => assistantProfile.markActivated(),
        });
        await startOrResumeAssistant();
        await reconcileOperations();
        await reconcileAssistantAttempts();
      }, stop: async () => undefined,
    },
    {
      name: "scheduler",
      start: async () => { schedulerAccepting = true; await enqueuePendingEvents(); await enqueuePendingSources(); },
      stop: async () => {
        stopping = true;
        schedulerAccepting = false;
        const active = assistant.current();
        if (active && !active.turnId.startsWith("pending:")) await pool.interrupt(assistantEndpoint.id, registry.snapshot().assistant.thread_id, active.turnId).catch(() => undefined);
        for (const [turnId, waiter] of terminalWaiters) {
          terminalWaiters.delete(turnId);
          waiter.reject(new AppError("OPERATION_UNCERTAIN", "bot stopped before the assistant turn reached a proven terminal state"));
        }
        await scheduler.idle();
      },
    },
    {
      name: "delivery",
      start: async () => {
        chat = new TelegramChatAdapter(db, operations, attachments, { token: config.telegramBotToken, ownerId: config.telegramOwnerId, maxMessageBytes: config.attachmentMaxBytes, onAccepted: async (contextId) => { enqueueSource(contextId); } });
        deliveryWorker = new DeliveryWorker(deliveries, chat.delivery, attachments, undefined, (delivery) => { persistDeliveryState(delivery); });
        deliveryWorker.start();
      },
      stop: async () => { await deliveryWorker.stop(); await chat.close(); },
    },
    { name: "maintenance", start: async () => undefined, stop: async () => undefined },
    {
      name: "polling",
      start: async () => { chat.start(); }, stop: async () => { await chat.stop(); },
    },
  ];

  function buildActions(): Partial<Record<AssistantToolName, (args: any, context: any) => Promise<any>>> {
    return {
      list_managed_sessions: async () => registry.snapshot(),
      discover_sessions: async (args) => discovery.list({ endpointId: projectEndpoint(args.endpoint), ...(args.search ? { search: args.search } : {}), ...(args.cwd ? { cwd: args.cwd } : {}), ...(args.limit ? { limit: args.limit } : {}), ...(args.cursor ? { cursor: args.cursor } : {}) }),
      get_session_status: async (args) => {
        const identity = dashboardIdentity(args.nickname);
        const live = await sessions.status(args.nickname, { observeNative: ({ nativeStatus, activeTurnId }) => {
          const before = runtime.getSession(identity.endpointId, identity.threadId);
          const beforeTurn = runtime.activeTurn(identity.endpointId, identity.threadId) ?? null;
          const sequence = dashboardStore.allocateObservationSequence();
          const activeTurn = nativeStatus === "active" ? activeTurnId ?? undefined : undefined;
          const applied = runtime.reconcileNativeState(identity.endpointId, identity.threadId, nativeStatus, activeTurn, sequence);
          if (applied && (before?.nativeStatus !== nativeStatus || beforeTurn !== (activeTurn ?? null))) observeLifecycle(args.nickname);
        } }) as any;
        observeGoal(args.nickname, live.goal);
        await renderDashboardSafely();
        return dashboard.status(args.nickname);
      },
      create_session: async (args, context) => {
        const endpointId = projectEndpoint(args.endpoint);
        const project = await projectWorkspaces.prepareCreate(args.nickname, args.project_dir);
        const workspaceReceipt = projectWorkspaceReceipt(project);
        let dispatchStarted = false;
        let settingsObservationSequence: number | undefined;
        context.checkpoint({ endpoint: endpointId, ...workspaceReceipt, dispatchStarted });
        const settings = await lifecycle.create(args.nickname, endpointId, project, context.operationId, (thread, currentSettings) => {
          settingsObservationSequence = dashboardStore.allocateObservationSequence();
          context.checkpoint({ endpoint: endpointId, ...workspaceReceipt, dispatchStarted, threadId: thread.id, currentSettings, settingsObservationSequence });
          hydrateThreadOrder(endpointId, thread);
        }, () => {
          dispatchStarted = true;
          context.checkpoint({ endpoint: endpointId, ...workspaceReceipt, dispatchStarted });
        });
        advanceNativeWatermark(args.nickname);
        observeLifecycle(args.nickname);
        observeCurrentSettings(args.nickname, settings, Date.now(), settingsObservationSequence);
        await renderDashboardSafely();
        return { nickname: args.nickname };
      },
      register_session: async (args, context) => {
        const endpointId = projectEndpoint(args.endpoint);
        const project = await projectWorkspaces.prepareExisting(args.project_dir);
        context.checkpoint({ endpoint: endpointId, ...projectWorkspaceReceipt(project) });
        await lifecycle.register(args.nickname, endpointId, args.thread_id, project, (thread) => hydrateThreadOrder(endpointId, thread));
        advanceNativeWatermark(args.nickname);
        observeLifecycle(args.nickname);
        await renderDashboardSafely();
        return { nickname: args.nickname };
      },
      adopt_session: async (args, context) => {
        const endpointId = projectEndpoint(args.endpoint);
        const projectDir = args.project_dir ?? String((await pool.request<any>(endpointId, "thread/read", { threadId: args.thread_id, includeTurns: false })).thread.cwd);
        const project = await projectWorkspaces.prepareExisting(projectDir);
        context.checkpoint({ endpoint: endpointId, ...projectWorkspaceReceipt(project) });
        await lifecycle.adopt(args.nickname, endpointId, args.thread_id, project, (thread) => hydrateThreadOrder(endpointId, thread));
        advanceNativeWatermark(args.nickname);
        observeLifecycle(args.nickname);
        await renderDashboardSafely();
        return { nickname: args.nickname };
      },
      rename_session: async (args) => { await registry.rename(args.old_nickname, args.new_nickname); await reconcileDashboard(); return { nickname: args.new_nickname }; },
      detach_session: async (args) => { await lifecycle.detach(args.nickname); observeLifecycle(args.nickname); await renderDashboardSafely(); return { nickname: args.nickname }; },
      attach_session: async (args, context) => {
        const session = registry.get(args.nickname);
        if (!session) throw new AppError("UNKNOWN_SESSION", `unknown session: ${args.nickname}`);
        let settingsObservationSequence: number | undefined;
        let settingsObservedAt: number | undefined;
        let nativeObservationSequence: number | undefined;
        let resumedSettings: { model?: string; effort?: string | null } | undefined;
        const checkpoint = () => context.checkpoint({
          ...(resumedSettings ? { currentSettings: resumedSettings } : {}),
          ...(settingsObservationSequence === undefined ? {} : { settingsObservationSequence }),
          ...(settingsObservedAt === undefined ? {} : { settingsObservedAt }),
          ...(nativeObservationSequence === undefined ? {} : { nativeObservationSequence }),
        });
        const settings = await lifecycle.attach(args.nickname, {
          onResumed: (currentSettings) => {
            resumedSettings = currentSettings;
            settingsObservationSequence = dashboardStore.allocateObservationSequence();
            settingsObservedAt = Date.now();
            checkpoint();
          },
          onThreadRead: (thread) => {
            nativeObservationSequence = dashboardStore.allocateObservationSequence();
            hydrateThreadOrder(session.endpoint, thread);
            checkpoint();
          },
        });
        advanceNativeWatermark(args.nickname, nativeObservationSequence);
        observeLifecycle(args.nickname);
        observeCurrentSettings(args.nickname, settings, settingsObservedAt, settingsObservationSequence);
        await observations.drain(session.endpoint);
        await renderDashboardSafely();
        return { nickname: args.nickname };
      },
      archive_session: async (args) => { await lifecycle.archive(args.nickname); observeLifecycle(args.nickname); await renderDashboardSafely(); return { nickname: args.nickname }; },
      send_to_session: async (args, context) => {
        const worker = registry.get(args.nickname);
        if (!worker) throw new AppError("UNKNOWN_SESSION", `unknown session: ${args.nickname}`);
        const pendingSettings = args.mode === "start" ? runtime.settings(worker.endpoint, worker.thread_id) : undefined;
        const settingsObservationSequence = pendingSettings && (Object.hasOwn(pendingSettings, "model") || Object.hasOwn(pendingSettings, "effort"))
          ? dashboardStore.allocateObservationSequence()
          : undefined;
        context.checkpoint(args.mode === "steer"
          ? { turnId: sessions.activeTurnId(args.nickname) }
          : { pendingSettings, ...(settingsObservationSequence === undefined ? {} : { settingsObservationSequence }) });
        const files = args.attachment_ids.map((id: any) => attachments.toUserInput(context.sourceContextId, id));
        const input = [...(args.content.length > 0 ? [{ type: "text", text: args.content, text_elements: [] }] : []), ...files];
        const holdId = workerAttachmentHoldId(context.sourceContextId, context.attemptId, context.callId);
        if (args.attachment_ids.length > 0) attachments.retainForOperation(holdId, context.sourceContextId, args.attachment_ids);
        let result: Awaited<ReturnType<SessionService["send"]>>;
        try {
          result = await sessions.send(args.nickname, args.content, {
            mode: args.mode,
            clientUserMessageId: `${context.sourceContextId}:${context.callId}`,
            input,
            ...(pendingSettings ? { settings: pendingSettings } : {}),
          });
        } catch (error) {
          if (isProvenSendNoEffect(error)) attachments.releaseOperation(holdId);
          throw error;
        }
        if (args.attachment_ids.length > 0) {
          if (result.terminal) attachments.releaseOperation(holdId);
          else attachments.transferOperationToTurn(holdId, worker.endpoint, worker.thread_id, result.turnId);
        }
        if (args.attachment_ids.length > 0 && !result.terminal) {
          const history = await pool.request<any>(worker.endpoint, "thread/read", { threadId: worker.thread_id, includeTurns: true });
          const turn = history.thread.turns.find((candidate: any) => candidate.id === result.turnId);
          if (turn && isTerminalStatus(turn.status)) attachments.releaseTurn(worker.endpoint, worker.thread_id, result.turnId);
        }
        observeLastSent(args.nickname, args, result, context.operationSequence);
        advanceNativeWatermark(args.nickname);
        if (result.appliedSettings) observeCurrentSettings(args.nickname, result.appliedSettings, Date.now(), settingsObservationSequence);
        observeLifecycle(args.nickname);
        await renderDashboardSafely();
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
        ? sessions.collect(args.nickname, args.count, {
          direct: true,
          destination: String(config.telegramDestinationChatId),
          deliveryKey: context.sourceContextId,
          onSelected: (messageIds) => context.checkpoint({ messageIds }),
        })
        : sessions.collect(args.nickname, args.count),
      interrupt_session: async (args, context) => {
        const turnId = args.turn_id ?? sessions.activeTurnId(args.nickname);
        context.checkpoint({ turnId });
        await sessions.interrupt(args.nickname, turnId);
        advanceNativeWatermark(args.nickname);
        observeLifecycle(args.nickname);
        await renderDashboardSafely();
        return { interrupted: true, turnId };
      },
      list_models: async (args) => sessions.models(args.endpoint ?? "local"),
      set_session_model: async (args) => { await sessions.setModel(args.nickname, args.model); observeLifecycle(args.nickname); await renderDashboardSafely(); return { pending: true }; },
      set_reasoning_effort: async (args) => { await sessions.setEffort(args.nickname, args.effort); observeLifecycle(args.nickname); await renderDashboardSafely(); return { pending: true }; },
      get_goal: async (args) => {
        const result = await sessions.getGoal(args.nickname);
        observeGoal(args.nickname, result);
        await renderDashboardSafely();
        return result;
      },
      set_goal: async (args) => {
        const result = await sessions.setGoal(args.nickname, args.objective, args.token_budget);
        observeGoal(args.nickname, result);
        await renderDashboardSafely();
        return result;
      },
      pause_goal: async (args) => {
        const result = await sessions.pauseGoal(args.nickname);
        observeGoal(args.nickname, result);
        await renderDashboardSafely();
        return result;
      },
      resume_goal: async (args) => {
        const result = await sessions.resumeGoal(args.nickname);
        observeGoal(args.nickname, result);
        await renderDashboardSafely();
        return result;
      },
      cancel_goal: async (args, context) => {
        if (args.interrupt_active_turn) {
          let turnId: string | null = null;
          try { turnId = sessions.activeTurnId(args.nickname); }
          catch (error) { if (!(error instanceof AppError && error.code === "SESSION_IDLE")) throw error; }
          context.checkpoint({ turnId });
          if (turnId) await sessions.interrupt(args.nickname, turnId);
          if (turnId) advanceNativeWatermark(args.nickname);
        }
        const result = await sessions.cancelGoal(args.nickname);
        observeGoal(args.nickname, result);
        observeLifecycle(args.nickname);
        await renderDashboardSafely();
        return result;
      },
      update_session_notes: async (args, context) => {
        const { nickname, ...patch } = args;
        let result;
        try { result = dashboardStore.updateNotes(dashboardIdentity(nickname), context.operationId, patch, Date.now()); }
        catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError("OPERATION_CONFLICT", "manager note update was not committed");
        }
        await renderDashboardSafely();
        return result;
      },
      send_chat_message: async (args, context) => ({ deliveryId: deliveries.prepare({ id: `chat:${context.sourceContextId}:${context.attemptId}:${context.callId}`, kind: "chat", destination: String(config.telegramDestinationChatId), body: args.content, mandatory: false, replyTo: args.reply_to }).id }),
      prepare_chat_attachment: async (args, context) => {
        const ownerRoot = args.owner === "assistant" ? assistantDir : sessions.managedProjectRoot(args.owner);
        const prepared = await attachments.prepareOutbound(context.sourceContextId, ownerRoot, args.relative_path, undefined, undefined, operationFileHandle(context.sourceContextId, context.attemptId, context.callId));
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

  async function reconcileDashboard(required = false): Promise<void> {
    dashboardStore.markDirty();
    await renderDashboardSafely(required);
  }

  async function renderDashboardSafely(required = false): Promise<void> {
    try { await dashboard.renderIfDirty(); }
    catch (error) {
      queueDashboardWarning();
      if (required) throw error;
    }
  }

  function queueDashboardWarning(): void {
    const state = dashboardStore.renderState();
    if (!state.lastError) return;
    deliveries.prepare({
      id: `dashboard-render-warning:${state.failureGeneration}`,
      kind: "system_warning",
      destination: String(config.telegramDestinationChatId),
      body: "[system] session dashboard rendering failed; durable state is safe and rendering will retry",
      mandatory: true,
    });
  }

  function dashboardIdentity(nickname: string): { endpointId: string; threadId: string } {
    const session = registry.get(nickname);
    if (!session) throw new AppError("UNKNOWN_SESSION", `unknown session: ${nickname}`);
    return { endpointId: session.endpoint, threadId: session.thread_id };
  }

  function observeLifecycle(nickname: string, observedAt = Date.now()): void {
    dashboardStore.observeLifecycle(dashboardIdentity(nickname), observedAt);
  }

  function advanceNativeWatermark(nickname: string, observationSequence = dashboardStore.allocateObservationSequence()): void {
    const identity = dashboardIdentity(nickname);
    const state = runtime.getSession(identity.endpointId, identity.threadId);
    if (!state) return;
    runtime.reconcileNativeState(identity.endpointId, identity.threadId, state.nativeStatus, runtime.activeTurn(identity.endpointId, identity.threadId), observationSequence);
  }

  function observeCurrentSettings(nickname: string, settings: { model?: string; effort?: string | null }, observedAt = Date.now(), observationSequence = dashboardStore.allocateObservationSequence()): void {
    if (!Object.hasOwn(settings, "model") && !Object.hasOwn(settings, "effort")) return;
    dashboardStore.observeCurrentSettings(dashboardIdentity(nickname), { ...settings, observedAt }, observationSequence);
  }

  function observeGoal(nickname: string, response: any, observedAt = Date.now()): void {
    const goal = response && typeof response === "object" && "goal" in response ? response.goal : response;
    const sequence = dashboardStore.allocateObservationSequence();
    if (goal == null) {
      dashboardStore.observeGoal(dashboardIdentity(nickname), null, observedAt, sequence, observedAt);
      return;
    }
    const updatedAt = normalizeAppServerTime(goal.updatedAt, observedAt);
    dashboardStore.observeGoal(dashboardIdentity(nickname), {
      objective: String(goal.objective ?? ""),
      status: String(goal.status ?? "unknown"),
      token_budget: typeof goal.tokenBudget === "number" ? goal.tokenBudget : typeof goal.token_budget === "number" ? goal.token_budget : null,
    }, updatedAt, sequence, updatedAt);
  }

  function hydrateThreadOrder(endpointId: string, thread: { id: string; turns?: Array<{ id: string; startedAt?: number | null }> }): void {
    dashboardStore.hydrateTurnOrder({ endpointId, threadId: thread.id }, (thread.turns ?? []).map((turn) => ({
      id: turn.id,
      startedAt: typeof turn.startedAt === "number" && Number.isFinite(turn.startedAt) ? turn.startedAt : null,
    })));
  }

  function observeLastSent(nickname: string, args: any, result: { mode: "start" | "steer"; turnId: string }, operationSequence: number, observedAt = Date.now()): void {
    dashboardStore.observeLastSent(dashboardIdentity(nickname), {
      text: String(args.content),
      mode: result.mode,
      attachment_ids: [...args.attachment_ids],
      turn_id: result.turnId,
      at: new Date(observedAt).toISOString(),
    }, operationSequence);
  }

  function projectEndpoint(requested?: string): string {
    const endpointId = requested ?? endpoint.id;
    if (endpointId === assistantEndpoint.id) throw new AppError("UNSUPPORTED_CAPABILITY", "the assistant-only endpoint cannot host project sessions");
    return endpointId;
  }

  async function runAssistantJob(job: AssistantJob): Promise<void> {
    const isEventBatch = "events" in job;
    const eventIds = isEventBatch ? job.events.map((event) => event.id) : [];
    const contextId = isEventBatch ? `batch:${eventIds.join(",")}` : String((job.payload as any).contextId);
    if (!schedulerAccepting || stopping || hasOrphanAssistantAttempt()) {
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
    const identity = registry.snapshot().assistant;
    const internalLabel = source.kind === "recovery" ? "Recovery metadata for a previous assistant attempt" : "Project session event metadata";
    const input: any[] = [{ type: "text", text: isInternal ? `${internalLabel}:\n${source.rawText}` : source.rawText, text_elements: [] }];
    if (!isInternal && source.attachmentIds.length > 0) {
      input.push({ type: "text", text: `Backend attachment handles in source order: ${JSON.stringify(source.attachmentIds)}`, text_elements: [] });
      input.push(...source.attachmentIds.map((id) => attachments.toUserInput(contextId, id as any)));
    }
    const attemptId = `attempt_${crypto.randomUUID()}`;
    assistant.prepareAttempt(contextId, attemptId, isInternal ? "internal" : "user");
    try {
      const response = await pool.startTurn<any>(identity.endpoint, { threadId: identity.thread_id, clientUserMessageId: contextId, input });
      const turnId = String(response.turn.id);
      assistant.bindTurn(attemptId, turnId);
      if (stopping || !schedulerAccepting) {
        await pool.interrupt(identity.endpoint, identity.thread_id, turnId).catch(() => undefined);
        throw new AppError("OPERATION_UNCERTAIN", "bot stopped after the assistant turn started and before its terminal state was observed");
      }
      const terminal = new Promise<void>((resolvePromise, rejectPromise) => terminalWaiters.set(turnId, { resolve: resolvePromise, reject: rejectPromise, eventIds }));
      const early = earlyAssistantTerminals.take(turnId);
      if (early) await processAssistantTerminal(early);
      else if (isTerminalStatus(response.turn.status)) await processAssistantTerminal({ threadId: identity.thread_id, turn: response.turn });
      await terminal;
    } catch (error) {
      await reconcileOperations();
      const active = assistant.current();
      if (active?.attemptId === attemptId) terminalWaiters.delete(active.turnId);
      const uncertainTransport = isUncertainAssistantTransportFailure(error, assistantEndpoint.state);
      if (uncertainTransport && active?.attemptId === attemptId) {
        assistant.abandonActive(active.turnId);
        enqueuedSources.delete(contextId);
        for (const id of eventIds) enqueuedEvents.delete(id);
        return;
      }
      const recovery = active?.attemptId === attemptId ? assistant.failAttempt(active.turnId, error) : undefined;
      await requeueFailedContext(contextId, eventIds, recovery);
    }
  }

  async function handleSchedulerFailure(job: AssistantJob, _error: unknown): Promise<void> {
    const eventIds = "events" in job ? job.events.map((event) => event.id) : [];
    const contextId = "events" in job ? `batch:${eventIds.join(",")}` : String((job.payload as any).contextId);
    enqueuedSources.delete(contextId);
    for (const id of eventIds) enqueuedEvents.delete(id);
    recordBackgroundFailure("assistant job before dispatch");
    await requeueFailedContext(contextId, eventIds, undefined);
  }

  async function onNotification(endpointId: string, method: string, params: any): Promise<void> {
    const identity = registry.snapshot().assistant;
    if (endpointId === identity.endpoint && method === "turn/completed" && params.threadId === identity.thread_id) {
      pool.markTurnTerminal(endpointId, identity.thread_id, params.turn.id);
      if (terminalWaiters.has(params.turn.id) || assistant.activeAttempts().some((attempt) => attempt.turnId === params.turn.id)) await processAssistantTerminal(params);
      else earlyAssistantTerminals.publish(params.turn.id, params);
      return;
    }
    await relay.handleNotification(endpointId, method, params);
    await enqueuePendingEvents();
  }

  async function processAssistantTerminal(params: any): Promise<void> {
    const identity = registry.snapshot().assistant;
    const history = await pool.request<any>(identity.endpoint, "thread/read", { threadId: identity.thread_id, includeTurns: true });
    const turn = history.thread.turns.find((candidate: any) => candidate.id === params.turn.id) ?? params.turn;
    const messages = finals.persistTerminalTurn(identity.endpoint, identity.thread_id, turn, Date.now());
    const attempt = assistant.contextForTurn(turn.id);
    let recovery: ReturnType<AssistantRuntime["failAttempt"]>;
    if (turn.status === "completed") {
      assistant.handleTerminal(turn.id, messages.map((message) => message.body).join("\n") || undefined);
      if (attempt) {
        enqueuedSources.delete(attempt.contextId);
      }
    } else {
      await reconcileOperations({ includeActiveAttempt: true });
      recovery = assistant.failAttempt(turn.id, turn.error);
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

  function enqueuePendingEvents(): void {
    if (!schedulerAccepting || stopping || hasOrphanAssistantAttempt()) return;
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

  function enqueuePendingSources(): void {
    if (!schedulerAccepting || stopping || hasOrphanAssistantAttempt()) return;
    for (const source of operations.listPendingSourceContexts(["telegram", "recovery"])) enqueueSource(source.id);
  }

  function enqueueSource(contextId: string): void {
    if (!schedulerAccepting || stopping || hasOrphanAssistantAttempt()) return;
    if (enqueuedSources.has(contextId)) return;
    enqueuedSources.add(contextId);
    scheduler.enqueueUser({ id: contextId, payload: { contextId } });
  }

  async function requeueFailedContext(contextId: string, eventIds: readonly string[], recovery: ReturnType<AssistantRuntime["failAttempt"]>): Promise<void> {
    enqueuedSources.delete(contextId);
    for (const id of eventIds) enqueuedEvents.delete(id);
    if (recovery) {
      if (!stopping) enqueueSource(recovery.id);
      return;
    }
    const retry = setTimeout(() => {
      if (stopping) return;
      if (eventIds.length > 0) enqueuePendingEvents();
      else enqueuePendingSources();
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

  function hasOrphanAssistantAttempt(): boolean {
    return assistant.activeAttempts().length > 0 && assistant.current() === undefined;
  }

  async function startOrResumeAssistant(): Promise<void> {
    const resumed = await resumeAssistantIdentity({
      registry,
      endpoint: assistantEndpoint,
      assistantDir,
      sandboxMode: config.assistantSandboxMode,
      config: assistantTurnConfig(mcp.url, token),
      creationNonce: assistantProfile.creationNonce,
      pendingThreadId: assistantProfile.pendingThreadId,
      recordPendingThread: (threadId) => assistantProfile.recordPendingThread(threadId),
      clearPendingThread: (threadId) => assistantProfile.clearPendingThread(threadId),
    });
    runtime.setSession(assistantEndpoint.id, resumed.threadId, "managed", resumed.nativeStatus);
  }

  async function reconcileAssistantAttempts(): Promise<void> {
    const identity = registry.snapshot().assistant;
    for (const attempt of assistant.activeAttempts()) {
      let turnId = attempt.turnId;
      if (attempt.turnId.startsWith("pending:")) {
        const pendingHistory = await pool.request<any>(identity.endpoint, "thread/read", { threadId: identity.thread_id, includeTurns: true });
        const matched = [...pendingHistory.thread.turns].reverse().find((candidate: any) => candidate.items.some((item: any) => item.type === "userMessage" && item.clientId === attempt.contextId));
        if (matched) {
          assistant.bindTurn(attempt.attemptId, matched.id);
          turnId = matched.id;
        } else if (pendingHistory.thread.status?.type === "idle") {
          await requeueFailedContext(attempt.contextId, [], assistant.failAttempt(attempt.turnId, "restart proved that the unbound turn was never created"));
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
      if (turn && isTerminalStatus(turn.status)) await processAssistantTerminal({ threadId: identity.thread_id, turn });
      // If the exact turn is still not terminal, leave its source and attempt active.
      // A later terminal notification or maintenance pass will reconcile it; rerunning
      // the source now could let the old turn perform effects after the replay starts.
    }
  }

  function reconcileOperations(options: { includeActiveAttempt?: boolean } = {}): Promise<void> {
    const run = operationReconciliationTail.then(
      () => reconcileOperationsOnce(options),
      () => reconcileOperationsOnce(options),
    );
    operationReconciliationTail = run.catch(() => undefined);
    return run;
  }

  async function reconcileOperationsOnce(options: { includeActiveAttempt?: boolean }): Promise<void> {
    const liveAttemptId = assistant.current()?.attemptId;
    for (const operation of operations.listRecoverable()) {
      if (!options.includeActiveAttempt && operation.attemptId === liveAttemptId) continue;
      const args = operation.args as any;
      try {
        if (operation.kind === "update_session_notes") {
          const result = dashboardStore.noteOperationResult(operation.id);
          if (result) await succeedRecovered(operation, result);
          else failRecoveredNoEffect(operation.id, "manager note mutation was not committed");
        } else if (operation.kind === "send_chat_message") {
          const id = `chat:${operation.contextId}:${operation.attemptId}:${operation.callId}`;
          if (deliveries.get(id)) operations.succeed(operation.id, { deliveryId: id });
          else failRecoveredNoEffect(operation.id, "chat delivery intent was not committed");
        } else if (operation.kind === "send_chat_attachment") {
          const id = `chat-attachment:${operation.contextId}:${operation.attemptId}:${operation.callId}`;
          if (deliveries.get(id)) operations.succeed(operation.id, { deliveryId: id });
          else failRecoveredNoEffect(operation.id, "attachment delivery intent was not committed");
        } else if (operation.kind === "prepare_chat_attachment") {
          const id = operationFileHandle(operation.contextId, operation.attemptId, operation.callId);
          let prepared = attachments.get(operation.contextId, id);
          if (!prepared) {
            const ownerRoot = args.owner === "assistant" ? assistantDir : sessions.managedProjectRoot(args.owner);
            prepared = await attachments.prepareOutbound(operation.contextId, ownerRoot, args.relative_path, undefined, undefined, id);
          }
          operations.succeed(operation.id, { file_handle: prepared.id, display_name: prepared.displayName, media_type: prepared.mediaType, size: prepared.size, sha256: prepared.sha256 });
        } else if (operation.kind === "collect_messages") {
          const checkpoint = operation.receipt as { messageIds?: string[] } | undefined;
          const result = Array.isArray(checkpoint?.messageIds)
            ? await sessions.collectSelected(args.nickname, checkpoint.messageIds, { destination: String(config.telegramDestinationChatId), deliveryKey: operation.contextId })
            : await sessions.collect(args.nickname, args.count, {
              direct: true,
              destination: String(config.telegramDestinationChatId),
              deliveryKey: operation.contextId,
              onSelected: (messageIds) => operations.checkpoint(operation.id, { messageIds }),
            });
          operations.succeed(operation.id, { deliveries: result.map((item) => item.deliveryId), count: args.count, nickname: args.nickname });
        } else if (operation.kind === "send_to_session") {
          const session = registry.get(args.nickname);
          if (!session) continue;
          const history = await pool.request<any>(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: true });
          const clientId = `${operation.contextId}:${operation.callId}`;
          const turn = history.thread.turns.find((candidate: any) => candidate.items.some((item: any) => item.type === "userMessage" && item.clientId === clientId));
          const holdId = workerAttachmentHoldId(operation.contextId, operation.attemptId, operation.callId);
          if (turn) {
            if (args.attachment_ids.length > 0) {
              attachments.transferOperationToTurn(holdId, session.endpoint, session.thread_id, turn.id);
              attachments.retainForTurn(session.endpoint, session.thread_id, turn.id, operation.contextId, args.attachment_ids);
              if (isTerminalStatus(turn.status)) attachments.releaseTurn(session.endpoint, session.thread_id, turn.id);
            }
            const checkpoint = operation.receipt as { pendingSettings?: { model?: string; effort?: string }; settingsObservationSequence?: number } | undefined;
            const appliedSettings = args.mode === "start" && checkpoint && Object.hasOwn(checkpoint, "pendingSettings") ? checkpoint.pendingSettings ?? {} : undefined;
            if (appliedSettings) runtime.consumeSettings(session.endpoint, session.thread_id, appliedSettings);
            const receipt = { nickname: args.nickname, mode: args.mode, turnId: turn.id, terminal: isTerminalStatus(turn.status), ...(appliedSettings ? { appliedSettings } : {}) };
            await succeedRecovered(operation, receipt, () => {
              observeLastSent(args.nickname, args, { mode: args.mode, turnId: turn.id }, operation.sequence);
              if (appliedSettings) observeCurrentSettings(args.nickname, appliedSettings, operation.createdAt, checkpoint?.settingsObservationSequence);
              advanceNativeWatermark(args.nickname);
              observeLifecycle(args.nickname);
            });
          } else if (args.mode === "start" && history.thread.status?.type === "idle") {
            attachments.releaseOperation(holdId);
            operations.failAndUnbind(operation.id, { message: "thread history proves the requested start did not create a turn" });
          } else if (args.mode === "steer") {
            const targetTurnId = (operation.receipt as { turnId?: string } | undefined)?.turnId;
            const target = targetTurnId ? history.thread.turns.find((candidate: any) => candidate.id === targetTurnId) : undefined;
            if (target && isTerminalStatus(target.status)) {
              attachments.releaseOperation(holdId);
              operations.failAndUnbind(operation.id, { message: "terminal target history proves the requested steer was not appended" });
            }
          }
        } else if (operation.kind === "set_session_model" || operation.kind === "set_reasoning_effort") {
          const session = registry.get(args.nickname);
          const settings = session ? runtime.settings(session.endpoint, session.thread_id) : {};
          const proven = operation.kind === "set_session_model" ? settings.model === args.model : settings.effort === args.effort;
          if (proven) await succeedRecovered(operation, { pending: true }, () => observeLifecycle(args.nickname, operation.createdAt));
          else failRecoveredNoEffect(operation.id, "pending session setting was not committed");
        } else if (["create_session", "register_session", "adopt_session"].includes(operation.kind)) {
          let session = registry.get(args.nickname);
          const checkpoint = operation.receipt as ({ endpoint?: string; threadId?: string; dispatchStarted?: boolean } & Record<string, unknown>) | undefined;
          const project = checkpoint ? preparedProjectWorkspaceFromCheckpoint(checkpoint) : undefined;
          if (project) await projectWorkspaces.assertDispatchable(project);
          const expectedThread = args.thread_id as string | undefined ?? (operation.kind === "create_session" ? checkpoint?.threadId : undefined);
          const expectedDir = project?.path;
          if (!session && operation.kind === "create_session" && checkpoint?.dispatchStarted === false) {
            failRecoveredNoEffect(operation.id, "project workspace was prepared before worker dispatch began");
            continue;
          }
          if (!session && operation.kind === "create_session" && checkpoint?.dispatchStarted === true && !checkpoint.threadId && project) {
            const endpointId = projectEndpoint(checkpoint.endpoint ?? args.endpoint);
            const candidates = (await discovery.list({ endpointId, cwd: project.path, limit: 100 })).sessions
              .filter((candidate) => candidate.threadSource === operation.id && !candidate.archived);
            if (candidates.length === 0) {
              failRecoveredNoEffect(operation.id, "worker discovery proved the requested thread was not created");
              continue;
            }
            if (candidates.length !== 1) continue;
            checkpoint.threadId = candidates[0]!.id;
            operations.checkpoint(operation.id, checkpoint);
          }
          if (!session && operation.kind === "create_session" && checkpoint?.threadId && project) {
            const endpointId = projectEndpoint(checkpoint.endpoint ?? args.endpoint);
            await lifecycle.adopt(args.nickname, endpointId, checkpoint.threadId, project, (thread) => {
              if (thread.threadSource !== operation.id) throw new AppError("OPERATION_UNCERTAIN", "recovered worker thread has the wrong creation source");
              hydrateThreadOrder(endpointId, thread);
            });
            session = registry.get(args.nickname);
          }
          if (session && (!expectedThread || session.thread_id === expectedThread) && (!expectedDir || session.project_dir === expectedDir)) {
            const native = await pool.request<any>(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: true });
            await verifySessionCwd(native.thread.cwd, session.project_dir);
            hydrateThreadOrder(session.endpoint, native.thread);
            if (!runtime.getSession(session.endpoint, session.thread_id) && native.thread.status?.type === "idle") {
              runtime.setSession(session.endpoint, session.thread_id, "managed", "idle");
              runtime.beginEpoch(session.endpoint, session.thread_id, native.thread.turns?.at(-1)?.id, Date.now());
            }
            await succeedRecovered(operation, { nickname: args.nickname }, () => {
              advanceNativeWatermark(args.nickname);
              observeLifecycle(args.nickname);
              const currentSettings = (checkpoint as any)?.currentSettings;
              if (currentSettings) observeCurrentSettings(args.nickname, currentSettings, operation.createdAt, (checkpoint as any)?.settingsObservationSequence);
            });
          } else if (!session && operation.kind !== "create_session") {
            failRecoveredNoEffect(operation.id, "atomic session registry mapping was not committed");
          }
        } else if (operation.kind === "rename_session") {
          if (!registry.get(args.old_nickname) && registry.get(args.new_nickname)) await succeedRecovered(operation, { nickname: args.new_nickname }, () => dashboardStore.markDirty());
          else if (registry.get(args.old_nickname) && !registry.get(args.new_nickname)) failRecoveredNoEffect(operation.id, "atomic nickname replacement was not committed");
        } else if (["detach_session", "attach_session"].includes(operation.kind)) {
          const session = registry.get(args.nickname);
          const saved = operation.receipt as {
            currentSettings?: { model?: string; effort?: string | null };
            settingsObservationSequence?: number;
            settingsObservedAt?: number;
            nativeObservationSequence?: number;
          } | undefined;
          let currentSettings = saved?.currentSettings;
          let settingsObservationSequence = saved?.settingsObservationSequence;
          let settingsObservedAt = saved?.settingsObservedAt;
          let nativeObservationSequence = saved?.nativeObservationSequence;
          const checkpointAttach = () => operations.checkpoint(operation.id, {
            ...(currentSettings ? { currentSettings } : {}),
            ...(settingsObservationSequence === undefined ? {} : { settingsObservationSequence }),
            ...(settingsObservedAt === undefined ? {} : { settingsObservedAt }),
            ...(nativeObservationSequence === undefined ? {} : { nativeObservationSequence }),
          });
          let state = session ? runtime.getSession(session.endpoint, session.thread_id)?.managementState : undefined;
          if (state === "detaching" || state === "attaching") {
            await lifecycle.reconcileStartup({ endpointId: session!.endpoint, threadId: session!.thread_id }, operation.kind === "attach_session" ? {
              onResumed: (settings) => {
                currentSettings = settings;
                settingsObservationSequence = dashboardStore.allocateObservationSequence();
                settingsObservedAt = Date.now();
                checkpointAttach();
              },
              onThreadRead: (thread) => {
                nativeObservationSequence = dashboardStore.allocateObservationSequence();
                hydrateThreadOrder(session!.endpoint, thread);
                checkpointAttach();
              },
            } : {});
            state = session ? runtime.getSession(session.endpoint, session.thread_id)?.managementState : undefined;
          }
          const expected = operation.kind === "detach_session" ? "detached" : "managed";
          if (state === expected && expected === "managed") {
            advanceNativeWatermark(args.nickname, nativeObservationSequence);
            if (currentSettings) observeCurrentSettings(args.nickname, currentSettings, settingsObservedAt ?? operation.createdAt, settingsObservationSequence);
            observeLifecycle(args.nickname);
            await observations.drain(session!.endpoint);
            await succeedRecovered(operation, { nickname: args.nickname });
          } else if (state === expected) {
            await succeedRecovered(operation, { nickname: args.nickname }, () => observeLifecycle(args.nickname));
          }
          else if ((operation.kind === "detach_session" && state === "managed") || (operation.kind === "attach_session" && state === "detached")) {
            failRecoveredNoEffect(operation.id, `durable ${operation.kind === "detach_session" ? "detaching" : "attaching"} marker was not committed`);
          }
        } else if (operation.kind === "archive_session") {
          const session = registry.get(args.nickname);
          if (!session) continue;
          let state = runtime.getSession(session.endpoint, session.thread_id)?.managementState;
          let discovered: { archived: boolean } | undefined;
          if (state !== "archived") {
            discovered = (await discovery.list({ endpointId: session.endpoint, cwd: session.project_dir, search: session.thread_id, limit: 1 })).sessions.find((candidate) => candidate.id === session.thread_id);
            if (discovered?.archived) {
              runtime.endEpoch(session.endpoint, session.thread_id, Date.now());
              runtime.setSession(session.endpoint, session.thread_id, "archived", "notLoaded");
              state = "archived";
            }
          }
          if (state === "archived") await succeedRecovered(operation, { nickname: args.nickname }, () => observeLifecycle(args.nickname));
          else if (discovered && !discovered.archived) failRecoveredNoEffect(operation.id, "thread archive was not committed");
        } else if (["set_goal", "pause_goal", "resume_goal", "cancel_goal"].includes(operation.kind)) {
          const current = await sessions.getGoal(args.nickname) as any;
          const goal = current?.goal;
          const actualBudget = goal?.tokenBudget ?? goal?.token_budget ?? null;
          let cancelInterruptProven = true;
          if (operation.kind === "cancel_goal" && args.interrupt_active_turn) {
            const checkpoint = operation.receipt as { turnId?: string | null } | undefined;
            cancelInterruptProven = checkpoint !== undefined && checkpoint.turnId === null;
            if (checkpoint?.turnId) {
              const session = registry.get(args.nickname);
              if (session) {
                const history = await pool.request<any>(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: true });
                cancelInterruptProven = history.thread.turns.some((turn: any) => turn.id === checkpoint.turnId && isTerminalStatus(turn.status));
              }
            }
          }
          const proven = operation.kind === "set_goal" ? goal?.objective === args.objective && goal?.status === "active" && actualBudget === (args.token_budget ?? null)
            : operation.kind === "pause_goal" ? goal?.status === "paused"
              : operation.kind === "resume_goal" ? goal?.status === "active"
                : goal == null && cancelInterruptProven;
          if (proven) await succeedRecovered(operation, current, () => {
            observeGoal(args.nickname, current);
            if (operation.kind === "cancel_goal") observeLifecycle(args.nickname);
          });
        } else if (operation.kind === "interrupt_session") {
          const session = registry.get(args.nickname);
          if (!session) continue;
          const turnId = args.turn_id ?? (operation.receipt as { turnId?: string } | undefined)?.turnId;
          if (!turnId) continue;
          const history = await pool.request<any>(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: true });
          const turn = history.thread.turns.find((candidate: any) => candidate.id === turnId);
          if (turn && isTerminalStatus(turn.status)) await succeedRecovered(operation, { interrupted: true, turnId }, () => {
            advanceNativeWatermark(args.nickname);
            observeLifecycle(args.nickname);
          });
        }
      } catch {
        // Leave the operation uncertain unless authoritative state proves its exact outcome.
      }
    }
  }

  function projectWorkspaceReceipt(project: PreparedProjectWorkspace): Record<string, unknown> {
    return {
      projectDir: project.path,
      projectDirCreated: project.created,
      projectDirFallback: project.fallback,
      projectDirDevice: project.identity.device,
      projectDirInode: project.identity.inode,
    };
  }

  async function resumeManagedSessions(): Promise<void> {
    for (const session of Object.values(registry.snapshot().sessions)) {
      if (session.endpoint !== endpoint.id) continue;
      const state = runtime.getSession(session.endpoint, session.thread_id);
      if (state?.managementState === "managed") {
        runtime.setSession(session.endpoint, session.thread_id, "unavailable", state.nativeStatus);
      }
    }
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
        dashboardStore.observeLifecycle({ endpointId: session.endpoint, threadId: session.thread_id }, Date.now());
        warnSessionUnavailable(nickname, session.endpoint, session.thread_id);
        continue;
      }
      if (state.managementState === "unavailable" && state.restoreState !== "managed") continue;
      if (state.managementState !== "managed" && state.managementState !== "unavailable") continue;
      try {
        const project = await projectWorkspaces.prepareExisting(session.project_dir);
        await projectWorkspaces.assertDispatchable(project);
        const response = await endpoint.request<any>(
          "thread/resume",
          workerThreadResumeParams(session.thread_id, project.path),
        );
        const resumeObservationSequence = dashboardStore.allocateObservationSequence();
        await verifySessionCwd(response.thread.cwd, session.project_dir);
        const authoritative = await endpoint.request<any>("thread/read", { threadId: session.thread_id, includeTurns: true });
        const nativeObservationSequence = dashboardStore.allocateObservationSequence();
        hydrateThreadOrder(session.endpoint, authoritative.thread);
        const nativeStatus = authoritative.thread.status?.type ?? response.thread.status?.type ?? "idle";
        runtime.setSession(session.endpoint, session.thread_id, "managed", state.nativeStatus);
        observations.observeResume(session.endpoint, session.thread_id, { ...response, thread: authoritative.thread }, Date.now(), {
          settings: resumeObservationSequence,
          native: nativeObservationSequence,
        });
        dashboardStore.observeLifecycle({ endpointId: session.endpoint, threadId: session.thread_id }, Date.now());
        if (!runtime.currentEpoch(session.endpoint, session.thread_id)) {
          const baseline = [...(authoritative.thread.turns ?? [])].reverse().find((turn: any) => isTerminalStatus(turn.status))?.id;
          runtime.beginEpoch(session.endpoint, session.thread_id, baseline, Date.now());
        }
      } catch {
        runtime.setSession(session.endpoint, session.thread_id, "unavailable", "notLoaded");
        dashboardStore.observeLifecycle({ endpointId: session.endpoint, threadId: session.thread_id }, Date.now());
        warnSessionUnavailable(nickname, session.endpoint, session.thread_id);
      }
    }
  }

  async function handleEndpointUnavailable(target: LocalEndpoint): Promise<void> {
    if (stopping || !endpointsCommitted) return;
    endpointIncident += 1;
    acceptingReadyEvents = false;
    pool.markEndpointUnavailable(target.id);
    for (const session of runtime.listSessions()) {
      if (session.endpointId === target.id && session.managementState === "managed") {
        runtime.setSession(session.endpointId, session.threadId, "unavailable", "notLoaded");
        dashboardStore.observeLifecycle({ endpointId: session.endpointId, threadId: session.threadId }, Date.now());
      }
    }
    if (target.id === assistantEndpoint.id) {
      schedulerAccepting = false;
      for (const [turnId, waiter] of terminalWaiters) {
        terminalWaiters.delete(turnId);
        waiter.reject(new AppError("ENDPOINT_UNAVAILABLE", "assistant app-server became unavailable"));
      }
    }
    const identity = registry.snapshot().assistant;
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
    await renderDashboardSafely();
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
    if (target.id === endpoint.id) {
      await target.start();
      await resumeManagedSessions();
      await observations.drain(endpoint.id);
      await relay.reconcileEndpoint(endpoint.id);
      await reconcileOperations();
      await renderDashboardSafely();
    } else {
      try {
        await startAuthenticatedAssistantEndpoint(assistantEndpoint, assistantProfile);
      } catch (error) {
        if (error instanceof AppError && error.details?.reason === "assistant_auth_required") {
          recordAssistantAuthenticationFailure(deliveries, String(config.telegramDestinationChatId), endpointIncident);
        }
        throw error;
      }
      await startOrResumeAssistant();
      await reconcileOperations();
      await reconcileAssistantAttempts();
      schedulerAccepting = true;
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

  function persistDeliveryState(delivery: DeliveryRecord, schedule = true): boolean {
    const inserted = persistDeliveryStateEvent(db, delivery);
    if (inserted && schedule && schedulerAccepting) enqueuePendingEvents();
    return inserted;
  }

  function reconcileDeliveryEvents(): void {
    if (reconcileDeliveryStateEvents(db, deliveries) > 0 && schedulerAccepting) enqueuePendingEvents();
  }

  function failRecoveredNoEffect(operationId: string, message: string): void {
    operations.failAndUnbind(operationId, { message });
  }

  async function succeedRecovered(operation: { id: string }, receipt: unknown, project?: () => void): Promise<void> {
    project?.();
    operations.succeed(operation.id, receipt);
    await renderDashboardSafely();
  }

  function recordBackgroundFailure(label: string): void {
    try {
      backgroundIncident += 1;
      const id = `background-failure:${backgroundIncident}`;
      deliveries.prepare({ id, kind: "system_warning", destination: String(config.telegramDestinationChatId), body: `[system] ${label} failed; durable reconciliation will retry`, mandatory: true });
      const identity = registry.snapshot().assistant;
      db.prepare(`INSERT OR IGNORE INTO events(id, endpoint_id, thread_id, kind, payload_json, state, created_at)
        VALUES (?, ?, ?, 'background_failure', ?, 'pending', ?)`)
        .run(id, identity.endpoint, identity.thread_id, JSON.stringify({ label, incident: backgroundIncident }), Date.now());
      if (schedulerAccepting) enqueuePendingEvents();
    } catch { /* containment path cannot safely escalate */ }
  }

  return composeApp(phases, { maintenance: { intervalMs: 60_000, run: runMaintenance } });

  async function runMaintenance(): Promise<void> {
    await attachments.cleanupExpired();
    discovery.cleanupExpired();
    reconcileDeliveryEvents();
    await reconcileOperations();
    await observations.drain(endpoint.id);
    if (endpoint.state === "ready") {
      try { await relay.reconcileEndpoint(endpoint.id); }
      catch { recordBackgroundFailure("periodic project reconciliation"); }
    }
    await renderDashboardSafely();
    if (assistantEndpoint.state === "ready") {
      await reconcileAssistantAttempts();
      if (!hasOrphanAssistantAttempt()) {
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
    await reconcileDashboard();
  }

  async function validateRegistryDocument(document: RegistryDocument): Promise<void> {
    const currentAssistant = registry.snapshot().assistant;
    if (document.assistant.endpoint !== currentAssistant.endpoint || document.assistant.thread_id !== currentAssistant.thread_id || document.assistant.project_dir !== currentAssistant.project_dir) {
      throw new Error("the live assistant mapping cannot be externally repointed");
    }
    for (const session of Object.values(document.sessions)) {
      if (session.endpoint !== endpoint.id) throw new Error(`unknown endpoint: ${session.endpoint}`);
      const project = await projectWorkspaces.prepareExisting(session.project_dir);
      await projectWorkspaces.assertDispatchable(project);
      const response = await endpoint.request<any>("thread/read", { threadId: session.thread_id, includeTurns: false });
      await verifySessionCwd(response.thread.cwd, session.project_dir);
    }
  }

  async function initializeNewRegistryMappings(): Promise<void> {
    for (const [nickname, session] of Object.entries(registry.snapshot().sessions)) {
      if (runtime.getSession(session.endpoint, session.thread_id)) continue;
      const project = await projectWorkspaces.prepareExisting(session.project_dir);
      await projectWorkspaces.assertDispatchable(project);
      const response = await endpoint.request<any>("thread/read", { threadId: session.thread_id, includeTurns: false });
      runtime.setSession(session.endpoint, session.thread_id, "unavailable", response.thread.status?.type ?? "notLoaded");
      dashboardStore.observeLifecycle({ endpointId: session.endpoint, threadId: session.thread_id }, Date.now());
      warnSessionUnavailable(nickname, session.endpoint, session.thread_id);
    }
  }
}

export function isUncertainAssistantTransportFailure(error: unknown, endpointState: LocalEndpoint["state"]): boolean {
  return endpointState !== "ready" || (error instanceof AppError && new Set(["ENDPOINT_UNAVAILABLE", "OPERATION_UNCERTAIN"]).has(error.code));
}

function operationFileHandle(contextId: string, attemptId: string, callId: string): FileHandleId {
  return `file_${createHash("sha256").update(`${contextId}\0${attemptId}\0${callId}`).digest("hex")}`;
}

function workerAttachmentHoldId(contextId: string, attemptId: string, callId: string): string {
  return `worker-send:${createHash("sha256").update(`${contextId}\0${attemptId}\0${callId}`).digest("hex")}`;
}

function isProvenSendNoEffect(error: unknown): boolean {
  return error instanceof AppError && new Set(["UNKNOWN_SESSION", "SESSION_DETACHED", "SESSION_BUSY", "SESSION_IDLE", "OPERATION_CONFLICT", "CAPACITY_EXCEEDED"]).has(error.code);
}

function normalizeAppServerTime(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.abs(value) < 1_000_000_000_000 ? value * 1_000 : value;
}
