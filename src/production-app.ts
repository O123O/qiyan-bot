import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { AttachmentStore, type FileHandleId } from "./attachments/store.ts";
import { AttachmentCleanup, type CleanupTimers } from "./attachments/cleanup.ts";
import type { ChatAdapter } from "./chat-apps/shared/contracts.ts";
import type { ConversationBinding, JsonValue } from "./chat-apps/shared/binding.ts";
import { ChatAdapterRegistry } from "./chat-apps/shared/adapter-registry.ts";
import { OwnerRouteCatalog, OwnerRouteStore } from "./chat-apps/shared/owner-route-store.ts";
import type { ChatHistoryRequest } from "./chat-apps/shared/contracts.ts";
import { DeliveryWorker } from "./chat-apps/shared/delivery-worker.ts";
import type { ChatAppDeps } from "./chat-apps/shared/plugin.ts";
import { CHAT_APPS } from "./chat-apps/registry.ts";
import {
  chatAttachmentDeliveryId,
  chatAttachmentFileHandle,
  chatMessageDeliveryId,
  createChatOutputActions,
} from "./chat-apps/shared/output-actions.ts";
import { LocalAppServerRuntime } from "./app-server/local-runtime.ts";
import { EndpointAuthenticationRequiredError, ManagedAppServerEndpoint } from "./app-server/managed-endpoint.ts";
import { AppServerPool } from "./app-server/pool.ts";
import { RpcRequestTimeoutError } from "./app-server/rpc-client.ts";
import { MINIMUM_SUPPORTED_CODEX_VERSION } from "./app-server/protocol.ts";
import { composeApp, type AppPhase, type BotApp } from "./app.ts";
import type { BotConfig } from "./config.ts";
import { AppError } from "./core/errors.ts";
import { runBackground } from "./core/background.ts";
import {
  createBackgroundFailureReporter,
  createFailureCycle,
  type BackgroundFailureNotice,
} from "./core/background-failure-reporter.ts";
import type { OperationalEvent, OperationalEventSink } from "./core/operational-log.ts";
import type { CanonicalChatSource, ManagementState, OperationState } from "./core/types.ts";
import { SessionDashboard } from "./assistant/session-dashboard.ts";
import { activateAssistantProfileIdentity, resumeAssistantIdentity } from "./assistant/identity.ts";
import { assistantAuthenticationStartupError, recordAssistantAuthenticationFailure } from "./assistant/auth-recovery.ts";
import { buildAssistantChildEnvironment, prepareAssistantProfile, type PreparedAssistantProfile } from "./assistant/profile.ts";
import { AssistantRuntime } from "./assistant/runtime.ts";
import { AssistantScheduler } from "./assistant/scheduler.ts";
import { ConversationDispatcher, type AssistantTurnPort } from "./assistant/conversation-dispatcher.ts";
import {
  AssistantLifecycleBuffer,
  parseAssistantLifecycleNotification,
  type AssistantTurnLifecycleNotification,
} from "./assistant/lifecycle-buffer.ts";
import { AttemptScope } from "./assistant/attempt-scope.ts";
import { SessionObservationProcessor } from "./assistant/session-observer.ts";
import { createAssistantTools, type AssistantToolName, type ToolHandler } from "./assistant/tools.ts";
import { prepareAssistantWorkspace } from "./assistant/workspace.ts";
import { EventRelay } from "./events/relay.ts";
import { persistDeliveryStateEvent, reconcileDeliveryStateEvents } from "./events/delivery-status.ts";
import { buildWorkerChildEnvironment, assistantTurnConfig, LoopbackMcpServer, ToolReadinessGate } from "./mcp/server.ts";
import { SessionRegistry, type RegistrySession } from "./registry/session-registry.ts";
import { SessionDiscovery } from "./sessions/discovery.ts";
import { FinalMessageStore } from "./sessions/final-messages.ts";
import { SessionLifecycle } from "./sessions/lifecycle.ts";
import { OwnershipEventStore } from "./sessions/ownership-event-store.ts";
import {
  ExternalOwnershipMonitor,
  SessionOwnershipWatcher,
  type ExternalOwnershipCycleResult,
  type ExternalOwnershipReleaseStatus,
  type ExternalTurnIncident,
} from "./sessions/ownership-watcher.ts";
import { createAppServerRolloutPathResolver, SessionOwnershipGuard } from "./sessions/rollout-ownership.ts";
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
import { SessionDashboardStore } from "./storage/session-dashboard-store.ts";
import type { SlackContextService } from "./chat-apps/slack/context-service.ts";
import { SlackChatAdapter } from "./chat-apps/slack/chat-adapter.ts";
import type { WeixinCredentialHandle } from "./chat-apps/weixin/credential-store.ts";
import { WeixinApiClient, WeixinApiError } from "./chat-apps/weixin/api-client.ts";
import { WeixinAccountStore } from "./chat-apps/weixin/account-store.ts";
import { WeixinInboxStore } from "./chat-apps/weixin/inbox-store.ts";
import { WeixinIngressWorker } from "./chat-apps/weixin/ingress-worker.ts";
import { WeixinOutboundStore } from "./chat-apps/weixin/outbound-store.ts";
import { WeixinDeliveryAdapter } from "./chat-apps/weixin/delivery-adapter.ts";
import { authorizationIncident, WeixinChatAdapter } from "./chat-apps/weixin/chat-adapter.ts";
import { WeixinIncidentRouter } from "./chat-apps/weixin/incident-router.ts";
import { EndpointCatalog } from "./endpoints/catalog.ts";
import { EndpointBindingStore } from "./endpoints/binding-store.ts";
import { EndpointManager } from "./endpoints/manager.ts";
import { SshGenerationPlanner } from "./endpoints/ssh-config.ts";
import { attestUserControlMaster, prepareRemoteHost, type RemoteHost, SshRemoteClient, SshRuntime } from "./endpoints/ssh-runtime.ts";
import { SshClaudeCommandRunner } from "./endpoints/ssh-claude-command-runner.ts";
import { SshAppServerRuntime } from "./endpoints/ssh-app-server-runtime.ts";
import { prepareLocalSshEndpointSocketRoot, prepareLocalSshRuntimeRoot } from "./endpoints/local-runtime.ts";
import { WebSocketWire } from "./app-server/websocket-wire.ts";
import { SshHost } from "./endpoints/ssh-host.ts";
import { WorkspaceRouter } from "./endpoints/workspace-router.ts";
import {
  parseRuntimeIdentity,
  type EndpointLossKind,
  type EndpointWorkLease,
  type ManagedAppServerEndpoint as ManagedEndpointContract,
  type RuntimeIdentity,
} from "./endpoints/types.ts";
import { WorkerFileBridge } from "./endpoints/worker-file-bridge.ts";
import { EndpointCapacityRecovery, recoverableCapacityHint } from "./endpoints/capacity-recovery.ts";
import { RolloutAccessRouter } from "./endpoints/rollout-access.ts";
import { ClaudeCodeRuntime } from "./endpoints/claude-runtime.ts";
import { LocalClaudeCommandRunner, type ClaudeLaunchFlags } from "./endpoints/claude-command-runner.ts";
import { scanLocalClaudeTranscript } from "./sessions/claude-transcript.ts";
import { ClaudeGoalStore } from "./sessions/claude-goals.ts";
import { ClaudeGoalDriver } from "./sessions/claude-goal-driver.ts";
import { SchedulingService } from "./scheduling/scheduling-service.ts";
import type { ScheduleRow } from "./scheduling/schedule-store.ts";

// Runs a monitor schedule's shell predicate on the QiYan host; true iff exit 0. Only
// wired for LOCAL Claude sessions (host == QiYan host), so this is not a cross-host
// escalation. When a REMOTE worker endpoint is added, its monitors MUST run over that
// session's ssh channel, not here — gate on endpoint locality before that ships.
// `bash -c` (not -l) so it does not source the operator's login profile.
function runMonitorCheck(command: string, timeoutMs = 20_000): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { stdio: "ignore" });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(false); }, timeoutMs);
    timer.unref?.();
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

const assistantAssetRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/assistant");
const remoteAssetRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/remote");
const fullAccessWarning = "QiYan assistant is running non-interactively with full filesystem access and approvals disabled.";
const assistantMappingId = "assistant";
const scheduledFailureThreshold = 3;
const externalOwnershipFailureEpisode = "external-ownership-detection";

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

type AssistantTerminalTurn = {
  id: string;
  status: string;
  itemsView: string;
  items: Array<Record<string, unknown>>;
  error?: unknown;
};

export async function resolveAssistantTerminalTurn<T extends AssistantTerminalTurn>(
  notification: T,
  readTurns: () => Promise<T[]>,
): Promise<T> {
  if (notification.itemsView === "full") return notification;
  let turns: T[];
  try { turns = await readTurns(); }
  catch { return notification; }
  const candidate = turns.find((turn) => turn.id === notification.id);
  if (!candidate || candidate.itemsView !== "full" || candidate.status !== notification.status) return notification;
  // Only adopt the history turn when it still contains everything the notification observed;
  // a divergent/empty "full" read must not drop a final the notification already captured.
  const retainsNotification = notification.items.every((item) => {
    const id = item.id;
    if (typeof id !== "string") return false;
    const match = candidate.items.find((value) => value.id === id);
    return !!match && Object.entries(item).every(([key, value]) => isDeepStrictEqual(match[key], value));
  });
  return retainsNotification ? candidate : notification;
}

export async function commitAssistantTerminalFinals<T extends AssistantTerminalTurn>(
  notification: T,
  readTurns: () => Promise<T[]>,
  commit: (turn: T) => void | Promise<void>,
): Promise<void> {
  const turn = await resolveAssistantTerminalTurn(notification, readTurns);
  await commit(turn);
}

export function createAttachmentCleanupOwner(
  cleanup: () => Promise<number>,
  report: OperationalEventSink,
  timers?: CleanupTimers,
): AttachmentCleanup {
  return new AttachmentCleanup(
    cleanup,
    () => reportOperationalSafely(report, {
      level: "warn", code: "background_task_failed", component: "attachment_cleanup",
    }),
    timers,
  );
}

export function createExternalOwnershipCycleReporter(options: {
  runId?: string;
  onOperational(): void;
  onDegraded(notice: BackgroundFailureNotice): void;
}): (results: readonly ExternalOwnershipCycleResult[]) => void {
  const reporter = createBackgroundFailureReporter({
    ...(options.runId ? { runId: options.runId } : {}),
    onOperational: () => { options.onOperational(); },
    onDurable: options.onDegraded,
  });
  return (results) => {
    const cycle = createFailureCycle({
      onFailed: () => {
        reporter.report("external session ownership detection", {
          episode: externalOwnershipFailureEpisode,
          notifyAfter: scheduledFailureThreshold,
        });
      },
      onResolved: () => { reporter.resolve(externalOwnershipFailureEpisode); },
    });
    for (const result of results) {
      if (result.outcome === "failed") cycle.failed();
      else if (result.outcome === "inconclusive") cycle.inconclusive();
      else cycle.succeeded();
    }
    cycle.finish();
  };
}

export type OperationRecoveryAction = "wait_for_tool" | "attempt";

export function operationRecoveryAction(input: {
  state: RecoverableOperation["state"];
  activeHandler: boolean;
  recoveryOwned?: boolean;
}): OperationRecoveryAction {
  return input.activeHandler && !(input.state === "uncertain" && input.recoveryOwned) ? "wait_for_tool" : "attempt";
}

