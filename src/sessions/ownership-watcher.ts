import { AppError } from "../core/errors.ts";
import type { EndpointWorkLease } from "../endpoints/types.ts";
import type { MappingIdentity, SessionRegistry } from "../registry/session-registry.ts";
import type { LifecycleCheckpoint } from "./lifecycle.ts";
import type { OwnershipInspection } from "./rollout-ownership.ts";

interface OwnershipInspector {
  inspect(identity: MappingIdentity, lease?: EndpointWorkLease): Promise<OwnershipInspection>;
}

interface SessionUnadopter {
  unadopt(
    nickname: string,
    checkpoint?: (value: LifecycleCheckpoint) => void,
    existingLease?: EndpointWorkLease,
  ): Promise<void>;
}

interface OwnershipGate {
  run<T>(endpointId: string, threadId: string, operation: () => Promise<T>): Promise<T>;
}

export interface ExternalTurnIncident extends MappingIdentity {
  nickname: string;
  turnId: string;
}

export type ExternalOwnershipReleaseStatus = "pending" | "completed";

export function externalOwnershipEventPayload(
  incident: ExternalTurnIncident,
  releaseStatus: ExternalOwnershipReleaseStatus,
): {
  event: "external_worker_turn_detected" | "external_worker_session_released";
  releaseStatus: ExternalOwnershipReleaseStatus;
  nickname: string;
  mappingId: string;
  turnId: string;
} {
  return {
    event: releaseStatus === "pending" ? "external_worker_turn_detected" : "external_worker_session_released",
    releaseStatus,
    nickname: incident.nickname,
    mappingId: incident.mapping_id,
    turnId: incident.turnId,
  };
}

export class SessionOwnershipWatcher {
  constructor(
    private readonly registry: SessionRegistry,
    private readonly ownership: OwnershipInspector,
    private readonly lifecycle: SessionUnadopter,
    private readonly options: {
      onExternal(incident: ExternalTurnIncident): void | Promise<void>;
      onReleased(incident: ExternalTurnIncident): void | Promise<void>;
      isInspectable?(identity: MappingIdentity): boolean;
    },
    private readonly gate?: OwnershipGate,
  ) {}

  async reconcileEndpoint(endpointId: string, lease?: EndpointWorkLease): Promise<void> {
    await this.release(await this.detectEndpoint(endpointId, lease), lease);
  }

  async detectEndpoint(
    endpointId: string,
    lease?: EndpointWorkLease,
    isCurrent: () => boolean = () => true,
  ): Promise<ExternalTurnIncident[]> {
    const incidents: ExternalTurnIncident[] = [];
    const sessions = Object.entries(this.registry.snapshot().sessions)
      .filter(([, session]) => session.endpoint === endpointId && session.lifecycle_state === "managed");
    for (const [nickname, session] of sessions) {
      if (!isCurrent()) return incidents;
      if (this.options.isInspectable && !this.options.isInspectable(session)) continue;
      const inspect = async (): Promise<OwnershipInspection> => {
        if (!isCurrent()) throw new AppError("ENDPOINT_UNAVAILABLE", "ownership inspection generation changed");
        const result = await this.ownership.inspect(session, lease);
        if (!isCurrent()) throw new AppError("ENDPOINT_UNAVAILABLE", "ownership inspection generation changed");
        return result;
      };
      const result = this.gate
        ? await this.gate.run(session.endpoint, session.thread_id, inspect)
        : await inspect();
      if (!isCurrent()) return incidents;
      if (result.state !== "external") continue;
      const incident = {
        nickname,
        endpoint: session.endpoint,
        thread_id: session.thread_id,
        mapping_id: session.mapping_id,
        turnId: result.turnId,
      };
      incidents.push(incident);
      if (!isCurrent()) return incidents;
      await this.options.onExternal(incident);
      if (!isCurrent()) return incidents;
    }
    return incidents;
  }

