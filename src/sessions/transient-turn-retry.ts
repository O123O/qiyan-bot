import type { RegistrySession } from "../registry/session-registry.ts";

export const TRANSIENT_TURN_RETRY_MESSAGE =
  "[system] Your previous turn failed with a transient provider error before producing anything."
  + " Continue the work it was meant to do; if it already finished, no response is needed.";

// Codex classifies every turn failure, so the retryable set is a decision about codes rather than
// a guess about messages. These are the failures where the request produced nothing and the same
// request can succeed unchanged: capacity, upstream 5xx, and dropped connections.
//
// Everything else is excluded deliberately. usageLimitExceeded and sessionBudgetExceeded fail
// identically however often they are retried, and retrying spends a budget the user is already
// out of. contextWindowExceeded needs a compaction, not a repeat. cyberPolicy, unauthorized and
// badRequest are verdicts on the request itself. "other" is unclassified, which is not evidence
// of transience. responseTooManyFailedAttempts is left out because codex has already exhausted
// its own retries for that turn.
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "serverOverloaded",
  "internalServerError",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
]);
// Deliberately absent: responseStreamDisconnected cannot arrive here. codex reports mid-turn
// stream errors on its own `error` notification and leaves the turn's last_error alone, because
// it retries those itself -- so listing it would be dead code implying coverage we do not have.

// CodexErrorInfo is either a bare string or a single-key object carrying an http status.
export function transientTurnErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const info = (error as { codexErrorInfo?: unknown }).codexErrorInfo;
  const code = typeof info === "string"
    ? info
    : info && typeof info === "object" && !Array.isArray(info) ? Object.keys(info)[0] : undefined;
  return code !== undefined && RETRYABLE_CODES.has(code) ? code : undefined;
}

export type TurnRetryDecision = "reset" | "retry" | "ignore";

// A turn that completed without an error proves the provider is answering, and only that resets
// the budget. A turn it refused (a quota, a context overflow, a policy verdict) ran but proves
// nothing about transience, so it neither retries nor resets -- otherwise a worker driven by its
// own goal would re-arm a fresh budget after every refusal and keep paying for retries.
export function turnRetryDecision(turn: { error?: unknown } | null | undefined): TurnRetryDecision {
  if (!turn) return "ignore";
  if (turn.error === null || turn.error === undefined) return "reset";
  return transientTurnErrorCode(turn.error) === undefined ? "ignore" : "retry";
}

export interface RetryWorker {
  nickname: string;
  session: RegistrySession;
}

interface RetryTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: any): void;
}

const nodeRetryTimers: RetryTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

const keyOf = (session: Pick<RegistrySession, "endpoint" | "thread_id" | "mapping_id">): string =>
  `${session.endpoint}\0${session.thread_id}\0${session.mapping_id}`;

// A transient provider failure used to be permanent for the worker: the turn died, the thread was
// marked errored, and nothing tried again. Retrying is bounded on purpose -- a provider at
// capacity is not helped by being asked faster, and an unbounded retry would hide a real outage
// behind a worker that looks busy.
export class TransientTurnRetry {
  private readonly attempts = new Map<string, number>();
  private readonly pending = new Map<string, unknown>();
  private stopped = false;

  constructor(private readonly deps: {
    retry(worker: RetryWorker, attempt: number): Promise<void> | void;
    onExhausted(worker: RetryWorker, code: string, attempts: number, turnId?: string): void;
    onScheduled?(worker: RetryWorker, code: string, attempt: number, delayMs: number): void;
    onRetryFailed?(worker: RetryWorker, error: unknown): void;
    timers?: RetryTimers;
    retryMs?: number;
    maxAttempts?: number;
  }) {}

  private get retryMs(): number { return this.deps.retryMs ?? 120_000; }
  private get maxAttempts(): number { return this.deps.maxAttempts ?? 3; }
  private get timers(): RetryTimers { return this.deps.timers ?? nodeRetryTimers; }

  // Returns the code being retried, or undefined when the failure is not retryable, the budget is
  // spent, or a retry is already scheduled for this session.
  turnFailed(worker: RetryWorker, error: unknown, turnId?: string): string | undefined {
    if (this.stopped) return undefined;
    const code = transientTurnErrorCode(error);
    if (!code) return undefined;
    const key = keyOf(worker.session);
    if (this.pending.has(key)) return undefined;
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    if (attempt > this.maxAttempts) {
      // Reported once, when the budget runs out: the worker is now genuinely stuck and the owner
      // has to know, because nothing else will try again.
      this.attempts.delete(key);
      this.deps.onExhausted(worker, code, this.maxAttempts, turnId);
      return undefined;
    }
    this.attempts.set(key, attempt);
    const handle: any = this.timers.setTimeout(() => {
      this.pending.delete(key);
      if (this.stopped) return;
      void (async () => {
        try { await this.deps.retry(worker, attempt); }
        catch (error) { this.deps.onRetryFailed?.(worker, error); }
      })();
    }, this.retryMs);
    handle?.unref?.(); // a pending retry must not hold the process open
    this.pending.set(key, handle);
    this.deps.onScheduled?.(worker, code, attempt, this.retryMs);
    return code;
  }

  // Any turn that starts or settles normally proves the provider is answering again, so the
  // budget resets. Without this a worker that failed twice weeks apart would give up on its
  // first failure the third time.
  turnObserved(session: Pick<RegistrySession, "endpoint" | "thread_id" | "mapping_id">): void {
    this.attempts.delete(keyOf(session));
  }

  // A turn the user started supersedes a retry we have not sent yet.
  cancel(session: Pick<RegistrySession, "endpoint" | "thread_id" | "mapping_id">): void {
    const key = keyOf(session);
    const handle = this.pending.get(key);
    if (handle !== undefined) this.timers.clearTimeout(handle);
    this.pending.delete(key);
  }

  stop(): void {
    this.stopped = true;
    for (const handle of this.pending.values()) this.timers.clearTimeout(handle);
    this.pending.clear();
    this.attempts.clear();
  }
}
