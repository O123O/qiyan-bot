import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkerMemoryWatch,
  hostFreePercent,
  hostPressureWarningMessage,
  memoryWarningMessage,
  memorySharePercent,
  selectWatchTargets,
  type WorkerMemorySample,
  type WorkerMemoryTarget,
} from "../../src/sessions/worker-memory.ts";

const GB = 1024 ** 3;
const target: WorkerMemoryTarget = { nickname: "plug-serve", endpointId: "claude-local", threadId: "t1" };
const sample = (usedGb: number, limitGb: number, host?: { totalGb: number; availableGb: number }): WorkerMemorySample => ({
  usedBytes: usedGb * GB,
  limitBytes: limitGb * GB,
  scope: "session",
  ...(host ? { hostTotalBytes: host.totalGb * GB, hostAvailableBytes: host.availableGb * GB } : {}),
});

function harness(samples: (WorkerMemorySample | undefined)[]) {
  const sent: { nickname: string; message: string }[] = [];
  const errors: unknown[] = [];
  const unmeasured: number[] = [];
  let index = 0;
  let clock = 0;
  const watch = new WorkerMemoryWatch({
    targets: () => [target],
    sample: async () => samples[Math.min(index++, samples.length - 1)],
    warn: async (t, message) => { sent.push({ nickname: t.nickname, message }); },
    now: () => clock,
    onError: (error) => errors.push(error),
    onUnmeasured: (_t, consecutive) => unmeasured.push(consecutive),
  });
  return { watch, sent, errors, unmeasured, advance: (ms: number) => { clock += ms; } };
}

test("warns once when a worker crosses half the machine, and names the real figures", async () => {
  const { watch, sent } = harness([sample(186, 252)]);
  await watch.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.nickname, "plug-serve");
  assert.equal(
    sent[0]!.message,
    "[system] Warning, you used 74% memory of the system (186.0 GB of 252.0 GB), be careful about the oom, reduce unnecessary memory cost.",
  );
});

test("stays silent below the threshold and inside the hysteresis band", async () => {
  const quiet = harness([sample(10, 252)]);
  await quiet.watch.tick();
  assert.deepEqual(quiet.sent, []);
  const band = harness([sample(45, 100)]);
  await band.watch.tick();
  assert.deepEqual(band.sent, []);
});

test("does not repeat the warning until the repeat interval has passed", async () => {
  const { watch, sent, advance } = harness([sample(200, 252)]);
  await watch.tick();
  assert.equal(sent.length, 1);
  advance(14 * 60 * 1000);
  await watch.tick();
  assert.equal(sent.length, 1, "a worker still over the line is not nagged every tick");
  advance(2 * 60 * 1000);
  await watch.tick();
  assert.equal(sent.length, 2, "a worker that stays over the line is reminded");
});

test("dropping below the re-arm point lets the next crossing warn immediately", async () => {
  const { watch, sent, advance } = harness([sample(200, 252), sample(20, 252), sample(200, 252)]);
  await watch.tick();
  assert.equal(sent.length, 1);
  advance(1000);
  await watch.tick();
  assert.equal(sent.length, 1);
  advance(1000);
  await watch.tick();
  assert.equal(sent.length, 2, "a new crossing is a new warning, not a repeat");
});

test("an unreadable sample is not treated as recovery, and is counted out loud", async () => {
  const { watch, sent, unmeasured, advance } = harness([sample(200, 252), undefined, undefined, sample(200, 252)]);
  await watch.tick();
  assert.equal(sent.length, 1);
  advance(1000);
  await watch.tick();
  await watch.tick();
  assert.equal(sent.length, 1, "nothing is sent when nothing could be measured");
  assert.deepEqual(unmeasured, [1, 2], "the silence is counted so it can be reported");
  advance(1000);
  await watch.tick();
  assert.equal(sent.length, 1, "the unknown readings did not clear the latch");
});

