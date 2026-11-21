import assert from "node:assert/strict";
import test from "node:test";
import { createOperationalLogSink } from "../../src/core/operational-log.ts";
import { AppError, describeAttemptFailure } from "../../src/core/errors.ts";

test("operational logs contain only bounded structured metadata", () => {
  const lines: string[] = [];
  const report = createOperationalLogSink((line) => { lines.push(line); });
  report({ level: "warn", code: "chat_ingress_failed", adapter: "telegram", consecutiveFailures: 2 });
  report({ level: "info", code: "chat_input_accepted", adapter: "not safe secret-token" as "telegram" });
  report({ level: "warn", code: "endpoint_recovery_paused", endpoint: "prenyx-codex", reason: "ssh_fresh_channel_unavailable" });
  report({ level: "warn", code: "endpoint_connection_lost", endpoint: "polyphe", reason: "frame_too_large" });
  report({ level: "warn", code: "managed_session_parked", endpoint: "prenyx", reason: "thread_writer_locked", sessions: 2 });
  report({ level: "warn", code: "endpoint_connection_lost", endpoint: "polyphe", reason: "transport_closed", loss: "runtime-lost" });
  report({
    level: "warn", code: "endpoint_runtime_reclaimed", component: "ssh_runtime", endpoint: "polyphe",
    reason: "dead_supervisor", survivors: 3,
  });
  assert.deepEqual(lines, [
    "qiyan-bot: WARN event=chat_ingress_failed adapter=telegram consecutive_failures=2\n",
    "qiyan-bot: INFO event=chat_input_accepted adapter=unknown\n",
    "qiyan-bot: WARN event=endpoint_recovery_paused endpoint=prenyx-codex reason=ssh_fresh_channel_unavailable\n",
    "qiyan-bot: WARN event=endpoint_connection_lost endpoint=polyphe reason=frame_too_large\n",
    // How many sessions parked is the difference between one worker and the whole endpoint.
    "qiyan-bot: WARN event=managed_session_parked endpoint=prenyx reason=thread_writer_locked sessions=2\n",
    // A lost connection and a dead remote runtime are different incidents; the line says which.
    "qiyan-bot: WARN event=endpoint_connection_lost endpoint=polyphe reason=transport_closed loss=runtime-lost\n",
    "qiyan-bot: WARN event=endpoint_runtime_reclaimed endpoint=polyphe reason=dead_supervisor component=ssh_runtime survivors=3\n",
  ]);
  assert.equal(lines.join("").includes("secret-token"), false);
});

// The LAN-exposure warning is the one line telling you an unauthenticated full-access UI is
// reachable over plain HTTP, and it printed `reason=unknown` — the sentence it carried was a
// sentence. Every journal reason has to be a token, including the ones written as prose by hand.
test("every reason this build emits survives the sink as itself", () => {
  const lines: string[] = [];
  const report = createOperationalLogSink((line) => { lines.push(line); });
  for (const reason of [
    "lan_reachable_plain_http", "reconnect_budget_exhausted",
    "sample_timed_out", "sample_failed", "no_reading",
  ]) {
    report({ level: "warn", code: "web_ui_lan_exposure", reason });
  }

  assert.equal(lines.some((line) => line.includes("reason=unknown")), false);
  assert.deepEqual(lines.map((line) => line.trim().split("reason=")[1]), [
    "lan_reachable_plain_http", "reconnect_budget_exhausted",
    "sample_timed_out", "sample_failed", "no_reading",
  ]);
});

// Endpoint ids may begin with a digit; the token rule may not. These lines exist to say which
// endpoint something happened to, and `endpoint=unknown` is the one thing they must never say
// about an id that is perfectly valid.
test("an endpoint id that starts with a digit is still named", () => {
  const lines: string[] = [];
  const report = createOperationalLogSink((line) => { lines.push(line); });
  report({ level: "warn", code: "endpoint_reconnect_gave_up", endpoint: "3090-box", reason: "reconnect_budget_exhausted" });
  report({ level: "warn", code: "endpoint_reconnect_gave_up", endpoint: "not a valid id", reason: "reconnect_budget_exhausted" });

  assert.deepEqual(lines.map((line) => line.split(" ")[3]), ["endpoint=3090-box", "endpoint=unknown"]);
});