export async function stopOperationRecoveryBeforeTools(dependencies: {
  stopOperationRecovery(): Promise<void>;
  waitForTools(): Promise<void>;
}): Promise<void> {
  let stopping: Promise<void>;
  try { stopping = dependencies.stopOperationRecovery(); }
  catch (error) { stopping = Promise.reject(error); }
  let waiting: Promise<void>;
  try { waiting = dependencies.waitForTools(); }
  catch (error) { waiting = Promise.reject(error); }
  const [stopped, tools] = await Promise.allSettled([stopping, waiting]);
  if (stopped.status === "rejected") throw stopped.reason;
  if (tools.status === "rejected") throw tools.reason;
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
      if (accepting) {
        pending.delete(endpointId);
        return requestRecovery(endpointId);
      }
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

export type ProjectReadyRecoveryDisposition = "retry" | "publication" | "retain";

export function projectReadyRecoveryDisposition(
  error: unknown,
  failedGeneration: number,
  current: { generation: number; ready: boolean; automatic: boolean } | undefined,
): ProjectReadyRecoveryDisposition {
  const sameReadyGeneration = current?.generation === failedGeneration && current.ready && current.automatic;
  if (error instanceof RpcRequestTimeoutError
    || (error instanceof AppError && error.details?.recovery === "ownership_unclassified")) {
    return sameReadyGeneration ? "retry" : "publication";
  }
  if (error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE") {
    return sameReadyGeneration ? "retry" : "publication";
  }
  return "retain";
}

export class EndpointRecoveryIncidents {
  private sequence = 0;
  private readonly incidents = new Map<string, number>();

  record(endpointId: string): number {
    this.sequence += 1;
    this.incidents.set(endpointId, this.sequence);
    return this.sequence;
  }

  pending(endpointId: string): number | undefined { return this.incidents.get(endpointId); }

  consume(endpointId: string, incident: number): boolean {
    if (this.incidents.get(endpointId) !== incident) return false;
    this.incidents.delete(endpointId);
    return true;
  }

  get latestSequence(): number { return this.sequence; }
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
    const endpointId = target.policy === "ready_endpoint" || target.policy === "endpoint_lifecycle"
      ? target.endpointId
      : undefined;
    if (endpointId && blockedEndpoints.has(endpointId)) continue;
    if (await attempt(entry, target) && endpointId) blockedEndpoints.add(endpointId);
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
      return recoverableCreateHasNoDispatch(operation.receipt, 0) ? { policy: "local" } : projectTarget();
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

type SequencedRecoverableOperation = Pick<RecoverableOperation, "sequence" | "kind" | "args" | "receipt">;

export function hasEarlierEndpointOperation(
  operations: readonly SequencedRecoverableOperation[],
  currentSequence: number,
  endpointId: string,
  resolver: OperationRecoveryTargetResolver,
): boolean {
  return operations.some((operation) => {
    if (operation.sequence >= currentSequence) return false;
    const target = recoverableOperationTarget(operation, resolver);
    return (target.policy === "ready_endpoint" || target.policy === "endpoint_lifecycle")
      && target.endpointId === endpointId;
  });
}

export function hasEarlierSessionCreation(
  operations: readonly SequencedRecoverableOperation[],
  currentSequence: number,
  current: { nickname: string; endpointId: string; threadId?: string },
  resolver: OperationRecoveryTargetResolver,
): boolean {
  return operations.some((operation) => {
    if (operation.sequence >= currentSequence || (operation.kind !== "create_session" && operation.kind !== "adopt_session")) return false;
    const args = operation.args && typeof operation.args === "object" ? operation.args as Record<string, unknown> : {};
    if (args.nickname === current.nickname) return true;
    if (!current.threadId) return false;
    const target = recoverableOperationTarget(operation, resolver);
    if (target.policy !== "ready_endpoint" || target.endpointId !== current.endpointId) return false;
    const priorThreadId = stringField(operation.receipt, "threadId") ?? stringField(args, "thread_id");
    return priorThreadId === current.threadId;
  });
}

export function recoverableOperationActivationReferences(
  operations: readonly Pick<RecoverableOperation, "kind" | "args" | "receipt">[],
  resolver: OperationRecoveryTargetResolver,
): string[] {
  const references = new Set<string>();
  for (const operation of operations) {
    const target = recoverableOperationTarget(operation, resolver);
    if (target.policy === "ready_endpoint") references.add(target.endpointId);
  }
  return [...references].sort();
}

export function startupProjectEndpointReferences(options: {
  sessionEndpoints: readonly string[];
  recoveredEndpointIds: readonly string[];
  operationEndpointIds: readonly string[];
  lifecycleOwnedEndpointIds: ReadonlySet<string>;
  assistantEndpointId: string;
}): string[] {
  return [...new Set([
    ...options.sessionEndpoints,
    ...options.recoveredEndpointIds,
    ...options.operationEndpointIds,
  ])].filter((endpointId) => endpointId !== options.assistantEndpointId
    && !options.lifecycleOwnedEndpointIds.has(endpointId));
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

export function recoverableCreateHasNoDispatch(receipt: unknown, recoveryProtocol: number): boolean {
  if (receipt === undefined) return recoveryProtocol >= 1;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  return Object.hasOwn(receipt, "dispatchStarted")
    && (receipt as Record<string, unknown>).dispatchStarted === false;
}

export function isMissingUnmaterializedThread(error: unknown, threadId: string): boolean {
  return error instanceof AppError
    && error.code === "THREAD_NOT_FOUND"
    && error.details?.recovery === "thread_not_durable"
    && error.details.threadId === threadId;
}

// reconcileManaged's create-completion durability gate drops the phantom mapping and throws
// THREAD_NOT_FOUND with recovery "pathless_thread_lost"; "thread_not_durable" is accepted
// defensively so any future non-durable signal on this path fails the create with no effect.
function isRecoveredThreadNotDurable(error: unknown): boolean {
  return error instanceof AppError
    && error.code === "THREAD_NOT_FOUND"
    && (error.details?.recovery === "pathless_thread_lost" || error.details?.recovery === "thread_not_durable");
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
  exactGenerationReady = false,
): OperationRecoveryFailureDisposition {
  if (error instanceof RpcRequestTimeoutError
    || (error instanceof AppError && error.details?.recovery === "ownership_unclassified")) {
    return target?.policy === "ready_endpoint" && !exactGenerationReady ? "wait_for_endpoint" : "retry";
  }
  if (error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE") {
    return target?.policy === "endpoint_lifecycle" || (target?.policy === "ready_endpoint" && exactGenerationReady)
      ? "retry"
      : "wait_for_endpoint";
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
  waitForTerminal(operationId: string, signal?: AbortSignal): Promise<void>;
  recoveryOwns(operationId: string): boolean;
  endpointReady(endpointId: string): Promise<void>;
  endpointUnavailable(endpointId: string): void;
  stop(): Promise<void>;
}

export function createOperationReconciliationLoop(options: {
  reconcileOnce(): Promise<OperationReconciliationPass>;
  isEndpointReady(endpointId: string): boolean;
  operationState?(operationId: string): OperationState | undefined;
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
  let ownedPassFailureRetryActive = false;
  let transientTargets = new Map<string, OperationRecoveryTarget>();
  const recoveryOwnedOperations = new Set<string>();
  type TerminalWaiter = { resolve(): void; reject(error: Error): void; detach(): void };
  const terminalWaiters = new Map<string, Set<TerminalWaiter>>();

  const removeTerminalWaiter = (operationId: string, waiter: TerminalWaiter): void => {
    waiter.detach();
    const waiters = terminalWaiters.get(operationId);
    waiters?.delete(waiter);
    if (waiters?.size === 0) terminalWaiters.delete(operationId);
  };

  const settleTerminalWaiters = (): void => {
    if (!options.operationState) return;
    for (const operationId of recoveryOwnedOperations) {
      const state = options.operationState(operationId);
      if (state !== "succeeded" && state !== "failed") continue;
      recoveryOwnedOperations.delete(operationId);
      const waiters = terminalWaiters.get(operationId) ?? new Set<TerminalWaiter>();
      terminalWaiters.delete(operationId);
      for (const waiter of waiters) {
        waiter.detach();
        waiter.resolve();
      }
    }
  };

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
      try {
        finalPass = await options.reconcileOnce();
      } catch (error) {
        if (!stopped && recoveryOwnedOperations.size > 0) {
          ownedPassFailureRetryActive = true;
          armRetryTimer();
        }
        throw error;
      }
      ownedPassFailureRetryActive = false;
      settleTerminalWaiters();
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
      const current = running;
      return current.then(() => {
        if (!stopped && followupRequested) return request();
      });
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
    waitForTerminal: (operationId, signal) => {
      if (!options.operationState) return Promise.reject(new Error("operation terminal state reader is unavailable"));
      if (stopped) return Promise.reject(new Error("operation reconciliation stopped"));
      const state = options.operationState(operationId);
      if (state === "succeeded" || state === "failed") return Promise.resolve();
      if (state !== "uncertain") return Promise.reject(new Error("only an uncertain operation can be handed to reconciliation"));
      const newlyOwned = !recoveryOwnedOperations.has(operationId);
      recoveryOwnedOperations.add(operationId);
      const pending = new Promise<void>((resolve, reject) => {
        let abort: (() => void) | undefined;
        const waiter: TerminalWaiter = {
          resolve,
          reject,
          detach: () => { if (abort) signal?.removeEventListener("abort", abort); },
        };
        abort = () => {
          removeTerminalWaiter(operationId, waiter);
          reject(signal?.reason instanceof Error ? signal.reason : new Error("operation terminal wait was canceled"));
        };
        const waiters = terminalWaiters.get(operationId) ?? new Set<TerminalWaiter>();
        waiters.add(waiter);
        terminalWaiters.set(operationId, waiters);
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
      settleTerminalWaiters();
      if (newlyOwned && recoveryOwnedOperations.has(operationId)) void request().catch(() => undefined);
      return pending;
    },
    recoveryOwns: (operationId) => recoveryOwnedOperations.has(operationId),
    endpointReady: () => request(),
    endpointUnavailable: () => {
      if (!ownedPassFailureRetryActive && ![...transientTargets.values()].some(isActionable)) clearRetryTimer(false);
    },
    stop: async () => {
      if (!stopped) {
        stopped = true;
        const error = new Error("operation reconciliation stopped");
        for (const waiters of terminalWaiters.values()) for (const waiter of waiters) {
          waiter.detach();
          waiter.reject(error);
        }
        terminalWaiters.clear();
        recoveryOwnedOperations.clear();
        ownedPassFailureRetryActive = false;
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

export async function settleAssistantTerminalTools(dependencies: {
  fenceTools(): Promise<"settled" | "timed_out">;
  reconcileOperations(): Promise<void>;
  requestRestartOnce(): void;
}): Promise<boolean> {
  if (await dependencies.fenceTools() === "timed_out") {
    dependencies.requestRestartOnce();
    return false;
  }
  await dependencies.reconcileOperations();
  return true;
}

export function markEndpointOwnersUnavailable(dependencies: {
  relay: Pick<EventRelay, "endpointUnavailable">;
  observations: Pick<SessionObservationProcessor, "endpointUnavailable">;
  managed: Pick<ManagedSessionRecoveryOwner, "endpointUnavailable">;
  operations: { endpointUnavailable(endpointId: string): void };
}, endpointId: string): void {
  dependencies.relay.endpointUnavailable(endpointId);
  dependencies.observations.endpointUnavailable(endpointId);
  dependencies.managed.endpointUnavailable(endpointId);
  dependencies.operations.endpointUnavailable(endpointId);
}

export interface DurableEventWakeBoundary {
  wakeAfterDurableCommit(inserted: boolean): Promise<void>;
  requestRestartOnce(): void;
}

export function createDurableEventWakeBoundary(options: {
  schedulerAccepting(): boolean;
  stopping(): boolean;
  enqueuePendingEvents(): Promise<void>;
  requestRestart(): void;
}): DurableEventWakeBoundary {
  let restartRequested = false;
  const requestRestartOnce = (): void => {
    if (restartRequested) return;
    restartRequested = true;
    options.requestRestart();
  };
  return {
    requestRestartOnce,
    wakeAfterDurableCommit: async (inserted) => {
      if (!inserted || !options.schedulerAccepting() || options.stopping()) return;
      try { await options.enqueuePendingEvents(); }
      catch { requestRestartOnce(); }
    },
  };
}

export interface EndpointUnavailableEvent {
  id: string;
  endpointId: string;
  threadId: string;
  incident: number;
  createdAt: number;
}

export interface DurableEventSourceCallbacks {
  relayCommitted(): Promise<void>;
  deliveryState(delivery: DeliveryRecord): Promise<boolean>;
  reconcileDeliveryStates(): Promise<number>;
  ownership(incident: ExternalTurnIncident, status: ExternalOwnershipReleaseStatus): Promise<boolean>;
  reconcileOwnership(): Promise<number>;
  endpointUnavailable(event: EndpointUnavailableEvent): Promise<boolean>;
  backgroundFailure(notice: BackgroundFailureNotice): void;
  reconcileLifecycle(filter: { endpointId?: string; nickname?: string }): Promise<number>;
}

export function createDurableEventSourceCallbacks(options: {
  wakeAfterDurableCommit(inserted: boolean): Promise<void>;
  persistDeliveryState(delivery: DeliveryRecord): boolean;
  reconcileDeliveryStates(): number;
  recordOwnership(incident: ExternalTurnIncident, status: ExternalOwnershipReleaseStatus): boolean;
  reconcileOwnership(): number;
  persistEndpointUnavailable(event: EndpointUnavailableEvent): boolean;
  recordBackgroundFailure(notice: BackgroundFailureNotice): void;
  reconcileLifecycle(filter: { endpointId?: string; nickname?: string }): Promise<number>;
}): DurableEventSourceCallbacks {
  return {
    relayCommitted: () => options.wakeAfterDurableCommit(true),
    deliveryState: async (delivery) => {
      const inserted = options.persistDeliveryState(delivery);
      await options.wakeAfterDurableCommit(inserted);
      return inserted;
    },
    reconcileDeliveryStates: async () => {
      const inserted = options.reconcileDeliveryStates();
      await options.wakeAfterDurableCommit(inserted > 0);
      return inserted;
    },
    ownership: async (incident, status) => {
      const inserted = options.recordOwnership(incident, status);
      await options.wakeAfterDurableCommit(inserted);
      return inserted;
    },
    reconcileOwnership: async () => {
      const inserted = options.reconcileOwnership();
      await options.wakeAfterDurableCommit(inserted > 0);
      return inserted;
    },
    endpointUnavailable: async (event) => {
      const inserted = options.persistEndpointUnavailable(event);
      await options.wakeAfterDurableCommit(inserted);
      return inserted;
    },
    backgroundFailure: (notice) => {
      options.recordBackgroundFailure(notice);
      void options.wakeAfterDurableCommit(true);
    },
    reconcileLifecycle: async (filter) => {
      const inserted = await options.reconcileLifecycle(filter);
      await options.wakeAfterDurableCommit(inserted > 0);
      return inserted;
    },
  };
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

export function managedSessionNeedsRecovery(
  state: { managementState: ManagementState } | undefined,
  unavailableOnly: boolean,
): boolean {
  return unavailableOnly ? state?.managementState === "unavailable" : true;
}

export type ManagedRecoveryDisposition = "retry" | "endpoint" | "external" | "permanent";

export function managedRecoveryDisposition(error: unknown, currentReadyLease = false): ManagedRecoveryDisposition {
  if (error instanceof RpcRequestTimeoutError
    || (error instanceof AppError && error.details?.recovery === "ownership_unclassified")) return "retry";
  if (error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE") return currentReadyLease ? "retry" : "endpoint";
  if (error instanceof AppError && error.code === "SESSION_BUSY" && error.details?.recovery === "external_turn") return "external";
  return "permanent";
}

export function isSettledPathlessThreadLoss(
  error: unknown,
  current: RegistrySession | undefined,
  expected: RegistrySession,
): boolean {
  if (!(error instanceof AppError) || error.code !== "THREAD_NOT_FOUND"
    || error.details?.recovery !== "pathless_thread_lost") return false;
  return !current || current.endpoint !== expected.endpoint || current.thread_id !== expected.thread_id
    || current.mapping_id !== expected.mapping_id;
}

export function managedRecoveryManagementState(
  current: ManagementState | undefined,
  disposition: ManagedRecoveryDisposition,
): ManagementState {
  if (disposition !== "external") return "unavailable";
  return current === "unadopting" ? "unadopting" : "managed";
}

export type ManagedRetryKey = `${string}\0${string}\0${string}`;

export function managedRetryKey(endpointId: string, threadId: string, mappingId: string): ManagedRetryKey {
  return `${endpointId}\0${threadId}\0${mappingId}`;
}

function managedRetryEndpoint(key: ManagedRetryKey): string {
  return key.slice(0, key.indexOf("\0"));
}

interface ManagedRecoveryTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: any): void;
}

const nodeManagedRecoveryTimers: ManagedRecoveryTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface ManagedSessionRecoveryBatchResult {
  restored: boolean;
  restoredKeys: readonly ManagedRetryKey[];
  settledKeys: readonly ManagedRetryKey[];
  failures: readonly { key: ManagedRetryKey; disposition: ManagedRecoveryDisposition }[];
}

export interface ManagedEndpointReadyOutcome {
  recovery: "none" | "pending" | "completed";
  sharedWake: "needed" | "completed" | "stale";
}

export async function recoverReadyEndpointOwners(options: {
  recoverManaged(wakeShared: () => Promise<void>): Promise<ManagedEndpointReadyOutcome>;
  relay(): Promise<void>;
  observations(): Promise<void>;
  operations(): Promise<void>;
  onError(owner: "relay" | "observations" | "operations", error: unknown): void;
}): Promise<void> {
  const report = (owner: "relay" | "observations" | "operations", error: unknown): void => {
    try { options.onError(owner, error); }
    catch { /* Operational reporting must not suppress later owner wakes. */ }
  };
  const runOwner = async (
    owner: "relay" | "observations" | "operations",
    action: () => Promise<void>,
  ): Promise<void> => {
    try { await action(); }
    catch (error) { report(owner, error); }
  };
  let sharedWake: Promise<void> | undefined;
  const wakeShared = (): Promise<void> => {
    sharedWake ??= (async () => {
      await runOwner("relay", options.relay);
      await runOwner("observations", options.observations);
    })();
    return sharedWake;
  };

  const outcome = await options.recoverManaged(wakeShared);
  if (sharedWake) await sharedWake;
  else if (outcome.sharedWake !== "completed" && outcome.sharedWake !== "stale") await wakeShared();
  await runOwner("operations", options.operations);
}

export type ManagedOwnershipIncidentReceipt = ExternalTurnIncident;

export interface ManagedSessionRecoveryOwner {
  recordFailure(key: ManagedRetryKey, disposition: ManagedRecoveryDisposition): void;
  endpointReady(
    endpointId: string,
    lease: EndpointWorkLease,
    wakeShared?: () => Promise<void>,
  ): Promise<ManagedEndpointReadyOutcome>;
  endpointUnavailable(endpointId: string): void;
  stop(): Promise<void>;
}

export async function recoverManagedEndpointReady(
  owner: Pick<ManagedSessionRecoveryOwner, "endpointReady">,
  endpointId: string,
  lease: EndpointWorkLease,
  wakeShared: () => Promise<void>,
): Promise<ManagedEndpointReadyOutcome> {
  const result = await owner.endpointReady(endpointId, lease, wakeShared);
  if (result.sharedWake !== "needed") return result;
  await wakeShared();
  return { ...result, sharedWake: "completed" };
}

export async function recoverStartupManagedEndpoint(options: {
  endpointId: string;
  withReadyLease<T>(run: (lease: EndpointWorkLease) => Promise<T>): Promise<T>;
  isLeaseCurrent(lease: EndpointWorkLease): boolean;
  recover(
    lease: EndpointWorkLease,
    isCurrent: () => boolean,
  ): Promise<ManagedSessionRecoveryBatchResult>;
  reconcile(lease: EndpointWorkLease, isCurrent: () => boolean): Promise<void>;
  acknowledge(): void;
}): Promise<"acknowledged" | "publication"> {
  try {
    await options.withReadyLease(async (lease) => {
      const isCurrent = (): boolean => options.isLeaseCurrent(lease);
      const result = await options.recover(lease, isCurrent);
      if (!isCurrent()) {
        throw new AppError("ENDPOINT_UNAVAILABLE", `managed startup recovery generation changed: ${options.endpointId}`);
      }
      if (result.restored) {
        await options.reconcile(lease, isCurrent);
        if (!isCurrent()) {
          throw new AppError("ENDPOINT_UNAVAILABLE", `managed startup reconciliation generation changed: ${options.endpointId}`);
        }
      }
      options.acknowledge();
    });
    return "acknowledged";
  } catch (error) {
    if (error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE") return "publication";
    throw error;
  }
}

export function requireManagedRecoveryAcknowledged(
  outcome: "acknowledged" | "publication",
  endpointId: string,
): void {
  if (outcome !== "acknowledged") {
    throw new AppError("ENDPOINT_UNAVAILABLE", `managed sessions were not restored on endpoint ${endpointId}`);
  }
}

const threadGoalStatuses = new Set(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);

export function restoredGoalControlIsActive(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "goal")) {
    throw new AppError("OPERATION_UNCERTAIN", "managed goal state is invalid");
  }
  const goal = (value as { goal: unknown }).goal;
  if (goal === null) return false;
  if (!goal || typeof goal !== "object" || Array.isArray(goal)) {
    throw new AppError("OPERATION_UNCERTAIN", "managed goal state is invalid");
  }
  const status = (goal as { status?: unknown }).status;
  if (typeof status !== "string" || !threadGoalStatuses.has(status)) {
    throw new AppError("OPERATION_UNCERTAIN", "managed goal status is invalid");
  }
  return status === "active";
}

export async function recoverCancelGoalInterrupt(options: {
  requested: boolean;
  checkpoint?: { turnId?: string | null };
  goal: unknown;
  nativeStatus: string;
  turns: ReadonlyArray<{ id: string; status?: unknown }>;
  checkpointTurn(turnId: string | null): void;
  authorize(turnId: string): void;
  interrupt(turnId: string): Promise<void>;
}): Promise<boolean> {
  if (!options.requested) return true;
  if (options.goal !== null) return false;
  const activeTurn = options.nativeStatus === "active"
    ? [...options.turns].reverse().find((candidate) => !isRecoveryTerminalStatus(candidate.status))
    : undefined;
  let turnId = typeof options.checkpoint?.turnId === "string" ? options.checkpoint.turnId : undefined;
  if (activeTurn && activeTurn.id !== turnId) {
    turnId = activeTurn.id;
    options.checkpointTurn(turnId);
  }
  if (!turnId) {
    if (options.nativeStatus !== "idle") return false;
    options.checkpointTurn(null);
    return true;
  }
  options.authorize(turnId);
  const turn = options.turns.find((candidate) => candidate.id === turnId);
  if (turn && isRecoveryTerminalStatus(turn.status)) return true;
  if (!turn) return false;
  await options.interrupt(turnId);
  return true;
}

function isRecoveryTerminalStatus(status: unknown): boolean {
  const type = typeof status === "string" ? status : String((status as { type?: unknown } | null)?.type ?? "");
  return type === "completed" || type === "failed" || type === "interrupted";
}

export async function interruptCancelledGoalTurn(
  requested: boolean,
  turnId: string | null,
  interrupt: (turnId: string) => Promise<void>,
): Promise<boolean> {
  if (!requested || !turnId) return false;
  await interrupt(turnId);
  return true;
}

export function createManagedSessionRecoveryOwner(options: {
  endpoints: Pick<EndpointManager, "withReadyWorkLease">;
  isLeaseCurrent(endpointId: string, lease: EndpointWorkLease): boolean;
  recover(
    endpointId: string,
    keys: readonly ManagedRetryKey[],
    lease: EndpointWorkLease,
    isCurrent: () => boolean,
  ): Promise<ManagedSessionRecoveryBatchResult>;
  beforeShared(
    endpointId: string,
    lease: EndpointWorkLease,
    isCurrent: () => boolean,
  ): Promise<readonly ManagedOwnershipIncidentReceipt[]>;
  wakeShared(endpointId: string, lease: EndpointWorkLease, isCurrent: () => boolean): Promise<void>;
  afterShared(
    endpointId: string,
    lease: EndpointWorkLease,
    beforeIncidents: readonly ManagedOwnershipIncidentReceipt[],
    isCurrent: () => boolean,
  ): Promise<void>;
  onSafetyFailure(error: unknown): void;
  onError(error: unknown): void;
  timers?: ManagedRecoveryTimers;
  retryMs?: number;
}): ManagedSessionRecoveryOwner {
  type PendingTarget = {
    disposition: "retry" | "endpoint" | "safety";
    stage: "managed" | "before_shared" | "after_shared";
    incidents: readonly ManagedOwnershipIncidentReceipt[] | undefined;
    sharedWakeEpoch: number | undefined;
  };
  const pending = new Map<ManagedRetryKey, PendingTarget>();
  const unavailableEndpoints = new Set<string>();
  const safetyReported = new Set<string>();
  const timers = new Map<string, { handle: unknown; generation: number; epoch: number }>();
  const timerGenerations = new Map<string, number>();
  const endpointEpochs = new Map<string, number>();
  const tails = new Map<string, Promise<void>>();
  const fallbackWakes = new Map<string, { epoch: number; barrier: Promise<void> }>();
  let stopped = false;

  const report = (error: unknown): void => {
    try { options.onError(error); }
    catch { /* operational reporting must not change recovery ownership */ }
  };
  const endpointEpoch = (endpointId: string): number => endpointEpochs.get(endpointId) ?? 0;
  const advanceEndpointEpoch = (endpointId: string): number => {
    const next = endpointEpoch(endpointId) + 1;
    endpointEpochs.set(endpointId, next);
    return next;
  };
  const clearTimer = (endpointId: string): void => {
    timerGenerations.set(endpointId, (timerGenerations.get(endpointId) ?? 0) + 1);
    const timer = timers.get(endpointId);
    if (timer) (options.timers ?? nodeManagedRecoveryTimers).clearTimeout(timer.handle);
    timers.delete(endpointId);
  };
  const targetsFor = (endpointId: string, selection: "retry" | "all"): Array<[ManagedRetryKey, PendingTarget]> => [...pending]
    .filter(([key, target]) => managedRetryEndpoint(key) === endpointId && (selection === "all" || target.disposition === "retry"));
  const markEndpointWaiting = (endpointId: string): void => {
    unavailableEndpoints.add(endpointId);
    for (const [key, target] of pending) {
      if (managedRetryEndpoint(key) === endpointId) pending.set(key, { ...target, disposition: "endpoint" });
    }
    clearTimer(endpointId);
  };
  const applyFailure = (
    keys: readonly ManagedRetryKey[],
    error: unknown,
    stage: PendingTarget["stage"],
    currentReadyLease = false,
  ): void => {
    const disposition = managedRecoveryDisposition(error, currentReadyLease);
    for (const key of keys) {
      const current = pending.get(key);
      const incidents = current?.stage === stage ? current.incidents : undefined;
      const sharedWakeEpoch = current?.stage === stage ? current.sharedWakeEpoch : undefined;
      if (disposition === "retry" || disposition === "endpoint") pending.set(key, {
        disposition, stage, incidents, sharedWakeEpoch,
      });
      else if (disposition === "permanent") pending.set(key, { disposition: "safety", stage, incidents, sharedWakeEpoch });
      else pending.delete(key);
    }
    if (disposition === "endpoint" && keys.length > 0) markEndpointWaiting(managedRetryEndpoint(keys[0]!));
    if (disposition === "permanent" && keys.length > 0) {
      const endpointId = managedRetryEndpoint(keys[0]!);
      if (!safetyReported.has(endpointId)) {
        safetyReported.add(endpointId);
        try { options.onSafetyFailure(error); }
        catch { /* A safety callback must not change recovery ownership. */ }
      }
    }
    report(error);
  };
  const generationIsCurrent = (endpointId: string, epoch: number, lease: EndpointWorkLease): boolean => !stopped
    && endpointEpoch(endpointId) === epoch
    && options.isLeaseCurrent(endpointId, lease);
  const runIsCurrent = (endpointId: string, epoch: number, lease: EndpointWorkLease): boolean => generationIsCurrent(endpointId, epoch, lease)
    && !unavailableEndpoints.has(endpointId);
  const dedupeIncidents = (incidents: readonly ManagedOwnershipIncidentReceipt[]): ManagedOwnershipIncidentReceipt[] => {
    const seen = new Set<string>();
    return incidents.filter((incident) => {
      const key = `${incident.endpoint}\0${incident.thread_id}\0${incident.mapping_id}\0${incident.turnId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  let schedule!: (endpointId: string) => void;
  const run = async (endpointId: string, selection: "retry" | "all", epoch: number, existingLease?: EndpointWorkLease): Promise<ManagedEndpointReadyOutcome> => {
    if (stopped) return { recovery: "pending", sharedWake: "stale" };
    const fallbackWake = fallbackWakes.get(endpointId);
    if (fallbackWake) await fallbackWake.barrier;
    if (stopped || endpointEpoch(endpointId) !== epoch) return { recovery: "pending", sharedWake: "stale" };
    const targets = targetsFor(endpointId, selection);
    if (targets.length === 0) {
      safetyReported.delete(endpointId);
      return { recovery: "none", sharedWake: "needed" };
    }
    const targetKeys = targets.map(([key]) => key);
    const recover = async (lease: EndpointWorkLease): Promise<ManagedEndpointReadyOutcome> => {
      let sharedWakeCompleted = targets.some(([, target]) => target.sharedWakeEpoch === epoch);
      const isCurrent = (): boolean => runIsCurrent(endpointId, epoch, lease);
      const isGenerationCurrent = (): boolean => generationIsCurrent(endpointId, epoch, lease);
      const recovery = (completed = false): ManagedEndpointReadyOutcome["recovery"] => targetsFor(endpointId, "all").length > 0
        ? "pending"
        : completed ? "completed" : "none";
      const pendingWake = (): ManagedEndpointReadyOutcome => ({
        recovery: recovery(),
        sharedWake: isGenerationCurrent() ? "needed" : "stale",
      });
      if (!isCurrent()) return { recovery: "pending", sharedWake: "stale" };
      const managedKeys = targets.filter(([, target]) => target.stage === "managed").map(([key]) => key);
      let batch: ManagedSessionRecoveryBatchResult = { restored: false, restoredKeys: [], settledKeys: [], failures: [] };
      try {
        if (managedKeys.length > 0) batch = await options.recover(endpointId, managedKeys, lease, isCurrent);
      } catch (error) {
        if (isCurrent()) applyFailure(managedKeys, error, "managed", true);
        return pendingWake();
      }
      if (!isCurrent()) return pendingWake();
      const managedSet = new Set(managedKeys);
      const returnedKeys = [...batch.restoredKeys, ...batch.settledKeys, ...batch.failures.map(({ key }) => key)];
      if (returnedKeys.some((key) => !managedSet.has(key))) {
        applyFailure(managedKeys, new Error("managed recovery returned an unexpected mapping"), "managed", true);
        return pendingWake();
      }
      for (const key of batch.restoredKeys) {
        const current = pending.get(key);
        if (current) pending.set(key, {
          ...current, stage: "before_shared", incidents: undefined, sharedWakeEpoch: undefined,
        });
      }
      for (const key of batch.settledKeys) pending.delete(key);
      for (const failure of batch.failures) {
        if (failure.disposition === "retry" || failure.disposition === "endpoint") {
          pending.set(failure.key, {
            disposition: failure.disposition, stage: "managed", incidents: undefined, sharedWakeEpoch: undefined,
          });
        } else if (failure.disposition === "permanent") {
          pending.set(failure.key, {
            disposition: "safety", stage: "managed", incidents: undefined, sharedWakeEpoch: undefined,
          });
          if (!safetyReported.has(endpointId)) {
            safetyReported.add(endpointId);
            try { options.onSafetyFailure(new Error("permanent managed recovery failure")); }
            catch { /* An isolation callback must not change recovery ownership. */ }
          }
        } else pending.delete(failure.key);
      }
      if (batch.failures.some(({ disposition }) => disposition === "endpoint")) markEndpointWaiting(endpointId);
      if (!isCurrent()) return pendingWake();

      const beforeKeys = targetKeys.filter((key) => pending.get(key)?.stage === "before_shared");
      if (beforeKeys.length > 0) {
        const needsBefore = beforeKeys.filter((key) => pending.get(key)?.incidents === undefined);
        const needsSharedWake = beforeKeys.some((key) => pending.get(key)?.sharedWakeEpoch !== epoch);
        try {
          if (needsBefore.length > 0) {
            const discovered = dedupeIncidents(await options.beforeShared(endpointId, lease, isCurrent));
            if (!isCurrent()) return pendingWake();
            const accumulated = dedupeIncidents([
              ...beforeKeys.flatMap((key) => pending.get(key)?.incidents ?? []),
              ...discovered,
            ]);
            for (const key of beforeKeys) {
              const current = pending.get(key);
              if (current?.stage === "before_shared") pending.set(key, { ...current, incidents: accumulated });
            }
          }
          if (!isCurrent()) return pendingWake();
          if (needsSharedWake) {
            await options.wakeShared(endpointId, lease, isCurrent);
            sharedWakeCompleted = true;
          }
        } catch (error) {
          if (isCurrent()) applyFailure(beforeKeys, error, "before_shared", true);
          return pendingWake();
        }
        if (!isCurrent()) return { recovery: "pending", sharedWake: "stale" };
        const beforeIncidents = dedupeIncidents(beforeKeys.flatMap((key) => pending.get(key)?.incidents ?? []));
        for (const key of beforeKeys) {
          const current = pending.get(key);
          if (current?.stage === "before_shared") pending.set(key, {
            ...current, stage: "after_shared", incidents: beforeIncidents, sharedWakeEpoch: epoch,
          });
        }
      }

      const afterKeys = targetKeys.filter((key) => pending.get(key)?.stage === "after_shared");
      if (afterKeys.length > 0) {
        const beforeIncidents = dedupeIncidents(afterKeys.flatMap((key) => pending.get(key)?.incidents ?? []));
        try { await options.afterShared(endpointId, lease, beforeIncidents, isCurrent); }
        catch (error) {
          if (isCurrent()) applyFailure(afterKeys, error, "after_shared", true);
          return {
            recovery: recovery(),
            sharedWake: isGenerationCurrent() ? sharedWakeCompleted ? "completed" : "needed" : "stale",
          };
        }
        if (!isCurrent()) return { recovery: "pending", sharedWake: "stale" };
        for (const key of afterKeys) pending.delete(key);
      }
      if (beforeKeys.length > 0 || afterKeys.length > 0) {
        safetyReported.delete(endpointId);
        return { recovery: recovery(true), sharedWake: sharedWakeCompleted ? "completed" : "needed" };
      }
      return { recovery: recovery(), sharedWake: sharedWakeCompleted ? "completed" : "needed" };
    };
    let result: ManagedEndpointReadyOutcome;
    if (existingLease) result = await recover(existingLease);
    else {
      try { result = await options.endpoints.withReadyWorkLease(endpointId, recover); }
      catch (error) {
        if (!stopped && endpointEpoch(endpointId) === epoch) {
          for (const stage of ["managed", "before_shared", "after_shared"] as const) {
            const keys = targets.filter(([, target]) => target.stage === stage).map(([key]) => key);
            if (keys.length > 0) applyFailure(keys, error, stage);
          }
        }
        result = {
          recovery: targetsFor(endpointId, "all").length > 0 ? "pending" : "none",
          sharedWake: !stopped && endpointEpoch(endpointId) === epoch ? "needed" : "stale",
        };
      }
    }
    if (!stopped && !unavailableEndpoints.has(endpointId) && targetsFor(endpointId, "retry").length > 0) schedule(endpointId);
    return result;
  };
  const enqueue = (endpointId: string, selection: "retry" | "all", epoch: number, lease?: EndpointWorkLease): Promise<ManagedEndpointReadyOutcome> => {
    if (stopped) return Promise.resolve({ recovery: "pending", sharedWake: "stale" });
    const previous = tails.get(endpointId) ?? Promise.resolve();
    let result: ManagedEndpointReadyOutcome = { recovery: "pending", sharedWake: "stale" };
    const scheduled = previous.then(async () => { result = await run(endpointId, selection, epoch, lease); }, async () => { result = await run(endpointId, selection, epoch, lease); });
    const contained = scheduled.catch(report);
    tails.set(endpointId, contained);
    void contained.finally(() => { if (tails.get(endpointId) === contained) tails.delete(endpointId); });
    return contained.then(() => result);
  };
  schedule = (endpointId: string): void => {
    if (stopped || unavailableEndpoints.has(endpointId) || timers.has(endpointId) || targetsFor(endpointId, "retry").length === 0) return;
    const generation = (timerGenerations.get(endpointId) ?? 0) + 1;
    const epoch = endpointEpoch(endpointId);
    timerGenerations.set(endpointId, generation);
    const timerApi = options.timers ?? nodeManagedRecoveryTimers;
    const handle = timerApi.setTimeout(() => {
      const timer = timers.get(endpointId);
      if (stopped || unavailableEndpoints.has(endpointId) || timer?.generation !== generation || timer.epoch !== epoch
        || endpointEpoch(endpointId) !== epoch) return;
      timers.delete(endpointId);
      void enqueue(endpointId, "retry", epoch);
    }, options.retryMs ?? 1_000);
    timers.set(endpointId, { handle, generation, epoch });
    (handle as { unref?: () => void } | undefined)?.unref?.();
  };
  const completeIndependentSharedWake = async (
    endpointId: string,
    lease: EndpointWorkLease,
    epoch: number,
    wakeShared: () => Promise<void>,
    result: ManagedEndpointReadyOutcome,
  ): Promise<ManagedEndpointReadyOutcome> => {
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    const record = { epoch, barrier };
    fallbackWakes.set(endpointId, record);
    try {
      await wakeShared();
      if (!generationIsCurrent(endpointId, epoch, lease)) return { ...result, sharedWake: "stale" };
      for (const [key, target] of pending) {
        if (managedRetryEndpoint(key) !== endpointId || target.stage !== "before_shared") continue;
        pending.set(key, { ...target, sharedWakeEpoch: epoch });
      }
      return { ...result, sharedWake: "completed" };
    } finally {
      releaseBarrier();
      if (fallbackWakes.get(endpointId) === record) fallbackWakes.delete(endpointId);
    }
  };

  return {
    recordFailure: (key, disposition) => {
      if (stopped) return;
      const current = pending.get(key);
      if (disposition === "retry" || disposition === "endpoint") pending.set(key, current && current.stage !== "managed"
        ? { ...current, disposition }
        : { disposition, stage: "managed", incidents: undefined, sharedWakeEpoch: undefined });
      else if (disposition === "permanent") pending.set(key, {
        disposition: "safety", stage: "managed", incidents: undefined, sharedWakeEpoch: undefined,
      });
      else pending.delete(key);
      const endpointId = managedRetryEndpoint(key);
      if (disposition === "endpoint") markEndpointWaiting(endpointId);
      else if (disposition === "retry") schedule(endpointId);
      else if (targetsFor(endpointId, "retry").length === 0) clearTimer(endpointId);
    },
    endpointReady: async (endpointId, lease, wakeShared) => {
      const epoch = advanceEndpointEpoch(endpointId);
      unavailableEndpoints.delete(endpointId);
      clearTimer(endpointId);
      const result = await enqueue(endpointId, "all", epoch, lease);
      if (!wakeShared || result.sharedWake !== "needed") return result;
      return completeIndependentSharedWake(endpointId, lease, epoch, wakeShared, result);
    },
    endpointUnavailable: (endpointId) => {
      if (stopped) return;
      advanceEndpointEpoch(endpointId);
      markEndpointWaiting(endpointId);
    },
    stop: async () => {
      if (!stopped) {
        stopped = true;
        pending.clear();
        for (const endpointId of [...timers.keys()]) clearTimer(endpointId);
      }
      while (tails.size > 0 || fallbackWakes.size > 0) {
        await Promise.all([...tails.values(), ...[...fallbackWakes.values()].map(({ barrier }) => barrier)]);
      }
    },
  };
}

export async function wakeRestoredSessionOwners(dependencies: {
  relay: Pick<EventRelay, "endpointReady">;
  observations: Pick<SessionObservationProcessor, "endpointReady">;
  onError(owner: "relay" | "observations", error: unknown): void;
}, endpointId: string, lease?: EndpointWorkLease, isCurrent: () => boolean = () => true): Promise<void> {
  if (!isCurrent()) return;
  try { await dependencies.relay.endpointReady(endpointId, lease); }
  catch (error) { if (isCurrent()) dependencies.onError("relay", error); }
  if (!isCurrent()) return;
  try { await dependencies.observations.endpointReady(endpointId); }
  catch (error) { if (isCurrent()) dependencies.onError("observations", error); }
  if (!isCurrent()) return;
}

export async function releaseRestoredOwnershipIncidents(dependencies: {
  ownership: Pick<SessionOwnershipWatcher, "detectEndpoint" | "release">;
}, endpointId: string, lease: EndpointWorkLease, beforeIncidents: readonly ManagedOwnershipIncidentReceipt[], isCurrent: () => boolean): Promise<void> {
  const assertCurrent = (): void => {
    if (!isCurrent()) throw new AppError("ENDPOINT_UNAVAILABLE", "managed recovery generation changed during ownership release");
  };
  assertCurrent();
  const afterIncidents = await dependencies.ownership.detectEndpoint(endpointId, lease, isCurrent);
  assertCurrent();
  const seen = new Set<string>();
  const incidents = [...beforeIncidents, ...afterIncidents].filter((incident) => {
    const key = `${incident.endpoint}\0${incident.thread_id}\0${incident.mapping_id}\0${incident.turnId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  assertCurrent();
  await dependencies.ownership.release(incidents, lease, isCurrent);
  assertCurrent();
}

export function reportOperationalSafely(sink: OperationalEventSink, event: OperationalEvent): void {
  try { sink(event); }
  catch { /* operational logging must not change runtime behavior */ }
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
  observations: Pick<SessionObservationProcessor, "stop">,
  finishDashboard: () => Promise<void>,
): Promise<void> {
  await observations.stop();
  await relay.stop();
  await finishDashboard();
}

export async function stopRecoveryOwnerSet(dependencies: {
  ready?: Pick<EndpointReadyBuffer, "stop">;
  managed?: Pick<ManagedSessionRecoveryOwner, "stop">;
  operations?: Pick<OperationReconciliationLoop, "stop">;
  dispatcher?: Pick<ConversationDispatcher, "stop">;
  relay?: Pick<EventRelay, "stop">;
  observations?: Pick<SessionObservationProcessor, "stop">;
  finishDashboard?(): Promise<void>;
}): Promise<void> {
  let firstError: unknown;
  for (const stop of [
    () => dependencies.ready?.stop(),
    () => dependencies.managed?.stop(),
    () => dependencies.observations?.stop(),
    () => dependencies.relay?.stop(),
    () => dependencies.operations?.stop(),
    () => dependencies.dispatcher?.stop(),
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
    testing?: {
      holdAssistantScheduler?: boolean;
      onManagerToolsBuilt?(
        tools: Readonly<Record<AssistantToolName, ToolHandler>>,
        activity: { registerTool(attemptId: string): number; finishTool(attemptId: string): void },
      ): void;
    };
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
  let attachmentCleanup!: AttachmentCleanup;
  let operations!: OperationStore;
  let deliveries!: DeliveryStore;
  let backgroundFailures!: BackgroundFailureStore;
  let runtime!: RuntimeStore;
  let finals!: FinalMessageStore;
  let endpoint!: ManagedAppServerEndpoint;
  let assistantEndpoint!: ManagedAppServerEndpoint;
  let claudeEndpoint: ClaudeCodeRuntime | undefined;
  let scheduling: SchedulingService | undefined;
  let claudeGoals: ClaudeGoalStore | undefined;
  let claudeGoalDriver: ClaudeGoalDriver | undefined;
  const CLAUDE_MAX_GOAL_TURNS = 25;
  let endpointCatalog!: EndpointCatalog;
  let endpointBindings!: EndpointBindingStore;
  let endpointManager!: EndpointManager;
  let pool!: AppServerPool;
  let discovery!: SessionDiscovery;
  let lifecycle!: SessionLifecycle;
  let ownership!: SessionOwnershipGuard;
  let ownershipEvents!: OwnershipEventStore;
  let ownershipWatcher!: SessionOwnershipWatcher;
  let externalOwnershipMonitor!: ExternalOwnershipMonitor;
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
  const projectReadyRetryTimers = new Map<string, { generation: number; timer: ReturnType<typeof setTimeout> }>();
  type RemoteContext = { host: RemoteHost; remote: SshRemoteClient; projectsRoot: string };
  const remoteContexts = new Map<string, RemoteContext>();
  const remoteCandidateContexts = new WeakMap<ManagedEndpointContract, RemoteContext>();
  const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reconnectAttempts = new Map<string, number>();
  const terminalProcessing = new Map<string, Promise<void>>();
  const assistantLifecycleBuffer = new AssistantLifecycleBuffer();
  const assistantToolReadiness = new ToolReadinessGate();
  const endpointRecoveryIncidents = new EndpointRecoveryIncidents();
  let stopping = false;
  let endpointsCommitted = false;
  let operationReconciler: OperationReconciliationLoop | undefined;
  let managedRecoveryOwner: ManagedSessionRecoveryOwner | undefined;
  let recoveryOwnersStop: Promise<void> | undefined;
  const report = options.onOperationalEvent ?? (() => undefined);
  const eventWakeBoundary = createDurableEventWakeBoundary({
    schedulerAccepting: () => schedulerAccepting,
    stopping: () => stopping,
    enqueuePendingEvents,
    requestRestart: options.requestRestart ?? (() => undefined),
  });
  const { requestRestartOnce, wakeAfterDurableCommit } = eventWakeBoundary;
  const durableEventSources = createDurableEventSourceCallbacks({
    wakeAfterDurableCommit,
    persistDeliveryState: (delivery) => persistDeliveryStateEvent(db, delivery),
    reconcileDeliveryStates: () => reconcileDeliveryStateEvents(db, deliveries),
    recordOwnership: (incident, status) => ownershipEvents.record(incident, status),
    reconcileOwnership: () => ownershipEvents.reconcileReleased(registry),
    persistEndpointUnavailable: (event) => db.prepare(`INSERT OR IGNORE INTO events
      (id, endpoint_id, thread_id, kind, payload_json, state, created_at)
      VALUES (?, ?, ?, 'endpoint_unavailable', ?, 'pending', ?)`)
      .run(event.id, event.endpointId, event.threadId, JSON.stringify({
        endpointId: event.endpointId,
        status: "unavailable",
        incident: event.incident,
      }), event.createdAt).changes === 1,
    recordBackgroundFailure: (notice) => {
      const identity = registry.snapshot().assistant;
      backgroundFailures.record({
        ...notice,
        endpointId: identity.endpoint,
        threadId: identity.thread_id,
        binding: currentOwnerBinding(),
      });
    },
    reconcileLifecycle: (filter) => reconcileLifecycleAndOwnership(
      lifecycle,
      isolateLifecycleRecoveryFailure,
      ownershipEvents,
      registry,
      filter,
    ),
  });
  const backgroundFailureReporter = createBackgroundFailureReporter({
    runId: randomUUID(),
    onOperational: (label) => {
      report({ level: "warn", code: "background_task_failed", component: label.replaceAll(" ", "_") });
    },
    onDurable: durableEventSources.backgroundFailure,
  });
  const reportExternalOwnershipCycle = createExternalOwnershipCycleReporter({
    onOperational: () => reportOperationalSafely(report, {
      level: "warn", code: "background_task_failed", component: "external_ownership_detection",
    }),
    onDegraded: (notice) => {
      const identity = registry.snapshot().assistant;
      backgroundFailures.recordExternalOwnershipDegraded({
        id: notice.id,
        incident: notice.incident,
        endpointId: identity.endpoint,
        threadId: identity.thread_id,
        binding: currentOwnerBinding(),
      });
      void wakeAfterDurableCommit(true);
    },
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
            dashboardStoreOptions: {
              onMetadataRecoveryRequired: () => {
                try { report({ level: "warn", code: "database_metadata_recovery_required" }); }
                finally { requestRestartOnce(); }
              },
            },
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
        attachmentCleanup = createAttachmentCleanupOwner(() => attachments.cleanupExpired(), report);
        await attachmentCleanup.start();
      }, stop: async () => { await attachmentCleanup.stop(); },
    },
    {
      name: "chat-adapters",
      start: async () => {
        conversations = new ConversationStore(db, deliveries, attachments);
        const configured: ChatAdapter[] = options.chatAdapters ? [...options.chatAdapters] : [];
        const readyHooks: Array<() => Promise<void> | void> = [];
        if (!options.chatAdapters) {
          const appDeps: ChatAppDeps = {
            db, attachments, conversations, deliveries,
            onMessage: acceptChat,
            onOperationalEvent: report,
            maxMessageBytes: config.attachmentMaxBytes,
          };
          for (const app of CHAT_APPS) {
            const appConfig = (config.chat as unknown as Record<string, unknown>)[app.id];
            if (appConfig === undefined) continue;
            const instance = app.create(appDeps, appConfig);
            configured.push(instance.adapter);
            if (instance.onAllReady) readyHooks.push(() => instance.onAllReady!());
          }
        }
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
        for (const hook of readyHooks) await hook();
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
        const tools = createAssistantTools(operations, actions, {
          maxCollectCount: config.maxCollectCount,
          attemptScope,
          waitForTerminal: (operationId, signal) => {
            if (!operationReconciler) throw new AppError("ENDPOINT_UNAVAILABLE", "operation reconciliation is not ready");
            return operationReconciler.waitForTerminal(operationId, signal);
          },
        });
        options.testing?.onManagerToolsBuilt?.(tools, {
          registerTool: (attemptId) => assistant.registerTool(attemptId),
          finishTool: (attemptId) => assistant.finishTool(attemptId),
        });
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
        endpoint = new ManagedAppServerEndpoint({
          id: "local",
          runtime: new LocalAppServerRuntime({ codexBinary: config.codexBinary, env: buildWorkerChildEnvironment(process.env) }),
          minimumVersion: MINIMUM_SUPPORTED_CODEX_VERSION,
        });
        assistantEndpoint = new ManagedAppServerEndpoint({
          id: "assistant-local",
          runtime: new LocalAppServerRuntime({
            codexBinary: config.codexBinary,
            env: buildAssistantChildEnvironment(process.env, assistantProfile, token),
            expectedCodexHome: assistantProfile.codexHome,
            validateEnvironment: () => assistantProfile.assertIntact(),
          }),
          minimumVersion: MINIMUM_SUPPORTED_CODEX_VERSION,
        });
        // Opt-in local Claude Code endpoint (Phase 1.4). Eager + always-ready like
        // "local" (no daemon); absent config.claudeCode it is never constructed and
        // the composition is unchanged.
        const claudeCodeConfig = config.claudeCode;
        // Shared across the runtime (thread/goal/*), the scheduling service (the
        // worker set_goal_status tool), and the goal driver (auto-drive).
        claudeGoals = claudeCodeConfig === undefined ? undefined : new ClaudeGoalStore(db);
        // Refresh the dashboard after a worker/driver goal-status change (those bypass
        // the manager tools' observeGoal).
        const refreshClaudeGoalObservation = (nickname: string): void => {
          if (!claudeGoals || !claudeCodeConfig) return;
          const session = registry.get(nickname);
          if (!session || session.endpoint !== claudeCodeConfig.endpointId) return;
          observeGoal(nickname, { goal: claudeGoals.get(claudeCodeConfig.endpointId, session.thread_id) });
          void renderDashboardSafely();
        };
        scheduling = claudeCodeConfig === undefined ? undefined : new SchedulingService({
          db,
          now: () => Date.now(),
          mcpConfigDir: join(dataDir, "claude-worker-mcp"),
          // Fire drives a turn via the durable send_to_session (singleFireKey ==
          // clientUserMessageId for idempotent delivery).
          send: (nickname, message, key) => sessions.send(nickname, message, { mode: "auto", clientUserMessageId: key }).then(() => undefined),
          runCheck: (row: ScheduleRow) => runMonitorCheck(row.spec),
          ...(claudeGoals ? { goals: claudeGoals, onGoalStatusChanged: (session) => refreshClaudeGoalObservation(session.nickname) } : {}),
        });
        // Goal enforcement (auto-drive). The goal is set via the assistant's set_goal
        // MCP manager tool (NOT Claude's internal /goal); the worker ends it via the
        // set_goal_status MCP tool. QiYan drives the next turn after each completion
        // while the goal is active.
        claudeGoalDriver = (claudeCodeConfig && scheduling && claudeGoals) ? new ClaudeGoalDriver({
          goals: claudeGoals,
          now: () => Date.now(),
          maxDrivenTurns: CLAUDE_MAX_GOAL_TURNS,
          enqueue: (session, message) => scheduling!.enqueueGoalDrive(session, message),
          hasPendingDrive: (session) => scheduling!.hasPendingGoalDrive(session),
          onStatusChanged: (session) => refreshClaudeGoalObservation(session.nickname),
        }) : undefined;
        // Launch policy (disallowed tools, system prompt, model) applies to Claude
        // sessions regardless of host, so the local and remote endpoints share it.
        const claudeLaunchFlags: ClaudeLaunchFlags = claudeCodeConfig === undefined ? {} : {
          disallowedTools: claudeCodeConfig.disallowedTools,
          appendSystemPrompt: claudeCodeConfig.appendSystemPrompt,
          ...(claudeCodeConfig.model === undefined ? {} : { model: claudeCodeConfig.model }),
        };
        claudeEndpoint = claudeCodeConfig === undefined ? undefined : new ClaudeCodeRuntime({
          id: claudeCodeConfig.endpointId,
          runner: new LocalClaudeCommandRunner({ command: claudeCodeConfig.command }),
          launchFlags: claudeLaunchFlags,
          ...(claudeGoals ? { goals: claudeGoals } : {}),
          ...(scheduling ? {
            workerMcpConfigPath: async (threadId: string) => {
              const found = registry.getByIdentity(claudeCodeConfig.endpointId, threadId);
              return found ? scheduling!.workerMcpConfigPath({ nickname: found.nickname, endpointId: claudeCodeConfig.endpointId, threadId }) : undefined;
            },
            steer: async (threadId: string, message: string) => {
              const found = registry.getByIdentity(claudeCodeConfig.endpointId, threadId);
              if (found) scheduling!.enqueueSteer({ nickname: found.nickname, endpointId: claudeCodeConfig.endpointId, threadId }, message);
            },
          } : {}),
        });
        // A Claude endpoint id that collides with a configured remote (catalog) id
        // would silently shadow that remote (builtins short-circuit before the
        // catalog). Refuse the misconfiguration loudly.
        if (claudeEndpoint && endpointCatalog.snapshot().endpoints[claudeEndpoint.id]) {
          throw new AppError("CONFIGURATION_ERROR", `CLAUDE_CODE_ENDPOINT_ID collides with a catalog endpoint: ${claudeEndpoint.id}`);
        }
        // Drive the goal loop: after each completed Claude turn, if the goal is still
        // active, enqueue the next pursuit turn. Stops when the worker's set_goal_status
        // flips the status (or the backstop cap pauses it).
        if (claudeEndpoint && claudeGoalDriver && claudeCodeConfig) {
          const claudeId = claudeCodeConfig.endpointId;
          unsubscribers.push(claudeEndpoint.onNotification((method, params) => {
            if (method !== "turn/completed") return;
            const threadId = (params as { threadId?: string }).threadId;
            if (typeof threadId !== "string") return;
            const found = registry.getByIdentity(claudeId, threadId);
            if (found) claudeGoalDriver!.onTurnCompleted({ nickname: found.nickname, endpointId: claudeId, threadId });
          }));
        }
        const sshRuntimeRoot = await prepareLocalSshRuntimeRoot(dataDir);
        const helperSource = await readFile(join(remoteAssetRoot, "qiyan-ssh-helper.mjs"));
        const planner = new SshGenerationPlanner({
          sshBinary: "ssh",
          runtimeDir: sshRuntimeRoot,
          hasReferences: (id) => hasEndpointIdentityReferences(id),
          checkExisting: (id, destination, references) => endpointBindings.checkExisting(id, destination, references),
          attestControlMaster: attestUserControlMaster,
        });
        endpointManager = new EndpointManager({
          localEndpoint: endpoint,
          ...(claudeEndpoint ? { builtinEndpoints: [claudeEndpoint] } : {}),
          catalog: endpointCatalog,
          createRemote: async (definition) => {
            const generation = await planner.createGeneration(definition.id);
            const remote = new SshRemoteClient({ plan: generation.plan, helperSource });
            if (definition.type === "claude-code") {
              // A Claude endpoint has no app-server to lazily prepare, so bootstrap the
              // helper eagerly here (installs it + establishes the ControlMaster) — the
              // ownership scan / workspace ops need the installed helper immediately.
              const host = await prepareRemoteHost({ endpointId: definition.id, remote, assetRoot: remoteAssetRoot });
              const claudeRemoteEndpoint = new ClaudeCodeRuntime({
                id: definition.id,
                runner: new SshClaudeCommandRunner({ plan: generation.plan }),
                launchFlags: claudeLaunchFlags,
              });
              remoteCandidateContexts.set(claudeRemoteEndpoint, { host, remote, projectsRoot: definition.projectsRoot });
              return { endpoint: claudeRemoteEndpoint, pendingBinding: generation.pendingBinding };
            }
            const remoteRuntime = new SshRuntime({ endpointId: definition.id, remote, assetRoot: remoteAssetRoot });
            const socketRoot = await prepareLocalSshEndpointSocketRoot(sshRuntimeRoot, definition.id);
            const remoteEndpoint = new ManagedAppServerEndpoint({
              id: definition.id,
              runtime: new SshAppServerRuntime({
                runtime: remoteRuntime,
                plan: generation.plan,
                socketRoot,
                connectWire: (socketPath) => WebSocketWire.connect(socketPath, { timeoutMs: 10_000, trustedRoot: socketRoot }),
              }),
              minimumVersion: MINIMUM_SUPPORTED_CODEX_VERSION,
            });
            remoteCandidateContexts.set(remoteEndpoint, { host: remoteRuntime, remote, projectsRoot: definition.projectsRoot });
            return { endpoint: remoteEndpoint, pendingBinding: generation.pendingBinding };
          },
          hasIdentityReferences: (id) => hasEndpointIdentityReferences(id),
          commitBinding: (binding, references) => endpointBindings.commitAfterActivation(binding.endpointId, binding.destination, references),
          managedThreadIds: (id) => Object.values(registry.snapshot().sessions).filter((session) => session.endpoint === id).map((session) => session.thread_id),
        });
        pool = new AppServerPool([endpoint, assistantEndpoint, ...(claudeEndpoint ? [claudeEndpoint] : [])], {
          maxConcurrentTurns: config.maxConcurrentTurns,
          resolveEndpoint: (id) => endpointManager.ensureReady(id),
          // The Claude endpoint is a manager built-in (like "local"), so it goes
          // through the manager's ready-work-lease; only assistant-local (not
          // manager-registered) runs the callback directly.
          workLeaseProvider: (id, lease, run) => id === assistantEndpoint.id ? run(lease) : endpointManager.runWithReadyWorkLease(id, lease, run),
        });
        recoveredEndpointIds = new EndpointCapacityRecovery({
          runtime,
          registry,
          operations,
          pool,
          quarantine: (operation, reason) => operations.failAndUnbind(operation.id, { message: reason }),
        }).restoreBeforeIngress();
        // A local endpoint runs on QiYan's own host with no ssh: the Codex "local" plus the
        // optional local Claude endpoint (CLAUDE_CODE_ENDPOINT_ID). Both resolve to the local
        // project workspace and count as local for ownership scans. Shared so the workspace
        // router and the rollout-access router cannot diverge (they did — see the local Claude
        // "SSH workspace host is unavailable" regression).
        const isLocalEndpoint = (id: string): boolean => id === "local" || id === claudeCodeConfig?.endpointId;
        workspaceRouter = new WorkspaceRouter(async (id) => {
          if (isLocalEndpoint(id)) return projectWorkspaces;
          await endpointManager.ensureReady(id);
          const context = remoteContexts.get(id);
          if (!context) throw new AppError("ENDPOINT_UNAVAILABLE", `SSH workspace host is unavailable: ${id}`);
          const home = context.host.remoteHome;
          const projectsRoot = context.projectsRoot.startsWith("~/") ? posix.resolve(home, context.projectsRoot.slice(2)) : posix.resolve(context.projectsRoot);
          return new ProjectWorkspacePolicy({
            userHome: home,
            qiyanHome: context.host.remoteRuntimeDir,
            assistantWorkdir: context.host.remoteRuntimeDir,
            dataDir: context.host.remoteRuntimeDir,
            registryPath: posix.join(context.host.remoteRuntimeDir, "sessions.json"),
            defaultProjectsRoot: projectsRoot,
            host: new SshHost(id, context.remote, context.host.remoteHelperPath),
          });
        }, (id, lease) => endpointManager.validateWorkLease(lease, id));
        workerFiles = new WorkerFileBridge({
          attachments,
          registry,
          endpoints: endpointManager,
          workspaces: workspaceRouter,
          remote: (id) => {
            const context = remoteContexts.get(id);
            return context ? { remote: context.remote, helperPath: context.host.remoteHelperPath, runtimeDir: context.host.remoteRuntimeDir } : undefined;
          },
          isLocal: isLocalEndpoint,
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
            return context ? { remote: context.remote, helperPath: context.host.remoteHelperPath } : undefined;
          },
          validateLease: (id, lease) => endpointManager.validateWorkLease(lease, id),
          // Provider dispatch (shared helper): Claude endpoints use the transcript
          // scanner. Only the built-in local Claude endpoint is local; a catalog
          // claude-code endpoint is remote (scans over ssh).
          provider: (id) => sessionProvider(id),
          local: isLocalEndpoint,
          scanLocalClaude: scanLocalClaudeTranscript,
        });
        ownership = new SessionOwnershipGuard(
          db, runtime, operations, rolloutAccess, createAppServerRolloutPathResolver(pool),
        );
        lifecycle = new SessionLifecycle(
          pool,
          registry,
          runtime,
          { now: () => Date.now() },
          workspaceRouter as never,
          threadGate,
          endpointManager,
          ownership,
          async (identity, lease, thread) => {
            const control = runtime.goalControl(identity.endpoint, identity.thread_id, identity.mapping_id);
            if (control.known && !control.controlled) return;
            const currentGoal = await pool.request<any>(
              identity.endpoint,
              "thread/goal/get",
              { threadId: identity.thread_id },
              undefined,
              lease,
            );
            const registered = registry.getByIdentity(identity.endpoint, identity.thread_id);
            if (!registered || registered.session.mapping_id !== identity.mapping_id) {
              throw new AppError("OPERATION_CONFLICT", "managed goal mapping changed during recovery");
            }
            const active = restoredGoalControlIsActive(currentGoal);
            const hasGoal = currentGoal.goal !== null;
            if (!control.known) setGoalControlled(registered.nickname, hasGoal);
            let authorizedTurnId: string | undefined;
            if ((control.controlled || hasGoal) && active) {
              const activeTurn = [...(thread?.turns ?? [])].reverse().find((turn) => !isTerminalStatus(turn.status));
              authorizedTurnId = activeTurn?.id;
            }
            observeGoal(registered.nickname, currentGoal);
            const after = (control.controlled || hasGoal) && !active
              ? () => setGoalControlled(registered.nickname, false)
              : undefined;
            if (authorizedTurnId || after) return { ...(authorizedTurnId ? { authorizedTurnId } : {}), ...(after ? { after } : {}) };
          },
        );
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
          onIdleTurn: ({ endpointId, threadId, turnId }) => processWorkerTerminalNotification({
            endpoints: endpointManager,
            ownership: ownershipWatcher,
            relay,
            reconcileOperations,
          }, endpointId, "turn/completed", { threadId, turn: { id: turnId } }),
          onGoalTurnStarted: ({ endpointId, threadId, mappingId, turnId }) => {
            ownership.authorizeTurn({ endpoint: endpointId, thread_id: threadId, mapping_id: mappingId }, turnId);
          },
          onChanged: () => runBackground(() => renderDashboardSafely(), () => recordBackgroundFailure("dashboard rendering")),
          classifyFailure: (error) => error instanceof RpcRequestTimeoutError
            ? "retry"
            : error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE" ? "endpoint" : "sleep",
          onError: () => reportOperationalSafely(report, {
            level: "warn", code: "background_task_failed", component: "session_observation",
          }),
        });
        relay = new EventRelay(db, pool, registry, runtime, finals, deliveries, {
          binding: currentOwnerBinding,
          clock: { now: () => Date.now() },
          onTerminal: (event, lease) => observations.observeTerminal(event, lease),
          onEventCommitted: durableEventSources.relayCommitted,
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
            await durableEventSources.ownership(incident, "pending");
            dashboardStore.observeLifecycle({ endpointId: incident.endpoint, threadId: incident.thread_id }, Date.now());
            await renderDashboardSafely();
          },
          onReleased: async (incident) => {
            await durableEventSources.ownership(incident, "completed");
            dashboardStore.observeLifecycle({ endpointId: incident.endpoint, threadId: incident.thread_id }, Date.now());
            await renderDashboardSafely();
          },
        }, threadGate);
        externalOwnershipMonitor = new ExternalOwnershipMonitor({
          endpointIds: () => [...new Set([
            ...Object.values(registry.snapshot().sessions)
              .filter((session) => session.lifecycle_state === "managed" || session.lifecycle_state === "unadopting")
              .map((session) => session.endpoint),
            ...ownershipEvents.pending().map((incident) => incident.endpoint),
          ])],
          pending: (endpointId) => ownershipEvents.pending(endpointId),
          withReadyEndpointWorkLease: (endpointId, run) => endpointManager.withReadyWorkLease(endpointId, run),
          resumeRemoval: async (incident, lease) => {
            const current = registry.get(incident.nickname);
            const exact = current?.endpoint === incident.endpoint
              && current.thread_id === incident.thread_id
              && current.mapping_id === incident.mapping_id;
            if (exact && current.lifecycle_state === "managed") {
              await ownershipWatcher.release([incident], lease);
            } else if (exact && current.lifecycle_state === "unadopting") {
              await lifecycle.reconcileRemoval(incident.nickname, current, lease);
            }
            await durableEventSources.reconcileOwnership();
          },
          inspectAndRelease: (endpointId, lease) => ownershipWatcher.reconcileEndpoint(endpointId, lease),
          onCycle: reportExternalOwnershipCycle,
        });
        managedRecoveryOwner = createManagedSessionRecoveryOwner({
          endpoints: endpointManager,
          isLeaseCurrent: isManagedRecoveryLeaseCurrent,
          recover: (endpointId, keys, lease, isCurrent) => resumeManagedSessions(endpointId, {
            unavailableOnly: true, keys, lease, isCurrent,
          }),
          beforeShared: beforeRestoredEndpoint,
          wakeShared: wakeRestoredEndpoint,
          afterShared: afterRestoredEndpoint,
          onSafetyFailure: () => reportOperationalSafely(report, {
            level: "warn", code: "background_task_failed", component: "managed_session_recovery_isolated",
          }),
          onError: () => reportOperationalSafely(report, {
            level: "warn", code: "background_task_failed", component: "managed_session_recovery",
          }),
        });
        operationReconciler = createOperationReconciliationLoop({
          reconcileOnce: reconcileOperationsOnce,
          isEndpointReady: isRecoveryEndpointReady,
          operationState: (operationId) => operations.get(operationId)?.state,
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
        for (const { timer } of projectReadyRetryTimers.values()) clearTimeout(timer);
        projectReadyRetryTimers.clear();
      },
    },
    {
      name: "endpoint",
      start: async () => {
        stopping = false;
        endpointsCommitted = false;
        try {
          await assistantEndpoint.start();
          if (assistantEndpoint.state !== "ready") {
            throw new AppError("ENDPOINT_UNAVAILABLE", "the assistant app-server became unavailable during initial startup");
          }
          endpointsCommitted = true;
        } catch (error) {
          stopping = true;
          for (const timer of reconnectTimers.values()) clearTimeout(timer);
          reconnectTimers.clear();
          await stopRecoveryOwners().catch(() => undefined);
          await Promise.all([assistantEndpoint.closeConnection(), endpointManager.closeConnections()]).catch(() => undefined);
          throw assistantAuthenticationStartupError(error);
        }
      },
      stop: async () => {
        stopping = true;
        endpointsCommitted = false;
        for (const timer of reconnectTimers.values()) clearTimeout(timer);
        reconnectTimers.clear();
        await Promise.all([assistantEndpoint.closeConnection(), endpointManager.closeConnections()]);
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
        await assistantLifecycleBuffer.activate(handleAssistantLifecycleNotification);
        await dispatcher.recover();
        await dispatcher.idle();
        assistant.hydrateActive();
        const lifecycleOwned = lifecycleOwnedEndpointIds();
        const referencedEndpoints = startupProjectEndpointReferences({
          sessionEndpoints: Object.values(registry.snapshot().sessions).map((session) => session.endpoint),
          recoveredEndpointIds,
          operationEndpointIds: recoverableActivationReferences(),
          lifecycleOwnedEndpointIds: lifecycleOwned,
          assistantEndpointId: assistantEndpoint.id,
        });
        const activation = await endpointManager.activateReferenced(referencedEndpoints);
        await reconcileOperations();
        conversations.repairQueueNotices();
        await reconcileStartupLifecycleState();
        await resumeStartupManagedSessions();
        for (const endpointId of [...new Set(recoveredEndpointIds)]) {
          if (endpointId === assistantEndpoint.id || activation.unavailable.includes(endpointId)
            || lifecycleOwnedEndpointIds().has(endpointId) || endpointManager.desiredState(endpointId) !== "automatic") continue;
          await reconcileOwnershipBeforeRelayWithLease(endpointManager, ownershipWatcher, relay, endpointId, async (lease) => {
            await pool.reconcileEndpointClaims(
              endpointId, lease, () => endpointManager.validateReadyWorkLease(lease, endpointId),
            );
          });
          endpointReadyBuffer?.acknowledge(endpointId);
        }
        deliveries.recoverAfterCrash();
        await reconcileDeliveryEvents();
        await endpointReadyBuffer?.acceptAndDrain();
        assistantToolReadiness.ready();
      }, stop: async () => undefined,
    },
    {
      name: "scheduler",
      start: async () => {
        if (options.testing?.holdAssistantScheduler) return;
        schedulerAccepting = true;
        await enqueuePendingEvents();
        await dispatcher.enqueueInternal("startup");
        // Provider-agnostic schedule engine + worker MCP surface (Phase 2). Recovery
        // re-arms durable schedules on start; fires drive send_to_session.
        if (scheduling) await scheduling.start();
        // Re-kick active Claude goals whose drive turn was in flight at restart (no
        // pending schedule, no live turn) so goal enforcement is restart-durable.
        const claudeGoalId = config.claudeCode?.endpointId;
        if (claudeGoalDriver && claudeGoals && claudeGoalId !== undefined) {
          const active = claudeGoals.listActive(claudeGoalId)
            .map((g) => registry.getByIdentity(claudeGoalId, g.threadId))
            .filter((found): found is NonNullable<typeof found> => found !== undefined)
            .map((found) => ({ nickname: found.nickname, endpointId: claudeGoalId, threadId: found.session.thread_id }));
          claudeGoalDriver.resumeActive(active);
        }
      },
      stop: async () => {
        stopping = true;
        if (scheduling) await scheduling.stop();
        assistantToolReadiness.stop();
        schedulerAccepting = false;
        const active = assistant.current();
        assistant.fenceToolAdmission();
        await stopOperationRecoveryBeforeTools({
          stopOperationRecovery: () => operationReconciler?.stop() ?? Promise.resolve(),
          waitForTools: () => assistant.waitForTools(),
        });
        if (active?.turnId) {
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
        deliveryWorker = new DeliveryWorker(
          deliveries,
          chatRegistry,
          attachments,
          undefined,
          async (delivery) => {
            try { await durableEventSources.deliveryState(delivery); }
            catch { requestRestartOnce(); }
          },
          (delivery) => { report({ level: "warn", code: "delivery_failed", adapter: delivery.binding.adapterId }); },
        );
        deliveryWorker.start();
      },
      stop: async () => { await deliveryWorker.stop(); },
    },
    {
      name: "external-ownership-watcher",
      start: async () => { await externalOwnershipMonitor.start(); },
      stop: async () => { await externalOwnershipMonitor.stop(); },
    },
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
      ...(managedRecoveryOwner ? { managed: managedRecoveryOwner } : {}),
      ...(operationReconciler ? { operations: operationReconciler } : {}),
      ...(dispatcherAvailable ? { dispatcher } : {}),
      ...(relay ? { relay } : {}),
      ...(observations ? { observations } : {}),
      ...(relay && observations ? { finishDashboard: renderDashboardSafely } : {}),
    }).finally(() => {
      dispatcherAvailable = false;
      assistantLifecycleBuffer.clear();
    });
    return recoveryOwnersStop;
  }

  function buildActions(): Partial<Record<AssistantToolName, (args: any, context: any) => Promise<any>>> {
    return {
      list_managed_sessions: async () => {
        const snapshot = registry.managedSnapshot();
        // Annotate each session with its provider (codex/claude) so the assistant can
        // tell the runtime kind without knowing the endpoint-id convention.
        return {
          ...snapshot,
          sessions: Object.fromEntries(Object.entries(snapshot.sessions).map(([nickname, session]) =>
            [nickname, { ...session, provider: sessionProvider(session.endpoint) }])),
        };
      },
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
        assertSessionCreationOrder(context.operationSequence, args.nickname, endpointId);
        const mappingId = `mapping_${randomUUID()}`;
        context.checkpoint({ endpoint: endpointId, mappingId, dispatchStarted: false });
        return endpointManager.withWorkLease(endpointId, "session-mutation", async (_endpoint, lease) => {
          const project = await workspaceRouter.prepareCreate(endpointId, args.nickname, args.project_dir, lease);
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
        assertSessionCreationOrder(context.operationSequence, args.nickname, endpointId, args.thread_id);
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
        await reconcileExternalOwnershipReleases();
        await reconcileDashboard();
        return { nickname: args.nickname, mapping_id: session.mapping_id };
      },
      archive_session: async (args, context) => {
        const session = registry.get(args.nickname);
        if (!session) throw new AppError("UNKNOWN_SESSION", `unknown session: ${args.nickname}`);
        context.checkpoint({ nickname: args.nickname, ...session, step: "prepared" });
        await lifecycle.archive(args.nickname, (checkpoint) => context.checkpoint(checkpoint));
        await reconcileExternalOwnershipReleases();
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
        assertEndpointLifecycleOrder(context.operationSequence, endpointId);
        await endpointManager.disconnect(endpointId, (checkpoint) => context.checkpoint({ endpoint: endpointId, ...(checkpoint as object) }));
        return { endpoint: endpointId, state: "disconnected" };
      },
      restart_endpoint: async (args, context) => {
        const endpointId = projectEndpoint(args.endpoint);
        assertEndpointLifecycleOrder(context.operationSequence, endpointId);
        await endpointManager.restart(endpointId, (checkpoint) => context.checkpoint({ endpoint: endpointId, ...(checkpoint as object) }));
        await resumeManagedEndpoint(endpointId, true);
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
        const result = await sessions.setGoal(
          args.nickname,
          args.objective,
          args.token_budget,
          () => armGoalControl(args.nickname),
          () => setGoalControlled(args.nickname, false),
        );
        observeGoal(args.nickname, result);
        activateClaudeGoalIfClaude(args.nickname);
        await renderDashboardSafely();
        return result;
      },
      pause_goal: async (args) => {
        try { sessions.authorizeTurn(args.nickname, sessions.activeTurnId(args.nickname)); }
        catch (error) { if (!(error instanceof AppError && error.code === "SESSION_IDLE")) throw error; }
        await sessions.authorizeActiveTurn(args.nickname);
        const result = await sessions.pauseGoal(args.nickname);
        await sessions.authorizeActiveTurn(args.nickname);
        setGoalControlled(args.nickname, false);
        observeGoal(args.nickname, result);
        await renderDashboardSafely();
        return result;
      },
      resume_goal: async (args) => {
        const result = await sessions.resumeGoal(
          args.nickname,
          () => armGoalControl(args.nickname),
          () => setGoalControlled(args.nickname, false),
        );
        observeGoal(args.nickname, result);
        activateClaudeGoalIfClaude(args.nickname);
        await renderDashboardSafely();
        return result;
      },
      cancel_goal: async (args, context) => {
        let turnId: string | null = null;
        try { turnId = sessions.activeTurnId(args.nickname); }
        catch (error) { if (!(error instanceof AppError && error.code === "SESSION_IDLE")) throw error; }
        if (turnId) sessions.authorizeTurn(args.nickname, turnId);
        turnId = await sessions.authorizeActiveTurn(args.nickname) ?? turnId;
        if (args.interrupt_active_turn) context.checkpoint({ turnId });
        const result = await sessions.cancelGoal(args.nickname);
        const activeAfterClear = await sessions.authorizeActiveTurn(args.nickname);
        if (args.interrupt_active_turn && activeAfterClear && activeAfterClear !== turnId) {
          turnId = activeAfterClear;
          context.checkpoint({ turnId });
        }
        setGoalControlled(args.nickname, false);
        if (await interruptCancelledGoalTurn(args.interrupt_active_turn, turnId, async (currentTurnId) => {
          try { await sessions.interrupt(args.nickname, currentTurnId); }
          catch (error) { if (!(error instanceof AppError && error.code === "SESSION_IDLE")) throw error; }
        })) {
          advanceNativeWatermark(args.nickname);
        }
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

  function setGoalControlled(nickname: string, controlled: boolean): void {
    const identity = dashboardIdentity(nickname);
    runtime.setGoalControlled(identity.endpointId, identity.threadId, identity.mappingId, controlled);
  }

  function armGoalControl(nickname: string): void {
    const identity = dashboardIdentity(nickname);
    runtime.setGoalControlled(
      identity.endpointId,
      identity.threadId,
      identity.mappingId,
      true,
      dashboardStore.allocateObservationSequence(),
    );
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

  // Kick the Claude goal auto-drive when a goal is set/resumed via the MCP manager
  // tools. No-op for Codex sessions (native goal engine) and when Claude is disabled.
  function activateClaudeGoalIfClaude(nickname: string): void {
    const claudeId = config.claudeCode?.endpointId;
    if (!claudeGoalDriver || claudeId === undefined) return;
    const session = registry.get(nickname);
    if (session?.endpoint === claudeId) claudeGoalDriver.activate({ nickname, endpointId: claudeId, threadId: session.thread_id });
  }

  function projectEndpoint(requested?: string): string {
    const endpointId = requested ?? endpoint.id;
    if (endpointId === assistantEndpoint.id) throw new AppError("UNSUPPORTED_CAPABILITY", "the assistant-only endpoint cannot host project sessions");
    return endpointId;
  }

  // The provider (runtime kind) of an endpoint. An endpoint is Codex or Claude, fixed
  // at definition time: the local Claude endpoint is bound by config; a remote Claude
  // endpoint is a catalog `type:"claude-code"` entry; everything else is Codex.
  function sessionProvider(endpointId: string): "codex" | "claude" {
    if (config.claudeCode !== undefined && endpointId === config.claudeCode.endpointId) return "claude";
    if (endpointId !== "local" && endpointId !== assistantEndpoint.id) {
      try {
        const entry = endpointCatalog.snapshot().endpoints[endpointId] as { type?: string } | undefined;
        if (entry?.type === "claude-code") return "claude";
      } catch { /* catalog unavailable — treat as codex */ }
    }
    return "codex";
  }

  function operationTargetResolver(): OperationRecoveryTargetResolver {
    return { defaultProjectEndpointId: "local", session: (nickname) => registry.get(nickname) };
  }

  function assertEndpointLifecycleOrder(operationSequence: number, endpointId: string): void {
    if (!hasEarlierEndpointOperation(operations.listRecoverable(), operationSequence, endpointId, operationTargetResolver())) return;
    throw new AppError("OPERATION_CONFLICT", `endpoint ${endpointId} has an earlier unresolved operation`);
  }

  function assertSessionCreationOrder(
    operationSequence: number,
    nickname: string,
    endpointId: string,
    threadId?: string,
  ): void {
    if (!hasEarlierSessionCreation(
      operations.listRecoverable(), operationSequence, { nickname, endpointId, ...(threadId ? { threadId } : {}) }, operationTargetResolver(),
    )) return;
    throw new AppError("OPERATION_CONFLICT", `session ${nickname} has an earlier unresolved creation operation`);
  }

  function hasEndpointIdentityReferences(endpointId: string): boolean {
    return Object.values(registry.snapshot().sessions).some((session) => session.endpoint === endpointId)
      || Boolean(pool?.hasClaims(endpointId))
      || Boolean(operations?.listRecoverable().some((operation) => recoverableCapacityHint(operation)?.endpoint === endpointId))
      || recoverableEndpointReferences().includes(endpointId)
      || recoverableActivationReferences().includes(endpointId);
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

  function bindProjectEndpoint(target: ManagedEndpointContract, generation: number): void {
    for (const unsubscribe of projectEndpointSubscriptions.get(target.id) ?? []) unsubscribe();
    const previousRetry = projectReadyRetryTimers.get(target.id);
    if (previousRetry) clearTimeout(previousRetry.timer);
    projectReadyRetryTimers.delete(target.id);
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
      if (recovery) runBackground(() => recovery, (error) => {
        reportOperationalSafely(report, {
          level: "warn", code: "background_task_failed", component: "project_ready_safety",
        });
        let currentState: { generation: number; ready: boolean; automatic: boolean } | undefined;
        try {
          const value = endpointManager.endpointGeneration(target.id);
          currentState = {
            generation: value.generation,
            ready: value.endpoint.state === "ready",
            automatic: endpointManager.desiredState(target.id) === "automatic",
          };
        } catch { /* An absent generation waits for manager publication. */ }
        if (projectReadyRecoveryDisposition(error, generation, currentState) !== "retry"
          || projectReadyRetryTimers.has(target.id)) return;
        const timer = setTimeout(() => {
          const pending = projectReadyRetryTimers.get(target.id);
          if (pending?.generation !== generation) return;
          projectReadyRetryTimers.delete(target.id);
          requestReadyRecovery();
        }, 1_000);
        timer.unref?.();
        projectReadyRetryTimers.set(target.id, { generation, timer });
      });
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
        }, () => recordBackgroundFailure("permission notification"));
      }),
      target.onUnavailable((kind) => { if (current()) runBackground(() => handleEndpointUnavailable(target, kind), () => recordBackgroundFailure("project unavailable handling")); }),
    ];
    projectEndpointSubscriptions.set(target.id, subscriptions);
    if (target.state === "ready") requestReadyRecovery();
  }

  async function onNotification(endpointId: string, method: string, params: any): Promise<void> {
    const identity = registry.snapshot().assistant;
    const assistantLifecycle = parseAssistantLifecycleNotification(method, params);
    if (assistantLifecycle && endpointId === identity.endpoint && assistantLifecycle.params.threadId === identity.thread_id) {
      await assistantLifecycleBuffer.accept(assistantLifecycle, handleAssistantLifecycleNotification);
      return;
    }
    if (method === "turn/completed") {
      await processWorkerTerminalNotification({
        endpoints: endpointManager,
        ownership: ownershipWatcher,
        relay,
        reconcileOperations,
      }, endpointId, method, params);
      return;
    } else {
      await relay.handleNotification(endpointId, method, params);
    }
  }

  async function handleAssistantLifecycleNotification(notification: AssistantTurnLifecycleNotification): Promise<void> {
    if (notification.method === "turn/started") {
      await dispatcher.started(notification.params.turn as any);
      return;
    }
    await processAssistantTerminal(notification.params);
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
    const terminalLease = conversations.lease();
    if (!terminalLease || terminalLease.phase !== "terminalizing" || terminalLease.turnId !== params.turn.id) return;
    const attemptBefore = assistant.contextForLease(terminalLease.attemptId, params.turn.id);
    if (!attemptBefore) return;
    if (conversations.membersForAttempt(attemptBefore.attemptId)
      .some((member) => new Set(["start_submitting", "steer_submitting", "uncertain"]).has(member.state))) return;
    if (!assistant.beginLeaseTerminalizing(attemptBefore.attemptId, params.turn.id)) return;
    const settled = await settleAssistantTerminalTools({
      fenceTools: () => assistant.fenceTools(attemptBefore.attemptId, 1_000),
      reconcileOperations,
      requestRestartOnce,
    });
    if (!settled) return;
    const memberIds = conversations.membersForAttempt(attemptBefore.attemptId).map((member) => member.contextId);
    await commitAssistantTerminalFinals(params.turn, async () => {
      const history = await pool.request<any>(identity.endpoint, "thread/read", { threadId: identity.thread_id, includeTurns: true });
      return history.thread.turns ?? [];
    }, (resolved) => {
      const messages = finals.persistTerminalTurn(identity.endpoint, identity.thread_id, resolved, Date.now());
      assistant.handleTerminal(
        resolved.id,
        isTerminalStatus(resolved.status) ? resolved.status : "failed",
        messages.map((message) => message.body).join("\n") || undefined,
        resolved.error,
      );
    });
    for (const contextId of memberIds) attemptScope.notifyMembership(contextId);
    if (operations.listRecoverable().some((operation) => operation.attemptId === attemptBefore.attemptId)) {
      await reconcileOperations();
    }
    await enqueuePendingEvents();
    await dispatcher.enqueueInternal("terminal");
  }

  async function enqueuePendingEvents(): Promise<void> {
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
    await dispatcher?.enqueueInternal("events");
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
      if (operationRecoveryAction({
        state: operation.state,
        activeHandler: assistant.hasActiveTools(operation.attemptId),
        recoveryOwned: operationReconciler?.recoveryOwns(operation.id) ?? false,
      }) === "wait_for_tool") return true;
      const preflight = operationRecoveryPreflight(target, isRecoveryEndpointReady);
      if (preflight === "sleep") return true;
      if (preflight === "wait_for_endpoint") {
        waitingForEndpoint = true;
        return true;
      }
      attempted = true;
      const args = operation.args as any;
      let attemptedEndpointGeneration: number | undefined;
      try {
        const recover = async (recoveryLease?: EndpointWorkLease): Promise<void> => {
        attemptedEndpointGeneration = recoveryLease?.endpointGeneration;
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
          await resumeManagedEndpoint(endpointId, true);
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
          if (operation.kind === "create_session" && recoverableCreateHasNoDispatch(operation.receipt, operation.recoveryProtocol)) {
            failRecoveredNoEffect(operation.id, "worker dispatch was never started");
            return;
          }
          const recoveryEndpointId = projectEndpoint(checkpoint?.endpoint ?? args.endpoint);
          if (!recoveryLease || recoveryLease.endpointId !== recoveryEndpointId) {
            throw new AppError("ENDPOINT_UNAVAILABLE", "session recovery endpoint lease changed");
          }
          const lease = recoveryLease;
          let session = registry.get(args.nickname);
          const project = operation.kind === "create_session" && checkpoint ? preparedProjectWorkspaceFromCheckpoint(checkpoint) : undefined;
          if (project) {
            await workspaceRouter.assertDispatchable(recoveryEndpointId, project, lease);
          }
          const expectedThread = args.thread_id as string | undefined ?? (operation.kind === "create_session" ? checkpoint?.threadId : undefined);
          const expectedDir = project?.path;
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
            try {
              await lifecycle.adopt(args.nickname, recoveryEndpointId, checkpoint.threadId, (thread) => {
                if (thread.threadSource !== operation.id) throw new AppError("OPERATION_UNCERTAIN", "recovered worker thread has the wrong creation source");
                hydrateThreadOrder(recoveryEndpointId, thread);
              }, checkpoint.mappingId, lease);
            } catch (error) {
              if (!isMissingUnmaterializedThread(error, checkpoint.threadId)) throw error;
              failRecoveredNoEffect(operation.id, "allocated worker thread was lost before its rollout materialized");
              return;
            }
            session = registry.get(args.nickname);
          }
          if (session?.lifecycle_state === "adopting" && session.mapping_id === checkpoint?.mappingId && session.endpoint === recoveryEndpointId) {
            await lifecycle.reconcileAdopting({ nickname: args.nickname, endpointId: recoveryEndpointId, existingLease: lease });
            session = registry.get(args.nickname);
          }
          if (session?.lifecycle_state === "managed" && session.mapping_id === checkpoint?.mappingId && session.endpoint === recoveryEndpointId
            && (!expectedThread || session.thread_id === expectedThread) && (!expectedDir || session.project_dir === expectedDir)) {
            const state = runtime.getSession(session.endpoint, session.thread_id, session.mapping_id);
            const needsReconcile = state?.managementState !== "managed" || !runtime.currentEpoch(session.endpoint, session.thread_id, session.mapping_id);
            let native: any;
            if (needsReconcile) {
              try {
                native = await lifecycle.reconcileManaged(args.nickname, session, lease, undefined,
                  operation.kind === "create_session" ? { requireDurableRollout: true } : undefined);
              } catch (error) {
                // A create whose worker thread never durably materialized is unrecoverable;
                // reconcileManaged has already removed the phantom mapping, so fail with no effect
                // instead of blessing it as managed (mirrors the adopt-branch gate above).
                if (operation.kind === "create_session" && isRecoveredThreadNotDurable(error)) {
                  failRecoveredNoEffect(operation.id, "allocated worker thread was lost before its rollout materialized");
                  return;
                }
                throw error;
              }
            } else {
              native = await pool.request<any>(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: false }, undefined, lease);
            }
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
            const history = await pool.request<any>(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: true }, undefined, recoveryLease);
            cancelInterruptProven = await recoverCancelGoalInterrupt({
              requested: true,
              ...(checkpoint ? { checkpoint } : {}),
              goal,
              nativeStatus: String(history.thread.status?.type ?? "unknown"),
              turns: history.thread.turns,
              checkpointTurn: (turnId) => operations.checkpoint(operation.id, { turnId }),
              authorize: (turnId) => sessions.authorizeTurn(args.nickname, turnId),
              interrupt: (turnId) => sessions.interrupt(args.nickname, turnId, {
                ...(recoveryLease ? { existingLease: recoveryLease } : {}),
                recoverExactTurn: true,
              }),
            });
          }
          const proven = operation.kind === "set_goal" ? goal?.objective === args.objective && goal?.status === "active" && actualBudget === (args.token_budget ?? null)
            : operation.kind === "pause_goal" ? goal?.status === "paused"
              : operation.kind === "resume_goal" ? goal?.status === "active"
                : goal == null && cancelInterruptProven;
          if (!proven && (operation.kind === "set_goal" || operation.kind === "resume_goal")) {
            restoredGoalControlIsActive(current);
            await sessions.authorizeActiveTurn(args.nickname, recoveryLease);
            setGoalControlled(args.nickname, false);
          }
          if (proven && (operation.kind === "pause_goal" || operation.kind === "cancel_goal")) {
            await sessions.authorizeActiveTurn(args.nickname, recoveryLease);
          }
          if (proven) await succeedRecovered(operation, current, () => {
            if (operation.kind === "set_goal" || operation.kind === "resume_goal") armGoalControl(args.nickname);
            else setGoalControlled(args.nickname, false);
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
        let exactGenerationReady = false;
        if (target.policy === "ready_endpoint" && attemptedEndpointGeneration !== undefined) {
          try {
            const value = endpointManager.endpointGeneration(target.endpointId);
            exactGenerationReady = value.generation === attemptedEndpointGeneration
              && value.endpoint.state === "ready"
              && endpointManager.desiredState(target.endpointId) === "automatic";
          } catch { /* A missing generation waits for manager publication. */ }
        }
        const disposition = operationRecoveryFailureDisposition(error, target, exactGenerationReady);
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
      await reconcileExternalOwnershipReleases();
      return;
    }
    for (const endpointId of endpointIds) await reconcileLifecycleState({ endpointId });
  }

  async function resumeStartupManagedSessions(): Promise<void> {
    const excluded = lifecycleOwnedEndpointIds();
    const endpointIds = [...new Set(Object.values(registry.managedSnapshot().sessions).map((session) => session.endpoint))]
      .filter((endpointId) => !excluded.has(endpointId) && endpointManager.desiredState(endpointId) === "automatic");
    for (const endpointId of endpointIds) await resumeManagedEndpoint(endpointId);
  }

  async function resumeManagedEndpoint(endpointId: string, requireAcknowledged = false): Promise<void> {
    const outcome = await recoverStartupManagedEndpoint({
      endpointId,
      withReadyLease: (run) => endpointManager.withReadyWorkLease(endpointId, run),
      isLeaseCurrent: (lease) => isManagedRecoveryLeaseCurrent(endpointId, lease),
      recover: (lease, isCurrent) => resumeManagedSessions(endpointId, { lease, isCurrent }),
      reconcile: (lease) => reconcileRestoredEndpoint(endpointId, lease),
      acknowledge: () => endpointReadyBuffer?.acknowledge(endpointId),
    });
    if (requireAcknowledged) requireManagedRecoveryAcknowledged(outcome, endpointId);
  }

  async function resumeManagedSessions(endpointFilter?: string, options: {
    unavailableOnly?: boolean;
    keys?: readonly ManagedRetryKey[];
    lease?: EndpointWorkLease;
    isCurrent?: () => boolean;
  } = {}): Promise<ManagedSessionRecoveryBatchResult> {
    const exactKeys = options.keys ? new Set(options.keys) : undefined;
    if (!options.unavailableOnly && !exactKeys) {
      for (const session of Object.values(registry.managedSnapshot().sessions)) {
        if (endpointFilter && session.endpoint !== endpointFilter) continue;
        const state = runtime.getSession(session.endpoint, session.thread_id, session.mapping_id);
        if (state?.managementState === "managed") {
          runtime.setSession(session.endpoint, session.thread_id, session.mapping_id, "unavailable", state.nativeStatus);
        }
      }
    }
    const restoredKeys: ManagedRetryKey[] = [];
    const settledKeys: ManagedRetryKey[] = [];
    const failures: Array<{ key: ManagedRetryKey; disposition: ManagedRecoveryDisposition }> = [];
    const seenKeys = new Set<ManagedRetryKey>();
    for (const [nickname, session] of Object.entries(registry.managedSnapshot().sessions)) {
      if (options.isCurrent && !options.isCurrent()) break;
      if (endpointFilter && session.endpoint !== endpointFilter) continue;
      const key = managedRetryKey(session.endpoint, session.thread_id, session.mapping_id);
      if (exactKeys && !exactKeys.has(key)) continue;
      seenKeys.add(key);
      const stateBefore = runtime.getSession(session.endpoint, session.thread_id, session.mapping_id);
      if (options.unavailableOnly && stateBefore?.managementState !== "unavailable") {
        settledKeys.push(key);
        continue;
      }
      try {
        const response = await lifecycle.reconcileManaged(nickname, session, options.lease, options.isCurrent);
        if ((options.isCurrent && !options.isCurrent())
          || (options.lease && !isManagedRecoveryLeaseCurrent(session.endpoint, options.lease))) {
          throw new AppError("ENDPOINT_UNAVAILABLE", "managed recovery endpoint generation changed");
        }
        const activeTurn = [...(response.thread.turns ?? [])].reverse().find((turn: any) => !isTerminalStatus(turn.status));
        if (options.isCurrent && !options.isCurrent()) throw new AppError("ENDPOINT_UNAVAILABLE", "managed recovery owner stopped");
        if (activeTurn) pool.restoreObservedActiveTurn(session.endpoint, session.thread_id, activeTurn.id);
        if (options.isCurrent && !options.isCurrent()) throw new AppError("ENDPOINT_UNAVAILABLE", "managed recovery owner stopped");
        const resumeObservationSequence = dashboardStore.allocateObservationSequence();
        const nativeObservationSequence = dashboardStore.allocateObservationSequence();
        if (options.isCurrent && !options.isCurrent()) throw new AppError("ENDPOINT_UNAVAILABLE", "managed recovery owner stopped");
        hydrateThreadOrder(session.endpoint, response.thread);
        if (options.isCurrent && !options.isCurrent()) throw new AppError("ENDPOINT_UNAVAILABLE", "managed recovery owner stopped");
        observations.observeResume(session.endpoint, session.thread_id, response, Date.now(), {
          settings: resumeObservationSequence,
          native: nativeObservationSequence,
        });
        if (options.isCurrent && !options.isCurrent()) throw new AppError("ENDPOINT_UNAVAILABLE", "managed recovery owner stopped");
        dashboardStore.observeLifecycle({ endpointId: session.endpoint, threadId: session.thread_id }, Date.now());
        if (options.isCurrent && !options.isCurrent()) throw new AppError("ENDPOINT_UNAVAILABLE", "managed recovery owner stopped");
        restoredKeys.push(key);
      } catch (error) {
        if (options.isCurrent && !options.isCurrent()) throw error;
        const current = registry.get(nickname);
        if (isSettledPathlessThreadLoss(error, current, session)) {
          settledKeys.push(key);
          continue;
        }
        const disposition = managedRecoveryDisposition(
          error,
          Boolean(options.lease && isManagedRecoveryLeaseCurrent(session.endpoint, options.lease)),
        );
        failures.push({ key, disposition });
        if (!exactKeys) managedRecoveryOwner?.recordFailure(key, disposition);
        if (current?.mapping_id === session.mapping_id && current.endpoint === session.endpoint
          && current.thread_id === session.thread_id && current.lifecycle_state === "managed") {
          const state = runtime.getSession(session.endpoint, session.thread_id, session.mapping_id);
          const recoveryState = managedRecoveryManagementState(state?.managementState, disposition);
          if (recoveryState !== "unadopting") {
            runtime.setSession(
              session.endpoint,
              session.thread_id,
              session.mapping_id,
              recoveryState,
              disposition === "external" ? state?.nativeStatus ?? "notLoaded" : "notLoaded",
            );
            if (disposition === "permanent") warnSessionUnavailable(nickname, session.endpoint, session.thread_id);
          }
          dashboardStore.observeLifecycle({ endpointId: session.endpoint, threadId: session.thread_id }, Date.now());
        }
      }
    }
    if (exactKeys) for (const key of exactKeys) if (!seenKeys.has(key)) settledKeys.push(key);
    return { restored: restoredKeys.length > 0, restoredKeys, settledKeys, failures };
  }

  function isManagedRecoveryLeaseCurrent(endpointId: string, lease: EndpointWorkLease): boolean {
    try {
      const current = endpointManager.endpointGeneration(endpointId);
      return current.generation === lease.endpointGeneration && endpointManager.validateReadyWorkLease(lease, endpointId);
    } catch { return false; }
  }

  async function reconcileRestoredEndpoint(endpointId: string, existingLease?: EndpointWorkLease): Promise<void> {
    const reconcile = async (lease: EndpointWorkLease): Promise<void> => {
      const isCurrent = (): boolean => isManagedRecoveryLeaseCurrent(endpointId, lease);
      const beforeIncidents = await beforeRestoredEndpoint(endpointId, lease, isCurrent);
      await wakeRestoredEndpoint(endpointId, lease, isCurrent);
      await afterRestoredEndpoint(endpointId, lease, beforeIncidents, isCurrent);
    };
    if (existingLease) {
      await endpointManager.runWithWorkLease(endpointId, existingLease, async (lease) => {
        if (!lease) throw new AppError("ENDPOINT_UNAVAILABLE", "managed recovery endpoint lease is unavailable");
        await reconcile(lease);
      });
      return;
    }
    await endpointManager.withReadyWorkLease(endpointId, reconcile);
  }

  function assertManagedRecoveryCurrent(isCurrent: () => boolean): void {
    if (!isCurrent()) throw new AppError("ENDPOINT_UNAVAILABLE", "managed recovery generation changed during downstream work");
  }

  async function beforeRestoredEndpoint(
    endpointId: string,
    lease: EndpointWorkLease,
    isCurrent: () => boolean,
  ): Promise<readonly ManagedOwnershipIncidentReceipt[]> {
    assertManagedRecoveryCurrent(isCurrent);
    const incidents = await ownershipWatcher.detectEndpoint(endpointId, lease, isCurrent);
    assertManagedRecoveryCurrent(isCurrent);
    await pool.reconcileEndpointClaims(endpointId, lease, isCurrent);
    assertManagedRecoveryCurrent(isCurrent);
    return incidents;
  }

  async function wakeRestoredEndpoint(
    endpointId: string,
    lease: EndpointWorkLease,
    isCurrent: () => boolean,
  ): Promise<void> {
    assertManagedRecoveryCurrent(isCurrent);
    await wakeRestoredSessionOwners({
      relay,
      observations,
      onError: (owner) => reportOperationalSafely(report, {
        level: "warn", code: "background_task_failed", component: `managed_${owner}_recovery`,
      }),
    }, endpointId, lease, isCurrent);
    assertManagedRecoveryCurrent(isCurrent);
  }

  async function afterRestoredEndpoint(
    endpointId: string,
    lease: EndpointWorkLease,
    beforeIncidents: readonly ManagedOwnershipIncidentReceipt[],
    isCurrent: () => boolean,
  ): Promise<void> {
    await releaseRestoredOwnershipIncidents({ ownership: ownershipWatcher }, endpointId, lease, beforeIncidents, isCurrent);
  }

  function recoverProjectEndpoint(endpointId: string): Promise<void> {
    const existing = projectEndpointRecoveries.get(endpointId);
    if (existing) return existing;
    const recovery = (async () => {
      await reconcileLifecycleState({ endpointId });
      let recoveredGeneration: number | undefined;
      await recoverReadyEndpointOwners({
        recoverManaged: (wakeShared) => endpointManager.withReadyWorkLease(endpointId, (lease) => {
          recoveredGeneration = lease.endpointGeneration;
          return recoverManagedEndpointReady(managedRecoveryOwner!, endpointId, lease, wakeShared);
        }),
        relay: () => relay.endpointReady(endpointId),
        observations: () => observations.endpointReady(endpointId),
        operations: () => operationReconciler?.endpointReady(endpointId) ?? Promise.resolve(),
        onError: (owner) => reportOperationalSafely(report, {
          level: "warn", code: "background_task_failed", component: `endpoint_ready_${owner}_recovery`,
        }),
      });
      if (recoveredGeneration === undefined) {
        throw new AppError("ENDPOINT_UNAVAILABLE", `endpoint recovery did not establish a ready generation: ${endpointId}`);
      }
      await endpointManager.withReadyWorkLease(endpointId, async (lease) => {
        if (lease.endpointGeneration !== recoveredGeneration || !endpointManager.validateReadyWorkLease(lease, endpointId)) {
          throw new AppError("ENDPOINT_UNAVAILABLE", `endpoint generation changed before recovery publication: ${endpointId}`);
        }
        const incident = endpointRecoveryIncidents.pending(endpointId);
        if (incident !== undefined) {
          deliveries.prepare({
            id: `endpoint-recovered:${endpointId}:${incident}`,
            kind: "system_warning",
            binding: currentOwnerBinding(),
            body: `[system] ${endpointId} app-server reconnected`,
            mandatory: true,
          });
          endpointRecoveryIncidents.consume(endpointId, incident);
        }
        await renderDashboardSafely();
      });
    })().finally(() => { if (projectEndpointRecoveries.get(endpointId) === recovery) projectEndpointRecoveries.delete(endpointId); });
    projectEndpointRecoveries.set(endpointId, recovery);
    return recovery;
  }

  async function handleEndpointUnavailable(target: ManagedEndpointContract, kind: EndpointLossKind = "runtime-lost"): Promise<void> {
    if (stopping || !endpointsCommitted) return;
    const endpointIncident = endpointRecoveryIncidents.record(target.id);
    markEndpointOwnersUnavailable({
      relay,
      observations,
      managed: managedRecoveryOwner!,
      operations: operationReconciler!,
    }, target.id);
    if (target.id === assistantEndpoint.id) endpointReadyBuffer?.pause();
    pool.markEndpointUnavailable(target.id, kind);
    for (const session of runtime.listSessions()) {
      if (session.endpointId === target.id && session.managementState === "managed") {
        runtime.setSession(session.endpointId, session.threadId, session.mappingId, "unavailable", "notLoaded");
        managedRecoveryOwner?.recordFailure(managedRetryKey(session.endpointId, session.threadId, session.mappingId), "endpoint");
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
    await durableEventSources.endpointUnavailable({
      id: `endpoint-unavailable:${target.id}:${endpointIncident}`,
      endpointId: target.id,
      threadId: identity.thread_id,
      incident: endpointIncident,
      createdAt: Date.now(),
    });
    if (target.id === assistantEndpoint.id) scheduleAssistantReconnect();
    await renderDashboardSafely();
  }

  function scheduleAssistantReconnect(): void {
    const endpointId = assistantEndpoint.id;
    if (stopping || reconnectTimers.has(endpointId)) return;
    const attempt = reconnectAttempts.get(endpointId) ?? 0;
    const delay = Math.min(1_000 * 2 ** attempt, 30_000);
    reconnectAttempts.set(endpointId, attempt + 1);
    const timer = setTimeout(() => {
      reconnectTimers.delete(endpointId);
      void recoverAssistantEndpoint().catch(scheduleAssistantReconnect);
    }, delay);
    reconnectTimers.set(endpointId, timer);
    timer.unref?.();
  }

  async function recoverAssistantEndpoint(): Promise<void> {
    if (stopping) return;
    try {
      await assistantEndpoint.start();
    } catch (error) {
      if (error instanceof EndpointAuthenticationRequiredError) {
        recordAssistantAuthenticationFailure(deliveries, currentOwnerBinding, endpointRecoveryIncidents.latestSequence);
      }
      throw error;
    }
    await startOrResumeAssistant();
    await dispatcher.recover();
    await dispatcher.idle();
    assistant.hydrateActive();
    await operationReconciler?.endpointReady(assistantEndpoint.id);
    assistantToolReadiness.ready();
    schedulerAccepting = true;
    await endpointReadyBuffer?.acceptAndDrain();
    reconnectAttempts.set(assistantEndpoint.id, 0);
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
      id: `session-unavailable:${endpointId}:${threadId}:${endpointRecoveryIncidents.latestSequence}`,
      kind: "worker_warning",
      binding: currentOwnerBinding(),
      body: `[${nickname}] unavailable; its registered thread and project directory require verification`,
      mandatory: true,
    });
  }

  async function reconcileDeliveryEvents(): Promise<void> {
    await durableEventSources.reconcileDeliveryStates();
  }

  async function reconcileExternalOwnershipReleases(): Promise<number> {
    return durableEventSources.reconcileOwnership();
  }

  async function reconcileLifecycleState(filter: { endpointId?: string; nickname?: string } = {}): Promise<void> {
    await durableEventSources.reconcileLifecycle(filter);
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

  return composeApp(phases);
}

export function createChatHistoryAction(
  registry: () => ChatAdapterRegistry,
  binding: (attemptId: string) => ConversationBinding,
): (args: ChatHistoryRequest, context: { attemptId: string }) => Promise<JsonValue> {
  return (args, context) => registry().getHistory(binding(context.attemptId), args);
}

export function isUncertainAssistantTransportFailure(error: unknown, endpointState: ManagedEndpointContract["state"]): boolean {
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
  const binding = adapter.primaryBinding;
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
