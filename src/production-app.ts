import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { AttachmentStore, type FileHandleId } from "./attachments/store.ts";
import type { ChatAdapter } from "./chat/contracts.ts";
import type { ConversationBinding, JsonValue } from "./chat/binding.ts";
import { ChatAdapterRegistry } from "./chat/adapter-registry.ts";
import { OwnerRouteCatalog, OwnerRouteStore } from "./chat/owner-route-store.ts";
import type { ChatHistoryRequest } from "./chat/contracts.ts";
import { DeliveryWorker } from "./chat/delivery-worker.ts";
import {
  chatAttachmentDeliveryId,
  chatAttachmentFileHandle,
  chatMessageDeliveryId,
  createChatOutputActions,
} from "./chat/output-actions.ts";
import { LocalEndpoint } from "./app-server/local-endpoint.ts";
import { AppServerPool } from "./app-server/pool.ts";
import { RpcRequestTimeoutError } from "./app-server/rpc-client.ts";
import { MINIMUM_SUPPORTED_CODEX_VERSION } from "./app-server/protocol.ts";
import { composeApp, type AppPhase, type BotApp } from "./app.ts";
import type { BotConfig } from "./config.ts";
import { AppError } from "./core/errors.ts";
import { runBackground } from "./core/background.ts";
import { createBackgroundFailureReporter, createFailureCycle } from "./core/background-failure-reporter.ts";
import type { OperationalEventSink } from "./core/operational-log.ts";
import type { CanonicalChatSource, ManagementState } from "./core/types.ts";
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
import { OwnershipEventStore } from "./sessions/ownership-event-store.ts";
import { SessionOwnershipWatcher } from "./sessions/ownership-watcher.ts";
import { SessionOwnershipGuard } from "./sessions/rollout-ownership.ts";
import { preparedProjectWorkspaceFromCheckpoint, ProjectWorkspacePolicy, type PreparedProjectWorkspace } from "./sessions/project-workspace.ts";
import { SessionService } from "./sessions/service.ts";
import { ThreadGate } from "./sessions/thread-gate.ts";
import { openDatabase, type Database } from "./storage/database.ts";
import { acquireDatabaseLease, type DatabaseLease } from "./storage/database-lease.ts";
import { openStateDatabaseWithAutomaticRecovery } from "./storage/automatic-dashboard-recovery.ts";
import { DeliveryStore, type DeliveryRecord } from "./storage/delivery-store.ts";
import { BackgroundFailureStore } from "./storage/background-failure-store.ts";
import { ConversationStore, type ChatAcceptanceEffects } from "./storage/conversation-store.ts";
import { finalizeConversationCutover, preflightConversationCutover, runConversationRoutingBackfill } from "./storage/conversation-cutover.ts";
import { OperationStore, type RecoverableOperation } from "./storage/operation-store.ts";
import { RuntimeStore } from "./storage/runtime-store.ts";
import { isDashboardMetadataRecoveryRequired, SessionDashboardStore } from "./storage/session-dashboard-store.ts";
import { TelegramChatAdapter } from "./telegram/chat-adapter.ts";
import type { SlackContextService } from "./slack/context-service.ts";
import { SlackChatAdapter } from "./slack/chat-adapter.ts";
import type { WeixinCredentialHandle } from "./weixin/credential-store.ts";
import { WeixinApiClient, WeixinApiError } from "./weixin/api-client.ts";
import { WeixinAccountStore } from "./weixin/account-store.ts";
import { WeixinInboxStore } from "./weixin/inbox-store.ts";
import { WeixinIngressWorker } from "./weixin/ingress-worker.ts";
import { WeixinOutboundStore } from "./weixin/outbound-store.ts";
import { WeixinDeliveryAdapter } from "./weixin/delivery-adapter.ts";
import { authorizationIncident, WeixinChatAdapter } from "./weixin/chat-adapter.ts";
import { WeixinIncidentRouter } from "./weixin/incident-router.ts";
import { EndpointCatalog } from "./endpoints/catalog.ts";
import { EndpointBindingStore } from "./endpoints/binding-store.ts";
import { EndpointManager } from "./endpoints/manager.ts";
import { SshGenerationPlanner } from "./endpoints/ssh-config.ts";
import { SshRemoteClient, SshRuntime } from "./endpoints/ssh-runtime.ts";
import { openSshUnixTunnel, SshEndpoint } from "./endpoints/ssh-endpoint.ts";
import { WebSocketWire } from "./app-server/websocket-wire.ts";
import { SshHost } from "./endpoints/ssh-host.ts";
import { WorkspaceRouter } from "./endpoints/workspace-router.ts";
import { parseRuntimeIdentity, type EndpointLossKind, type EndpointWorkLease, type ManagedAppServerEndpoint, type RuntimeIdentity } from "./endpoints/types.ts";
import { WorkerFileBridge } from "./endpoints/worker-file-bridge.ts";
import { EndpointCapacityRecovery, recoverableCapacityHint } from "./endpoints/capacity-recovery.ts";
import { RolloutAccessRouter } from "./endpoints/rollout-access.ts";

const assistantAssetRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/assistant");
const remoteAssetRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/remote");
const fullAccessWarning = "QiYan assistant is running non-interactively with full filesystem access and approvals disabled.";
const assistantMappingId = "assistant";
const scheduledFailureThreshold = 3;
const maintenanceFailureEpisode = "maintenance";
const projectReconciliationFailureEpisode = "periodic-project-reconciliation";
const managedRecoveryFailureEpisode = "periodic-managed-session-recovery";

export function assistantAccessWarning(mode: BotConfig["assistantSandboxMode"]): string | undefined {
  return mode === "danger-full-access" ? fullAccessWarning : undefined;
}

export function reportAssistantTerminalFailure(
  dispatcher: Pick<ConversationDispatcher, "requestRecovery"> | undefined,
  report: () => void,
): void {
  try { report(); }
  finally { dispatcher?.requestRecovery(); }
}

export type OperationRecoveryAction = "wait_for_tool" | "attempt";

export function operationRecoveryAction(input: {
  state: RecoverableOperation["state"];
  activeHandler: boolean;
}): OperationRecoveryAction {
  return input.activeHandler ? "wait_for_tool" : "attempt";
}

export type OperationRecoveryTarget =
  | { policy: "local" }
  | { policy: "ready_endpoint"; endpointId: string }
  | { policy: "endpoint_lifecycle"; endpointId: string }
  | { policy: "unknown" };

export interface EndpointReadyBuffer {
  ready(endpointId: string): Promise<void> | undefined;
  acknowledge(endpointId: string): void;
  pause(): void;
  acceptAndDrain(): Promise<void>;
  stop(): Promise<void>;
}

export function createEndpointReadyBuffer(options: {
  recover(endpointId: string): Promise<void>;
  maxPendingEndpoints?: number;
}): EndpointReadyBuffer {
  const maxPendingEndpoints = options.maxPendingEndpoints ?? 65_536;
  if (!Number.isSafeInteger(maxPendingEndpoints) || maxPendingEndpoints < 1) {
    throw new RangeError("maxPendingEndpoints must be a positive safe integer");
  }
  const pending = new Set<string>();
  const recoveries = new Map<string, { dirty: boolean; running: Promise<void> }>();
  let accepting = false;
  let stopped = false;

  const requestRecovery = (endpointId: string): Promise<void> => {
    const existing = recoveries.get(endpointId);
    if (existing) {
      existing.dirty = true;
      return existing.running;
    }
    const state = { dirty: false, running: undefined as unknown as Promise<void> };
    recoveries.set(endpointId, state);
    state.running = Promise.resolve().then(async () => {
      if (stopped) {
        recoveries.delete(endpointId);
        return;
      }
      let terminalResult: { ok: true } | { ok: false; error: unknown } = { ok: true };
      do {
        state.dirty = false;
        try {
          await options.recover(endpointId);
          terminalResult = { ok: true };
        } catch (error) {
          terminalResult = { ok: false, error };
        }
      } while (state.dirty && accepting && !stopped);
      if (state.dirty && !accepting && !stopped) pending.add(endpointId);
      if (!terminalResult.ok && !stopped) pending.add(endpointId);
      if (recoveries.get(endpointId) === state) recoveries.delete(endpointId);
      if (!terminalResult.ok) throw terminalResult.error;
    });
    return state.running;
  };

  return {
    ready: (endpointId) => {
      if (stopped) return undefined;
      if (accepting) return requestRecovery(endpointId);
      if (pending.has(endpointId)) return undefined;
      if (pending.size >= maxPendingEndpoints) {
        return Promise.reject(new AppError("CAPACITY_EXCEEDED", "too many endpoint-ready events are pending"));
      }
      pending.add(endpointId);
      return undefined;
    },
    acknowledge: (endpointId) => { pending.delete(endpointId); },
    pause: () => { if (!stopped) accepting = false; },
    acceptAndDrain: async () => {
      if (stopped) return;
      accepting = true;
      for (const endpointId of [...pending].sort()) {
        if (stopped || !accepting) break;
        pending.delete(endpointId);
        try { await requestRecovery(endpointId); }
        catch (error) {
          if (!stopped) pending.add(endpointId);
          throw error;
        }
      }
    },
    stop: async () => {
      stopped = true;
      accepting = false;
      pending.clear();
      await Promise.allSettled([...recoveries.values()].map((state) => state.running));
    },
  };
}

export async function runOperationRecoveryChains<
  T extends { operation: { id: string; sequence: number } },
>(
  entries: readonly T[],
  targetOf: (entry: T) => OperationRecoveryTarget,
  attempt: (entry: T, target: OperationRecoveryTarget) => Promise<boolean>,
): Promise<ReadonlySet<string>> {
  const ordered = [...entries].sort((left, right) => left.operation.sequence - right.operation.sequence
    || left.operation.id.localeCompare(right.operation.id));
  const blockedEndpoints = new Set<string>();
  for (const entry of ordered) {
    const target = targetOf(entry);
    if (target.policy !== "endpoint_lifecycle" || blockedEndpoints.has(target.endpointId)) continue;
    if (await attempt(entry, target)) blockedEndpoints.add(target.endpointId);
  }
  for (const entry of ordered) {
    const target = targetOf(entry);
    if (target.policy === "endpoint_lifecycle") continue;
    if (target.policy === "ready_endpoint" && blockedEndpoints.has(target.endpointId)) continue;
    await attempt(entry, target);
  }
  return blockedEndpoints;
}

