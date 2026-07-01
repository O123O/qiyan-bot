import type { RegistryDocument } from "../registry/session-registry.ts";
import type { RuntimeStore } from "../storage/runtime-store.ts";
import { SessionDashboardStore, type DashboardIdentity, type DashboardNotification } from "../storage/session-dashboard-store.ts";
import { normalizeTokenUsage, toIsoTimestamp, type DashboardGoal } from "./dashboard-schema.ts";
import type { TerminalObservation } from "../events/relay.ts";

interface RegistryView { snapshot(): RegistryDocument }
interface ObserverOptions {
  now(): number;
  readThread(endpointId: string, threadId: string): Promise<{ turns: Array<{ id: string; startedAt: number | null; status?: unknown }> }>;
  readGoal(endpointId: string, threadId: string): Promise<unknown>;
  onChanged(): void;
  onError(error: unknown): void;
}

const supportedMethods = new Set([
  "turn/started",
  "thread/status/changed",
  "thread/settings/updated",
  "thread/tokenUsage/updated",
  "thread/goal/updated",
  "thread/goal/cleared",
]);

export class SessionObservationProcessor {
  private tails = new Map<string, Promise<void>>();

  constructor(
    private readonly store: SessionDashboardStore,
    private readonly registry: RegistryView,
    private readonly runtime: RuntimeStore,
    private readonly options: ObserverOptions,
  ) {}

  accept(endpointId: string, method: string, params: unknown): boolean {
    if (!supportedMethods.has(method)) return false;
    const normalized = normalizeNotification(method, params);
    if (!normalized) return false;
    this.store.acceptNotification(endpointId, method, normalized, this.options.now());
    void this.enqueue(endpointId);
    return true;
  }

  async drain(endpointId?: string): Promise<void> {
    if (endpointId !== undefined) {
      await this.enqueue(endpointId);
      return;
    }
    const endpoints = new Set(this.store.pendingNotifications().map((item) => item.endpointId));
    await Promise.all([...endpoints].map((id) => this.enqueue(id)));
  }

  async idle(): Promise<void> {
    await Promise.all([...this.tails.values()]);
  }

  observeResume(endpointId: string, threadId: string, response: any, observedAt: number): void {
    const identity = this.managedIdentity(endpointId, threadId);
    if (!identity) return;
    const sequence = this.store.allocateObservationSequence();
    const turns = Array.isArray(response?.thread?.turns) ? response.thread.turns : [];
    this.store.hydrateTurnOrder(identity, turns.map((turn: any) => ({ id: String(turn.id), startedAt: finiteOrNull(turn.startedAt) })));
    const nativeStatus = String(response?.thread?.status?.type ?? "notLoaded");
    const activeTurn = nativeStatus === "active"
      ? [...turns].reverse().find((turn: any) => !isTerminalStatus(turn.status))?.id ?? this.runtime.activeTurn(endpointId, threadId)
      : undefined;
    const before = this.visibleRuntime(identity);
    this.runtime.reconcileNativeState(endpointId, threadId, nativeStatus, activeTurn, sequence);
    const visibleChanged = before.nativeStatus !== nativeStatus || before.activeTurnId !== (activeTurn ?? null);
    if (visibleChanged) this.store.observeLifecycle(identity, observedAt);
    const settings = this.store.observeCurrentSettings(identity, {
      ...(typeof response?.model === "string" ? { model: response.model } : {}),
      ...(typeof response?.reasoningEffort === "string" || response?.reasoningEffort === null ? { effort: response.reasoningEffort } : {}),
      observedAt,
    }, sequence);
    if (visibleChanged || settings.valueChanged) this.options.onChanged();
  }

