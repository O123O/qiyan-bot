import type { AttachmentStore, FileHandleId } from "../attachments/store.ts";
import { TurnIdentityConflictError } from "../app-server/pool.ts";
import type { AppServerPool, TurnCapacityClaim } from "../app-server/pool.ts";
import { JsonRpcResponseError } from "../app-server/json-rpc-client.ts";
import { AppError } from "../core/errors.ts";
import type { CanonicalChatSource } from "../core/types.ts";
import type { AssistantAttempt, ChatAcceptanceEffects, ConversationStore, ReservedSubmission } from "../storage/conversation-store.ts";
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
  historyWindow?: {
    exhausted: boolean;
    anchorTurnIds: string[];
  };
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
  start(
    params: TurnStartParams,
    claim: TurnCapacityClaim,
    checkpointBaseline: (baselineTurnId: string | null) => void,
  ): Promise<{ turn: TurnSnapshot }>;
  steer(params: TurnSteerParams): Promise<{ turnId: string }>;
  readThread(): Promise<ThreadSnapshot>;
}

interface DispatcherOptions {
  endpointId: string;
  threadId: string;
  attachments?: AttachmentStore;
  membershipObserver?: { notifyMembership(contextId: string): void };
  runtimeObserver?: { activateAttempt(attemptId: string): unknown; clearActive(): void; beginTerminalizing?(turnId: string): unknown };
  onTerminal?: (turn: TurnSnapshot) => void;
  scheduler?: AssistantScheduler;
  beforeStartAdmission?: () => Promise<void>;
  retryMs?: number;
  onOperationalEvent?: (event: DispatcherOperationalEvent) => void;
}

export type DispatcherOperationalEvent =
  | "assistant_turn_started"
  | "assistant_turn_steered"
  | "assistant_submission_uncertain"
  | "assistant_turn_terminal";

export class AssistantStartCheckpointError extends Error {
  constructor(cause: unknown) {
    super("assistant start dispatch checkpoint failed", { cause });
    this.name = "AssistantStartCheckpointError";
  }
}

export function checkpointAssistantStartDispatch(
  checkpointBaseline: (baselineTurnId: string | null) => void,
): void {
  try { checkpointBaseline(null); }
  catch (error) {
    throw error instanceof AssistantStartCheckpointError ? error : new AssistantStartCheckpointError(error);
  }
}

export class ConversationDispatcher {
  private tail: Promise<void> = Promise.resolve();
  private networkCount = 0;
  private readonly idleWaiters = new Set<() => void>();
  private readonly earlyTerminals = new Map<string, TurnSnapshot>();
  private readonly publishedTerminalIds = new Set<string>();
  private earlyTerminalAttemptId: string | undefined;
  private pumpPaused = false;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryGeneration = 0;
  private nativeSubmissionCount = 0;
  private readonly attemptSubmissionCounts = new Map<string, number>();
  private readonly attemptSubmissionWaiters = new Map<string, Set<() => void>>();
  private inFlightStartAttemptId: string | undefined;
  private eventWakeTimer: ReturnType<typeof setTimeout> | undefined;
  private admissionRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private startAdmissionInFlight = false;
  private startAdmissionGranted = false;
  private currentAttempt: AssistantAttempt | undefined;
  private nativeBusy = false;
  private steeringPause: { attemptId: string; reason: string } | undefined;
  private readonly provisionalClaims = new Map<string, TurnCapacityClaim>();
  private nativeRecoveryReady = false;
  private nativeRecoveryFailureCause: unknown;
  private nativeAuthorityGeneration = 0;
  private stopped = false;

  constructor(
    private readonly store: ConversationStore,
    private readonly pool: AppServerPool,
    private readonly runner: AssistantTurnPort,
    private readonly options: DispatcherOptions,
  ) {}

  accept(source: CanonicalChatSource, effects: ChatAcceptanceEffects = {}): Promise<void> {
    return this.post(() => {
      this.pumpPaused = false;
      this.store.acceptChatSource(source, effects, this.currentAttempt);
      this.pump();
    });
  }

  enqueueInternal(_contextId: string): Promise<void> {
    return this.post(() => { this.pumpPaused = false; this.pump(); });
  }

  waitForAttemptSubmissions(attemptId: string): Promise<void> {
    if (this.attemptSubmissionsSettled(attemptId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.attemptSubmissionWaiters.get(attemptId) ?? new Set<() => void>();
      waiters.add(resolve);
      this.attemptSubmissionWaiters.set(attemptId, waiters);
    });
  }

