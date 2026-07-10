import type { AttachmentStore, FileHandleId } from "../attachments/store.ts";
import { TurnIdentityConflictError } from "../app-server/pool.ts";
import type { AppServerPool, TurnCapacityClaim } from "../app-server/pool.ts";
import { JsonRpcResponseError } from "../app-server/json-rpc-client.ts";
import { AppError } from "../core/errors.ts";
import type { CanonicalChatSource } from "../core/types.ts";
import type { AssistantLease, ChatAcceptanceEffects, ConversationStore, ReservedSubmission } from "../storage/conversation-store.ts";
import type { AssistantScheduler } from "./scheduler.ts";

export interface TurnSnapshot {
  id: string;
  status: string;
  itemsView: "full" | "summary" | "notLoaded";
  items: Array<{ type: string; clientId?: string | null }>;
}

export interface ThreadSnapshot {
  status?: string | { type?: string };
  turns: TurnSnapshot[];
}

export interface TurnStartParams {
  threadId: string;
  clientUserMessageId: string;
  input: unknown[];
}

export interface TurnSteerParams extends TurnStartParams {
  expectedTurnId: string;
}

export interface AssistantTurnPort {
  start(params: TurnStartParams, claim: TurnCapacityClaim): Promise<{ turn: TurnSnapshot }>;
  steer(params: TurnSteerParams): Promise<{ turnId: string }>;
  readThread(): Promise<ThreadSnapshot>;
}

interface DispatcherOptions {
  endpointId: string;
  threadId: string;
  attachments?: AttachmentStore;
  membershipObserver?: { notifyMembership(contextId: string): void };
  runtimeObserver?: { hydrateActive(): unknown; beginTerminalizing?(turnId: string): unknown };
  onDeferredTerminal?: (turn: TurnSnapshot) => void;
  scheduler?: AssistantScheduler;
  retryMs?: number;
  onOperationalEvent?: (event: DispatcherOperationalEvent) => void;
}

export type DispatcherOperationalEvent =
  | "assistant_turn_started"
  | "assistant_turn_steered"
  | "assistant_submission_uncertain"
  | "assistant_turn_terminal";