test("a measurement that comes back resets the unmeasured count", async () => {
  const { watch, unmeasured } = harness([undefined, sample(1, 252), undefined]);
  await watch.tick();
  await watch.tick();
  await watch.tick();
  assert.deepEqual(unmeasured, [1, 1]);
});

// The failure the reviewer reproduced: one wedged endpoint used to stall the serial pass and,
// because the next timer was only scheduled in the tick's `finally`, silently end the watch for
// every other worker on every other host.
test("a hung send cannot stall the pass for the other workers", async () => {
  const other: WorkerMemoryTarget = { nickname: "qarl", endpointId: "ptyche", threadId: "t2" };
  const sent: string[] = [];
  const errors: unknown[] = [];
  const watch = new WorkerMemoryWatch({
    targets: () => [target, other],
    sample: async () => sample(3, 4),
    warn: (t) => {
      if (t.nickname === "plug-serve") return new Promise<void>(() => { /* never settles */ });
      sent.push(t.nickname);
      return Promise.resolve();
    },
    now: () => 0,
    onError: (error) => errors.push(error),
    opTimeoutMs: 50,
  });
  await watch.tick();
  assert.deepEqual(sent, ["qarl"], "the healthy worker was warned in the same pass");
  assert.equal(errors.length, 1);
  assert.match(String((errors[0] as Error).message), /timed out/u);
});

test("a hung sample is bounded rather than left to stall the pass", async () => {
  const unmeasured: string[] = [];
  const errors: unknown[] = [];
  const watch = new WorkerMemoryWatch({
    targets: () => [target],
    sample: () => new Promise(() => { /* never settles */ }),
    warn: async () => undefined,
    now: () => 0,
    onError: (error) => errors.push(error),
    onUnmeasured: (_t, _consecutive, reason) => unmeasured.push(reason),
    opTimeoutMs: 50,
  });
  await watch.tick();
  // It is a failure to MEASURE, so it takes the unmeasured ladder rather than reporting an
  // unthrottled error on every tick for as long as the host stays wedged.
  assert.equal(unmeasured.length, 1);
  assert.match(unmeasured[0]!, /sample timed out/u);
  assert.deepEqual(errors, []);
});

test("a sample or a send that throws is isolated, and the other workers still get their pass", async () => {
  const other: WorkerMemoryTarget = { nickname: "qarl", endpointId: "ptyche", threadId: "t2" };
  const sent: string[] = [];
  const unmeasured: string[] = [];
  const watch = new WorkerMemoryWatch({
    targets: () => [target, other],
    sample: async (t) => {
      if (t.nickname === "plug-serve") throw new Error("probe exploded");
      return sample(3, 4);
    },
    warn: async (t) => { sent.push(t.nickname); },
    now: () => 0,
    onUnmeasured: (_t, _consecutive, reason) => unmeasured.push(reason),
  });
  await watch.tick();
  assert.deepEqual(unmeasured, ["probe exploded"]);
  assert.deepEqual(sent, ["qarl"]);
});

test("a send that fails still reaches onError", async () => {
  const errors: unknown[] = [];
  const watch = new WorkerMemoryWatch({
    targets: () => [target],
    sample: async () => sample(200, 252),
    warn: async () => { throw new Error("session is busy"); },
    now: () => 0,
    onError: (error) => errors.push(error),
  });
  await watch.tick();
  assert.equal(errors.length, 1);
  assert.match(String((errors[0] as Error).message), /session is busy/u);
});

test("a worker that stops being watched does not keep its latch forever", async () => {
  let live: WorkerMemoryTarget[] = [target];
  const sent: string[] = [];
  let clock = 0;
  const watch = new WorkerMemoryWatch({
    targets: () => live,
    sample: async () => sample(200, 252),
    warn: async (t) => { sent.push(t.nickname); },
    now: () => clock,
  });
  await watch.tick();
  assert.equal(sent.length, 1);
  live = [];
  await watch.tick();
  live = [target];
  clock += 1000;
  await watch.tick();
  assert.equal(sent.length, 2, "the session came back as a new one, so its first crossing warns");
});

