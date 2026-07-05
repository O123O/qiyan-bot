import { AppError } from "../core/errors.ts";
import type { EndpointWorkLease } from "./types.ts";

export type EndpointDesiredState = "automatic" | "draining" | "disconnected";

export interface EndpointDrainHandle {
  reopen(): void;
  disconnect(): void;
}

export class EndpointAdmissionGate {
  private state: EndpointDesiredState = "automatic";
  private lifecycleGeneration = 1;
  private readonly live = new Map<string, EndpointWorkLease>();
  private drainPromise?: Promise<EndpointDrainHandle>;
  private drainResolve?: (handle: EndpointDrainHandle) => void;

  constructor(private readonly endpointId: string) {}

  get desiredState(): EndpointDesiredState { return this.state; }

  acquire(endpointGeneration: number): EndpointWorkLease {
    if (this.state !== "automatic") throw new AppError("ENDPOINT_UNAVAILABLE", `endpoint is ${this.state}: ${this.endpointId}`);
    const lease: EndpointWorkLease = {
      endpointId: this.endpointId,
      lifecycleGeneration: this.lifecycleGeneration,
      endpointGeneration,
      leaseId: crypto.randomUUID(),
    };
    this.live.set(lease.leaseId, lease);
    return lease;
  }

  validate(lease: EndpointWorkLease, endpointGeneration: number): boolean {
    const actual = this.live.get(lease.leaseId);
    return actual !== undefined
      && actual.endpointId === this.endpointId
      && actual.lifecycleGeneration === lease.lifecycleGeneration
      && actual.endpointGeneration === endpointGeneration
      && actual.endpointGeneration === lease.endpointGeneration;
  }

  release(lease: EndpointWorkLease): void {
    if (!this.validate(lease, lease.endpointGeneration)) return;
    this.live.delete(lease.leaseId);
    this.resolveDrainIfReady();
  }

  beginDrain(): Promise<EndpointDrainHandle> {
    if (this.drainPromise) return this.drainPromise;
    if (this.state === "disconnected") throw new AppError("ENDPOINT_UNAVAILABLE", `endpoint is disconnected: ${this.endpointId}`);
    this.state = "draining";
    this.drainPromise = new Promise((resolve) => { this.drainResolve = resolve; });
    this.resolveDrainIfReady();
    return this.drainPromise;
  }

  requestAutomatic(): void {
    if (this.state === "automatic") return;
    if (this.state === "draining") throw new AppError("ENDPOINT_UNAVAILABLE", `endpoint is draining: ${this.endpointId}`);
    this.lifecycleGeneration += 1;
    this.state = "automatic";
  }

  private resolveDrainIfReady(): void {
    if (this.state !== "draining" || this.live.size !== 0 || !this.drainResolve) return;
    const generation = this.lifecycleGeneration;
    const settle = (state: "automatic" | "disconnected") => {
      if (this.state !== "draining" || this.lifecycleGeneration !== generation) return;
      this.lifecycleGeneration += 1;
      this.state = state;
      delete this.drainPromise;
      delete this.drainResolve;
    };
    const resolve = this.drainResolve;
    delete this.drainResolve;
    resolve({ reopen: () => settle("automatic"), disconnect: () => settle("disconnected") });
  }
}