interface OperationRecoveryTargetResolver {
  readonly defaultProjectEndpointId: string;
  session(nickname: string): RegistrySession | undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

export function recoverableOperationTarget(
  operation: Pick<RecoverableOperation, "kind" | "args" | "receipt">,
  resolver: OperationRecoveryTargetResolver,
): OperationRecoveryTarget {
  const args = operation.args && typeof operation.args === "object" ? operation.args as Record<string, unknown> : {};
  const sessionTarget = (nickname: unknown): OperationRecoveryTarget => {
    if (typeof nickname !== "string") return { policy: "unknown" };
    const endpointId = resolver.session(nickname)?.endpoint;
    return endpointId ? { policy: "ready_endpoint", endpointId } : { policy: "unknown" };
  };
  const projectTarget = (): OperationRecoveryTarget => ({
    policy: "ready_endpoint",
    endpointId: stringField(operation.receipt, "endpoint") ?? stringField(args, "endpoint") ?? resolver.defaultProjectEndpointId,
  });
  switch (operation.kind) {
    case "update_session_notes":
    case "send_chat_message":
    case "send_chat_attachment":
    case "collect_messages":
    case "set_session_model":
    case "set_reasoning_effort":
    case "rename_session":
      return { policy: "local" };
    case "prepare_chat_attachment":
      return args.owner === "assistant" ? { policy: "local" } : sessionTarget(args.owner);
    case "create_session":
    case "adopt_session":
      return projectTarget();
    case "send_to_session":
    case "set_goal":
    case "pause_goal":
    case "resume_goal":
    case "cancel_goal":
    case "interrupt_session":
      return sessionTarget(args.nickname);
    case "unadopt_session":
    case "archive_session": {
      const saved = operation.receipt as (Partial<RegistrySession> & { step?: string; nickname?: string }) | undefined;
      const nickname = saved?.nickname ?? args.nickname;
      if (typeof nickname !== "string") return { policy: "unknown" };
      const current = resolver.session(nickname);
      const decision = removalRecoveryDecision(operation.kind, saved, current);
      if (decision === "succeeded" || decision === "no_effect") return { policy: "local" };
      if (decision !== "reconcile") return { policy: "unknown" };
      const endpointId = stringField(saved, "endpoint") ?? current?.endpoint;
      return endpointId ? { policy: "ready_endpoint", endpointId } : { policy: "unknown" };
    }
    case "disconnect_endpoint":
    case "restart_endpoint":
      return {
        policy: "endpoint_lifecycle",
        endpointId: stringField(operation.receipt, "endpoint") ?? stringField(args, "endpoint") ?? resolver.defaultProjectEndpointId,
      };
    default:
      return { policy: "unknown" };
  }
}

export function recoverableOperationEndpointReferences(
  operations: readonly Pick<RecoverableOperation, "kind" | "args" | "receipt">[],
  resolver: OperationRecoveryTargetResolver,
): string[] {
  const references = new Set<string>();
  for (const operation of operations) {
    const target = recoverableOperationTarget(operation, resolver);
    if ((target.policy === "ready_endpoint" || target.policy === "endpoint_lifecycle")
      && target.endpointId !== resolver.defaultProjectEndpointId) references.add(target.endpointId);
  }
  return [...references].sort();
}

export function recoverableOperationActivationReferences(
  operations: readonly Pick<RecoverableOperation, "kind" | "args" | "receipt">[],
  resolver: OperationRecoveryTargetResolver,
): string[] {
  const references = new Set<string>();
  for (const operation of operations) {
    const target = recoverableOperationTarget(operation, resolver);
    if (target.policy === "ready_endpoint" && target.endpointId !== resolver.defaultProjectEndpointId) references.add(target.endpointId);
  }
  return [...references].sort();
}

export function recoverableLifecycleEndpointReferences(
  operations: readonly Pick<RecoverableOperation, "kind" | "args" | "receipt">[],
  resolver: OperationRecoveryTargetResolver,
): string[] {
  const references = new Set<string>();
  for (const operation of operations) {
    const target = recoverableOperationTarget(operation, resolver);
    if (target.policy === "endpoint_lifecycle") references.add(target.endpointId);
  }
  return [...references].sort();
}

export type OperationRecoveryPreflight = "attempt" | "wait_for_endpoint" | "sleep";

export function operationRecoveryPreflight(
  target: OperationRecoveryTarget,
  isEndpointReady: (endpointId: string) => boolean,
): OperationRecoveryPreflight {
  if (target.policy === "unknown") return "sleep";
  if (target.policy === "ready_endpoint" && !isEndpointReady(target.endpointId)) return "wait_for_endpoint";
  return "attempt";
}

export function runOperationRecoveryTarget<T>(
  target: OperationRecoveryTarget,
  endpoints: Pick<EndpointManager, "withReadyWorkLease">,
  recover: (lease?: EndpointWorkLease) => Promise<T>,
): Promise<T> {
  return target.policy === "ready_endpoint" ? endpoints.withReadyWorkLease(target.endpointId, recover) : recover();
}

export type OperationRecoveryFailureDisposition = "retry" | "wait_for_endpoint" | "sleep";

export function operationRecoveryFailureDisposition(
  error: unknown,
  target?: OperationRecoveryTarget,
): OperationRecoveryFailureDisposition {
  if (error instanceof RpcRequestTimeoutError
    || (error instanceof AppError && error.details?.recovery === "ownership_unclassified")) return "retry";
  if (error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE") {
    return target?.policy === "endpoint_lifecycle" ? "retry" : "wait_for_endpoint";
  }
  return "sleep";
}

export interface OperationReconciliationOutcome {
  attempted: boolean;
  transientRetry: boolean;
  waitingForEndpoint: boolean;
}

export interface OperationReconciliationPass {
  outcome: OperationReconciliationOutcome;
  transientTargets: ReadonlyMap<string, OperationRecoveryTarget>;
}

interface OperationTimerApi {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: any): void;
}

export interface OperationReconciliationLoop {
  request(): Promise<void>;
  endpointReady(endpointId: string): Promise<void>;
  endpointUnavailable(endpointId: string): void;
  stop(): Promise<void>;
}

export function createOperationReconciliationLoop(options: {
  reconcileOnce(): Promise<OperationReconciliationPass>;
  isEndpointReady(endpointId: string): boolean;
  timers?: OperationTimerApi;
}): OperationReconciliationLoop {
  let operationReconciliationTail: Promise<void> = Promise.resolve();
  let running: Promise<void> | undefined;
  let followupRequested = false;
  let retryTimer: unknown;
  let retryTimerActive = false;
  let retryAttempt = 0;
  let timerGeneration = 0;
  let stopped = false;
  let transientTargets = new Map<string, OperationRecoveryTarget>();

  const isActionable = (target: OperationRecoveryTarget): boolean => target.policy === "local" || target.policy === "endpoint_lifecycle"
    || (target.policy === "ready_endpoint" && options.isEndpointReady(target.endpointId));

  const clearRetryTimer = (resetAttempt: boolean): void => {
    timerGeneration += 1;
    if (retryTimerActive) (options.timers ?? defaultOperationTimers).clearTimeout(retryTimer);
    retryTimer = undefined;
    retryTimerActive = false;
    if (resetAttempt) retryAttempt = 0;
  };

  let request!: () => Promise<void>;
  const armRetryTimer = (): void => {
    if (stopped || retryTimerActive) return;
    const timers = options.timers ?? defaultOperationTimers;
    const generation = ++timerGeneration;
    const delay = Math.min(1_000 * 2 ** retryAttempt, 30_000);
    retryAttempt += 1;
    retryTimer = timers.setTimeout(() => {
      if (stopped || generation !== timerGeneration) return;
      retryTimer = undefined;
      retryTimerActive = false;
      void request().catch(() => undefined);
    }, delay);
    retryTimerActive = true;
    (retryTimer as { unref?: () => void } | undefined)?.unref?.();
  };

  const runCoalesced = async (): Promise<void> => {
    let finalPass: OperationReconciliationPass;
    let queuedBeforeFirstPass = followupRequested;
    do {
      followupRequested = false;
      finalPass = await options.reconcileOnce();
      if (queuedBeforeFirstPass) {
        queuedBeforeFirstPass = false;
        followupRequested = true;
      }
    } while (followupRequested && !stopped);
    if (stopped) return;
    transientTargets = new Map(finalPass.transientTargets);
    if (finalPass.outcome.transientRetry && [...transientTargets.values()].some(isActionable)) armRetryTimer();
    else clearRetryTimer(true);
  };

  request = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) {
      followupRequested = true;
      return running;
    }
    clearRetryTimer(false);
    followupRequested = false;
    const scheduled = operationReconciliationTail.then(runCoalesced, runCoalesced);
    operationReconciliationTail = scheduled.catch(() => undefined);
    const current = scheduled.finally(() => { if (running === current) running = undefined; });
    running = current;
    return current;
  };

  return {
    request,
    endpointReady: () => request(),
    endpointUnavailable: () => {
      if (![...transientTargets.values()].some(isActionable)) clearRetryTimer(false);
    },
    stop: async () => {
      if (!stopped) {
        stopped = true;
        followupRequested = false;
        transientTargets.clear();
        clearRetryTimer(true);
      }
      await running;
      await operationReconciliationTail;
    },
  };
}

const defaultOperationTimers: OperationTimerApi = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export async function processWorkerTerminalNotification(
  dependencies: {
    endpoints: Pick<EndpointManager, "withReadyWorkLease">;
    ownership: Pick<SessionOwnershipWatcher, "detectEndpoint" | "release">;
    relay: Pick<EventRelay, "handleNotification">;
    reconcileOperations(): Promise<void>;
    enqueuePendingEvents(): void | Promise<void>;
  },
  endpointId: string,
  method: string,
  params: unknown,
): Promise<void> {
  try {
    await dependencies.endpoints.withReadyWorkLease(endpointId, async (lease) => {
      const before = await dependencies.ownership.detectEndpoint(endpointId, lease);
      await dependencies.relay.handleNotification(endpointId, method, params, lease);
      const after = await dependencies.ownership.detectEndpoint(endpointId, lease);
      await dependencies.ownership.release([...before, ...after], lease);
    });
  } finally {
    await dependencies.reconcileOperations();
  }
  await dependencies.enqueuePendingEvents();
}

export function requestOperationRecoveryForAttempt(
  operations: Pick<OperationStore, "listRecoverable">,
  attemptId: string,
  request: () => Promise<void>,
): boolean {
  if (!operations.listRecoverable().some((operation) => operation.attemptId === attemptId)) return false;
  void request().catch(() => undefined);
  return true;
}

export async function runAssistantTerminalRecovery(dependencies: {
  fenceTools(): Promise<unknown>;
  reconcileOperations(): Promise<void>;
  finalize(): Promise<void>;
  hasRecoverableOperations(): boolean;
}): Promise<void> {
  await dependencies.fenceTools();
  await dependencies.reconcileOperations();
  await dependencies.finalize();
  if (dependencies.hasRecoverableOperations()) await dependencies.reconcileOperations();
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

export async function recoverRemovalOperation(options: {
  operation: Pick<RecoverableOperation, "id" | "kind" | "args" | "receipt">;
  registry: Pick<SessionRegistry, "get">;
  lifecycle: Pick<SessionLifecycle, "reconcileRemoval">;
  lease?: EndpointWorkLease;
  succeed(receipt: unknown): void | Promise<void>;
  failNoEffect(): void;
}): Promise<RemovalRecoveryDecision> {
  if (options.operation.kind !== "unadopt_session" && options.operation.kind !== "archive_session") return "pending";
  const saved = options.operation.receipt as (Partial<RegistrySession> & { nickname?: string; step?: string }) | undefined;
  const args = options.operation.args && typeof options.operation.args === "object" ? options.operation.args as Record<string, unknown> : {};
  const nickname = saved?.nickname ?? args.nickname;
  if (typeof nickname !== "string") return "pending";
  let current = options.registry.get(nickname);
  let decision = removalRecoveryDecision(options.operation.kind, saved, current);
  if (decision === "reconcile") {
    if (!options.lease) throw new AppError("ENDPOINT_UNAVAILABLE", "removal recovery requires a ready endpoint lease");
    await options.lifecycle.reconcileRemoval(nickname, current!, options.lease);
    current = options.registry.get(nickname);
    decision = removalRecoveryDecision(options.operation.kind, saved, current);
  }
  if (decision === "succeeded") await options.succeed({ nickname, mapping_id: saved!.mapping_id });
  else if (decision === "no_effect") options.failNoEffect();
  return decision;
}

export function registryReloadPreservesWorkerMappings(current: RegistryDocument, candidate: RegistryDocument): boolean {
  return isDeepStrictEqual(current.sessions, candidate.sessions);
}

export function managedSessionNeedsRecovery(
  state: { managementState: ManagementState } | undefined,
  unavailableOnly: boolean,
): boolean {
  return unavailableOnly ? state?.managementState === "unavailable" : true;
}

export function parseEndpointLifecycleCheckpoint(value: unknown): { endpoint: string; phase: "draining" | "idle_proven" | "runtime_stopped" | "runtime_started"; identity: RuntimeIdentity } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !new Set(["endpoint", "phase", "identity"]).has(key))) return undefined;
  if (typeof item.endpoint !== "string" || !new Set(["draining", "idle_proven", "runtime_stopped", "runtime_started"]).has(String(item.phase))) return undefined;
  try {
    return { endpoint: item.endpoint, phase: item.phase as "draining" | "idle_proven" | "runtime_stopped" | "runtime_started", identity: parseRuntimeIdentity(item.identity) };
  } catch { return undefined; }
}