// A per-worker share cannot see the aggregate that actually fills a machine.
test("warns about the host itself when it is nearly full, even though no single worker is over its share", async () => {
  const { watch, sent, advance } = harness([sample(30, 252, { totalGb: 252, availableGb: 20 })]);
  await watch.tick();
  assert.equal(sent.length, 1, "12% free is the emergency even at a 12% personal share");
  assert.equal(
    sent[0]!.message,
    "[system] Warning, the machine is nearly full: 8% memory free (20.0 GB of 252.0 GB), and your own work is using 30.0 GB."
    + " Be careful about the oom, reduce unnecessary memory cost.",
  );
  advance(1000);
  await watch.tick();
  assert.equal(sent.length, 1, "host pressure is latched like any other warning");
});

test("host pressure and a personal share are separate warnings with separate latches", async () => {
  const { watch, sent, advance } = harness([sample(200, 252, { totalGb: 252, availableGb: 10 })]);
  await watch.tick();
  assert.equal(sent.length, 2);
  assert.match(sent[0]!.message, /the machine is nearly full/u);
  assert.match(sent[1]!.message, /you used 79% memory/u);
  advance(1000);
  await watch.tick();
  assert.equal(sent.length, 2);
});

test("host pressure re-arms only after the host has real room again", async () => {
  const tight = sample(10, 252, { totalGb: 100, availableGb: 10 });
  const better = sample(10, 252, { totalGb: 100, availableGb: 20 });
  const roomy = sample(10, 252, { totalGb: 100, availableGb: 30 });
  const { watch, sent, advance } = harness([tight, better, roomy, tight]);
  await watch.tick();
  assert.equal(sent.length, 1);
  advance(1000);
  await watch.tick();
  assert.equal(sent.length, 1, "20% free is inside the band: not warned, not re-armed");
  advance(1000);
  await watch.tick();
  assert.equal(sent.length, 1);
  advance(1000);
  await watch.tick();
  assert.equal(sent.length, 2, "re-armed at 30% free, so the next squeeze warns again");
});

test("a host that publishes no availability figure is simply not judged", async () => {
  const { watch, sent } = harness([sample(10, 252)]);
  await watch.tick();
  assert.deepEqual(sent, []);
  assert.equal(hostFreePercent(sample(10, 252)), undefined);
});

// A stop/start pair used to leave the in-flight tick's `finally` scheduling a second, orphaned
// timer chain that nothing could ever cancel.
test("stopping during a tick does not leave a second timer chain running", async () => {
  const timers: { fn: () => void; cancelled: boolean }[] = [];
  let releaseSample!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseSample = resolve; });
  const watch = new WorkerMemoryWatch({
    targets: () => [target],
    sample: async () => { await blocked; return undefined; },
    warn: async () => undefined,
    now: () => 0,
    pollIntervalMs: 1,
    setTimer: (fn) => {
      const entry = { fn, cancelled: false };
      timers.push(entry);
      return { cancel: () => { entry.cancelled = true; } };
    },
  });
  watch.start();
  assert.equal(timers.length, 1);
  const inFlight = watch.tick();
  watch.stop();
  watch.start();
  assert.equal(timers.length, 2, "the restart armed exactly one new timer");
  releaseSample();
  await inFlight;
  assert.equal(timers.length, 2, "the stopped generation's tick did not arm a third");
  const live = timers.filter((entry) => !entry.cancelled);
  assert.equal(live.length, 1, "exactly one chain survives a stop/start pair");
});

