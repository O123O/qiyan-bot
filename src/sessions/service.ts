import type { AppServerPool } from "../app-server/pool.ts";
import { AppError } from "../core/errors.ts";
import type { RegistrySession, SessionRegistry } from "../registry/session-registry.ts";
import type { DeliveryStore } from "../storage/delivery-store.ts";
import type { ConversationBinding } from "../chat-apps/shared/binding.ts";
import type { SessionControlStore } from "../storage/session-control-store.ts";
import type { FinalMessageStore, LogicalFinalMessage } from "./final-messages.ts";
import type { ProjectWorkspacePolicy } from "./project-workspace.ts";
import type { ThreadGate } from "./thread-gate.ts";
import { WorkspaceRouter } from "../endpoints/workspace-router.ts";
import type { EndpointManager } from "../endpoints/manager.ts";
import type { EndpointWorkLease } from "../endpoints/types.ts";
import type { NativeSessionIdentity, NativeSessionView } from "./native-session-state.ts";
import { NativeSessionState } from "./native-session-state.ts";
import { repairActiveTurnIdentity } from "./native-session-probe.ts";
import { createHistoryScanBudget } from "../app-server/thread-history.ts";
import { waitForCompactionEvidence } from "./compaction.ts";

export class SessionService {
  constructor(
    private readonly pool: AppServerPool,
    private readonly registry: SessionRegistry,
    private readonly native: NativeSessionState,
    private readonly controls: SessionControlStore,
    private readonly finals: FinalMessageStore,
    private readonly deliveries: DeliveryStore,
    private readonly workspaces: Pick<ProjectWorkspacePolicy, "prepareExisting" | "assertDispatchable"> | WorkspaceRouter,
    private readonly gate: ThreadGate,
    private readonly endpoints?: Pick<EndpointManager, "withWorkLease" | "runWithWorkLease">,
    // Does the endpoint's backend persist model/effort itself (Codex app-server), so a turn
    // CONSUMES the pending setting? For Claude there is no server: the setting must stay sticky
    // in SessionControlStore and re-apply every turn, so this returns false and consume is skipped.
    private readonly settingsPersistNatively: (endpointId: string) => boolean = () => true,
    private readonly onTurnAccepted: (session: RegistrySession, turnId: string) => void = () => undefined,
    private readonly observedSettings: (
      endpointId: string,
      threadId: string,
      mappingId: string,
    ) => { model?: string | null; effort?: string | null } = () => ({}),
  ) {}

