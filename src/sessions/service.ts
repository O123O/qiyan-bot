import type { AppServerPool } from "../app-server/pool.ts";
import { AppError } from "../core/errors.ts";
import type { SessionRegistry } from "../registry/session-registry.ts";
import type { DeliveryStore } from "../storage/delivery-store.ts";
import type { RuntimeStore } from "../storage/runtime-store.ts";
import type { FinalMessageStore, LogicalFinalMessage } from "./final-messages.ts";

export class SessionService {
  constructor(
    private readonly pool: AppServerPool,
    private readonly registry: SessionRegistry,
    private readonly runtime: RuntimeStore,
    private readonly finals: FinalMessageStore,
    private readonly deliveries: DeliveryStore,
  ) {}

  async send(nickname: string, text: string, options: { mode?: "auto" | "start" | "steer"; clientUserMessageId?: string; input?: unknown[]; settings?: { model?: string; effort?: string } } = {}): Promise<{ mode: "start" | "steer"; turnId: string; terminal?: boolean; appliedSettings?: { model?: string; effort?: string } }> {
    const session = this.required(nickname);
    const state = this.runtime.getSession(session.endpoint, session.thread_id);
    if (!state || state.managementState !== "managed") throw new AppError("SESSION_DETACHED", `${nickname} is not managed`);
    const activeTurn = this.runtime.activeTurn(session.endpoint, session.thread_id);
    const mode = options.mode ?? "auto";
    const input = options.input ?? [{ type: "text", text, text_elements: [] }];
    if (activeTurn) {
      if (mode === "start") throw new AppError("SESSION_BUSY", `${nickname} already has an active turn`);
      try {
        const response = await this.pool.request<{ turnId: string }>(session.endpoint, "turn/steer", {
          threadId: session.thread_id, ...(options.clientUserMessageId ? { clientUserMessageId: options.clientUserMessageId } : {}), input, expectedTurnId: activeTurn,
        });
        return { mode: "steer", turnId: response.turnId };
      } catch (error) {
        if (!options.clientUserMessageId) throw error;
        const history = await this.pool.request<any>(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: true });
        const proven = history.thread.turns.find((turn: any) => turn.id === activeTurn && turn.items.some((item: any) => item.type === "userMessage" && item.clientId === options.clientUserMessageId));
        if (!proven) throw error;
        return { mode: "steer", turnId: activeTurn };
      }
    }
    if (mode === "steer") throw new AppError("SESSION_IDLE", `${nickname} has no active turn`);
    const settings = options.settings ?? this.runtime.settings(session.endpoint, session.thread_id);
    const response = await this.pool.startTurn<{ turn: { id: string; status?: string } }>(session.endpoint, {
      threadId: session.thread_id, ...(options.clientUserMessageId ? { clientUserMessageId: options.clientUserMessageId } : {}), input, ...settings,
    });
    this.runtime.consumeSettings(session.endpoint, session.thread_id, settings);
    const terminal = new Set(["completed", "failed", "interrupted"]).has(response.turn.status ?? "");
    if (!terminal) {
      this.runtime.setActiveTurn(session.endpoint, session.thread_id, response.turn.id);
    }
    return { mode: "start", turnId: response.turn.id, terminal, appliedSettings: settings };
  }

  async interrupt(nickname: string, turnId?: string): Promise<void> {
    const session = this.required(nickname);
    const active = this.runtime.activeTurn(session.endpoint, session.thread_id);
    if (!active) throw new AppError("SESSION_IDLE", `${nickname} has no active turn`);
    if (turnId && turnId !== active) throw new AppError("OPERATION_CONFLICT", `active turn is ${active}, not ${turnId}`);
    await this.pool.interrupt(session.endpoint, session.thread_id, active);
    this.runtime.setActiveTurn(session.endpoint, session.thread_id, undefined);
  }

  activeTurnId(nickname: string): string {
    const session = this.managed(nickname);
    const turnId = this.runtime.activeTurn(session.endpoint, session.thread_id);
    if (!turnId) throw new AppError("SESSION_IDLE", `${nickname} has no active turn`);
    return turnId;
  }

  managedProjectRoot(nickname: string): string { return this.managed(nickname).project_dir; }

  collect(nickname: string, count: number): Promise<LogicalFinalMessage[]>;
  collect(nickname: string, count: number, options: { direct?: false; destination?: string }): Promise<LogicalFinalMessage[]>;
  collect(nickname: string, count: number, options: { direct: true; destination: string; deliveryKey?: string; onSelected?(messageIds: readonly string[]): void }): Promise<Array<{ deliveryId: string }>>;
  async collect(nickname: string, count: number, options: { direct?: boolean; destination?: string; deliveryKey?: string; onSelected?(messageIds: readonly string[]): void } = {}): Promise<LogicalFinalMessage[] | Array<{ deliveryId: string }>> {
    const session = this.required(nickname);
    const messages = this.finals.list(session.endpoint, session.thread_id, count);
    if (!options.direct) return messages;
    if (!options.destination) throw new TypeError("destination is required for direct collection");
    options.onSelected?.(messages.map((message) => message.id));
    return this.prepareCollection(nickname, session, messages, options.destination, options.deliveryKey ?? "legacy");
  }

  async collectSelected(nickname: string, messageIds: readonly string[], options: { destination: string; deliveryKey: string }): Promise<Array<{ deliveryId: string }>> {
    const session = this.required(nickname);
    const messages = messageIds.map((id) => {
      const message = this.finals.getById(id);
      if (!message || message.endpointId !== session.endpoint || message.threadId !== session.thread_id) throw new AppError("OPERATION_CONFLICT", `collection message does not belong to ${nickname}: ${id}`);
      return message;
    });
    return this.prepareCollection(nickname, session, messages, options.destination, options.deliveryKey);
  }

  private prepareCollection(nickname: string, session: { endpoint: string; thread_id: string }, messages: readonly LogicalFinalMessage[], destination: string, deliveryKey: string): Array<{ deliveryId: string }> {
    return messages.map((message) => ({
      deliveryId: this.deliveries.prepare({
        id: `collect:${deliveryKey}:${session.endpoint}:${session.thread_id}:${message.turnId}:${message.itemId}:${destination}`,
        kind: "collection", destination, body: `[${nickname}] ${message.body}`, mandatory: true,
      }).id,
    }));
  }

  async status(nickname: string, options: {
    observeNative?(snapshot: { nativeStatus: string; activeTurnId: string | null }): void;
  } = {}): Promise<unknown> {
    const session = this.required(nickname);
    const native = await this.pool.request<any>(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: true });
    const runtime = this.runtime.getSession(session.endpoint, session.thread_id);
    const nativeStatus = native.thread.status?.type ?? "unknown";
    const activeTurnId = nativeStatus === "active"
      ? [...(native.thread.turns ?? [])].reverse().find((turn: any) => !isTerminalStatus(turn.status))?.id ?? null
      : null;
    options.observeNative?.({ nativeStatus, activeTurnId });
    const goal = await this.getGoal(nickname);
    return {
      nickname,
      identity: { endpoint: session.endpoint, threadId: session.thread_id, projectDir: session.project_dir },
      managementState: runtime?.managementState ?? "unavailable",
      nativeStatus,
      activeTurnId,
      goal: goal && typeof goal === "object" && "goal" in goal ? (goal as any).goal : goal ?? null,
    };
  }

  async models(endpointId: string): Promise<unknown> { return { data: await this.listModels(endpointId), nextCursor: null }; }

  async setModel(nickname: string, model: string): Promise<void> {
    const session = this.managed(nickname);
    const available = await this.listModels(session.endpoint);
    if (!available.some((candidate) => candidate.id === model || candidate.model === model)) throw new AppError("UNSUPPORTED_CAPABILITY", `unknown model for ${session.endpoint}: ${model}`);
    this.runtime.setModel(session.endpoint, session.thread_id, model);
  }

  async setEffort(nickname: string, effort: string): Promise<void> {
    const session = this.managed(nickname);
    const available = await this.listModels(session.endpoint);
    const pendingModel = this.runtime.settings(session.endpoint, session.thread_id).model;
    const native = await this.pool.request<any>(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: false });
    const configuredModel = pendingModel ?? native.thread.model;
    const model = available.find((candidate) => candidate.id === configuredModel || candidate.model === configuredModel) ?? available.find((candidate) => candidate.isDefault) ?? available[0];
    if (model?.supportedReasoningEfforts && !model.supportedReasoningEfforts.some((candidate: any) => candidate.reasoningEffort === effort || candidate === effort)) {
      throw new AppError("UNSUPPORTED_CAPABILITY", `reasoning effort ${effort} is not supported by ${model.id ?? model.model}`);
    }
    this.runtime.setEffort(session.endpoint, session.thread_id, effort);
  }

  getGoal(nickname: string): Promise<unknown> {
    const session = this.required(nickname); return this.pool.request(session.endpoint, "thread/goal/get", { threadId: session.thread_id });
  }

  async setGoal(nickname: string, objective: string, tokenBudget?: number): Promise<unknown> {
    const session = this.managed(nickname);
    try {
      return await this.pool.request(session.endpoint, "thread/goal/set", { threadId: session.thread_id, objective, status: "active", ...(tokenBudget === undefined ? {} : { tokenBudget }) });
    } catch (error) {
      const current = await this.getGoal(nickname).catch(() => undefined) as any;
      const goal = current?.goal;
      if (goal?.objective === objective && goal?.status === "active" && (tokenBudget === undefined || goal.tokenBudget === tokenBudget || goal.token_budget === tokenBudget)) return current;
      throw error;
    }
  }

  pauseGoal(nickname: string): Promise<unknown> { return this.setGoalStatus(nickname, "paused"); }
  resumeGoal(nickname: string): Promise<unknown> { return this.setGoalStatus(nickname, "active"); }

  async cancelGoal(nickname: string): Promise<unknown> {
    const session = this.managed(nickname);
    try { return await this.pool.request(session.endpoint, "thread/goal/clear", { threadId: session.thread_id }); }
    catch (error) {
      const current = await this.getGoal(nickname).catch(() => undefined) as any;
      if (current && current.goal == null) return current;
      throw error;
    }
  }

  private async setGoalStatus(nickname: string, status: "paused" | "active"): Promise<unknown> {
    const session = this.managed(nickname);
    try { return await this.pool.request(session.endpoint, "thread/goal/set", { threadId: session.thread_id, status }); }
    catch (error) {
      const current = await this.getGoal(nickname).catch(() => undefined) as any;
      if (current?.goal?.status === status) return current;
      throw error;
    }
  }

  private async listModels(endpointId: string): Promise<any[]> {
    const data: any[] = [];
    let cursor: string | null = null;
    do {
      const page: { data?: any[]; nextCursor?: string | null } = await this.pool.request(endpointId, "model/list", cursor ? { cursor } : {});
      data.push(...(page.data ?? []));
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return data;
  }

  private required(nickname: string) {
    const session = this.registry.get(nickname);
    if (!session) throw new AppError("UNKNOWN_SESSION", `unknown session: ${nickname}`);
    return session;
  }

  private managed(nickname: string) {
    const session = this.required(nickname);
    if (this.runtime.getSession(session.endpoint, session.thread_id)?.managementState !== "managed") throw new AppError("SESSION_DETACHED", `${nickname} is not managed`);
    return session;
  }
}

function isTerminalStatus(status: unknown): boolean {
  const type = typeof status === "string" ? status : String((status as any)?.type ?? "");
  return new Set(["completed", "failed", "interrupted"]).has(type);
}