test("picks one session per endpoint when a reading covers the whole endpoint", () => {
  const sessions: WorkerMemoryTarget[] = [
    { nickname: "zeta", endpointId: "ptyche", threadId: "a" },
    { nickname: "alpha", endpointId: "ptyche", threadId: "b" },
    { nickname: "mid", endpointId: "ptyche", threadId: "c" },
    { nickname: "plug-serve", endpointId: "claude-local", threadId: "d" },
    { nickname: "brainstorm", endpointId: "claude-local", threadId: "e" },
    { nickname: "orphan", endpointId: "unwatched", threadId: "f" },
  ];
  const scopeOf = (id: string) => id === "claude-local" ? "session" as const : id === "ptyche" ? "endpoint" as const : undefined;
  const chosen = selectWatchTargets(sessions, scopeOf).map((entry) => entry.nickname).sort();
  assert.deepEqual(chosen, ["alpha", "brainstorm", "plug-serve"]);
});

test("an endpoint-wide reading does not claim the memory is yours alone", () => {
  const endpointWide: WorkerMemorySample = { usedBytes: 3 * GB, limitBytes: 4 * GB, scope: "endpoint" };
  assert.match(memoryWarningMessage(endpointWide, 75), /^\[system\] Warning, the work on your endpoint used 75% memory of the system/u);
  assert.match(memoryWarningMessage(sample(3, 4), 75), /^\[system\] Warning, you used 75% memory of the system/u);
});

test("a share that cannot be computed is reported as undefined rather than as zero", () => {
  assert.equal(memorySharePercent({ usedBytes: 1, limitBytes: 0, scope: "session" }), undefined);
  assert.equal(memorySharePercent({ usedBytes: -1, limitBytes: 10, scope: "session" }), undefined);
  assert.equal(memorySharePercent({ usedBytes: 5, limitBytes: 10, scope: "session" }), 50);
});

test("the message rounds the share and keeps one decimal on the sizes", () => {
  assert.match(
    memoryWarningMessage({ usedBytes: 2.55 * GB, limitBytes: 4 * GB, scope: "session" }, 63.75),
    /you used 64% memory of the system \(2\.5 GB of 4\.0 GB\)/u,
  );
  assert.match(
    hostPressureWarningMessage({ usedBytes: GB, limitBytes: 4 * GB, scope: "session", hostTotalBytes: 4 * GB, hostAvailableBytes: GB / 2 }, 12.5),
    /13% memory free \(0\.5 GB of 4\.0 GB\), and your own work is using 1\.0 GB/u,
  );
});

// N1: the generation counter stopped the rescheduling, but clearing `ticking` in stop() removed
// the only thing keeping two passes apart — and a concurrent prune() could delete a latch the
// other pass was about to write, producing two identical warnings at the same instant.
test("a stop and restart during a tick cannot produce two warnings at one instant", async () => {
  const sent: number[] = [];
  let live: WorkerMemoryTarget[] = [target];
  let releaseSample!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseSample = resolve; });
  let first = true;
  const watch = new WorkerMemoryWatch({
    targets: () => live,
    sample: async () => {
      if (first) { first = false; await blocked; }
      return sample(200, 252);
    },
    warn: async () => { sent.push(0); },
    now: () => 0,
    pollIntervalMs: 1,
    setTimer: (fn) => { const handle = setTimeout(fn, 0); return { cancel: () => clearTimeout(handle) }; },
  });
  const inFlight = watch.tick();
  watch.stop();
  watch.start();
  // The session list goes momentarily empty, which is what used to prune the latch mid-pass.
  live = [];
  await watch.tick();
  live = [target];
  await watch.tick();
  releaseSample();
  await inFlight;
  watch.stop();
  assert.equal(sent.length, 1, "one crossing, one warning, however the passes interleave");
});

test("a second tick cannot start while one is still running", async () => {
  let inFlightSamples = 0;
  let peak = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const watch = new WorkerMemoryWatch({
    targets: () => [target],
    sample: async () => {
      inFlightSamples += 1;
      peak = Math.max(peak, inFlightSamples);
      await blocked;
      inFlightSamples -= 1;
      return undefined;
    },
    warn: async () => undefined,
    now: () => 0,
  });
  const first = watch.tick();
  watch.stop();
  watch.start();
  await watch.tick();
  release();
  await first;
  watch.stop();
  assert.equal(peak, 1, "stop() must not let a second pass overlap the one in flight");
});

