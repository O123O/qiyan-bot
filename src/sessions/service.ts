import type { AppServerPool } from "../app-server/pool.ts";
import { AppError } from "../core/errors.ts";
import type { RegistrySession, SessionRegistry } from "../registry/session-registry.ts";
import type { DeliveryStore } from "../storage/delivery-store.ts";
import type { ConversationBinding } from "../chat/binding.ts";
import type { RuntimeStore } from "../storage/runtime-store.ts";
import type { FinalMessageStore, LogicalFinalMessage } from "./final-messages.ts";
import type { ProjectWorkspacePolicy } from "./project-workspace.ts";
import type { ThreadGate } from "./thread-gate.ts";
import { WorkspaceRouter } from "../endpoints/workspace-router.ts";
import type { EndpointManager } from "../endpoints/manager.ts";
import type { EndpointWorkLease } from "../endpoints/types.ts";
import type { OwnershipInspection } from "./rollout-ownership.ts";
import { isExactThreadNotMaterialized } from "../app-server/thread-errors.ts";

interface SessionOwnershipCheck {
  inspect(identity: Pick<RegistrySession, "endpoint" | "thread_id" | "mapping_id">, lease?: EndpointWorkLease): Promise<OwnershipInspection>;
  authorizeTurn?(identity: Pick<RegistrySession, "endpoint" | "thread_id" | "mapping_id">, turnId: string): void;
}

export class SessionService {
  constructor(
    private readonly pool: AppServerPool,
    private readonly registry: SessionRegistry,
    private readonly runtime: RuntimeStore,
    private readonly finals: FinalMessageStore,
    private readonly deliveries: DeliveryStore,
    private readonly workspaces: Pick<ProjectWorkspacePolicy, "prepareExisting" | "assertDispatchable"> | WorkspaceRouter,
    private readonly gate: ThreadGate,
    private readonly endpoints?: Pick<EndpointManager, "withWorkLease" | "runWithWorkLease">,
    private readonly ownership?: SessionOwnershipCheck,
  ) {}

