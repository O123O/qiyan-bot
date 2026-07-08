import type { AppServerPool } from "../app-server/pool.ts";
import type { Clock } from "../core/clock.ts";
import type { SessionRegistry } from "../registry/session-registry.ts";
import type { FinalMessageStore } from "../sessions/final-messages.ts";
import type { Database } from "../storage/database.ts";
import type { DeliveryStore } from "../storage/delivery-store.ts";
import type { RuntimeStore } from "../storage/runtime-store.ts";
import type { AttachmentStore } from "../attachments/store.ts";
import type { ConversationBinding } from "../chat/binding.ts";
import type { EndpointWorkLease } from "../endpoints/types.ts";
import type { MappingIdentity } from "../registry/session-registry.ts";
import type { ThreadGate } from "../sessions/thread-gate.ts";
import type { OwnershipInspection } from "../sessions/rollout-ownership.ts";

interface TerminalTurn {
  id: string;
  status: string;
  startedAt?: number | null;
  completedAt: number | null;
  items: Array<{ type: string; id: string; text?: string; phase?: string | null }>;
}

interface TerminalOwnership {
  inspect(identity: MappingIdentity, lease?: EndpointWorkLease): Promise<OwnershipInspection>;
  ownsTurn(identity: MappingIdentity, turnId: string): boolean;
}

interface RelayTarget {
  endpointId: string;
  threadId: string;
  turnId: string;
  mappingId: string;
  epochId: string;
}

interface RelayTimer {
  handle: ReturnType<typeof setTimeout>;
  generation: number;
}

export interface RelayTimers {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const nodeRelayTimers: RelayTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export type RelayOutcome = "handled" | "conclusively_ignored" | "retry";

export interface TerminalObservation {
  endpointId: string;
  threadId: string;
  turnId: string;
  status: string;
  startedAt: number | null;
  completedAt: number;
  finalMessageId: string | null;
}

function relayTargetKey(target: RelayTarget): string {
  return [target.endpointId, target.threadId, target.turnId, target.mappingId, target.epochId].join("\0");
}

export class EventRelay {
  private readonly retryTargets = new Map<string, RelayTarget>();
  private readonly retryTimers = new Map<string, RelayTimer>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly endpointTails = new Map<string, Promise<void>>();
  private readonly endpointGenerations = new Map<string, number>();
  private readonly unavailableEndpoints = new Set<string>();
  private readonly scanPendingEndpoints = new Set<string>();
  private stopped = false;

  constructor(
    private readonly db: Database,
    private readonly pool: AppServerPool,
    private readonly registry: SessionRegistry,
    private readonly runtime: RuntimeStore,
    private readonly finals: FinalMessageStore,
    private readonly deliveries: DeliveryStore,
    private readonly options: {
      binding(): ConversationBinding;
      clock: Clock;
      onTerminal?(event: TerminalObservation, lease: EndpointWorkLease): void | Promise<void>;
      withEndpointWorkLease<T>(
        endpointId: string,
        existingLease: EndpointWorkLease | undefined,
        run: (lease: EndpointWorkLease) => Promise<T>,
      ): Promise<T>;
    },
    private readonly attachments: Pick<AttachmentStore, "releaseTurn"> | undefined,
    private readonly ownership: TerminalOwnership | undefined,
    private readonly gate: ThreadGate,
    private readonly timers: RelayTimers = nodeRelayTimers,
  ) {}

  async handleNotification(
    endpointId: string,
    method: string,
    params: any,
    lease?: EndpointWorkLease,
  ): Promise<RelayOutcome> {
    if (method !== "turn/completed" || this.stopped) return "conclusively_ignored";
    const threadId = String(params.threadId);
    const turnId = String(params.turn.id);
    const target = await this.gate.run(endpointId, threadId, async () => this.captureTarget(endpointId, threadId, turnId));
    if (!target || this.stopped) return "conclusively_ignored";
    this.retryTargets.set(relayTargetKey(target), target);
    return this.enqueueEndpoint(endpointId, async () => {
      if (this.stopped) return "conclusively_ignored";
      const generation = this.endpointGeneration(endpointId);
      const outcome = this.unavailableEndpoints.has(endpointId)
        ? "retry"
        : await this.classifyOne(target, lease, generation);
      return this.settleTarget(target, outcome, generation);
    });
  }

