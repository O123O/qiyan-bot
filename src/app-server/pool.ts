import { AppError } from "../core/errors.ts";

export interface AppServerEndpoint {
  readonly id: string;
  readonly state: "starting" | "ready" | "unavailable" | "stopped";
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
}

export interface TurnCapacityClaim {
  id: string;
  endpointId: string;
  threadId: string;
}

export interface ThreadHistory {
  status?: string | { type?: string };
  turns: Array<{
    id: string;
    status: string;
    itemsView?: "full" | "summary" | "notLoaded";
    items: Array<{ type: string; clientId?: string | null }>;
  }>;
}

interface TurnStartResponse { turn: { id: string } }
interface ClaimState extends TurnCapacityClaim {
  phase: "provisional" | "active";
  turnId?: string;
  selfOwned: boolean;
}

class StartProvenAbsentError extends Error {}

export class AppServerPool {
  private readonly endpoints = new Map<string, AppServerEndpoint>();
  private readonly claims = new Map<string, ClaimState>();
  private readonly terminalBeforeStart = new Set<string>();
  private readonly capacityListeners = new Set<() => void>();
  private capacitySignalPending = false;

  constructor(endpoints: readonly AppServerEndpoint[], private readonly options: { maxConcurrentTurns: number; reconciliationTimeoutMs?: number; reconciliationPollMs?: number; sleep?: (ms: number) => Promise<void> }) {
    for (const endpoint of endpoints) this.endpoints.set(endpoint.id, endpoint);
  }

  endpoint(id: string): AppServerEndpoint {
    const endpoint = this.endpoints.get(id);
    if (!endpoint || endpoint.state !== "ready") throw new AppError("ENDPOINT_UNAVAILABLE", `app-server endpoint is unavailable: ${id}`);
    return endpoint;
  }

  request<T>(endpointId: string, method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    return this.endpoint(endpointId).request<T>(method, params, signal);
  }

  claimTurnCapacity(endpointId: string, threadId: string, claimId: string): TurnCapacityClaim {
    return this.createClaim(endpointId, threadId, claimId, false);
  }

  restoreTurnCapacityClaim(endpointId: string, threadId: string, claimId: string, state: { phase: "provisional" | "active"; turnId?: string }): TurnCapacityClaim {
    const existing = this.claims.get(claimId);
    if (existing) {
      if (existing.endpointId !== endpointId || existing.threadId !== threadId) this.conflict(`capacity claim ${claimId} changed identity`);
      if (state.phase === "active" && state.turnId && existing.phase === "provisional") this.bindTurnCapacityClaim(existing, state.turnId);
      return this.publicClaim(existing);
    }
    const claim = this.createClaim(endpointId, threadId, claimId, false);
    if (state.phase === "active") {
      if (!state.turnId) this.conflict(`active capacity claim ${claimId} has no turn ID`);
      this.bindTurnCapacityClaim(claim, state.turnId);
    }
    return claim;
  }

  bindTurnCapacityClaim(claim: TurnCapacityClaim, turnId: string): void {
    const state = this.requiredClaim(claim);
    if (state.phase === "active") {
      if (state.turnId !== turnId) this.conflict(`capacity claim ${claim.id} is already bound to another turn`);
      return;
    }
    const terminalKey = this.turnKey(claim.endpointId, claim.threadId, turnId);
    if (this.terminalBeforeStart.delete(terminalKey)) {
      this.releaseClaimState(state);
      return;
    }
    state.phase = "active";
    state.turnId = turnId;
  }

  releaseTurnCapacityClaim(claim: TurnCapacityClaim): void {
    const state = this.claims.get(claim.id);
    if (!state) return;
    if (state.endpointId !== claim.endpointId || state.threadId !== claim.threadId) this.conflict(`capacity claim ${claim.id} changed identity`);
    this.releaseClaimState(state);
  }

  onCapacityAvailable(listener: () => void): () => void {
    this.capacityListeners.add(listener);
    return () => { this.capacityListeners.delete(listener); };
  }

