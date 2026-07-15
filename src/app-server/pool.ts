import { AppError } from "../core/errors.ts";
import type { EndpointLossKind, EndpointWorkLease, ManagedAppServerEndpoint } from "../endpoints/types.ts";

export interface AppServerEndpoint {
  readonly id: string;
  readonly state: "starting" | "ready" | "unavailable" | "stopped";
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
}

export interface TurnCapacityClaim {
  id: string;
  endpointId: string;
  threadId: string;
  generation: number;
}

export class TurnIdentityConflictError extends AppError {
  constructor(readonly returnedTurnId: string, readonly expectedTurnId?: string) {
    super("OPERATION_CONFLICT", "turn/start response identity conflicts with the caller-owned claim", {
      returnedTurnId,
      ...(expectedTurnId ? { expectedTurnId } : {}),
    });
    this.name = "TurnIdentityConflictError";
  }
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
  origin: "caller" | "implicit" | "cold-active" | "cold-provisional";
  clientUserMessageId?: string;
}

interface TerminalClaim extends TurnCapacityClaim { turnId: string }
type WorkLeaseProvider = <T>(endpointId: string, existing: EndpointWorkLease | undefined, run: (lease: EndpointWorkLease | undefined) => Promise<T>) => Promise<T>;

class StartProvenAbsentError extends Error {}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

export class AppServerPool {
  private readonly endpoints = new Map<string, AppServerEndpoint>();
  private readonly endpointGenerations = new Map<string, number>();
  private readonly endpointUnavailableSubscriptions = new Map<string, () => void>();
  private readonly claims = new Map<string, ClaimState>();
  private readonly terminalBeforeStart = new Set<string>();
  private readonly terminalClaims = new Map<string, TerminalClaim>();
  private readonly capacityListeners = new Set<() => void>();
  private readonly endpointStarts = new Map<string, Promise<AppServerEndpoint>>();
  private readonly resolvedProvisional = new Set<string>();
  private capacitySignalPending = false;
  private nextClaimGeneration = 1;
  private workLeaseProvider?: WorkLeaseProvider;

  constructor(endpoints: readonly AppServerEndpoint[], private readonly options: { maxConcurrentTurns: number; reconciliationTimeoutMs?: number; reconciliationPollMs?: number; sleep?: (ms: number) => Promise<void>; resolveEndpoint?: (id: string) => Promise<ManagedAppServerEndpoint>; workLeaseProvider?: WorkLeaseProvider }) {
    if (options.workLeaseProvider) this.workLeaseProvider = options.workLeaseProvider;
    for (const endpoint of endpoints) this.publishEndpoint(endpoint);
  }

  endpoint(id: string): AppServerEndpoint {
    const endpoint = this.endpoints.get(id);
    if (!endpoint || endpoint.state !== "ready") throw new AppError("ENDPOINT_UNAVAILABLE", `app-server endpoint is unavailable: ${id}`);
    return endpoint;
  }

  endpointGeneration(id: string): { endpoint: AppServerEndpoint; generation: number } {
    const endpoint = this.endpoints.get(id);
    const generation = this.endpointGenerations.get(id);
    if (!endpoint || generation === undefined) throw new AppError("ENDPOINT_UNAVAILABLE", `app-server endpoint is unavailable: ${id}`);
    return { endpoint, generation };
  }

  replaceEndpoint(endpoint: AppServerEndpoint): number {
    this.endpointStarts.delete(endpoint.id);
    return this.publishEndpoint(endpoint);
  }

  setWorkLeaseProvider(provider: WorkLeaseProvider): void { this.workLeaseProvider = provider; }

  // Non-activating readiness check: true iff the endpoint is already ready. Triggers NO start/activation
  // — lets a passive reader (e.g. the web UI transcript) skip an endpoint that would otherwise be spun
  // up on demand (a down remote ssh worker must not be dialed just because a tab was opened).
  isReady(endpointId: string): boolean {
    return this.endpoints.get(endpointId)?.state === "ready";
  }

