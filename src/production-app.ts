import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { AttachmentStore, type FileHandleId } from "./attachments/store.ts";
import type { ChatAdapter } from "./chat/contracts.ts";
import type { ConversationBinding, JsonValue } from "./chat/binding.ts";
import { ChatAdapterRegistry } from "./chat/adapter-registry.ts";
import { OwnerRouteStore } from "./chat/owner-route-store.ts";
import type { ChatHistoryRequest } from "./chat/contracts.ts";
import { DeliveryWorker } from "./chat/delivery-worker.ts";
import { LocalEndpoint } from "./app-server/local-endpoint.ts";
import { AppServerPool } from "./app-server/pool.ts";
import { SUPPORTED_CODEX_VERSION } from "./app-server/protocol.ts";
import { composeApp, type AppPhase, type BotApp } from "./app.ts";
import type { BotConfig } from "./config.ts";
import { AppError } from "./core/errors.ts";
import { runBackground } from "./core/background.ts";
import { SessionDashboard } from "./assistant/session-dashboard.ts";
import { activateAssistantProfileIdentity, resumeAssistantIdentity } from "./assistant/identity.ts";
import { recordAssistantAuthenticationFailure } from "./assistant/auth-recovery.ts";
import { buildAssistantChildEnvironment, prepareAssistantProfile, startAuthenticatedAssistantEndpoint, type PreparedAssistantProfile } from "./assistant/profile.ts";
import { AssistantRuntime } from "./assistant/runtime.ts";
import { AssistantScheduler } from "./assistant/scheduler.ts";
import { ConversationDispatcher, type AssistantTurnPort } from "./assistant/conversation-dispatcher.ts";
import { AttemptScope } from "./assistant/attempt-scope.ts";
import { SessionObservationProcessor } from "./assistant/session-observer.ts";
import { createAssistantTools, type AssistantToolName } from "./assistant/tools.ts";
import { prepareAssistantWorkspace } from "./assistant/workspace.ts";
import { EventRelay } from "./events/relay.ts";
import { persistDeliveryStateEvent, reconcileDeliveryStateEvents } from "./events/delivery-status.ts";
import { buildWorkerChildEnvironment, assistantTurnConfig, LoopbackMcpServer, ToolReadinessGate } from "./mcp/server.ts";
import { SessionRegistry, type RegistryDocument, type RegistrySession } from "./registry/session-registry.ts";
import { SessionDiscovery } from "./sessions/discovery.ts";
import { FinalMessageStore } from "./sessions/final-messages.ts";
import { SessionLifecycle } from "./sessions/lifecycle.ts";
import { preparedProjectWorkspaceFromCheckpoint, ProjectWorkspacePolicy, type PreparedProjectWorkspace } from "./sessions/project-workspace.ts";
import { SessionService } from "./sessions/service.ts";
import { ThreadGate } from "./sessions/thread-gate.ts";
import { openDatabase, type Database } from "./storage/database.ts";
import { DeliveryStore, type DeliveryRecord } from "./storage/delivery-store.ts";
import { ConversationStore } from "./storage/conversation-store.ts";
import { finalizeConversationCutover, runConversationRoutingBackfill } from "./storage/conversation-cutover.ts";
import { OperationStore } from "./storage/operation-store.ts";
import { RuntimeStore } from "./storage/runtime-store.ts";
import { SessionDashboardStore } from "./storage/session-dashboard-store.ts";
import { TelegramChatAdapter } from "./telegram/chat-adapter.ts";
import type { SlackContextService } from "./slack/context-service.ts";

const assistantAssetRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/assistant");
const fullAccessWarning = "QiYan assistant is running non-interactively with full filesystem access and approvals disabled.";
const assistantMappingId = "assistant";

export function assistantAccessWarning(mode: BotConfig["assistantSandboxMode"]): string | undefined {
  return mode === "danger-full-access" ? fullAccessWarning : undefined;
}

export type RemovalRecoveryDecision = "pending" | "no_effect" | "reconcile" | "succeeded";

export function removalRecoveryDecision(
  operationKind: "unadopt_session" | "archive_session",
  saved: (Partial<RegistrySession> & { step?: string }) | undefined,
  current: RegistrySession | undefined,
): RemovalRecoveryDecision {
  if (!saved?.endpoint || !saved.thread_id || !saved.project_dir || !saved.mapping_id) return "no_effect";
  const targetState = operationKind === "unadopt_session" ? "unadopting" : "archiving";
  const sameGeneration = current?.mapping_id === saved.mapping_id
    && current.endpoint === saved.endpoint && current.thread_id === saved.thread_id;
  const enteredTransition = saved.lifecycle_state === targetState && saved.step !== undefined && saved.step !== "prepared";
  if (!enteredTransition) {
    if (sameGeneration && current?.lifecycle_state === targetState) return "reconcile";
    return "no_effect";
  }
  if (!sameGeneration) return "succeeded";
  if (current?.lifecycle_state === targetState) return "reconcile";
  if (current?.lifecycle_state === "managed") return "no_effect";
  return "pending";
}

export function registryReloadPreservesWorkerMappings(current: RegistryDocument, candidate: RegistryDocument): boolean {
  return isDeepStrictEqual(current.sessions, candidate.sessions);
}