  async startTurn<T extends TurnStartResponse = TurnStartResponse>(
    endpointId: string,
    params: { threadId: string; [key: string]: unknown },
    callerClaim?: TurnCapacityClaim,
  ): Promise<T> {
    const claim = callerClaim
      ? this.publicClaim(this.requiredClaim(callerClaim))
      : this.createClaim(endpointId, params.threadId, `implicit:${crypto.randomUUID()}`, true);
    if (claim.endpointId !== endpointId || claim.threadId !== params.threadId) this.conflict("turn start does not match its capacity claim");

    let response: T;
    try {
      try {
        response = await this.request<T>(endpointId, "turn/start", params);
      } catch (startError) {
        if (typeof params.clientUserMessageId !== "string") {
          this.releaseTurnCapacityClaim(claim);
          throw startError;
        }
        try {
          const actual = await this.findStartedTurn(endpointId, params.threadId, params.clientUserMessageId);
          response = { turn: actual } as unknown as T;
        } catch (reconciliationError) {
          if (reconciliationError instanceof StartProvenAbsentError) {
            this.releaseTurnCapacityClaim(claim);
            throw startError;
          }
          throw reconciliationError;
        }
      }

      if (typeof params.clientUserMessageId === "string") {
        try {
          response = { ...response, turn: await this.findStartedTurn(endpointId, params.threadId, params.clientUserMessageId, response.turn.id) } as T;
        } catch (error) {
          if (error instanceof StartProvenAbsentError) {
            this.releaseTurnCapacityClaim(claim);
            throw new AppError("OPERATION_CONFLICT", "turn/start response was not present in full thread history");
          }
          throw error;
        }
      }
      this.bindTurnCapacityClaim(claim, response.turn.id);
      return response;
    } catch (error) {
      if (!(error instanceof AppError && error.code === "OPERATION_UNCERTAIN") && !(error instanceof StartProvenAbsentError)) {
        const state = this.claims.get(claim.id);
        if (state?.phase === "provisional") this.releaseTurnCapacityClaim(claim);
      }
      throw error;
    }
  }