  private async ensureEndpoint(id: string): Promise<AppServerEndpoint> {
    const existing = this.endpoints.get(id);
    if (existing?.state === "ready") return existing;
    const pending = this.endpointStarts.get(id);
    if (pending) return pending;
    if (!this.options.resolveEndpoint) throw new AppError("ENDPOINT_UNAVAILABLE", `app-server endpoint is unavailable: ${id}`);
    const initialGeneration = this.endpointGenerations.get(id) ?? 0;
    let start!: Promise<AppServerEndpoint>;
    start = (async () => {
      const endpoint = existing ?? await this.options.resolveEndpoint!(id);
      if (endpoint.id !== id) throw new AppError("OPERATION_CONFLICT", "resolved endpoint identity changed");
      if (!("start" in endpoint) || typeof endpoint.start !== "function") throw new AppError("ENDPOINT_UNAVAILABLE", `app-server endpoint cannot be started: ${id}`);
      await endpoint.start();
      if (endpoint.state !== "ready") throw new AppError("ENDPOINT_UNAVAILABLE", `app-server endpoint is unavailable: ${id}`);
      const currentGeneration = this.endpointGenerations.get(id) ?? 0;
      const currentEndpoint = this.endpoints.get(id);
      const unchanged = existing
        ? currentGeneration === initialGeneration && currentEndpoint === existing
        : currentGeneration === initialGeneration && currentEndpoint === undefined;
      if (!unchanged) {
        if ("closeConnection" in endpoint && typeof endpoint.closeConnection === "function") {
          await endpoint.closeConnection().catch(() => undefined);
        }
        throw new AppError("ENDPOINT_UNAVAILABLE", `app-server endpoint generation changed while starting: ${id}`);
      }
      if (!existing) this.publishEndpoint(endpoint);
      return endpoint;
    })().finally(() => {
      if (this.endpointStarts.get(id) === start) this.endpointStarts.delete(id);
    });
    this.endpointStarts.set(id, start);
    return start;
  }

  request<T>(endpointId: string, method: string, params: unknown, signal?: AbortSignal, lease?: EndpointWorkLease): Promise<T> {
    return this.withWorkLease(endpointId, lease, () => this.requestAdmitted<T>(
      endpointId, method, params, signal, lease === undefined,
    ));
  }

  private requestAdmitted<T>(
    endpointId: string,
    method: string,
    params: unknown,
    signal: AbortSignal | undefined,
    allowActivation: boolean,
  ): Promise<T> {
    const existing = this.endpoints.get(endpointId);
    if (existing?.state === "ready") return existing.request<T>(method, params, signal);
    if (!allowActivation) {
      return Promise.reject(new AppError("ENDPOINT_UNAVAILABLE", `leased app-server endpoint is unavailable: ${endpointId}`));
    }
    return this.ensureEndpoint(endpointId).then((endpoint) => endpoint.request<T>(method, params, signal));
  }

  claimTurnCapacity(endpointId: string, threadId: string, claimId: string): TurnCapacityClaim {
    return this.createClaim(endpointId, threadId, claimId, "caller");
  }

  restoreTurnCapacityClaim(endpointId: string, threadId: string, claimId: string, state: { phase: "provisional" | "active"; turnId?: string }): TurnCapacityClaim {
    if (state.phase === "active" && !state.turnId) this.conflict(`active capacity claim ${claimId} has no turn ID`);
    const existing = this.claims.get(claimId);
    if (existing) {
      if (existing.endpointId !== endpointId || existing.threadId !== threadId) this.conflict(`capacity claim ${claimId} changed identity`);
      if (state.phase === "active") {
        if (existing.phase === "active" && existing.turnId !== state.turnId) this.conflict(`active capacity claim ${claimId} changed turn`);
        if (existing.phase === "provisional") this.bindTurnCapacityClaim(existing, state.turnId!);
      }
      return this.publicClaim(existing);
    }
    const terminal = this.terminalClaims.get(claimId);
    if (terminal) {
      if (terminal.endpointId !== endpointId || terminal.threadId !== threadId) this.conflict(`terminal capacity claim ${claimId} changed identity`);
      if (state.phase === "active" && state.turnId !== terminal.turnId) this.conflict(`terminal capacity claim ${claimId} changed turn`);
      return this.publicClaim(terminal);
    }
    const claim = this.createClaim(endpointId, threadId, claimId, "caller");
    if (state.phase === "active") {
      this.bindTurnCapacityClaim(claim, state.turnId!);
    }
    return claim;
  }

