import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkerMemoryWatch,
  memoryWarningMessage,
  memorySharePercent,
  type WorkerMemorySample,
  type WorkerMemoryTarget,
} from "../../src/sessions/worker-memory.ts";

const GB = 1024 ** 3;
const target: WorkerMemoryTarget = { nickname: "plug-serve", endpointId: "claude-local", threadId: "t1" };

function harness(samples: (WorkerMemorySample | undefined)[]) {
  const sent: { nickname: string; message: string }[] = [];
  const errors: unknown[] = [];
  let index = 0;
  let clock = 0;
  const watch = new WorkerMemoryWatch({
    targets: () => [target],
    sample: async () => samples[Math.min(index++, samples.length - 1)],
    warn: async (t, message) => { sent.push({ nickname: t.nickname, message }); },
    now: () => clock,
    onError: (error) => errors.push(error),
  });
  return { watch, sent, errors, advance: (ms: number) => { clock += ms; }, setClock: (ms: number) => { clock = ms; } };
}

test("warns once when a worker crosses half the machine, and names the real figures", async () => {
  const { watch, sent } = harness([{ usedBytes: 186 * GB, limitBytes: 252 * GB }]);
  await watch.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.nickname, "plug-serve");
  assert.equal(
    sent[0]!.message,
    "[system] Warning, you used 74% memory of the system (186.0 GB of 252.0 GB), be careful about the oom, reduce unnecessary memory cost.",
  );
});

test("stays silent below the threshold and inside the hysteresis band", async () => {
  const quiet = harness([{ usedBytes: 10 * GB, limitBytes: 252 * GB }]);
  await quiet.watch.tick();
  assert.deepEqual(quiet.sent, []);
  // 45% is above the re-arm point but not above the warn point: neither warn nor re-arm.
  const band = harness([{ usedBytes: 45 * GB, limitBytes: 100 * GB }]);
  await band.watch.tick();
  assert.deepEqual(band.sent, []);
});

test("does not repeat the warning until the repeat interval has passed", async () => {
  const high = { usedBytes: 200 * GB, limitBytes: 252 * GB };
  const { watch, sent, advance } = harness([high, high, high]);
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
  const high = { usedBytes: 200 * GB, limitBytes: 252 * GB };
  const low = { usedBytes: 20 * GB, limitBytes: 252 * GB };
  const { watch, sent, advance } = harness([high, low, high]);
  await watch.tick();
  assert.equal(sent.length, 1);
  advance(1000);
  await watch.tick();
  assert.equal(sent.length, 1);
  advance(1000);
  await watch.tick();
  assert.equal(sent.length, 2, "a new crossing is a new warning, not a repeat");
});

test("an unreadable sample is not treated as recovery", async () => {
  const high = { usedBytes: 200 * GB, limitBytes: 252 * GB };
  const { watch, sent, advance } = harness([high, undefined, high]);
  await watch.tick();
  assert.equal(sent.length, 1);
  advance(1000);
  await watch.tick();
  assert.equal(sent.length, 1, "nothing is sent when nothing could be measured");
  advance(1000);
  await watch.tick();
  assert.equal(sent.length, 1, "the unknown reading did not clear the latch");
});

test("a sample or a send that throws is isolated, and the other workers still get their pass", async () => {
  const other: WorkerMemoryTarget = { nickname: "qarl", endpointId: "ptyche", threadId: "t2" };
  const sent: string[] = [];
  const errors: unknown[] = [];
  const watch = new WorkerMemoryWatch({
    targets: () => [target, other],
    sample: async (t) => {
      if (t.nickname === "plug-serve") throw new Error("probe exploded");
      return { usedBytes: 3 * GB, limitBytes: 4 * GB };
    },
    warn: async (t) => { sent.push(t.nickname); },
    now: () => 0,
    onError: (error) => errors.push(error),
  });
  await watch.tick();
  assert.equal(errors.length, 1);
  assert.deepEqual(sent, ["qarl"]);
});

test("a worker that stops being watched does not keep its latch forever", async () => {
  const high = { usedBytes: 200 * GB, limitBytes: 252 * GB };
  let live: WorkerMemoryTarget[] = [target];
  const sent: string[] = [];
  let clock = 0;
  const watch = new WorkerMemoryWatch({
    targets: () => live,
    sample: async () => high,
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

test("a share that cannot be computed is reported as undefined rather than as zero", () => {
  assert.equal(memorySharePercent({ usedBytes: 1, limitBytes: 0 }), undefined);
  assert.equal(memorySharePercent({ usedBytes: -1, limitBytes: 10 }), undefined);
  assert.equal(memorySharePercent({ usedBytes: 5, limitBytes: 10 }), 50);
});

test("the message rounds the share and keeps one decimal on the sizes", () => {
  assert.match(memoryWarningMessage({ usedBytes: 2.55 * GB, limitBytes: 4 * GB }, 63.75), /you used 64% memory of the system \(2\.5 GB of 4\.0 GB\)/u);
});