  async handlePermissionBlocked(
    endpointId: string,
    event: { threadId?: string; turnId?: string; method: string; params: unknown },
  ): Promise<void> {
    if (!event.threadId) return;
    const mapping = this.mapping(endpointId, event.threadId);
    const state = mapping ? this.runtime.getSession(endpointId, event.threadId, mapping.session.mapping_id) : undefined;
    if (!mapping || mapping.session.lifecycle_state !== "managed" || state?.managementState !== "managed") return;
    const nickname = mapping.nickname;
    const key = `permission:${endpointId}:${event.threadId}:${event.turnId ?? "unknown"}:${event.method}`;
    this.deliveries.prepare({
      id: key,
      kind: "permission",
      binding: this.options.binding(),
      body: `[${nickname}] blocked by a permission request`,
      mandatory: true,
    });
    this.persistEvent(key, endpointId, event.threadId, event.turnId, "permission_blocked", {
      nickname,
      turnId: event.turnId ?? null,
      method: event.method,
    });
    this.runtime.setSession(endpointId, event.threadId, mapping.session.mapping_id, "managed", "permissionBlocked");
  }

  reconcileEndpoint(endpointId: string, lease?: EndpointWorkLease): Promise<void> {
    return this.endpointReady(endpointId, lease);
  }

  endpointUnavailable(endpointId: string): void {
    if (this.stopped) return;
    this.unavailableEndpoints.add(endpointId);
    this.advanceEndpointGeneration(endpointId);
    this.clearRetryTimer(endpointId);
  }

