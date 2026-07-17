import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { hostname } from "node:os";
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
import {
  createHistoryScanBudget,
  isHistoryScanBudgetExhausted,
  type ThreadHistoryReader,
} from "./app-server/thread-history.ts";
import { RpcRequestTimeoutError } from "./app-server/rpc-client.ts";
import { MINIMUM_SUPPORTED_CODEX_VERSION } from "./app-server/protocol.ts";
import { composeApp, type AppPhase, type BotApp } from "./app.ts";
import type { BotConfig } from "./config.ts";
import { parseDirective } from "./directives/parser.ts";
import { deliverDirectTo } from "./assistant/direct-to.ts";
import { WebBus, createWebAdapter, createWebUiPhase, WEB_ADAPTER_ID } from "./webui/index.ts";
import { createWebGoalControl, type WebGoalControl } from "./webui/web-goal-control.ts";
import { workerDeliveryNickname } from "./webui/web-reads.ts";
import { webUiStatePath } from "./webui/webui-state.ts";
import { claudeLaunchPolicy } from "./config.ts";
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
import { AssistantPostTurnActions, type AssistantPostTurnAction } from "./assistant/post-turn-actions.ts";
import { runAssistantCompaction, runAssistantRestart, startAssistantTurnWithPendingSettings } from "./assistant/self-controls.ts";
import { recordAssistantSystemAwareness } from "./assistant/system-awareness.ts";
import { AssistantScheduler, type EventJob } from "./assistant/scheduler.ts";
import { ConversationDispatcher, prepareAssistantStartDispatch, type AssistantTurnPort } from "./assistant/conversation-dispatcher.ts";
import {
  AssistantLifecycleBuffer,
  parseAssistantLifecycleNotification,
  type AssistantTurnLifecycleNotification,
} from "./assistant/lifecycle-buffer.ts";
import { AttemptScope } from "./assistant/attempt-scope.ts";
import { SessionObservationProcessor } from "./assistant/session-observer.ts";
import { createAssistantTools, type AssistantToolName, type ToolHandler } from "./assistant/tools.ts";
import { readWorkerMessages } from "./assistant/worker-message-history.ts";
import { prepareAssistantWorkspace } from "./assistant/workspace.ts";
import { EventRelay } from "./events/relay.ts";
import { persistDeliveryStateEvent, reconcileDeliveryStateEvents } from "./events/delivery-status.ts";
import { buildWorkerChildEnvironment, assistantTurnConfig, LoopbackMcpServer, ToolReadinessGate } from "./mcp/server.ts";
import { SessionRegistry, type RegistrySession } from "./registry/session-registry.ts";
import { SessionDiscovery } from "./sessions/discovery.ts";
import { FinalMessageStore } from "./sessions/final-messages.ts";
import { SessionLifecycle } from "./sessions/lifecycle.ts";
import { readReadyWorkerTurns } from "./webui/worker-native-read.ts";
import { CodexHistoryAccess } from "./webui/codex-history-access.ts";
import { createWorkerStream, offerWorkerDiscontinuity, offerWorkerNotification } from "./webui/worker-stream.ts";
import { OwnershipEventStore } from "./sessions/ownership-event-store.ts";
import {
  ExternalOwnershipMonitor,
  SessionOwnershipWatcher,
  type ExternalOwnershipCycleResult,
  type ExternalOwnershipReleaseStatus,
  type ExternalTurnIncident,
} from "./sessions/ownership-watcher.ts";
import { createAppServerRolloutPathResolver, type RolloutPathResolver, SessionOwnershipGuard } from "./sessions/rollout-ownership.ts";
import { preparedProjectWorkspaceFromCheckpoint, ProjectWorkspacePolicy, type PreparedProjectWorkspace } from "./sessions/project-workspace.ts";
import { SessionService } from "./sessions/service.ts";
import { NativeSessionState } from "./sessions/native-session-state.ts";
import { ThreadGate } from "./sessions/thread-gate.ts";
import { openDatabase, type Database } from "./storage/database.ts";
import { acquireDatabaseLease, type DatabaseLease } from "./storage/database-lease.ts";
import { openStateDatabaseWithAutomaticRecovery } from "./storage/automatic-dashboard-recovery.ts";
import { DeliveryStore, type DeliveryRecord } from "./storage/delivery-store.ts";
import { BackgroundFailureStore } from "./storage/background-failure-store.ts";
import { ConversationStore, type ChatAcceptanceEffects } from "./storage/conversation-store.ts";
import { conversationCutoverNeedsAssistantHistory, finalizeConversationCutover, preflightConversationCutover, runConversationRoutingBackfill } from "./storage/conversation-cutover.ts";
import { OperationStore, type RecoverableOperation } from "./storage/operation-store.ts";
import { SessionControlStore } from "./storage/session-control-store.ts";
import { ManagedEpochStore } from "./storage/managed-epoch-store.ts";
import { SessionDeliveryProgressStore } from "./storage/session-delivery-progress-store.ts";
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
import { NativeCapacityBridge } from "./endpoints/native-capacity-bridge.ts";
import { SshGenerationPlanner } from "./endpoints/ssh-config.ts";
import { prepareSshFreshChannelUnavailableNotice } from "./endpoints/ssh-recovery.ts";
import { attestUserControlMaster, prepareRemoteHost, type RemoteHost, SshRemoteClient, SshRuntime } from "./endpoints/ssh-runtime.ts";
import { SshClaudeCommandRunner } from "./endpoints/ssh-claude-command-runner.ts";
import { RemoteWorkerTunnel } from "./endpoints/remote-worker-tunnel.ts";
import { SshAppServerRuntime } from "./endpoints/ssh-app-server-runtime.ts";
import { prepareLocalSshRuntimeRoot } from "./endpoints/local-runtime.ts";
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
import { ClaudeArchiveStore } from "./sessions/claude-archives.ts";
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
const webuiStaticRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/webui");
const fullAccessWarning = "QiYan assistant is running non-interactively with full filesystem access and approvals disabled.";
const assistantMappingId = "assistant";
const scheduledFailureThreshold = 3;
const externalOwnershipFailureEpisode = "external-ownership-detection";
const recoveryTurnWindowLimit = 64;

export function assistantAccessWarning(mode: BotConfig["assistantSandboxMode"]): string | undefined {
  return mode === "danger-full-access" ? fullAccessWarning : undefined;
}

// An endpoint runs on QiYan's own host (no ssh) when it is the Codex `"local"` endpoint or the
// local Claude endpoint (the endpoints.json entry with transport:"local"). Local endpoints resolve
// to the local project workspace and in-process file handling; every other id is remote (ssh).
// One predicate for the workspace router, rollout-access, and the worker file bridge so they
// cannot diverge (they did — the local Claude endpoint was mis-sent through the ssh path).
export function isLocalEndpointId(endpointId: string, localClaudeEndpointId?: string): boolean {
  return endpointId === "local" || (localClaudeEndpointId !== undefined && endpointId === localClaudeEndpointId);
}

function isForeignAssistantThreadNotification(
  endpointId: string,
  assistant: { endpoint: string; thread_id: string },
  params: unknown,
): boolean {
  if (endpointId !== assistant.endpoint || !params || typeof params !== "object" || Array.isArray(params)) return false;
  const threadId = (params as Record<string, unknown>).threadId;
  return typeof threadId === "string" && threadId !== assistant.thread_id;
}

export async function routeLifecycleNotification(
  handlers: {
    assistant(notification: AssistantTurnLifecycleNotification): Promise<void>;
    worker(endpointId: string, method: string, params: unknown): Promise<void>;
  },
  endpointId: string,
  assistant: { endpoint: string; thread_id: string },
  method: string,
  params: unknown,
): Promise<boolean> {
  if (endpointId === assistant.endpoint) {
    if (isForeignAssistantThreadNotification(endpointId, assistant, params)) return true;
    const lifecycle = parseAssistantLifecycleNotification(method, params);
    if (lifecycle?.params.threadId === assistant.thread_id) {
      await handlers.assistant(lifecycle);
      return true;
    }
    // The assistant-only endpoint can never own a managed worker. Consume malformed terminal
    // notifications here rather than routing them through the project endpoint manager.
    return method === "turn/completed";
  }
  if (method !== "turn/completed") return false;
  await handlers.worker(endpointId, method, params);
  return true;
}

export function reportAssistantTerminalFailure(
  dispatcher: Pick<ConversationDispatcher, "requestRecovery"> | undefined,
  report: () => void,
): void {
  try { report(); }
  finally { dispatcher?.requestRecovery(); }
}

export function prepareAssistantWebCommentary(
  conversations: { bindingForTurn(turnId: string): ConversationBinding | undefined },
  deliveries: { prepare(input: { id: string; kind: string; binding: ConversationBinding; body: string; mandatory: boolean }): unknown },
  expectedThreadId: string,
  isActiveTurn: (turnId: string) => boolean,
  method: string,
  params: unknown,
): boolean {
  if (method !== "item/completed" || !params || typeof params !== "object" || Array.isArray(params)) return false;
  const notification = params as Record<string, unknown>;
  if (notification.threadId !== expectedThreadId || typeof notification.turnId !== "string"
    || !notification.item || typeof notification.item !== "object" || Array.isArray(notification.item)) return false;
  const item = notification.item as Record<string, unknown>;
  if (item.type !== "agentMessage" || item.phase !== "commentary" || typeof item.id !== "string"
    || typeof item.text !== "string" || item.text.trim().length === 0) return false;
  const binding = conversations.bindingForTurn(notification.turnId);
  if (!isActiveTurn(notification.turnId) || binding?.adapterId !== WEB_ADAPTER_ID) return false;
  deliveries.prepare({
    id: `assistant-commentary:${notification.turnId}:${item.id}`,
    kind: "assistant_commentary",
    binding,
    body: item.text,
    mandatory: true,
  });
  return true;
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
  if (!candidate || !new Set(["full", "summary"]).has(candidate.itemsView)
    || candidate.status !== notification.status) return notification;
  // A Codex legacy summary is authoritative for user/agent messages even though it omits tool
  // detail. That is sufficient for committing the terminal answer. Still require it to retain
  // every item already observed in the notification so hydration can never discard live evidence.
  const additionalObservedItems: T["items"] = [];
  const retainsNotification = notification.items.every((item) => {
    const id = item.id;
    if (typeof id !== "string") return false;
    const match = candidate.items.find((value) => value.id === id);
    if (match) return Object.entries(item).every(([key, value]) => isDeepStrictEqual(match[key], value));
    if (candidate.itemsView !== "summary" || item.type === "userMessage" || item.type === "agentMessage") return false;
    additionalObservedItems.push(item);
    return true;
  });
  if (!retainsNotification) return notification;
  return additionalObservedItems.length === 0
    ? candidate
    : { ...candidate, items: [...candidate.items, ...additionalObservedItems] };
}

export function throwAssistantNativeRecoveryFailure(failure: unknown): never {
  if (failure !== undefined) throw failure;
  throw new AppError("ENDPOINT_UNAVAILABLE", "assistant native recovery snapshot is unavailable");
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
  closeGoalAdmission(): void;
  stopOperationRecovery(): Promise<void>;
  waitForTools(): Promise<void>;
  waitForGoalControls(): Promise<void>;
}): Promise<void> {
  let admissionError: unknown;
  try { dependencies.closeGoalAdmission(); }
  catch (error) { admissionError = error; }
  let stopping: Promise<void>;
  try { stopping = dependencies.stopOperationRecovery(); }
  catch (error) { stopping = Promise.reject(error); }
  let waiting: Promise<void>;
  try { waiting = dependencies.waitForTools(); }
  catch (error) { waiting = Promise.reject(error); }
  let webGoals: Promise<void>;
  try { webGoals = dependencies.waitForGoalControls(); }
  catch (error) { webGoals = Promise.reject(error); }
  const [stopped, tools, web] = await Promise.allSettled([stopping, waiting, webGoals]);
  if (admissionError !== undefined) throw admissionError;
  if (stopped.status === "rejected") throw stopped.reason;
  if (tools.status === "rejected") throw tools.reason;
  if (web.status === "rejected") throw web.reason;
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
  private readonly incidents = new Map<string, { sequence: number; episode: string }>();

  constructor(private readonly runId: string = randomUUID()) {}

  record(endpointId: string): { sequence: number; episode: string } {
    this.sequence += 1;
    const incident = {
      sequence: this.sequence,
      episode: this.incidents.get(endpointId)?.episode ?? `${this.runId}:${this.sequence}`,
    };
    this.incidents.set(endpointId, incident);
    return incident;
  }

  pending(endpointId: string): { sequence: number; episode: string } | undefined { return this.incidents.get(endpointId); }

  consume(endpointId: string, incident: { sequence: number; episode: string }): boolean {
    const current = this.incidents.get(endpointId);
    if (current?.sequence !== incident.sequence || current.episode !== incident.episode) return false;
    this.incidents.delete(endpointId);
    return true;
  }

  get latestSequence(): number { return this.sequence; }
}

