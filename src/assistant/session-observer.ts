import type { RegistryDocument } from "../registry/session-registry.ts";
import type { RuntimeStore } from "../storage/runtime-store.ts";
import { SessionDashboardStore, type DashboardIdentity, type DashboardNotification } from "../storage/session-dashboard-store.ts";
import { normalizeTokenUsage, toIsoTimestamp, type DashboardGoal } from "./dashboard-schema.ts";
import type { TerminalObservation } from "../events/relay.ts";
import { ZodError } from "zod";
import type { EndpointWorkLease } from "../endpoints/types.ts";

interface RegistryView { snapshot(): RegistryDocument }
interface ObserverOptions {
  now(): number;
  readThread(endpointId: string, threadId: string, lease?: EndpointWorkLease): Promise<{
    turns: Array<{ id: string; startedAt: number | null; status?: unknown }>;
  }>;
  readGoal(endpointId: string, threadId: string): Promise<unknown>;
  onChanged(): void;
  onError(error: unknown): void;
  onIdleTurn?(event: { endpointId: string; threadId: string; turnId: string }): Promise<void>;
  onGoalTurnStarted?(event: { endpointId: string; threadId: string; mappingId: string; turnId: string }): void;
  classifyFailure?(error: unknown): "retry" | "endpoint" | "sleep";
  retryMs?: number;
  timers?: ObservationTimers;
}

interface ObservationTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: any): void;
}

const nodeObservationTimers: ObservationTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

const supportedMethods = new Set([
  "turn/started",
  "thread/status/changed",
  "thread/settings/updated",
  "thread/tokenUsage/updated",
  "thread/goal/updated",
  "thread/goal/cleared",
]);
const goalStatuses = new Set(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);

