import assert from "node:assert/strict";
import test from "node:test";
import { createOperationalLogSink } from "../../src/core/operational-log.ts";

test("operational logs contain only bounded structured metadata", () => {
  const lines: string[] = [];
  const report = createOperationalLogSink((line) => { lines.push(line); });
  report({ level: "warn", code: "chat_ingress_failed", adapter: "telegram", consecutiveFailures: 2 });
  report({ level: "info", code: "chat_input_accepted", adapter: "not safe secret-token" as "telegram" });
  report({ level: "warn", code: "endpoint_recovery_paused", endpoint: "prenyx-codex", reason: "ssh_fresh_channel_unavailable" });
  report({ level: "warn", code: "endpoint_connection_lost", endpoint: "polyphe", reason: "frame_too_large" });
  report({ level: "warn", code: "managed_session_parked", endpoint: "prenyx", reason: "thread_writer_locked", sessions: 2 });
  assert.deepEqual(lines, [
    "qiyan-bot: WARN event=chat_ingress_failed adapter=telegram consecutive_failures=2\n",
    "qiyan-bot: INFO event=chat_input_accepted adapter=unknown\n",
    "qiyan-bot: WARN event=endpoint_recovery_paused endpoint=prenyx-codex reason=ssh_fresh_channel_unavailable\n",
    "qiyan-bot: WARN event=endpoint_connection_lost endpoint=polyphe reason=frame_too_large\n",
    // How many sessions parked is the difference between one worker and the whole endpoint.
    "qiyan-bot: WARN event=managed_session_parked endpoint=prenyx reason=thread_writer_locked sessions=2\n",
  ]);
  assert.equal(lines.join("").includes("secret-token"), false);
});