// N2: a timed-out sample used to reach onError and never increment the unmeasured ladder — so
// the escalation added for a silent watch never fired for a wedged host, and that host emitted
// an unthrottled operational warning on every single tick instead.
test("a hung sample counts as unmeasured, not as a bare error", async () => {
  const unmeasured: { consecutive: number; reason: string }[] = [];
  const errors: unknown[] = [];
  const watch = new WorkerMemoryWatch({
    targets: () => [target],
    sample: () => new Promise(() => { /* never settles */ }),
    warn: async () => undefined,
    now: () => 0,
    onError: (error) => errors.push(error),
    onUnmeasured: (_t, consecutive, reason) => unmeasured.push({ consecutive, reason }),
    opTimeoutMs: 20,
  });
  await watch.tick();
  await watch.tick();
  await watch.tick();
  assert.deepEqual(unmeasured.map((entry) => entry.consecutive), [1, 2, 3], "the ladder sees the wedged host");
  assert.match(unmeasured[0]!.reason, /timed out/u);
  assert.deepEqual(errors, [], "and it is not also reported as an unthrottled error every tick");
});

// N6: every session on a nearly-full host crossed the host line in the same pass, and the
// concurrent fan-out meant N turns started at once as the response to a full machine.
test("a nearly-full host produces one warning per endpoint, not one per session", async () => {
  const sessions: WorkerMemoryTarget[] = [
    { nickname: "a", endpointId: "claude-local", threadId: "t1" },
    { nickname: "b", endpointId: "claude-local", threadId: "t2" },
    { nickname: "c", endpointId: "claude-local", threadId: "t3" },
  ];
  const sent: string[] = [];
  const watch = new WorkerMemoryWatch({
    targets: () => sessions,
    sample: async () => sample(5, 252, { totalGb: 252, availableGb: 10 }),
    warn: async (t, message) => { if (/nearly full/u.test(message)) sent.push(t.nickname); },
    now: () => 0,
  });
  await watch.tick();
  assert.equal(sent.length, 1, "the host is one thing however many sessions sit on it");
});

// N3: the endpoint's single warning used to go to whichever nickname sorted first, which can be
// an idle session that owns none of the memory — starting a turn to tell it about someone
// else's work, while the session doing the work hears nothing.
test("an endpoint's warning goes to a session that is actually running", () => {
  const sessions: WorkerMemoryTarget[] = [
    { nickname: "zed", endpointId: "ptyche", threadId: "busy" },
    { nickname: "aria", endpointId: "ptyche", threadId: "idle" },
  ];
  const endpointScope = () => "endpoint" as const;
  assert.deepEqual(
    selectWatchTargets(sessions, endpointScope, (session) => session.threadId === "busy").map((entry) => entry.nickname),
    ["zed"],
  );
  // With nobody busy the choice stays the stable one, so the carrier does not wander.
  assert.deepEqual(selectWatchTargets(sessions, endpointScope).map((entry) => entry.nickname), ["aria"]);
});

test("an endpoint-wide latch survives the carrier changing", async () => {
  let carrier: WorkerMemoryTarget = { nickname: "aria", endpointId: "ptyche", threadId: "t1" };
  const sent: string[] = [];
  let clock = 0;
  const watch = new WorkerMemoryWatch({
    targets: () => [carrier],
    sample: async () => ({ usedBytes: 200 * GB, limitBytes: 252 * GB, scope: "endpoint" }),
    warn: async (t) => { sent.push(t.nickname); },
    now: () => clock,
  });
  await watch.tick();
  assert.deepEqual(sent, ["aria"]);
  // A busier session takes over as carrier a minute later; the endpoint's throttle must hold.
  carrier = { nickname: "zed", endpointId: "ptyche", threadId: "t2" };
  clock += 60_000;
  await watch.tick();
  assert.deepEqual(sent, ["aria"], "changing which session carries it does not reset the interval");
});