export class SessionObservationProcessor {
  private tails = new Map<string, Promise<void>>();
  private retryTimers = new Map<string, { handle: unknown; generation: number; epoch: number }>();
  private retryGenerations = new Map<string, number>();
  private endpointEpochs = new Map<string, number>();
  private unavailableEndpoints = new Set<string>();
  private stopped = false;

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
    if (method === "thread/goal/updated" && normalized.turnId !== null) {
      const target = this.observationTarget(endpointId, String(normalized.threadId));
      if (target.kind !== "discarded" && this.runtime.goalControlled(endpointId, target.identity.threadId, target.mappingId)) {
        normalized.goalControlMappingId = target.mappingId;
      }
    }
    this.store.acceptNotification(endpointId, method, normalized, this.options.now());
    if (method === "thread/goal/updated" && typeof normalized.goalControlMappingId === "string") {
      try {
        this.options.onGoalTurnStarted?.({
          endpointId,
          threadId: String(normalized.threadId),
          mappingId: normalized.goalControlMappingId,
          turnId: String(normalized.turnId),
        });
      } catch { /* Durable replay retries authorization after the ownership guard is ready. */ }
    }
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
    while (this.tails.size > 0) await Promise.all([...this.tails.values()]);
  }

  endpointUnavailable(endpointId: string): void {
    if (this.stopped) return;
    this.advanceEndpointEpoch(endpointId);
    this.unavailableEndpoints.add(endpointId);
    this.clearRetry(endpointId);
  }

  async endpointReady(endpointId: string): Promise<void> {
    if (this.stopped) return;
    this.advanceEndpointEpoch(endpointId);
    this.unavailableEndpoints.delete(endpointId);
    this.clearRetry(endpointId);
    await this.enqueue(endpointId, this.endpointEpoch(endpointId));
  }

  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      for (const endpointId of [...this.retryTimers.keys()]) this.clearRetry(endpointId);
    }
    await this.idle();
  }

  observeResume(
    endpointId: string,
    threadId: string,
    response: any,
    observedAt: number,
    sequences: { settings?: number; native?: number } = {},
  ): void {
    const target = this.managedTarget(endpointId, threadId);
    if (!target) return;
    const { identity, mappingId } = target;
    const sharedSequence = sequences.settings === undefined || sequences.native === undefined
      ? this.store.allocateObservationSequence()
      : undefined;
    const settingsSequence = sequences.settings ?? sharedSequence!;
    const nativeSequence = sequences.native ?? sharedSequence!;
    const turns = Array.isArray(response?.thread?.turns) ? response.thread.turns : [];
    this.store.hydrateTurnOrder(identity, turns.map((turn: any) => ({ id: String(turn.id), startedAt: finiteOrNull(turn.startedAt) })));
    const nativeStatus = String(response?.thread?.status?.type ?? "notLoaded");
    const activeTurn = nativeStatus === "active"
      ? [...turns].reverse().find((turn: any) => !isTerminalStatus(turn.status))?.id ?? this.runtime.activeTurn(endpointId, threadId, mappingId)
      : undefined;
    const before = this.visibleRuntime(identity, mappingId);
    const nativeApplied = this.runtime.reconcileNativeState(endpointId, threadId, mappingId, nativeStatus, activeTurn, nativeSequence);
    const visibleChanged = nativeApplied && (before.nativeStatus !== nativeStatus || before.activeTurnId !== (activeTurn ?? null));
    if (visibleChanged) this.store.observeLifecycle(identity, observedAt);
    const settings = this.store.observeCurrentSettings(identity, {
      ...(typeof response?.model === "string" ? { model: response.model } : {}),
      ...(typeof response?.reasoningEffort === "string" || response?.reasoningEffort === null ? { effort: response.reasoningEffort } : {}),
      observedAt,
    }, settingsSequence);
    if (visibleChanged || settings.valueChanged) this.options.onChanged();
  }

  async observeTerminal(event: TerminalObservation, lease?: EndpointWorkLease): Promise<void> {
    const target = this.managedTarget(event.endpointId, event.threadId);
    if (!target) return;
    const { identity, mappingId } = target;
    let ordinal = this.store.turnOrdinal(identity, event.turnId);
    if (ordinal === undefined) {
      const history = await this.options.readThread(event.endpointId, event.threadId, lease);
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
    const active = this.runtime.activeTurn(event.endpointId, event.threadId, mappingId);
    if (active === undefined || active === event.turnId) {
      const sequence = this.store.allocateObservationSequence();
      const before = this.visibleRuntime(identity, mappingId);
      this.runtime.reconcileNativeState(event.endpointId, event.threadId, mappingId, "idle", undefined, sequence);
      lifecycleChanged = before.nativeStatus !== "idle" || before.activeTurnId !== null;
      if (lifecycleChanged) this.store.observeLifecycle(identity, completedAt);
    }
    if (workerChanged || lifecycleChanged) this.options.onChanged();
  }

  private enqueue(endpointId: string, epoch = this.endpointEpoch(endpointId)): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const previous = this.tails.get(endpointId) ?? Promise.resolve();
    const run = previous.then(() => this.processPending(endpointId, epoch), () => this.processPending(endpointId, epoch));
    const contained = run.then((current) => {
      if (current) this.clearRetry(endpointId, epoch);
    }, (error) => {
      if (!this.runIsCurrent(endpointId, epoch)) return;
      try { this.options.onError(error); }
      catch { /* operational reporting must not change retry ownership */ }
      let disposition: "retry" | "endpoint" | "sleep" = "sleep";
      try { disposition = this.options.classifyFailure?.(error) ?? "sleep"; }
      catch { /* a classifier failure must leave durable work asleep */ }
      if (disposition === "retry") this.scheduleRetry(endpointId, epoch);
    });
    this.tails.set(endpointId, contained);
    void contained.finally(() => { if (this.tails.get(endpointId) === contained) this.tails.delete(endpointId); });
    return contained;
  }

  private scheduleRetry(endpointId: string, epoch: number): void {
    if (!this.runIsCurrent(endpointId, epoch) || this.retryTimers.has(endpointId)) return;
    const generation = (this.retryGenerations.get(endpointId) ?? 0) + 1;
    this.retryGenerations.set(endpointId, generation);
    const timers = this.options.timers ?? nodeObservationTimers;
    const handle = timers.setTimeout(() => {
      const current = this.retryTimers.get(endpointId);
      if (!this.runIsCurrent(endpointId, epoch) || current?.generation !== generation || current.epoch !== epoch) return;
      this.retryTimers.delete(endpointId);
      void this.enqueue(endpointId, epoch);
    }, this.options.retryMs ?? 1_000);
    this.retryTimers.set(endpointId, { handle, generation, epoch });
    (handle as { unref?: () => void } | undefined)?.unref?.();
  }

  private clearRetry(endpointId: string, expectedEpoch?: number): void {
    const timer = this.retryTimers.get(endpointId);
    if (expectedEpoch !== undefined && timer?.epoch !== expectedEpoch) return;
    this.retryGenerations.set(endpointId, (this.retryGenerations.get(endpointId) ?? 0) + 1);
    if (timer) (this.options.timers ?? nodeObservationTimers).clearTimeout(timer.handle);
    this.retryTimers.delete(endpointId);
  }

  private async processPending(endpointId: string, epoch: number): Promise<boolean> {
    if (!this.runIsCurrent(endpointId, epoch)) return false;
    for (const notification of this.store.pendingNotifications(endpointId)) {
      if (!this.runIsCurrent(endpointId, epoch)) return false;
      let result: boolean | "deferred" | "stale";
      try {
        result = await this.process(notification, epoch);
      } catch (error) {
        if (!(error instanceof ZodError)) throw error;
        if (!this.runIsCurrent(endpointId, epoch)) return false;
        const safeError = { message: `invalid ${notification.method} notification` };
        this.store.failNotification(notification.sequence, safeError);
        this.options.onError(new Error(safeError.message));
        continue;
      }
      if (result === "stale" || !this.runIsCurrent(endpointId, epoch)) return false;
      if (result === "deferred") continue;
      this.store.completeNotification(notification.sequence);
      if (result && this.runIsCurrent(endpointId, epoch)) this.options.onChanged();
    }
    return this.runIsCurrent(endpointId, epoch);
  }

  private async process(notification: DashboardNotification, epoch: number): Promise<boolean | "deferred" | "stale"> {
    if (!this.runIsCurrent(notification.endpointId, epoch)) return "stale";
    const params = notification.params as any;
    const target = this.observationTarget(notification.endpointId, String(params.threadId));
    if (target.kind === "deferred") return "deferred";
    if (target.kind === "discarded") return false;
    const identity = target.identity;
    const mappingId = target.mappingId;
    if (notification.method === "turn/started") {
      const ordinal = this.store.observeTurnStarted(identity, { id: params.turn.id, startedAt: params.turn.startedAt });
      void ordinal;
      const before = this.visibleRuntime(identity, mappingId);
      this.runtime.reconcileNativeState(notification.endpointId, identity.threadId, mappingId, "active", params.turn.id, notification.sequence);
      const changed = before.nativeStatus !== "active" || before.activeTurnId !== params.turn.id;
      if (changed) this.store.observeLifecycle(identity, notification.receivedAt);
      return changed;
    }
    if (notification.method === "thread/status/changed") {
      const nativeStatus = String(params.status.type);
      const completedTurnId = nativeStatus === "idle"
        ? this.runtime.activeTurn(notification.endpointId, identity.threadId, mappingId)
        : undefined;
      if (completedTurnId) {
        await this.options.onIdleTurn?.({
          endpointId: notification.endpointId,
          threadId: identity.threadId,
          turnId: completedTurnId,
        });
        if (!this.runIsCurrent(notification.endpointId, epoch)) return "stale";
      }
      const activeTurn = nativeStatus === "active" ? this.runtime.activeTurn(notification.endpointId, identity.threadId, mappingId) : undefined;
      const before = this.visibleRuntime(identity, mappingId);
      this.runtime.reconcileNativeState(notification.endpointId, identity.threadId, mappingId, nativeStatus, activeTurn, notification.sequence);
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
      const tokenUsage = normalizeTokenUsage(params.tokenUsage, notification.receivedAt);
      let ordinal = this.store.turnOrdinal(identity, params.turnId);
      if (ordinal === undefined) {
        const history = await this.options.readThread(notification.endpointId, identity.threadId);
        if (!this.runIsCurrent(notification.endpointId, epoch)) return "stale";
        this.store.hydrateTurnOrder(identity, history.turns.map((turn) => ({ id: turn.id, startedAt: turn.startedAt })));
        ordinal = this.store.turnOrdinal(identity, params.turnId);
      }
      if (ordinal === undefined) return "deferred";
      return this.store.observeTokenUsage(identity, params.turnId, tokenUsage, ordinal, notification.sequence);
    }
    if (notification.method === "thread/goal/updated") {
      if (params.goalControlMappingId === mappingId && typeof params.turnId === "string") {
        this.options.onGoalTurnStarted?.({
          endpointId: notification.endpointId,
          threadId: identity.threadId,
          mappingId,
          turnId: params.turnId,
        });
        if (!this.runIsCurrent(notification.endpointId, epoch)) return "stale";
      }
      const normalized = normalizeGoal(params.goal);
      const sourceTime = normalizeProtocolTime(params.goal.updatedAt, notification.receivedAt);
      const changed = this.store.observeGoal(identity, normalized, sourceTime, notification.sequence, sourceTime);
      if (normalized.status !== "active") {
        this.runtime.clearGoalControlledBefore(notification.endpointId, identity.threadId, mappingId, notification.sequence);
      }
      return changed;
    }
    if (notification.method === "thread/goal/cleared") {
      const current = await this.options.readGoal(notification.endpointId, identity.threadId) as any;
      if (!this.runIsCurrent(notification.endpointId, epoch)) return "stale";
      const goal = current?.goal;
      if (goal) {
        const normalized = normalizeGoal(goal);
        const sourceTime = normalizeProtocolTime(goal.updatedAt, notification.receivedAt);
        const changed = this.store.observeGoal(identity, normalized, sourceTime, notification.sequence, sourceTime);
        if (normalized.status !== "active") {
          this.runtime.clearGoalControlledBefore(notification.endpointId, identity.threadId, mappingId, notification.sequence);
        }
        return changed;
      }
      const changed = this.store.observeGoal(identity, null, notification.receivedAt, notification.sequence, notification.receivedAt);
      this.runtime.clearGoalControlledBefore(notification.endpointId, identity.threadId, mappingId, notification.sequence);
      return changed;
    }
    return false;
  }

  private endpointEpoch(endpointId: string): number { return this.endpointEpochs.get(endpointId) ?? 0; }
  private advanceEndpointEpoch(endpointId: string): void { this.endpointEpochs.set(endpointId, this.endpointEpoch(endpointId) + 1); }
  private runIsCurrent(endpointId: string, epoch: number): boolean {
    return !this.stopped && !this.unavailableEndpoints.has(endpointId) && this.endpointEpoch(endpointId) === epoch;
  }

  private managedTarget(endpointId: string, threadId: string): { identity: DashboardIdentity; mappingId: string } | undefined {
    const target = this.observationTarget(endpointId, threadId);
    return target.kind === "managed" ? { identity: target.identity, mappingId: target.mappingId } : undefined;
  }

  private observationTarget(endpointId: string, threadId: string):
    | { kind: "managed"; identity: DashboardIdentity; mappingId: string }
    | { kind: "deferred"; identity: DashboardIdentity; mappingId: string }
    | { kind: "discarded" } {
    const session = Object.values(this.registry.snapshot().sessions).find((candidate) => candidate.endpoint === endpointId && candidate.thread_id === threadId);
    if (!session) return { kind: "discarded" };
    const state = this.runtime.getSession(endpointId, threadId, session.mapping_id);
    if (session.lifecycle_state === "managed" && state?.managementState === "managed") return { kind: "managed", identity: { endpointId, threadId }, mappingId: session.mapping_id };
    if (session.lifecycle_state === "managed" && state?.managementState === "unavailable" && state.restoreState === "managed") {
      return { kind: "deferred", identity: { endpointId, threadId }, mappingId: session.mapping_id };
    }
    return { kind: "discarded" };
  }

  private visibleRuntime(identity: DashboardIdentity, mappingId: string): { nativeStatus: string; activeTurnId: string | null } {
    return {
      nativeStatus: this.runtime.getSession(identity.endpointId, identity.threadId, mappingId)?.nativeStatus ?? "notLoaded",
      activeTurnId: this.runtime.activeTurn(identity.endpointId, identity.threadId, mappingId) ?? null,
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
    if (!params.goal || typeof params.goal.objective !== "string" || typeof params.goal.status !== "string"
      || !goalStatuses.has(params.goal.status)) return undefined;
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
  const status = String(value.status);
  if (!goalStatuses.has(status)) throw new Error("invalid goal status");
  return {
    objective: String(value.objective),
    status,
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