type LifecycleRecoveryFailure = (nickname: string, session: RegistrySession, error: unknown) => void | Promise<void>;

export async function reconcileLifecycleTransitions(
  lifecycle: Pick<SessionLifecycle, "reconcileAdopting" | "reconcileRemovals">,
  onError: LifecycleRecoveryFailure,
  filter: { endpointId?: string; nickname?: string } = {},
): Promise<void> {
  await lifecycle.reconcileAdopting({ ...filter, onError });
  await lifecycle.reconcileRemovals({ ...filter, onError });
}

export async function reconcileLifecycleAndOwnership(
  lifecycle: Pick<SessionLifecycle, "reconcileAdopting" | "reconcileRemovals">,
  onError: LifecycleRecoveryFailure,
  ownershipEvents: Pick<OwnershipEventStore, "reconcileReleased">,
  registry: Pick<SessionRegistry, "getByIdentity">,
  filter: { endpointId?: string; nickname?: string } = {},
): Promise<number> {
  await reconcileLifecycleTransitions(lifecycle, onError, filter);
  return ownershipEvents.reconcileReleased(registry);
}

export function createMaintenanceFailureHandler(options: {
  requestRestart(): void;
  reportRecoveryRequired(): void;
  reportRetryableFailure(): void;
}): (error: unknown) => void {
  let restartRequested = false;
  return (error) => {
    if (!isDashboardMetadataRecoveryRequired(error)) {
      options.reportRetryableFailure();
      return;
    }
    if (restartRequested) return;
    restartRequested = true;
    try { options.reportRecoveryRequired(); }
    catch { /* Operational reporting cannot prevent a required restart. */ }
    options.requestRestart();
  };
}

export async function reconcileOwnershipBeforeRelay(
  ownership: Pick<SessionOwnershipWatcher, "detectEndpoint" | "release">,
  relay: Pick<EventRelay, "reconcileEndpoint">,
  endpointId: string,
  lease?: EndpointWorkLease,
  beforeRelay?: (lease: EndpointWorkLease | undefined) => Promise<void>,
): Promise<void> {
  const before = await ownership.detectEndpoint(endpointId, lease);
  await beforeRelay?.(lease);
  await relay.reconcileEndpoint(endpointId, lease);
  const after = await ownership.detectEndpoint(endpointId, lease);
  await ownership.release([...before, ...after], lease);
}

export function reconcileOwnershipBeforeRelayWithLease(
  endpoints: Pick<EndpointManager, "withWorkLease">,
  ownership: Pick<SessionOwnershipWatcher, "detectEndpoint" | "release">,
  relay: Pick<EventRelay, "reconcileEndpoint">,
  endpointId: string,
  beforeRelay?: (lease: EndpointWorkLease) => Promise<void>,
): Promise<void> {
  return endpoints.withWorkLease(endpointId, "rpc", (_endpoint, lease) => reconcileOwnershipBeforeRelay(
    ownership, relay, endpointId, lease, beforeRelay ? () => beforeRelay(lease) : undefined,
  ));
}

export function withRelayEndpointWorkLease<T>(
  endpoints: Pick<EndpointManager, "runWithWorkLease" | "withReadyWorkLease">,
  endpointId: string,
  existingLease: EndpointWorkLease | undefined,
  run: (lease: EndpointWorkLease) => Promise<T>,
): Promise<T> {
  if (!existingLease) return endpoints.withReadyWorkLease(endpointId, run);
  return endpoints.runWithWorkLease(endpointId, existingLease, (lease) => {
    if (!lease) throw new AppError("ENDPOINT_UNAVAILABLE", "endpoint work lease is unavailable");
    return run(lease);
  });
}

export async function stopRelayRecovery(
  relay: Pick<EventRelay, "stop">,
  observations: Pick<SessionObservationProcessor, "idle">,
  finishDashboard: () => Promise<void>,
): Promise<void> {
  await relay.stop();
  await observations.idle();
  await finishDashboard();
}

export async function stopRecoveryOwnerSet(dependencies: {
  ready?: Pick<EndpointReadyBuffer, "stop">;
  operations?: Pick<OperationReconciliationLoop, "stop">;
  dispatcher?: Pick<ConversationDispatcher, "stop">;
  relay?: Pick<EventRelay, "stop">;
  observations?: Pick<SessionObservationProcessor, "idle">;
  finishDashboard?(): Promise<void>;
}): Promise<void> {
  let firstError: unknown;
  for (const stop of [
    () => dependencies.ready?.stop(),
    () => dependencies.operations?.stop(),
    () => dependencies.dispatcher?.stop(),
    () => dependencies.relay?.stop(),
    () => dependencies.observations?.idle(),
    () => dependencies.finishDashboard?.(),
  ]) {
    try { await stop(); }
    catch (error) { firstError ??= error; }
  }
  if (firstError) throw firstError;
}

