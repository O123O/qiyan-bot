import assert from "node:assert/strict";
import test from "node:test";
import { CoordinatorScheduler } from "../../src/coordinator/scheduler.ts";

test("scheduler serializes turns, prioritizes users, then services events after five users", async () => {
  const order: string[] = [];
  let release!: () => void;
  const first = new Promise<void>((resolve) => { release = resolve; });
  const scheduler = new CoordinatorScheduler(async (job) => { order.push(job.id); if (job.id === "u1") await first; });
  scheduler.enqueueUser({ id: "u1", payload: {} });
  scheduler.enqueueEvent({ id: "e1", sessionKey: "s", payload: {} });
  for (let index = 2; index <= 7; index += 1) scheduler.enqueueUser({ id: `u${index}`, payload: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["u1"]);
  release();
  await scheduler.idle();
  assert.deepEqual(order, ["u1", "u2", "u3", "u4", "u5", "batch:e1", "u6", "u7"]);
});

test("event batches preserve per-session order and enforce item and byte caps", async () => {
  const seen: any[] = [];
  const scheduler = new CoordinatorScheduler(async (job) => { seen.push(job); }, { maxBatchEvents: 2, maxBatchBytes: 80, batchWindowMs: 0 });
  scheduler.enqueueEvent({ id: "a", sessionKey: "one", payload: { status: "active" } });
  scheduler.enqueueEvent({ id: "b", sessionKey: "one", payload: { final: true } });
  scheduler.enqueueEvent({ id: "c", sessionKey: "two", payload: { final: true } });
  await scheduler.idle();
  assert.deepEqual(seen.flatMap((job) => job.events?.map((event: any) => event.id) ?? []), ["a", "b", "c"]);
  assert.ok(seen.every((job) => !job.events || job.events.length <= 2));
});

test("events wait for the batch window but a 30-second-old event cannot starve", async () => {
  let now = 0;
  const timers: Array<() => void> = [];
  const seen: string[] = [];
  const scheduler = new CoordinatorScheduler(async (job) => { seen.push(job.id); }, {
    now: () => now,
    setTimeout: ((callback: () => void) => { timers.push(callback); return { unref() {} }; }) as any,
    clearTimeout: (() => undefined) as any,
  });
  scheduler.enqueueEvent({ id: "e", sessionKey: "s", payload: { final: true } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, []);
  now = 30_000;
  timers.shift()?.();
  await scheduler.idle();
  assert.deepEqual(seen, ["batch:e"]);
});

test("a failed job is reported and does not stop later durable jobs", async () => {
  const executed: string[] = [];
  const failed: string[] = [];
  const scheduler = new CoordinatorScheduler(async (job) => {
    executed.push(job.id);
    if (job.id === "bad") throw new Error("pre-dispatch failure");
  }, { onError: (job) => { failed.push(job.id); } });
  scheduler.enqueueUser({ id: "bad", payload: {} });
  scheduler.enqueueUser({ id: "next", payload: {} });
  await scheduler.idle();
  assert.deepEqual(executed, ["bad", "next"]);
  assert.deepEqual(failed, ["bad"]);
});
