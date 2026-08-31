import assert from "node:assert/strict";
import test from "node:test";
import type { RegistrySession } from "../../src/registry/session-registry.ts";
import {
  TRANSIENT_TURN_RETRY_MESSAGE,
  TransientTurnRetry,
  transientTurnErrorCode,
  turnRetryDecision,
} from "../../src/sessions/transient-turn-retry.ts";

const session: RegistrySession = {
  endpoint: "local",
  thread_id: "thread-1",
  project_dir: "/project",
  mapping_id: "mapping-1",
  lifecycle_state: "managed",
};
const worker = { nickname: "fp5", session };

type Timer = { callback: () => void; delayMs: number; cleared: boolean };

const harness = (options: { maxAttempts?: number; retryMs?: number } = {}) => {
  const timers: Timer[] = [];
  const retried: number[] = [];
  const exhausted: Array<{ code: string; attempts: number }> = [];
  const scheduled: Array<{ code: string; attempt: number; delayMs: number }> = [];
  const retry = new TransientTurnRetry({
    retry: (_worker, attempt) => { retried.push(attempt); },
    onExhausted: (_worker, code, attempts) => { exhausted.push({ code, attempts }); },
    onScheduled: (_worker, code, attempt, delayMs) => { scheduled.push({ code, attempt, delayMs }); },
    timers: {
      setTimeout: (callback, delayMs) => {
        const timer = { callback, delayMs, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer: Timer) => { timer.cleared = true; },
    },
    ...options,
  });
  const fire = async () => {
    const next = timers.find((timer) => !timer.cleared);
    assert.ok(next, "expected a scheduled retry to fire");
    timers.splice(timers.indexOf(next), 1);
    next.callback();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  };
  return { retry, timers, retried, exhausted, scheduled, fire };
};

// The failure that started this: an upstream capacity error ended a turn, and because nothing
// retried it the worker was finished for the day.
test("a capacity failure is retried three times, two minutes apart", async () => {
  const h = harness();

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const code = h.retry.turnFailed(worker, { message: "at capacity", codexErrorInfo: "serverOverloaded" });
    assert.equal(code, "serverOverloaded", `attempt ${attempt} was not scheduled`);
    assert.equal(h.scheduled.at(-1)?.delayMs, 120_000, "retries are two minutes apart");
    assert.equal(h.scheduled.at(-1)?.attempt, attempt);
    await h.fire();
    assert.deepEqual(h.retried.at(-1), attempt, "the retry actually ran");
  }

  assert.deepEqual(h.retried, [1, 2, 3], "exactly three retries");
  assert.deepEqual(h.exhausted, [], "the budget is not reported spent until a fourth failure");

  // The fourth failure is the one that has to reach the owner: nothing else will try again.
  assert.equal(h.retry.turnFailed(worker, { codexErrorInfo: "serverOverloaded" }), undefined);
  assert.deepEqual(h.exhausted, [{ code: "serverOverloaded", attempts: 3 }]);
  assert.deepEqual(h.retried, [1, 2, 3], "no fourth retry is sent");
});

// Retrying a quota or a policy refusal cannot succeed and spends what the user is already out of.
test("only failures that can succeed unchanged are retried", () => {
  assert.equal(transientTurnErrorCode({ codexErrorInfo: "serverOverloaded" }), "serverOverloaded");
  assert.equal(transientTurnErrorCode({ codexErrorInfo: "internalServerError" }), "internalServerError");
  assert.equal(transientTurnErrorCode({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } }),
    "httpConnectionFailed", "a coded variant is an object whose single key is the code");

  assert.equal(transientTurnErrorCode({ codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: null } } }),
    "responseStreamConnectionFailed");

  // Every remaining member of the CodexErrorInfo union, in the shape the wire actually uses:
  // the coded variants are objects, so asserting them as bare strings would pass for the wrong
  // reason and keep passing if one were added to the retryable set.
  for (const code of ["usageLimitExceeded", "sessionBudgetExceeded", "contextWindowExceeded",
    "cyberPolicy", "unauthorized", "badRequest", "other",
    "threadRollbackFailed", "sandboxError"]) {
    assert.equal(transientTurnErrorCode({ codexErrorInfo: code }), undefined, `${code} must not be retried`);
  }
  for (const code of ["responseTooManyFailedAttempts", "activeTurnNotSteerable", "responseStreamDisconnected"]) {
    assert.equal(transientTurnErrorCode({ codexErrorInfo: { [code]: { httpStatusCode: 500 } } }), undefined,
      `${code} must not be retried`);
  }
  assert.equal(transientTurnErrorCode(null), undefined);
  assert.equal(transientTurnErrorCode({}), undefined, "an unclassified failure is not evidence of transience");
});