export class ConversationDispatcher {
  private tail: Promise<void> = Promise.resolve();
  private networkCount = 0;
  private readonly idleWaiters = new Set<() => void>();
  private readonly earlyTerminals = new Map<string, TurnSnapshot>();
  private earlyTerminalAttemptId: string | undefined;
  private deferredTerminal: { attemptId: string; turn: TurnSnapshot } | undefined;
  private readonly unsubscribeCapacity: () => void;
  private capacityWaiting = false;
  private pumpPaused = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryGeneration = 0;
  private nativeSubmissionCount = 0;
  private inFlightStartAttemptId: string | undefined;
  private eventWakeTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly store: ConversationStore,
    private readonly pool: AppServerPool,
    private readonly runner: AssistantTurnPort,
    private readonly options: DispatcherOptions,
  ) {
    this.unsubscribeCapacity = pool.onCapacityAvailable(() => {
      if (!this.capacityWaiting || this.stopped) return;
      this.capacityWaiting = false;
      this.cancelRetry();
      void this.post(() => this.pump());
    });
  }

  accept(source: CanonicalChatSource, effects: ChatAcceptanceEffects = {}): Promise<void> {
    return this.post(() => {
      this.pumpPaused = false;
      this.store.acceptChatSource(source, effects);
      this.pump();
    });
  }

  enqueueInternal(_contextId: string): Promise<void> {
    return this.post(() => { this.pumpPaused = false; this.pump(); });
  }

  started(turn: TurnSnapshot): Promise<void> {
    return this.post(() => {
      const correlated = this.correlatedUnresolvedStart(turn);
      if (!correlated) return;
      const early = this.takeEarlyTerminal(correlated.attemptId, turn.id);
      const leaseBefore = this.store.lease();
      const confirmation = this.confirmNotifiedStart(correlated, turn, !!early);
      if (confirmation === "conflict") {
        this.pauseIdentityConflict(correlated.attemptId);
        return;
      }
      if (confirmation === "bound") {
        this.options.onOperationalEvent?.("assistant_turn_started");
        this.options.membershipObserver?.notifyMembership(correlated.contextId);
      }
      this.options.runtimeObserver?.hydrateActive();
      if (early) {
        if (confirmation === "bound") this.noteConversationPeriod(leaseBefore);
        this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, turn.id);
        this.options.runtimeObserver?.beginTerminalizing?.(turn.id);
        if (confirmation === "bound") this.options.onOperationalEvent?.("assistant_turn_terminal");
        this.options.onDeferredTerminal?.(early);
      } else if (confirmation !== "already_terminal_same") this.pump();
    });
  }

  terminal(turn: TurnSnapshot): Promise<void> {
    return this.post(() => {
      this.pumpPaused = false;
      const lease = this.store.lease();
      if (lease?.turnId === turn.id) {
        this.noteConversationPeriod(lease);
        this.store.beginTerminalizing(turn.id);
        this.options.runtimeObserver?.beginTerminalizing?.(turn.id);
        this.options.onOperationalEvent?.("assistant_turn_terminal");
        if (this.hasUnresolvedSubmission(lease.attemptId)) this.deferredTerminal = { attemptId: lease.attemptId, turn };
        this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, turn.id);
        return;
      }
      if (lease?.phase !== "starting") return;
      const inFlight = this.inFlightStartAttemptId === lease.attemptId;
      const submission = inFlight
        ? this.unresolvedStart(lease)
        : this.correlatedUnresolvedStart(turn);
      if (!submission) return;
      const newlyUncertain = this.store.observeUnknownStartTerminal(submission.attemptId, submission.contextId);
      if (newlyUncertain) {
        this.options.membershipObserver?.notifyMembership(submission.contextId);
        this.options.onOperationalEvent?.("assistant_submission_uncertain");
      }
      if (inFlight) this.bufferEarlyTerminal(lease.attemptId, turn);
    });
  }

  recover(): Promise<void> {
    return this.post(() => {
      this.cancelRecovery();
      if (this.nativeSubmissionCount > 0) {
        this.scheduleRecovery();
        return;
      }
      const recoveryGeneration = ++this.recoveryGeneration;
      this.pumpPaused = false;
      const lease = this.store.lease();
      if (lease) {
        const claim = this.pool.restoreTurnCapacityClaim(this.options.endpointId, this.options.threadId, lease.capacityClaimId, {
          phase: lease.turnId ? "active" : "provisional",
          ...(lease.turnId ? { turnId: lease.turnId } : {}),
        });
        const members = this.store.membersForAttempt(lease.attemptId);
        const unresolved = members.find((member) => new Set(["start_submitting", "steer_submitting", "uncertain"]).has(member.state));
        const unknownTerminal = lease.phase === "starting" && lease.pauseReason === "unknown_terminal_observed";
        if (unresolved && !unknownTerminal) {
          if (unresolved.state !== "uncertain") this.store.markUncertain(lease.attemptId, unresolved.contextId);
          const submission = this.store.submissionFor(lease.attemptId, unresolved.contextId)!;
          this.launch(
            this.runner.readThread(),
            (thread) => {
              if (recoveryGeneration !== this.recoveryGeneration) return;
              this.reconcileSubmission(submission, submission.submissionKind === "start" ? claim : undefined, thread);
              const current = this.store.membersForAttempt(lease.attemptId)
                .find((member) => member.contextId === unresolved.contextId);
              if (current && this.shouldRetryUnresolved(current)) this.scheduleRecovery();
            },
            () => { if (recoveryGeneration === this.recoveryGeneration) this.scheduleRecovery(); },
          );
        } else if (lease.phase === "starting" && members.length === 0) {
          this.launchStart(this.store.reserveStart(lease.primaryContextId), claim, recoveryGeneration);
        } else if (lease.turnId && (lease.phase === "active" || lease.phase === "terminalizing")) {
          this.launch(
            this.runner.readThread(),
            (thread) => {
              if (recoveryGeneration !== this.recoveryGeneration) return;
              const turn = thread.turns.find((candidate) => candidate.id === lease.turnId);
              if (!turn || !isTerminal(turn.status)) {
                if (lease.phase === "terminalizing") this.scheduleRecovery();
                return;
              }
              this.noteConversationPeriod();
              this.store.beginTerminalizing(turn.id);
              this.options.runtimeObserver?.beginTerminalizing?.(turn.id);
              this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, turn.id);
              this.options.onOperationalEvent?.("assistant_turn_terminal");
              this.options.onDeferredTerminal?.(turn);
            },
            () => { if (recoveryGeneration === this.recoveryGeneration) this.scheduleRecovery(); },
          );
        }
      }
      this.store.repairQueueNotices();
      if (!lease) this.pump();
    });
  }

  requestRecovery(): void {
    this.scheduleRecovery();
  }

  async idle(): Promise<void> {
    while (true) {
      await this.tail;
      await Promise.resolve();
      if (this.networkCount === 0) {
        await this.tail;
        if (this.networkCount === 0) return;
      }
      await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribeCapacity();
    this.cancelRetry();
    this.cancelRecovery();
    if (this.eventWakeTimer) clearTimeout(this.eventWakeTimer);
    const inFlightStart = this.inFlightStartAttemptId;
    this.inFlightStartAttemptId = undefined;
    if (inFlightStart) this.clearEarlyTerminals(inFlightStart);
    const lease = this.store.lease();
    if (lease) {
      const unresolved = this.store.membersForAttempt(lease.attemptId)
        .find((member) => new Set(["start_submitting", "steer_submitting"]).has(member.state));
      if (unresolved) {
        this.store.markUncertain(lease.attemptId, unresolved.contextId);
        this.options.membershipObserver?.notifyMembership(unresolved.contextId);
      }
    }
    await this.idle();
  }

  private pump(): void {
    if (this.stopped || this.networkCount > 0 || this.pumpPaused) return;
    const lease = this.store.lease();
    if (!lease) {
      const sourceCandidate = this.store.nextPendingCandidate();
      const eventCandidate = this.options.scheduler?.peekEligibleEventBatch();
      const chooseEvent = !!eventCandidate && (!sourceCandidate || eventCandidate.forced);
      const candidate = chooseEvent ? { kind: "internal" as const, contextId: eventCandidate!.batchId } : sourceCandidate;
      if (!candidate) {
        this.scheduleEventWake();
        return;
      }
      const claimId = `assistant:${candidate.contextId}`;
      let claim: TurnCapacityClaim;
      try {
        claim = this.pool.claimTurnCapacity(this.options.endpointId, this.options.threadId, claimId);
      } catch (error) {
        if (!(error instanceof AppError && error.code === "CAPACITY_EXCEEDED")) throw error;
        this.waitForCapacity();
        return;
      }
      let acquired: AssistantLease;
      try {
        acquired = chooseEvent
          ? this.store.materializeAndAcquireEventBatch(eventCandidate!, claim.id)
          : this.store.acquireLease(candidate, claim.id);
        if (chooseEvent) this.options.scheduler!.commitEventBatch(eventCandidate!.batchId, eventCandidate!.eventIds);
      } catch (error) {
        this.pool.releaseTurnCapacityClaim(claim);
        throw error;
      }
      let submission: ReservedSubmission;
      try {
        submission = this.store.reserveStart(acquired.primaryContextId);
      } catch (error) {
        this.pool.releaseTurnCapacityClaim(claim);
        this.store.clearLease(acquired.attemptId);
        throw error;
      }
      this.launchStart(submission, claim);
      return;
    }
    if (lease.phase !== "active" || lease.steerPaused) return;
    let submission: ReservedSubmission | undefined;
    try {
      submission = this.store.reserveNextSteer(lease.attemptId);
    } catch (error) {
      if (error instanceof AppError && error.code === "OPERATION_CONFLICT") return;
      throw error;
    }
    if (submission) this.launchSteer(submission, lease);
  }

  private launchStart(submission: ReservedSubmission, claim: TurnCapacityClaim, recoveryGeneration?: number): void {
    const params: TurnStartParams = {
      threadId: this.options.threadId,
      clientUserMessageId: submission.clientUserMessageId,
      input: this.input(submission),
    };
    if (this.inFlightStartAttemptId && this.inFlightStartAttemptId !== submission.attemptId) {
      throw new Error("another assistant start is already in flight");
    }
    this.inFlightStartAttemptId = submission.attemptId;
    this.options.runtimeObserver?.hydrateActive();
    this.launch(
      this.trackNativeSubmission(() => this.runner.start(params, claim)),
      (response) => {
        this.settleInFlightStart(submission.attemptId);
        if (recoveryGeneration !== undefined && recoveryGeneration !== this.recoveryGeneration) {
          this.clearEarlyTerminals(submission.attemptId);
          return;
        }
        const early = this.takeEarlyTerminal(submission.attemptId, response.turn.id);
        this.clearEarlyTerminals(submission.attemptId);
        const leaseBefore = this.store.lease();
        try {
          this.pool.bindTurnCapacityClaim(claim, response.turn.id);
        } catch (error) {
          const current = this.store.lease();
          if (current?.attemptId === submission.attemptId && current.turnId === response.turn.id) {
            // A lifecycle notification already bound the same exact identity.
          } else {
            this.pauseIdentityConflict(submission.attemptId);
            return;
          }
        }
        const terminal = !!early || isTerminal(response.turn.status);
        const confirmation = this.store.confirmStart(submission.attemptId, submission.contextId, response.turn.id, { terminal });
        if (confirmation === "conflict") {
          this.pauseIdentityConflict(submission.attemptId);
          return;
        }
        if (confirmation === "bound") {
          this.options.onOperationalEvent?.("assistant_turn_started");
          this.options.membershipObserver?.notifyMembership(submission.contextId);
        }
        this.options.runtimeObserver?.hydrateActive();
        if (terminal || confirmation === "already_terminal_same") {
          if (confirmation === "bound") this.noteConversationPeriod(leaseBefore);
          this.options.runtimeObserver?.beginTerminalizing?.(response.turn.id);
          this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, response.turn.id);
          if (confirmation !== "already_terminal_same") this.options.onOperationalEvent?.("assistant_turn_terminal");
          if (early || isTerminal(response.turn.status)) this.options.onDeferredTerminal?.(early ?? response.turn);
          return;
        }
        this.pump();
      },
      (error) => {
        this.settleInFlightStart(submission.attemptId);
        this.clearEarlyTerminals(submission.attemptId);
        if (recoveryGeneration !== undefined && recoveryGeneration !== this.recoveryGeneration) return;
        this.handleSubmissionFailure(submission, claim, error, recoveryGeneration);
      },
      () => this.finishNativeSubmission(),
    );
  }

  private launchSteer(submission: ReservedSubmission, lease: AssistantLease): void {
    const params: TurnSteerParams = {
      threadId: this.options.threadId,
      expectedTurnId: lease.turnId!,
      clientUserMessageId: submission.clientUserMessageId,
      input: this.input(submission),
    };
    this.launch(
      this.trackNativeSubmission(() => this.runner.steer(params)),
      (response) => {
        const confirmation = this.store.confirmSteer(submission.attemptId, submission.contextId, response.turnId);
        if (confirmation === "conflict") {
          this.pauseIdentityConflict(submission.attemptId);
          return;
        }
        if (confirmation === "bound") {
          this.options.onOperationalEvent?.("assistant_turn_steered");
        }
        this.options.membershipObserver?.notifyMembership(submission.contextId);
        this.options.runtimeObserver?.hydrateActive();
        if (confirmation === "already_terminal_same") this.resumeDeferredTerminal(submission.attemptId);
        else this.pump();
      },
      (error) => this.handleSubmissionFailure(submission, undefined, error),
      () => this.finishNativeSubmission(),
    );
  }

  private handleSubmissionFailure(submission: ReservedSubmission, claim: TurnCapacityClaim | undefined, error: unknown, recoveryGeneration?: number): void {
    if (error instanceof TurnIdentityConflictError && submission.submissionKind === "start") {
      this.pauseIdentityConflict(submission.attemptId);
      return;
    }
    if (this.isKnownNonSteerable(error) && submission.submissionKind === "steer") {
      const current = this.store.membersForAttempt(submission.attemptId).find((member) => member.contextId === submission.contextId);
      if (!current || !new Set(["steer_submitting", "uncertain"]).has(current.state)) return;
      this.store.restorePending(submission.attemptId, submission.contextId);
      this.options.membershipObserver?.notifyMembership(submission.contextId);
      if (this.store.lease()?.phase === "terminalizing") this.resumeDeferredTerminal(submission.attemptId);
      else this.store.pauseSteering(submission.attemptId, "native_turn_not_steerable");
      return;
    }
    const reconciliationGeneration = recoveryGeneration ?? ++this.recoveryGeneration;
    if (!this.store.markUncertainIfUnresolved(submission.attemptId, submission.contextId)) return;
    this.options.onOperationalEvent?.("assistant_submission_uncertain");
    this.launch(
      this.runner.readThread(),
      (thread) => {
        if (reconciliationGeneration !== this.recoveryGeneration) return;
        this.reconcileSubmission(submission, claim, thread);
        const current = this.store.membersForAttempt(submission.attemptId)
          .find((member) => member.contextId === submission.contextId);
        if (current && this.shouldRetryUnresolved(current)) this.scheduleRecovery();
      },
      () => {
        if (reconciliationGeneration === this.recoveryGeneration) this.scheduleRecovery();
      },
    );
  }

  private reconcileSubmission(submission: ReservedSubmission, claim: TurnCapacityClaim | undefined, thread: ThreadSnapshot): void {
    const positive = submission.submissionKind === "steer" && submission.expectedTurnId
      ? thread.turns.find((turn) => turn.id === submission.expectedTurnId
        && turn.items.some((item) => item.type === "userMessage" && item.clientId === submission.clientUserMessageId))
      : [...thread.turns].reverse().find((turn) =>
        turn.items.some((item) => item.type === "userMessage" && item.clientId === submission.clientUserMessageId));
    if (positive) {
      if (submission.submissionKind === "start") return;
      const confirmation = this.store.confirmSteer(submission.attemptId, submission.contextId, positive.id);
      if (confirmation === "conflict") return;
      if (confirmation === "bound") {
        this.options.onOperationalEvent?.("assistant_turn_steered");
      }
      this.options.membershipObserver?.notifyMembership(submission.contextId);
      this.options.runtimeObserver?.hydrateActive();
      if (isTerminal(positive.status)) {
        this.noteConversationPeriod(this.store.lease());
        this.store.beginTerminalizing(positive.id);
        this.options.runtimeObserver?.beginTerminalizing?.(positive.id);
        this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, positive.id);
        this.options.onOperationalEvent?.("assistant_turn_terminal");
        if (!this.resumeDeferredTerminal(submission.attemptId)) this.options.onDeferredTerminal?.(positive);
      } else if (confirmation === "already_terminal_same") {
        this.resumeDeferredTerminal(submission.attemptId);
      } else this.pump();
      return;
    }

    const allFull = thread.turns.every((turn) => turn.itemsView === "full");
    const expected = submission.expectedTurnId
      ? thread.turns.find((turn) => turn.id === submission.expectedTurnId)
      : undefined;
    const noActiveTurn = !thread.turns.some((turn) => !isTerminal(turn.status));
    const threadStatus = typeof thread.status === "string" ? thread.status : thread.status?.type;
    const provenAbsent = allFull && (submission.submissionKind === "steer"
      ? !!expected && isTerminal(expected.status)
      : noActiveTurn && threadStatus === "idle");
    if (submission.submissionKind === "start" && this.store.lease()?.pauseReason === "unknown_terminal_observed") return;
    if (!provenAbsent) return;

    this.store.restorePending(submission.attemptId, submission.contextId);
    this.options.membershipObserver?.notifyMembership(submission.contextId);
    if (submission.submissionKind === "steer" && expected && isTerminal(expected.status)) {
      this.noteConversationPeriod(this.store.lease());
      this.store.beginTerminalizing(expected.id);
      this.options.runtimeObserver?.beginTerminalizing?.(expected.id);
      this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, expected.id);
      if (!this.resumeDeferredTerminal(submission.attemptId)) this.options.onDeferredTerminal?.(expected);
    }
    if (claim) {
      this.pumpPaused = true;
      this.store.clearLease(submission.attemptId);
      this.pool.releaseTurnCapacityClaim(claim);
    }
  }

  private input(submission: ReservedSubmission): unknown[] {
    const input: unknown[] = [];
    const origin = originHeader(submission.binding);
    if (origin) input.push({ type: "text", text: origin, text_elements: [] });
    if (submission.rawText) input.push({ type: "text", text: submission.rawText, text_elements: [] });
    for (const failed of submission.failedAttachments) {
      const name = failed.displayName.replace(/[\u0000-\u001f\u007f\]]/gu, "_").trim().slice(0, 180) || "attachment";
      input.push({ type: "text", text: `[Slack attachment unavailable: ${name}]`, text_elements: [] });
    }
    if (submission.attachmentIds.length > 0) {
      if (!this.options.attachments) throw new AppError("ATTACHMENT_INVALID", "assistant attachment input is not configured");
      for (const id of submission.attachmentIds) {
        input.push(this.options.attachments.toUserInput(submission.contextId, id as FileHandleId));
      }
    }
    return input;
  }

  private launch<T>(promise: Promise<T>, success: (value: T) => void, failure: (error: unknown) => void, settled?: () => void): void {
    this.networkCount += 1;
    void promise.then(
      (value) => this.post(() => { if (!this.stopped) success(value); }),
      (error) => this.post(() => { if (!this.stopped) failure(error); }),
    ).finally(() => {
      settled?.();
      this.networkCount -= 1;
      if (this.networkCount === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
        if (!this.stopped) void this.post(() => this.pump());
      }
    });
  }

  private trackNativeSubmission<T>(start: () => Promise<T>): Promise<T> {
    this.nativeSubmissionCount += 1;
    try { return start(); }
    catch (error) { return Promise.reject(error); }
  }

  private finishNativeSubmission(): void {
    this.nativeSubmissionCount = Math.max(0, this.nativeSubmissionCount - 1);
  }

  private post(action: () => void): Promise<void> {
    const run = this.tail.then(() => { action(); });
    this.tail = run.catch(() => undefined);
    return run;
  }

  private waitForCapacity(): void {
    this.capacityWaiting = true;
    if (this.retryTimer || this.stopped) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.capacityWaiting || this.stopped) return;
      this.capacityWaiting = false;
      void this.post(() => this.pump());
    }, this.options.retryMs ?? 1_000);
  }

  private cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private scheduleRecovery(): void {
    if (this.recoveryTimer || this.stopped) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      if (!this.stopped) void this.recover();
    }, this.options.retryMs ?? 1_000);
    this.recoveryTimer.unref?.();
  }

  private cancelRecovery(): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  private scheduleEventWake(): void {
    if (this.eventWakeTimer || !this.options.scheduler || this.stopped) return;
    const wakeAt = this.options.scheduler.nextWakeAt();
    if (wakeAt === undefined) return;
    this.eventWakeTimer = setTimeout(() => {
      this.eventWakeTimer = undefined;
      if (!this.stopped) void this.post(() => this.pump());
    }, Math.max(0, wakeAt - Date.now()));
    this.eventWakeTimer.unref?.();
  }

  private isKnownNonSteerable(error: unknown): boolean {
    if (error instanceof AppError) return new Set(["SESSION_IDLE", "OPERATION_CONFLICT"]).has(error.code);
    if (!(error instanceof JsonRpcResponseError) || !error.data || typeof error.data !== "object") return false;
    const data = error.data as Record<string, unknown>;
    const info = data.codexErrorInfo && typeof data.codexErrorInfo === "object"
      ? data.codexErrorInfo as Record<string, unknown>
      : data;
    return Object.hasOwn(info, "activeTurnNotSteerable");
  }

  private correlatedUnresolvedStart(turn: TurnSnapshot): ReservedSubmission | undefined {
    const lease = this.store.lease();
    if (!lease || lease.phase !== "starting" || lease.turnId) return undefined;
    const submission = this.unresolvedStart(lease);
    if (!submission) return undefined;
    return turn.items.some((item) => item.type === "userMessage" && item.clientId === submission.clientUserMessageId)
      ? submission
      : undefined;
  }

  private unresolvedStart(lease: AssistantLease): ReservedSubmission | undefined {
    const submission = this.store.submissionFor(lease.attemptId, lease.primaryContextId);
    return submission?.submissionKind === "start" && new Set(["start_submitting", "uncertain"]).has(submission.state)
      ? submission
      : undefined;
  }

  private settleInFlightStart(attemptId: string): void {
    if (this.inFlightStartAttemptId === attemptId) this.inFlightStartAttemptId = undefined;
  }

  private shouldRetryUnresolved(member: { attemptId: string; submissionKind: "start" | "steer"; state: string }): boolean {
    if (!new Set(["start_submitting", "steer_submitting", "uncertain"]).has(member.state)) return false;
    const lease = this.store.lease();
    return !(member.submissionKind === "start" && lease?.attemptId === member.attemptId
      && lease.phase === "starting" && lease.pauseReason === "unknown_terminal_observed");
  }

  private confirmNotifiedStart(submission: ReservedSubmission, turn: TurnSnapshot, terminal: boolean) {
    const lease = this.store.lease();
    if (!lease || lease.attemptId !== submission.attemptId) return "conflict" as const;
    const claim = this.pool.restoreTurnCapacityClaim(this.options.endpointId, this.options.threadId, lease.capacityClaimId, { phase: "provisional" });
    try {
      this.pool.bindTurnCapacityClaim(claim, turn.id);
    } catch {
      return "conflict" as const;
    }
    const confirmation = this.store.confirmStart(submission.attemptId, submission.contextId, turn.id, { terminal });
    return confirmation;
  }

  private pauseIdentityConflict(attemptId: string): void {
    this.pumpPaused = true;
    const lease = this.store.lease();
    const unresolvedSteer = this.store.membersForAttempt(attemptId)
      .find((member) => member.submissionKind === "steer" && new Set(["steer_submitting", "uncertain"]).has(member.state));
    if (unresolvedSteer?.state === "steer_submitting" && this.store.markUncertainIfUnresolved(attemptId, unresolvedSteer.contextId)) {
      this.scheduleRecovery();
    }
    if (lease?.attemptId === attemptId && lease.phase === "active" && !lease.steerPaused) {
      this.store.pauseSteering(attemptId, "native_turn_identity_conflict");
    }
    this.options.onOperationalEvent?.("assistant_submission_uncertain");
  }

  private bufferEarlyTerminal(attemptId: string, turn: TurnSnapshot): void {
    if (this.earlyTerminalAttemptId !== attemptId) {
      this.earlyTerminals.clear();
      this.earlyTerminalAttemptId = attemptId;
    }
    this.earlyTerminals.set(turn.id, turn);
    if (this.earlyTerminals.size > 8) this.earlyTerminals.delete(this.earlyTerminals.keys().next().value!);
  }

  private takeEarlyTerminal(attemptId: string, turnId: string): TurnSnapshot | undefined {
    if (this.earlyTerminalAttemptId !== attemptId) return undefined;
    const turn = this.earlyTerminals.get(turnId);
    if (turn) this.clearEarlyTerminals(attemptId);
    return turn;
  }

  private clearEarlyTerminals(attemptId: string): void {
    if (this.earlyTerminalAttemptId !== attemptId) return;
    this.earlyTerminals.clear();
    this.earlyTerminalAttemptId = undefined;
  }

  private hasUnresolvedSubmission(attemptId: string): boolean {
    return this.store.membersForAttempt(attemptId)
      .some((member) => new Set(["start_submitting", "steer_submitting", "uncertain"]).has(member.state));
  }

  private resumeDeferredTerminal(attemptId: string): boolean {
    const deferred = this.deferredTerminal;
    if (!deferred || deferred.attemptId !== attemptId || this.hasUnresolvedSubmission(attemptId)) return false;
    this.deferredTerminal = undefined;
    this.options.onDeferredTerminal?.(deferred.turn);
    return true;
  }

  private noteConversationPeriod(lease: AssistantLease | undefined = this.store.lease()): void {
    if (lease?.phase !== "terminalizing" && lease?.binding) this.options.scheduler?.noteConversationPeriodCompleted();
  }
}

function originHeader(binding: ReservedSubmission["binding"]): string | undefined {
  if (!binding) return undefined;
  if (binding.adapterId === "telegram") return "[telegram]";
  if (binding.adapterId !== "slack") return `[${binding.adapterId}]`;
  const destination = typeof binding.destination === "object" && binding.destination !== null && !Array.isArray(binding.destination)
    ? binding.destination as Record<string, unknown>
    : undefined;
  if (typeof destination?.threadTs === "string") {
    return typeof destination.channelId === "string" ? `[slack ${destination.channelId} thread]` : "[slack thread]";
  }
  return "[slack dm]";
}

function isTerminal(status: string): boolean {
  return new Set(["completed", "failed", "interrupted"]).has(status);
}