  async observeTerminal(event: TerminalObservation): Promise<void> {
    const identity = this.managedIdentity(event.endpointId, event.threadId);
    if (!identity) return;
    let ordinal = this.store.turnOrdinal(identity, event.turnId);
    if (ordinal === undefined) {
      const history = await this.options.readThread(event.endpointId, event.threadId);
      this.store.hydrateTurnOrder(identity, history.turns.map((turn) => ({ id: turn.id, startedAt: turn.startedAt })));
      ordinal = this.store.turnOrdinal(identity, event.turnId);
    }
    ordinal ??= this.store.observeTurnStarted(identity, { id: event.turnId, startedAt: event.startedAt });
    const completedAt = normalizeProtocolTime(event.completedAt, this.options.now());
    const workerChanged = this.store.observeLastWorkerEvent(identity, {
      message_id: event.finalMessageId,
      turn_id: event.turnId,
      status: event.status,
      at: toIsoTimestamp(completedAt),
    }, ordinal);
    let lifecycleChanged = false;
    const active = this.runtime.activeTurn(event.endpointId, event.threadId);
    if (active === undefined || active === event.turnId) {
      const sequence = this.store.allocateObservationSequence();
      const before = this.visibleRuntime(identity);
      this.runtime.reconcileNativeState(event.endpointId, event.threadId, "idle", undefined, sequence);
      lifecycleChanged = before.nativeStatus !== "idle" || before.activeTurnId !== null;
      if (lifecycleChanged) this.store.observeLifecycle(identity, completedAt);
    }
    if (workerChanged || lifecycleChanged) this.options.onChanged();
  }

  private enqueue(endpointId: string): Promise<void> {
    const previous = this.tails.get(endpointId) ?? Promise.resolve();
    const run = previous.then(() => this.processPending(endpointId), () => this.processPending(endpointId));
    const contained = run.catch((error) => { this.options.onError(error); });
    this.tails.set(endpointId, contained);
    void contained.finally(() => { if (this.tails.get(endpointId) === contained) this.tails.delete(endpointId); });
    return contained;
  }

  private async processPending(endpointId: string): Promise<void> {
    for (const notification of this.store.pendingNotifications(endpointId)) {
      const changed = await this.process(notification);
      this.store.completeNotification(notification.sequence);
      if (changed) this.options.onChanged();
    }
  }

  private async process(notification: DashboardNotification): Promise<boolean> {
    const params = notification.params as any;
    const identity = this.managedIdentity(notification.endpointId, String(params.threadId));
    if (!identity) return false;
    if (notification.method === "turn/started") {
      const ordinal = this.store.observeTurnStarted(identity, { id: params.turn.id, startedAt: params.turn.startedAt });
      void ordinal;
      const before = this.visibleRuntime(identity);
      this.runtime.reconcileNativeState(notification.endpointId, identity.threadId, "active", params.turn.id, notification.sequence);
      const changed = before.nativeStatus !== "active" || before.activeTurnId !== params.turn.id;
      if (changed) this.store.observeLifecycle(identity, notification.receivedAt);
      return changed;
    }
    if (notification.method === "thread/status/changed") {
      const nativeStatus = String(params.status.type);
      const activeTurn = nativeStatus === "active" ? this.runtime.activeTurn(notification.endpointId, identity.threadId) : undefined;
      const before = this.visibleRuntime(identity);
      this.runtime.reconcileNativeState(notification.endpointId, identity.threadId, nativeStatus, activeTurn, notification.sequence);
      const changed = before.nativeStatus !== nativeStatus || before.activeTurnId !== (activeTurn ?? null);
      if (changed) this.store.observeLifecycle(identity, notification.receivedAt);
      return changed;
    }
    if (notification.method === "thread/settings/updated") {
      return this.store.observeCurrentSettings(identity, {
        model: params.threadSettings.model,
        effort: params.threadSettings.effort,
        observedAt: notification.receivedAt,
      }, notification.sequence).valueChanged;
    }
    if (notification.method === "thread/tokenUsage/updated") {
      let ordinal = this.store.turnOrdinal(identity, params.turnId);
      if (ordinal === undefined) {
        const history = await this.options.readThread(notification.endpointId, identity.threadId);
        this.store.hydrateTurnOrder(identity, history.turns.map((turn) => ({ id: turn.id, startedAt: turn.startedAt })));
        ordinal = this.store.turnOrdinal(identity, params.turnId);
      }
      if (ordinal === undefined) throw new Error(`cannot order token usage for turn ${params.turnId}`);
      return this.store.observeTokenUsage(identity, params.turnId, normalizeTokenUsage(params.tokenUsage, notification.receivedAt), ordinal, notification.sequence);
    }
    if (notification.method === "thread/goal/updated") {
      const normalized = normalizeGoal(params.goal);
      const sourceTime = normalizeProtocolTime(params.goal.updatedAt, notification.receivedAt);
      return this.store.observeGoal(identity, normalized, sourceTime, notification.sequence, sourceTime);
    }
    if (notification.method === "thread/goal/cleared") {
      const current = await this.options.readGoal(notification.endpointId, identity.threadId) as any;
      const goal = current?.goal;
      if (goal) {
        const sourceTime = normalizeProtocolTime(goal.updatedAt, notification.receivedAt);
        return this.store.observeGoal(identity, normalizeGoal(goal), sourceTime, notification.sequence, sourceTime);
      }
      return this.store.observeGoal(identity, null, notification.receivedAt, notification.sequence, notification.receivedAt);
    }
    return false;
  }