export async function buildProductionApp(
  config: BotConfig,
  options: {
    chdir?: (path: string) => void;
    chatAdapters?: readonly ChatAdapter[];
    weixinCredential?: WeixinCredentialHandle;
    onOperationalEvent?: OperationalEventSink;
    requestRestart?: () => void;
    storage?: {
      acquireDatabaseLease?: (path: string) => Promise<DatabaseLease>;
      openDatabase?: (path: string) => Database;
      closeDatabase?: (database: Database) => void;
      recoverDatabase?: (path: string) => Promise<unknown>;
    };
  } = {},
): Promise<BotApp> {
  const telegramConfig = config.chat.telegram;
  const token = randomBytes(32).toString("base64url");
  const telegramBinding: ConversationBinding | undefined = telegramConfig ? {
    adapterId: "telegram",
    conversationKey: `telegram:${telegramConfig.destinationChatId}`,
    destination: { chatId: String(telegramConfig.destinationChatId) },
  } : undefined;
  let administrativeBinding!: ConversationBinding;

  let assistantDir = config.assistantWorkdir;
  let dataDir = config.dataDir;
  let registryPath = config.sessionRegistryPath;
  let dashboardPath = join(assistantDir, "session-status.json");
  let assistantWarnings: string[] = [];
  let assistantProfile!: PreparedAssistantProfile;
  let db!: Database;
  let databaseLease: DatabaseLease | undefined;
  let blockedStorageCleanup: { database?: Database; lease: DatabaseLease } | undefined;
  let registry!: SessionRegistry;
  let dashboardStore!: SessionDashboardStore;
  let dashboard!: SessionDashboard;
  let observations!: SessionObservationProcessor;
  let attachments!: AttachmentStore;
  let operations!: OperationStore;
  let deliveries!: DeliveryStore;
  let backgroundFailures!: BackgroundFailureStore;
  let runtime!: RuntimeStore;
  let finals!: FinalMessageStore;
  let endpoint!: LocalEndpoint;
  let assistantEndpoint!: LocalEndpoint;
  let endpointCatalog!: EndpointCatalog;
  let endpointBindings!: EndpointBindingStore;
  let endpointManager!: EndpointManager;
  let pool!: AppServerPool;
  let discovery!: SessionDiscovery;
  let lifecycle!: SessionLifecycle;
  let ownership!: SessionOwnershipGuard;
  let ownershipEvents!: OwnershipEventStore;
  let ownershipWatcher!: SessionOwnershipWatcher;
  let threadGate!: ThreadGate;
  let projectWorkspaces!: ProjectWorkspacePolicy;
  let workspaceRouter!: WorkspaceRouter;
  let workerFiles!: WorkerFileBridge;
  let recoveredEndpointIds: string[] = [];
  let sessions!: SessionService;
  let relay!: EventRelay;
  let assistant!: AssistantRuntime;
  let conversations!: ConversationStore;
  let ownerRoutes!: OwnerRouteStore;
  let ownerRouteCatalog: OwnerRouteCatalog | undefined;
  let weixinIncidents: WeixinIncidentRouter | undefined;
  let attemptScope!: AttemptScope;
  let dispatcher!: ConversationDispatcher;
  let dispatcherAvailable = false;
  let scheduler!: AssistantScheduler;
  let mcp!: LoopbackMcpServer;
  let chats: ChatAdapter[] = [];
  let chatRegistry!: ChatAdapterRegistry;
  let slackContextService: SlackContextService | undefined;
  let deliveryWorker!: DeliveryWorker;
  let endpointReadyBuffer: EndpointReadyBuffer | undefined;
  let schedulerAccepting = false;
  const unsubscribers: Array<() => void> = [];
  const projectEndpointSubscriptions = new Map<string, Array<() => void>>();
  const projectEndpointRecoveries = new Map<string, Promise<void>>();
  type RemoteContext = { runtime: SshRuntime; remote: SshRemoteClient; projectsRoot: string };
  const remoteContexts = new Map<string, RemoteContext>();
  const remoteCandidateContexts = new WeakMap<ManagedAppServerEndpoint, RemoteContext>();
  const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reconnectAttempts = new Map<string, number>();
  const terminalProcessing = new Map<string, Promise<void>>();
  const assistantToolReadiness = new ToolReadinessGate();
  let endpointIncident = 0;
  let stopping = false;
  let registryInvalid = false;
  let endpointsCommitted = false;
  let operationReconciler: OperationReconciliationLoop | undefined;
  let recoveryOwnersStop: Promise<void> | undefined;
  const report = options.onOperationalEvent ?? (() => undefined);
  const backgroundFailureReporter = createBackgroundFailureReporter({
    runId: randomUUID(),
    onOperational: (label) => {
      report({ level: "warn", code: "background_task_failed", component: label.replaceAll(" ", "_") });
    },
    onDurable: (notice) => {
      const identity = registry.snapshot().assistant;
      backgroundFailures.record({
        ...notice,
        endpointId: identity.endpoint,
        threadId: identity.thread_id,
        binding: currentOwnerBinding(),
      });
      if (schedulerAccepting) {
        try { enqueuePendingEvents(); }
        catch { /* Durable state remains pending for the next scheduler pass. */ }
      }
    },
  });
  const handleMaintenanceFailure = createMaintenanceFailureHandler({
    requestRestart: options.requestRestart ?? (() => undefined),
    reportRecoveryRequired: () => { report({ level: "warn", code: "database_metadata_recovery_required" }); },
    reportRetryableFailure: () => { recordScheduledBackgroundFailure("maintenance", maintenanceFailureEpisode); },
  });
  const acquireStateLease = options.storage?.acquireDatabaseLease ?? acquireDatabaseLease;
  const openStateDatabase = options.storage?.openDatabase ?? openDatabase;
  const closeStateDatabase = options.storage?.closeDatabase ?? ((database: Database) => { database.close(); });

  const acceptChat = async (source: CanonicalChatSource, effects: ChatAcceptanceEffects): Promise<void> => {
    await dispatcher.accept(source, effects);
    report({ level: "info", code: "chat_input_accepted", adapter: source.binding.adapterId });
  };

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
        if (blockedStorageCleanup) throw new AppError("CONFIGURATION_ERROR", "previous state database cleanup did not complete; restart QiYan");
        const databasePath = join(dataDir, "bot.sqlite3");
        const lease = await acquireStateLease(databasePath);
        let openedDb: Database | undefined;
        try {
          const opened = await openStateDatabaseWithAutomaticRecovery(databasePath, {
            beforeOpen: () => { preflightConversationCutover(databasePath, telegramBinding !== undefined); },
            openDatabase: (path) => {
              const database = openStateDatabase(path);
              openedDb = database;
              return database;
            },
            closeDatabase: (database) => {
              closeStateDatabase(database);
              if (openedDb === database) openedDb = undefined;
            },
            ...(options.storage?.recoverDatabase === undefined ? {} : { recoverDatabase: options.storage.recoverDatabase }),
          });
          openedDb = opened.database;
          const openedOperations = new OperationStore(openedDb);
          const openedDeliveries = new DeliveryStore(openedDb);
          const openedBackgroundFailures = new BackgroundFailureStore(openedDb, openedDeliveries);
          const openedRuntime = new RuntimeStore(openedDb);
          const openedFinals = new FinalMessageStore(openedDb);
          const openedOwnershipEvents = new OwnershipEventStore(openedDb);
          const openedDashboardStore = opened.dashboardStore;
          const openedEndpointBindings = new EndpointBindingStore(openedDb);
          const openedEndpointCatalog = await EndpointCatalog.open(config.endpointCatalogPath);
          runConversationRoutingBackfill(openedDb, telegramBinding);

          db = openedDb;
          operations = openedOperations;
          deliveries = openedDeliveries;
          backgroundFailures = openedBackgroundFailures;
          runtime = openedRuntime;
          finals = openedFinals;
          ownershipEvents = openedOwnershipEvents;
          dashboardStore = openedDashboardStore;
          endpointBindings = openedEndpointBindings;
          endpointCatalog = openedEndpointCatalog;
          databaseLease = lease;
          if (opened.recovered) report({ level: "warn", code: "database_metadata_recovered" });
        } catch (error) {
          let databaseClosed = openedDb === undefined;
          if (openedDb) {
            try { closeStateDatabase(openedDb); databaseClosed = true; }
            catch { /* Retain ownership when SQLite did not close cleanly. */ }
          }
          if (!databaseClosed) blockedStorageCleanup = { ...(openedDb ? { database: openedDb } : {}), lease };
          else {
            try { await lease.release(); }
            catch { blockedStorageCleanup = { lease }; }
          }
          throw error;
        }
      },
      stop: async () => {
        const lease = databaseLease;
        if (!lease) return;
        try { closeStateDatabase(db); }
        catch (error) {
          blockedStorageCleanup = { database: db, lease };
          throw error;
        }
        try { await lease.release(); }
        catch (error) {
          blockedStorageCleanup = { lease };
          throw error;
        }
        databaseLease = undefined;
      },
    },
    {
      name: "registry",
      start: async () => {
        registry = await SessionRegistry.open(registryPath, {
          version: 3,
          assistant: { endpoint: "assistant-local", thread_id: "pending", project_dir: assistantDir },
          sessions: {},
        });
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
      name: "chat-adapters",
      start: async () => {
        conversations = new ConversationStore(db, deliveries, attachments);
        const configured: ChatAdapter[] = options.chatAdapters ? [...options.chatAdapters] : [];
        if (!options.chatAdapters && telegramConfig) configured.push(new TelegramChatAdapter(db, attachments, {
            token: telegramConfig.token,
            ownerId: telegramConfig.ownerId,
            maxMessageBytes: config.attachmentMaxBytes,
            onMessage: (source, commitNativeCheckpoint) => acceptChat(source, { commitNativeCheckpoint }),
            onOperationalEvent: report,
          }));
        let slack: SlackChatAdapter | undefined;
        if (!options.chatAdapters && config.chat.slack) {
          slack = new SlackChatAdapter(db, attachments, conversations, deliveries, {
            config: config.chat.slack,
            maxMessageBytes: config.attachmentMaxBytes,
            onMessage: acceptChat,
            onOperationalEvent: report,
          });
          configured.push(slack);
        } else if (options.chatAdapters) {
          slack = configured.find((adapter) => adapter.delivery.id === "slack") as SlackChatAdapter | undefined;
        }
        let weixin: WeixinChatAdapter | undefined;
        if (!options.chatAdapters && config.chat.weixin) {
          const credential = options.weixinCredential;
          if (!credential) throw new AppError("CONFIGURATION_ERROR", "configured WeChat credentials are unavailable");
          const accounts = new WeixinAccountStore(db, deliveries);
          const inbox = new WeixinInboxStore(db, {
            botId: credential.public.botId,
            ownerUserId: credential.public.ownerUserId,
          }, { attachments });
          const outbound = new WeixinOutboundStore(db);
          const api = new WeixinApiClient(credential);
          const generationId = credential.public.accountGenerationId;
          weixinIncidents = new WeixinIncidentRouter(db, accounts, deliveries, {
            warningRoute: () => ownerRouteCatalog?.warningRoute({
              failedAdapterId: "weixin",
              ...(ownerRoutes ? { current: ownerRoutes.current() } : {}),
            }),
          });
          const ingress = new WeixinIngressWorker(inbox, attachments, conversations, {
            generationId,
            botId: credential.public.botId,
            ownerUserId: credential.public.ownerUserId,
            download: async (url) => {
              try {
                try { accounts.requireActive(generationId); }
                catch { throw new WeixinApiError("authorization", "WeChat account authorization is inactive"); }
                return await api.download(url) as AsyncIterable<Uint8Array | string>;
              }
              catch (error) {
                const incident = authorizationIncident(error);
                if (incident) await weixinIncidents!.transition({ generationId, ...incident });
                throw error;
              }
            },
            isTransient: isRetryableWeixinIngressFailure,
            onMessage: acceptChat,
            maxMediaBytes: config.attachmentMaxBytes,
          });
          const delivery = new WeixinDeliveryAdapter({
            api,
            outbound,
            deliveries,
            accounts,
            incidentSink: weixinIncidents,
          });
          weixin = new WeixinChatAdapter({
            credential: credential.public,
            api,
            accounts,
            inbox,
            outbound,
            ingress,
            delivery,
            incidentSink: weixinIncidents,
          });
          configured.push(weixin);
        } else if (options.chatAdapters) {
          weixin = configured.find((adapter) => adapter.delivery.id === "weixin") as WeixinChatAdapter | undefined;
        }
        const expectedAdapters = [
          telegramConfig ? "telegram" : undefined,
          config.chat.slack ? "slack" : undefined,
          config.chat.weixin ? "weixin" : undefined,
        ].filter((id): id is string => Boolean(id)).sort();
        const actualAdapters = configured.map((adapter) => adapter.delivery.id).sort();
        if (!isDeepStrictEqual(actualAdapters, expectedAdapters)) throw new AppError("CONFIGURATION_ERROR", "configured chat adapters do not match chat credentials");
        chats = configured;
        try { await Promise.all(chats.map((adapter) => adapter.initialize())); }
        catch (error) {
          await Promise.allSettled(chats.map(shutdownAdapter));
          throw error;
        }
        const slackBinding = adapterPrimaryBinding(slack, "slack");
        const weixinBinding = adapterPrimaryBinding(weixin, "weixin");
        administrativeBinding = config.chat.primary === "telegram" ? telegramBinding!
          : config.chat.primary === "slack" ? slackBinding ?? unavailablePrimary("Slack")
            : weixinBinding ?? unavailablePrimary("WeChat");
        ownerRoutes = new OwnerRouteStore(db, administrativeBinding);
        ownerRouteCatalog = new OwnerRouteCatalog(
          [telegramBinding, slackBinding, weixinBinding].filter((binding): binding is ConversationBinding => binding !== undefined),
          config.chat.primary,
        );
        await weixinIncidents?.reconcileUnwarned();
        chatRegistry = new ChatAdapterRegistry(chats);
        slackContextService = slack?.context;
        queueStartupWarnings();
      },
      stop: async () => { await settleAll(chats.map(shutdownAdapter)); },
    },
    {
      name: "mcp",
      start: async () => {
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
          afterToolCall: (attemptId) => { requestOperationRecoveryForAttempt(operations, attemptId, reconcileOperations); },
        });
        await mcp.start();
      }, stop: async () => { await mcp.stop(); },
    },
    {
      name: "subscriptions",
      start: async () => {
        recoveryOwnersStop = undefined;
        try {
        endpoint = new LocalEndpoint({ id: "local", codexBinary: config.codexBinary, env: buildWorkerChildEnvironment(process.env), minimumVersion: MINIMUM_SUPPORTED_CODEX_VERSION });
        assistantEndpoint = new LocalEndpoint({
          id: "assistant-local",
          codexBinary: config.codexBinary,
          env: buildAssistantChildEnvironment(process.env, assistantProfile, token),
          expectedCodexHome: assistantProfile.codexHome,
          validateEnvironment: () => assistantProfile.assertIntact(),
          minimumVersion: MINIMUM_SUPPORTED_CODEX_VERSION,
        });
        const sshRuntimeRoot = join(dataDir, "ssh-runtime");
        await mkdir(sshRuntimeRoot, { recursive: true, mode: 0o700 });
        await chmod(sshRuntimeRoot, 0o700);
        const helperSource = await readFile(join(remoteAssetRoot, "qiyan-ssh-helper.mjs"));
        const planner = new SshGenerationPlanner({
          sshBinary: "ssh",
          runtimeDir: sshRuntimeRoot,
          hasReferences: (id) => hasEndpointIdentityReferences(id),
          checkExisting: (id, destination, references) => endpointBindings.checkExisting(id, destination, references),
        });
        endpointManager = new EndpointManager({
          localEndpoint: endpoint,
          catalog: endpointCatalog,
          createRemote: async (definition) => {
            const generation = await planner.createGeneration(definition.id);
            const remote = new SshRemoteClient({ plan: generation.plan, helperSource });
            const remoteRuntime = new SshRuntime({ endpointId: definition.id, remote, assetRoot: remoteAssetRoot });
            const socketRoot = join(sshRuntimeRoot, "sockets", createHash("sha256").update(definition.id).digest("hex").slice(0, 24));
            await mkdir(socketRoot, { recursive: true, mode: 0o700 });
            await chmod(socketRoot, 0o700);
            const localSocket = join(socketRoot, "app-server.sock");
            const remoteEndpoint = new SshEndpoint({
              id: definition.id,
              runtime: remoteRuntime,
              minimumVersion: MINIMUM_SUPPORTED_CODEX_VERSION,
              openTunnel: (remoteSocketPath) => openSshUnixTunnel({ plan: generation.plan, localSocketPath: localSocket, remoteSocketPath }),
              connectWire: () => WebSocketWire.connect(localSocket, { timeoutMs: 10_000, trustedRoot: socketRoot }),
            });
            remoteCandidateContexts.set(remoteEndpoint, { runtime: remoteRuntime, remote, projectsRoot: definition.projectsRoot });
            return { endpoint: remoteEndpoint, pendingBinding: generation.pendingBinding };
          },
          hasIdentityReferences: (id) => hasEndpointIdentityReferences(id),
          commitBinding: (binding, references) => endpointBindings.commitAfterActivation(binding.endpointId, binding.destination, references),
          managedThreadIds: (id) => Object.values(registry.snapshot().sessions).filter((session) => session.endpoint === id).map((session) => session.thread_id),
        });
        pool = new AppServerPool([endpoint, assistantEndpoint], {
          maxConcurrentTurns: config.maxConcurrentTurns,
          resolveEndpoint: (id) => endpointManager.ensureReady(id),
          workLeaseProvider: (id, lease, run) => id === assistantEndpoint.id ? run(lease) : endpointManager.runWithWorkLease(id, lease, run),
        });
        recoveredEndpointIds = new EndpointCapacityRecovery({
          runtime,
          registry,
          operations,
          pool,
          quarantine: (operation, reason) => operations.failAndUnbind(operation.id, { message: reason }),
        }).restoreBeforeIngress();
        workspaceRouter = new WorkspaceRouter(async (id) => {
          if (id === "local") return projectWorkspaces;
          await endpointManager.ensureReady(id);
          const context = remoteContexts.get(id);
          if (!context) throw new AppError("ENDPOINT_UNAVAILABLE", `SSH workspace host is unavailable: ${id}`);
          const home = context.runtime.remoteHome;
          const projectsRoot = context.projectsRoot.startsWith("~/") ? posix.resolve(home, context.projectsRoot.slice(2)) : posix.resolve(context.projectsRoot);
          return new ProjectWorkspacePolicy({
            userHome: home,
            qiyanHome: context.runtime.remoteRuntimeDir,
            assistantWorkdir: context.runtime.remoteRuntimeDir,
            dataDir: context.runtime.remoteRuntimeDir,
            registryPath: posix.join(context.runtime.remoteRuntimeDir, "sessions.json"),
            defaultProjectsRoot: projectsRoot,
            host: new SshHost(id, context.remote, context.runtime.remoteHelperPath),
          });
        }, (id, lease) => endpointManager.validateWorkLease(lease, id));
        workerFiles = new WorkerFileBridge({
          attachments,
          registry,
          endpoints: endpointManager,
          workspaces: workspaceRouter,
          remote: (id) => {
            const context = remoteContexts.get(id);
            return context ? { remote: context.remote, helperPath: context.runtime.remoteHelperPath, runtimeDir: context.runtime.remoteRuntimeDir } : undefined;
          },
          maxFileBytes: config.attachmentMaxBytes,
        });
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
        const rolloutAccess = new RolloutAccessRouter({
          remote: (id) => {
            const context = remoteContexts.get(id);
            return context ? { remote: context.remote, helperPath: context.runtime.remoteHelperPath } : undefined;
          },
          validateLease: (id, lease) => endpointManager.validateWorkLease(lease, id),
        });
        ownership = new SessionOwnershipGuard(db, runtime, operations, rolloutAccess);
        lifecycle = new SessionLifecycle(pool, registry, runtime, { now: () => Date.now() }, workspaceRouter as never, threadGate, endpointManager, ownership);
        sessions = new SessionService(pool, registry, runtime, finals, deliveries, workspaceRouter, threadGate, endpointManager, ownership);
        observations = new SessionObservationProcessor(dashboardStore, registry, runtime, {
          now: () => Date.now(),
          readThread: async (endpointId, threadId, lease) => (await pool.request<any>(
            endpointId,
            "thread/read",
            { threadId, includeTurns: true },
            undefined,
            lease,
          )).thread,
          readGoal: (endpointId, threadId) => pool.request(endpointId, "thread/goal/get", { threadId }),
          onChanged: () => runBackground(() => renderDashboardSafely(), () => recordBackgroundFailure("dashboard rendering")),
          onError: () => recordBackgroundFailure("session observation"),
        });
        relay = new EventRelay(db, pool, registry, runtime, finals, deliveries, {
          binding: currentOwnerBinding,
          clock: { now: () => Date.now() },
          onTerminal: (event, lease) => observations.observeTerminal(event, lease),
          withEndpointWorkLease: (endpointId, existingLease, run) => withRelayEndpointWorkLease(
            endpointManager,
            endpointId,
            existingLease,
            run,
          ),
        }, attachments, ownership, threadGate);
        ownershipWatcher = new SessionOwnershipWatcher(registry, ownership, lifecycle, {
          isInspectable: (identity) => {
            const state = runtime.getSession(identity.endpoint, identity.thread_id, identity.mapping_id)?.managementState;
            return state === "managed" || state === "unadopting";
          },
          onExternal: async (incident) => {
            const id = `external-turn:${incident.endpoint}:${incident.thread_id}:${incident.mapping_id}:${incident.turnId}`;
            deliveries.prepare({
              id,
              kind: "worker_warning",
              binding: currentOwnerBinding(),
              body: `[${incident.nickname}] another Codex client started a turn; QiYan is releasing this session`,
              mandatory: true,
            });
            ownershipEvents.record(incident, "pending");
            dashboardStore.observeLifecycle({ endpointId: incident.endpoint, threadId: incident.thread_id }, Date.now());
            await renderDashboardSafely();
            if (schedulerAccepting) enqueuePendingEvents();
          },
          onReleased: async (incident) => {
            ownershipEvents.record(incident, "completed");
            dashboardStore.observeLifecycle({ endpointId: incident.endpoint, threadId: incident.thread_id }, Date.now());
            await renderDashboardSafely();
            if (schedulerAccepting) enqueuePendingEvents();
          },
        }, threadGate);
        operationReconciler = createOperationReconciliationLoop({
          reconcileOnce: reconcileOperationsOnce,
          isEndpointReady: isRecoveryEndpointReady,
        });
        endpointReadyBuffer = createEndpointReadyBuffer({ recover: recoverProjectEndpoint });
        scheduler = new AssistantScheduler();
        unsubscribers.push(endpointManager.onEndpoint((target, generation) => bindProjectEndpoint(target, generation)));
        unsubscribers.push(assistantEndpoint.onNotification((method, params) => runBackground(
          () => onNotification(assistantEndpoint.id, method, params),
          // Before construction, the assistant phase's initial dispatcher.recover() is the recovery boundary.
          () => reportAssistantTerminalFailure(dispatcherAvailable ? dispatcher : undefined, () => recordBackgroundFailure("assistant notification")),
        )));
        unsubscribers.push(assistantEndpoint.onUnavailable((kind) => {
          assistantToolReadiness.block();
          runBackground(() => handleEndpointUnavailable(assistantEndpoint, kind), () => recordBackgroundFailure("assistant unavailable handling"));
        }));
        } catch (error) {
          await stopRecoveryOwners().catch(() => undefined);
          throw error;
        }
      }, stop: async () => {
        for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
        for (const subscriptions of projectEndpointSubscriptions.values()) for (const unsubscribe of subscriptions) unsubscribe();
        projectEndpointSubscriptions.clear();
      },
    },
    {
      name: "endpoint",
      start: async () => {
        stopping = false;
        endpointsCommitted = false;
        try {
          const lifecycleOwned = lifecycleOwnedEndpointIds();
          if (!lifecycleOwned.has("local")) await endpointManager.ensureReady("local");
          await startAuthenticatedAssistantEndpoint(assistantEndpoint, assistantProfile);
          if ((!lifecycleOwned.has("local") && endpoint.state !== "ready") || assistantEndpoint.state !== "ready") {
            throw new AppError("ENDPOINT_UNAVAILABLE", "an app-server became unavailable during initial startup");
          }
          endpointsCommitted = true;
        } catch (error) {
          stopping = true;
          for (const timer of reconnectTimers.values()) clearTimeout(timer);
          reconnectTimers.clear();
          await stopRecoveryOwners().catch(() => undefined);
          await Promise.all([assistantEndpoint.stop(), endpointManager.closeConnections()]).catch(() => undefined);
          throw error;
        }
      },
      stop: async () => {
        stopping = true;
        endpointsCommitted = false;
        for (const timer of reconnectTimers.values()) clearTimeout(timer);
        reconnectTimers.clear();
        await Promise.all([assistantEndpoint.stop(), endpointManager.closeConnections()]);
      },
    },
    {
      name: "recovery-owners",
      start: async () => { endpointReadyBuffer?.pause(); },
      stop: stopRecoveryOwners,
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
          onOperationalEvent: (code) => { report({ level: code === "assistant_submission_uncertain" ? "warn" : "info", code }); },
          onDeferredTerminal: (turn) => runBackground(
            () => processAssistantTerminal({ threadId: identity.thread_id, turn }),
            () => reportAssistantTerminalFailure(dispatcher, () => recordBackgroundFailure("deferred assistant terminal")),
          ),
        });
        dispatcherAvailable = true;
        await dispatcher.recover();
        await dispatcher.idle();
        assistant.hydrateActive();
        const lifecycleOwned = lifecycleOwnedEndpointIds();
        const referencedEndpoints = [...new Set([
          ...Object.values(registry.snapshot().sessions).map((session) => session.endpoint),
          ...recoveredEndpointIds,
          ...recoverableActivationReferences(),
        ])].filter((id) => id !== "local" && id !== assistantEndpoint.id && !lifecycleOwned.has(id));
        const activation = await endpointManager.activateReferenced(referencedEndpoints);
        await reconcileOperations();
        conversations.repairQueueNotices();
        await reconcileStartupLifecycleState();
        await resumeStartupManagedSessions();
        for (const endpointId of [...new Set(recoveredEndpointIds)]) {
          if (endpointId === assistantEndpoint.id || activation.unavailable.includes(endpointId)
            || lifecycleOwnedEndpointIds().has(endpointId) || endpointManager.desiredState(endpointId) !== "automatic") continue;
          await reconcileOwnershipBeforeRelayWithLease(endpointManager, ownershipWatcher, relay, endpointId, async () => {
            await pool.reconcileEndpointClaims(endpointId);
          });
          endpointReadyBuffer?.acknowledge(endpointId);
        }
        deliveries.recoverAfterCrash();
        reconcileDeliveryEvents();
        await endpointReadyBuffer?.acceptAndDrain();
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
        assistant.fenceToolAdmission();
        const active = assistant.current();
        if (active && !active.turnId.startsWith("pending:")) {
          await assistant.fenceTools(active.attemptId, 1_000);
          let interruptTimer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            pool.interrupt(assistantEndpoint.id, registry.snapshot().assistant.thread_id, active.turnId).catch(() => undefined),
            new Promise<void>((resolve) => { interruptTimer = setTimeout(resolve, 1_000); }),
          ]);
          if (interruptTimer) clearTimeout(interruptTimer);
        }
        await assistant.waitForTools();
        await dispatcher.stop();
      },
    },
    {
      name: "delivery",
      start: async () => {
        deliveryWorker = new DeliveryWorker(
          deliveries,
          chatRegistry,
          attachments,
          undefined,
          (delivery) => { persistDeliveryState(delivery); },
          (delivery) => { report({ level: "warn", code: "delivery_failed", adapter: delivery.binding.adapterId }); },
        );
        deliveryWorker.start();
      },
      stop: async () => { await deliveryWorker.stop(); },
    },
    { name: "maintenance", start: async () => undefined, stop: async () => undefined },
    {
      name: "chat-ingress",
      start: async () => {
        await Promise.all(chats.map((adapter) => adapter.start()));
        for (const adapter of chats) report({ level: "info", code: "chat_ingress_started", adapter: adapter.delivery.id });
      },
      stop: async () => { await settleAll(chats.map((adapter) => adapter.stop())); },
    },
  ];

  function stopRecoveryOwners(): Promise<void> {
    if (recoveryOwnersStop) return recoveryOwnersStop;
    recoveryOwnersStop = stopRecoveryOwnerSet({
      ...(endpointReadyBuffer ? { ready: endpointReadyBuffer } : {}),
      ...(operationReconciler ? { operations: operationReconciler } : {}),
      ...(dispatcherAvailable ? { dispatcher } : {}),
      ...(relay ? { relay } : {}),
      ...(observations ? { observations } : {}),
      ...(relay && observations ? { finishDashboard: renderDashboardSafely } : {}),
    }).finally(() => {
      dispatcherAvailable = false;
    });
    return recoveryOwnersStop;
  }

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
        return endpointManager.withWorkLease(endpointId, "session-mutation", async (_endpoint, lease) => {
          const project = await workspaceRouter.prepareCreate(endpointId, args.nickname, args.project_dir, lease);
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
          }, mappingId, lease);
          advanceNativeWatermark(args.nickname);
          observeLifecycle(args.nickname);
          observeCurrentSettings(args.nickname, settings, Date.now(), settingsObservationSequence);
          await renderDashboardSafely();
          const mapping = registry.get(args.nickname);
          if (!mapping || mapping.mapping_id !== mappingId) throw new AppError("OPERATION_UNCERTAIN", "created session mapping was not committed");
          return { nickname: args.nickname, mapping_id: mapping.mapping_id };
        });
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
        reconcileExternalOwnershipReleases();
        await reconcileDashboard();
        return { nickname: args.nickname, mapping_id: session.mapping_id };
      },
      archive_session: async (args, context) => {
        const session = registry.get(args.nickname);
        if (!session) throw new AppError("UNKNOWN_SESSION", `unknown session: ${args.nickname}`);
        context.checkpoint({ nickname: args.nickname, ...session, step: "prepared" });
        await lifecycle.archive(args.nickname, (checkpoint) => context.checkpoint(checkpoint));
        reconcileExternalOwnershipReleases();
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
            prepareInput: async ({ session, projectRoot, lease }) => {
              if (!lease) throw new AppError("ENDPOINT_UNAVAILABLE", "worker endpoint lease is unavailable");
              const files = await Promise.all(resolvedAttachments.map((attachment) => workerFiles.toWorkerInput({
                lease,
                mapping: session,
                projectRoot,
                scopeId: attachment.contextId,
                attachmentId: attachment.attachmentId,
              })));
              return [...(args.content.length > 0 ? [{ type: "text", text: args.content, text_elements: [] }] : []), ...files];
            },
            onBeforeNativeDispatch: ({ session, mode, activeTurnId }) => {
              if (mode === "steer") {
                context.checkpoint({ turnId: activeTurnId });
                return;
              }
              context.checkpoint({
                pendingSettings,
                ...(settingsObservationSequence === undefined ? {} : { settingsObservationSequence }),
                capacityHint: {
                  phase: "provisional-start", endpoint: session.endpoint, threadId: session.thread_id,
                  mappingId: session.mapping_id, clientUserMessageId: `${context.effectiveSourceContextId}:${context.callId}`,
                },
              });
            },
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
      list_models: async (args) => sessions.models(projectEndpoint(args.endpoint)),
      disconnect_endpoint: async (args, context) => {
        const endpointId = projectEndpoint(args.endpoint);
        await endpointManager.disconnect(endpointId, (checkpoint) => context.checkpoint({ endpoint: endpointId, ...(checkpoint as object) }));
        return { endpoint: endpointId, state: "disconnected" };
      },
      restart_endpoint: async (args, context) => {
        const endpointId = projectEndpoint(args.endpoint);
        await endpointManager.restart(endpointId, (checkpoint) => context.checkpoint({ endpoint: endpointId, ...(checkpoint as object) }));
        return { endpoint: endpointId, state: "ready" };
      },
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
      ...createChatOutputActions({
        deliveries,
        attachments,
        prepareAttachment: prepareChatAttachment,
        binding: assistantAttemptBinding,
      }),
      get_chat_history: createChatHistoryAction(() => chatRegistry, assistantAttemptBinding),
      search_slack: async (args) => requireSlackContext().search(args.query, args.date_from, args.date_to),
      get_slack_mentions: async (args) => requireSlackContext().mentions(args.date_from),
    };
  }

  function queueStartupWarnings(): void {
    for (const [index, warning] of registry.warnings().entries()) {
      deliveries.prepare({ id: `registry-startup-warning:${index}`, kind: "system_warning", binding: currentOwnerBinding(), body: `[system] ${warning}`, mandatory: true });
    }
    for (const [index, warning] of assistantWarnings.entries()) {
      deliveries.prepare({ id: `assistant-workspace-warning:${index}`, kind: "system_warning", binding: currentOwnerBinding(), body: `[system] ${warning}`, mandatory: true });
    }
    const accessWarning = assistantAccessWarning(config.assistantSandboxMode);
    if (accessWarning) deliveries.prepare({
      id: "assistant-full-access-warning",
      kind: "system_warning",
      binding: currentOwnerBinding(),
      body: `[system] ${accessWarning}`,
      mandatory: true,
    });
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
    if (!ownerRoutes) return;
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

  function hasEndpointIdentityReferences(endpointId: string): boolean {
    return Object.values(registry.snapshot().sessions).some((session) => session.endpoint === endpointId)
      || Boolean(pool?.hasClaims(endpointId))
      || Boolean(operations?.listRecoverable().some((operation) => recoverableCapacityHint(operation)?.endpoint === endpointId))
      || recoverableEndpointReferences().includes(endpointId);
  }

  function recoverableEndpointReferences(): string[] {
    if (!operations || !registry) return [];
    return recoverableOperationEndpointReferences(operations.listRecoverable(), {
      defaultProjectEndpointId: "local",
      session: (nickname) => registry.get(nickname),
    }).filter((endpointId) => endpointId !== assistantEndpoint?.id);
  }

  function recoverableActivationReferences(): string[] {
    return recoverableOperationActivationReferences(operations.listRecoverable(), {
      defaultProjectEndpointId: "local",
      session: (nickname) => registry.get(nickname),
    }).filter((endpointId) => endpointId !== assistantEndpoint.id);
  }

  function lifecycleOwnedEndpointIds(): Set<string> {
    return new Set(recoverableLifecycleEndpointReferences(operations.listRecoverable(), {
      defaultProjectEndpointId: "local",
      session: (nickname) => registry.get(nickname),
    }));
  }

  function bindProjectEndpoint(target: ManagedAppServerEndpoint, generation: number): void {
    for (const unsubscribe of projectEndpointSubscriptions.get(target.id) ?? []) unsubscribe();
    const current = () => {
      try {
        const value = endpointManager.endpointGeneration(target.id);
        return value.endpoint === target && value.generation === generation;
      } catch { return false; }
    };
    const remoteContext = remoteCandidateContexts.get(target);
    if (remoteContext) remoteContexts.set(target.id, remoteContext);
    pool.replaceEndpoint(target);
    const requestReadyRecovery = (): void => {
      if (!current()) return;
      const recovery = endpointReadyBuffer?.ready(target.id);
      if (recovery) runBackground(() => recovery, () => recordBackgroundFailure("project ready reconciliation"));
    };
    const subscriptions = [
      target.onNotification((method, params) => {
        if (!current()) return;
        if (!observations.accept(target.id, method, params)) runBackground(() => onNotification(target.id, method, params), () => recordBackgroundFailure("project notification"));
      }),
      target.onPermissionBlocked((event) => {
        if (!current()) return;
        runBackground(async () => {
          await relay.handlePermissionBlocked(target.id, event);
          const mapping = event.threadId ? registry.getByIdentity(target.id, event.threadId) : undefined;
          if (event.threadId && mapping && runtime.getSession(target.id, event.threadId, mapping.session.mapping_id)?.managementState === "managed") {
            const state = runtime.getSession(target.id, event.threadId, mapping.session.mapping_id)!;
            runtime.reconcileNativeState(target.id, event.threadId, mapping.session.mapping_id, state.nativeStatus, runtime.activeTurn(target.id, event.threadId, mapping.session.mapping_id), dashboardStore.allocateObservationSequence());
            dashboardStore.observeLifecycle({ endpointId: target.id, threadId: event.threadId }, Date.now());
            await renderDashboardSafely();
          }
          enqueuePendingEvents();
        }, () => recordBackgroundFailure("permission notification"));
      }),
      target.onReady(requestReadyRecovery),
      target.onUnavailable((kind) => { if (current()) runBackground(() => handleEndpointUnavailable(target, kind), () => recordBackgroundFailure("project unavailable handling")); }),
    ];
    projectEndpointSubscriptions.set(target.id, subscriptions);
    if (target.state === "ready") requestReadyRecovery();
  }

  async function onNotification(endpointId: string, method: string, params: any): Promise<void> {
    const identity = registry.snapshot().assistant;
    if (endpointId === identity.endpoint && method === "turn/completed" && params.threadId === identity.thread_id) {
      await processAssistantTerminal(params);
      return;
    }
    if (method === "turn/completed") {
      await processWorkerTerminalNotification({
        endpoints: endpointManager,
        ownership: ownershipWatcher,
        relay,
        reconcileOperations,
        enqueuePendingEvents,
      }, endpointId, method, params);
      return;
    } else {
      await relay.handleNotification(endpointId, method, params);
    }
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
    await runAssistantTerminalRecovery({
      fenceTools: () => assistant.fenceTools(attemptBefore.attemptId, 1_000),
      reconcileOperations,
      finalize: async () => {
        const history = await pool.request<any>(identity.endpoint, "thread/read", { threadId: identity.thread_id, includeTurns: true });
        const turn = history.thread.turns.find((candidate: any) => candidate.id === params.turn.id) ?? params.turn;
        const messages = finals.persistTerminalTurn(identity.endpoint, identity.thread_id, turn, Date.now());
        const memberIds = conversations.membersForAttempt(attemptBefore.attemptId).map((member) => member.contextId);
        assistant.handleTerminal(
          turn.id,
          isTerminalStatus(turn.status) ? turn.status : "failed",
          messages.map((message) => message.body).join("\n") || undefined,
          turn.error,
        );
        for (const contextId of memberIds) attemptScope.notifyMembership(contextId);
      },
      hasRecoverableOperations: () => operations.listRecoverable().some((operation) => operation.attemptId === attemptBefore.attemptId),
    });
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
      config: assistantTurnConfig(mcp.url, token, {
        userHome: config.userHome,
        codexHome: assistantProfile.codexHome,
      }),
      creationNonce: assistantProfile.creationNonce,
      pendingThreadId: assistantProfile.pendingThreadId,
      recordPendingThread: (threadId) => assistantProfile.recordPendingThread(threadId),
      clearPendingThread: (threadId) => assistantProfile.clearPendingThread(threadId),
    });
    runtime.setSession(assistantEndpoint.id, resumed.threadId, assistantMappingId, "managed", resumed.nativeStatus);
  }

  function isRecoveryEndpointReady(endpointId: string): boolean {
    if (endpointId === assistantEndpoint.id) return assistantEndpoint.state === "ready";
    try { return endpointManager.endpointGeneration(endpointId).endpoint.state === "ready"; }
    catch { return false; }
  }

  function reconcileOperations(): Promise<void> {
    return operationReconciler?.request() ?? Promise.resolve();
  }

  async function reconcileOperationsOnce(): Promise<OperationReconciliationPass> {
    let attempted = false;
    let waitingForEndpoint = false;
    const transientTargets = new Map<string, OperationRecoveryTarget>();
    const entries = operations.listRecoverable().map((operation) => ({ operation }));
    const resolveTarget = ({ operation }: { operation: RecoverableOperation }): OperationRecoveryTarget =>
      recoverableOperationTarget(operation, {
        defaultProjectEndpointId: endpoint.id,
        session: (nickname) => registry.get(nickname),
      });
    await runOperationRecoveryChains(entries, resolveTarget, async ({ operation }, target) => {
      if (operationRecoveryAction({ state: operation.state, activeHandler: assistant.hasActiveTools(operation.attemptId) }) === "wait_for_tool") return true;
      const preflight = operationRecoveryPreflight(target, isRecoveryEndpointReady);
      if (preflight === "sleep") return true;
      if (preflight === "wait_for_endpoint") {
        waitingForEndpoint = true;
        return true;
      }
      attempted = true;
      const args = operation.args as any;
      try {
        const recover = async (recoveryLease?: EndpointWorkLease): Promise<void> => {
        if (operation.kind === "update_session_notes") {
          const result = dashboardStore.noteOperationResult(operation.id);
          if (result) await succeedRecovered(operation, result);
          else failRecoveredNoEffect(operation.id, "manager note mutation was not committed");
        } else if (operation.kind === "send_chat_message") {
          const id = chatMessageDeliveryId(operation.contextId, operation.attemptId, operation.callId);
          if (deliveries.get(id)) operations.succeed(operation.id, { deliveryId: id });
          else failRecoveredNoEffect(operation.id, "chat delivery intent was not committed");
        } else if (operation.kind === "send_chat_attachment") {
          const id = chatAttachmentDeliveryId(operation.contextId, operation.attemptId, operation.callId);
          if (deliveries.get(id)) operations.succeed(operation.id, { deliveryId: id });
          else failRecoveredNoEffect(operation.id, "attachment delivery intent was not committed");
        } else if (operation.kind === "prepare_chat_attachment") {
          const id = chatAttachmentFileHandle(operation.contextId, operation.attemptId, operation.callId);
          let prepared = attachments.get(operation.contextId, id);
          if (!prepared) {
            prepared = await prepareChatAttachment(args.owner, args.relative_path, operation.contextId, id, recoveryLease);
          }
          operations.succeed(operation.id, { file_handle: prepared.id, display_name: prepared.displayName, media_type: prepared.mediaType, size: prepared.size, sha256: prepared.sha256 });
        } else if (operation.kind === "disconnect_endpoint") {
          const endpointId = projectEndpoint(args.endpoint);
          const saved = parseEndpointLifecycleCheckpoint(operation.receipt);
          if (operation.receipt !== undefined && (!saved || saved.endpoint !== endpointId)) return;
          if (saved) {
            if (saved.phase === "runtime_started") return;
            await endpointManager.recoverDisconnect(endpointId, saved.phase, saved.identity,
              (checkpoint) => operations.checkpoint(operation.id, { endpoint: endpointId, ...(checkpoint as object) }));
          }
          else await endpointManager.disconnect(endpointId, (checkpoint) => operations.checkpoint(operation.id, { endpoint: endpointId, ...(checkpoint as object) }));
          operations.succeed(operation.id, { endpoint: endpointId, state: "disconnected" });
        } else if (operation.kind === "restart_endpoint") {
          const endpointId = projectEndpoint(args.endpoint);
          const saved = parseEndpointLifecycleCheckpoint(operation.receipt);
          if (operation.receipt !== undefined && (!saved || saved.endpoint !== endpointId)) return;
          if (saved) await endpointManager.recoverRestart(endpointId, saved.phase, saved.identity,
            (checkpoint) => operations.checkpoint(operation.id, { endpoint: endpointId, ...(checkpoint as object) }));
          else await endpointManager.restart(endpointId, (checkpoint) => operations.checkpoint(operation.id, { endpoint: endpointId, ...(checkpoint as object) }));
          operations.succeed(operation.id, { endpoint: endpointId, state: "ready" });
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
          if (!session) return;
          const history = await pool.request<any>(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: true }, undefined, recoveryLease);
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
          const checkpoint = operation.receipt as ({ endpoint?: string; threadId?: string; mappingId?: string; dispatchStarted?: boolean } & Record<string, unknown>) | undefined;
          const project = operation.kind === "create_session" && checkpoint ? preparedProjectWorkspaceFromCheckpoint(checkpoint) : undefined;
          const recoveryEndpointId = projectEndpoint(checkpoint?.endpoint ?? args.endpoint);
          if (!recoveryLease || recoveryLease.endpointId !== recoveryEndpointId) {
            throw new AppError("ENDPOINT_UNAVAILABLE", "session recovery endpoint lease changed");
          }
          const lease = recoveryLease;
          let session = registry.get(args.nickname);
          if (project) {
            await workspaceRouter.assertDispatchable(recoveryEndpointId, project, lease);
          }
          const expectedThread = args.thread_id as string | undefined ?? (operation.kind === "create_session" ? checkpoint?.threadId : undefined);
          const expectedDir = project?.path;
          if (!session && operation.kind === "create_session" && checkpoint?.dispatchStarted === false) {
            failRecoveredNoEffect(operation.id, "project workspace was prepared before worker dispatch began");
            return;
          }
          if (!session && operation.kind === "create_session" && checkpoint?.dispatchStarted === true && !checkpoint.threadId && project) {
            const candidates = (await discovery.list({ endpointId: recoveryEndpointId, cwd: project.path, limit: 100 }, lease)).sessions
              .filter((candidate) => candidate.threadSource === operation.id && !candidate.archived);
            if (candidates.length === 0) {
              failRecoveredNoEffect(operation.id, "worker discovery proved the requested thread was not created");
              return;
            }
            if (candidates.length !== 1) return;
            checkpoint.threadId = candidates[0]!.id;
            operations.checkpoint(operation.id, checkpoint);
          }
          if (!session && operation.kind === "create_session" && checkpoint?.threadId && project) {
            if (!checkpoint.mappingId) return;
            await lifecycle.adopt(args.nickname, recoveryEndpointId, checkpoint.threadId, (thread) => {
              if (thread.threadSource !== operation.id) throw new AppError("OPERATION_UNCERTAIN", "recovered worker thread has the wrong creation source");
              hydrateThreadOrder(recoveryEndpointId, thread);
            }, checkpoint.mappingId, lease);
            session = registry.get(args.nickname);
          }
          if (session?.lifecycle_state === "adopting" && session.mapping_id === checkpoint?.mappingId && session.endpoint === recoveryEndpointId) {
            await lifecycle.reconcileAdopting({ nickname: args.nickname, endpointId: recoveryEndpointId, existingLease: lease });
            session = registry.get(args.nickname);
          }
          if (session?.lifecycle_state === "managed" && session.mapping_id === checkpoint?.mappingId && session.endpoint === recoveryEndpointId
            && (!expectedThread || session.thread_id === expectedThread) && (!expectedDir || session.project_dir === expectedDir)) {
            const state = runtime.getSession(session.endpoint, session.thread_id, session.mapping_id);
            const native = state?.managementState !== "managed" || !runtime.currentEpoch(session.endpoint, session.thread_id, session.mapping_id)
              ? await lifecycle.reconcileManaged(args.nickname, session, lease)
              : await pool.request<any>(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: true }, undefined, lease);
            await verifySessionCwd(session.endpoint, native.thread.cwd, session.project_dir, lease);
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
          await recoverRemovalOperation({
            operation,
            registry,
            lifecycle,
            ...(recoveryLease ? { lease: recoveryLease } : {}),
            succeed: (receipt) => succeedRecovered(operation, receipt, () => dashboardStore.markDirty()),
            failNoEffect: () => failRecoveredNoEffect(operation.id, "durable removal transition was not committed"),
          });
        } else if (["set_goal", "pause_goal", "resume_goal", "cancel_goal"].includes(operation.kind)) {
          const session = registry.get(args.nickname);
          if (!session) return;
          const current = await pool.request<any>(session.endpoint, "thread/goal/get", { threadId: session.thread_id }, undefined, recoveryLease);
          const goal = current?.goal;
          const actualBudget = goal?.tokenBudget ?? goal?.token_budget ?? null;
          let cancelInterruptProven = true;
          if (operation.kind === "cancel_goal" && args.interrupt_active_turn) {
            const checkpoint = operation.receipt as { turnId?: string | null } | undefined;
            cancelInterruptProven = checkpoint !== undefined && checkpoint.turnId === null;
            if (checkpoint?.turnId) {
              const history = await pool.request<any>(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: true }, undefined, recoveryLease);
              cancelInterruptProven = history.thread.turns.some((turn: any) => turn.id === checkpoint.turnId && isTerminalStatus(turn.status));
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
          if (!session) return;
          const turnId = args.turn_id ?? (operation.receipt as { turnId?: string } | undefined)?.turnId;
          if (!turnId) return;
          const history = await pool.request<any>(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: true }, undefined, recoveryLease);
          const turn = history.thread.turns.find((candidate: any) => candidate.id === turnId);
          if (turn && isTerminalStatus(turn.status)) await succeedRecovered(operation, { interrupted: true, turnId }, () => {
            advanceNativeWatermark(args.nickname);
            observeLifecycle(args.nickname);
          });
        }
        };
        await runOperationRecoveryTarget(target, endpointManager, recover);
      } catch (error) {
        const disposition = operationRecoveryFailureDisposition(error, target);
        const current = operations.get(operation.id);
        if (disposition === "retry" && current && (current.state === "dispatched" || current.state === "uncertain")) {
          transientTargets.set(operation.id, target);
        }
        else if (disposition === "wait_for_endpoint") waitingForEndpoint = true;
        // Leave the operation uncertain unless authoritative state proves its exact outcome.
      }
      const current = operations.get(operation.id);
      return current?.state === "dispatched" || current?.state === "uncertain";
    });
    return {
      outcome: { attempted, transientRetry: transientTargets.size > 0, waitingForEndpoint },
      transientTargets,
    };
  }

  async function prepareChatAttachment(owner: string, relativePath: string, scopeId: string, requestedId: FileHandleId, recoveryLease?: EndpointWorkLease) {
    if (owner === "assistant") {
      return attachments.prepareOutbound(scopeId, assistantDir, relativePath, undefined, undefined, requestedId);
    }
    const session = registry.get(owner);
    if (!session) throw new AppError("UNKNOWN_SESSION", `unknown session: ${owner}`);
    if (session.lifecycle_state !== "managed") throw new AppError("SESSION_DETACHED", `${owner} is not managed`);
    if (recoveryLease && recoveryLease.endpointId !== session.endpoint) throw new AppError("ENDPOINT_UNAVAILABLE", "worker endpoint changed during attachment recovery");
    return workerFiles.prepareProjectFile({
      endpointId: session.endpoint,
      projectRoot: session.project_dir,
      mapping: session,
      ...(recoveryLease ? { lease: recoveryLease } : {}),
      scopeId,
      relativePath,
      requestedId,
    });
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

  async function reconcileStartupLifecycleState(): Promise<void> {
    const excluded = lifecycleOwnedEndpointIds();
    const endpointIds = [...new Set(Object.values(registry.snapshot().sessions).map((session) => session.endpoint))]
      .filter((endpointId) => !excluded.has(endpointId) && endpointManager.desiredState(endpointId) === "automatic");
    if (endpointIds.length === 0) {
      reconcileExternalOwnershipReleases();
      return;
    }
    for (const endpointId of endpointIds) await reconcileLifecycleState({ endpointId });
  }

  async function resumeStartupManagedSessions(): Promise<void> {
    const excluded = lifecycleOwnedEndpointIds();
    const endpointIds = [...new Set(Object.values(registry.managedSnapshot().sessions).map((session) => session.endpoint))]
      .filter((endpointId) => !excluded.has(endpointId) && endpointManager.desiredState(endpointId) === "automatic");
    for (const endpointId of endpointIds) {
      await resumeManagedSessions(endpointId);
      endpointReadyBuffer?.acknowledge(endpointId);
    }
  }

  async function resumeManagedSessions(endpointFilter?: string, unavailableOnly = false): Promise<void> {
    if (!unavailableOnly) {
      for (const session of Object.values(registry.managedSnapshot().sessions)) {
        if (endpointFilter && session.endpoint !== endpointFilter) continue;
        const state = runtime.getSession(session.endpoint, session.thread_id, session.mapping_id);
        if (state?.managementState === "managed") {
          runtime.setSession(session.endpoint, session.thread_id, session.mapping_id, "unavailable", state.nativeStatus);
        }
      }
    }
    const reconciledEndpoints = new Set<string>();
    for (const [nickname, session] of Object.entries(registry.managedSnapshot().sessions)) {
      if (endpointFilter && session.endpoint !== endpointFilter) continue;
      if (!managedSessionNeedsRecovery(runtime.getSession(session.endpoint, session.thread_id, session.mapping_id), unavailableOnly)) continue;
      reconciledEndpoints.add(session.endpoint);
      try {
        const response = await lifecycle.reconcileManaged(nickname, session);
        const activeTurn = [...(response.thread.turns ?? [])].reverse().find((turn: any) => !isTerminalStatus(turn.status));
        if (activeTurn) pool.restoreObservedActiveTurn(session.endpoint, session.thread_id, activeTurn.id);
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
          const state = runtime.getSession(session.endpoint, session.thread_id, session.mapping_id);
          if (state?.managementState !== "unadopting") {
            runtime.setSession(session.endpoint, session.thread_id, session.mapping_id, "unavailable", "notLoaded");
            warnSessionUnavailable(nickname, session.endpoint, session.thread_id);
          }
          dashboardStore.observeLifecycle({ endpointId: session.endpoint, threadId: session.thread_id }, Date.now());
        }
      }
    }
    if (!unavailableOnly && endpointFilter && !reconciledEndpoints.has(endpointFilter)
      && !Object.values(registry.managedSnapshot().sessions).some((session) => session.endpoint === endpointFilter)) {
      reconciledEndpoints.add(endpointFilter);
    }
    for (const endpointId of reconciledEndpoints) {
      await reconcileOwnershipBeforeRelayWithLease(endpointManager, ownershipWatcher, relay, endpointId, async () => {
        await pool.reconcileEndpointClaims(endpointId);
        await observations.drain(endpointId);
      });
    }
  }

  function recoverProjectEndpoint(endpointId: string): Promise<void> {
    const existing = projectEndpointRecoveries.get(endpointId);
    if (existing) return existing;
    const recovery = (async () => {
      await reconcileLifecycleState({ endpointId });
      await resumeManagedSessions(endpointId);
      await operationReconciler?.endpointReady(endpointId);
      deliveries.prepare({
        id: `endpoint-recovered:${endpointId}:${endpointIncident}`,
        kind: "system_warning",
        binding: currentOwnerBinding(),
        body: `[system] ${endpointId} app-server reconnected`,
        mandatory: true,
      });
      await renderDashboardSafely();
    })().finally(() => { if (projectEndpointRecoveries.get(endpointId) === recovery) projectEndpointRecoveries.delete(endpointId); });
    projectEndpointRecoveries.set(endpointId, recovery);
    return recovery;
  }

  async function handleEndpointUnavailable(target: ManagedAppServerEndpoint, kind: EndpointLossKind = "runtime-lost"): Promise<void> {
    if (stopping || !endpointsCommitted) return;
    relay.endpointUnavailable(target.id);
    endpointIncident += 1;
    if (target.id === assistantEndpoint.id) endpointReadyBuffer?.pause();
    pool.markEndpointUnavailable(target.id, kind);
    operationReconciler?.endpointUnavailable(target.id);
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
    if (target.id === assistantEndpoint.id) scheduleReconnect(assistantEndpoint);
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
      await reconcileLifecycleState({ endpointId: target.id });
      await resumeManagedSessions(endpoint.id);
      await operationReconciler?.endpointReady(target.id);
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
      await operationReconciler?.endpointReady(target.id);
      assistantToolReadiness.ready();
      schedulerAccepting = true;
    }
    await endpointReadyBuffer?.acceptAndDrain();
    reconnectAttempts.set(target.id, 0);
    await enqueuePendingEvents();
  }

  async function isolateLifecycleRecoveryFailure(nickname: string, session: RegistrySession): Promise<void> {
    const current = registry.get(nickname);
    if (!current || current.mapping_id !== session.mapping_id || current.endpoint !== session.endpoint || current.thread_id !== session.thread_id) return;
    runtime.setSession(session.endpoint, session.thread_id, session.mapping_id, "unavailable", "notLoaded");
    dashboardStore.observeLifecycle({ endpointId: session.endpoint, threadId: session.thread_id }, Date.now());
    warnSessionUnavailable(nickname, session.endpoint, session.thread_id);
  }

  async function verifySessionCwd(endpointId: string, actual: string, expected: string, existingLease?: EndpointWorkLease): Promise<void> {
    await endpointManager.runWithWorkLease(endpointId, existingLease, async (lease) => {
      const prepared = await workspaceRouter.prepareExisting(endpointId, actual, lease);
      await workspaceRouter.assertDispatchable(endpointId, prepared, lease);
      if (prepared.path !== expected) throw new Error("registered project directory does not match thread cwd");
    });
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

  function reconcileExternalOwnershipReleases(): number {
    const inserted = ownershipEvents.reconcileReleased(registry);
    if (inserted > 0 && schedulerAccepting) enqueuePendingEvents();
    return inserted;
  }

  async function reconcileLifecycleState(filter: { endpointId?: string; nickname?: string } = {}): Promise<void> {
    const inserted = await reconcileLifecycleAndOwnership(lifecycle, isolateLifecycleRecoveryFailure, ownershipEvents, registry, filter);
    if (inserted > 0 && schedulerAccepting) enqueuePendingEvents();
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
    backgroundFailureReporter.report(label);
  }

  function recordScheduledBackgroundFailure(label: string, episode: string): void {
    backgroundFailureReporter.report(label, { episode, notifyAfter: scheduledFailureThreshold });
  }

  return composeApp(phases, {
    maintenance: {
      intervalMs: 60_000,
      run: runMaintenance,
      onFailure: handleMaintenanceFailure,
      onSuccess: () => { backgroundFailureReporter.resolve(maintenanceFailureEpisode); },
    },
  });

  async function runMaintenance(): Promise<void> {
    dashboardStore.assertMetadataHealthy();
    await attachments.cleanupExpired();
    discovery.cleanupExpired();
    reconcileDeliveryEvents();
    await reconcileOperations();
    const managedEndpointIds = [...new Set(Object.values(registry.managedSnapshot().sessions).map((session) => session.endpoint))];
    const projectCycle = createFailureCycle({
      onFailed: () => { recordScheduledBackgroundFailure("periodic project reconciliation", projectReconciliationFailureEpisode); },
      onResolved: () => { backgroundFailureReporter.resolve(projectReconciliationFailureEpisode); },
    });
    for (const endpointId of managedEndpointIds) {
      let target: ManagedAppServerEndpoint;
      try { target = endpointManager.endpointGeneration(endpointId).endpoint; }
      catch { projectCycle.inconclusive(); continue; }
      if (target.state !== "ready") { projectCycle.inconclusive(); continue; }
      try {
        await reconcileOwnershipBeforeRelayWithLease(endpointManager, ownershipWatcher, relay, endpointId, async () => {
          await observations.drain(endpointId);
        });
        projectCycle.succeeded();
      } catch { projectCycle.failed(); }
    }
    projectCycle.finish();
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
    await reconcileLifecycleState();
    const managedRecoveryCycle = createFailureCycle({
      onFailed: () => { recordScheduledBackgroundFailure("periodic managed session recovery", managedRecoveryFailureEpisode); },
      onResolved: () => { backgroundFailureReporter.resolve(managedRecoveryFailureEpisode); },
    });
    for (const endpointId of managedEndpointIds) {
      let target: ManagedAppServerEndpoint;
      try { target = endpointManager.endpointGeneration(endpointId).endpoint; }
      catch { managedRecoveryCycle.inconclusive(); continue; }
      if (target.state !== "ready") { managedRecoveryCycle.inconclusive(); continue; }
      try { await resumeManagedSessions(endpointId, true); managedRecoveryCycle.succeeded(); }
      catch { managedRecoveryCycle.failed(); }
    }
    managedRecoveryCycle.finish();
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

async function settleAll(promises: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(promises);
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (errors.length > 0) throw new AggregateError(errors, "one or more chat adapters failed to stop");
}

async function shutdownAdapter(adapter: ChatAdapter): Promise<void> {
  let first: unknown;
  try { await adapter.stop(); } catch (error) { first = error; }
  try { await adapter.close(); } catch (error) { first ??= error; }
  if (first) throw first;
}

function adapterPrimaryBinding(adapter: ChatAdapter | undefined, expectedId: string): ConversationBinding | undefined {
  if (!adapter) return undefined;
  const binding = (adapter as ChatAdapter & { primaryBinding?: ConversationBinding }).primaryBinding;
  if (!binding || binding.adapterId !== expectedId) throw new AppError("CONFIGURATION_ERROR", `${expectedId} primary binding is unavailable`);
  return binding;
}

function unavailablePrimary(label: string): never {
  throw new AppError("CONFIGURATION_ERROR", `${label} primary direct message is unavailable`);
}

function isRetryableWeixinIngressFailure(error: unknown): boolean {
  return authorizationIncident(error) !== undefined || (error instanceof WeixinApiError
    && new Set(["authorization", "rate_limit", "service", "unknown"]).has(error.category));
}
