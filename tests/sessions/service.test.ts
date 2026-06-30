import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AppServerEndpoint } from "../../src/app-server/pool.ts";
import { AppServerPool } from "../../src/app-server/pool.ts";
import { AppError } from "../../src/core/errors.ts";
import { SessionRegistry } from "../../src/registry/session-registry.ts";
import { FinalMessageStore } from "../../src/sessions/final-messages.ts";
import { SessionService } from "../../src/sessions/service.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { RuntimeStore } from "../../src/storage/runtime-store.ts";

class ServiceEndpoint implements AppServerEndpoint {
  readonly id = "local";
  state: AppServerEndpoint["state"] = "ready";
  readonly calls: Array<{ method: string; params: any }> = [];
  status = "idle";
  activeTurnId = "active-1";
  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    if (method === "turn/start") return { turn: { id: "started-1" } } as T;
    if (method === "turn/steer") return { turnId: params.expectedTurnId } as T;
    if (method === "thread/read") return { thread: { id: "thread", cwd: params.cwd, status: { type: this.status }, turns: [] } } as T;
    if (method === "thread/goal/get") return { goal: null } as T;
    if (method === "model/list") return { data: [{ id: "gpt-5" }], nextCursor: null } as T;
    return { goal: { objective: params.objective, status: params.status } } as T;
  }
}

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "codex-bot-service-")));
  const registry = await SessionRegistry.open(join(dir, "sessions.json"), {
    version: 1, coordinator: { endpoint: "local", thread_id: "coord", project_dir: dir },
    sessions: { payments: { endpoint: "local", thread_id: "thread", project_dir: dir } },
  });
  const db = createTestDatabase();
  const endpoint = new ServiceEndpoint();
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 4 });
  const runtime = new RuntimeStore(db);
  runtime.setSession("local", "thread", "managed", "idle");
  const finals = new FinalMessageStore(db);
  const deliveries = new DeliveryStore(db);
  const service = new SessionService(pool, registry, runtime, finals, deliveries);
  return { endpoint, runtime, finals, deliveries, service };
}

test("starts idle sessions, steers active sessions, and interrupts the exact turn", async () => {
  const { endpoint, runtime, service } = await fixture();
  await service.setModel("payments", "gpt-5");
  await service.setEffort("payments", "high");
  const started = await service.send("payments", "hello", { clientUserMessageId: "msg-1" });
  assert.equal(started.turnId, "started-1");
  assert.deepEqual(endpoint.calls.find((call) => call.method === "turn/start")?.params, {
    threadId: "thread", clientUserMessageId: "msg-1", input: [{ type: "text", text: "hello", text_elements: [] }], model: "gpt-5", effort: "high",
  });
  assert.deepEqual(runtime.settings("local", "thread"), {});

  runtime.setActiveTurn("local", "thread", "active-1");
  assert.equal((await service.send("payments", "more")).mode, "steer");
  await service.interrupt("payments", "active-1");
  assert.ok(endpoint.calls.some((call) => call.method === "turn/interrupt" && call.params.turnId === "active-1"));
});

test("send enforces managed state and start/steer preconditions", async () => {
  const { runtime, service } = await fixture();
  runtime.setSession("local", "thread", "detached", "idle");
  await assert.rejects(service.send("payments", "x"), (error: unknown) => error instanceof AppError && error.code === "SESSION_DETACHED");
  runtime.setSession("local", "thread", "managed", "idle");
  await assert.rejects(service.send("payments", "x", { mode: "steer" }), (error: unknown) => error instanceof AppError && error.code === "SESSION_IDLE");
});

test("collect returns coordinator bodies or creates chronological direct deliveries", async () => {
  const { finals, deliveries, service } = await fixture();
  finals.persistTerminalTurn("local", "thread", { id: "one", status: "completed", completedAt: 1, items: [{ type: "agentMessage", id: "i1", text: "old", phase: "final_answer" }] }, 1);
  finals.persistTerminalTurn("local", "thread", { id: "two", status: "completed", completedAt: 2, items: [{ type: "agentMessage", id: "i2", text: "new", phase: "final_answer" }] }, 2);
  assert.deepEqual((await service.collect("payments", 2)).map((message) => message.body), ["old", "new"]);
  const receipt = await service.collect("payments", 2, { direct: true, destination: "chat" });
  assert.equal(receipt.length, 2);
  assert.deepEqual(deliveries.listReady().map((delivery) => delivery.body), ["[payments] old", "[payments] new"]);
  await assert.rejects(service.collect("payments", 21), RangeError);
});

test("goal operations replace, pause, resume and cancel without exposing completion", async () => {
  const { endpoint, service } = await fixture();
  await service.setGoal("payments", "ship it", 1_000);
  await service.pauseGoal("payments");
  await service.resumeGoal("payments");
  await service.cancelGoal("payments");
  assert.deepEqual(endpoint.calls.filter((call) => call.method.startsWith("thread/goal")).map((call) => [call.method, call.params.status]), [
    ["thread/goal/set", "active"], ["thread/goal/set", "paused"], ["thread/goal/set", "active"], ["thread/goal/clear", undefined],
  ]);
  assert.equal("completeGoal" in service, false);
});
