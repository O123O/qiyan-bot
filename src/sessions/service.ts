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

  async send(nickname: string, text: string, options: { mode?: "auto" | "start" | "steer"; clientUserMessageId?: string; input?: unknown[] } = {}): Promise<{ mode: "start" | "steer"; turnId: string }> {
    const session = this.required(nickname);
    const state = this.runtime.getSession(session.endpoint, session.thread_id);
    if (!state || state.managementState !== "managed") throw new AppError("SESSION_DETACHED", `${nickname} is not managed`);
    const activeTurn = this.runtime.activeTurn(session.endpoint, session.thread_id);
    const mode = options.mode ?? "auto";
    const input = options.input ?? [{ type: "text", text, text_elements: [] }];
    if (activeTurn) {
      if (mode === "start") throw new AppError("SESSION_BUSY", `${nickname} already has an active turn`);
      const response = await this.pool.request<{ turnId: string }>(session.endpoint, "turn/steer", {
        threadId: session.thread_id, ...(options.clientUserMessageId ? { clientUserMessageId: options.clientUserMessageId } : {}), input, expectedTurnId: activeTurn,
      });
      return { mode: "steer", turnId: response.turnId };
    }
    if (mode === "steer") throw new AppError("SESSION_IDLE", `${nickname} has no active turn`);
    const settings = this.runtime.settings(session.endpoint, session.thread_id);
    const response = await this.pool.startTurn<{ turn: { id: string } }>(session.endpoint, {
      threadId: session.thread_id, ...(options.clientUserMessageId ? { clientUserMessageId: options.clientUserMessageId } : {}), input, ...settings,
    });
    this.runtime.consumeSettings(session.endpoint, session.thread_id);
    this.runtime.setActiveTurn(session.endpoint, session.thread_id, response.turn.id);
    return { mode: "start", turnId: response.turn.id };
  }

  async interrupt(nickname: string, turnId?: string): Promise<void> {
    const session = this.required(nickname);
    const active = this.runtime.activeTurn(session.endpoint, session.thread_id);
    if (!active) throw new AppError("SESSION_IDLE", `${nickname} has no active turn`);
    if (turnId && turnId !== active) throw new AppError("OPERATION_CONFLICT", `active turn is ${active}, not ${turnId}`);
    await this.pool.interrupt(session.endpoint, session.thread_id, active);
    this.runtime.setActiveTurn(session.endpoint, session.thread_id, undefined);
  }

  collect(nickname: string, count: number): Promise<LogicalFinalMessage[]>;
  collect(nickname: string, count: number, options: { direct?: false; destination?: string }): Promise<LogicalFinalMessage[]>;
  collect(nickname: string, count: number, options: { direct: true; destination: string }): Promise<Array<{ deliveryId: string }>>;
  async collect(nickname: string, count: number, options: { direct?: boolean; destination?: string } = {}): Promise<LogicalFinalMessage[] | Array<{ deliveryId: string }>> {
    const session = this.required(nickname);
    const messages = this.finals.list(session.endpoint, session.thread_id, count);
    if (!options.direct) return messages;
    if (!options.destination) throw new TypeError("destination is required for direct collection");
    return messages.map((message) => ({
      deliveryId: this.deliveries.prepare({
        id: `collect:${session.endpoint}:${session.thread_id}:${message.turnId}:${message.itemId}:${options.destination}`,
        kind: "collection", destination: options.destination!, body: `[${nickname}] ${message.body}`, mandatory: false,
      }).id,
    }));
  }

  status(nickname: string): Promise<unknown> {
    const session = this.required(nickname);
    return this.pool.request(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: false });
  }

  models(endpointId: string): Promise<unknown> { return this.pool.request(endpointId, "model/list", {}); }

  async setModel(nickname: string, model: string): Promise<void> {
    const session = this.required(nickname); this.runtime.setModel(session.endpoint, session.thread_id, model);
  }

  async setEffort(nickname: string, effort: string): Promise<void> {
    const session = this.required(nickname); this.runtime.setEffort(session.endpoint, session.thread_id, effort);
  }

  getGoal(nickname: string): Promise<unknown> {
    const session = this.required(nickname); return this.pool.request(session.endpoint, "thread/goal/get", { threadId: session.thread_id });
  }

  setGoal(nickname: string, objective: string, tokenBudget?: number): Promise<unknown> {
    const session = this.required(nickname); return this.pool.request(session.endpoint, "thread/goal/set", { threadId: session.thread_id, objective, status: "active", ...(tokenBudget === undefined ? {} : { tokenBudget }) });
  }

  pauseGoal(nickname: string): Promise<unknown> { return this.setGoalStatus(nickname, "paused"); }
  resumeGoal(nickname: string): Promise<unknown> { return this.setGoalStatus(nickname, "active"); }

  cancelGoal(nickname: string): Promise<unknown> {
    const session = this.required(nickname); return this.pool.request(session.endpoint, "thread/goal/clear", { threadId: session.thread_id });
  }

  private setGoalStatus(nickname: string, status: "paused" | "active"): Promise<unknown> {
    const session = this.required(nickname); return this.pool.request(session.endpoint, "thread/goal/set", { threadId: session.thread_id, status });
  }

  private required(nickname: string) {
    const session = this.registry.get(nickname);
    if (!session) throw new AppError("UNKNOWN_SESSION", `unknown session: ${nickname}`);
    return session;
  }
}
