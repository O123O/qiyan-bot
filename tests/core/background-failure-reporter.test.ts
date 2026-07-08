import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundFailureReporter, createFailureCycle } from "../../src/core/background-failure-reporter.ts";

test("an episode notifies once at its threshold and resets after resolution", () => {
  const operational: string[] = [];
  const durable: Array<{ id: string; label: string; incident: number }> = [];
  const reporter = createBackgroundFailureReporter({
    runId: "test-run",
    onOperational: (label) => { operational.push(label); },
    onDurable: (notice) => { durable.push(notice); },
  });

  reporter.report("periodic project reconciliation", { episode: "project", notifyAfter: 3 });
  reporter.report("periodic project reconciliation", { episode: "project", notifyAfter: 3 });
  assert.equal(durable.length, 0);
  reporter.report("periodic project reconciliation", { episode: "project", notifyAfter: 3 });
  reporter.report("periodic project reconciliation", { episode: "project", notifyAfter: 3 });
  assert.deepEqual(durable, [{
    id: "background-failure:test-run:1",
    label: "periodic project reconciliation",
    incident: 1,
  }]);

  reporter.resolve("project");
  reporter.report("periodic project reconciliation", { episode: "project", notifyAfter: 3 });
  reporter.report("periodic project reconciliation", { episode: "project", notifyAfter: 3 });
  reporter.report("periodic project reconciliation", { episode: "project", notifyAfter: 3 });
  assert.deepEqual(durable.map((notice) => notice.id), [
    "background-failure:test-run:1",
    "background-failure:test-run:2",
  ]);
  assert.equal(operational.length, 7);
});

test("callback failures are contained and a failed durable attempt remains retryable", () => {
  const attempted: BackgroundFailureAttempt[] = [];
  let durableCalls = 0;
  const reporter = createBackgroundFailureReporter({
    runId: "retry-run",
    onOperational: () => { throw new Error("operational sink failed"); },
    onDurable: (notice) => {
      attempted.push(notice);
      durableCalls += 1;
      if (durableCalls === 1) throw new Error("durable sink failed");
    },
  });

  assert.doesNotThrow(() => reporter.report("maintenance", { episode: "maintenance" }));
  assert.doesNotThrow(() => reporter.report("maintenance", { episode: "maintenance" }));
  reporter.report("maintenance", { episode: "maintenance" });

  assert.deepEqual(attempted, [
    { id: "background-failure:retry-run:1", label: "maintenance", incident: 1 },
    { id: "background-failure:retry-run:2", label: "maintenance", incident: 2 },
  ]);
});

test("non-episode reports notify immediately and separate episodes are independent", () => {
  const durable: BackgroundFailureAttempt[] = [];
  const reporter = createBackgroundFailureReporter({
    runId: "independent-run",
    onOperational: () => undefined,
    onDurable: (notice) => { durable.push(notice); },
  });

  reporter.report("dashboard rendering");
  reporter.report("dashboard rendering");
  reporter.report("project", { episode: "project", notifyAfter: 2 });
  reporter.report("managed", { episode: "managed", notifyAfter: 2 });
  reporter.report("project", { episode: "project", notifyAfter: 2 });
  assert.deepEqual(durable.map((notice) => notice.label), ["dashboard rendering", "dashboard rendering", "project"]);
  assert.deepEqual(durable.map((notice) => Object.keys(notice).sort()), [
    ["id", "incident", "label"],
    ["id", "incident", "label"],
    ["id", "incident", "label"],
  ]);
});

test("invalid reporter configuration and thresholds are rejected", () => {
  assert.throws(() => createBackgroundFailureReporter({
    runId: "invalid:run",
    onOperational: () => undefined,
    onDurable: () => undefined,
  }), /invalid background failure run id/u);
  const reporter = createBackgroundFailureReporter({
    runId: "validation-run",
    onOperational: () => undefined,
    onDurable: () => undefined,
  });
  for (const notifyAfter of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => reporter.report("maintenance", { episode: "maintenance", notifyAfter }), /notification threshold/u);
  }
  reporter.report("maintenance", { episode: "maintenance", notifyAfter: 2 });
  assert.throws(
    () => reporter.report("different label", { episode: "maintenance", notifyAfter: 2 }),
    /episode configuration changed/u,
  );
});

test("a multi-endpoint cycle reports at most one failure and failure wins mixed outcomes", () => {
  const events: string[] = [];
  const cycle = createFailureCycle({
    onFailed: () => { events.push("failed"); },
    onResolved: () => { events.push("resolved"); },
  });

  cycle.failed();
  cycle.failed();
  cycle.succeeded();
  cycle.inconclusive();
  cycle.finish();

  assert.deepEqual(events, ["failed"]);
  assert.throws(() => cycle.finish(), /already finished/u);
  assert.throws(() => cycle.succeeded(), /already finished/u);
});

test("a cycle resolves only after conclusive success or no applicable endpoints", () => {
  const events: string[] = [];
  const inconclusive = createFailureCycle({
    onFailed: () => { events.push("failed"); },
    onResolved: () => { events.push("resolved"); },
  });
  inconclusive.succeeded();
  inconclusive.inconclusive();
  inconclusive.finish();
  assert.equal(events.length, 0);

  const successful = createFailureCycle({
    onFailed: () => { events.push("failed"); },
    onResolved: () => { events.push("resolved"); },
  });
  successful.succeeded();
  successful.succeeded();
  successful.finish();

  const inapplicable = createFailureCycle({
    onFailed: () => { events.push("failed"); },
    onResolved: () => { events.push("resolved"); },
  });
  inapplicable.finish();
  assert.deepEqual(events, ["resolved", "resolved"]);
});

test("three failed maintenance cycles notify once regardless of endpoint count and reset after success", () => {
  const durable: BackgroundFailureAttempt[] = [];
  const reporter = createBackgroundFailureReporter({
    runId: "cycle-run",
    onOperational: () => undefined,
    onDurable: (notice) => { durable.push(notice); },
  });
  const runCycle = (outcomes: Array<"failed" | "succeeded" | "inconclusive">) => {
    const cycle = createFailureCycle({
      onFailed: () => reporter.report("periodic project reconciliation", { episode: "project", notifyAfter: 3 }),
      onResolved: () => reporter.resolve("project"),
    });
    for (const outcome of outcomes) cycle[outcome]();
    cycle.finish();
  };

  runCycle(["failed", "failed", "failed"]);
  runCycle(["succeeded", "failed"]);
  assert.equal(durable.length, 0);
  runCycle(["inconclusive"]);
  assert.equal(durable.length, 0);
  runCycle(["failed"]);
  runCycle(["failed"]);
  assert.deepEqual(durable.map((notice) => notice.id), ["background-failure:cycle-run:1"]);
  runCycle(["succeeded"]);
  runCycle(["failed"]);
  runCycle(["failed"]);
  runCycle(["failed"]);
  assert.deepEqual(durable.map((notice) => notice.id), [
    "background-failure:cycle-run:1",
    "background-failure:cycle-run:2",
  ]);
});

type BackgroundFailureAttempt = { id: string; label: string; incident: number };