  private managedIdentity(endpointId: string, threadId: string): DashboardIdentity | undefined {
    const session = Object.values(this.registry.snapshot().sessions).find((candidate) => candidate.endpoint === endpointId && candidate.thread_id === threadId);
    if (!session || this.runtime.getSession(endpointId, threadId)?.managementState !== "managed") return undefined;
    return { endpointId, threadId };
  }

  private visibleRuntime(identity: DashboardIdentity): { nativeStatus: string; activeTurnId: string | null } {
    return {
      nativeStatus: this.runtime.getSession(identity.endpointId, identity.threadId)?.nativeStatus ?? "notLoaded",
      activeTurnId: this.runtime.activeTurn(identity.endpointId, identity.threadId) ?? null,
    };
  }
}

function normalizeNotification(method: string, raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const params = raw as any;
  if (typeof params.threadId !== "string") return undefined;
  if (method === "turn/started") {
    if (!params.turn || typeof params.turn.id !== "string") return undefined;
    return { threadId: params.threadId, turn: { id: params.turn.id, startedAt: finiteOrNull(params.turn.startedAt) } };
  }
  if (method === "thread/status/changed") {
    if (!params.status || typeof params.status.type !== "string") return undefined;
    return { threadId: params.threadId, status: { type: params.status.type } };
  }
  if (method === "thread/settings/updated") {
    if (!params.threadSettings || typeof params.threadSettings.model !== "string") return undefined;
    const effort = params.threadSettings.effort;
    if (effort !== null && typeof effort !== "string") return undefined;
    return { threadId: params.threadId, threadSettings: { model: params.threadSettings.model, effort } };
  }
  if (method === "thread/tokenUsage/updated") {
    if (typeof params.turnId !== "string" || !params.tokenUsage) return undefined;
    return { threadId: params.threadId, turnId: params.turnId, tokenUsage: structuredClone(params.tokenUsage) };
  }
  if (method === "thread/goal/updated") {
    if (!params.goal || typeof params.goal.objective !== "string" || typeof params.goal.status !== "string") return undefined;
    return { threadId: params.threadId, turnId: typeof params.turnId === "string" ? params.turnId : null, goal: {
      objective: params.goal.objective,
      status: params.goal.status,
      tokenBudget: typeof params.goal.tokenBudget === "number" ? params.goal.tokenBudget : null,
      updatedAt: Number(params.goal.updatedAt),
    } };
  }
  if (method === "thread/goal/cleared") return { threadId: params.threadId };
  return undefined;
}

function normalizeGoal(value: any): DashboardGoal {
  return {
    objective: String(value.objective),
    status: String(value.status),
    token_budget: typeof value.tokenBudget === "number" ? value.tokenBudget : typeof value.token_budget === "number" ? value.token_budget : null,
  };
}

function normalizeProtocolTime(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.abs(value) < 1_000_000_000_000 ? value * 1_000 : value;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isTerminalStatus(status: unknown): boolean {
  return new Set(["completed", "failed", "interrupted"]).has(typeof status === "string" ? status : String((status as any)?.type ?? ""));
}