// The sink renders anything that is not a lowercase slug as "unknown", which is a silent way of
// discarding the only thing a failure line carries. Every caller with a real cause in hand has to
// convert it first, and `describeAttemptFailure` is that conversion — so what it produces must
// survive the sink. Observed in production: `background_task_failed … reason=unknown` on an
// endpoint that was unreachable for a perfectly nameable reason.
test("a classified failure cause reaches the journal instead of degrading to unknown", () => {
  const lines: string[] = [];
  const report = createOperationalLogSink((line) => { lines.push(line); });
  for (const error of [
    new AppError("ENDPOINT_UNAVAILABLE", "existing SSH runtime is unhealthy: polyphe"),
    new Error("connect ECONNREFUSED 127.0.0.1:35513"),
    "no_reading",
  ]) {
    report({ level: "warn", code: "background_task_failed", endpoint: "polyphe", reason: describeAttemptFailure(error).token });
  }

  assert.deepEqual(lines.map((line) => line.trim().split(" ").at(-1)), [
    "reason=endpoint_unavailable",
    "reason=exception",
    "reason=no_reading",
  ]);
  assert.equal(lines.join("").includes("unknown"), false);
});

// Codex reports a failed turn as DATA on the turn -- `{ message, codexErrorInfo,
// additionalDetails }` -- so it is neither an Error nor a string and used to fall through every
// branch to "no cause was recorded". Measured 2026-11-20 20:10-20:14 UTC: three assistant turns
// lost to a model-API outage, each journalled as `reason=unknown`, and the owner told that the
// last failure had no cause while codex had named it twice over.
test("a codex turn error names the failure it already classified", () => {
  assert.deepEqual(describeAttemptFailure({
    message: "stream error: failed to connect to Responses WebSocket",
    codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: null } },
    additionalDetails: null,
  }), {
    token: "responsestreamconnectionfailed",
    detail: "stream error: failed to connect to Responses WebSocket",
  });

  // The bare-string form of CodexErrorInfo, and a detail assembled from both halves.
  assert.deepEqual(describeAttemptFailure({
    message: "server overloaded", codexErrorInfo: "serverOverloaded", additionalDetails: "retry later",
  }), { token: "serveroverloaded", detail: "server overloaded -- retry later" });

  // Classified as a turn failure even when codex declines to say which kind, because that is
  // still more than "unknown", which here only ever meant the cause was lost on the way in.
  assert.deepEqual(describeAttemptFailure({ message: "turn failed", codexErrorInfo: null, additionalDetails: null }),
    { token: "turn_failed", detail: "turn failed" });

  // A foreign rejected value -- some library's `{ message, code }` -- is NOT a turn failure.
  // Its message is worth carrying; naming it one would assert something nothing here showed.
  assert.deepEqual(describeAttemptFailure({ message: "socket hang up", code: "ECONNRESET" }),
    { token: "unknown", detail: "socket hang up" });

  // And the real fallback is untouched: nothing in hand is still nothing in hand.
  assert.deepEqual(describeAttemptFailure(undefined), { token: "unknown", detail: "no cause was recorded" });

  const lines: string[] = [];
  const report = createOperationalLogSink((line) => { lines.push(line); });
  report({
    level: "warn", code: "assistant_attempt_failed", component: "assistant_runtime",
    reason: describeAttemptFailure({ message: "x", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } }, additionalDetails: null }).token,
  });
  // The same spelling the worker line already uses for this code, so one outage reads the same
  // on both sides of the system.
  assert.equal(lines[0], "qiyan-bot: WARN event=assistant_attempt_failed reason=httpconnectionfailed component=assistant_runtime\n");
});