  async release(
    incidents: readonly ExternalTurnIncident[],
    lease?: EndpointWorkLease,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const seen = new Set<string>();
    for (const incident of incidents) {
      if (!isCurrent()) return;
      const key = `${incident.endpoint}\0${incident.thread_id}\0${incident.mapping_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const current = this.registry.get(incident.nickname);
      if (!current || current.endpoint !== incident.endpoint || current.thread_id !== incident.thread_id
        || current.mapping_id !== incident.mapping_id || current.lifecycle_state !== "managed") continue;
      try {
        if (!isCurrent()) return;
        await this.lifecycle.unadopt(incident.nickname, undefined, lease);
        if (!isCurrent()) return;
        await this.options.onReleased(incident);
        if (!isCurrent()) return;
      } catch (error) {
        if (error instanceof AppError && error.code === "SESSION_BUSY") continue;
        throw error;
      }
    }
  }
}

export type ExternalOwnershipOutcome = "succeeded" | "failed" | "inconclusive";

export interface ExternalOwnershipEndpointResult {
  endpointId: string;
  outcome: ExternalOwnershipOutcome;
}

export interface ExternalOwnershipCandidateFailure {
  component: "candidate_enumeration";
  outcome: "failed";
}

export type ExternalOwnershipCycleResult = ExternalOwnershipEndpointResult | ExternalOwnershipCandidateFailure;

export interface ExternalOwnershipMonitorOptions {
  endpointIds(): readonly string[];
  pending(endpointId: string): readonly ExternalTurnIncident[];
  withReadyEndpointWorkLease<T>(
    endpointId: string,
    run: (lease: EndpointWorkLease) => Promise<T>,
  ): Promise<T>;
  resumeRemoval(incident: ExternalTurnIncident, lease: EndpointWorkLease): Promise<void>;
  inspectAndRelease(endpointId: string, lease: EndpointWorkLease): Promise<void>;
  onCycle(results: readonly ExternalOwnershipCycleResult[]): void;
}

export interface OwnershipMonitorTimers {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const nodeOwnershipMonitorTimers: OwnershipMonitorTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export class ExternalOwnershipMonitor {
  private stopped = true;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private starting: Promise<void> | undefined;

  constructor(
    private readonly options: ExternalOwnershipMonitorOptions,
    private readonly timers: OwnershipMonitorTimers = nodeOwnershipMonitorTimers,
    private readonly intervalMs = 60_000,
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) {
      await this.starting;
      return;
    }
    this.stopped = false;
    this.generation += 1;
    const generation = this.generation;
    const draining = this.running;
    let starting: Promise<void>;
    starting = (async () => {
      await draining;
      if (this.stopped || generation !== this.generation) return;
      this.schedule(generation);
    })().finally(() => {
      if (this.starting === starting) this.starting = undefined;
    });
    this.starting = starting;
    await starting;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    await this.starting;
    await this.running;
  }

  private schedule(generation: number): void {
    if (this.stopped || generation !== this.generation || this.timer !== undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    timer = this.timers.setTimeout(() => {
      if (this.stopped || generation !== this.generation || timer === undefined || this.timer !== timer) return;
      this.timer = undefined;
      this.run(generation);
    }, this.intervalMs);
    timer.unref?.();
    this.timer = timer;
  }

  private run(generation: number): void {
    if (this.stopped || generation !== this.generation || this.running) return;
    let running: Promise<void>;
    running = this.runCycle().catch(() => undefined).finally(() => {
      if (this.running === running) this.running = undefined;
      if (!this.stopped && generation === this.generation) this.schedule(generation);
    });
    this.running = running;
  }

  private async runCycle(): Promise<void> {
    let endpointIds: string[];
    try { endpointIds = [...new Set(this.options.endpointIds())]; }
    catch {
      this.publishCycle([{ component: "candidate_enumeration", outcome: "failed" }]);
      return;
    }
    const results = await Promise.all(endpointIds.map((endpointId) => this.runEndpoint(endpointId)));
    this.publishCycle(results);
  }

  private publishCycle(results: readonly ExternalOwnershipCycleResult[]): void {
    try { this.options.onCycle(results); }
    catch { /* Operational reporting must not stop the ownership clock. */ }
  }

  private async runEndpoint(endpointId: string): Promise<ExternalOwnershipEndpointResult> {
    let admitted = false;
    try {
      await this.options.withReadyEndpointWorkLease(endpointId, async (lease) => {
        admitted = true;
        for (const incident of this.options.pending(endpointId)) {
          await this.options.resumeRemoval(incident, lease);
        }
        await this.options.inspectAndRelease(endpointId, lease);
      });
      return { endpointId, outcome: "succeeded" };
    } catch (error) {
      return {
        endpointId,
        outcome: !admitted && error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE" ? "inconclusive" : "failed",
      };
    }
  }
}