// A worker that recovers must not carry its old failures forward, or the third capacity blip in
// its lifetime would give up immediately.
test("a turn that runs resets the retry budget", async () => {
  const h = harness();
  h.retry.turnFailed(worker, { codexErrorInfo: "serverOverloaded" });
  await h.fire();
  h.retry.turnObserved(session);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.equal(h.retry.turnFailed(worker, { codexErrorInfo: "serverOverloaded" }), "serverOverloaded",
      `attempt ${attempt} after the reset was refused`);
    await h.fire();
  }
  assert.deepEqual(h.exhausted, [], "the budget restarted from zero");
});

// Someone sending to the worker themselves supersedes a retry we have not delivered.
test("a pending retry is cancelled rather than delivered late", async () => {
  const h = harness();
  h.retry.turnFailed(worker, { codexErrorInfo: "serverOverloaded" });
  h.retry.cancel(session);

  assert.equal(h.timers.every((timer) => timer.cleared), true, "the timer was cleared");
  assert.deepEqual(h.retried, [], "no retry was sent");

  // And the session is not left wedged: a later failure schedules again.
  assert.equal(h.retry.turnFailed(worker, { codexErrorInfo: "serverOverloaded" }), "serverOverloaded");
});

test("stop cancels everything in flight", () => {
  const h = harness();
  h.retry.turnFailed(worker, { codexErrorInfo: "serverOverloaded" });
  h.retry.stop();
  assert.equal(h.timers.every((timer) => timer.cleared), true);
  assert.equal(h.retry.turnFailed(worker, { codexErrorInfo: "serverOverloaded" }), undefined,
    "a stopped scheduler takes no new work");
});

// The hook that reads a live notification, kept out of the closure on purpose: the previous
// change in this series shipped inert because a payload was not the shape it assumed, and nothing
// could have caught it. These are the literal TurnCompletedNotification shapes codex sends --
// camelCase, per the generated CodexErrorInfo type.
test("a turn notification is classified from the shape codex actually sends", () => {
  assert.equal(turnRetryDecision({ id: "t1", status: "completed", error: null } as never), "reset",
    "a clean turn proves the provider is answering");
  assert.equal(turnRetryDecision({ id: "t1", status: "completed" } as never), "reset",
    "an absent error is the same as none");
  assert.equal(turnRetryDecision({
    id: "t2", status: "failed",
    error: { message: "Selected model is at capacity. Please try a different model.", codexErrorInfo: "serverOverloaded", additionalDetails: null },
  } as never), "retry", "the exact payload from the 2026-08-31 outage");
  assert.equal(turnRetryDecision({
    id: "t3", status: "failed",
    error: { message: "quota", codexErrorInfo: "usageLimitExceeded", additionalDetails: null },
  } as never), "ignore", "a refusal neither retries nor resets the budget");
  assert.equal(turnRetryDecision(undefined), "ignore");
  // Claude workers publish turn/completed with no error field at all, so they can only ever reset.
  assert.equal(turnRetryDecision({ id: "t4", status: "completed", itemsView: "full", items: [] } as never), "reset");
});

test("the retry message tells the worker the turn produced nothing", () => {
  assert.match(TRANSIENT_TURN_RETRY_MESSAGE, /transient provider error/u);
  assert.match(TRANSIENT_TURN_RETRY_MESSAGE, /Continue the work/u);
});