  async endpointReady(endpointId: string, lease?: EndpointWorkLease): Promise<void> {
    if (this.stopped) return;
    this.unavailableEndpoints.delete(endpointId);
    const generation = this.advanceEndpointGeneration(endpointId);
    this.clearRetryTimer(endpointId);
    this.scanPendingEndpoints.add(endpointId);
    await this.enqueueEndpoint(endpointId, async () => {
      if (!this.runIsCurrent(endpointId, generation)) return;
      try {
        await this.options.withEndpointWorkLease(endpointId, lease, async (activeLease) => {
          const complete = await this.reconcileHistory(endpointId, activeLease, generation);
          if (complete && this.runIsCurrent(endpointId, generation)) this.scanPendingEndpoints.delete(endpointId);
          for (const target of this.targetsForEndpoint(endpointId)) {
            if (!this.runIsCurrent(endpointId, generation)) return;
            if (!this.retryTargets.has(relayTargetKey(target))) continue;
            const outcome = await this.gate.run(endpointId, target.threadId, () => this.projectTarget(
              target,
              activeLease,
              generation,
            ));
            this.settleTarget(target, outcome, generation, false);
          }
        });
      } catch (error) {
        this.scheduleRetry(endpointId);
        throw error;
      }
      this.scheduleRetry(endpointId);
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      await Promise.allSettled([...this.endpointTails.values()]);
      return;
    }
    this.stopped = true;
    for (const endpointId of this.retryTimers.keys()) this.clearRetryTimer(endpointId);
    this.retryTargets.clear();
    this.scanPendingEndpoints.clear();
    this.retryAttempts.clear();
    await Promise.allSettled([...this.endpointTails.values()]);
  }

  private captureTarget(endpointId: string, threadId: string, turnId: string): RelayTarget | undefined {
    const mapping = this.mapping(endpointId, threadId);
    if (!mapping || mapping.session.lifecycle_state !== "managed") return undefined;
    const epoch = this.runtime.currentEpoch(endpointId, threadId, mapping.session.mapping_id);
    if (!epoch) return undefined;
    return {
      endpointId,
      threadId,
      turnId,
      mappingId: mapping.session.mapping_id,
      epochId: epoch.id,
    };
  }

  private async classifyOne(
    target: RelayTarget,
    lease: EndpointWorkLease | undefined,
    generation: number,
  ): Promise<RelayOutcome> {
    try {
      return await this.options.withEndpointWorkLease(target.endpointId, lease, (activeLease) => this.gate.run(
        target.endpointId,
        target.threadId,
        () => this.projectTarget(target, activeLease, generation),
      ));
    } catch {
      return "retry";
    }
  }

  private async projectTarget(
    target: RelayTarget,
    lease: EndpointWorkLease,
    generation: number,
  ): Promise<RelayOutcome> {
    if (!this.runIsCurrent(target.endpointId, generation)) return "retry";
    const stateBefore = this.targetState(target);
    if (stateBefore !== "deliverable") return stateBefore === "stale" ? "conclusively_ignored" : "retry";
    const mappingBefore = this.mapping(target.endpointId, target.threadId)!;
    const firstOwnership = await this.inspectOwnership(mappingBefore.session, lease);
    if (!this.runIsCurrent(target.endpointId, generation)) return "retry";
    if (firstOwnership.state === "unclassified") return "retry";

    const history = await this.pool.request<{ thread: { turns: TerminalTurn[] } }>(
      target.endpointId,
      "thread/read",
      { threadId: target.threadId, includeTurns: true },
      undefined,
      lease,
    );
    if (!this.runIsCurrent(target.endpointId, generation)) return "retry";

    const current = this.mapping(target.endpointId, target.threadId);
    if (!current || current.session.mapping_id !== target.mappingId) return "conclusively_ignored";
    const secondOwnership = await this.inspectOwnership(current.session, lease);
    if (!this.runIsCurrent(target.endpointId, generation)) return "retry";
    if (secondOwnership.state === "unclassified") return "retry";

    const stateAfter = this.targetState(target);
    if (stateAfter !== "deliverable") return stateAfter === "stale" ? "conclusively_ignored" : "retry";
    const turns = history.thread.turns;
    const turnIndex = turns.findIndex((candidate) => candidate.id === target.turnId);
    if (turnIndex < 0) return "retry";
    const epoch = this.runtime.currentEpoch(target.endpointId, target.threadId, target.mappingId)!;
    if (epoch.baselineTurnId) {
      const baselineIndex = turns.findIndex((candidate) => candidate.id === epoch.baselineTurnId);
      if (baselineIndex < 0) return "retry";
      if (turnIndex <= baselineIndex) return "conclusively_ignored";
    }
    const turn = turns[turnIndex]!;
    if (!this.isTerminal(turn.status)) return "retry";
    if (this.ownership && !this.ownership.ownsTurn(current.session, turn.id)) return "conclusively_ignored";
    if (!this.runIsCurrent(target.endpointId, generation)) return "retry";
    return this.commitTerminal(target, turn, lease);
  }

  private async reconcileHistory(endpointId: string, lease: EndpointWorkLease, generation: number): Promise<boolean> {
    let complete = true;
    for (const session of Object.values(this.registry.managedSnapshot().sessions)) {
      if (session.endpoint !== endpointId) continue;
      if (!this.runIsCurrent(endpointId, generation)) return false;
      const sessionComplete = await this.gate.run(endpointId, session.thread_id, async () => {
        const mapping = this.mapping(endpointId, session.thread_id);
        const state = mapping ? this.runtime.getSession(endpointId, session.thread_id, mapping.session.mapping_id) : undefined;
        const epoch = mapping ? this.runtime.currentEpoch(endpointId, session.thread_id, mapping.session.mapping_id) : undefined;
        if (!mapping) return true;
        if (mapping.session.mapping_id !== session.mapping_id) return false;
        if (mapping.session.lifecycle_state !== "managed"
          || !state || !this.isDeliverableState(state.managementState) || !epoch) return true;
        const targetGeneration = { mappingId: session.mapping_id, epochId: epoch.id };
        const before = await this.inspectOwnership(session, lease);
        if (!this.runIsCurrent(endpointId, generation) || before.state === "unclassified") return false;
        const response = await this.pool.request<{ thread: { turns: TerminalTurn[] } }>(
          endpointId,
          "thread/read",
          { threadId: session.thread_id, includeTurns: true },
          undefined,
          lease,
        );
        if (!this.runIsCurrent(endpointId, generation)) return false;
        const current = this.mapping(endpointId, session.thread_id);
        if (!current) return true;
        if (current.session.mapping_id !== session.mapping_id) return false;
        const after = await this.inspectOwnership(current.session, lease);
        if (!this.runIsCurrent(endpointId, generation) || after.state === "unclassified"
          || !this.isDeliverableGeneration(endpointId, session.thread_id, targetGeneration)) return false;
        const turns = response.thread.turns;
        let index = epoch.baselineTurnId ? turns.findIndex((turn) => turn.id === epoch.baselineTurnId) + 1 : 0;
        if (epoch.baselineTurnId && index === 0) return false;
        if (state.deliveryCursor) {
          const cursorIndex = turns.findIndex((turn) => turn.id === state.deliveryCursor);
          if (cursorIndex >= 0) index = Math.max(index, cursorIndex + 1);
        }
        for (const turn of turns.slice(index)) {
          if (!this.isTerminal(turn.status)) break;
          if (this.ownership && !this.ownership.ownsTurn(current.session, turn.id)) {
            if (!this.runIsCurrent(endpointId, generation)) return false;
            this.runtime.setDeliveryCursor(endpointId, session.thread_id, session.mapping_id, turn.id);
            if (!this.runIsCurrent(endpointId, generation)) return false;
            this.retryTargets.delete(relayTargetKey({
              endpointId,
              threadId: session.thread_id,
              turnId: turn.id,
              mappingId: session.mapping_id,
              epochId: epoch.id,
            }));
            continue;
          }
          if (!this.runIsCurrent(endpointId, generation)) return false;
          const target: RelayTarget = {
            endpointId,
            threadId: session.thread_id,
            turnId: turn.id,
            mappingId: session.mapping_id,
            epochId: epoch.id,
          };
          this.retryTargets.set(relayTargetKey(target), target);
          const outcome = await this.commitTerminal(target, turn, lease);
          if (!this.runIsCurrent(endpointId, generation)) return false;
          if (outcome !== "handled") return false;
          this.retryTargets.delete(relayTargetKey(target));
          if (!this.runIsCurrent(endpointId, generation)) return false;
          this.runtime.setDeliveryCursor(endpointId, session.thread_id, session.mapping_id, turn.id);
        }
        return true;
      });
      if (!sessionComplete) complete = false;
    }
    return complete;
  }

  private async commitTerminal(target: RelayTarget, turn: TerminalTurn, lease: EndpointWorkLease): Promise<RelayOutcome> {
    if (this.targetState(target) !== "deliverable") return "conclusively_ignored";
    const mapping = this.mapping(target.endpointId, target.threadId)!;
    const nickname = mapping.nickname;
    this.runtime.clearActiveTurn(target.endpointId, target.threadId, target.mappingId, turn.id);
    this.pool.markTurnTerminal(target.endpointId, target.threadId, turn.id);
    const messages = this.finals.persistTerminalTurn(target.endpointId, target.threadId, turn, this.options.clock.now());
    const eventId = `terminal:${target.endpointId}:${target.threadId}:${turn.id}`;
    this.persistEvent(eventId, target.endpointId, target.threadId, turn.id, "turn_terminal", {
      final: true,
      nickname,
      endpointId: target.endpointId,
      threadId: target.threadId,
      turnId: turn.id,
      completedAt: turn.completedAt ?? this.options.clock.now(),
      status: turn.status,
      finalMessageIds: messages.map((message) => message.id),
      deliveryState: "prepared",
    });
    await this.options.onTerminal?.({
      endpointId: target.endpointId,
      threadId: target.threadId,
      turnId: turn.id,
      status: turn.status,
      startedAt: turn.startedAt ?? null,
      completedAt: turn.completedAt ?? this.options.clock.now(),
      finalMessageId: messages.at(-1)?.id ?? null,
    }, lease);
    if (messages.length === 0 && turn.status !== "completed") {
      this.deliveries.prepare({
        id: `${eventId}:warning`,
        kind: "worker_warning",
        binding: this.options.binding(),
        body: `[${nickname}] turn ${turn.id} ${turn.status} without a final response`,
        mandatory: true,
      });
    }
    for (const message of messages) {
      const status = turn.status === "completed" ? "" : ` · ${turn.status}`;
      this.deliveries.prepare({
        id: `worker:${target.endpointId}:${target.threadId}:${message.turnId}:${message.itemId}`,
        kind: "worker_final",
        binding: this.options.binding(),
        body: `[${nickname}${status}] ${message.body}`,
        mandatory: true,
      });
    }
    this.attachments?.releaseTurn(target.endpointId, target.threadId, turn.id);
    return "handled";
  }

  private targetState(target: RelayTarget): "deliverable" | "retry" | "stale" {
    const mapping = this.mapping(target.endpointId, target.threadId);
    if (!mapping || mapping.session.mapping_id !== target.mappingId || mapping.session.lifecycle_state !== "managed") return "stale";
    const epoch = this.runtime.currentEpoch(target.endpointId, target.threadId, target.mappingId);
    if (!epoch || epoch.id !== target.epochId) return "stale";
    const state = this.runtime.getSession(target.endpointId, target.threadId, target.mappingId);
    return this.isDeliverableState(state?.managementState) ? "deliverable" : "retry";
  }

  private isDeliverableGeneration(
    endpointId: string,
    threadId: string,
    expected: { mappingId: string; epochId: string },
  ): boolean {
    const current = this.mapping(endpointId, threadId);
    const state = current ? this.runtime.getSession(endpointId, threadId, current.session.mapping_id) : undefined;
    const epoch = current ? this.runtime.currentEpoch(endpointId, threadId, current.session.mapping_id) : undefined;
    return current?.session.mapping_id === expected.mappingId
      && current.session.lifecycle_state === "managed"
      && this.isDeliverableState(state?.managementState)
      && epoch?.id === expected.epochId;
  }

  private isDeliverableState(state: string | undefined): boolean {
    return state === "managed" || state === "unadopting";
  }

  private isTerminal(status: string): boolean {
    return status === "completed" || status === "failed" || status === "interrupted";
  }

  private inspectOwnership(identity: MappingIdentity, lease: EndpointWorkLease): Promise<OwnershipInspection> {
    return this.ownership?.inspect(identity, lease) ?? Promise.resolve({ state: "owned" });
  }

  private settleTarget(
    target: RelayTarget,
    outcome: RelayOutcome,
    generation: number,
    schedule = true,
  ): RelayOutcome {
    const effective = this.runIsCurrent(target.endpointId, generation) ? outcome : "retry";
    if (!this.stopped) {
      if (effective === "retry") this.retryTargets.set(relayTargetKey(target), target);
      else this.retryTargets.delete(relayTargetKey(target));
      if (!this.hasPendingWork(target.endpointId)) {
        this.clearRetryTimer(target.endpointId);
        this.retryAttempts.delete(target.endpointId);
      } else if (schedule) this.scheduleRetry(target.endpointId);
    }
    return effective;
  }

  private scheduleRetry(endpointId: string): void {
    if (this.stopped || this.unavailableEndpoints.has(endpointId) || this.retryTimers.has(endpointId)) return;
    if (!this.hasPendingWork(endpointId)) {
      this.retryAttempts.delete(endpointId);
      return;
    }
    const attempt = this.retryAttempts.get(endpointId) ?? 0;
    const delay = Math.min(1_000 * 2 ** attempt, 30_000);
    const generation = this.endpointGeneration(endpointId);
    let handle: ReturnType<typeof setTimeout>;
    handle = this.timers.setTimeout(() => {
      const current = this.retryTimers.get(endpointId);
      if (!current || current.handle !== handle || current.generation !== generation
        || !this.runIsCurrent(endpointId, generation)) return;
      this.retryTimers.delete(endpointId);
      void this.enqueueEndpoint(endpointId, () => this.retryEndpoint(endpointId, generation)).catch(() => undefined);
    }, delay);
    handle.unref?.();
    this.retryTimers.set(endpointId, { handle, generation });
    this.retryAttempts.set(endpointId, attempt + 1);
  }

  private async retryEndpoint(endpointId: string, generation: number): Promise<void> {
    if (!this.runIsCurrent(endpointId, generation)) return;
    try {
      await this.options.withEndpointWorkLease(endpointId, undefined, async (lease) => {
        if (this.scanPendingEndpoints.has(endpointId)) {
          const complete = await this.reconcileHistory(endpointId, lease, generation);
          if (complete && this.runIsCurrent(endpointId, generation)) this.scanPendingEndpoints.delete(endpointId);
        }
        for (const target of this.targetsForEndpoint(endpointId)) {
          if (!this.runIsCurrent(endpointId, generation)) return;
          const outcome = await this.gate.run(endpointId, target.threadId, () => this.projectTarget(
            target,
            lease,
            generation,
          ));
          this.settleTarget(target, outcome, generation, false);
        }
      });
    } catch { /* Exact targets and the scan marker remain pending. */ }
    this.scheduleRetry(endpointId);
  }

  private clearRetryTimer(endpointId: string): void {
    const timer = this.retryTimers.get(endpointId);
    if (!timer) return;
    this.timers.clearTimeout(timer.handle);
    this.retryTimers.delete(endpointId);
  }

  private targetsForEndpoint(endpointId: string): RelayTarget[] {
    return [...this.retryTargets.values()].filter((target) => target.endpointId === endpointId);
  }

  private hasPendingWork(endpointId: string): boolean {
    return this.scanPendingEndpoints.has(endpointId) || this.targetsForEndpoint(endpointId).length > 0;
  }

  private endpointGeneration(endpointId: string): number {
    return this.endpointGenerations.get(endpointId) ?? 0;
  }

  private advanceEndpointGeneration(endpointId: string): number {
    const generation = this.endpointGeneration(endpointId) + 1;
    this.endpointGenerations.set(endpointId, generation);
    this.retryAttempts.delete(endpointId);
    return generation;
  }

  private runIsCurrent(endpointId: string, generation: number): boolean {
    return !this.stopped && !this.unavailableEndpoints.has(endpointId) && this.endpointGeneration(endpointId) === generation;
  }

  private enqueueEndpoint<T>(endpointId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.endpointTails.get(endpointId) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(action);
    let tail: Promise<void>;
    tail = running.then(() => undefined, () => undefined).finally(() => {
      if (this.endpointTails.get(endpointId) === tail) this.endpointTails.delete(endpointId);
    });
    this.endpointTails.set(endpointId, tail);
    return running;
  }

  private persistEvent(
    id: string,
    endpointId: string,
    threadId: string,
    turnId: string | undefined,
    kind: string,
    payload: unknown,
  ): void {
    this.db.prepare(`INSERT OR IGNORE INTO events(id, endpoint_id, thread_id, turn_id, kind, payload_json, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(id, endpointId, threadId, turnId ?? null, kind, JSON.stringify(payload), this.options.clock.now());
  }

  private mapping(endpointId: string, threadId: string) {
    return this.registry.getByIdentity(endpointId, threadId);
  }
}
