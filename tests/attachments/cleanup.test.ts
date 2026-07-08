import assert from "node:assert/strict";
import test from "node:test";
import { AttachmentCleanup, type CleanupTimers } from "../../src/attachments/cleanup.ts";

const DAY_MS = 24 * 60 * 60_000;

type ScheduledCleanup = {
  callback: () => void;
  handle: ReturnType<typeof setTimeout>;
  ms: number;
};

class FakeCleanupTimers implements CleanupTimers {
  readonly cleared: Array<ReturnType<typeof setTimeout>> = [];
  readonly scheduled: ScheduledCleanup[] = [];
  private nextHandle = 1;

  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const handle = this.nextHandle as unknown as ReturnType<typeof setTimeout>;
    this.nextHandle += 1;
    this.scheduled.push({ callback, handle, ms });
    return handle;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.cleared.push(handle);
    const index = this.scheduled.findIndex((scheduled) => scheduled.handle === handle);
    if (index >= 0) this.scheduled.splice(index, 1);
  }

  takeNext(): ScheduledCleanup {
    const next = this.scheduled.shift();
    assert.ok(next);
    return next;
  }

  peekNext(): ScheduledCleanup {
    const next = this.scheduled[0];
    assert.ok(next);
    return next;
  }
}

test("attachment cleanup runs at startup, schedules daily without overlap, and waits on stop", async () => {
  const timers = new FakeCleanupTimers();
  let calls = 0;
  let releaseBlockedRun: (() => void) | undefined;
  const blockedRun = new Promise<void>((resolve) => { releaseBlockedRun = resolve; });
  const cleanup = new AttachmentCleanup(async () => {
    calls += 1;
    if (calls === 2) await blockedRun;
    return 0;
  }, () => { assert.fail("unexpected cleanup failure"); }, timers);

  await cleanup.start();

  assert.equal(calls, 1);
  assert.equal(timers.scheduled.length, 1);
  const scheduled = timers.takeNext();
  assert.equal(scheduled.ms, DAY_MS);

  scheduled.callback();
  assert.equal(calls, 2);
  scheduled.callback();
  await Promise.resolve();
  assert.equal(calls, 2, "a repeated timer callback cannot overlap the active cleanup");

  let stopped = false;
  const stopping = cleanup.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false, "stop waits for the active cleanup");

  assert.ok(releaseBlockedRun);
  releaseBlockedRun();
  await stopping;
  assert.equal(timers.scheduled.length, 0, "stop prevents future scheduling");
});

test("attachment cleanup reports metadata-only failure and retries the next day", async () => {
  const timers = new FakeCleanupTimers();
  let calls = 0;
  let errors = 0;
  const cleanup = new AttachmentCleanup(async () => {
    calls += 1;
    if (calls === 1) throw new Error("cleanup failed");
    return 0;
  }, () => { errors += 1; }, timers);

  await cleanup.start();

  assert.equal(calls, 1);
  assert.equal(errors, 1);
  assert.equal(timers.scheduled.length, 1);
  const retry = timers.takeNext();
  assert.equal(retry.ms, DAY_MS);

  retry.callback();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(calls, 2);
  assert.equal(errors, 1);
  assert.equal(timers.scheduled.length, 1);

  await cleanup.stop();
  assert.equal(timers.scheduled.length, 0);
  assert.equal(timers.cleared.length, 1);
});

test("a captured cleanup callback is inert after stop", async () => {
  const timers = new FakeCleanupTimers();
  let calls = 0;
  const cleanup = new AttachmentCleanup(async () => {
    calls += 1;
    return 0;
  }, () => { assert.fail("unexpected cleanup failure"); }, timers);

  await cleanup.start();
  const stale = timers.peekNext();
  await cleanup.stop();

  stale.callback();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(calls, 1);
  assert.equal(timers.scheduled.length, 0);
});

test("a callback from an old generation cannot disturb a restarted cleanup timer", async () => {
  const timers = new FakeCleanupTimers();
  let calls = 0;
  const cleanup = new AttachmentCleanup(async () => {
    calls += 1;
    return 0;
  }, () => { assert.fail("unexpected cleanup failure"); }, timers);

  await cleanup.start();
  const stale = timers.peekNext();
  await cleanup.stop();
  await cleanup.start();
  const current = timers.peekNext();

  stale.callback();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(calls, 2);
  assert.deepEqual(timers.scheduled.map(({ handle }) => handle), [current.handle]);

  await cleanup.stop();
  assert.equal(timers.scheduled.length, 0);
  assert.deepEqual(timers.cleared, [stale.handle, current.handle]);
});
