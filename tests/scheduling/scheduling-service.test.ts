import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestDatabase } from "../../src/storage/database.ts";
import { SchedulingService } from "../../src/scheduling/scheduling-service.ts";
import { ClaudeGoalStore } from "../../src/sessions/claude-goals.ts";
import { AppError } from "../../src/core/errors.ts";

async function harness(send: (nickname: string, message: string, key: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-sched-svc-"));
  const svc = new SchedulingService({
    db: createTestDatabase(),
    now: () => 1_000_000,
    mcpConfigDir: dir,
    send,
    runCheck: async () => false,
  });
  svc.store.create({ nickname: "s1", endpointId: "claude-local", threadId: "t1", kind: "wakeup", spec: "0", message: "go", nextFireAt: 1_000_000 }, 1_000_000);
  return svc;
}

test("an ambiguous send failure is NOT re-sent (no double-delivery) and the schedule advances", async () => {
  let calls = 0;
  const svc = await harness(async () => { calls += 1; throw new AppError("OPERATION_UNCERTAIN", "maybe delivered"); });
  await svc.runDueOnce();
  await svc.runDueOnce(); // even on a second pass...
  assert.equal(calls, 1); // ...it is not re-sent
  assert.equal(svc.store.listForSession("claude-local", "t1").length, 0); // schedule advanced to done
});

test("a proven-not-dispatched failure (SESSION_BUSY) is retried until it succeeds", async () => {
  let calls = 0;
  const svc = await harness(async () => { calls += 1; if (calls < 3) throw new AppError("SESSION_BUSY", "turn running"); });
  await svc.runDueOnce(); // busy
  await svc.runDueOnce(); // busy
  await svc.runDueOnce(); // delivers
  assert.equal(calls, 3);
  assert.equal(svc.store.listForSession("claude-local", "t1").length, 0); // done after delivery
});

test("a clean success fires once and advances", async () => {
  let calls = 0;
  const svc = await harness(async () => { calls += 1; });
  await svc.runDueOnce();
  await svc.runDueOnce();
  assert.equal(calls, 1);
});

// A goal auto-drive is enqueued when a pursuit turn completes and fires GOAL_DRIVE_DELAY_MS
// later. If the goal stops being active in that window (cancel deletes it; pause/complete/blocked
// change its status), the pending drive MUST NOT send — otherwise a stopped goal drives one more
// turn that collides with the user's next send ("turn already running").
async function goalHarness(): Promise<{ svc: SchedulingService; goals: ClaudeGoalStore; sends: () => number; tick: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-sched-goal-"));
  const db = createTestDatabase();
  const goals = new ClaudeGoalStore(db);
  let clock = 1_000_000;
  let calls = 0;
  const svc = new SchedulingService({ db, now: () => clock, mcpConfigDir: dir, send: async () => { calls += 1; }, runCheck: async () => false, goals });
  return { svc, goals, sends: () => calls, tick: async () => { clock += 5_000; await svc.runDueOnce(); } };
}

test("an active goal drives, but a cancelled/paused/complete goal drops its pending drive", async () => {
  const session = { nickname: "s1", endpointId: "claude-local", threadId: "t1" };
  for (const stop of [
    (h: ClaudeGoalStore) => h.clear("claude-local", "t1"),                       // cancel_goal
    (h: ClaudeGoalStore) => h.setStatus("claude-local", "t1", "paused", 1),      // pause_goal
    (h: ClaudeGoalStore) => h.setStatus("claude-local", "t1", "complete", 1),    // worker set_goal_status
    (h: ClaudeGoalStore) => h.setStatus("claude-local", "t1", "blocked", 1),
  ]) {
    const { svc, goals, sends, tick } = await goalHarness();
    goals.set("claude-local", "t1", { objective: "keep going" }, 1_000_000);
    svc.enqueueGoalDrive(session, "continue");
    await tick();
    assert.equal(sends(), 1, "an active goal fires its drive");
    // A second drive is enqueued (as if the prior turn completed), then the goal is stopped
    // before it fires — the stale drive must be dropped.
    svc.enqueueGoalDrive(session, "continue");
    stop(goals);
    await tick();
    assert.equal(sends(), 1, "a stopped goal does NOT drive another turn");
  }
});