export function completeEndpointRecoveryIncident(
  incidents: EndpointRecoveryIncidents,
  endpointId: string,
  prepare: (incident: { sequence: number; episode: string }) => void,
): boolean {
  const incident = incidents.pending(endpointId);
  if (incident === undefined) return false;
  prepare(incident);
  return incidents.consume(endpointId, incident);
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
  readonly assistantEndpointId?: string;
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
    case "compact_session": {
      if (args.nickname === "assistant") return { policy: "local" };
      const endpointId = stringField(operation.receipt, "endpointId");
      return endpointId ? { policy: "ready_endpoint", endpointId } : sessionTarget(args.nickname);
    }
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
      return {
        policy: "endpoint_lifecycle",
        endpointId: stringField(operation.receipt, "endpoint") ?? stringField(args, "endpoint") ?? resolver.defaultProjectEndpointId,
      };
    case "restart_endpoint": {
      const endpointId = stringField(operation.receipt, "endpoint") ?? stringField(args, "endpoint") ?? resolver.defaultProjectEndpointId;
      return endpointId === resolver.assistantEndpointId ? { policy: "local" } : { policy: "endpoint_lifecycle", endpointId };
    }
    default:
      return { policy: "unknown" };
  }
}

export function assistantPostTurnActionMatches(
  action: AssistantPostTurnAction | undefined,
  expected:
    | { kind: "compact"; endpointId: string; threadId: string }
    | { kind: "restart"; endpointId: string },
): boolean {
  if (!action || action.kind !== expected.kind || action.payload.endpointId !== expected.endpointId) return false;
  if (expected.kind === "compact") return action.payload.threadId === expected.threadId;
  try { parseRuntimeIdentity(action.payload.runtimeIdentity); return true; }
  catch { return false; }
}

export function assistantStartupCanDrainPostTurnActions(
  nativeStatus: string,
  turns: ReadonlyArray<{ status: unknown }>,
): boolean {
  const terminal = new Set(["completed", "failed", "interrupted"]);
  return nativeStatus === "idle" && turns.every((turn) => terminal.has(String(turn.status)));
}

export async function finalizeAssistantStartup(
  nativeStatus: string,
  turns: ReadonlyArray<{ status: unknown }>,
  finalize: () => void | Promise<void>,
  drain: () => void | Promise<void>,
): Promise<void> {
  await finalize();
  if (assistantStartupCanDrainPostTurnActions(nativeStatus, turns)) await drain();
}

interface RecoveredSendHistory {
  thread: {
    status?: { type?: string };
    turns: ReadonlyArray<{
      itemsView: "full" | "summary" | "notLoaded";
      items: ReadonlyArray<{ type?: string; clientId?: string }>;
    }>;
  };
}

export function reconcileAbsentRecoveredSendStart(
  operations: Pick<OperationStore, "failAndUnbindWithReconciliation">,
  operation: Pick<RecoverableOperation, "id" | "contextId" | "callId" | "kind" | "args">,
  history: RecoveredSendHistory,
  releaseHolds: () => void,
): boolean {
  const args = operation.args as { mode?: unknown };
  if (operation.kind !== "send_to_session" || args.mode !== "start" || history.thread.status?.type !== "idle") return false;
  if (history.thread.turns.some((turn) => turn.itemsView === "notLoaded")) return false;
  const clientId = `${operation.contextId}:${operation.callId}`;
  const created = history.thread.turns.some((turn) => turn.items.some((item) => item.type === "userMessage" && item.clientId === clientId));
  if (created) return false;
  releaseHolds();
  operations.failAndUnbindWithReconciliation(operation.id, { message: "thread history proves the requested start did not create a turn" });
  return true;
}

