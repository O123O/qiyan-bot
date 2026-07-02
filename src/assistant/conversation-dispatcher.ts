import type { AttachmentStore, FileHandleId } from "../attachments/store.ts";
import type { AppServerPool, TurnCapacityClaim } from "../app-server/pool.ts";
import { AppError } from "../core/errors.ts";
import type { CanonicalChatSource } from "../core/types.ts";
import type { AssistantLease, ConversationStore, ReservedSubmission } from "../storage/conversation-store.ts";

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
  retryMs?: number;
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
        this.store.beginTerminalizing(turn.id);
      } else {
        this.earlyTerminals.set(turn.id, turn);
      }
      this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, turn.id);
    });
  }

  recover(): Promise<void> {
    return this.post(() => {
      const lease = this.store.lease();
      if (lease) {
        this.pool.restoreTurnCapacityClaim(this.options.endpointId, this.options.threadId, lease.capacityClaimId, {
          phase: lease.turnId ? "active" : "provisional",
          ...(lease.turnId ? { turnId: lease.turnId } : {}),
        });
      }
      this.store.repairQueueNotices();
      this.pump();
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
    await this.idle();
  }

  private pump(): void {
    if (this.stopped || this.networkCount > 0 || this.pumpPaused) return;
    const lease = this.store.lease();
    if (!lease) {
      const candidate = this.store.nextPendingCandidate();
      if (!candidate) return;
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
        acquired = this.store.acquireLease(candidate, claim.id);
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
        this.store.markSubmitted(submission.attemptId, submission.contextId, response.turn.id);
        this.pool.bindTurnCapacityClaim(claim, response.turn.id);
        const early = this.earlyTerminals.get(response.turn.id);
        if (early || isTerminal(response.turn.status)) {
          this.earlyTerminals.delete(response.turn.id);
          this.store.beginTerminalizing(response.turn.id);
          this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, response.turn.id);
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
        this.pump();
      },
      (error) => this.handleSubmissionFailure(submission, undefined, error),
    );
  }

  private handleSubmissionFailure(submission: ReservedSubmission, claim: TurnCapacityClaim | undefined, error: unknown): void {
    if (this.isKnownNonSteerable(error) && submission.submissionKind === "steer") {
      this.store.restorePending(submission.attemptId, submission.contextId);
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
      if (claim) this.pool.bindTurnCapacityClaim(claim, positive.id);
      if (isTerminal(positive.status)) {
        this.store.beginTerminalizing(positive.id);
        this.pool.markTurnTerminal(this.options.endpointId, this.options.threadId, positive.id);
      } else this.pump();
      return;
    }

    const allFull = thread.turns.every((turn) => turn.itemsView === "full");
    const expected = submission.expectedTurnId
      ? thread.turns.find((turn) => turn.id === submission.expectedTurnId)
      : undefined;
    const noActiveTurn = !thread.turns.some((turn) => !isTerminal(turn.status));
    const provenAbsent = allFull && (submission.submissionKind === "steer" ? !!expected && isTerminal(expected.status) : noActiveTurn);
    if (!provenAbsent) return;

    this.store.restorePending(submission.attemptId, submission.contextId);
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
      (value) => this.post(() => success(value)),
      (error) => this.post(() => failure(error)),
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

  private isKnownNonSteerable(error: unknown): boolean {
    return error instanceof AppError && new Set(["SESSION_IDLE", "OPERATION_CONFLICT"]).has(error.code);
  }
}

function isTerminal(status: string): boolean {
  return new Set(["completed", "failed", "interrupted"]).has(status);
}