  bindTurnCapacityClaim(claim: TurnCapacityClaim, turnId: string): void {
    const state = this.claims.get(claim.id);
    if (!state || state.endpointId !== claim.endpointId || state.threadId !== claim.threadId || state.generation !== claim.generation) {
      const terminal = this.terminalClaims.get(claim.id);
      if (terminal?.endpointId === claim.endpointId && terminal.threadId === claim.threadId
        && terminal.generation === claim.generation && terminal.turnId === turnId) return;
      this.conflict(`unknown capacity claim ${claim.id}`);
    }
    if (state.phase === "active") {
      if (state.turnId !== turnId) this.conflict(`capacity claim ${claim.id} is already bound to another turn`);
      return;
    }
    const terminalKey = this.turnKey(claim.endpointId, claim.threadId, turnId);
    if (this.terminalBeforeStart.delete(terminalKey)) {
      this.recordTerminalClaim(state, turnId);
      this.releaseClaimState(state);
      return;
    }
    state.phase = "active";
    state.turnId = turnId;
  }

  releaseTurnCapacityClaim(claim: TurnCapacityClaim): void {
    const state = this.claims.get(claim.id);
    if (!state) return;
    if (state.endpointId !== claim.endpointId || state.threadId !== claim.threadId || state.generation !== claim.generation) {
      this.conflict(`capacity claim ${claim.id} changed identity`);
    }
    this.releaseClaimState(state);
  }

  onCapacityAvailable(listener: () => void): () => void {
    this.capacityListeners.add(listener);
    return () => { this.capacityListeners.delete(listener); };
  }

  restoreObservedActiveTurn(endpointId: string, threadId: string, turnId: string): TurnCapacityClaim {
    const existing = [...this.claims.values()].find((state) => state.endpointId === endpointId && state.threadId === threadId && state.phase === "active" && state.turnId === turnId);
    if (existing) return this.publicClaim(existing);
    const terminal = [...this.terminalClaims.values()].find((state) => state.endpointId === endpointId && state.threadId === threadId && state.turnId === turnId);
    if (terminal) return this.publicClaim(terminal);
    const claim = this.createClaim(endpointId, threadId, `observed:${endpointId}:${threadId}:${turnId}`, "cold-active", true);
    this.bindTurnCapacityClaim(claim, turnId);
    return claim;
  }

  restoreProvisionalTurnCapacity(endpointId: string, threadId: string, claimId: string, clientUserMessageId: string): TurnCapacityClaim | undefined {
    if (this.resolvedProvisional.has(claimId)) return undefined;
    const existing = this.claims.get(claimId);
    if (existing?.clientUserMessageId !== undefined && existing.clientUserMessageId !== clientUserMessageId) {
      this.conflict(`capacity claim ${claimId} changed message correlation`);
    }
    const claim = this.createClaim(endpointId, threadId, claimId, "cold-provisional", true);
    const state = this.claims.get(claim.id);
    if (state && state.clientUserMessageId === undefined) state.clientUserMessageId = clientUserMessageId;
    return claim;
  }

  hasClaims(endpointId: string): boolean {
    return [...this.claims.values()].some((state) => state.endpointId === endpointId);
  }