export function recoveryTurnSuffix<T extends { id: string }>(turns: readonly T[], baselineTurnId: string | null): T[] {
  if (baselineTurnId === null) return [...turns];
  const index = turns.findIndex((turn) => turn.id === baselineTurnId);
  if (index < 0) throw new AppError("OPERATION_UNCERTAIN", "recovery history baseline turn is absent");
  return turns.slice(index + 1);
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
  if (error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE"
    && error.details?.recovery === "ssh_fresh_channel_unavailable") {
    return target?.policy === "endpoint_lifecycle" || target?.policy === "ready_endpoint"
      ? "wait_for_endpoint"
      : "sleep";
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

export function assistantEventIsActionable(kind: string): boolean {
  return kind !== "delivery_status";
}

export function routePendingAssistantEvents(db: Database, enqueue: (event: EventJob) => void): void {
  const rows = db.prepare("SELECT id, endpoint_id, thread_id, kind, payload_json, created_at FROM events WHERE state = 'pending' ORDER BY created_at, id")
    .all() as Array<Record<string, unknown>>;
  const latestTransient = new Map<string, string>();
  for (const row of rows) {
    if (!assistantEventIsActionable(String(row.kind))) continue;
    const payload = JSON.parse(String(row.payload_json));
    if (payload && typeof payload === "object" && "status" in payload && !("final" in payload)) {
      latestTransient.set(`${row.endpoint_id}:${row.thread_id}`, String(row.id));
    }
  }
  for (const row of rows) {
    const id = String(row.id);
    if (!assistantEventIsActionable(String(row.kind))) {
      db.prepare("UPDATE events SET state = 'coalesced' WHERE id = ? AND state = 'pending'").run(id);
      continue;
    }
    const sessionKey = `${row.endpoint_id}:${row.thread_id}`;
    const payload = JSON.parse(String(row.payload_json));
    if (payload && typeof payload === "object" && "status" in payload && !("final" in payload)
      && latestTransient.get(sessionKey) !== id) {
      db.prepare("UPDATE events SET state = 'coalesced' WHERE id = ? AND state = 'pending'").run(id);
      continue;
    }
    enqueue({ id, sessionKey, payload, queuedAt: Number(row.created_at) });
  }
}

export async function hydrateSelectedThreadTurns(
  threadId: string,
  thread: any,
  turnIds: Iterable<string | undefined>,
  reader: Pick<ThreadHistoryReader, "exactTurnItems">,
  options: { allowLegacySummary?: boolean; retainPartialOnBudgetExhaustion?: boolean } = {},
): Promise<any> {
  const targets = new Set([...turnIds].filter((id): id is string => typeof id === "string" && id.length > 0));
  if (targets.size === 0) return thread;
  const budget = createHistoryScanBudget();
  const replacements = new Map<string, any>();
  for (const turn of thread.turns ?? []) {
    if (!targets.has(String(turn.id))) continue;
    try {
      const exact = await reader.exactTurnItems(threadId, String(turn.id), {
        budget,
        ...(options.allowLegacySummary === undefined ? {} : { allowLegacySummary: options.allowLegacySummary }),
      });
      replacements.set(String(turn.id), {
        ...turn,
        ...(exact.summaryTurn ?? {}),
        id: String(turn.id),
        itemsView: exact.complete ? "full" : "summary",
        items: exact.items,
      });
    } catch (error) {
      if (options.retainPartialOnBudgetExhaustion && isHistoryScanBudgetExhausted(error)) break;
      throw error;
    }
  }
  return {
    ...thread,
    turns: (thread.turns ?? []).map((turn: any) => replacements.get(String(turn.id)) ?? turn),
  };
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

export function managedRecoveryRequiresConnectionResume(provider: string, remote: boolean): boolean {
  return provider === "codex" && remote;
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

export async function settleStartupCapacityBootstrap(
  endpointIds: readonly string[],
  recover: (endpointId: string) => Promise<void>,
  onError: (endpointId: string, error: unknown) => void,
): Promise<Set<string>> {
  const endpoints = new Set(endpointIds);
  await Promise.all([...endpoints].map(async (endpointId) => {
    try { await recover(endpointId); }
    catch (error) { onError(endpointId, error); }
  }));
  return endpoints;
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

export function parseEndpointLifecycleCheckpoint(value: unknown): { endpoint: string; phase: "draining" | "idle_proven" | "runtime_stopped" | "runtime_started"; identity?: RuntimeIdentity } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !new Set(["endpoint", "phase", "identity"]).has(key))) return undefined;
  if (typeof item.endpoint !== "string" || !new Set(["draining", "idle_proven", "runtime_stopped", "runtime_started"]).has(String(item.phase))) return undefined;
  try {
    // A daemonless endpoint (Claude) checkpoints with no runtime identity, so `identity` is
    // absent from the persisted receipt — accept that instead of failing the parse (which
    // would strand the recovery and permanently lock out the endpoint's lifecycle ops).
    return {
      endpoint: item.endpoint,
      phase: item.phase as "draining" | "idle_proven" | "runtime_stopped" | "runtime_started",
      ...(item.identity === undefined ? {} : { identity: parseRuntimeIdentity(item.identity) }),
    };
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
      onWebUiStarted?(url: string): void;
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
  const localHostName = hostname();
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
  let localClaudeEndpointId: string | undefined; // the local Claude endpoint id, if configured (for web file-browse locality)
  let webSshRuntimeRoot: string | undefined; // the ssh ControlMaster runtime root (for the web UI's remote file reads)
  let observations!: SessionObservationProcessor;
  let attachments!: AttachmentStore;
  let attachmentCleanup!: AttachmentCleanup;
  let operations!: OperationStore;
  let deliveries!: DeliveryStore;
  let backgroundFailures!: BackgroundFailureStore;
  const nativeSessions = new NativeSessionState();
  let sessionControls!: SessionControlStore;
  let managedEpochs!: ManagedEpochStore;
  let sessionDeliveryProgress!: SessionDeliveryProgressStore;
  let finals!: FinalMessageStore;
  let endpoint!: ManagedAppServerEndpoint;
  let assistantEndpoint!: ManagedAppServerEndpoint;
  let claudeEndpoint: ClaudeCodeRuntime | undefined;
  let scheduling: SchedulingService | undefined;
  let claudeGoals: ClaudeGoalStore | undefined;
  let claudeArchives: ClaudeArchiveStore | undefined;
  let claudeGoalDriver: ClaudeGoalDriver | undefined;
  const CLAUDE_MAX_GOAL_TURNS = 50;
  let endpointCatalog!: EndpointCatalog;
  let endpointBindings!: EndpointBindingStore;
  let endpointManager!: EndpointManager;
  let pool!: AppServerPool;
  let nativeCapacityBridge: NativeCapacityBridge | undefined;
  let discovery!: SessionDiscovery;
  let lifecycle!: SessionLifecycle;
  let ownership!: SessionOwnershipGuard;
  let codexHistoryAccess!: CodexHistoryAccess;
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
  let assistantPostTurnActions!: AssistantPostTurnActions;
  let assistantCurrentSettings: { model?: string; effort?: string | null } = {};
  let conversations!: ConversationStore;
  let ownerRoutes!: OwnerRouteStore;
  let ownerRouteCatalog: OwnerRouteCatalog | undefined;
  let weixinIncidents: WeixinIncidentRouter | undefined;
  let attemptScope!: AttemptScope;
  let dispatcher!: ConversationDispatcher;
  let dispatcherAvailable = false;
  let scheduler!: AssistantScheduler;
  let mcp!: LoopbackMcpServer;
  let webGoalControl: WebGoalControl | undefined;
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
    const directive = parseDirective(source.rawText, source.attachmentIds, config.maxCollectCount);
    if (directive.kind === "to") {
      // `/to <worker> <text>` is delivered directly to the worker + copied to the assistant as an
      // internal awareness source; it does NOT run a normal assistant reply turn.
      await deliverDirectTo({
        alreadyDelivered: (sourceId) => conversations.hasInternalSource("direct_to", sourceId),
        send: (nickname, text, sendOptions) => {
          // Record the client id for this direct relay BEFORE dispatch. A direct send carries no MCP
          // operation and no scheduler outbox marker, so without this the ownership guard misreads the
          // turn it starts as an external Codex turn and releases the session (see ownsDrivenTurn).
          if (sendOptions.clientUserMessageId) ownership.recordDirectSendTurn(sendOptions.clientUserMessageId);
          return sessions.send(nickname, text, sendOptions);
        },
        recordAwareness: (input) => { conversations.createInternalSource(input); },
        pump: () => { void dispatcher.enqueueInternal("direct_to"); },
        commitCheckpoint: () => effects.commitNativeCheckpoint?.(),
        report,
      }, source, directive.target, directive.payload);
      return;
    }
    await dispatcher.accept(source, effects);
    report({ level: "info", code: "chat_input_accepted", adapter: source.binding.adapterId });
  };

  // Web UI (opt-in). The bus + token are dependency-free, so create them here and share between
  // the `web` ChatAdapter (chat-adapters phase) and the web server (web-ui phase). The machinery is
  // always built; the web server listens only when the persisted state says enabled (off by default,
  // toggled by `qiyan-bot web-ui start|stop`).
  const webBus = new WebBus();
  const webWorkerStream = createWorkerStream({
    bus: webBus,
    resolveSession: (nickname) => {
      const snapshot = registry.snapshot();
      if (nickname === "assistant") {
        return { endpointId: snapshot.assistant.endpoint, threadId: snapshot.assistant.thread_id, mappingId: assistantMappingId };
      }
      const session = snapshot.sessions[nickname];
      return session ? { endpointId: session.endpoint, threadId: session.thread_id, mappingId: session.mapping_id } : undefined;
    },
  });
  // The access token is PERSISTED under the data dir so it survives restarts — otherwise every restart
  // rotates it and open browser tabs (and their auth cookie) 401 with a stale token. Read lazily so
  // `dataDir` is the finalized root.
  let webTokenCache: string | undefined;
  const webToken = (): string => {
    if (webTokenCache) return webTokenCache;
    const path = join(dataDir, "web-token");
    try { const existing = readFileSync(path, "utf8").trim(); if (existing) return (webTokenCache = existing); } catch { /* create below */ }
    const token = randomBytes(32).toString("base64url");
    try { writeFileSync(path, token, { mode: 0o600 }); } catch { /* fall back to an ephemeral token */ }
    return (webTokenCache = token);
  };
  // The web file store: inbound sends and outbound files QiYan sends both land here, and the paths
  // are surfaced to the browser (clickable preview). Read lazily so `dataDir` is the finalized root.
  const webUploads = () => ({ dir: join(dataDir, "web-uploads"), maxBytes: config.attachmentMaxBytes, ttlMs: 30 * 24 * 60 * 60 * 1000 });
  const readWorkerTurns = (
    endpointId: string,
    threadId: string,
    mappingId: string,
    limit: number,
    cursor: string | undefined,
    signal: AbortSignal,
  ) => {
    if (sessionProvider(endpointId) === "claude") {
      return readReadyWorkerTurns({
        withReadyWorkLease: (id, run) => endpointManager.withReadyWorkLease(id, run),
        request: (id, method, params, requestSignal, lease) => pool.request(id, method, params, requestSignal, lease),
      }, endpointId, threadId, limit, cursor, signal);
    }
    const readCodexPage = async (lease?: EndpointWorkLease) => {
      if (signal.aborted) throw signal.reason;
      const path = ownership.managedRolloutPath({ endpoint: endpointId, thread_id: threadId, mapping_id: mappingId });
      if (!path) return { messages: [], hasOlder: false, openTurnIds: [], terminalTurnIds: [] };
      const native = nativeSessions.view({ endpointId, threadId, mappingId });
      const activeTurnId = native?.availability === "ready" && native.status === "active"
        ? native.activeTurnId
        : null;
      const page = await codexHistoryAccess.read(endpointId, {
        path, threadId, limit,
        ...(activeTurnId ? { activeTurnId } : {}),
        ...(cursor ? { cursor } : {}),
      }, lease, signal);
      if (signal.aborted) throw signal.reason;
      return page;
    };
    return endpointId === assistantEndpoint.id
      ? readCodexPage()
      : endpointManager.withReadyWorkLease(endpointId, readCodexPage);
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
          const openedSessionControls = new SessionControlStore(openedDb);
          const openedManagedEpochs = new ManagedEpochStore(openedDb);
          const openedSessionDeliveryProgress = new SessionDeliveryProgressStore(openedDb);
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
          sessionControls = openedSessionControls;
          managedEpochs = openedManagedEpochs;
          sessionDeliveryProgress = openedSessionDeliveryProgress;
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
        dashboard = new SessionDashboard(dashboardStore, registry, sessionControls, { root: assistantDir, path: dashboardPath });
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
        conversations = new ConversationStore(db, deliveries, attachments, { ownerBinding: currentOwnerBinding });
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
        // The web UI participates as a `web` ChatAdapter (browser ⇄ assistant), so it must be in
        // `chats` for outbound routing AND admitted into the boot guard's expected set. Always
        // registered (the machinery is always built); it only carries traffic when the server listens.
        configured.push(createWebAdapter(
          webBus,
          webUploads(),
          (id, appended) => deliveries.appendToBody(id, appended),
          (id) => {
            const delivery = deliveries.get(id);
            const worker = delivery ? workerDeliveryNickname(delivery.kind, delivery.body) : undefined;
            return delivery ? {
              kind: delivery.kind,
              ...(worker ? { worker, ...(registry.get(worker) ? { origin: worker } : {}) } : {}),
            } : {};
          },
        ));
        const expectedAdapters = [
          telegramConfig ? "telegram" : undefined,
          config.chat.slack ? "slack" : undefined,
          config.chat.weixin ? "weixin" : undefined,
          "web", // always registered — the web machinery is always built
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
        webGoalControl = createWebGoalControl({
          operations,
          tools,
          wake: () => { void dispatcher.enqueueInternal("web_goal"); },
          requestReconciliation: () => { void reconcileOperations().catch(() => undefined); },
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
      }, stop: async () => { await mcp.stop(); webGoalControl = undefined; },
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
        assistantPostTurnActions = new AssistantPostTurnActions(db, {
          compact: async (action, context) => {
            await runAssistantCompaction(action, {
              identity: () => {
                const identity = registry.snapshot().assistant;
                return { endpointId: identity.endpoint, threadId: identity.thread_id };
              },
              readThread: async () => {
                const identity = registry.snapshot().assistant;
                return readBoundedThread(identity.endpoint, identity.thread_id);
              },
              assertPagingSupported: async (baselineTurnId) => {
                const identity = registry.snapshot().assistant;
                await sessions.assertCompactionPagingSupported(identity.endpoint, identity.thread_id, baselineTurnId);
              },
              compactionItemIdsAfter: async (baselineTurnId) => {
                const identity = registry.snapshot().assistant;
                return sessions.compactionItemIdsAfter(identity.endpoint, identity.thread_id, baselineTurnId);
              },
              compact: async () => {
                const identity = registry.snapshot().assistant;
                await pool.request(identity.endpoint, "thread/compact/start", { threadId: identity.thread_id });
              },
            }, context.checkpoint);
            completeDeferredSystemNotices(action);
          },
          restart: async (action, context) => {
            await runAssistantRestart(action, {
              endpointId: assistantEndpoint.id,
              runtimeIdentity: () => assistantEndpoint.runtimeIdentity(),
              shutdownRuntime: (identity) => assistantEndpoint.shutdownRuntime(identity),
              startAndResume: async () => { await assistantEndpoint.start(); await startOrResumeAssistant(); },
            }, context.checkpoint);
            completeDeferredSystemNotices(action);
          },
        });
        // The local Claude endpoint (an endpoints.json entry with transport:"local") is eager +
        // always-ready like "local" (no daemon); absent such an entry it is never constructed
        // and the composition is unchanged.
        // The local Claude endpoint (if any) is an endpoints.json entry with provider:claude,
        // transport:local. At most one is allowed — the wiring below (single builtin, scalar id,
        // one monitor runner) is singular; a second such entry is a loud misconfiguration.
        const localClaudeDefs = endpointCatalog.definitions().filter((definition) => definition.provider === "claude" && definition.transport === "local");
        if (localClaudeDefs.length > 1) {
          throw new AppError("CONFIGURATION_ERROR", `at most one local Claude endpoint (provider:claude, transport:local) is allowed; found: ${localClaudeDefs.map((definition) => definition.id).join(", ")}`);
        }
        const localClaudeDef = localClaudeDefs[0];
        localClaudeEndpointId = localClaudeDef?.id;
        // Goals + scheduling serve EVERY Claude endpoint (the local one and any remote
        // claude endpoint), keyed by (endpointId, threadId). Construct the stack
        // unconditionally: a remote Claude endpoint is added at runtime by writing
        // endpoints.json, so a startup-snapshot gate would leave it without goals/scheduling.
        // The cost when no Claude endpoint exists is one idle loopback MCP + one poll loop.
        claudeGoals = new ClaudeGoalStore(db);
        claudeArchives = new ClaudeArchiveStore(db);
        // Refresh the dashboard after a worker/driver goal-status change (those bypass
        // the manager tools' observeGoal). Provider-based, so it covers remote Claude too.
        const refreshClaudeGoalObservation = (nickname: string): void => {
          const session = registry.get(nickname);
          if (!session || sessionProvider(session.endpoint) !== "claude") return;
          observeGoal(nickname, { goal: claudeGoals!.get(session.endpoint, session.thread_id) });
          void renderDashboardSafely();
        };
        // A `monitor` check must run on the SESSION's own host. The local Claude worker runs
        // it here (runMonitorCheck); each remote Claude endpoint registers its ssh runner
        // below so the check runs over ssh on the worker's host. `monitor` is offered only to
        // sessions whose host has a registered runner (see supportsMonitor).
        const monitorCheckRunners = new Map<string, (command: string) => Promise<boolean>>();
        scheduling = new SchedulingService({
          db,
          now: () => Date.now(),
          mcpConfigDir: join(dataDir, "claude-worker-mcp"),
          // Fire drives a turn via the durable send_to_session (singleFireKey ==
          // clientUserMessageId for idempotent delivery).
          send: (nickname, message, key) => sessions.send(nickname, message, { mode: "auto", clientUserMessageId: key }).then(() => undefined),
          // A monitor check MUST run on the session's own host. If no runner is registered for
          // the endpoint (its runner is only registered once the endpoint is active — so a
          // durable monitor whose endpoint is unavailable/unrecovered has none), treat the
          // condition as UNMET rather than running a remote worker's shell check here. Returning
          // false re-arms the poll, so the monitor self-heals once the endpoint is re-activated.
          runCheck: (row: ScheduleRow) => { const check = monitorCheckRunners.get(row.endpointId); return check ? check(row.spec) : Promise.resolve(false); },
          goals: claudeGoals,
          onGoalStatusChanged: (session) => refreshClaudeGoalObservation(session.nickname),
          // `monitor` is offered to any Claude session whose host can run the check — the
          // local worker (checked here) and every remote worker (checked over ssh). Both
          // register a runner in monitorCheckRunners.
          supportsMonitor: (session) => monitorCheckRunners.has(session.endpointId),
        });
        // Goal enforcement (auto-drive). The goal is set via the assistant's set_goal
        // MCP manager tool (NOT Claude's internal /goal); the worker ends it via the
        // set_goal_status MCP tool. QiYan drives the next turn after each completion
        // while the goal is active. Endpoint-agnostic — drives local and remote Claude alike.
        claudeGoalDriver = new ClaudeGoalDriver({
          goals: claudeGoals,
          now: () => Date.now(),
          maxDrivenTurns: CLAUDE_MAX_GOAL_TURNS,
          enqueue: (session, message) => scheduling!.enqueueGoalDrive(session, message),
          hasPendingDrive: (session) => scheduling!.hasPendingGoalDrive(session),
          onStatusChanged: (session) => refreshClaudeGoalObservation(session.nickname),
        });
        // Goal + steer options wired into a Claude runtime (local or remote). Both are
        // QiYan-side and host-agnostic; steer = durable enqueue delivered as the next turn
        // (Claude has no mid-turn injection). workerMcpConfigPath is added per-endpoint
        // separately (local: loopback; remote: reverse tunnel).
        const claudeGoalRuntimeOptions = (endpointId: string) => ({
          goals: claudeGoals!,
          archives: claudeArchives!,
          steer: async (threadId: string, message: string): Promise<void> => {
            const found = registry.getByIdentity(endpointId, threadId);
            if (found) scheduling!.enqueueSteer({ nickname: found.nickname, endpointId, threadId }, message);
          },
        });
        // Route a Claude endpoint's completed turns to the goal driver (auto-drive). The
        // runtime self-emits turn/completed, so subscribing on the endpoint object works for
        // both local (builtin) and remote (createRemote) Claude endpoints.
        const subscribeClaudeGoalDriver = (endpoint: ClaudeCodeRuntime, endpointId: string): void => {
          unsubscribers.push(endpoint.onNotification((method, params) => {
            if (method !== "turn/completed") return;
            const threadId = (params as { threadId?: string }).threadId;
            if (typeof threadId !== "string") return;
            const found = registry.getByIdentity(endpointId, threadId);
            if (found) claudeGoalDriver!.onTurnCompleted({ nickname: found.nickname, endpointId, threadId });
          }));
        };
        // The launch policy (disabled built-in scheduling tools + redirect prompt) applies to
        // EVERY Claude session, local or remote; model/effort are the per-endpoint overrides from
        // the endpoint's endpoints.json entry.
        claudeEndpoint = localClaudeDef === undefined ? undefined : new ClaudeCodeRuntime({
          id: localClaudeDef.id,
          runner: new LocalClaudeCommandRunner({ command: localClaudeDef.command ?? "claude" }),
          launchFlags: claudeLaunchPolicy(localClaudeDef.model, localClaudeDef.effort),
          ...claudeGoalRuntimeOptions(localClaudeDef.id),
          // Local: the worker reaches the loopback MCP directly (no tunnel).
          workerMcpConfigPath: async (threadId: string) => {
            const found = registry.getByIdentity(localClaudeDef.id, threadId);
            return found ? scheduling!.workerMcpConfigPath({ nickname: found.nickname, endpointId: localClaudeDef.id, threadId }) : undefined;
          },
        });
        // Drive the goal loop: after each completed Claude turn, if the goal is still
        // active, enqueue the next pursuit turn. Stops when the worker's set_goal_status
        // flips the status (or the backstop cap pauses it). (The remote endpoint is
        // subscribed the same way inside createRemote.)
        if (claudeEndpoint) subscribeClaudeGoalDriver(claudeEndpoint, localClaudeDef!.id);
        // The local worker's `monitor` check runs on this host.
        if (localClaudeDef) monitorCheckRunners.set(localClaudeDef.id, (command) => runMonitorCheck(command));
        const sshRuntimeRoot = await prepareLocalSshRuntimeRoot(dataDir);
        webSshRuntimeRoot = sshRuntimeRoot;
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
            // Local endpoints are built at startup as builtins; only ssh endpoints reach here. A
            // transport:local entry added to endpoints.json after startup is not in the frozen
            // builtins map — reject it loudly rather than mis-run it as remote ssh (it has no host).
            if (definition.transport === "local") {
              throw new AppError("CONFIGURATION_ERROR", `local endpoint '${definition.id}' cannot be activated remotely; local endpoint changes require a restart`);
            }
            // host drives the ssh alias (ssh -G, ControlMaster path); id stays the identity/binding key.
            const generation = await planner.createGeneration(definition.id, definition.host!);
            const remote = new SshRemoteClient({ plan: generation.plan, helperSource });
            if (definition.provider === "claude") {
              // A Claude endpoint has no app-server to lazily prepare, so bootstrap the
              // helper eagerly here (installs it + establishes the ControlMaster) — the
              // ownership scan / workspace ops need the installed helper immediately.
              const host = await prepareRemoteHost({ endpointId: definition.id, remote, assetRoot: remoteAssetRoot });
              // Tier B: expose QiYan's worker-MCP on the remote host via an ssh -R reverse
              // tunnel over this endpoint's ControlMaster, so the remote worker can self-schedule.
              // The remote listen port is allocated dynamically by the remote sshd (read back
              // after ensure()); the worker learns it from the URL in its per-session config.
              const tunnel = new RemoteWorkerTunnel({
                plan: generation.plan, localPort: scheduling!.mcpPort,
              });
              // Warn the user once per session when the tunnel degrades (below), so the loss of
              // self-scheduling is visible, not just an operational log line.
              const tunnelWarned = new Set<string>();
              const remoteWorkerMcpConfigPath = async (threadId: string): Promise<string | undefined> => {
                const found = registry.getByIdentity(definition.id, threadId);
                if (!found) return undefined;
                // Self-scheduling is best-effort: the reverse tunnel must NOT be a single point of
                // failure for basic remote messaging. If establishing it (or writing the config)
                // fails, run the turn WITHOUT the scheduling tools rather than failing the whole
                // turn. The degradation is surfaced as an operational warning (not silent), and the
                // acceptance test's schedule-step assertion still fails loudly on a real regression.
                try {
                  await tunnel.ensure();
                  const content = scheduling!.workerMcpConfigContent(
                    { nickname: found.nickname, endpointId: definition.id, threadId },
                    `http://127.0.0.1:${tunnel.remotePort}/mcp`,
                  );
                  // Write the token-bearing config to the REMOTE runtime dir (content-addressed
                  // under files/<sha256>, mode 0600) so `claude -p --mcp-config` reads it there.
                  const buffer = Buffer.from(content, "utf8");
                  const result = await remote.invokeTransfer<{ path: string }>("write-file",
                    [JSON.stringify({ runtimeDir: host.remoteRuntimeDir, size: buffer.byteLength, sha256: createHash("sha256").update(buffer).digest("hex") })],
                    { input: (async function* () { yield buffer; })(), maxOutputBytes: 64 * 1024 }, host.remoteHelperPath);
                  return result.path;
                } catch (error) {
                  const reason = error instanceof Error ? error.message : String(error);
                  reportOperationalSafely(report, {
                    level: "warn", code: "worker_scheduling_unavailable", component: "remote_worker_tunnel", reason,
                  });
                  // The reverse tunnel (Tier B) only carries the worker's SELF-scheduling tools; the
                  // worker's turns and QiYan-side goal drive/steer (Tier A) go over the ControlMaster
                  // and are unaffected. Surface the degradation to the user once per session — but,
                  // like the operational log above, this MUST NOT fail the turn (this whole branch
                  // exists to degrade gracefully), so swallow any delivery/binding error and add to
                  // the dedup set only after a successful prepare (so a throw doesn't lose the warning).
                  try {
                    if (deliveries && !tunnelWarned.has(threadId)) {
                      deliveries.prepare({
                        id: `worker-scheduling-unavailable:${definition.id}:${threadId}`,
                        kind: "worker_warning", binding: currentOwnerBinding(), mandatory: true,
                        body: `[${found.nickname}] the remote worker can't reach QiYan's scheduling tools (reverse tunnel failed: ${reason}). It still runs turns and pursues its goal, but can't set its own wakeups, crons, or monitors this turn.`,
                      });
                      tunnelWarned.add(threadId);
                    }
                  } catch { /* surfacing the warning must not fail the turn */ }
                  return undefined;
                }
              };
              const claudeRemoteRunner = new SshClaudeCommandRunner({ plan: generation.plan });
              // The remote worker's `monitor` check runs over ssh on ITS host, not ours.
              monitorCheckRunners.set(definition.id, (command) => claudeRemoteRunner.runShellCheck(command));
              const claudeRemoteEndpoint = new ClaudeCodeRuntime({
                id: definition.id,
                runner: claudeRemoteRunner,
                launchFlags: claudeLaunchPolicy(definition.model, definition.effort),
                // Goals + steer are QiYan-side (Tier A); worker self-scheduling reaches the MCP
                // over the reverse tunnel (Tier B).
                ...claudeGoalRuntimeOptions(definition.id),
                workerMcpConfigPath: remoteWorkerMcpConfigPath,
              });
              subscribeClaudeGoalDriver(claudeRemoteEndpoint, definition.id);
              remoteCandidateContexts.set(claudeRemoteEndpoint, { host, remote, projectsRoot: definition.projectsRoot });
              return { endpoint: claudeRemoteEndpoint, pendingBinding: generation.pendingBinding };
            }
            const remoteRuntime = new SshRuntime({ endpointId: definition.id, remote, assetRoot: remoteAssetRoot });
            const remoteEndpoint = new ManagedAppServerEndpoint({
              id: definition.id,
              runtime: new SshAppServerRuntime({
                runtime: remoteRuntime,
                connectWire: (stream) => WebSocketWire.connectStream(stream, { timeoutMs: 10_000 }),
              }),
              minimumVersion: MINIMUM_SUPPORTED_CODEX_VERSION,
            });
            remoteCandidateContexts.set(remoteEndpoint, { host: remoteRuntime, remote, projectsRoot: definition.projectsRoot });
            return { endpoint: remoteEndpoint, pendingBinding: generation.pendingBinding };
          },
          hasIdentityReferences: (id) => hasEndpointIdentityReferences(id),
          commitBinding: (binding, references) => endpointBindings.commitAfterActivation(binding.endpointId, binding.destination, references),
          managedThreadIds: (id) => Object.values(registry.snapshot().sessions).filter((session) => session.endpoint === id).map((session) => session.thread_id),
          onReconnectGaveUp: (id, attempts) => reportOperationalSafely(report, {
            level: "warn", code: "endpoint_reconnect_gave_up", component: "endpoint_manager", consecutiveFailures: attempts,
            reason: `endpoint ${id} unreachable after sustained reconnect attempts (~48h); pausing automatic recovery until restart or next use`,
          }),
          onRecoveryPaused: (id, recovery) => {
            reportOperationalSafely(report, {
              level: "warn",
              code: "endpoint_recovery_paused",
              component: "endpoint_manager",
              endpoint: id,
              reason: recovery.reason,
            });
            try {
              prepareSshFreshChannelUnavailableNotice(deliveries, currentOwnerBinding(), {
                endpointId: id,
                sshHost: recovery.sshHost,
              });
              return true;
            } catch {
              reportOperationalSafely(report, {
                level: "warn",
                code: "background_task_failed",
                component: "endpoint_recovery_notice",
                endpoint: id,
              });
              return false;
            }
          },
        });
        pool = new AppServerPool([endpoint, assistantEndpoint, ...(claudeEndpoint ? [claudeEndpoint] : [])], {
          maxConcurrentTurns: config.maxConcurrentTurns,
          resolveEndpoint: (id) => endpointManager.ensureReady(id),
          // The Claude endpoint is a manager built-in (like "local"), so it goes
          // through the manager's ready-work-lease; only assistant-local (not
          // manager-registered) runs the callback directly.
          workLeaseProvider: (id, lease, run) => id === assistantEndpoint.id ? run(lease) : endpointManager.runWithReadyWorkLease(id, lease, run),
        });
        nativeCapacityBridge = new NativeCapacityBridge(nativeSessions, pool);
        recoveredEndpointIds = new EndpointCapacityRecovery({
          registry,
          operations,
          quarantine: (operation, reason) => operations.failAndUnbind(operation.id, { message: reason }),
        }).restoreBeforeIngress();
        // Bind the shared locality predicate to this deployment's local Claude endpoint id,
        // then inject it into the workspace router, rollout-access, and worker file bridge.
        const isLocalEndpoint = (id: string): boolean => isLocalEndpointId(id, localClaudeDef?.id);
        // Reuse the ProjectWorkspacePolicy (and its SshHost + resolved-constant cache) while the
        // endpoint's remote context is unchanged. A new generation installs a fresh RemoteContext
        // (bindProjectEndpoint), so the `=== context` check rebuilds — never handing back a policy
        // bound to a torn-down transport. ensureReady() still gates every lookup onto a ready generation.
        const remotePolicyCache = new Map<string, { context: RemoteContext; policy: ProjectWorkspacePolicy }>();
        workspaceRouter = new WorkspaceRouter(async (id) => {
          if (isLocalEndpoint(id)) return projectWorkspaces;
          await endpointManager.ensureReady(id);
          const context = remoteContexts.get(id);
          if (!context) throw new AppError("ENDPOINT_UNAVAILABLE", `SSH workspace host is unavailable: ${id}`);
          const cached = remotePolicyCache.get(id);
          if (cached && cached.context === context) return cached.policy;
          const home = context.host.remoteHome;
          const projectsRoot = context.projectsRoot.startsWith("~/") ? posix.resolve(home, context.projectsRoot.slice(2)) : posix.resolve(context.projectsRoot);
          const policy = new ProjectWorkspacePolicy({
            userHome: home,
            qiyanHome: context.host.remoteRuntimeDir,
            assistantWorkdir: context.host.remoteRuntimeDir,
            dataDir: context.host.remoteRuntimeDir,
            registryPath: posix.join(context.host.remoteRuntimeDir, "sessions.json"),
            defaultProjectsRoot: projectsRoot,
            host: new SshHost(id, context.remote, context.host.remoteHelperPath),
          });
          remotePolicyCache.set(id, { context, policy });
          return policy;
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
        discovery = new SessionDiscovery(db, pool);
        threadGate = new ThreadGate();
        const rolloutAccess = new RolloutAccessRouter({
          remote: (id) => {
            const context = remoteContexts.get(id);
            return context ? { remote: context.remote, helperPath: context.host.remoteHelperPath } : undefined;
          },
          validateLease: (id, lease) => endpointManager.validateWorkLease(lease, id),
          // Provider dispatch (shared helper): Claude endpoints use the transcript
          // scanner. Only the local Claude endpoint (transport:"local") is local; an ssh
          // claude endpoint is remote (scans over ssh).
          provider: (id) => sessionProvider(id),
          local: isLocalEndpoint,
          scanLocalClaude: scanLocalClaudeTranscript,
        });
        codexHistoryAccess = new CodexHistoryAccess({
          remote: (id) => {
            const context = remoteContexts.get(id);
            return context ? { remote: context.remote, helperPath: context.host.remoteHelperPath } : undefined;
          },
          isLocal: (id) => id === assistantEndpoint.id || isLocalEndpoint(id),
          validateLease: (id, lease) => endpointManager.validateWorkLease(lease, id),
        });
        // A Claude session's transcript is only written by the first `claude -p`, so its
        // rollout path is unresolvable ("pending") until then — but that is terminal-safe (no
        // turn has run), not a transient binding window like Codex. Report it as "unstarted"
        // so the ownership guard lets the first turn dispatch instead of deadlocking.
        const baseRolloutPathResolver = createAppServerRolloutPathResolver(pool);
        const rolloutPathResolver: RolloutPathResolver = async (identity, lease) => {
          const resolution = await baseRolloutPathResolver(identity, lease);
          return resolution.state === "pending" && sessionProvider(identity.endpoint) === "claude"
            ? { state: "unstarted" }
            : resolution;
        };
        ownership = new SessionOwnershipGuard(
          db, sessionControls, operations, rolloutAccess, rolloutPathResolver,
        );
        lifecycle = new SessionLifecycle(
          pool,
          registry,
          managedEpochs,
          nativeSessions,
          { now: () => Date.now() },
          workspaceRouter as never,
          threadGate,
          endpointManager,
          ownership,
          async (identity, lease, thread) => {
            const control = sessionControls.goalControl(identity.endpoint, identity.thread_id, identity.mapping_id);
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
              authorizedTurnId = activeTurn?.id
                ?? nativeSessions.view({ endpointId: identity.endpoint, threadId: identity.thread_id, mappingId: identity.mapping_id })?.activeTurnId
                ?? undefined;
            }
            observeGoal(registered.nickname, currentGoal);
            const after = (control.controlled || hasGoal) && !active
              ? () => setGoalControlled(registered.nickname, false)
              : undefined;
            if (authorizedTurnId || after) return { ...(authorizedTurnId ? { authorizedTurnId } : {}), ...(after ? { after } : {}) };
          },
        );
        sessions = new SessionService(pool, registry, nativeSessions, sessionControls, finals, deliveries, workspaceRouter, threadGate, endpointManager, ownership, (id: string) => sessionProvider(id) !== "claude");
        observations = new SessionObservationProcessor(dashboardStore, registry, sessionControls, {
          now: () => Date.now(),
          readThread: (endpointId, threadId, lease) => readBoundedThread(endpointId, threadId, lease),
          readGoal: (endpointId, threadId) => pool.request(endpointId, "thread/goal/get", { threadId }),
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
        relay = new EventRelay(db, pool, registry, managedEpochs, sessionDeliveryProgress, finals, deliveries, {
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
            const current = registry.getByIdentity(identity.endpoint, identity.thread_id)?.session;
            return current?.mapping_id === identity.mapping_id
              && (current.lifecycle_state === "managed" || current.lifecycle_state === "unadopting");
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
            dashboardStore.markDirty();
            await renderDashboardSafely();
          },
          onReleased: async (incident) => {
            await durableEventSources.ownership(incident, "completed");
            dashboardStore.markDirty();
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
        unsubscribers.push(assistantEndpoint.onNotification((method, params) => {
          const generation = pool.endpointGeneration(assistantEndpoint.id).generation;
          const refreshRequired = nativeSessions.observe(assistantEndpoint.id, generation, method, params);
          if (refreshRequired) {
            runBackground(() => refreshAssistantNativeState(), () => recordBackgroundFailure("assistant native status refresh"));
          }
          offerWorkerNotification(webWorkerStream, assistantEndpoint.id, method, params);
          runBackground(
          () => onNotification(assistantEndpoint.id, method, params),
          // Before construction, the assistant phase's initial dispatcher.recover() is the recovery boundary.
          () => reportAssistantTerminalFailure(dispatcherAvailable ? dispatcher : undefined, () => recordBackgroundFailure("assistant notification")),
        );
        }));
        unsubscribers.push(assistantEndpoint.onReady(() => {
          offerWorkerDiscontinuity(webWorkerStream, assistantEndpoint.id);
        }));
        unsubscribers.push(assistantEndpoint.onUnavailable((kind) => {
          offerWorkerDiscontinuity(webWorkerStream, assistantEndpoint.id);
          nativeSessions.invalidateEndpoint(assistantEndpoint.id, pool.endpointGeneration(assistantEndpoint.id).generation);
          assistantToolReadiness.block();
          assistant.clearActive();
          if (dispatcherAvailable) {
            runBackground(() => dispatcher.nativeUnavailable(), () => recordBackgroundFailure("assistant dispatcher invalidation"));
          }
          runBackground(() => handleEndpointUnavailable(assistantEndpoint, kind), () => recordBackgroundFailure("assistant unavailable handling"));
        }));
        } catch (error) {
          await stopRecoveryOwners().catch(() => undefined);
          throw error;
        }
      }, stop: async () => {
        nativeCapacityBridge?.close();
        nativeCapacityBridge = undefined;
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
        const assistantNativeStatus = await startOrResumeAssistant();
        const identity = registry.snapshot().assistant;
        const assistantThread = conversationCutoverNeedsAssistantHistory(db)
          ? await readBoundedThread(identity.endpoint, identity.thread_id)
          : { turns: [] };
        await finalizeAssistantStartup(
          assistantNativeStatus,
          assistantThread.turns ?? [],
          () => finalizeConversationCutover(db, {
            threadId: identity.thread_id,
            turns: (assistantThread.turns ?? []).map((turn: any) => ({
              id: String(turn.id),
              status: String(turn.status),
              itemsView: turn.itemsView ?? "notLoaded",
              items: turn.items ?? [],
            })),
          }),
          () => drainAssistantPostTurnActions(false),
        );
        const runner: AssistantTurnPort = {
          start: async (params, claim, checkpointBaseline) => {
            const pending = sessionControls.settings(identity.endpoint, identity.thread_id, assistantMappingId);
            await prepareAssistantStartDispatch(
              async () => (await pool.historyReader(identity.endpoint).latestTurn(identity.thread_id))?.id ?? null,
              checkpointBaseline,
            );
            return startAssistantTurnWithPendingSettings(params, pending,
              (request) => pool.startTurn<{ turn: any }>(identity.endpoint, { ...request }, claim),
              (applied) => {
                if (applied.model !== undefined) assistantCurrentSettings.model = applied.model;
                if (applied.effort !== undefined) assistantCurrentSettings.effort = applied.effort;
                sessionControls.consumeSettings(identity.endpoint, identity.thread_id, assistantMappingId, applied);
              });
          },
          steer: (params) => pool.request(identity.endpoint, "turn/steer", params),
          readThread: () => readAssistantRecoveryThread(identity.endpoint, identity.thread_id),
        };
        dispatcher = new ConversationDispatcher(conversations, pool, runner, {
          endpointId: identity.endpoint,
          threadId: identity.thread_id,
          attachments,
          membershipObserver: attemptScope,
          runtimeObserver: assistant,
          scheduler,
          beforeStartAdmission: async () => { await drainAssistantPostTurnActions(true); },
          onOperationalEvent: (code) => { report({ level: code === "assistant_submission_uncertain" ? "warn" : "info", code }); },
          onTerminal: (turn) => runBackground(
            () => processAssistantTerminal({ threadId: identity.thread_id, turn }),
            () => reportAssistantTerminalFailure(dispatcher, () => recordBackgroundFailure("assistant terminal")),
          ),
        });
        dispatcherAvailable = true;
        await assistantLifecycleBuffer.activate(handleAssistantLifecycleNotification);
        await dispatcher.recover();
        await dispatcher.idle();
        if (!dispatcher.isNativeRecoveryReady()) {
          const failure = dispatcher.nativeRecoveryFailure();
          await dispatcher.nativeUnavailable();
          throwAssistantNativeRecoveryFailure(failure);
        }
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
        const capacityBootstrapped = await resumeStartupManagedSessions();
        for (const endpointId of [...new Set(recoveredEndpointIds)]) {
          // Managed startup recovery already performed the endpoint reconcile (ownership + relay
          // + claims) behind the startup barrier. Do not race or repeat it here.
          if (endpointId === assistantEndpoint.id || activation.unavailable.includes(endpointId)
            || capacityBootstrapped.has(endpointId)
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
        // The provider-agnostic schedule engine + worker MCP surface (Phase 2) is an
        // independent subsystem from the assistant's autonomous dispatcher, so it starts
        // even when the latter is held (tests set holdAssistantScheduler to suppress the
        // proactive assistant, NOT worker goal-drive / self-scheduling). Recovery re-arms
        // durable schedules on start; fires drive send_to_session.
        if (scheduling) await scheduling.start();
        // Re-kick active Claude goals whose drive turn was in flight at restart (no
        // pending schedule, no live turn) so goal enforcement is restart-durable. listActive
        // is per endpointId, so enumerate every Claude endpoint present in the registry
        // (local + any remote ssh claude endpoint), not just the local one.
        if (claudeGoalDriver && claudeGoals) {
          const claudeEndpointIds = new Set(Object.values(registry.snapshot().sessions)
            .filter((s) => sessionProvider(s.endpoint) === "claude").map((s) => s.endpoint));
          const active = [...claudeEndpointIds].flatMap((endpointId) => claudeGoals!.listActive(endpointId)
            .map((g) => registry.getByIdentity(endpointId, g.threadId))
            .filter((found): found is NonNullable<typeof found> => found !== undefined)
            .map((found) => ({ nickname: found.nickname, endpointId, threadId: found.session.thread_id })));
          claudeGoalDriver.resumeActive(active);
        }
        if (options.testing?.holdAssistantScheduler) return;
        schedulerAccepting = true;
        await enqueuePendingEvents();
        await dispatcher.enqueueInternal("startup");
      },
      stop: async () => {
        stopping = true;
        if (scheduling) await scheduling.stop();
        assistantToolReadiness.stop();
        schedulerAccepting = false;
        const active = assistant.current();
        assistant.fenceToolAdmission();
        await stopOperationRecoveryBeforeTools({
          closeGoalAdmission: () => { webGoalControl?.closeAdmission(); },
          stopOperationRecovery: () => operationReconciler?.stop() ?? Promise.resolve(),
          waitForTools: () => assistant.waitForTools(),
          waitForGoalControls: () => webGoalControl?.waitForActive() ?? Promise.resolve(),
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
    // The web UI server is last so it starts after every backend it reads is live, and (reverse
    // order) stops first — before the delivery/chat teardown it depends on.
    createWebUiPhase({
      defaultHost: config.webUi.host, defaultPort: config.webUi.port, token: webToken(),
      staticDir: webuiStaticRoot, bus: webBus,
      reads: {
        registrySnapshot: () => registry.snapshot(),
        dashboardSnapshot: () => dashboard.snapshot(),
        assistantSession: assistantSessionSummary,
        nativeSession: (endpointId, threadId, mappingId) => nativeSessions.view({ endpointId, threadId, mappingId }),
        onSessionsChanged: (listener) => {
          const unsubscribeNative = nativeSessions.onChange(() => listener());
          const unsubscribeDashboard = dashboardStore.onChange(listener);
          return () => {
            unsubscribeNative();
            unsubscribeDashboard();
          };
        },
        readWorkerTurns,
        listOwnerConversation: (before, limit) => conversations.listOwnerConversation(before, limit),
        provider: (id) => sessionProvider(id),
        host: (id) => {
          if (isLocalEndpointId(id, localClaudeEndpointId)) return localHostName;
          return endpointCatalog.definitions().find((definition) => definition.id === id)?.host ?? id;
        },
      },
      // Local file browsing is confined to each session's managed project directory. Only LOCAL
      // sessions expose files here; a remote (ssh) session's project dir is on another host, so it
      // is intentionally not browsable yet (remote file browsing is a later phase).
      files: {
        projectDir: (nickname) => {
          const session = registry.snapshot().sessions[nickname];
          return session && isLocalEndpointId(session.endpoint, localClaudeEndpointId) ? session.project_dir : undefined;
        },
        // Transport for a session: local (fs) or remote (ssh host from the endpoint catalog).
        fileTarget: (nickname) => {
          const session = registry.snapshot().sessions[nickname];
          if (!session) return undefined;
          if (isLocalEndpointId(session.endpoint, localClaudeEndpointId)) return { transport: "local", projectDir: session.project_dir };
          const definition = endpointCatalog.definitions().find((d) => d.id === session.endpoint);
          return definition?.transport === "ssh" && definition.host ? { transport: "remote", projectDir: session.project_dir, host: definition.host } : undefined;
        },
        maxFileBytes: config.attachmentMaxBytes,
      },
      // Remote-worker file access over ssh reuses the user's ControlMaster (never creates one). A
      // provider read per request: `webSshRuntimeRoot` is only assigned once endpoints start up.
      remote: () => (webSshRuntimeRoot ? { sshBinary: "ssh", sshRuntimeRoot: webSshRuntimeRoot } : undefined),
      // Send-file store: uploads land here on the bot host and auto-expire after 30 days. The path is
      // appended to the message so a LOCAL assistant/worker can read it (remote hosts can't — deferred).
      uploads: webUploads(),
      acceptChat,
      controlGoal: (input) => webGoalControl?.control(input) ?? Promise.resolve({ ok: false, error: "goal control is unavailable" }),
      openGoalAdmission: () => { webGoalControl?.openAdmission(); },
      closeGoalAdmission: () => { webGoalControl?.closeAdmission(); },
      waitForGoalControls: () => webGoalControl?.waitForActive() ?? Promise.resolve(),
      report,
      onStarted: (url) => { process.stdout.write(`QiYan web UI listening — open ${url}\n`); options.testing?.onWebUiStarted?.(url); },
      statePath: webUiStatePath(config.qiyanHome),
    }),
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
        if (args.nickname === "assistant") return assistantSessionStatus(true);
        const live = await sessions.status(args.nickname) as any;
        observeGoal(args.nickname, live.goal);
        await renderDashboardSafely();
        const facts = dashboard.status(args.nickname);
        return {
          ...facts,
          auto_session_info: {
            ...facts.auto_session_info,
            management_state: live.managementState,
            native_status: live.nativeStatus,
            active_turn_id: live.activeTurnId,
          },
        };
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
          dashboardStore.markDirty();
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
        dashboardStore.markDirty();
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
        const pendingSettings = args.mode === "start" ? sessionControls.settings(worker.endpoint, worker.thread_id, worker.mapping_id) : undefined;
        const settingsObservationSequence = pendingSettings && (Object.hasOwn(pendingSettings, "model") || Object.hasOwn(pendingSettings, "effort"))
          ? dashboardStore.allocateObservationSequence()
          : undefined;
        if (args.mode === "start") {
          context.checkpoint({ pendingSettings, ...(settingsObservationSequence === undefined ? {} : { settingsObservationSequence }) });
        }
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
            onBeforeNativeDispatch: ({ session, mode, activeTurnId, baselineTurnId }) => {
              if (mode === "steer") {
                context.checkpoint({ turnId: activeTurnId });
                return;
              }
              context.checkpoint({
                pendingSettings,
                ...(settingsObservationSequence === undefined ? {} : { settingsObservationSequence }),
                baselineTurnId: baselineTurnId ?? null,
                capacityHint: {
                  phase: "provisional-start", endpoint: session.endpoint, threadId: session.thread_id,
                  mappingId: session.mapping_id, clientUserMessageId: `${context.effectiveSourceContextId}:${context.callId}`,
                  baselineTurnId: baselineTurnId ?? null,
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
          const turn = await pool.historyReader(worker.endpoint).findTurn(
            worker.thread_id, result.turnId, createHistoryScanBudget(),
          );
          if (turn && isTerminalStatus(turn.status)) attachments.releaseTurn(worker.endpoint, worker.thread_id, result.turnId);
        }
        observeLastSent(args.nickname, args, result, context.operationSequence);
        if (result.appliedSettings) observeCurrentSettings(args.nickname, result.appliedSettings, Date.now(), settingsObservationSequence);
        dashboardStore.markDirty();
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
      inspect_worker_conversation: async (args, context) => {
        const signal = context.signal ?? new AbortController().signal;
        return readWorkerMessages({
          resolveSession: (nickname) => registry.get(nickname),
          readTurns: readWorkerTurns,
        }, args, signal);
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
        if (args.nickname === "assistant") throw new AppError("UNSUPPORTED_CAPABILITY", "the assistant cannot interrupt its own active tool turn");
        const turnId = await sessions.interrupt(args.nickname, args.turn_id, {
          onBeforeNativeDispatch: (resolvedTurnId) => context.checkpoint({ turnId: resolvedTurnId }),
        });
        dashboardStore.markDirty();
        await renderDashboardSafely();
        return { interrupted: true, turnId };
      },
      compact_session: async (args, context) => {
        if (args.nickname === "assistant") {
          const identity = registry.snapshot().assistant;
          const notice = systemNoticeForAttempt(context.attemptId, "assistant session compacted");
          assistantPostTurnActions.schedule(context.operationId, "compact", {
            endpointId: identity.endpoint,
            threadId: identity.thread_id,
            awarenessBody: "assistant session compacted",
            ...(notice ? { notice } : {}),
          });
          return { scheduled: true, actionId: context.operationId };
        }
        const result = await sessions.compact(args.nickname, {
          onBeforeNativeDispatch: (evidence) => context.checkpoint(evidence),
        });
        prepareToolSystemNotice(context.operationId, context.attemptId, `${args.nickname} session compacted`);
        return { nickname: args.nickname, ...result };
      },
      list_models: async (args) => sessions.models(args.endpoint === assistantEndpoint.id ? assistantEndpoint.id : projectEndpoint(args.endpoint)),
      disconnect_endpoint: async (args, context) => {
        const endpointId = projectEndpoint(args.endpoint);
        assertEndpointLifecycleOrder(context.operationSequence, endpointId);
        await endpointManager.disconnect(endpointId, (checkpoint) => context.checkpoint({ endpoint: endpointId, ...(checkpoint as object) }));
        return { endpoint: endpointId, state: "disconnected" };
      },
      restart_endpoint: async (args, context) => {
        if (args.endpoint === assistantEndpoint.id) {
          const runtimeIdentity = await assistantEndpoint.runtimeIdentity();
          if (!runtimeIdentity) throw new AppError("OPERATION_CONFLICT", "assistant runtime identity is unavailable");
          const notice = systemNoticeForAttempt(context.attemptId, "assistant app-server restarted");
          assistantPostTurnActions.schedule(context.operationId, "restart", {
            endpointId: assistantEndpoint.id,
            runtimeIdentity,
            awarenessBody: "assistant app-server restarted",
            ...(notice ? { notice } : {}),
          });
          return { scheduled: true, actionId: context.operationId, endpoint: assistantEndpoint.id };
        }
        const endpointId = projectEndpoint(args.endpoint);
        assertEndpointLifecycleOrder(context.operationSequence, endpointId);
        // Daemonless (Claude) endpoints go through the same restart flow; the manager skips the
        // runtime-identity drain/shutdown for them (see EndpointManager.shutdownTarget).
        await endpointManager.restart(endpointId, (checkpoint) => context.checkpoint({ endpoint: endpointId, ...(checkpoint as object) }));
        await resumeManagedEndpoint(endpointId, true);
        prepareToolSystemNotice(context.operationId, context.attemptId, `endpoint ${endpointId} restarted`);
        return { endpoint: endpointId, state: "ready" };
      },
      set_session_model: async (args, context) => {
        if (args.nickname === "assistant") {
          const identity = registry.snapshot().assistant;
          await sessions.setModelForIdentity(identity.endpoint, identity.thread_id, assistantMappingId, args.model);
        } else {
          await sessions.setModel(args.nickname, args.model);
          dashboardStore.markDirty();
          await renderDashboardSafely();
        }
        const body = `${args.nickname} will use model ${args.model} on its next turn`;
        prepareToolSystemNotice(context.operationId, context.attemptId, body);
        if (args.nickname === "assistant") recordAssistantSystemAwareness(conversations, context.operationId, body);
        return { pending: true };
      },
      set_reasoning_effort: async (args, context) => {
        if (args.nickname === "assistant") {
          const identity = registry.snapshot().assistant;
          await sessions.setEffortForIdentity(identity.endpoint, identity.thread_id, assistantMappingId, args.effort);
        } else {
          await sessions.setEffort(args.nickname, args.effort);
          dashboardStore.markDirty();
          await renderDashboardSafely();
        }
        const body = `${args.nickname} will use reasoning effort ${args.effort} on its next turn`;
        prepareToolSystemNotice(context.operationId, context.attemptId, body);
        if (args.nickname === "assistant") recordAssistantSystemAwareness(conversations, context.operationId, body);
        return { pending: true };
      },
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
        }
        observeGoal(args.nickname, result);
        dashboardStore.markDirty();
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

  function systemNoticeForAttempt(attemptId: string, body: string): { binding: ConversationBinding; body: string } | undefined {
    try { return { binding: assistantAttemptBinding(attemptId), body: `[system] ${body}` }; }
    catch (error) {
      if (error instanceof AppError && error.code === "UNSUPPORTED_CAPABILITY") return undefined;
      throw error;
    }
  }

  function prepareToolSystemNotice(operationId: string, attemptId: string, body: string): void {
    const notice = systemNoticeForAttempt(attemptId, body);
    if (!notice) return;
    deliveries.prepare({ id: `tool-system:${operationId}`, kind: "system_notice", ...notice, mandatory: true });
  }

  function completeDeferredSystemNotices(action: { id: string; payload: Record<string, unknown> }): void {
    const notice = action.payload.notice as { binding?: ConversationBinding; body?: string } | undefined;
    if (notice?.binding && typeof notice.body === "string") {
      deliveries.prepare({ id: `tool-system:${action.id}`, kind: "system_notice", binding: notice.binding, body: notice.body, mandatory: true });
    }
    if (typeof action.payload.awarenessBody === "string") {
      recordAssistantSystemAwareness(conversations, action.id, action.payload.awarenessBody);
    }
  }

  function assistantSessionSummary() {
    const identity = registry.snapshot().assistant;
    const pending = sessionControls.settings(identity.endpoint, identity.thread_id, assistantMappingId);
    const native = nativeSessions.view({ endpointId: identity.endpoint, threadId: identity.thread_id, mappingId: assistantMappingId });
    return {
      nickname: "assistant",
      mappingId: assistantMappingId,
      endpoint: identity.endpoint,
      provider: "codex" as const,
      projectDir: identity.project_dir,
      lifecycleState: "managed",
      nativeStatus: native?.availability === "ready" ? native.status : null,
      activeTurnId: native?.availability === "ready" ? native.activeTurnId : null,
      model: pending.model ?? assistantCurrentSettings.model ?? null,
      effort: pending.effort ?? assistantCurrentSettings.effort ?? null,
      host: localHostName,
      goal: null,
    };
  }

  async function refreshAssistantNativeState(): Promise<void> {
    const identity = registry.snapshot().assistant;
    const generation = pool.endpointGeneration(identity.endpoint).generation;
    const nativeIdentity = { endpointId: identity.endpoint, threadId: identity.thread_id, mappingId: assistantMappingId };
    const existing = nativeSessions.view(nativeIdentity);
    if (!existing || existing.endpointGeneration !== generation || existing.availability !== "ready") {
      nativeSessions.register(nativeIdentity, generation);
    }
    const token = nativeSessions.captureRefresh(nativeIdentity, generation);
    const response = await pool.request<any>(identity.endpoint, "thread/read", {
      threadId: identity.thread_id,
      includeTurns: false,
    });
    const status = response.thread?.status?.type ?? response.thread?.status ?? "unknown";
    const latest = status === "active" ? await pool.historyReader(identity.endpoint).latestTurn(identity.thread_id) : undefined;
    nativeSessions.applyRefresh(token, {
      status,
      activeTurnId: latest && !isTerminalStatus(latest.status) ? latest.id : null,
    });
  }

  async function assistantSessionStatus(observeNative: boolean): Promise<unknown> {
    const identity = registry.snapshot().assistant;
    if (observeNative) await refreshAssistantNativeState();
    const summary = assistantSessionSummary();
    return {
      nickname: "assistant",
      identity: { endpoint: summary.endpoint, threadId: identity.thread_id, projectDir: summary.projectDir },
      managementState: summary.lifecycleState,
      nativeStatus: summary.nativeStatus,
      activeTurnId: summary.activeTurnId,
      model: summary.model,
      effort: summary.effort,
      pendingSettings: sessionControls.settings(identity.endpoint, identity.thread_id, assistantMappingId),
      goal: null,
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
    sessionControls.setGoalControlled(identity.endpointId, identity.threadId, identity.mappingId, controlled);
  }

  function armGoalControl(nickname: string): void {
    const identity = dashboardIdentity(nickname);
    sessionControls.setGoalControlled(
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
    if (!claudeGoalDriver) return;
    const session = registry.get(nickname);
    if (session && sessionProvider(session.endpoint) === "claude") {
      claudeGoalDriver.activate({ nickname, endpointId: session.endpoint, threadId: session.thread_id });
    }
  }

  function projectEndpoint(requested?: string): string {
    const endpointId = requested ?? endpoint.id;
    if (endpointId === assistantEndpoint.id) throw new AppError("UNSUPPORTED_CAPABILITY", "the assistant-only endpoint cannot host project sessions");
    return endpointId;
  }

  // The provider (runtime kind) of an endpoint. Fixed at definition time: the built-in
  // `local`/`assistant-local` endpoints are Codex; every other endpoint (local Claude and all
  // remotes) is a catalog entry whose `provider` field is authoritative.
  function sessionProvider(endpointId: string): "codex" | "claude" {
    // The built-in `local`/`assistant-local` endpoints are Codex; every other endpoint (local
    // Claude and all remotes) is a catalog entry whose `provider` is authoritative.
    if (endpointId !== "local" && endpointId !== assistantEndpoint.id) {
      try {
        const entry = endpointCatalog.snapshot().endpoints[endpointId] as { provider?: string } | undefined;
        if (entry?.provider === "claude") return "claude";
      } catch { /* catalog unavailable — treat as codex */ }
    }
    return "codex";
  }

  function operationTargetResolver(): OperationRecoveryTargetResolver {
    return { defaultProjectEndpointId: "local", assistantEndpointId: assistantEndpoint.id, session: (nickname) => registry.get(nickname) };
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
      assistantEndpointId: assistantEndpoint?.id,
      session: (nickname) => registry.get(nickname),
    }).filter((endpointId) => endpointId !== assistantEndpoint?.id);
  }

  function recoverableActivationReferences(): string[] {
    return recoverableOperationActivationReferences(operations.listRecoverable(), {
      defaultProjectEndpointId: "local",
      assistantEndpointId: assistantEndpoint.id,
      session: (nickname) => registry.get(nickname),
    }).filter((endpointId) => endpointId !== assistantEndpoint.id);
  }

  function lifecycleOwnedEndpointIds(): Set<string> {
    return new Set(recoverableLifecycleEndpointReferences(operations.listRecoverable(), {
      defaultProjectEndpointId: "local",
      assistantEndpointId: assistantEndpoint.id,
      session: (nickname) => registry.get(nickname),
    }));
  }

  function bindProjectEndpoint(target: ManagedEndpointContract, generation: number): void {
    if (projectEndpointSubscriptions.has(target.id)) offerWorkerDiscontinuity(webWorkerStream, target.id);
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
    for (const session of Object.values(registry.snapshot().sessions)) {
      if (session.endpoint === target.id && session.lifecycle_state === "managed") {
        nativeSessions.register({ endpointId: target.id, threadId: session.thread_id, mappingId: session.mapping_id }, generation);
      }
    }
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
        const threadId = typeof (params as { threadId?: unknown })?.threadId === "string"
          ? (params as { threadId: string }).threadId
          : undefined;
        const mapping = threadId ? registry.getByIdentity(target.id, threadId) : undefined;
        const before = mapping
          ? nativeSessions.view({ endpointId: target.id, threadId: threadId!, mappingId: mapping.session.mapping_id })
          : undefined;
        const refreshRequired = nativeSessions.observe(target.id, generation, method, params);
        if (refreshRequired && mapping) {
          runBackground(
            () => sessions.refreshNativeState(mapping.nickname),
            () => recordBackgroundFailure("worker native status refresh"),
          );
        }
        offerWorkerNotification(webWorkerStream, target.id, method, params);
        if (method === "thread/status/changed" && (params as any)?.status?.type === "idle"
          && threadId && before?.availability === "ready" && before.status === "active" && before.activeTurnId) {
          runBackground(() => processWorkerTerminalNotification({
            endpoints: endpointManager,
            ownership: ownershipWatcher,
            relay,
            reconcileOperations,
          }, target.id, "turn/completed", { threadId, turn: { id: before.activeTurnId } }),
          () => recordBackgroundFailure("worker idle terminal recovery"));
        }
        if (!observations.accept(target.id, method, params)) runBackground(() => onNotification(target.id, method, params), () => recordBackgroundFailure("project notification"));
      }),
      target.onReady(() => {
        if (current()) offerWorkerDiscontinuity(webWorkerStream, target.id);
      }),
      target.onPermissionBlocked((event) => {
        if (!current()) return;
        runBackground(() => relay.handlePermissionBlocked(target.id, event), () => recordBackgroundFailure("permission notification"));
      }),
      target.onUnavailable((kind) => {
        if (!current()) return;
        offerWorkerDiscontinuity(webWorkerStream, target.id);
        nativeSessions.invalidateEndpoint(target.id, generation);
        runBackground(() => handleEndpointUnavailable(target, kind), () => recordBackgroundFailure("project unavailable handling"));
      }),
    ];
    projectEndpointSubscriptions.set(target.id, subscriptions);
    if (target.state === "ready") requestReadyRecovery();
  }

  async function onNotification(endpointId: string, method: string, params: any): Promise<void> {
    const identity = registry.snapshot().assistant;
    if (endpointId === identity.endpoint && params?.threadId === identity.thread_id && method === "thread/settings/updated") {
      const settings = params.threadSettings ?? {};
      assistantCurrentSettings = {
        ...(typeof settings.model === "string" ? { model: settings.model } : assistantCurrentSettings.model ? { model: assistantCurrentSettings.model } : {}),
        ...(typeof settings.effort === "string" || settings.effort === null ? { effort: settings.effort } : assistantCurrentSettings.effort !== undefined ? { effort: assistantCurrentSettings.effort } : {}),
      };
      return;
    }
    if (endpointId === identity.endpoint && params?.threadId === identity.thread_id && method === "thread/status/changed") return;
    if (endpointId === identity.endpoint
      && prepareAssistantWebCommentary(conversations, deliveries, identity.thread_id, (turnId) => {
        const live = nativeSessions.view({ endpointId: identity.endpoint, threadId: identity.thread_id, mappingId: assistantMappingId });
        return live?.availability === "ready" && live.status === "active" && live.activeTurnId === turnId;
      }, method, params)) return;
    if (await routeLifecycleNotification({
      assistant: (notification) => assistantLifecycleBuffer.accept(notification, handleAssistantLifecycleNotification),
      worker: (targetEndpointId, targetMethod, targetParams) => processWorkerTerminalNotification({
        endpoints: endpointManager,
        ownership: ownershipWatcher,
        relay,
        reconcileOperations,
      }, targetEndpointId, targetMethod, targetParams),
    }, endpointId, identity, method, params)) return;
    await relay.handleNotification(endpointId, method, params);
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
    const attemptBefore = assistant.contextForTurn(params.turn.id);
    if (!attemptBefore) return;
    await dispatcher.waitForAttemptSubmissions(attemptBefore.attemptId);
    if (!assistant.beginTerminalizing(params.turn.id)) return;
    const settled = await settleAssistantTerminalTools({
      fenceTools: () => assistant.fenceTools(attemptBefore.attemptId, 1_000),
      reconcileOperations,
      requestRestartOnce,
    });
    if (!settled) return;
    const memberIds = conversations.membersForAttempt(attemptBefore.attemptId).map((member) => member.contextId);
    await commitAssistantTerminalFinals(params.turn, async () => {
      const bounded = await readBoundedThreadWithReader(identity.endpoint, identity.thread_id);
      return (await hydrateThreadTurns(
        identity.endpoint, identity.thread_id, bounded.thread, [String(params.turn.id)], {
          allowLegacySummary: true,
          existingReader: bounded.reader,
        },
      )).turns ?? [];
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
    await drainAssistantPostTurnActions(false);
    await enqueuePendingEvents();
    await dispatcher.enqueueInternal("terminal");
  }

  async function enqueuePendingEvents(): Promise<void> {
    if (!schedulerAccepting || stopping) return;
    routePendingAssistantEvents(db, (event) => scheduler.enqueueEvent(event));
    await dispatcher?.enqueueInternal("events");
  }

  function isTerminalStatus(status: unknown): boolean {
    const value = typeof status === "string" ? status : String((status as { type?: unknown } | undefined)?.type ?? "");
    return new Set(["completed", "failed", "interrupted"]).has(value);
  }

  async function readBoundedThread(
    endpointId: string,
    threadId: string,
    lease?: EndpointWorkLease,
  ): Promise<any> {
    return (await readBoundedThreadWithReader(endpointId, threadId, lease)).thread;
  }

  async function readBoundedThreadWithReader(
    endpointId: string,
    threadId: string,
    lease?: EndpointWorkLease,
  ) {
    const response = await pool.request<any>(
      endpointId, "thread/read", { threadId, includeTurns: false }, undefined, lease,
    );
    const reader = pool.historyReader(endpointId, lease);
    const page = await reader.turnsPage(threadId, {
      limit: recoveryTurnWindowLimit,
      sortDirection: "desc",
      itemsView: "notLoaded",
    });
    const turns = [...page.data].reverse();
    return {
      thread: {
        ...response.thread,
        turns,
        historyWindow: { exhausted: page.nextCursor === null, anchorTurnIds: [] as string[] },
      },
      reader,
    };
  }

  async function hydrateThreadTurns(
    endpointId: string,
    threadId: string,
    thread: any,
    turnIds: Iterable<string | undefined>,
    options: {
      lease?: EndpointWorkLease;
      allowLegacySummary?: boolean;
      existingReader?: ReturnType<AppServerPool["historyReader"]>;
      retainPartialOnBudgetExhaustion?: boolean;
    } = {},
  ): Promise<any> {
    const reader = options.existingReader ?? pool.historyReader(endpointId, options.lease);
    return hydrateSelectedThreadTurns(threadId, thread, turnIds, reader, options);
  }

  async function readAssistantRecoveryThread(endpointId: string, threadId: string): Promise<any> {
    const bounded = await readBoundedThreadWithReader(endpointId, threadId);
    const thread = bounded.thread;
    const recoveryTurns = new Map<string, any>((thread.turns ?? []).map((turn: any) => [String(turn.id), turn]));
    const targetIds = new Set<string>(assistant.activeAttempts().flatMap((attempt) => attempt.turnId ? [attempt.turnId] : []));
    const anchorTurnIds = new Set<string>();
    for (const unresolved of conversations.unresolvedSubmissions()) {
      if (unresolved.submissionKind === "start" && Object.hasOwn(unresolved, "baselineTurnId")) {
        const baseline = unresolved.baselineTurnId ?? null;
        const baselineIndex = baseline === null
          ? -1
          : (thread.turns ?? []).findIndex((turn: any) => String(turn.id) === baseline);
        if (baseline !== null && baselineIndex >= 0) {
          anchorTurnIds.add(baseline);
        }
        const candidates = baseline !== null && baselineIndex >= 0
          ? (thread.turns ?? []).slice(baselineIndex + 1)
          : thread.turns ?? [];
        for (const turn of candidates) targetIds.add(String(turn.id));
      } else if (unresolved.expectedTurnId) {
        targetIds.add(unresolved.expectedTurnId);
      }
    }
    return hydrateThreadTurns(
      endpointId, threadId, {
        ...thread,
        turns: [...recoveryTurns.values()],
        historyWindow: { ...thread.historyWindow, anchorTurnIds: [...anchorTurnIds] },
      }, targetIds, {
        allowLegacySummary: true,
        existingReader: bounded.reader,
        retainPartialOnBudgetExhaustion: true,
      },
    );
  }

  async function startOrResumeAssistant(): Promise<string> {
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
    await refreshAssistantNativeState();
    assistantCurrentSettings = {
      ...(resumed.model ? { model: resumed.model } : {}),
      ...(resumed.effort !== undefined ? { effort: resumed.effort } : {}),
    };
    return nativeSessions.view({ endpointId: assistantEndpoint.id, threadId: resumed.threadId, mappingId: assistantMappingId })?.status ?? "unknown";
  }

  async function drainAssistantPostTurnActions(requireSettled: boolean): Promise<void> {
    const result = await assistantPostTurnActions.drain();
    if (result.failed > 0) report({ level: "warn", code: "background_task_failed", component: "assistant_post_turn_action" });
    if (requireSettled && (result.pending > 0 || assistantPostTurnActions.hasPending())) {
      throw new AppError("ENDPOINT_UNAVAILABLE", "assistant post-turn action is still awaiting native confirmation");
    }
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
        assistantEndpointId: assistantEndpoint.id,
        session: (nickname) => registry.get(nickname),
      });
    await runOperationRecoveryChains(entries, resolveTarget, async ({ operation }, target) => {
      if (operationRecoveryAction({
        state: operation.state,
        activeHandler: assistant.hasActiveTools(operation.attemptId) || webGoalControl?.hasActiveAttempt(operation.attemptId) === true,
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
          if (args.endpoint === assistantEndpoint.id) {
            const action = assistantPostTurnActions.get(operation.id);
            if (assistantPostTurnActionMatches(action, { kind: "restart", endpointId: assistantEndpoint.id })) {
              operations.succeed(operation.id, { scheduled: true, actionId: operation.id, endpoint: assistantEndpoint.id });
            } else failRecoveredNoEffect(operation.id, "assistant restart target was not durably scheduled exactly");
          } else {
            const endpointId = projectEndpoint(args.endpoint);
            const saved = parseEndpointLifecycleCheckpoint(operation.receipt);
            if (operation.receipt !== undefined && (!saved || saved.endpoint !== endpointId)) return;
            if (saved) await endpointManager.recoverRestart(endpointId, saved.phase, saved.identity,
              (checkpoint) => operations.checkpoint(operation.id, { endpoint: endpointId, ...(checkpoint as object) }));
            else await endpointManager.restart(endpointId, (checkpoint) => operations.checkpoint(operation.id, { endpoint: endpointId, ...(checkpoint as object) }));
            await resumeManagedEndpoint(endpointId, true);
            await succeedRecovered(operation, { endpoint: endpointId, state: "ready" },
              () => prepareToolSystemNotice(operation.id, operation.attemptId, `endpoint ${endpointId} restarted`));
          }
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
          const checkpoint = operation.receipt as {
            turnId?: string;
            baselineTurnId?: string | null;
            capacityHint?: unknown;
            pendingSettings?: { model?: string; effort?: string };
            settingsObservationSequence?: number;
          } | undefined;
          if (args.mode === "start" && !Object.hasOwn(checkpoint ?? {}, "baselineTurnId")) {
            if (checkpoint?.capacityHint === undefined) {
              failRecoveredNoEffect(operation.id, "worker start was not dispatched");
            }
            return;
          }
          const bounded = await readBoundedThreadWithReader(session.endpoint, session.thread_id, recoveryLease);
          const metadata = bounded.thread;
          let recoveryThread = metadata;
          let targetIds: Array<string | undefined>;
          if (args.mode === "steer") {
            targetIds = [checkpoint?.turnId];
          } else {
            const suffix = recoveryTurnSuffix(metadata.turns ?? [], checkpoint?.baselineTurnId ?? null);
            recoveryThread = { ...metadata, turns: suffix };
            targetIds = suffix.map((turn: any) => String(turn.id));
          }
          const history = { thread: await hydrateThreadTurns(
            session.endpoint, session.thread_id, recoveryThread, targetIds, {
              ...(recoveryLease === undefined ? {} : { lease: recoveryLease }),
              allowLegacySummary: true,
              existingReader: bounded.reader,
            },
          ) };
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
            const appliedSettings = args.mode === "start" && checkpoint && Object.hasOwn(checkpoint, "pendingSettings") ? checkpoint.pendingSettings ?? {} : undefined;
            // Same guard as the live send: Claude's model/effort are sticky (no server to
            // persist them), so consuming on recovery would silently erase them. Shared method.
            if (appliedSettings) sessions.consumeSettingsIfNative(session.endpoint, session.thread_id, session.mapping_id, appliedSettings);
            const receipt = { nickname: args.nickname, mode: args.mode, turnId: turn.id, terminal: isTerminalStatus(turn.status), ...(appliedSettings ? { appliedSettings } : {}) };
            await succeedRecovered(operation, receipt, () => {
              observeLastSent(args.nickname, args, { mode: args.mode, turnId: turn.id }, operation.sequence);
              if (appliedSettings) observeCurrentSettings(args.nickname, appliedSettings, operation.createdAt, checkpoint?.settingsObservationSequence);
              dashboardStore.markDirty();
            });
          } else {
            const reconciledStart = reconcileAbsentRecoveredSendStart(operations, operation, history, () => {
              for (const hold of holds) attachments.releaseOperation(hold.id);
            });
            if (!reconciledStart && args.mode === "steer") {
              const targetTurnId = checkpoint?.turnId;
              const target = targetTurnId ? history.thread.turns.find((candidate: any) => candidate.id === targetTurnId) : undefined;
              if (target?.itemsView === "full" && isTerminalStatus(target.status)) {
                for (const hold of holds) attachments.releaseOperation(hold.id);
                operations.failAndUnbind(operation.id, { message: "terminal target history proves the requested steer was not appended" });
              }
            }
          }
        } else if (operation.kind === "compact_session") {
          if (args.nickname === "assistant") {
            const action = assistantPostTurnActions.get(operation.id);
            const identity = registry.snapshot().assistant;
            if (assistantPostTurnActionMatches(action, {
              kind: "compact", endpointId: assistantEndpoint.id, threadId: identity.thread_id,
            })) operations.succeed(operation.id, { scheduled: true, actionId: operation.id });
            else failRecoveredNoEffect(operation.id, "assistant compaction target was not durably scheduled exactly");
          } else {
            const checkpoint = operation.receipt as {
              endpointId?: string;
              threadId?: string;
              mappingId?: string;
              baselineCompactionItemIds?: string[];
              baselineTurnId?: string | null;
            } | undefined;
            if (!checkpoint?.endpointId || !checkpoint.threadId || !checkpoint.mappingId
              || !checkpoint.baselineCompactionItemIds) {
              failRecoveredNoEffect(operation.id, "worker compaction was not dispatched");
            } else if (!Object.hasOwn(checkpoint, "baselineTurnId")) {
              // Pre-bounded-history checkpoints cannot be reconciled without retransferring
              // the entire thread. Leave them uncertain instead of redispatching compaction.
              return;
            } else {
              const observed = await sessions.compactionItemIdsAfter(
                checkpoint.endpointId, checkpoint.threadId, checkpoint.baselineTurnId ?? null, recoveryLease,
              );
              const compactionItemId = observed[0];
              if (compactionItemId) await succeedRecovered(operation, {
                nickname: args.nickname, compactionItemId, baselineCompactionItemIds: checkpoint.baselineCompactionItemIds,
              }, () => prepareToolSystemNotice(operation.id, operation.attemptId, `${args.nickname} session compacted`));
            }
          }
        } else if (operation.kind === "set_session_model" || operation.kind === "set_reasoning_effort") {
          const session = args.nickname === "assistant"
            ? { endpoint: assistantEndpoint.id, thread_id: registry.snapshot().assistant.thread_id, mapping_id: assistantMappingId }
            : registry.get(args.nickname);
          const settings = session ? sessionControls.settings(session.endpoint, session.thread_id, session.mapping_id) : {};
          const proven = operation.kind === "set_session_model" ? settings.model === args.model : settings.effort === args.effort;
          if (proven) await succeedRecovered(operation, { pending: true }, () => {
            if (args.nickname !== "assistant") dashboardStore.markDirty();
            const body = operation.kind === "set_session_model"
              ? `${args.nickname} will use model ${args.model} on its next turn`
              : `${args.nickname} will use reasoning effort ${args.effort} on its next turn`;
            prepareToolSystemNotice(operation.id, operation.attemptId, body);
            if (args.nickname === "assistant") recordAssistantSystemAwareness(conversations, operation.id, body);
          });
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
            const live = nativeSessions.view({ endpointId: session.endpoint, threadId: session.thread_id, mappingId: session.mapping_id });
            const needsReconcile = !managedEpochs.current(session.endpoint, session.thread_id, session.mapping_id)
              || !live || live.availability !== "ready" || live.status === "unknown";
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
              dashboardStore.markDirty();
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
            const history = { thread: await readBoundedThread(session.endpoint, session.thread_id, recoveryLease) };
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
              }).then(() => undefined),
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
            if (operation.kind === "cancel_goal") dashboardStore.markDirty();
          });
        } else if (operation.kind === "interrupt_session") {
          const session = registry.get(args.nickname);
          if (!session) return;
          const turnId = args.turn_id ?? (operation.receipt as { turnId?: string } | undefined)?.turnId;
          if (!turnId) return;
          const turn = await pool.historyReader(session.endpoint, recoveryLease).findTurn(
            session.thread_id, turnId, createHistoryScanBudget(),
          );
          if (turn && isTerminalStatus(turn.status)) await succeedRecovered(operation, { interrupted: true, turnId }, () => {
            dashboardStore.markDirty();
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
    webGoalControl?.repairAwareness();
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

  async function resumeStartupManagedSessions(): Promise<Set<string>> {
    const excluded = lifecycleOwnedEndpointIds();
    const endpointIds = [...new Set(Object.values(registry.managedSnapshot().sessions).map((session) => session.endpoint))]
      .filter((endpointId) => !excluded.has(endpointId) && endpointManager.desiredState(endpointId) === "automatic");
    // Chat ingress remains closed until every reachable referenced endpoint has produced its
    // first current-generation native snapshots. Per-endpoint work runs concurrently; failures
    // settle as unavailable/deferred rather than letting ingress race an unknown active turn.
    return settleStartupCapacityBootstrap(endpointIds, resumeManagedEndpoint, (endpointId, error) => {
      reportOperationalSafely(report, {
        level: "warn", code: "background_task_failed", component: "managed_recovery",
        reason: `startup managed recovery of ${endpointId} failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      // This startup attempt owns the endpoint recovery slot. Remove it from the ready buffer so
      // acceptAndDrain() cannot immediately duplicate it. The recovery owner and a later ready event
      // re-arm retries normally. Successful resumeManagedEndpoint acknowledges idempotently itself.
      endpointReadyBuffer?.acknowledge(endpointId);
    });
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
      const liveBefore = nativeSessions.view({ endpointId: session.endpoint, threadId: session.thread_id, mappingId: session.mapping_id });
      if (options.unavailableOnly && liveBefore?.availability === "ready" && liveBefore.status !== "unknown") {
        settledKeys.push(key);
        continue;
      }
      try {
        // SSH Codex keeps a detached App Server across QiYan connection generations. Rejoin each
        // managed thread so this WebSocket receives lifecycle/item notifications; local Codex gets
        // a fresh process and Claude's daemonless runtime has no connection subscription.
        const resumeForConnection = managedRecoveryRequiresConnectionResume(
          sessionProvider(session.endpoint),
          remoteContexts.has(session.endpoint),
        );
        const response = await lifecycle.reconcileManaged(
          nickname,
          session,
          options.lease,
          options.isCurrent,
          resumeForConnection ? { resumeForConnection: true } : undefined,
        );
        if ((options.isCurrent && !options.isCurrent())
          || (options.lease && !isManagedRecoveryLeaseCurrent(session.endpoint, options.lease))) {
          throw new AppError("ENDPOINT_UNAVAILABLE", "managed recovery endpoint generation changed");
        }
        const resumeObservationSequence = dashboardStore.allocateObservationSequence();
        if (options.isCurrent && !options.isCurrent()) throw new AppError("ENDPOINT_UNAVAILABLE", "managed recovery owner stopped");
        hydrateThreadOrder(session.endpoint, response.thread);
        if (options.isCurrent && !options.isCurrent()) throw new AppError("ENDPOINT_UNAVAILABLE", "managed recovery owner stopped");
        observations.observeResume(session.endpoint, session.thread_id, response, Date.now(), {
          settings: resumeObservationSequence,
        });
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
          && current.thread_id === session.thread_id && current.lifecycle_state === "managed"
          && disposition === "permanent") warnSessionUnavailable(nickname, session.endpoint, session.thread_id);
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
        if (!endpointManager.acknowledgeReadyRecovery(endpointId, recoveredGeneration)) {
          throw new AppError("ENDPOINT_UNAVAILABLE", `endpoint generation changed before recovery acknowledgement: ${endpointId}`);
        }
        completeEndpointRecoveryIncident(endpointRecoveryIncidents, endpointId, (incident) => {
          deliveries.prepare({
            id: `endpoint-recovered:${endpointId}:${incident.episode}`,
            kind: "system_warning",
            binding: currentOwnerBinding(),
            body: `[system] ${endpointId} app-server reconnected`,
            mandatory: true,
          });
        });
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
    for (const session of Object.values(registry.managedSnapshot().sessions)) {
      if (session.endpoint !== target.id) continue;
      managedRecoveryOwner?.recordFailure(managedRetryKey(session.endpoint, session.thread_id, session.mapping_id), "endpoint");
    }
    if (target.id === assistantEndpoint.id) {
      schedulerAccepting = false;
    }
    const identity = registry.snapshot().assistant;
    deliveries.prepare({
      id: `endpoint-unavailable:${target.id}:${endpointIncident.episode}`,
      kind: "system_warning",
      binding: currentOwnerBinding(),
      body: `[system] ${target.id} app-server is unavailable; reconnecting`,
      mandatory: true,
    });
    await durableEventSources.endpointUnavailable({
      id: `endpoint-unavailable:${target.id}:${endpointIncident.episode}`,
      endpointId: target.id,
      threadId: identity.thread_id,
      incident: endpointIncident.sequence,
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
    pool.replaceEndpoint(assistantEndpoint);
    await startOrResumeAssistant();
    await dispatcher.recover();
    await dispatcher.idle();
    if (!dispatcher.isNativeRecoveryReady()) {
      const failure = dispatcher.nativeRecoveryFailure();
      await dispatcher.nativeUnavailable();
      throwAssistantNativeRecoveryFailure(failure);
    }
    await operationReconciler?.endpointReady(assistantEndpoint.id);
    assistantToolReadiness.ready();
    schedulerAccepting = true;
    await endpointReadyBuffer?.acceptAndDrain();
    reconnectAttempts.set(assistantEndpoint.id, 0);
    await enqueuePendingEvents();
    completeEndpointRecoveryIncident(endpointRecoveryIncidents, assistantEndpoint.id, (incident) => {
      deliveries.prepare({
        id: `endpoint-recovered:${assistantEndpoint.id}:${incident.episode}`,
        kind: "system_warning",
        binding: currentOwnerBinding(),
        body: `[system] ${assistantEndpoint.id} app-server reconnected`,
        mandatory: true,
      });
    });
    await renderDashboardSafely();
  }

  async function isolateLifecycleRecoveryFailure(nickname: string, session: RegistrySession): Promise<void> {
    const current = registry.get(nickname);
    if (!current || current.mapping_id !== session.mapping_id || current.endpoint !== session.endpoint || current.thread_id !== session.thread_id) return;
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