  async readFullThread(endpointId: string, threadId: string): Promise<ThreadHistory> {
    let response: { thread: ThreadHistory };
    try {
      response = await this.request(endpointId, "thread/read", { threadId, includeTurns: true });
    } catch (error) {
      throw new AppError("OPERATION_UNCERTAIN", `full thread history was unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.thread.turns.some((turn) => turn.itemsView !== "full")) {
      throw new AppError("OPERATION_UNCERTAIN", "thread history is not a full item view");
    }
    return response.thread;
  }

  async interrupt(endpointId: string, threadId: string, turnId: string): Promise<void> {
    let terminal = false;
    try {
      await this.request(endpointId, "turn/interrupt", { threadId, turnId });
      terminal = true;
    } catch (error) {
      try {
        const history = await this.request<{ thread: { turns: Array<{ id: string; status: string }> } }>(endpointId, "thread/read", { threadId, includeTurns: true });
        terminal = history.thread.turns.some((turn) => turn.id === turnId && new Set(["completed", "failed", "interrupted"]).has(turn.status));
      } catch { /* the original interrupt outcome remains uncertain */ }
      if (!terminal) throw error;
    } finally {
      if (terminal) this.markTurnTerminal(endpointId, threadId, turnId);
    }
  }

  markTurnTerminal(endpointId: string, threadId: string, turnId: string): void {
    const state = [...this.claims.values()].find((candidate) =>
      candidate.endpointId === endpointId && candidate.threadId === threadId
      && candidate.phase === "active" && candidate.turnId === turnId);
    if (state) {
      this.releaseClaimState(state);
      return;
    }
    const key = this.turnKey(endpointId, threadId, turnId);
    this.terminalBeforeStart.add(key);
    if (this.terminalBeforeStart.size > 1_000) this.terminalBeforeStart.delete(this.terminalBeforeStart.values().next().value!);
  }

  markEndpointUnavailable(endpointId: string): void {
    for (const state of [...this.claims.values()]) {
      if (state.endpointId === endpointId && state.selfOwned) this.releaseClaimState(state);
    }
    for (const key of this.terminalBeforeStart) if (key.startsWith(`${endpointId}:`)) this.terminalBeforeStart.delete(key);
  }

  get activeTurnCount(): number { return this.claims.size; }

  private createClaim(endpointId: string, threadId: string, claimId: string, selfOwned: boolean): TurnCapacityClaim {
    const existing = this.claims.get(claimId);
    if (existing) {
      if (existing.endpointId !== endpointId || existing.threadId !== threadId) this.conflict(`capacity claim ${claimId} changed identity`);
      return this.publicClaim(existing);
    }
    if (this.claims.size >= this.options.maxConcurrentTurns) {
      throw new AppError("CAPACITY_EXCEEDED", `at most ${this.options.maxConcurrentTurns} turns may run concurrently`);
    }
    const state: ClaimState = { id: claimId, endpointId, threadId, phase: "provisional", selfOwned };
    this.claims.set(claimId, state);
    return this.publicClaim(state);
  }

  private requiredClaim(claim: TurnCapacityClaim): ClaimState {
    const state = this.claims.get(claim.id);
    if (!state || state.endpointId !== claim.endpointId || state.threadId !== claim.threadId) this.conflict(`unknown capacity claim ${claim.id}`);
    return state;
  }

  private releaseClaimState(state: ClaimState): void {
    const wasFull = this.claims.size >= this.options.maxConcurrentTurns;
    if (!this.claims.delete(state.id)) return;
    if (wasFull && this.claims.size < this.options.maxConcurrentTurns) this.scheduleCapacitySignal();
  }

  private scheduleCapacitySignal(): void {
    if (this.capacitySignalPending) return;
    this.capacitySignalPending = true;
    queueMicrotask(() => {
      this.capacitySignalPending = false;
      for (const listener of this.capacityListeners) listener();
    });
  }

  private async findStartedTurn(endpointId: string, threadId: string, clientUserMessageId: string, candidateTurnId?: string): Promise<{ id: string; items: Array<{ type: string; clientId?: string | null }> }> {
    const deadline = Date.now() + (this.options.reconciliationTimeoutMs ?? 30_000);
    do {
      let history: { thread: ThreadHistory };
      try {
        history = await this.request(endpointId, "thread/read", { threadId, includeTurns: true });
      } catch (error) {
        throw new AppError("OPERATION_UNCERTAIN", `turn/start outcome could not be reconciled because thread history was unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      const actual = [...history.thread.turns].reverse().find((turn) =>
        turn.items.some((item) => item.type === "userMessage" && item.clientId === clientUserMessageId)
        || (candidateTurnId !== undefined && turn.id === candidateTurnId));
      if (actual) return actual;
      if (Date.now() >= deadline) {
        const threadStatus = typeof history.thread.status === "string" ? history.thread.status : history.thread.status?.type;
        if (threadStatus === "idle" && history.thread.turns.every((turn) => turn.itemsView === "full")) throw new StartProvenAbsentError();
        throw new AppError("OPERATION_UNCERTAIN", "turn/start outcome could not be proven because thread history was incomplete");
      }
      await (this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(this.options.reconciliationPollMs ?? 25);
    } while (true);
  }

  private publicClaim(state: ClaimState): TurnCapacityClaim {
    return { id: state.id, endpointId: state.endpointId, threadId: state.threadId };
  }

  private turnKey(endpointId: string, threadId: string, turnId: string): string {
    return `${endpointId}:${threadId}:${turnId}`;
  }

  private conflict(message: string): never {
    throw new AppError("OPERATION_CONFLICT", `OPERATION_CONFLICT: ${message}`);
  }
}