  async reconcileEndpointClaims(
    endpointId: string,
    lease?: EndpointWorkLease,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const byThread = new Map<string, ClaimState[]>();
    for (const state of this.claims.values()) {
      if (state.endpointId !== endpointId) continue;
      const values = byThread.get(state.threadId) ?? [];
      values.push(state);
      byThread.set(state.threadId, values);
    }
    for (const [threadId, states] of byThread) {
      if (!isCurrent()) return;
      let history: ThreadHistory;
      try { history = await this.readFullThread(endpointId, threadId, lease); }
      catch { if (!isCurrent()) return; continue; }
      if (!isCurrent()) return;
      const threadStatus = typeof history.status === "string" ? history.status : history.status?.type;
      const fullyIdle = threadStatus === "idle" && history.turns.every((turn) => turn.itemsView === "full");
      for (const state of states) {
        if (!isCurrent()) return;
        if (!this.claims.has(state.id)) continue;
        if (state.phase === "active" && state.turnId) {
          const turn = history.turns.find((candidate) => candidate.id === state.turnId);
          if (turn && isTerminal(turn.status)) this.markTurnTerminal(endpointId, threadId, state.turnId);
          else if (!turn && fullyIdle) this.releaseClaimState(state);
          if (!isCurrent()) return;
          continue;
        }
        const turn = state.clientUserMessageId === undefined ? undefined : history.turns.find((candidate) =>
          candidate.items.some((item) => item.type === "userMessage" && item.clientId === state.clientUserMessageId));
        if (!turn) {
          if (fullyIdle) { this.resolved(state.id); this.releaseClaimState(state); }
          if (!isCurrent()) return;
          continue;
        }
        if (isTerminal(turn.status)) {
          this.resolved(state.id);
          this.recordTerminalClaim(state, turn.id);
          this.releaseClaimState(state);
          if (!isCurrent()) return;
          continue;
        }
        const duplicate = [...this.claims.values()].find((candidate) => candidate.id !== state.id
          && candidate.endpointId === endpointId && candidate.threadId === threadId
          && candidate.phase === "active" && candidate.turnId === turn.id);
        if (duplicate) {
          this.resolved(state.id);
          this.releaseClaimState(state);
        } else {
          this.resolved(state.id);
          this.bindTurnCapacityClaim(state, turn.id);
        }
        if (!isCurrent()) return;
      }
    }
  }

  async startTurn<T extends TurnStartResponse = TurnStartResponse>(
    endpointId: string,
    params: { threadId: string; [key: string]: unknown },
    callerClaim?: TurnCapacityClaim,
    lease?: EndpointWorkLease,
  ): Promise<T> {
    return this.withWorkLease(endpointId, lease, (admitted) => this.startTurnAdmitted<T>(endpointId, params, callerClaim, admitted));
  }

  private async startTurnAdmitted<T extends TurnStartResponse>(
    endpointId: string,
    params: { threadId: string; [key: string]: unknown },
    callerClaim: TurnCapacityClaim | undefined,
    lease: EndpointWorkLease | undefined,
  ): Promise<T> {
    const claim = callerClaim
      ? this.publicClaim(this.requiredClaim(callerClaim))
      : this.createClaim(endpointId, params.threadId, `implicit:${crypto.randomUUID()}`, "implicit");
    if (claim.endpointId !== endpointId || claim.threadId !== params.threadId) this.conflict("turn start does not match its capacity claim");

    let response: T;
    const callerSuppliedCorrelation = typeof params.clientUserMessageId === "string";
    const clientUserMessageId = callerSuppliedCorrelation ? params.clientUserMessageId as string : crypto.randomUUID();
    const startParams = callerSuppliedCorrelation ? params : { ...params, clientUserMessageId };
    try {
      try {
        const state = this.claims.get(claim.id);
        if (state) state.clientUserMessageId = clientUserMessageId;
        response = await this.request<T>(endpointId, "turn/start", startParams, undefined, lease);
      } catch (startError) {
        if (callerClaim) {
          throw new AppError("OPERATION_UNCERTAIN", "caller-owned turn/start outcome is uncertain");
        }
        try {
          const actual = await this.findStartedTurn(endpointId, params.threadId, clientUserMessageId, lease);
          response = { turn: actual } as unknown as T;
        } catch (reconciliationError) {
          if (reconciliationError instanceof StartProvenAbsentError) {
            this.releaseTurnCapacityClaim(claim);
            throw startError;
          }
          throw reconciliationError;
        }
      }
      try {
        this.bindTurnCapacityClaim(claim, response.turn.id);
      } catch (error) {
        if (!callerClaim || !(error instanceof AppError) || error.code !== "OPERATION_CONFLICT") throw error;
        const expected = this.claims.get(claim.id)?.turnId ?? this.terminalClaims.get(claim.id)?.turnId;
        throw new TurnIdentityConflictError(response.turn.id, expected);
      }
      return response;
    } catch (error) {
      if (!(error instanceof AppError && error.code === "OPERATION_UNCERTAIN") && !(error instanceof StartProvenAbsentError)) {
        const state = this.claims.get(claim.id);
        if (state?.phase === "provisional") this.releaseTurnCapacityClaim(claim);
      }
      throw error;
    }
  }

