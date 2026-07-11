import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestDatabase } from "../../src/storage/database.ts";
import { SchedulingService } from "../../src/scheduling/scheduling-service.ts";
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
