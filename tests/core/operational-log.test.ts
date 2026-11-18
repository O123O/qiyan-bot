import assert from "node:assert/strict";
import test from "node:test";
import { createOperationalLogSink } from "../../src/core/operational-log.ts";
import { describeAttemptFailure } from "../../src/assistant/runtime.ts";
import { AppError } from "../../src/core/errors.ts";

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