  async send(nickname: string, text: string, options: {
    mode?: "auto" | "start" | "steer";
    clientUserMessageId?: string;
    input?: unknown[];
    settings?: { model?: string; effort?: string };
    captureBaselineTurn?: boolean;
    prepareInput?(context: { session: RegistrySession; projectRoot: string; lease?: EndpointWorkLease }): Promise<unknown[]>;
    onBeforeNativeDispatch?(context: {
      session: RegistrySession;
      mode: "start" | "steer";
      activeTurnId?: string;
      baselineTurnId?: string | null;
      lease?: EndpointWorkLease;
    }): void | Promise<void>;
    onTurnAccepted?(context: { session: RegistrySession; mode: "start" | "steer"; turnId: string }): void;
  } = {}): Promise<{ mode: "start" | "steer"; turnId: string; terminal?: boolean; appliedSettings?: { model?: string; effort?: string } }> {
    return this.runVerifiedExecution(nickname, async (session, cwd, lease) => {
      const current = await this.currentNative(session, lease);
      if (current.status === "error") {
        throw new AppError("ENDPOINT_UNAVAILABLE", `${nickname} native session is in an error state`);
      }
      const activeTurn = current.status === "active" ? current.activeTurnId ?? undefined : undefined;
      // Busy on background work is not an unresolved turn identity: there is no turn, and the
      // provider queues a new message behind the work rather than colliding with it. Refusing
      // here made a worker unreachable for as long as its subagent ran.
      if (current.status === "active" && !activeTurn && !current.backgroundWork) {
        throw new AppError("SESSION_BUSY", `${nickname} has an active turn whose identity is still being refreshed`);
      }
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
        try {
          const response = await this.pool.request<{ turnId: string }>(session.endpoint, "turn/steer", {
            threadId: session.thread_id, ...(options.clientUserMessageId ? { clientUserMessageId: options.clientUserMessageId } : {}), input, expectedTurnId: activeTurn,
          }, undefined, lease);
          options.onTurnAccepted?.({ session, mode: "steer", turnId: response.turnId });
          this.onTurnAccepted(session, response.turnId);
          return { mode: "steer" as const, turnId: response.turnId };
        } catch (error) {
          if (!options.clientUserMessageId) throw error;
          // Best-effort proof that the message landed despite the failure. It scans history for
          // the turn, and on a long-lived worker that scan can run out of budget — especially
          // when the turn it is looking for was never written, which is exactly the case where
          // the steer failed because that turn had already finished.
          //
          // A proof that could not be carried out proves nothing, so the ORIGINAL failure stands.
          // Reporting the scan's own exhaustion instead replaced an actionable message ("that
          // turn is no longer running; send it as a new turn") with an internal one about a
          // budget, for a send the user simply needs to retry.
          const items = await this.pool.historyReader(session.endpoint, lease).exactTurnItems(
            session.thread_id, activeTurn, { budget: createHistoryScanBudget() },
          ).catch(() => undefined);
          const proven = items?.items.some((item) => item.type === "userMessage" && item.clientId === options.clientUserMessageId) ?? false;
          if (!proven) throw error;
          options.onTurnAccepted?.({ session, mode: "steer", turnId: activeTurn });
          this.onTurnAccepted(session, activeTurn);
          return { mode: "steer" as const, turnId: activeTurn };
        }
      }
      const settings = options.settings ?? this.controls.settings(session.endpoint, session.thread_id, session.mapping_id);
      this.assertExactManaged(nickname, session.mapping_id);
      const baselineTurnId = options.onBeforeNativeDispatch && options.captureBaselineTurn === true
        ? (await this.pool.historyReader(session.endpoint, lease).latestTurn(session.thread_id))?.id ?? null
        : undefined;
      await options.onBeforeNativeDispatch?.({
        session,
        mode: "start",
        ...(baselineTurnId === undefined ? {} : { baselineTurnId }),
        ...(lease ? { lease } : {}),
      });
      this.assertExactManaged(nickname, session.mapping_id);
      const generation = this.endpointGeneration(session.endpoint, lease);
      const startToken = this.native.captureStart(this.nativeIdentity(session), generation);
      const response = await this.pool.startTurn<{ turn: { id: string; status?: string } }>(session.endpoint, {
        threadId: session.thread_id, cwd, ...(options.clientUserMessageId ? { clientUserMessageId: options.clientUserMessageId } : {}), input, ...settings,
      }, undefined, lease);
      options.onTurnAccepted?.({ session, mode: "start", turnId: response.turn.id });
      this.onTurnAccepted(session, response.turn.id);
      this.consumeSettingsIfNative(session.endpoint, session.thread_id, session.mapping_id, settings);
      const terminal = new Set(["completed", "failed", "interrupted"]).has(response.turn.status ?? "");
      if (terminal) {
        this.native.observe(session.endpoint, generation, "turn/completed", {
          threadId: session.thread_id,
          turn: response.turn,
        });
      } else if (this.native.applyStartResponse(startToken, response.turn.id) === "refresh-required") {
        await this.repairNative(session, lease);
      }
      return { mode: "start" as const, turnId: response.turn.id, terminal, appliedSettings: settings };
    });
  }

  // Returns the interrupted turn's id, or — when the session was busy with work that belongs
  // to no turn — a report of the background work stopped instead. The caller has to be able
  // to tell those apart: there is no turn id to name in the second case, and inventing one
  // would put a turn that never ran into the operation receipt.
  async interrupt(nickname: string, turnId?: string, options: {
    existingLease?: EndpointWorkLease;
    recoverExactTurn?: boolean;
    onBeforeNativeDispatch?(turnId: string): void;
    onBeforeBackgroundStop?(): void;
  } = {}): Promise<string | { stoppedBackgroundWork: number }> {
    const expected = this.registeredControl(nickname);
    return this.withMutationLease(expected.endpoint, (lease) => this.gate.run(expected.endpoint, expected.thread_id, async () => {
      const session = this.assertExactRegisteredControl(nickname, expected.mapping_id);
      const current = await this.currentNative(session, lease);
      let active = current.status === "active" ? current.activeTurnId ?? undefined : undefined;
      if (!active && current.status === "active" && options.recoverExactTurn && turnId) active = turnId;
      if (current.status === "active" && !active && current.backgroundWork) {
        // The session is busy with work that belongs to no turn: a Claude background command
        // or subagent still running after the turn that started it ended. Stopping that is the
        // only way back to idle, and therefore the only way to archive or restart the session —
        // there is no turn to interrupt, so refusing here left it busy with nothing able to
        // end it.
        //
        // Only a Claude endpoint ever reports background work, so this is not a capability
        // probe and a failure here is a real failure — reported as OPERATION_UNCERTAIN
        // rather than a "busy" code, because those are all classified as proving no effect
        // and would discard the checkpoint written a line above. Tasks may well have been
        // stopped before the response was lost.
        options.onBeforeBackgroundStop?.();
        const response = await this.pool.request<unknown>(
          session.endpoint, "thread/tasks/stop", { threadId: session.thread_id }, undefined, lease,
        ).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
        if (response instanceof Error) {
          throw new AppError("OPERATION_UNCERTAIN", `${nickname} background work may or may not have stopped`, { cause: response });
        }
        // An answer without the counts has not told us what the endpoint did.
        const stopped = backgroundStopReport(response);
        if (!stopped) throw new AppError("OPERATION_UNCERTAIN", `${nickname} reported no usable result for its background work`);
        if (stopped.remaining > 0) {
          // Some stopped and some did not: an effect was applied, so this must not be recorded
          // as a failure that proves nothing happened.
          if (stopped.stopped > 0) {
            throw new AppError("OPERATION_UNCERTAIN",
              `${nickname} stopped ${stopped.stopped} background task(s); ${stopped.remaining} did not stop`);
          }
          throw new AppError("SESSION_BUSY", `${nickname} has ${stopped.remaining} background task(s) that did not stop`);
        }
        // Nothing was running after all — the active belief was stale, and the endpoint has
        // just corrected it. There was no work to interrupt, which is SESSION_IDLE, not a
        // success reporting an interrupt that never happened.
        if (stopped.stopped === 0) throw new AppError("SESSION_IDLE", `${nickname} has no active turn`);
        return { stoppedBackgroundWork: stopped.stopped };
      }
      // Active, no turn named, and no background work to explain it: the identity really is
      // unresolved. This is the Codex case, and the refusal it has always given.
      if (current.status === "active" && !active) {
        throw new AppError("SESSION_BUSY", `${nickname} has an active turn whose identity is still being refreshed`);
      }
      if (!active && options.recoverExactTurn && turnId) {
        const target = await this.pool.historyReader(session.endpoint, lease).findTurn(
          session.thread_id, turnId, createHistoryScanBudget(),
        );
        if (target && isTerminalStatus(target.status) && options.recoverExactTurn) return turnId!;
        if (turnId && !target) throw new AppError("OPERATION_UNCERTAIN", `turn ${turnId} is not present in authoritative history`);
      }
      if (!active) throw new AppError("SESSION_IDLE", `${nickname} has no active turn`);
      if (turnId && turnId !== active) throw new AppError("OPERATION_CONFLICT", `active turn is ${active}, not ${turnId}`);
      this.assertExactRegisteredControl(nickname, expected.mapping_id);
      options.onBeforeNativeDispatch?.(String(active));
      await this.pool.interrupt(session.endpoint, session.thread_id, active, lease);
      this.native.observe(session.endpoint, this.endpointGeneration(session.endpoint, lease), "turn/completed", {
        threadId: session.thread_id,
        turn: { id: active, status: "interrupted" },
      });
      return String(active);
    }), options.existingLease);
  }

  async compact(nickname: string, options: {
    onBeforeNativeDispatch?(evidence: {
      endpointId: string;
      threadId: string;
      mappingId: string;
      baselineCompactionItemIds: string[];
      baselineTurnId: string | null;
    }): void;
  } = {}): Promise<{ compactionItemId: string; baselineCompactionItemIds: string[] }> {
    return this.runVerifiedExecution(nickname, async (session, _cwd, lease) => {
      const before = await this.readWithTurns(session.endpoint, session.thread_id, lease);
      if (before.thread.status?.type === "active" || before.thread.turns.some((turn: any) => !isTerminalStatus(turn.status))) {
        throw new AppError("SESSION_BUSY", `${nickname} has an active turn`);
      }
      const baselineTurnId = before.thread.turns.at(-1)?.id ?? null;
      const baselineCompactionItemIds: string[] = [];
      options.onBeforeNativeDispatch?.({
        endpointId: session.endpoint,
        threadId: session.thread_id,
        mappingId: session.mapping_id,
        baselineCompactionItemIds,
        baselineTurnId,
      });
      await this.pool.request(session.endpoint, "thread/compact/start", { threadId: session.thread_id }, undefined, lease);
      const compactionItemId = await waitForCompactionEvidence(async () => (
        await this.compactionItemIdsAfter(session.endpoint, session.thread_id, baselineTurnId, lease)
      )[0]);
      if (!compactionItemId) throw new AppError("OPERATION_UNCERTAIN", `compaction completion is not yet visible for ${nickname}`);
      return { compactionItemId, baselineCompactionItemIds };
    });
  }

  async compactionItemIdsAfter(
    endpointId: string,
    threadId: string,
    baselineTurnId: string | null,
    lease?: EndpointWorkLease,
  ): Promise<string[]> {
    const reader = this.pool.historyReader(endpointId, lease);
    const budget = createHistoryScanBudget();
    const suffix = await reader.descendingSuffix(threadId, baselineTurnId ?? undefined, budget);
    if (baselineTurnId && !suffix.anchorFound) {
      throw new AppError("OPERATION_UNCERTAIN", "compaction baseline turn is absent from authoritative history");
    }
    const ids: string[] = [];
    for (const turn of [...suffix.turns].reverse()) {
      const exact = await reader.exactTurnItems(threadId, turn.id, { budget });
      ids.push(...exact.items.filter((item) => item.type === "contextCompaction").map((item) => item.id));
    }
    return ids;
  }

  activeTurnId(nickname: string): string {
    const session = this.managed(nickname);
    const turnId = this.native.view(this.nativeIdentity(session))?.activeTurnId ?? undefined;
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
    const read = async (lease?: EndpointWorkLease): Promise<unknown> => {
      const current = this.native.view(this.nativeIdentity(session));
      const generation = lease?.endpointGeneration ?? this.safeEndpointGeneration(session.endpoint);
      const ready = current?.availability === "ready" && current.endpointGeneration === generation;
      const nativeStatus = ready ? current.status : "unknown";
      const activeTurnId = ready ? current.activeTurnId : null;
      options.observeNative?.({ nativeStatus, activeTurnId });
      const goal = await this.getGoal(nickname, lease);
      return {
        nickname,
        identity: { endpoint: session.endpoint, threadId: session.thread_id, projectDir: session.project_dir },
        managementState: session.lifecycle_state,
        nativeStatus,
        activeTurnId,
        goal: goal && typeof goal === "object" && "goal" in goal ? (goal as any).goal : goal ?? null,
      };
    };
    return this.endpoints
      ? this.endpoints.withWorkLease(session.endpoint, "rpc", (_endpoint, lease) => read(lease))
      : read();
  }

  async refreshNativeState(nickname: string, expectedLifecycleRevision?: number): Promise<void> {
    const session = this.required(nickname);
    await this.withMutationLease(
      session.endpoint,
      (lease) => this.repairNative(session, lease, expectedLifecycleRevision),
    );
  }

  async models(endpointId: string): Promise<unknown> { return { data: await this.listModels(endpointId), nextCursor: null }; }

  async setModel(nickname: string, model: string): Promise<void> {
    const session = this.managed(nickname);
    await this.setModelForIdentity(session.endpoint, session.thread_id, session.mapping_id, model);
  }

  async setEffort(nickname: string, effort: string): Promise<void> {
    const session = this.managed(nickname);
    await this.setEffortForIdentity(session.endpoint, session.thread_id, session.mapping_id, effort);
  }

  async setModelForIdentity(endpointId: string, threadId: string, mappingId: string, model: string): Promise<void> {
    const available = await this.listModels(endpointId);
    if (!available.some((candidate) => candidate.id === model || candidate.model === model)) throw new AppError("UNSUPPORTED_CAPABILITY", `unknown model for ${endpointId}: ${model}`);
    this.controls.setModel(endpointId, threadId, mappingId, model);
  }

  async setEffortForIdentity(endpointId: string, threadId: string, mappingId: string, effort: string): Promise<void> {
    const available = await this.listModels(endpointId);
    const pendingModel = this.controls.settings(endpointId, threadId, mappingId).model;
    const configuredModel = pendingModel ?? this.observedSettings(endpointId, threadId, mappingId).model;
    if (!configuredModel) {
      throw new AppError("ENDPOINT_UNAVAILABLE", `current model is unavailable for ${endpointId}/${threadId}; set a model first`);
    }
    const model = available.find((candidate) =>
      candidate.id === configuredModel || candidate.model === configuredModel);
    if (!model) {
      throw new AppError("UNSUPPORTED_CAPABILITY", `current model is unavailable on ${endpointId}: ${configuredModel}`);
    }
    if (model?.supportedReasoningEfforts && !model.supportedReasoningEfforts.some((candidate: any) => candidate.reasoningEffort === effort || candidate === effort)) {
      throw new AppError("UNSUPPORTED_CAPABILITY", `reasoning effort ${effort} is not supported by ${model.id ?? model.model}`);
    }
    this.controls.setEffort(endpointId, threadId, mappingId, effort);
  }

  // Consume the pending model/effort ONLY when the endpoint's backend persists them itself
  // (Codex app-server). For Claude they are sticky (no server), so this is a no-op and the
  // value re-applies every turn. Shared by the live send AND the crashed-send recovery path
  // (production-app) so the two consume sites can never diverge on the provider guard.
  consumeSettingsIfNative(endpointId: string, threadId: string, mappingId: string, settings: { model?: string; effort?: string }): void {
    if (this.settingsPersistNatively(endpointId)) this.controls.consumeSettings(endpointId, threadId, mappingId, settings);
  }

  getGoal(nickname: string, lease?: EndpointWorkLease): Promise<unknown> {
    const session = this.required(nickname);
    return this.pool.request(session.endpoint, "thread/goal/get", { threadId: session.thread_id }, undefined, lease);
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
        await onAuthoritativeMismatch?.();
      }
      throw error;
    }
  }

  private runVerifiedExecution<T>(nickname: string, mutate: (session: RegistrySession, cwd: string, lease?: EndpointWorkLease) => Promise<T>): Promise<T> {
    const expected = this.managed(nickname);
    return this.withMutationLease(expected.endpoint, (lease) => this.gate.run(expected.endpoint, expected.thread_id, async () => {
      const session = this.assertExactManaged(nickname, expected.mapping_id);
      const native = await this.currentNative(session, lease);
      this.assertMutationNativeState(nickname, native.status);
      const project = await this.prepareExisting(session.endpoint, session.project_dir, lease);
      await this.assertDispatchable(session.endpoint, project, lease);
      if (project.path !== session.project_dir) throw new AppError("CWD_MISMATCH", "managed thread cwd changed");
      this.assertExactManaged(nickname, expected.mapping_id);
      return mutate(session, project.path, lease);
    }));
  }

  private assertMutationNativeState(nickname: string, status: unknown): void {
    const type = typeof status === "string"
      ? status
      : status && typeof status === "object" && !Array.isArray(status)
        ? (status as { type?: unknown }).type
        : undefined;
    if (type === "error" || type === "systemError") {
      throw new AppError("ENDPOINT_UNAVAILABLE", `${nickname} native session is in an error state`);
    }
  }

  private withMutationLease<T>(endpointId: string, run: (lease?: EndpointWorkLease) => Promise<T>, existingLease?: EndpointWorkLease): Promise<T> {
    if (!this.endpoints) return run(existingLease);
    return existingLease
      ? this.endpoints.runWithWorkLease(endpointId, existingLease, run)
      : this.endpoints.withWorkLease(endpointId, "session-mutation", (_endpoint, lease) => run(lease));
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
    return session;
  }

  private assertExactRegisteredControl(nickname: string, mappingId: string): RegistrySession {
    const session = this.registry.get(nickname);
    if (!session || session.mapping_id !== mappingId || session.lifecycle_state !== "managed") {
      throw new AppError("SESSION_DETACHED", `${nickname} mapping changed or is not managed`);
    }
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
    const found = this.registry.getByIdentity(endpointId, threadId);
    if (!found) throw new AppError("UNKNOWN_SESSION", `unknown managed thread: ${endpointId}/${threadId}`);
    const current = await this.currentNative(found.session, lease);
    const latest = await this.pool.historyReader(endpointId, lease).latestTurn(threadId);
    const turns = latest ? [latest] : [];
    return {
      thread: {
        id: threadId,
        cwd: found.session.project_dir,
        status: { type: current.status },
        turns,
      },
    };
  }

  private required(nickname: string) {
    const session = this.registry.get(nickname);
    if (!session) throw new AppError("UNKNOWN_SESSION", `unknown session: ${nickname}`);
    return session;
  }

  private managed(nickname: string) {
    const session = this.required(nickname);
    if (session.lifecycle_state !== "managed") throw new AppError("SESSION_DETACHED", `${nickname} is not managed`);
    return session;
  }

  private registeredControl(nickname: string): RegistrySession {
    const session = this.required(nickname);
    return this.assertExactRegisteredControl(nickname, session.mapping_id);
  }

  private nativeIdentity(session: Pick<RegistrySession, "endpoint" | "thread_id" | "mapping_id">): NativeSessionIdentity {
    return { endpointId: session.endpoint, threadId: session.thread_id, mappingId: session.mapping_id };
  }

  private endpointGeneration(endpointId: string, lease?: EndpointWorkLease): number {
    return lease?.endpointGeneration ?? this.pool.endpointGeneration(endpointId).generation;
  }

  private async currentNative(session: RegistrySession, lease?: EndpointWorkLease): Promise<NativeSessionView> {
    const generation = this.endpointGeneration(session.endpoint, lease);
    const current = this.native.view(this.nativeIdentity(session));
    if (!current || current.availability !== "ready" || current.endpointGeneration !== generation) {
      throw new AppError("ENDPOINT_UNAVAILABLE", `native session generation is unavailable: ${session.endpoint}/${session.thread_id}`);
    }
    // Background work names no turn by design, so it is not a missing identity to repair.
    const repaired = current.status === "active" && current.activeTurnId === null && !current.backgroundWork
      ? await this.repairNative(session, lease)
      : current;
    if (repaired.status === "unknown") {
      throw new AppError("ENDPOINT_UNAVAILABLE", `native session state is unknown: ${session.endpoint}/${session.thread_id}`);
    }
    return repaired;
  }

  private async repairNative(
    session: RegistrySession,
    lease?: EndpointWorkLease,
    expectedLifecycleRevision?: number,
  ): Promise<NativeSessionView> {
    const identity = this.nativeIdentity(session);
    const generation = this.endpointGeneration(session.endpoint, lease);
    await repairActiveTurnIdentity({
      native: this.native,
      identity,
      endpointGeneration: generation,
      latestTurn: () => this.pool.historyReader(session.endpoint, lease).latestTurn(session.thread_id),
      ...(expectedLifecycleRevision === undefined ? {} : { expectedLifecycleRevision }),
    });
    const current = this.native.view(identity);
    if (!current || current.endpointGeneration !== generation || current.availability !== "ready") {
      throw new AppError("ENDPOINT_UNAVAILABLE", `native session generation changed: ${session.endpoint}/${session.thread_id}`);
    }
    return current;
  }

  private safeEndpointGeneration(endpointId: string): number {
    try { return this.pool.endpointGeneration(endpointId).generation; }
    catch { return -1; }
  }
}

export function requireCompactionItemIds(thread: { turns?: any[] }): string[] {
  const turns = thread.turns ?? [];
  if (turns.some((turn) => turn.itemsView !== "full" || !Array.isArray(turn.items))) {
    throw new AppError("OPERATION_CONFLICT", "full native history is required to reconcile compaction");
  }
  return turns.flatMap((turn) => turn.items
    .filter((item: any) => item?.type === "contextCompaction" && typeof item.id === "string")
    .map((item: any) => String(item.id)));
}

function isTerminalStatus(status: unknown): boolean {
  const type = typeof status === "string" ? status : String((status as any)?.type ?? "");
  return new Set(["completed", "failed", "interrupted"]).has(type);
}

// A background-work stop is only believable when the endpoint reports both counts: how many
// stopped, and — the one that decides whether the session may now be archived or restarted —
// how many are still running. Anything else is an endpoint that does not implement this.
export function backgroundStopReport(value: unknown): { stopped: number; remaining: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { stopped, remaining } = value as { stopped?: unknown; remaining?: unknown };
  if (!Number.isInteger(stopped) || !Number.isInteger(remaining)) return undefined;
  return { stopped: stopped as number, remaining: remaining as number };
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
