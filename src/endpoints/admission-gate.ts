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

  // Abandon every live lease. A forced lifecycle action uses this so that work in flight cannot
  // park it: a lease on a dead channel would otherwise hold `beginDrain` open forever, and because
  // lifecycle actions serialize, every later one queues behind it.
  //
  // What this does and does not do, precisely. A discarded lease can no longer be used for further
  // work — `validate` fails for it, and `release` becomes a safe no-op when the orphaned work
  // finally unwinds. It does NOT cancel work already running: that RPC will still return, and its
  // result is simply not waited for and not relied upon. That is the same position a lost
  // connection leaves us in, which is the honest comparison; claiming the result is "ignored"
  // would be claiming a guarantee this does not provide.
  discardLiveWork(): number {
    const discarded = this.live.size;
    this.live.clear();
    this.resolveDrainIfReady();
    return discarded;
  }

  // `discardLive` discards in the SAME synchronous step that closes the gate. Doing the two as
  // separate statements is only race-free while they are adjacent, and on the forced paths they
  // were not: an `await` between them (preparing a replacement over SSH takes hundreds of
  // milliseconds) reopens the gate long enough for reconnect, recovery or status work to take a
  // fresh lease -- on the same dead channel -- and the drain then parks on that instead. Taking the
  // flag here makes the two inseparable rather than relying on every call site keeping them
  // together.
  beginDrain(options?: { discardLive?: boolean }): Promise<EndpointDrainHandle> {
    if (this.drainPromise) return this.drainPromise;
    if (this.state === "disconnected") throw new AppError("ENDPOINT_UNAVAILABLE", `endpoint is disconnected: ${this.endpointId}`);
    if (options?.discardLive) this.live.clear();
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
