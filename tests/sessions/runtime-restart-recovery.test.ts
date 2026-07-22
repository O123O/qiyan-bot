import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeRestartRecovery } from "../../src/sessions/runtime-restart-recovery.ts";

const session = {
  endpoint: "prenyx",
  thread_id: "thread-1",
  project_dir: "/workspace",
  mapping_id: "mapping-1",
  lifecycle_state: "managed" as const,
};

function harness() {
  let current = { ...session };
  let nickname = "worker";
  let live: { availability: "ready" | "unavailable"; status: "unknown" | "idle" | "active" | "error" } = {
    availability: "ready",
    status: "active",
  };
  let goalOwnsRecovery = false;
  const resumed: string[] = [];
  const resumedGoals: string[] = [];
  const recovery = new RuntimeRestartRecovery({
    listManaged: (endpointId) => endpointId === current.endpoint ? [{ nickname, session: current }] : [],
    resolve: (endpointId, threadId) => endpointId === current.endpoint && threadId === current.thread_id
      ? { nickname, session: current }
      : undefined,
    native: () => live,
    enqueueResume: ({ nickname }) => { resumed.push(nickname); },
    resumeActiveGoal: ({ nickname }) => {
      if (!goalOwnsRecovery) return false;
      resumedGoals.push(nickname);
      return true;
    },
  });
  return {
    recovery,
    resumed,
    resumedGoals,
    setLive: (value: typeof live) => { live = value; },
    setGoalOwnsRecovery: (value: boolean) => { goalOwnsRecovery = value; },
    replaceMapping: () => { current = { ...current, mapping_id: "mapping-2" }; },
    rename: (value: string) => { nickname = value; },
  };
}

test("a confirmed runtime loss resumes an observed active worker once it reconnects idle", () => {
  const value = harness();
  value.recovery.endpointUnavailable("prenyx", "runtime-lost");
  value.setLive({ availability: "ready", status: "idle" });

  value.recovery.endpointReady("prenyx");
  value.recovery.endpointReady("prenyx");

  assert.deepEqual(value.resumed, ["worker"]);
  assert.deepEqual(value.resumedGoals, []);
});

test("connection-only loss, idle workers, and still-active turns never receive a resume message", () => {
  const connection = harness();
  connection.recovery.endpointUnavailable("prenyx", "connection-lost");
  connection.setLive({ availability: "ready", status: "idle" });
  connection.recovery.endpointReady("prenyx");

  const idle = harness();
  idle.setLive({ availability: "ready", status: "idle" });
  idle.recovery.endpointUnavailable("prenyx", "runtime-lost");
  idle.recovery.endpointReady("prenyx");

  const running = harness();
  running.recovery.endpointUnavailable("prenyx", "runtime-lost");
  running.recovery.endpointReady("prenyx");

  assert.deepEqual(connection.resumed, []);
  assert.deepEqual(idle.resumed, []);
  assert.deepEqual(running.resumed, []);
});

test("an active goal owns restart continuation and an unavailable mapping waits for recovery", () => {
  const goal = harness();
  goal.recovery.endpointUnavailable("prenyx", "runtime-lost");
  goal.setLive({ availability: "ready", status: "idle" });
  goal.setGoalOwnsRecovery(true);
  goal.recovery.endpointReady("prenyx");
  assert.deepEqual(goal.resumed, []);
  assert.deepEqual(goal.resumedGoals, ["worker"]);

  const delayed = harness();
  delayed.recovery.endpointUnavailable("prenyx", "runtime-lost");
  delayed.setLive({ availability: "unavailable", status: "unknown" });
  delayed.recovery.endpointReady("prenyx");
  delayed.setLive({ availability: "ready", status: "idle" });
  delayed.recovery.endpointReady("prenyx");
  assert.deepEqual(delayed.resumed, ["worker"]);
});

test("a replaced managed mapping cannot inherit an interrupted turn", () => {
  const value = harness();
  value.recovery.endpointUnavailable("prenyx", "runtime-lost");
  value.replaceMapping();
  value.setLive({ availability: "ready", status: "idle" });
  value.recovery.endpointReady("prenyx");
  assert.deepEqual(value.resumed, []);
});

test("the same stable mapping resumes under its current nickname", () => {
  const value = harness();
  value.recovery.endpointUnavailable("prenyx", "runtime-lost");
  value.rename("renamed-worker");
  value.setLive({ availability: "ready", status: "idle" });
  value.recovery.endpointReady("prenyx");
  assert.deepEqual(value.resumed, ["renamed-worker"]);
});

test("an idle worker resumes when its provider does not own goal restart", () => {
  const value = harness();
  value.recovery.endpointUnavailable("prenyx", "runtime-lost");
  value.setLive({ availability: "ready", status: "idle" });
  value.setGoalOwnsRecovery(false);
  value.recovery.endpointReady("prenyx");
  assert.deepEqual(value.resumed, ["worker"]);
  assert.deepEqual(value.resumedGoals, []);
});