export async function buildProductionApp(
  config: BotConfig,
  options: { chdir?: (path: string) => void } = {},
): Promise<BotApp> {
  const telegramConfig = config.chat.telegram;
  if (!telegramConfig) throw new AppError("UNSUPPORTED_CAPABILITY", "Slack production composition is not available yet");
  const token = randomBytes(32).toString("base64url");
  const administrativeBinding: ConversationBinding = {
    adapterId: "telegram",
    conversationKey: `telegram:${telegramConfig.destinationChatId}`,
    destination: { chatId: String(telegramConfig.destinationChatId) },
  };

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
  let threadGate!: ThreadGate;
  let projectWorkspaces!: ProjectWorkspacePolicy;
  let sessions!: SessionService;
  let relay!: EventRelay;
  let assistant!: AssistantRuntime;
  let conversations!: ConversationStore;
  let ownerRoutes!: OwnerRouteStore;
  let attemptScope!: AttemptScope;
  let dispatcher!: ConversationDispatcher;
  let scheduler!: AssistantScheduler;
  let mcp!: LoopbackMcpServer;
  let chat!: ChatAdapter;
  let chatRegistry!: ChatAdapterRegistry;
  let slackContextService: SlackContextService | undefined;
  let deliveryWorker!: DeliveryWorker;
  let acceptingReadyEvents = false;
  let schedulerAccepting = false;
  const unsubscribers: Array<() => void> = [];
  const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reconnectAttempts = new Map<string, number>();
  const terminalProcessing = new Map<string, Promise<void>>();
  const assistantToolReadiness = new ToolReadinessGate();
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
        runConversationRoutingBackfill(db, administrativeBinding);
        ownerRoutes = new OwnerRouteStore(db, administrativeBinding);
      },
      stop: async () => { db.close(); },
    },
    {
      name: "registry",
      start: async () => {
        registry = await SessionRegistry.open(registryPath, {
          version: 3,
          assistant: { endpoint: "assistant-local", thread_id: "pending", project_dir: assistantDir },
          sessions: {},
        });
        for (const [index, warning] of registry.warnings().entries()) {
          deliveries.prepare({ id: `registry-startup-warning:${index}`, kind: "system_warning", binding: currentOwnerBinding(), body: `[system] ${warning}`, mandatory: true });
        }
        for (const [index, warning] of assistantWarnings.entries()) {
          deliveries.prepare({ id: `assistant-workspace-warning:${index}`, kind: "system_warning", binding: currentOwnerBinding(), body: `[system] ${warning}`, mandatory: true });
        }
        const accessWarning = assistantAccessWarning(config.assistantSandboxMode);
        if (accessWarning) {
          deliveries.prepare({
            id: "assistant-full-access-warning",
            kind: "system_warning",
            binding: currentOwnerBinding(),
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
        conversations = new ConversationStore(db, deliveries, attachments);
        attemptScope = new AttemptScope(db, operations, { maxCollectCount: config.maxCollectCount, attachments });
        assistant = new AssistantRuntime(db, operations, deliveries, { binding: currentOwnerBinding });
        const actions = buildActions();
        const tools = createAssistantTools(operations, actions, { maxCollectCount: config.maxCollectCount, attemptScope });
        mcp = new LoopbackMcpServer(tools, assistant, {
          host: config.mcpHost,
          port: config.mcpPort,
          token,
          allowedClientProcess: () => assistantEndpoint?.mcpClientIdentity,
          beforeToolCall: () => assistantToolReadiness.wait(),
        });
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
        const durableLease = conversations.lease();
        if (durableLease) {
          const identity = registry.snapshot().assistant;
          pool.restoreTurnCapacityClaim(identity.endpoint, identity.thread_id, durableLease.capacityClaimId, {
            phase: durableLease.turnId ? "active" : "provisional",
            ...(durableLease.turnId ? { turnId: durableLease.turnId } : {}),
          });
          assistant.hydrateActive();
        }
        discovery = new SessionDiscovery(db, pool);
        threadGate = new ThreadGate();
        lifecycle = new SessionLifecycle(pool, registry, runtime, { now: () => Date.now() }, projectWorkspaces, threadGate);
        sessions = new SessionService(pool, registry, runtime, finals, deliveries, projectWorkspaces, threadGate);
        observations = new SessionObservationProcessor(dashboardStore, registry, runtime, {
          now: () => Date.now(),
          readThread: async (endpointId, threadId) => (await pool.request<any>(endpointId, "thread/read", { threadId, includeTurns: true })).thread,
          readGoal: (endpointId, threadId) => pool.request(endpointId, "thread/goal/get", { threadId }),
          onChanged: () => runBackground(() => renderDashboardSafely(), () => recordBackgroundFailure("dashboard rendering")),
          onError: () => recordBackgroundFailure("session observation"),
        });
        relay = new EventRelay(db, pool, registry, runtime, finals, deliveries, {
          binding: currentOwnerBinding,
          clock: { now: () => Date.now() },
          onTerminal: (event) => observations.observeTerminal(event),
        }, attachments);
        scheduler = new AssistantScheduler();
        unsubscribers.push(endpoint.onNotification((method, params) => {
          if (!observations.accept(endpoint.id, method, params)) runBackground(() => onNotification(endpoint.id, method, params), () => recordBackgroundFailure("project notification"));
        }));
        unsubscribers.push(assistantEndpoint.onNotification((method, params) => runBackground(() => onNotification(assistantEndpoint.id, method, params), () => recordBackgroundFailure("assistant notification"))));
        unsubscribers.push(endpoint.onPermissionBlocked((event) => runBackground(async () => {
          await relay.handlePermissionBlocked(endpoint.id, event);
          const mapping = event.threadId ? registry.getByIdentity(endpoint.id, event.threadId) : undefined;
          if (event.threadId && mapping && runtime.getSession(endpoint.id, event.threadId, mapping.session.mapping_id)?.managementState === "managed") {
            const state = runtime.getSession(endpoint.id, event.threadId, mapping.session.mapping_id)!;
            runtime.reconcileNativeState(endpoint.id, event.threadId, mapping.session.mapping_id, state.nativeStatus, runtime.activeTurn(endpoint.id, event.threadId, mapping.session.mapping_id), dashboardStore.allocateObservationSequence());
            dashboardStore.observeLifecycle({ endpointId: endpoint.id, threadId: event.threadId }, Date.now());
            await renderDashboardSafely();
          }
          enqueuePendingEvents();
        }, () => recordBackgroundFailure("permission notification"))));
        unsubscribers.push(endpoint.onReady(() => { if (acceptingReadyEvents) runBackground(() => relay.reconcileEndpoint(endpoint.id), () => recordBackgroundFailure("project ready reconciliation")); }));
        unsubscribers.push(endpoint.onUnavailable(() => runBackground(() => handleEndpointUnavailable(endpoint), () => recordBackgroundFailure("project unavailable handling"))));
        unsubscribers.push(assistantEndpoint.onUnavailable(() => {
          assistantToolReadiness.block();
          runBackground(() => handleEndpointUnavailable(assistantEndpoint), () => recordBackgroundFailure("assistant unavailable handling"));
        }));
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
      start: async () => { acceptingReadyEvents = false; },
      stop: async () => { acceptingReadyEvents = false; await observations.idle(); await renderDashboardSafely(); },
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
        const identity = registry.snapshot().assistant;
        const assistantHistory = await pool.request<any>(identity.endpoint, "thread/read", { threadId: identity.thread_id, includeTurns: true });
        finalizeConversationCutover(db, {
          threadId: identity.thread_id,
          turns: (assistantHistory.thread.turns ?? []).map((turn: any) => ({
            id: String(turn.id),
            status: String(turn.status),
            itemsView: turn.itemsView ?? "notLoaded",
            items: turn.items ?? [],
          })),
        });
        const runner: AssistantTurnPort = {
          start: (params, claim) => pool.startTurn(identity.endpoint, { ...params }, claim),
          steer: (params) => pool.request(identity.endpoint, "turn/steer", params),
          readThread: async () => (await pool.request<any>(identity.endpoint, "thread/read", { threadId: identity.thread_id, includeTurns: true })).thread,
        };
        dispatcher = new ConversationDispatcher(conversations, pool, runner, {
          endpointId: identity.endpoint,
          threadId: identity.thread_id,
          attachments,
          membershipObserver: attemptScope,
          runtimeObserver: assistant,
          scheduler,
          onDeferredTerminal: (turn) => runBackground(
            () => processAssistantTerminal({ threadId: identity.thread_id, turn }),
            () => recordBackgroundFailure("deferred assistant terminal"),
          ),
        });
        await dispatcher.recover();
        await dispatcher.idle();
        assistant.hydrateActive();
        await reconcileOperations();
        conversations.repairQueueNotices();
        await lifecycle.reconcileAdopting();
        await lifecycle.reconcileRemovals();
        await resumeManagedSessions();
        await observations.drain(endpoint.id);
        await relay.reconcileEndpoint(endpoint.id);
        deliveries.recoverAfterCrash();
        reconcileDeliveryEvents();
        acceptingReadyEvents = true;
        assistantToolReadiness.ready();
      }, stop: async () => undefined,
    },
    {
      name: "scheduler",
      start: async () => { schedulerAccepting = true; await enqueuePendingEvents(); await dispatcher.enqueueInternal("startup"); },
      stop: async () => {
        stopping = true;
        assistantToolReadiness.stop();
        schedulerAccepting = false;
        const active = assistant.current();
        if (active && !active.turnId.startsWith("pending:")) {
          assistant.beginTerminalizing(active.turnId);
          await assistant.fenceTools(active.attemptId, 1_000);
          let interruptTimer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            pool.interrupt(assistantEndpoint.id, registry.snapshot().assistant.thread_id, active.turnId).catch(() => undefined),
            new Promise<void>((resolve) => { interruptTimer = setTimeout(resolve, 1_000); }),
          ]);
          if (interruptTimer) clearTimeout(interruptTimer);
        }
        await dispatcher.stop();
      },
    },
    {
      name: "delivery",
      start: async () => {
        chat = new TelegramChatAdapter(db, attachments, {
          token: telegramConfig.token,
          ownerId: telegramConfig.ownerId,
          maxMessageBytes: config.attachmentMaxBytes,
          onMessage: (source, checkpoint) => dispatcher.accept(source, { commitNativeCheckpoint: checkpoint }),
        });
        chatRegistry = new ChatAdapterRegistry([chat]);
        deliveryWorker = new DeliveryWorker(deliveries, chatRegistry, attachments, undefined, (delivery) => { persistDeliveryState(delivery); });
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
      list_managed_sessions: async () => registry.managedSnapshot(),
      discover_sessions: async (args) => discovery.list({ endpointId: projectEndpoint(args.endpoint), ...(args.search ? { search: args.search } : {}), ...(args.cwd ? { cwd: args.cwd } : {}), ...(args.limit ? { limit: args.limit } : {}), ...(args.cursor ? { cursor: args.cursor } : {}) }),
      get_session_status: async (args) => {
        const identity = dashboardIdentity(args.nickname);
        const live = await sessions.status(args.nickname, { observeNative: ({ nativeStatus, activeTurnId }) => {
          const before = runtime.getSession(identity.endpointId, identity.threadId, identity.mappingId);
          const beforeTurn = runtime.activeTurn(identity.endpointId, identity.threadId, identity.mappingId) ?? null;
          const sequence = dashboardStore.allocateObservationSequence();
          const activeTurn = nativeStatus === "active" ? activeTurnId ?? undefined : undefined;
          const applied = runtime.reconcileNativeState(identity.endpointId, identity.threadId, identity.mappingId, nativeStatus, activeTurn, sequence);
          if (applied && (before?.nativeStatus !== nativeStatus || beforeTurn !== (activeTurn ?? null))) observeLifecycle(args.nickname);
        } }) as any;
        observeGoal(args.nickname, live.goal);
        await renderDashboardSafely();
        return dashboard.status(args.nickname);
      },
      create_session: async (args, context) => {
        const endpointId = projectEndpoint(args.endpoint);
        const project = await projectWorkspaces.prepareCreate(args.nickname, args.project_dir);
        const mappingId = `mapping_${randomUUID()}`;
        const workspaceReceipt = projectWorkspaceReceipt(project);
        let dispatchStarted = false;
        let settingsObservationSequence: number | undefined;
        context.checkpoint({ endpoint: endpointId, mappingId, ...workspaceReceipt, dispatchStarted });
        const settings = await lifecycle.create(args.nickname, endpointId, project, context.operationId, (thread, currentSettings) => {
          settingsObservationSequence = dashboardStore.allocateObservationSequence();
          context.checkpoint({ endpoint: endpointId, mappingId, ...workspaceReceipt, dispatchStarted, threadId: thread.id, currentSettings, settingsObservationSequence });
          hydrateThreadOrder(endpointId, thread);
        }, () => {
          dispatchStarted = true;
          context.checkpoint({ endpoint: endpointId, mappingId, ...workspaceReceipt, dispatchStarted });
        }, mappingId);
        advanceNativeWatermark(args.nickname);
        observeLifecycle(args.nickname);
        observeCurrentSettings(args.nickname, settings, Date.now(), settingsObservationSequence);
        await renderDashboardSafely();
        const mapping = registry.get(args.nickname);
        if (!mapping || mapping.mapping_id !== mappingId) throw new AppError("OPERATION_UNCERTAIN", "created session mapping was not committed");
        return { nickname: args.nickname, mapping_id: mapping.mapping_id };
      },
      adopt_session: async (args, context) => {
        const endpointId = projectEndpoint(args.endpoint);
        const mappingId = `mapping_${randomUUID()}`;
        context.checkpoint({ endpoint: endpointId, threadId: args.thread_id, mappingId });
        await lifecycle.adopt(args.nickname, endpointId, args.thread_id, (thread) => hydrateThreadOrder(endpointId, thread), mappingId);
        advanceNativeWatermark(args.nickname);
        observeLifecycle(args.nickname);
        await renderDashboardSafely();
        const mapping = registry.get(args.nickname);
        if (!mapping || mapping.mapping_id !== mappingId) throw new AppError("OPERATION_UNCERTAIN", "adopted session mapping was not committed");
        return { nickname: args.nickname, mapping_id: mapping.mapping_id };
      },
      rename_session: async (args, context) => {
        const session = registry.get(args.old_nickname);
        if (!session) throw new AppError("UNKNOWN_SESSION", `unknown session: ${args.old_nickname}`);
        context.checkpoint({ nickname: args.old_nickname, ...session });
        await lifecycle.rename(args.old_nickname, args.new_nickname);
        await reconcileDashboard();
        return { nickname: args.new_nickname, mapping_id: session.mapping_id };
      },
      unadopt_session: async (args, context) => {
        const session = registry.get(args.nickname);
        if (!session) throw new AppError("UNKNOWN_SESSION", `unknown session: ${args.nickname}`);
        context.checkpoint({ nickname: args.nickname, ...session, step: "prepared" });
        await lifecycle.unadopt(args.nickname, (checkpoint) => context.checkpoint(checkpoint));
        await reconcileDashboard();
        return { nickname: args.nickname, mapping_id: session.mapping_id };
      },
      archive_session: async (args, context) => {
        const session = registry.get(args.nickname);
        if (!session) throw new AppError("UNKNOWN_SESSION", `unknown session: ${args.nickname}`);
        context.checkpoint({ nickname: args.nickname, ...session, step: "prepared" });
        await lifecycle.archive(args.nickname, (checkpoint) => context.checkpoint(checkpoint));
        await reconcileDashboard();
        return { nickname: args.nickname, mapping_id: session.mapping_id };
      },
      send_to_session: async (args, context) => {
        const worker = registry.get(args.nickname);
        if (!worker) throw new AppError("UNKNOWN_SESSION", `unknown session: ${args.nickname}`);
        const pendingSettings = args.mode === "start" ? runtime.settings(worker.endpoint, worker.thread_id, worker.mapping_id) : undefined;
        const settingsObservationSequence = pendingSettings && (Object.hasOwn(pendingSettings, "model") || Object.hasOwn(pendingSettings, "effort"))
          ? dashboardStore.allocateObservationSequence()
          : undefined;
        context.checkpoint(args.mode === "steer"
          ? { turnId: sessions.activeTurnId(args.nickname) }
          : { pendingSettings, ...(settingsObservationSequence === undefined ? {} : { settingsObservationSequence }) });
        const resolvedAttachments: Array<{ contextId: string; attachmentId: FileHandleId }> = (args.attachment_ids as string[])
          .map((id) => attemptScope.resolveAttachment(context.attemptId, id));
        const files = resolvedAttachments.map((attachment) => attachments.toUserInput(attachment.contextId, attachment.attachmentId));
        const input = [...(args.content.length > 0 ? [{ type: "text", text: args.content, text_elements: [] }] : []), ...files];
        const holds = resolvedAttachments.map((attachment, index) => ({
          ...attachment,
          id: `${workerAttachmentHoldId(context.effectiveSourceContextId, context.attemptId, context.callId)}:${index}`,
        }));
        for (const hold of holds) attachments.retainForOperation(hold.id, hold.contextId, [hold.attachmentId]);
        let result: Awaited<ReturnType<SessionService["send"]>>;
        try {
          result = await sessions.send(args.nickname, args.content, {
            mode: args.mode,
            clientUserMessageId: `${context.effectiveSourceContextId}:${context.callId}`,
            input,
            ...(pendingSettings ? { settings: pendingSettings } : {}),
          });
        } catch (error) {
          if (isProvenSendNoEffect(error)) for (const hold of holds) attachments.releaseOperation(hold.id);
          throw error;
        }
        if (holds.length > 0) {
          for (const hold of holds) {
            if (result.terminal) attachments.releaseOperation(hold.id);
            else attachments.transferOperationToTurn(hold.id, worker.endpoint, worker.thread_id, result.turnId);
          }
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
          binding: assistantAttemptBinding(context.attemptId),
          deliveryKey: context.operationId,
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
      send_chat_message: async (args, context) => ({ deliveryId: deliveries.prepare({ id: `chat:${context.effectiveSourceContextId}:${context.attemptId}:${context.callId}`, kind: "chat", binding: assistantAttemptBinding(context.attemptId), body: args.content, mandatory: false }).id }),
      prepare_chat_attachment: async (args, context) => {
        const ownerRoot = args.owner === "assistant" ? assistantDir : sessions.managedProjectRoot(args.owner);
        const prepared = await attachments.prepareOutbound(context.effectiveSourceContextId, ownerRoot, args.relative_path, undefined, undefined, operationFileHandle(context.effectiveSourceContextId, context.attemptId, context.callId));
        return { file_handle: prepared.id, display_name: prepared.displayName, media_type: prepared.mediaType, size: prepared.size, sha256: prepared.sha256 };
      },
      send_chat_attachment: async (args, context) => {
        const attachment = attachments.toUserInput(context.effectiveSourceContextId, args.file_handle);
        void attachment;
        const delivery = deliveries.prepareAttachment({
          id: `chat-attachment:${context.effectiveSourceContextId}:${context.attemptId}:${context.callId}`,
          kind: "attachment", binding: assistantAttemptBinding(context.attemptId), body: args.caption ?? "", mandatory: false,
          attachmentId: args.file_handle, attachmentScopeId: context.effectiveSourceContextId,
        });
        return { deliveryId: delivery.id };
      },
      get_chat_history: createChatHistoryAction(() => chatRegistry, assistantAttemptBinding),
      search_slack: async (args) => requireSlackContext().search(args.query, args.date_from, args.date_to),
      get_slack_mentions: async (args) => requireSlackContext().mentions(args.date_from),
    };
  }

  function currentOwnerBinding(): ConversationBinding { return ownerRoutes.current(); }

  function assistantAttemptBinding(attemptId: string): ConversationBinding {
    const row = db.prepare(`SELECT adapter_id, conversation_key, destination_json, native_reply_json
      FROM assistant_attempts WHERE id = ?`).get(attemptId) as Record<string, unknown> | undefined;
    if (!row?.adapter_id || !row.conversation_key || !row.destination_json) {
      throw new AppError("UNSUPPORTED_CAPABILITY", "destinationless internal assistant work cannot send chat output");
    }
    return {
      adapterId: String(row.adapter_id),
      conversationKey: String(row.conversation_key),
      destination: JSON.parse(String(row.destination_json)),
      ...(row.native_reply_json ? { reply: JSON.parse(String(row.native_reply_json)) } : {}),
    };
  }

  function requireSlackContext(): SlackContextService {
    if (!slackContextService) throw new AppError("UNSUPPORTED_CAPABILITY", "Slack search is not configured");
    return slackContextService;
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
      binding: currentOwnerBinding(),
      body: "[system] session dashboard rendering failed; durable state is safe and rendering will retry",
      mandatory: true,
    });
  }

  function dashboardIdentity(nickname: string): { endpointId: string; threadId: string; mappingId: string } {
    const session = registry.get(nickname);
    if (!session) throw new AppError("UNKNOWN_SESSION", `unknown session: ${nickname}`);
    return { endpointId: session.endpoint, threadId: session.thread_id, mappingId: session.mapping_id };
  }

  function observeLifecycle(nickname: string, observedAt = Date.now()): void {
    dashboardStore.observeLifecycle(dashboardIdentity(nickname), observedAt);
  }

  function advanceNativeWatermark(nickname: string, observationSequence = dashboardStore.allocateObservationSequence()): void {
    const identity = dashboardIdentity(nickname);
    const state = runtime.getSession(identity.endpointId, identity.threadId, identity.mappingId);
    if (!state) return;
    runtime.reconcileNativeState(identity.endpointId, identity.threadId, identity.mappingId, state.nativeStatus, runtime.activeTurn(identity.endpointId, identity.threadId, identity.mappingId), observationSequence);
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

  async function onNotification(endpointId: string, method: string, params: any): Promise<void> {
    const identity = registry.snapshot().assistant;
    if (endpointId === identity.endpoint && method === "turn/completed" && params.threadId === identity.thread_id) {
      await processAssistantTerminal(params);
      return;
    }
    await relay.handleNotification(endpointId, method, params);
    await enqueuePendingEvents();
  }

  function processAssistantTerminal(params: any): Promise<void> {
    const turnId = String(params.turn.id);
    const existing = terminalProcessing.get(turnId);
    if (existing) return existing;
    const processing = processAssistantTerminalOnce(params).finally(() => {
      if (terminalProcessing.get(turnId) === processing) terminalProcessing.delete(turnId);
    });
    terminalProcessing.set(turnId, processing);
    return processing;
  }

  async function processAssistantTerminalOnce(params: any): Promise<void> {
    const identity = registry.snapshot().assistant;
    await dispatcher.terminal(params.turn);
    await dispatcher.idle();
    const attemptBefore = assistant.contextForTurn(params.turn.id);
    if (!attemptBefore) return;
    if (conversations.membersForAttempt(attemptBefore.attemptId)
      .some((member) => new Set(["start_submitting", "steer_submitting", "uncertain"]).has(member.state))) return;
    assistant.beginTerminalizing(params.turn.id);
    await assistant.fenceTools(attemptBefore.attemptId, 1_000);
    const history = await pool.request<any>(identity.endpoint, "thread/read", { threadId: identity.thread_id, includeTurns: true });
    const turn = history.thread.turns.find((candidate: any) => candidate.id === params.turn.id) ?? params.turn;
    const messages = finals.persistTerminalTurn(identity.endpoint, identity.thread_id, turn, Date.now());
    if (turn.status !== "completed") await reconcileOperations({ includeActiveAttempt: true });
    const memberIds = attemptBefore ? conversations.membersForAttempt(attemptBefore.attemptId).map((member) => member.contextId) : [];
    assistant.handleTerminal(
      turn.id,
      isTerminalStatus(turn.status) ? turn.status : "failed",
      messages.map((message) => message.body).join("\n") || undefined,
      turn.error,
    );
    for (const contextId of memberIds) attemptScope.notifyMembership(contextId);
    await enqueuePendingEvents();
    await dispatcher.enqueueInternal("terminal");
  }

  function enqueuePendingEvents(): void {
    if (!schedulerAccepting || stopping) return;
    const rows = db.prepare("SELECT id, endpoint_id, thread_id, payload_json, created_at FROM events WHERE state = 'pending' ORDER BY created_at, id").all() as Array<Record<string, unknown>>;
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
        continue;
      }
      scheduler.enqueueEvent({ id, sessionKey, payload, queuedAt: Number(row.created_at) });
    }
    void dispatcher?.enqueueInternal("events");
  }

  function isTerminalStatus(status: unknown): boolean {
    return typeof status === "string" && new Set(["completed", "failed", "interrupted"]).has(status);
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
    runtime.setSession(assistantEndpoint.id, resumed.threadId, assistantMappingId, "managed", resumed.nativeStatus);
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
          const binding = assistantAttemptBinding(operation.attemptId);
          const result = Array.isArray(checkpoint?.messageIds)
            ? await sessions.collectSelected(args.nickname, checkpoint.messageIds, { binding, deliveryKey: operation.id })
            : await sessions.collect(args.nickname, args.count, {
              direct: true,
              binding,
              deliveryKey: operation.id,
              onSelected: (messageIds) => operations.checkpoint(operation.id, { messageIds }),
            });
          operations.succeed(operation.id, { deliveries: result.map((item) => item.deliveryId), count: args.count, nickname: args.nickname });
        } else if (operation.kind === "send_to_session") {
          const session = registry.get(args.nickname);
          if (!session) continue;
          const history = await pool.request<any>(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: true });
          const clientId = `${operation.contextId}:${operation.callId}`;
          const turn = history.thread.turns.find((candidate: any) => candidate.items.some((item: any) => item.type === "userMessage" && item.clientId === clientId));
          const holds = (args.attachment_ids as string[]).map((id, index) => {
            const attachment = attemptScope.resolveAttachment(operation.attemptId, id);
            return { ...attachment, id: `${workerAttachmentHoldId(operation.contextId, operation.attemptId, operation.callId)}:${index}` };
          });
          if (turn) {
            if (holds.length > 0) {
              for (const hold of holds) attachments.transferOperationToTurn(hold.id, session.endpoint, session.thread_id, turn.id);
              if (isTerminalStatus(turn.status)) attachments.releaseTurn(session.endpoint, session.thread_id, turn.id);
            }
            const checkpoint = operation.receipt as { pendingSettings?: { model?: string; effort?: string }; settingsObservationSequence?: number } | undefined;
            const appliedSettings = args.mode === "start" && checkpoint && Object.hasOwn(checkpoint, "pendingSettings") ? checkpoint.pendingSettings ?? {} : undefined;
            if (appliedSettings) runtime.consumeSettings(session.endpoint, session.thread_id, session.mapping_id, appliedSettings);
            const receipt = { nickname: args.nickname, mode: args.mode, turnId: turn.id, terminal: isTerminalStatus(turn.status), ...(appliedSettings ? { appliedSettings } : {}) };
            await succeedRecovered(operation, receipt, () => {
              observeLastSent(args.nickname, args, { mode: args.mode, turnId: turn.id }, operation.sequence);
              if (appliedSettings) observeCurrentSettings(args.nickname, appliedSettings, operation.createdAt, checkpoint?.settingsObservationSequence);
              advanceNativeWatermark(args.nickname);
              observeLifecycle(args.nickname);
            });
          } else if (args.mode === "start" && history.thread.status?.type === "idle") {
            for (const hold of holds) attachments.releaseOperation(hold.id);
            operations.failAndUnbind(operation.id, { message: "thread history proves the requested start did not create a turn" });
          } else if (args.mode === "steer") {
            const targetTurnId = (operation.receipt as { turnId?: string } | undefined)?.turnId;
            const target = targetTurnId ? history.thread.turns.find((candidate: any) => candidate.id === targetTurnId) : undefined;
            if (target && isTerminalStatus(target.status)) {
              for (const hold of holds) attachments.releaseOperation(hold.id);
              operations.failAndUnbind(operation.id, { message: "terminal target history proves the requested steer was not appended" });
            }
          }
        } else if (operation.kind === "set_session_model" || operation.kind === "set_reasoning_effort") {
          const session = registry.get(args.nickname);
          const settings = session ? runtime.settings(session.endpoint, session.thread_id, session.mapping_id) : {};
          const proven = operation.kind === "set_session_model" ? settings.model === args.model : settings.effort === args.effort;
          if (proven) await succeedRecovered(operation, { pending: true }, () => observeLifecycle(args.nickname, operation.createdAt));
          else failRecoveredNoEffect(operation.id, "pending session setting was not committed");
        } else if (["create_session", "adopt_session"].includes(operation.kind)) {
          let session = registry.get(args.nickname);
          const checkpoint = operation.receipt as ({ endpoint?: string; threadId?: string; mappingId?: string; dispatchStarted?: boolean } & Record<string, unknown>) | undefined;
          const project = operation.kind === "create_session" && checkpoint ? preparedProjectWorkspaceFromCheckpoint(checkpoint) : undefined;
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
            if (!checkpoint.mappingId) continue;
            await lifecycle.adopt(args.nickname, endpointId, checkpoint.threadId, (thread) => {
              if (thread.threadSource !== operation.id) throw new AppError("OPERATION_UNCERTAIN", "recovered worker thread has the wrong creation source");
              hydrateThreadOrder(endpointId, thread);
            }, checkpoint.mappingId);
            session = registry.get(args.nickname);
          }
          if (session?.lifecycle_state === "adopting" && session.mapping_id === checkpoint?.mappingId) {
            await lifecycle.reconcileAdopting();
            session = registry.get(args.nickname);
          }
          if (session?.lifecycle_state === "managed" && session.mapping_id === checkpoint?.mappingId
            && (!expectedThread || session.thread_id === expectedThread) && (!expectedDir || session.project_dir === expectedDir)) {
            const state = runtime.getSession(session.endpoint, session.thread_id, session.mapping_id);
            const native = state?.managementState !== "managed" || !runtime.currentEpoch(session.endpoint, session.thread_id, session.mapping_id)
              ? await lifecycle.reconcileManaged(args.nickname, session)
              : await pool.request<any>(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: true });
            await verifySessionCwd(native.thread.cwd, session.project_dir);
            hydrateThreadOrder(session.endpoint, native.thread);
            await succeedRecovered(operation, { nickname: args.nickname, mapping_id: session.mapping_id }, () => {
              advanceNativeWatermark(args.nickname);
              observeLifecycle(args.nickname);
              const currentSettings = (checkpoint as any)?.currentSettings;
              if (currentSettings) observeCurrentSettings(args.nickname, currentSettings, operation.createdAt, (checkpoint as any)?.settingsObservationSequence);
            });
          } else if (!session && operation.kind !== "create_session") {
            failRecoveredNoEffect(operation.id, "atomic session registry mapping was not committed");
          }
        } else if (operation.kind === "rename_session") {
          const saved = operation.receipt as Partial<RegistrySession> | undefined;
          const oldMapping = registry.get(args.old_nickname);
          const newMapping = registry.get(args.new_nickname);
          if (saved?.mapping_id && newMapping?.mapping_id === saved.mapping_id) {
            await succeedRecovered(operation, { nickname: args.new_nickname, mapping_id: saved.mapping_id }, () => dashboardStore.markDirty());
          } else if (saved?.mapping_id && oldMapping?.mapping_id === saved.mapping_id && !newMapping) {
            failRecoveredNoEffect(operation.id, "atomic nickname replacement was not committed");
          }
        } else if (operation.kind === "unadopt_session" || operation.kind === "archive_session") {
          const saved = operation.receipt as (Partial<RegistrySession> & { nickname?: string; step?: string }) | undefined;
          const nickname = saved?.nickname ?? args.nickname;
          let current = registry.get(nickname);
          let decision = removalRecoveryDecision(operation.kind, saved, current);
          if (decision === "reconcile") {
            await lifecycle.reconcileRemoval(nickname, current!);
            current = registry.get(nickname);
            decision = removalRecoveryDecision(operation.kind, saved, current);
          }
          if (decision === "succeeded") {
            await succeedRecovered(operation, { nickname, mapping_id: saved!.mapping_id }, () => dashboardStore.markDirty());
          } else if (decision === "no_effect") {
            failRecoveredNoEffect(operation.id, "durable removal transition was not committed");
          }
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
    for (const session of Object.values(registry.managedSnapshot().sessions)) {
      if (session.endpoint !== endpoint.id) continue;
      const state = runtime.getSession(session.endpoint, session.thread_id, session.mapping_id);
      if (state?.managementState === "managed") {
        runtime.setSession(session.endpoint, session.thread_id, session.mapping_id, "unavailable", state.nativeStatus);
      }
    }
    for (const [nickname, session] of Object.entries(registry.managedSnapshot().sessions)) {
      if (session.endpoint !== endpoint.id) continue;
      try {
        const response = await lifecycle.reconcileManaged(nickname, session);
        const resumeObservationSequence = dashboardStore.allocateObservationSequence();
        const nativeObservationSequence = dashboardStore.allocateObservationSequence();
        hydrateThreadOrder(session.endpoint, response.thread);
        observations.observeResume(session.endpoint, session.thread_id, response, Date.now(), {
          settings: resumeObservationSequence,
          native: nativeObservationSequence,
        });
        dashboardStore.observeLifecycle({ endpointId: session.endpoint, threadId: session.thread_id }, Date.now());
      } catch {
        const current = registry.get(nickname);
        if (current?.mapping_id === session.mapping_id && current.endpoint === session.endpoint
          && current.thread_id === session.thread_id && current.lifecycle_state === "managed") {
          runtime.setSession(session.endpoint, session.thread_id, session.mapping_id, "unavailable", "notLoaded");
          dashboardStore.observeLifecycle({ endpointId: session.endpoint, threadId: session.thread_id }, Date.now());
          warnSessionUnavailable(nickname, session.endpoint, session.thread_id);
        }
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
        runtime.setSession(session.endpointId, session.threadId, session.mappingId, "unavailable", "notLoaded");
        dashboardStore.observeLifecycle({ endpointId: session.endpointId, threadId: session.threadId }, Date.now());
      }
    }
    if (target.id === assistantEndpoint.id) {
      schedulerAccepting = false;
    }
    const identity = registry.snapshot().assistant;
    deliveries.prepare({
      id: `endpoint-unavailable:${target.id}:${endpointIncident}`,
      kind: "system_warning",
      binding: currentOwnerBinding(),
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
      await lifecycle.reconcileAdopting();
      await lifecycle.reconcileRemovals();
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
          recordAssistantAuthenticationFailure(deliveries, currentOwnerBinding, endpointIncident);
        }
        throw error;
      }
      await startOrResumeAssistant();
      await dispatcher.recover();
      await dispatcher.idle();
      assistant.hydrateActive();
      await reconcileOperations();
      assistantToolReadiness.ready();
      schedulerAccepting = true;
    }
    acceptingReadyEvents = true;
    reconnectAttempts.set(target.id, 0);
    await enqueuePendingEvents();
  }

  async function verifySessionCwd(actual: string, expected: string): Promise<void> {
    if (await realpath(actual) !== await realpath(expected)) throw new Error("registered project directory does not match thread cwd");
  }

  function warnSessionUnavailable(nickname: string, endpointId: string, threadId: string): void {
    deliveries.prepare({
      id: `session-unavailable:${endpointId}:${threadId}:${endpointIncident}`,
      kind: "worker_warning",
      binding: currentOwnerBinding(),
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
      deliveries.prepare({ id, kind: "system_warning", binding: currentOwnerBinding(), body: `[system] ${label} failed; durable reconciliation will retry`, mandatory: true });
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
      await dispatcher.recover();
      await enqueuePendingEvents();
    }
    if (endpoint.state !== "ready") return;
    const accepted = await registry.reload(validateRegistryDocument);
    if (!accepted) {
      if (!registryInvalid) {
        deliveries.prepare({
          id: `registry-invalid:${Date.now()}`,
          kind: "system_warning",
          binding: currentOwnerBinding(),
          body: "[system] sessions.json replacement was rejected; the last valid registry remains active",
          mandatory: true,
        });
      }
      registryInvalid = true;
      return;
    }
    registryInvalid = false;
    await lifecycle.reconcileAdopting();
    await lifecycle.reconcileRemovals();
    await reconcileDashboard();
  }

  async function validateRegistryDocument(document: RegistryDocument): Promise<void> {
    const currentDocument = registry.snapshot();
    const currentAssistant = currentDocument.assistant;
    if (document.assistant.endpoint !== currentAssistant.endpoint || document.assistant.thread_id !== currentAssistant.thread_id || document.assistant.project_dir !== currentAssistant.project_dir) {
      throw new Error("the live assistant mapping cannot be externally repointed");
    }
    if (!registryReloadPreservesWorkerMappings(currentDocument, document)) {
      throw new Error("worker mappings and lifecycle state are managed by QiYan tools and cannot be edited live");
    }
  }
}

export function createChatHistoryAction(
  registry: () => ChatAdapterRegistry,
  binding: (attemptId: string) => ConversationBinding,
): (args: ChatHistoryRequest, context: { attemptId: string }) => Promise<JsonValue> {
  return (args, context) => registry().getHistory(binding(context.attemptId), args);
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