  async send(nickname: string, text: string, options: {
    mode?: "auto" | "start" | "steer";
    clientUserMessageId?: string;
    input?: unknown[];
    settings?: { model?: string; effort?: string };
    prepareInput?(context: { session: RegistrySession; projectRoot: string; lease?: EndpointWorkLease }): Promise<unknown[]>;
    onBeforeNativeDispatch?(context: { session: RegistrySession; mode: "start" | "steer"; activeTurnId?: string; lease?: EndpointWorkLease }): void | Promise<void>;
  } = {}): Promise<{ mode: "start" | "steer"; turnId: string; terminal?: boolean; appliedSettings?: { model?: string; effort?: string } }> {
    return this.runVerifiedExecution(nickname, async (session, cwd, lease) => {
      const activeTurn = this.runtime.activeTurn(session.endpoint, session.thread_id, session.mapping_id);
      const mode = options.mode ?? "auto";
      if (activeTurn) {
        if (mode === "start") throw new AppError("SESSION_BUSY", `${nickname} already has an active turn`);
      } else if (mode === "steer") throw new AppError("SESSION_IDLE", `${nickname} has no active turn`);
      const input = options.prepareInput
        ? await options.prepareInput({ session, projectRoot: cwd, ...(lease ? { lease } : {}) })
        : options.input ?? [{ type: "text", text, text_elements: [] }];
      this.assertExactManaged(nickname, session.mapping_id);
      if (activeTurn) {
        await options.onBeforeNativeDispatch?.({ session, mode: "steer", activeTurnId: activeTurn, ...(lease ? { lease } : {}) });
        this.assertExactManaged(nickname, session.mapping_id);
        await this.assertOwned(nickname, session, lease);
        this.assertExactManaged(nickname, session.mapping_id);
        try {
          const response = await this.pool.request<{ turnId: string }>(session.endpoint, "turn/steer", {
            threadId: session.thread_id, ...(options.clientUserMessageId ? { clientUserMessageId: options.clientUserMessageId } : {}), input, expectedTurnId: activeTurn,
          }, undefined, lease);
          return { mode: "steer" as const, turnId: response.turnId };
        } catch (error) {
          if (!options.clientUserMessageId) throw error;
          const history = await this.pool.request<any>(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: true }, undefined, lease);
          const proven = history.thread.turns.find((turn: any) => turn.id === activeTurn && turn.items.some((item: any) => item.type === "userMessage" && item.clientId === options.clientUserMessageId));
          if (!proven) throw error;
          return { mode: "steer" as const, turnId: activeTurn };
        }
      }
      const settings = options.settings ?? this.runtime.settings(session.endpoint, session.thread_id, session.mapping_id);
      this.assertExactManaged(nickname, session.mapping_id);
      await options.onBeforeNativeDispatch?.({ session, mode: "start", ...(lease ? { lease } : {}) });
      this.assertExactManaged(nickname, session.mapping_id);
      await this.assertOwned(nickname, session, lease);
      this.assertExactManaged(nickname, session.mapping_id);
      const response = await this.pool.startTurn<{ turn: { id: string; status?: string } }>(session.endpoint, {
        threadId: session.thread_id, cwd, ...(options.clientUserMessageId ? { clientUserMessageId: options.clientUserMessageId } : {}), input, ...settings,
      }, undefined, lease);
      this.runtime.consumeSettings(session.endpoint, session.thread_id, session.mapping_id, settings);
      const terminal = new Set(["completed", "failed", "interrupted"]).has(response.turn.status ?? "");
      if (!terminal) this.runtime.setActiveTurn(session.endpoint, session.thread_id, session.mapping_id, response.turn.id);
      return { mode: "start" as const, turnId: response.turn.id, terminal, appliedSettings: settings };
    });
  }

  async interrupt(nickname: string, turnId?: string, options: {
    existingLease?: EndpointWorkLease;
    recoverExactTurn?: boolean;
  } = {}): Promise<void> {
    const expected = this.managed(nickname);
    await this.withMutationLease(expected.endpoint, (lease) => this.gate.run(expected.endpoint, expected.thread_id, async () => {
      const session = this.assertExactManaged(nickname, expected.mapping_id);
      await this.assertOwned(nickname, session, lease);
      this.assertExactManaged(nickname, expected.mapping_id);
      let active = this.runtime.activeTurn(session.endpoint, session.thread_id, session.mapping_id);
      if (!active && options.recoverExactTurn && turnId) {
        const native = await this.readWithTurns(session.endpoint, session.thread_id, lease);
        const target = native.thread.turns.find((candidate: any) => candidate.id === turnId);
        if (target && isTerminalStatus(target.status)) return;
        if (!target) throw new AppError("OPERATION_UNCERTAIN", `turn ${turnId} is not present in authoritative history`);
        active = turnId;
      }
      if (!active) throw new AppError("SESSION_IDLE", `${nickname} has no active turn`);
      if (turnId && turnId !== active) throw new AppError("OPERATION_CONFLICT", `active turn is ${active}, not ${turnId}`);
      await this.pool.interrupt(session.endpoint, session.thread_id, active, lease);
      this.runtime.clearActiveTurn(session.endpoint, session.thread_id, session.mapping_id, active);
    }), options.existingLease);
  }

  authorizeTurn(nickname: string, turnId: string): void {
    const session = this.managed(nickname);
    this.ownership?.authorizeTurn?.(session, turnId);
  }

  async authorizeActiveTurn(nickname: string, existingLease?: EndpointWorkLease): Promise<string | undefined> {
    const expected = this.managed(nickname);
    return this.withMutationLease(expected.endpoint, (lease) => this.gate.run(expected.endpoint, expected.thread_id, async () => {
      const session = this.assertExactManaged(nickname, expected.mapping_id);
      return this.authorizeActiveTurnForSession(session, lease);
    }), existingLease);
  }

  activeTurnId(nickname: string): string {
    const session = this.managed(nickname);
    const turnId = this.runtime.activeTurn(session.endpoint, session.thread_id, session.mapping_id);
    if (!turnId) throw new AppError("SESSION_IDLE", `${nickname} has no active turn`);
    return turnId;
  }

  managedProjectRoot(nickname: string): string { return this.managed(nickname).project_dir; }

  collect(nickname: string, count: number): Promise<LogicalFinalMessage[]>;
  collect(nickname: string, count: number, options: { direct?: false; binding?: ConversationBinding }): Promise<LogicalFinalMessage[]>;
  collect(nickname: string, count: number, options: { direct: true; binding: ConversationBinding; deliveryKey?: string; onSelected?(messageIds: readonly string[]): void }): Promise<Array<{ deliveryId: string }>>;
  async collect(nickname: string, count: number, options: { direct?: boolean; binding?: ConversationBinding; deliveryKey?: string; onSelected?(messageIds: readonly string[]): void } = {}): Promise<LogicalFinalMessage[] | Array<{ deliveryId: string }>> {
    const session = this.required(nickname);
    const messages = this.finals.list(session.endpoint, session.thread_id, count);
    if (!options.direct) return messages;
    if (!options.binding) throw new TypeError("binding is required for direct collection");
    options.onSelected?.(messages.map((message) => message.id));
    return this.prepareCollection(nickname, session, messages, options.binding, options.deliveryKey ?? "direct-collection");
  }

  async collectSelected(nickname: string, messageIds: readonly string[], options: { binding: ConversationBinding; deliveryKey: string }): Promise<Array<{ deliveryId: string }>> {
    const session = this.required(nickname);
    const messages = messageIds.map((id) => {
      const message = this.finals.getById(id);
      if (!message || message.endpointId !== session.endpoint || message.threadId !== session.thread_id) throw new AppError("OPERATION_CONFLICT", `collection message does not belong to ${nickname}: ${id}`);
      return message;
    });
    return this.prepareCollection(nickname, session, messages, options.binding, options.deliveryKey);
  }

  private prepareCollection(nickname: string, session: { endpoint: string; thread_id: string }, messages: readonly LogicalFinalMessage[], binding: ConversationBinding, deliveryKey: string): Array<{ deliveryId: string }> {
    return messages.map((message) => ({
      deliveryId: this.deliveries.prepare({
        id: `collect:${deliveryKey}:${session.endpoint}:${session.thread_id}:${message.turnId}:${message.itemId}:${binding.adapterId}:${binding.conversationKey}`,
        kind: "collection", binding, body: `[${nickname}] ${message.body}`, mandatory: true,
      }).id,
    }));
  }

  async status(nickname: string, options: {
    observeNative?(snapshot: { nativeStatus: string; activeTurnId: string | null }): void;
  } = {}): Promise<unknown> {
    const session = this.required(nickname);
    const native = await this.readWithTurns(session.endpoint, session.thread_id);
    const runtime = this.runtime.getSession(session.endpoint, session.thread_id, session.mapping_id);
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
    this.runtime.setModel(session.endpoint, session.thread_id, session.mapping_id, model);
  }

  async setEffort(nickname: string, effort: string): Promise<void> {
    const session = this.managed(nickname);
    const available = await this.listModels(session.endpoint);
    const pendingModel = this.runtime.settings(session.endpoint, session.thread_id, session.mapping_id).model;
    const native = await this.pool.request<any>(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: false });
    const configuredModel = pendingModel ?? native.thread.model;
    const model = available.find((candidate) => candidate.id === configuredModel || candidate.model === configuredModel) ?? available.find((candidate) => candidate.isDefault) ?? available[0];
    if (model?.supportedReasoningEfforts && !model.supportedReasoningEfforts.some((candidate: any) => candidate.reasoningEffort === effort || candidate === effort)) {
      throw new AppError("UNSUPPORTED_CAPABILITY", `reasoning effort ${effort} is not supported by ${model.id ?? model.model}`);
    }
    this.runtime.setEffort(session.endpoint, session.thread_id, session.mapping_id, effort);
  }

  getGoal(nickname: string): Promise<unknown> {
    const session = this.required(nickname); return this.pool.request(session.endpoint, "thread/goal/get", { threadId: session.thread_id });
  }

  async setGoal(
    nickname: string,
    objective: string,
    tokenBudget?: number,
    beforeDispatch?: () => void,
    onAuthoritativeMismatch?: () => void | Promise<void>,
  ): Promise<unknown> {
    return this.runVerifiedExecution(nickname, async (session, _cwd, lease) => {
      beforeDispatch?.();
      try {
        return await this.pool.request(session.endpoint, "thread/goal/set", { threadId: session.thread_id, objective, status: "active", ...(tokenBudget === undefined ? {} : { tokenBudget }) }, undefined, lease);
      } catch (error) {
        const current = await this.pool.request(session.endpoint, "thread/goal/get", { threadId: session.thread_id }, undefined, lease).catch(() => undefined) as any;
        const goal = current?.goal;
        if (goal?.objective === objective && goal?.status === "active" && (tokenBudget === undefined || goal.tokenBudget === tokenBudget || goal.token_budget === tokenBudget)) return current;
        if (isAuthoritativeGoalResponse(current)) {
          await this.authorizeActiveTurnForSession(session, lease);
          await onAuthoritativeMismatch?.();
        }
        throw error;
      }
    });
  }

  pauseGoal(nickname: string): Promise<unknown> { return this.setGoalStatusUnchecked(nickname, "paused"); }
  resumeGoal(nickname: string, beforeDispatch?: () => void, onAuthoritativeMismatch?: () => void | Promise<void>): Promise<unknown> {
    return this.runVerifiedExecution(nickname, (session, _cwd, lease) => {
      beforeDispatch?.();
      return this.setGoalStatusForSession(session, "active", lease, onAuthoritativeMismatch);
    });
  }

  async cancelGoal(nickname: string): Promise<unknown> {
    const session = this.managed(nickname);
    try { return await this.pool.request(session.endpoint, "thread/goal/clear", { threadId: session.thread_id }); }
    catch (error) {
      const current = await this.getGoal(nickname).catch(() => undefined) as any;
      if (current && current.goal == null) return current;
      throw error;
    }
  }

  private async setGoalStatusUnchecked(nickname: string, status: "paused"): Promise<unknown> {
    const session = this.managed(nickname);
    return this.setGoalStatusForSession(session, status);
  }

  private async setGoalStatusForSession(
    session: RegistrySession,
    status: "paused" | "active",
    lease?: EndpointWorkLease,
    onAuthoritativeMismatch?: () => void | Promise<void>,
  ): Promise<unknown> {
    try { return await this.pool.request(session.endpoint, "thread/goal/set", { threadId: session.thread_id, status }, undefined, lease); }
    catch (error) {
      const current = await this.pool.request(session.endpoint, "thread/goal/get", { threadId: session.thread_id }, undefined, lease).catch(() => undefined) as any;
      if (current?.goal?.status === status) return current;
      if (isAuthoritativeGoalResponse(current)) {
        await this.authorizeActiveTurnForSession(session, lease);
        await onAuthoritativeMismatch?.();
      }
      throw error;
    }
  }

  private runVerifiedExecution<T>(nickname: string, mutate: (session: RegistrySession, cwd: string, lease?: EndpointWorkLease) => Promise<T>): Promise<T> {
    const expected = this.managed(nickname);
    return this.withMutationLease(expected.endpoint, (lease) => this.gate.run(expected.endpoint, expected.thread_id, async () => {
      const session = this.assertExactManaged(nickname, expected.mapping_id);
      await this.assertOwned(nickname, session, lease);
      this.assertExactManaged(nickname, expected.mapping_id);
      const native = await this.pool.request<any>(session.endpoint, "thread/read", { threadId: session.thread_id, includeTurns: false }, undefined, lease);
      const project = await this.prepareExisting(session.endpoint, String(native.thread.cwd), lease);
      await this.assertDispatchable(session.endpoint, project, lease);
      if (project.path !== session.project_dir) throw new AppError("CWD_MISMATCH", "managed thread cwd changed");
      this.assertExactManaged(nickname, expected.mapping_id);
      return mutate(session, project.path, lease);
    }));
  }

  private withMutationLease<T>(endpointId: string, run: (lease?: EndpointWorkLease) => Promise<T>, existingLease?: EndpointWorkLease): Promise<T> {
    if (!this.endpoints) return run(existingLease);
    return existingLease
      ? this.endpoints.runWithWorkLease(endpointId, existingLease, run)
      : this.endpoints.withWorkLease(endpointId, "session-mutation", (_endpoint, lease) => run(lease));
  }

  private async assertOwned(nickname: string, session: RegistrySession, lease?: EndpointWorkLease): Promise<void> {
    if (!this.ownership) return;
    const ownership = await this.ownership.inspect(session, lease);
    if (ownership.state === "external") throw new AppError("SESSION_DETACHED", `${nickname} is being used outside QiYan`);
    if (ownership.state === "lost") throw new AppError("THREAD_NOT_FOUND", `${nickname} has no durable rollout after restart`);
    if (ownership.state === "pending") throw new AppError("SESSION_BUSY", `${nickname} is waiting for its rollout to materialize`);
    if (ownership.state === "unclassified") throw new AppError("SESSION_BUSY", `${nickname} has a turn whose ownership is not yet classified`);
  }

  private async authorizeActiveTurnForSession(session: RegistrySession, lease?: EndpointWorkLease): Promise<string | undefined> {
    const native = await this.readWithTurns(session.endpoint, session.thread_id, lease);
    if (native.thread.id !== session.thread_id || native.thread.status?.type !== "active") return undefined;
    const turn = [...native.thread.turns].reverse().find((candidate: any) => !isTerminalStatus(candidate.status));
    if (!turn) return undefined;
    this.ownership?.authorizeTurn?.(session, turn.id);
    return String(turn.id);
  }

  private prepareExisting(endpointId: string, path: string, lease?: EndpointWorkLease) {
    return this.workspaces instanceof WorkspaceRouter
      ? this.workspaces.prepareExisting(endpointId, path, lease)
      : this.workspaces.prepareExisting(path);
  }

  private assertDispatchable(endpointId: string, project: import("./project-workspace.ts").PreparedProjectWorkspace, lease?: EndpointWorkLease) {
    return this.workspaces instanceof WorkspaceRouter
      ? this.workspaces.assertDispatchable(endpointId, project, lease)
      : this.workspaces.assertDispatchable(project);
  }

  private assertExactManaged(nickname: string, mappingId: string) {
    const session = this.registry.get(nickname);
    if (!session || session.mapping_id !== mappingId || session.lifecycle_state !== "managed") {
      throw new AppError("SESSION_DETACHED", `${nickname} mapping changed or is not managed`);
    }
    const runtime = this.runtime.getSession(session.endpoint, session.thread_id, session.mapping_id);
    if (runtime?.managementState !== "managed") throw new AppError("SESSION_DETACHED", `${nickname} is not managed`);
    return session;
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

  private async readWithTurns(endpointId: string, threadId: string, lease?: EndpointWorkLease): Promise<any> {
    try {
      return await this.pool.request<any>(endpointId, "thread/read", { threadId, includeTurns: true }, undefined, lease);
    } catch (error) {
      if (!isExactThreadNotMaterialized(error, threadId)) throw error;
      const response = await this.pool.request<any>(endpointId, "thread/read", { threadId, includeTurns: false }, undefined, lease);
      return { ...response, thread: { ...response.thread, turns: [] } };
    }
  }

  private required(nickname: string) {
    const session = this.registry.get(nickname);
    if (!session) throw new AppError("UNKNOWN_SESSION", `unknown session: ${nickname}`);
    return session;
  }

  private managed(nickname: string) {
    const session = this.required(nickname);
    if (session.lifecycle_state !== "managed" || this.runtime.getSession(session.endpoint, session.thread_id, session.mapping_id)?.managementState !== "managed") throw new AppError("SESSION_DETACHED", `${nickname} is not managed`);
    return session;
  }
}

function isTerminalStatus(status: unknown): boolean {
  const type = typeof status === "string" ? status : String((status as any)?.type ?? "");
  return new Set(["completed", "failed", "interrupted"]).has(type);
}

const goalStatuses = new Set(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);

function isAuthoritativeGoalResponse(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "goal")) return false;
  const goal = (value as { goal: unknown }).goal;
  if (goal === null) return true;
  return !!goal && typeof goal === "object" && !Array.isArray(goal)
    && typeof (goal as { status?: unknown }).status === "string"
    && goalStatuses.has((goal as { status: string }).status);
}