  started(turn: TurnSnapshot): Promise<void> {
    return this.post(() => {
      this.nativeRecoveryReady = true;
      this.nativeRecoveryFailureCause = undefined;
      this.recoveryGeneration += 1;
      this.cancelRecovery();
      this.nativeBusy = true;
      const correlated = this.correlatedUnresolvedStart(turn);
      if (!correlated) return;
      const early = this.takeEarlyTerminal(correlated.attemptId, turn.id);
      const attemptBefore = this.store.attempt(correlated.attemptId);
      const confirmation = this.confirmNotifiedStart(correlated, turn, !!early);
      if (confirmation === "conflict") {
        this.pauseIdentityConflict(correlated.attemptId);
        return;
      }
      if (confirmation === "bound") {
        this.currentAttempt = this.store.attempt(correlated.attemptId);
        this.options.onOperationalEvent?.("assistant_turn_started");
        this.options.membershipObserver?.notifyMembership(correlated.contextId);
      }
      if (!early && confirmation !== "already_terminal_same") {
        this.options.runtimeObserver?.activateAttempt(correlated.attemptId);
      }
      if (early) {
        if (confirmation === "bound") this.noteConversationPeriod(attemptBefore);
        this.currentAttempt = undefined;
        this.nativeBusy = false;
        this.steeringPause = undefined;
        this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, turn.id);
        this.options.runtimeObserver?.beginTerminalizing?.(turn.id);
        if (confirmation === "bound") this.options.onOperationalEvent?.("assistant_turn_terminal");
        this.publishTerminal(early);
      } else if (confirmation !== "already_terminal_same") this.pump();
    });
  }

  terminal(turn: TurnSnapshot): Promise<void> {
    return this.post(() => {
      this.nativeRecoveryReady = true;
      this.nativeRecoveryFailureCause = undefined;
      this.recoveryGeneration += 1;
      this.cancelRecovery();
      this.pumpPaused = false;
      const attempt = this.currentAttempt?.turnId === turn.id
        ? this.currentAttempt
        : this.store.attemptForTurn(turn.id);
      if (attempt?.turnId === turn.id && this.currentAttempt?.attemptId === attempt.attemptId) {
        this.noteConversationPeriod(attempt);
        this.store.beginTerminalizing(attempt.attemptId, turn.id);
        this.currentAttempt = undefined;
        this.nativeBusy = false;
        this.steeringPause = undefined;
        this.options.runtimeObserver?.beginTerminalizing?.(turn.id);
        this.options.onOperationalEvent?.("assistant_turn_terminal");
        this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, turn.id);
        this.publishTerminal(turn);
        return;
      }
      const starting = this.currentAttempt && !this.currentAttempt.turnId ? this.currentAttempt : undefined;
      if (!starting) {
        this.nativeBusy = false;
        this.pump();
        return;
      }
      const inFlight = this.inFlightStartAttemptId === starting.attemptId;
      const submission = inFlight
        ? this.unresolvedStart(starting)
        : this.correlatedUnresolvedStart(turn);
      if (!submission) return;
      const correlated = turn.items.some((item) => item.type === "userMessage" && item.clientId === submission.clientUserMessageId);
      if (correlated) {
        const confirmation = this.confirmNotifiedStart(submission, turn, true);
        if (confirmation === "conflict") {
          this.pauseIdentityConflict(submission.attemptId);
          return;
        }
        this.noteConversationPeriod(starting);
        this.currentAttempt = undefined;
        this.nativeBusy = false;
        this.steeringPause = undefined;
        this.options.runtimeObserver?.beginTerminalizing?.(turn.id);
        this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, turn.id);
        if (confirmation === "bound") {
          this.options.membershipObserver?.notifyMembership(submission.contextId);
          this.options.onOperationalEvent?.("assistant_turn_started");
          this.options.onOperationalEvent?.("assistant_turn_terminal");
        }
        this.publishTerminal(turn);
        return;
      }
      const newlyUncertain = this.store.observeUnknownStartTerminal(submission.attemptId, submission.contextId);
      if (newlyUncertain) {
        this.options.membershipObserver?.notifyMembership(submission.contextId);
        this.options.onOperationalEvent?.("assistant_submission_uncertain");
      }
      if (inFlight) this.bufferEarlyTerminal(starting.attemptId, turn);
    });
  }

  recover(): Promise<void> {
    return this.post(() => {
      this.publishedTerminalIds.clear();
      this.nativeRecoveryReady = false;
      this.nativeRecoveryFailureCause = undefined;
      this.cancelRecovery();
      if (this.nativeSubmissionCount > 0) {
        this.scheduleRecovery(Date.now() + (this.options.retryMs ?? 1_000));
        return;
      }
      const recoveryGeneration = ++this.recoveryGeneration;
      this.pumpPaused = false;
      this.store.repairQueueNotices();
      this.launch(
        this.runner.readThread(),
        (thread) => {
          if (recoveryGeneration !== this.recoveryGeneration) return;
          this.nativeRecoveryReady = true;
          this.nativeRecoveryFailureCause = undefined;
          this.reconcileRecoverySnapshot(thread);
        },
        (error) => {
          if (recoveryGeneration === this.recoveryGeneration) {
            this.nativeRecoveryFailureCause = error;
            this.reconcileRecoveryFailure();
          }
        },
      );
    });
  }

  requestRecovery(): void {
    this.scheduleRecovery();
  }

  isNativeRecoveryReady(): boolean { return this.nativeRecoveryReady; }

  nativeRecoveryFailure(): unknown { return this.nativeRecoveryFailureCause; }

  nativeUnavailable(): Promise<void> {
    return this.post(() => {
      this.recoveryGeneration += 1;
      this.nativeAuthorityGeneration += 1;
      this.cancelRecovery();
      this.nativeRecoveryReady = false;
      this.nativeRecoveryFailureCause = undefined;
      this.nativeBusy = true;
      this.currentAttempt = undefined;
      this.steeringPause = undefined;
      for (const claim of this.provisionalClaims.values()) this.pool.releaseTurnCapacityClaim(claim);
      this.provisionalClaims.clear();
      this.options.runtimeObserver?.clearActive();
    });
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
    this.cancelRecovery();
    if (this.admissionRetryTimer) clearTimeout(this.admissionRetryTimer);
    this.admissionRetryTimer = undefined;
    if (this.eventWakeTimer) clearTimeout(this.eventWakeTimer);
    const inFlightStart = this.inFlightStartAttemptId;
    this.inFlightStartAttemptId = undefined;
    if (inFlightStart) this.clearEarlyTerminals(inFlightStart);
    const attempt = this.currentAttempt;
    if (attempt) {
      const unresolved = this.store.membersForAttempt(attempt.attemptId)
        .find((member) => new Set(["start_submitting", "steer_submitting"]).has(member.state));
      if (unresolved) {
        this.store.markUncertain(attempt.attemptId, unresolved.contextId);
        this.options.membershipObserver?.notifyMembership(unresolved.contextId);
      }
    }
    await this.idle();
  }

  private pump(): void {
    if (this.stopped || this.networkCount > 0 || this.pumpPaused || this.nativeBusy && !this.currentAttempt) return;
    const attempt = this.currentAttempt;
    if (!attempt) {
      const sourceCandidate = this.store.nextPendingCandidate();
      const eventCandidate = this.options.scheduler?.peekEligibleEventBatch();
      const chooseEvent = !!eventCandidate && (!sourceCandidate || eventCandidate.forced);
      const candidate = chooseEvent ? { kind: "internal" as const, contextId: eventCandidate!.batchId } : sourceCandidate;
      if (!candidate) {
        this.scheduleEventWake();
        return;
      }
      if (this.options.beforeStartAdmission && !this.startAdmissionGranted) {
        if (this.admissionRetryTimer) return;
        if (this.startAdmissionInFlight) return;
        this.startAdmissionInFlight = true;
        this.launch(
          this.options.beforeStartAdmission(),
          () => { this.startAdmissionInFlight = false; this.startAdmissionGranted = true; },
          () => { this.startAdmissionInFlight = false; this.scheduleAdmissionRetry(); },
        );
        return;
      }
      this.startAdmissionGranted = false;
      const claimId = `assistant:${candidate.contextId}`;
      const claim = this.pool.claimTurnCapacity(this.options.endpointId, this.options.threadId, claimId);
      let acquired: AssistantAttempt;
      try {
        acquired = chooseEvent
          ? this.store.materializeAndCreateEventAttempt(eventCandidate!)
          : this.store.createAttempt(candidate);
        if (chooseEvent) this.options.scheduler!.commitEventBatch(eventCandidate!.batchId, eventCandidate!.eventIds);
      } catch (error) {
        this.pool.releaseTurnCapacityClaim(claim);
        throw error;
      }
      this.currentAttempt = acquired;
      this.nativeBusy = true;
      this.provisionalClaims.set(acquired.attemptId, claim);
      let submission: ReservedSubmission;
      try {
        submission = this.store.reserveStart(acquired.attemptId, acquired.primaryContextId);
      } catch (error) {
        this.currentAttempt = undefined;
        this.nativeBusy = false;
        this.provisionalClaims.delete(acquired.attemptId);
        this.pool.releaseTurnCapacityClaim(claim);
        this.store.failUnstartedAttempt(acquired.attemptId);
        throw error;
      }
      this.launchStart(submission, claim);
      return;
    }
    if (!attempt.turnId || !attempt.acceptingTools || this.steeringPause?.attemptId === attempt.attemptId) return;
    let submission: ReservedSubmission | undefined;
    try {
      submission = this.store.reserveNextSteer(attempt.attemptId);
    } catch (error) {
      if (error instanceof AppError && error.code === "OPERATION_CONFLICT") return;
      throw error;
    }
    if (submission) this.launchSteer(submission, attempt);
  }

  private launchStart(submission: ReservedSubmission, claim: TurnCapacityClaim, recoveryGeneration?: number): void {
    const nativeAuthorityGeneration = this.nativeAuthorityGeneration;
    const params: TurnStartParams = {
      threadId: this.options.threadId,
      clientUserMessageId: submission.clientUserMessageId,
      input: this.input(submission),
    };
    if (this.inFlightStartAttemptId && this.inFlightStartAttemptId !== submission.attemptId) {
      throw new Error("another assistant start is already in flight");
    }
    this.inFlightStartAttemptId = submission.attemptId;
    this.options.runtimeObserver?.activateAttempt(submission.attemptId);
    this.launch(
      this.trackNativeSubmission(submission.attemptId, () => this.runner.start(params, claim, (baselineTurnId) => {
        this.store.checkpointSubmissionBaseline(submission.attemptId, submission.contextId, baselineTurnId);
      })),
      (response) => {
        this.settleInFlightStart(submission.attemptId);
        if (nativeAuthorityGeneration !== this.nativeAuthorityGeneration) {
          this.clearEarlyTerminals(submission.attemptId);
          this.handleSubmissionFailure(submission, claim, new AppError("OPERATION_UNCERTAIN", "assistant endpoint generation changed during turn/start"));
          return;
        }
        if (recoveryGeneration !== undefined && recoveryGeneration !== this.recoveryGeneration) {
          this.clearEarlyTerminals(submission.attemptId);
          return;
        }
        const early = this.takeEarlyTerminal(submission.attemptId, response.turn.id);
        this.clearEarlyTerminals(submission.attemptId);
        const attemptBefore = this.store.attempt(submission.attemptId);
        try {
          this.pool.bindTurnCapacityClaim(claim, response.turn.id);
          this.provisionalClaims.delete(submission.attemptId);
        } catch (error) {
          const current = this.store.attempt(submission.attemptId);
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
          this.currentAttempt = this.store.attempt(submission.attemptId);
          this.options.onOperationalEvent?.("assistant_turn_started");
          this.options.membershipObserver?.notifyMembership(submission.contextId);
        }
        if (!terminal && confirmation !== "already_terminal_same") {
          this.options.runtimeObserver?.activateAttempt(submission.attemptId);
        }
        if (terminal || confirmation === "already_terminal_same") {
          if (confirmation === "bound") this.noteConversationPeriod(attemptBefore);
          this.currentAttempt = undefined;
          this.nativeBusy = false;
          this.steeringPause = undefined;
          if (confirmation !== "already_terminal_same") {
            this.options.runtimeObserver?.beginTerminalizing?.(response.turn.id);
            this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, response.turn.id);
            this.options.onOperationalEvent?.("assistant_turn_terminal");
          }
          if (early || isTerminal(response.turn.status)) this.publishTerminal(early ?? response.turn);
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
      () => this.finishNativeSubmission(submission.attemptId),
    );
  }

  private launchSteer(submission: ReservedSubmission, attempt: AssistantAttempt): void {
    const nativeAuthorityGeneration = this.nativeAuthorityGeneration;
    const params: TurnSteerParams = {
      threadId: this.options.threadId,
      expectedTurnId: attempt.turnId!,
      clientUserMessageId: submission.clientUserMessageId,
      input: this.input(submission),
    };
    this.launch(
      this.trackNativeSubmission(submission.attemptId, () => this.runner.steer(params)),
      (response) => {
        if (nativeAuthorityGeneration !== this.nativeAuthorityGeneration) {
          this.handleSubmissionFailure(submission, undefined, new AppError("OPERATION_UNCERTAIN", "assistant endpoint generation changed during turn/steer"));
          return;
        }
        const confirmation = this.store.confirmSteer(submission.attemptId, submission.contextId, response.turnId);
        if (confirmation === "conflict") {
          this.pauseIdentityConflict(submission.attemptId);
          return;
        }
        if (confirmation === "bound") {
          this.options.onOperationalEvent?.("assistant_turn_steered");
        }
        this.options.membershipObserver?.notifyMembership(submission.contextId);
        this.options.runtimeObserver?.activateAttempt(submission.attemptId);
        this.pump();
      },
      (error) => this.handleSubmissionFailure(submission, undefined, error),
      () => this.finishNativeSubmission(submission.attemptId),
    );
  }

  private handleSubmissionFailure(submission: ReservedSubmission, claim: TurnCapacityClaim | undefined, error: unknown, recoveryGeneration?: number): void {
    if (error instanceof AssistantStartCheckpointError && submission.submissionKind === "start" && claim) {
      this.pumpPaused = true;
      this.store.restorePending(submission.attemptId, submission.contextId);
      this.store.failUnstartedAttempt(submission.attemptId);
      this.currentAttempt = undefined;
      this.nativeBusy = false;
      this.provisionalClaims.delete(submission.attemptId);
      this.pool.releaseTurnCapacityClaim(claim);
      this.options.membershipObserver?.notifyMembership(submission.contextId);
      this.scheduleRecovery(Date.now() + (this.options.retryMs ?? 1_000));
      return;
    }
    if (error instanceof TurnIdentityConflictError && submission.submissionKind === "start") {
      this.pauseIdentityConflict(submission.attemptId);
      return;
    }
    if (this.isKnownNonSteerable(error) && submission.submissionKind === "steer") {
      const current = this.store.membersForAttempt(submission.attemptId).find((member) => member.contextId === submission.contextId);
      if (!current || !new Set(["steer_submitting", "uncertain"]).has(current.state)) return;
      this.store.restorePending(submission.attemptId, submission.contextId);
      this.options.membershipObserver?.notifyMembership(submission.contextId);
      this.steeringPause = { attemptId: submission.attemptId, reason: "native_turn_not_steerable" };
      return;
    }
    const reconciliationGeneration = recoveryGeneration ?? ++this.recoveryGeneration;
    if (!this.store.markUncertainIfUnresolved(submission.attemptId, submission.contextId)) return;
    this.options.onOperationalEvent?.("assistant_submission_uncertain");
    const decision = this.store.beginReconciliation(submission.attemptId, submission.contextId);
    if (decision.kind === "needs_attention") {
      this.releaseProvisionalClaim(submission.attemptId, claim);
      if (this.currentAttempt?.attemptId === submission.attemptId) this.currentAttempt = undefined;
      this.options.membershipObserver?.notifyMembership(submission.contextId);
      this.pump();
      return;
    }
    if (decision.kind === "wait") {
      this.scheduleRecovery(decision.retryAt);
      return;
    }
    this.launch(
      this.runner.readThread(),
      (thread) => {
        if (reconciliationGeneration !== this.recoveryGeneration) return;
        this.reconcileSubmission(submission, claim, thread);
        const current = this.store.membersForAttempt(submission.attemptId)
          .find((member) => member.contextId === submission.contextId);
        if (current && this.shouldRetryUnresolved(current)) this.scheduleReconciliation(submission.attemptId, submission.contextId);
      },
      () => {
        if (reconciliationGeneration === this.recoveryGeneration) this.scheduleReconciliation(submission.attemptId, submission.contextId);
      },
    );
  }

  private reconcileSubmission(submission: ReservedSubmission, claim: TurnCapacityClaim | undefined, thread: ThreadSnapshot): void {
    const currentMember = this.store.membersForAttempt(submission.attemptId)
      .find((member) => member.contextId === submission.contextId);
    if (!currentMember || !new Set(["start_submitting", "steer_submitting", "uncertain"]).has(currentMember.state)) return;
    const positive = submission.submissionKind === "steer" && submission.expectedTurnId
      ? thread.turns.find((turn) => turn.id === submission.expectedTurnId
        && turn.items.some((item) => item.type === "userMessage" && item.clientId === submission.clientUserMessageId))
      : [...thread.turns].reverse().find((turn) =>
        turn.items.some((item) => item.type === "userMessage" && item.clientId === submission.clientUserMessageId));
    if (positive) {
      if (submission.submissionKind === "start") {
        const provisional = claim ?? this.provisionalClaims.get(submission.attemptId);
        if (provisional) {
          try {
            this.pool.bindTurnCapacityClaim(provisional, positive.id);
            this.provisionalClaims.delete(submission.attemptId);
          }
          catch { this.pauseIdentityConflict(submission.attemptId); return; }
        }
        const terminal = isTerminal(positive.status);
        const confirmation = this.store.confirmStart(submission.attemptId, submission.contextId, positive.id, { terminal });
        if (confirmation === "conflict") { this.pauseIdentityConflict(submission.attemptId); return; }
        if (confirmation === "bound") {
          this.currentAttempt = terminal ? undefined : this.store.attempt(submission.attemptId);
          this.nativeBusy = !terminal;
          this.options.onOperationalEvent?.("assistant_turn_started");
          this.options.membershipObserver?.notifyMembership(submission.contextId);
        }
        if (!terminal && confirmation !== "already_terminal_same") {
          this.options.runtimeObserver?.activateAttempt(submission.attemptId);
        }
        if (terminal || confirmation === "already_terminal_same") {
          this.noteConversationPeriod(this.store.attempt(submission.attemptId));
          this.currentAttempt = undefined;
          this.nativeBusy = false;
          this.steeringPause = undefined;
          this.options.runtimeObserver?.beginTerminalizing?.(positive.id);
          this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, positive.id);
          if (confirmation !== "already_terminal_same") this.options.onOperationalEvent?.("assistant_turn_terminal");
          this.publishTerminal(positive);
        } else this.pump();
        return;
      }
      const confirmation = this.store.confirmSteer(submission.attemptId, submission.contextId, positive.id);
      if (confirmation === "conflict") return;
      if (confirmation === "bound") {
        this.options.onOperationalEvent?.("assistant_turn_steered");
      }
      this.options.membershipObserver?.notifyMembership(submission.contextId);
      this.options.runtimeObserver?.activateAttempt(submission.attemptId);
      if (isTerminal(positive.status)) {
        this.noteConversationPeriod(this.store.attempt(submission.attemptId));
        this.store.beginTerminalizing(submission.attemptId, positive.id);
        if (this.currentAttempt?.attemptId === submission.attemptId) this.currentAttempt = undefined;
        this.nativeBusy = false;
        this.steeringPause = undefined;
        this.options.runtimeObserver?.beginTerminalizing?.(positive.id);
        this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, positive.id);
        this.options.onOperationalEvent?.("assistant_turn_terminal");
        this.publishTerminal(positive);
      } else this.pump();
      return;
    }

    const allFull = thread.turns.every((turn) => turn.itemsView === "full");
    const allStartItemsKnown = thread.turns.every((turn) => turn.itemsView !== "notLoaded");
    const expected = submission.expectedTurnId
      ? thread.turns.find((turn) => turn.id === submission.expectedTurnId)
      : undefined;
    const noActiveTurn = !thread.turns.some((turn) => !isTerminal(turn.status));
    const threadStatus = typeof thread.status === "string" ? thread.status : thread.status?.type;
    const baselineCovered = thread.historyWindow === undefined
      || (submission.baselineTurnId === null
        ? thread.historyWindow.exhausted
        : submission.baselineTurnId !== undefined
          && thread.historyWindow.anchorTurnIds.includes(submission.baselineTurnId));
    const provenAbsent = submission.submissionKind === "steer"
      ? allFull && !!expected && isTerminal(expected.status)
      : baselineCovered && allStartItemsKnown && noActiveTurn && threadStatus === "idle";
    if (!provenAbsent) return;

    this.store.restorePending(submission.attemptId, submission.contextId);
    this.options.membershipObserver?.notifyMembership(submission.contextId);
    if (submission.submissionKind === "steer" && expected && isTerminal(expected.status)) {
      this.noteConversationPeriod(this.store.attempt(submission.attemptId));
      this.store.beginTerminalizing(submission.attemptId, expected.id);
      if (this.currentAttempt?.attemptId === submission.attemptId) this.currentAttempt = undefined;
      this.nativeBusy = false;
      this.steeringPause = undefined;
      this.options.runtimeObserver?.beginTerminalizing?.(expected.id);
      this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, expected.id);
      this.publishTerminal(expected);
    }
    if (submission.submissionKind === "start") {
      this.pumpPaused = true;
      this.store.failUnstartedAttempt(submission.attemptId);
      if (this.currentAttempt?.attemptId === submission.attemptId) this.currentAttempt = undefined;
      this.nativeBusy = false;
      this.releaseProvisionalClaim(submission.attemptId, claim);
    }
  }

  private reconcileRecoverySnapshot(thread: ThreadSnapshot): void {
    this.store.failOrphanedUnstartedAttempts();
    const activeTurn = [...thread.turns].reverse().find((turn) => !isTerminal(turn.status));
    const threadStatus = typeof thread.status === "string" ? thread.status : thread.status?.type;
    this.nativeBusy = !!activeTurn || threadStatus === "active";
    this.currentAttempt = activeTurn ? this.store.attemptForTurn(activeTurn.id) : undefined;
    if (this.currentAttempt && !this.currentAttempt.acceptingTools) this.currentAttempt = undefined;
    if (this.currentAttempt) this.options.runtimeObserver?.activateAttempt(this.currentAttempt.attemptId);
    else this.options.runtimeObserver?.clearActive();
    if (!this.currentAttempt) this.steeringPause = undefined;

    let nextRetryAt: number | undefined;
    for (const submission of this.store.unresolvedSubmissions()) {
      if (submission.state !== "uncertain") this.store.markUncertain(submission.attemptId, submission.contextId);
      const decision = this.store.beginReconciliation(submission.attemptId, submission.contextId);
      if (decision.kind === "needs_attention") {
        this.releaseProvisionalClaim(submission.attemptId);
        if (this.currentAttempt?.attemptId === submission.attemptId) this.currentAttempt = undefined;
        this.options.membershipObserver?.notifyMembership(submission.contextId);
        continue;
      }
      if (decision.kind === "wait") {
        nextRetryAt = Math.min(nextRetryAt ?? decision.retryAt, decision.retryAt);
        continue;
      }
      this.reconcileSubmission(submission, this.provisionalClaims.get(submission.attemptId), thread);
      const retryAt = this.store.reconciliationRetryAt(submission.attemptId, submission.contextId);
      if (retryAt !== undefined) nextRetryAt = Math.min(nextRetryAt ?? retryAt, retryAt);
    }

    const observedTurnIds = new Set(thread.turns.map((turn) => turn.id));
    const terminalReconciliation = this.advanceTerminalReconciliations(observedTurnIds);
    for (const turn of thread.turns.filter((candidate) => isTerminal(candidate.status))) {
      const attempt = this.store.attemptForTurn(turn.id);
      if (!attempt || terminalReconciliation.blockedAttemptIds.has(attempt.attemptId)) continue;
      this.store.beginTerminalizing(attempt.attemptId, turn.id);
      this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, turn.id);
      this.options.runtimeObserver?.beginTerminalizing?.(turn.id);
      this.publishTerminal(turn);
    }
    if (terminalReconciliation.retryAt !== undefined) {
      nextRetryAt = Math.min(nextRetryAt ?? terminalReconciliation.retryAt, terminalReconciliation.retryAt);
    }
    if (nextRetryAt !== undefined) this.scheduleRecovery(nextRetryAt);
    if (!this.nativeBusy) this.pump();
  }

  private reconcileRecoveryFailure(): void {
    let nextRetryAt: number | undefined;
    for (const submission of this.store.unresolvedSubmissions()) {
      if (submission.state !== "uncertain") {
        if (!this.store.markUncertainIfUnresolved(submission.attemptId, submission.contextId)) continue;
        this.options.onOperationalEvent?.("assistant_submission_uncertain");
      }
      const decision = this.store.beginReconciliation(submission.attemptId, submission.contextId);
      if (decision.kind === "needs_attention") {
        this.releaseProvisionalClaim(submission.attemptId);
        if (this.currentAttempt?.attemptId === submission.attemptId) this.currentAttempt = undefined;
        this.options.membershipObserver?.notifyMembership(submission.contextId);
        continue;
      }
      const retryAt = decision.kind === "wait"
        ? decision.retryAt
        : this.store.reconciliationRetryAt(submission.attemptId, submission.contextId);
      if (retryAt !== undefined) nextRetryAt = Math.min(nextRetryAt ?? retryAt, retryAt);
    }
    const terminalRetryAt = this.advanceTerminalReconciliations().retryAt;
    if (terminalRetryAt !== undefined) nextRetryAt = Math.min(nextRetryAt ?? terminalRetryAt, terminalRetryAt);
    if (nextRetryAt !== undefined) this.scheduleRecovery(nextRetryAt);
  }

  private advanceTerminalReconciliations(observedTurnIds = new Set<string>()): {
    retryAt?: number;
    blockedAttemptIds: Set<string>;
  } {
    let nextRetryAt: number | undefined;
    const blockedAttemptIds = new Set<string>();
    for (const attempt of this.store.incompleteAttempts()) {
      if (attempt.acceptingTools || !attempt.turnId) continue;
      const memberContextIds = this.store.membersForAttempt(attempt.attemptId).map((member) => member.contextId);
      const decision = this.store.beginTerminalReconciliation(attempt.attemptId);
      if (decision.kind === "needs_attention") {
        blockedAttemptIds.add(attempt.attemptId);
        if (this.currentAttempt?.attemptId === attempt.attemptId) this.currentAttempt = undefined;
        for (const contextId of memberContextIds) this.options.membershipObserver?.notifyMembership(contextId);
        continue;
      }
      let retryAt: number | undefined;
      if (decision.kind === "wait") {
        blockedAttemptIds.add(attempt.attemptId);
        retryAt = decision.retryAt;
      } else if (!observedTurnIds.has(attempt.turnId)) {
        retryAt = this.store.terminalReconciliationRetryAt(attempt.attemptId);
      }
      if (retryAt !== undefined) nextRetryAt = Math.min(nextRetryAt ?? retryAt, retryAt);
    }
    return { ...(nextRetryAt === undefined ? {} : { retryAt: nextRetryAt }), blockedAttemptIds };
  }

  private scheduleReconciliation(attemptId: string, contextId: string): void {
    const retryAt = this.store.reconciliationRetryAt(attemptId, contextId);
    this.scheduleRecovery(retryAt ?? Date.now() + (this.options.retryMs ?? 1_000));
  }

  private releaseProvisionalClaim(attemptId: string, fallback?: TurnCapacityClaim): void {
    const claim = this.provisionalClaims.get(attemptId) ?? fallback;
    this.provisionalClaims.delete(attemptId);
    if (claim) this.pool.releaseTurnCapacityClaim(claim);
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

  private trackNativeSubmission<T>(attemptId: string, start: () => Promise<T>): Promise<T> {
    this.nativeSubmissionCount += 1;
    this.attemptSubmissionCounts.set(attemptId, (this.attemptSubmissionCounts.get(attemptId) ?? 0) + 1);
    try { return start(); }
    catch (error) { return Promise.reject(error); }
  }

  private finishNativeSubmission(attemptId: string): void {
    this.nativeSubmissionCount = Math.max(0, this.nativeSubmissionCount - 1);
    const remaining = Math.max(0, (this.attemptSubmissionCounts.get(attemptId) ?? 0) - 1);
    if (remaining > 0) {
      this.attemptSubmissionCounts.set(attemptId, remaining);
      return;
    }
    this.attemptSubmissionCounts.delete(attemptId);
    this.resolveSettledAttemptSubmissionWaiters();
  }

  private post(action: () => void): Promise<void> {
    const run = this.tail.then(() => {
      try { action(); }
      finally { this.resolveSettledAttemptSubmissionWaiters(); }
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  private attemptSubmissionsSettled(attemptId: string): boolean {
    if ((this.attemptSubmissionCounts.get(attemptId) ?? 0) > 0) return false;
    return !this.store.membersForAttempt(attemptId)
      .some((member) => new Set(["start_submitting", "steer_submitting", "uncertain"]).has(member.state));
  }

  private resolveSettledAttemptSubmissionWaiters(): void {
    for (const [attemptId, waiters] of this.attemptSubmissionWaiters) {
      if (!this.attemptSubmissionsSettled(attemptId)) continue;
      this.attemptSubmissionWaiters.delete(attemptId);
      for (const resolve of waiters) resolve();
    }
  }

  private scheduleRecovery(wakeAt = Date.now() + (this.options.retryMs ?? 1_000)): void {
    if (this.recoveryTimer || this.stopped) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      if (!this.stopped) void this.recover();
    }, Math.max(0, wakeAt - Date.now()));
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

  private scheduleAdmissionRetry(): void {
    if (this.admissionRetryTimer || this.stopped) return;
    this.admissionRetryTimer = setTimeout(() => {
      this.admissionRetryTimer = undefined;
      if (!this.stopped) void this.post(() => this.pump());
    }, this.options.retryMs ?? 1_000);
    this.admissionRetryTimer.unref?.();
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
    const attempt = this.currentAttempt;
    const currentSubmission = attempt && !attempt.turnId ? this.unresolvedStart(attempt) : undefined;
    if (currentSubmission && turn.items.some((item) => item.type === "userMessage" && item.clientId === currentSubmission.clientUserMessageId)) {
      return currentSubmission;
    }
    const matches = this.store.unresolvedSubmissions().filter((submission) => submission.submissionKind === "start"
      && turn.items.some((item) => item.type === "userMessage" && item.clientId === submission.clientUserMessageId));
    if (matches.length !== 1) return undefined;
    this.currentAttempt = this.store.attempt(matches[0]!.attemptId);
    return this.currentAttempt ? matches[0] : undefined;
  }

  private unresolvedStart(attempt: AssistantAttempt): ReservedSubmission | undefined {
    const submission = this.store.submissionFor(attempt.attemptId, attempt.primaryContextId);
    return submission?.submissionKind === "start" && new Set(["start_submitting", "uncertain"]).has(submission.state)
      ? submission
      : undefined;
  }

  private settleInFlightStart(attemptId: string): void {
    if (this.inFlightStartAttemptId === attemptId) this.inFlightStartAttemptId = undefined;
  }

  private shouldRetryUnresolved(member: { attemptId: string; submissionKind: "start" | "steer"; state: string }): boolean {
    return new Set(["start_submitting", "steer_submitting", "uncertain"]).has(member.state);
  }

  private confirmNotifiedStart(submission: ReservedSubmission, turn: TurnSnapshot, terminal: boolean) {
    const attempt = this.currentAttempt;
    if (!attempt || attempt.attemptId !== submission.attemptId) return "conflict" as const;
    const claim = this.provisionalClaims.get(attempt.attemptId)
      ?? this.pool.claimTurnCapacity(this.options.endpointId, this.options.threadId, `assistant:${attempt.primaryContextId}`);
    try {
      this.pool.bindTurnCapacityClaim(claim, turn.id);
      this.provisionalClaims.delete(attempt.attemptId);
    } catch {
      return "conflict" as const;
    }
    const confirmation = this.store.confirmStart(submission.attemptId, submission.contextId, turn.id, { terminal });
    return confirmation;
  }

  private pauseIdentityConflict(attemptId: string): void {
    this.pumpPaused = true;
    const unresolvedSteer = this.store.membersForAttempt(attemptId)
      .find((member) => member.submissionKind === "steer" && new Set(["steer_submitting", "uncertain"]).has(member.state));
    if (unresolvedSteer?.state === "steer_submitting" && this.store.markUncertainIfUnresolved(attemptId, unresolvedSteer.contextId)) {
      this.scheduleReconciliation(attemptId, unresolvedSteer.contextId);
    }
    if (this.currentAttempt?.attemptId === attemptId) this.steeringPause = { attemptId, reason: "native_turn_identity_conflict" };
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

  private publishTerminal(turn: TurnSnapshot): void {
    if (this.publishedTerminalIds.has(turn.id)) return;
    this.publishedTerminalIds.add(turn.id);
    if (this.publishedTerminalIds.size > 1_000) this.publishedTerminalIds.delete(this.publishedTerminalIds.values().next().value!);
    this.options.onTerminal?.(turn);
  }

  private noteConversationPeriod(attempt?: AssistantAttempt): void {
    if (attempt?.binding) this.options.scheduler?.noteConversationPeriodCompleted();
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