  async readFullThread(endpointId: string, threadId: string, lease?: EndpointWorkLease): Promise<ThreadHistory> {
    return this.withWorkLease(endpointId, lease, (admitted) => this.readFullThreadAdmitted(endpointId, threadId, admitted));
  }

  private async readFullThreadAdmitted(endpointId: string, threadId: string, lease: EndpointWorkLease | undefined): Promise<ThreadHistory> {
    let response: { thread: ThreadHistory };
    try {
      response = await this.request(endpointId, "thread/read", { threadId, includeTurns: true }, undefined, lease);
    } catch (error) {
      throw new AppError("OPERATION_UNCERTAIN", `full thread history was unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.thread.turns.some((turn) => turn.itemsView !== "full")) {
      throw new AppError("OPERATION_UNCERTAIN", "thread history is not a full item view");
    }
    return response.thread;
  }

  async interrupt(endpointId: string, threadId: string, turnId: string, lease?: EndpointWorkLease): Promise<void> {
    return this.withWorkLease(endpointId, lease, (admitted) => this.interruptAdmitted(endpointId, threadId, turnId, admitted));
  }

  private async interruptAdmitted(endpointId: string, threadId: string, turnId: string, lease: EndpointWorkLease | undefined): Promise<void> {
    let terminal = false;
    try {
      await this.request(endpointId, "turn/interrupt", { threadId, turnId }, undefined, lease);
      terminal = true;
    } catch (error) {
      try {
        const history = await this.request<{ thread: { turns: Array<{ id: string; status: string }> } }>(endpointId, "thread/read", { threadId, includeTurns: true }, undefined, lease);
        terminal = history.thread.turns.some((turn) => turn.id === turnId && new Set(["completed", "failed", "interrupted"]).has(turn.status));
      } catch { /* the original interrupt outcome remains uncertain */ }
      if (!terminal) throw error;
    } finally {
      if (terminal) this.markTurnTerminal(endpointId, threadId, turnId);
    }
  }

  markTurnTerminal(endpointId: string, threadId: string, turnId: string): void {
    const states = [...this.claims.values()].filter((candidate) =>
      candidate.endpointId === endpointId && candidate.threadId === threadId
      && candidate.phase === "active" && candidate.turnId === turnId);
    if (states.length > 0) {
      for (const state of states) {
        this.recordTerminalClaim(state, turnId);
        this.releaseClaimState(state);
      }
      return;
    }
    const key = this.turnKey(endpointId, threadId, turnId);
    this.terminalBeforeStart.add(key);
    if (this.terminalBeforeStart.size > 1_000) this.terminalBeforeStart.delete(this.terminalBeforeStart.values().next().value!);
  }

  markEndpointUnavailable(endpointId: string, kind: EndpointLossKind = "runtime-lost"): void {
    if (kind === "connection-lost") return;
    for (const state of [...this.claims.values()]) {
      if (state.endpointId === endpointId && state.origin !== "caller") this.releaseClaimState(state);
    }
    for (const key of this.terminalBeforeStart) if (key.startsWith(`${endpointId}:`)) this.terminalBeforeStart.delete(key);
  }

  get activeTurnCount(): number { return this.claims.size; }

  private resolved(claimId: string): void {
    this.resolvedProvisional.add(claimId);
    if (this.resolvedProvisional.size > 1_000) this.resolvedProvisional.delete(this.resolvedProvisional.values().next().value!);
  }

  private createClaim(endpointId: string, threadId: string, claimId: string, origin: ClaimState["origin"], bypassLimit = false): TurnCapacityClaim {
    const existing = this.claims.get(claimId);
    if (existing) {
      if (existing.endpointId !== endpointId || existing.threadId !== threadId) this.conflict(`capacity claim ${claimId} changed identity`);
      return this.publicClaim(existing);
    }
    if (!bypassLimit && this.claims.size >= this.options.maxConcurrentTurns) {
      throw new AppError("CAPACITY_EXCEEDED", `at most ${this.options.maxConcurrentTurns} turns may run concurrently`);
    }
    const state: ClaimState = { id: claimId, endpointId, threadId, generation: this.nextClaimGeneration++, phase: "provisional", origin };
    this.claims.set(claimId, state);
    return this.publicClaim(state);
  }

  private requiredClaim(claim: TurnCapacityClaim): ClaimState {
    const state = this.claims.get(claim.id);
    if (!state || state.endpointId !== claim.endpointId || state.threadId !== claim.threadId || state.generation !== claim.generation) {
      this.conflict(`unknown capacity claim ${claim.id}`);
    }
    return state;
  }

  private releaseClaimState(state: ClaimState): void {
    const wasFull = this.claims.size >= this.options.maxConcurrentTurns;
    if (!this.claims.delete(state.id)) return;
    if (wasFull && this.claims.size < this.options.maxConcurrentTurns) this.scheduleCapacitySignal();
  }

  private recordTerminalClaim(state: TurnCapacityClaim, turnId: string): void {
    this.terminalClaims.delete(state.id);
    this.terminalClaims.set(state.id, {
      id: state.id,
      endpointId: state.endpointId,
      threadId: state.threadId,
      generation: state.generation,
      turnId,
    });
    if (this.terminalClaims.size > 1_000) this.terminalClaims.delete(this.terminalClaims.keys().next().value!);
  }

  private scheduleCapacitySignal(): void {
    if (this.capacitySignalPending) return;
    this.capacitySignalPending = true;
    queueMicrotask(() => {
      this.capacitySignalPending = false;
      for (const listener of this.capacityListeners) listener();
    });
  }

  private async findStartedTurn(endpointId: string, threadId: string, clientUserMessageId: string, lease?: EndpointWorkLease): Promise<{ id: string; items: Array<{ type: string; clientId?: string | null }> }> {
    const deadline = Date.now() + (this.options.reconciliationTimeoutMs ?? 30_000);
    do {
      let history: { thread: ThreadHistory };
      try {
        history = await this.request(endpointId, "thread/read", { threadId, includeTurns: true }, undefined, lease);
      } catch (error) {
        throw new AppError("OPERATION_UNCERTAIN", `turn/start outcome could not be reconciled because thread history was unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      const actual = [...history.thread.turns].reverse().find((turn) =>
        turn.items.some((item) => item.type === "userMessage" && item.clientId === clientUserMessageId));
      if (actual) return actual;
      if (Date.now() >= deadline) {
        const threadStatus = typeof history.thread.status === "string" ? history.thread.status : history.thread.status?.type;
        if (threadStatus === "idle" && history.thread.turns.every((turn) => turn.itemsView === "full")) throw new StartProvenAbsentError();
        throw new AppError("OPERATION_UNCERTAIN", "turn/start outcome could not be proven because thread history was incomplete");
      }
      await (this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(this.options.reconciliationPollMs ?? 25);
    } while (true);
  }

  private publicClaim(state: TurnCapacityClaim): TurnCapacityClaim {
    return { id: state.id, endpointId: state.endpointId, threadId: state.threadId, generation: state.generation };
  }

  private turnKey(endpointId: string, threadId: string, turnId: string): string {
    return `${endpointId}:${threadId}:${turnId}`;
  }

  private conflict(message: string): never {
    throw new AppError("OPERATION_CONFLICT", `OPERATION_CONFLICT: ${message}`);
  }

  private withWorkLease<T>(endpointId: string, lease: EndpointWorkLease | undefined, run: (lease: EndpointWorkLease | undefined) => Promise<T>): Promise<T> {
    return this.workLeaseProvider ? this.workLeaseProvider(endpointId, lease, run) : run(lease);
  }

  private publishEndpoint(endpoint: AppServerEndpoint): number {
    const generation = (this.endpointGenerations.get(endpoint.id) ?? 0) + 1;
    this.endpointUnavailableSubscriptions.get(endpoint.id)?.();
    this.endpointUnavailableSubscriptions.delete(endpoint.id);
    this.endpoints.set(endpoint.id, endpoint);
    this.endpointGenerations.set(endpoint.id, generation);
    if ("onUnavailable" in endpoint && typeof endpoint.onUnavailable === "function") {
      const unsubscribe = endpoint.onUnavailable((kind: EndpointLossKind) => {
        if (this.endpointGenerations.get(endpoint.id) !== generation || this.endpoints.get(endpoint.id) !== endpoint) return;
        this.markEndpointUnavailable(endpoint.id, kind);
      });
      this.endpointUnavailableSubscriptions.set(endpoint.id, unsubscribe);
    }
    return generation;
  }
}
