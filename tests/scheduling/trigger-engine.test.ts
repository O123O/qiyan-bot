import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "../../src/storage/database.ts";
import { ScheduleStore, type ScheduleRow } from "../../src/scheduling/schedule-store.ts";
import { TriggerEngine } from "../../src/scheduling/trigger-engine.ts";

function harness() {
  const store = new ScheduleStore(createTestDatabase());
  let clock = 10_000;
  const fired: ScheduleRow[] = [];
  const checks: string[] = [];
  let checkResult = true;
  const engine = new TriggerEngine({
    store,
    now: () => clock,
    fire: async (row) => { fired.push(row); },
    runCheck: async (row) => { checks.push(row.id); return checkResult; },
    setTimer: () => ({ cancel: () => undefined }), // no auto-loop; tests drive tick()
  });
  return {
    store, engine, fired, checks,
    at: (t: number) => { clock = t; },
    setCheck: (v: boolean) => { checkResult = v; },
  };
}

const base = { nickname: "s1", endpointId: "claude-local", threadId: "t1", message: "wake up and continue" };

test("a wakeup fires once when due, then is done", async () => {
  const h = harness();
  h.store.create({ ...base, kind: "wakeup", spec: "20000", nextFireAt: 20_000 }, 10_000);

  h.at(15_000); await h.engine.tick();
  assert.equal(h.fired.length, 0); // not due yet

  h.at(20_000); await h.engine.tick();
  assert.equal(h.fired.length, 1);
  assert.equal(h.fired[0]?.message, "wake up and continue");

  h.at(25_000); await h.engine.tick();
  assert.equal(h.fired.length, 1); // one-shot: done, never fires again
});

test("firing is single-fire idempotent across repeated ticks at the same instant", async () => {
  const h = harness();
  h.store.create({ ...base, kind: "wakeup", spec: "20000", nextFireAt: 20_000 }, 10_000);
  h.at(20_000);
  await h.engine.tick();
  await h.engine.tick(); // simulates a duplicate / restart-at-fire
  assert.equal(h.fired.length, 1);
});

test("a cron re-arms and fires each interval", async () => {
  const h = harness();
  h.store.create({ ...base, kind: "cron", spec: "every 60s", nextFireAt: 20_000, intervalMs: 60_000 }, 10_000);
  h.at(20_000); await h.engine.tick();
  h.at(80_000); await h.engine.tick();
  h.at(140_000); await h.engine.tick();
  assert.equal(h.fired.length, 3);
});

test("a monitor fires only when its check passes, and keeps polling", async () => {
  const h = harness();
  h.store.create({ ...base, kind: "monitor", spec: "test -f /tmp/ready", nextFireAt: 20_000, intervalMs: 5_000 }, 10_000);

  h.setCheck(false);
  h.at(20_000); await h.engine.tick();
  assert.equal(h.fired.length, 0);
  assert.equal(h.checks.length, 1); // polled, condition false -> re-armed

  h.setCheck(true);
  h.at(25_000); await h.engine.tick();
  assert.equal(h.fired.length, 1); // condition true -> fires

  // still armed (re-polls) after firing
  h.at(30_000); await h.engine.tick();
  assert.equal(h.checks.length, 3);
});

test("recovery: a schedule missed while QiYan was down fires on the first tick", async () => {
  const h = harness();
  // armed with a next_fire_at far in the past (bot was down)
  h.store.create({ ...base, kind: "wakeup", spec: "5000", nextFireAt: 5_000 }, 1_000);
  h.at(100_000); // now, long after
  await h.engine.tick();
  assert.equal(h.fired.length, 1);
});

test("cancel disarms a schedule so it never fires", async () => {
  const h = harness();
  const row = h.store.create({ ...base, kind: "wakeup", spec: "20000", nextFireAt: 20_000 }, 10_000);
  assert.equal(h.store.cancel(row.id), true);
  h.at(20_000); await h.engine.tick();
  assert.equal(h.fired.length, 0);
  assert.equal(h.store.listForSession("claude-local", "t1").length, 0);
});
