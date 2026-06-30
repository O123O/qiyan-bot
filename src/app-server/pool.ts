import { AppError } from "../core/errors.ts";

export interface AppServerEndpoint {
  readonly id: string;
  readonly state: "starting" | "ready" | "unavailable" | "stopped";
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
}

interface TurnStartResponse { turn: { id: string } }

export class AppServerPool {
  private readonly endpoints = new Map<string, AppServerEndpoint>();
  private readonly active = new Set<string>();
  private readonly terminalBeforeStart = new Set<string>();

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

  async startTurn<T extends TurnStartResponse = TurnStartResponse>(endpointId: string, params: { threadId: string; [key: string]: unknown }): Promise<T> {
    if (this.active.size >= this.options.maxConcurrentTurns) {
      throw new AppError("CAPACITY_EXCEEDED", `at most ${this.options.maxConcurrentTurns} turns may run concurrently`);
    }
    const reservation = `${endpointId}:${params.threadId}:pending:${crypto.randomUUID()}`;
    this.active.add(reservation);
    try {
      let response: T;
      try {
        response = await this.request<T>(endpointId, "turn/start", params);
      } catch (error) {
        if (typeof params.clientUserMessageId !== "string") throw error;
        const actual = await this.findStartedTurn(endpointId, params.threadId, params.clientUserMessageId);
        response = { turn: actual } as unknown as T;
      }
      if (typeof params.clientUserMessageId === "string") response = { ...response, turn: await this.findStartedTurn(endpointId, params.threadId, params.clientUserMessageId, response.turn.id) } as T;
      this.active.delete(reservation);
      const key = this.turnKey(endpointId, params.threadId, response.turn.id);
      if (!this.terminalBeforeStart.delete(key)) this.active.add(key);
      return response;
    } catch (error) {
      this.active.delete(reservation);
      throw error;
    }
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
    const key = this.turnKey(endpointId, threadId, turnId);
    if (!this.active.delete(key)) {
      this.terminalBeforeStart.add(key);
      if (this.terminalBeforeStart.size > 1_000) this.terminalBeforeStart.delete(this.terminalBeforeStart.values().next().value!);
    }
  }

  markEndpointUnavailable(endpointId: string): void {
    for (const key of this.active) if (key.startsWith(`${endpointId}:`)) this.active.delete(key);
    for (const key of this.terminalBeforeStart) if (key.startsWith(`${endpointId}:`)) this.terminalBeforeStart.delete(key);
  }

  get activeTurnCount(): number { return this.active.size; }

  private async findStartedTurn(endpointId: string, threadId: string, clientUserMessageId: string, candidateTurnId?: string): Promise<{ id: string; items: Array<{ type: string; clientId?: string | null }> }> {
    const deadline = Date.now() + (this.options.reconciliationTimeoutMs ?? 30_000);
    do {
      let history: { thread: { turns: Array<{ id: string; items: Array<{ type: string; clientId?: string | null }> }> } };
      try {
        history = await this.request(endpointId, "thread/read", { threadId, includeTurns: true });
      } catch (error) {
        throw new AppError("OPERATION_UNCERTAIN", `turn/start outcome could not be reconciled because thread history was unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      const actual = [...history.thread.turns].reverse().find((turn) =>
        turn.items.some((item) => item.type === "userMessage" && item.clientId === clientUserMessageId)
        || (candidateTurnId !== undefined && turn.id === candidateTurnId));
      if (actual) return actual;
      if (Date.now() >= deadline) throw new AppError("OPERATION_UNCERTAIN", "turn/start outcome could not be proven by turn ID or clientUserMessageId in thread history");
      await (this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(this.options.reconciliationPollMs ?? 25);
    } while (true);
  }

  private turnKey(endpointId: string, threadId: string, turnId: string): string {
    return `${endpointId}:${threadId}:${turnId}`;
  }
}
