import type { AttachmentStore, FileHandleId } from "../attachments/store.ts";
import type { AppServerPool, TurnCapacityClaim } from "../app-server/pool.ts";
import { JsonRpcResponseError } from "../app-server/json-rpc-client.ts";
import { AppError } from "../core/errors.ts";
import type { CanonicalChatSource } from "../core/types.ts";
import type { AssistantLease, ConversationStore, ReservedSubmission } from "../storage/conversation-store.ts";
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
  stopWaitMs?: number;
}

export class ConversationDispatcher {
  private tail: Promise<void> = Promise.resolve();
  private networkCount = 0;
  private readonly idleWaiters = new Set<() => void>();
  private readonly earlyTerminals = new Map<string, TurnSnapshot>();
  private readonly unsubscribeCapacity: () => void;
  private capacityWaiting = false;
  private pumpPaused = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
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

  accept(source: CanonicalChatSource, commitNativeCheckpoint?: () => void): Promise<void> {
    return this.post(() => {
      this.pumpPaused = false;
      this.store.acceptChatSource(source, commitNativeCheckpoint);
      this.pump();
    });
  }

  enqueueInternal(_contextId: string): Promise<void> {
    return this.post(() => { this.pumpPaused = false; this.pump(); });
  }

  terminal(turn: TurnSnapshot): Promise<void> {
    return this.post(() => {
      this.pumpPaused = false;
      const lease = this.store.lease();
      if (lease?.turnId === turn.id) {
        this.noteConversationPeriod();
        this.store.beginTerminalizing(turn.id);
        this.options.runtimeObserver?.beginTerminalizing?.(turn.id);
      } else {
        this.earlyTerminals.set(turn.id, turn);
      }
      this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, turn.id);
    });
  }

  recover(): Promise<void> {
    return this.post(() => {
      this.pumpPaused = false;
      const lease = this.store.lease();
      if (lease) {
        const claim = this.pool.restoreTurnCapacityClaim(this.options.endpointId, this.options.threadId, lease.capacityClaimId, {
          phase: lease.turnId ? "active" : "provisional",
          ...(lease.turnId ? { turnId: lease.turnId } : {}),
        });
        const members = this.store.membersForAttempt(lease.attemptId);
        const unresolved = members.find((member) => new Set(["start_submitting", "steer_submitting", "uncertain"]).has(member.state));
        if (unresolved) {
          if (unresolved.state !== "uncertain") this.store.markUncertain(lease.attemptId, unresolved.contextId);
          const submission = this.store.submissionFor(lease.attemptId, unresolved.contextId)!;
          this.launch(
            this.runner.readThread(),
            (thread) => this.reconcileSubmission(submission, submission.submissionKind === "start" ? claim : undefined, thread),
            () => undefined,
          );
        } else if (lease.phase === "starting" && members.length === 0) {
          this.launchStart(this.store.reserveStart(lease.primaryContextId), claim);
        } else if (lease.turnId && (lease.phase === "active" || lease.phase === "terminalizing")) {
          this.launch(
            this.runner.readThread(),
            (thread) => {
              const turn = thread.turns.find((candidate) => candidate.id === lease.turnId);
              if (!turn || !isTerminal(turn.status)) return;
              this.noteConversationPeriod();
              this.store.beginTerminalizing(turn.id);
              this.options.runtimeObserver?.beginTerminalizing?.(turn.id);
              this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, turn.id);
              this.options.onDeferredTerminal?.(turn);
            },
            () => undefined,
          );
        }
      }
      this.store.repairQueueNotices();
      if (!lease) this.pump();
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
    this.unsubscribeCapacity();
    this.cancelRetry();
    if (this.eventWakeTimer) clearTimeout(this.eventWakeTimer);
    const lease = this.store.lease();
    if (lease) {
      const unresolved = this.store.membersForAttempt(lease.attemptId)
        .find((member) => new Set(["start_submitting", "steer_submitting"]).has(member.state));
      if (unresolved) {
        this.store.markUncertain(lease.attemptId, unresolved.contextId);
        this.options.membershipObserver?.notifyMembership(unresolved.contextId);
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.idle(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, this.options.stopWaitMs ?? 1_000); }),
    ]);
    if (timer) clearTimeout(timer);
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

  private launchStart(submission: ReservedSubmission, claim: TurnCapacityClaim): void {
    const params: TurnStartParams = {
      threadId: this.options.threadId,
      clientUserMessageId: submission.clientUserMessageId,
      input: this.input(submission),
    };
    this.launch(
      this.runner.start(params, claim),
      (response) => {
        const early = this.earlyTerminals.get(response.turn.id);
        try {
          this.pool.bindTurnCapacityClaim(claim, response.turn.id);
        } catch (error) {
          if (!early && !isTerminal(response.turn.status)) throw error;
        }
        this.store.markSubmitted(submission.attemptId, submission.contextId, response.turn.id);
        this.options.membershipObserver?.notifyMembership(submission.contextId);
        this.options.runtimeObserver?.hydrateActive();
        if (early || isTerminal(response.turn.status)) {
          this.earlyTerminals.delete(response.turn.id);
          this.noteConversationPeriod();
          this.store.beginTerminalizing(response.turn.id);
          this.options.runtimeObserver?.beginTerminalizing?.(response.turn.id);
          this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, response.turn.id);
          this.options.onDeferredTerminal?.(early ?? response.turn);
          return;
        }
        this.pump();
      },
      (error) => this.handleSubmissionFailure(submission, claim, error),
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
      this.runner.steer(params),
      (response) => {
        this.store.markSubmitted(submission.attemptId, submission.contextId, response.turnId);
        this.options.membershipObserver?.notifyMembership(submission.contextId);
        this.options.runtimeObserver?.hydrateActive();
        this.pump();
      },
      (error) => this.handleSubmissionFailure(submission, undefined, error),
    );
  }

  private handleSubmissionFailure(submission: ReservedSubmission, claim: TurnCapacityClaim | undefined, error: unknown): void {
    if (this.isKnownNonSteerable(error) && submission.submissionKind === "steer") {
      this.store.restorePending(submission.attemptId, submission.contextId);
      this.options.membershipObserver?.notifyMembership(submission.contextId);
      this.store.pauseSteering(submission.attemptId, "native_turn_not_steerable");
      return;
    }
    this.store.markUncertain(submission.attemptId, submission.contextId);
    this.launch(
      this.runner.readThread(),
      (thread) => this.reconcileSubmission(submission, claim, thread),
      () => undefined,
    );
  }

  private reconcileSubmission(submission: ReservedSubmission, claim: TurnCapacityClaim | undefined, thread: ThreadSnapshot): void {
    const positive = [...thread.turns].reverse().find((turn) =>
      turn.items.some((item) => item.type === "userMessage" && item.clientId === submission.clientUserMessageId));
    if (positive) {
      this.store.markSubmitted(submission.attemptId, submission.contextId, positive.id);
      this.options.membershipObserver?.notifyMembership(submission.contextId);
      this.options.runtimeObserver?.hydrateActive();
      if (claim) this.pool.bindTurnCapacityClaim(claim, positive.id);
      if (isTerminal(positive.status)) {
        this.noteConversationPeriod();
        this.store.beginTerminalizing(positive.id);
        this.options.runtimeObserver?.beginTerminalizing?.(positive.id);
        this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, positive.id);
        this.options.onDeferredTerminal?.(positive);
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
    if (!provenAbsent) return;

    this.store.restorePending(submission.attemptId, submission.contextId);
    this.options.membershipObserver?.notifyMembership(submission.contextId);
    if (submission.submissionKind === "steer" && expected && isTerminal(expected.status)) {
      this.noteConversationPeriod();
      this.store.beginTerminalizing(expected.id);
      this.options.runtimeObserver?.beginTerminalizing?.(expected.id);
      this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, expected.id);
      this.options.onDeferredTerminal?.(expected);
    }
    if (claim) {
      this.pumpPaused = true;
      this.store.clearLease(submission.attemptId);
      this.pool.releaseTurnCapacityClaim(claim);
    }
  }

  private input(submission: ReservedSubmission): unknown[] {
    const input: unknown[] = [];
    if (submission.rawText) input.push({ type: "text", text: submission.rawText, text_elements: [] });
    if (submission.attachmentIds.length > 0) {
      if (!this.options.attachments) throw new AppError("ATTACHMENT_INVALID", "assistant attachment input is not configured");
      for (const id of submission.attachmentIds) {
        input.push(this.options.attachments.toUserInput(submission.contextId, id as FileHandleId));
      }
    }
    return input;
  }

  private launch<T>(promise: Promise<T>, success: (value: T) => void, failure: (error: unknown) => void): void {
    this.networkCount += 1;
    void promise.then(
      (value) => this.post(() => { if (!this.stopped) success(value); }),
      (error) => this.post(() => { if (!this.stopped) failure(error); }),
    ).finally(() => {
      this.networkCount -= 1;
      if (this.networkCount === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
        if (!this.stopped) void this.post(() => this.pump());
      }
    });
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

  private noteConversationPeriod(): void {
    const lease = this.store.lease();
    if (lease?.phase !== "terminalizing" && lease?.binding) this.options.scheduler?.noteConversationPeriodCompleted();
  }
}

function isTerminal(status: string): boolean {
  return new Set(["completed", "failed", "interrupted"]).has(status);
}
