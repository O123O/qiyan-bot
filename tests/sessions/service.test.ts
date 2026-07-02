import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AppServerEndpoint } from "../../src/app-server/pool.ts";
import { AppServerPool } from "../../src/app-server/pool.ts";
import { SessionObservationProcessor } from "../../src/assistant/session-observer.ts";
import { AppError } from "../../src/core/errors.ts";
import { SessionRegistry } from "../../src/registry/session-registry.ts";
import { FinalMessageStore } from "../../src/sessions/final-messages.ts";
import { SessionService } from "../../src/sessions/service.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { RuntimeStore } from "../../src/storage/runtime-store.ts";
import { SessionDashboardStore } from "../../src/storage/session-dashboard-store.ts";

class ServiceEndpoint implements AppServerEndpoint {
  readonly id = "local";
  state: AppServerEndpoint["state"] = "ready";
  readonly calls: Array<{ method: string; params: any }> = [];
  status = "idle";
  activeTurnId = "active-1";
  lastClientId: string | undefined;
  historyTurnStatus: string | undefined;
  threadTurns: any[] | undefined;
  threadReadBarrier: Promise<void> | undefined;
  onThreadReadRequest: (() => void) | undefined;
  failNextStart = false;
  goal: any = null;
  goalBarrier: Promise<void> | undefined;
  onGoalRequest: (() => void) | undefined;
  loseNextGoalResponse = false;
  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    if (method === "turn/start") {
      if (this.failNextStart) { this.failNextStart = false; throw new Error("start failed"); }
      this.lastClientId = params.clientUserMessageId;
      return { turn: { id: "started-1" } } as T;
    }
    if (method === "turn/steer") return { turnId: params.expectedTurnId } as T;
    if (method === "thread/read") {
      this.onThreadReadRequest?.();
      await this.threadReadBarrier;
      return { thread: { id: "thread", cwd: params.cwd, status: { type: this.status }, turns: this.threadTurns ?? (this.lastClientId ? [{ id: "started-1", ...(this.historyTurnStatus ? { status: this.historyTurnStatus } : {}), items: [{ type: "userMessage", clientId: this.lastClientId }] }] : []) } } as T;
    }
    if (method === "thread/goal/get") {
      this.onGoalRequest?.();
      await this.goalBarrier;
      return { goal: this.goal } as T;
    }
    if (method === "model/list") return { data: [{ id: "gpt-5" }], nextCursor: null } as T;
    if (method === "thread/goal/set") {
      this.goal = { ...(this.goal ?? {}), ...(params.objective ? { objective: params.objective } : {}), status: params.status, ...(params.tokenBudget ? { tokenBudget: params.tokenBudget } : {}) };
      if (this.loseNextGoalResponse) { this.loseNextGoalResponse = false; throw new Error("response lost"); }
      return { goal: this.goal } as T;
    }
    if (method === "thread/goal/clear") { this.goal = null; return { goal: null } as T; }
    return { goal: { objective: params.objective, status: params.status } } as T;
  }
}

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "qiyan-bot-service-")));
  const registry = await SessionRegistry.open(join(dir, "sessions.json"), {
    version: 2, assistant: { endpoint: "local", thread_id: "coord", project_dir: dir },
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
  return { db, endpoint, registry, runtime, finals, deliveries, service };
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
  assert.deepEqual(started.appliedSettings, { model: "gpt-5", effort: "high" });
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
  await assert.rejects(service.setModel("payments", "gpt-5"), (error: unknown) => error instanceof AppError && error.code === "SESSION_DETACHED");
  await assert.rejects(service.setGoal("payments", "do not mutate"), (error: unknown) => error instanceof AppError && error.code === "SESSION_DETACHED");
  runtime.setSession("local", "thread", "managed", "idle");
  await assert.rejects(service.send("payments", "x", { mode: "steer" }), (error: unknown) => error instanceof AppError && error.code === "SESSION_IDLE");
});

test("status composes registry, runtime, native state, settings, and goal", async () => {
  const { runtime, service } = await fixture();
  runtime.setModel("local", "thread", "gpt-5");
  const status = await service.status("payments") as any;
  assert.equal(status.nickname, "payments");
  assert.equal(status.managementState, "managed");
  assert.equal(status.nativeStatus, "idle");
  assert.deepEqual(status.identity, { endpoint: "local", threadId: "thread", projectDir: status.identity.projectDir });
  assert.equal("pendingSettings" in status, false);
  assert.equal("configuredSettings" in status, false);
  assert.equal(status.goal, null);
});

test("status derives the active turn from authoritative history instead of cached runtime", async () => {
  const { endpoint, runtime, service } = await fixture();
  runtime.setActiveTurn("local", "thread", "stale-turn");
  endpoint.status = "active";
  endpoint.threadTurns = [
    { id: "finished", status: "completed", items: [] },
    { id: "active-turn", status: "inProgress", items: [] },
  ];

  const status = await service.status("payments") as any;
  assert.equal(status.activeTurnId, "active-turn");
  assert.equal(endpoint.calls.find((call) => call.method === "thread/read")?.params.includeTurns, true);
});

test("status binds its native snapshot before a blocked goal read so a newer notification wins", async () => {
  const { db, endpoint, registry, runtime, service } = await fixture();
  endpoint.status = "active";
  endpoint.threadTurns = [{ id: "old-turn", status: "inProgress", items: [] }];
  let releaseGoal!: () => void;
  endpoint.goalBarrier = new Promise<void>((resolve) => { releaseGoal = resolve; });
  let goalRequested!: () => void;
  const waitingForGoal = new Promise<void>((resolve) => { goalRequested = resolve; });
  endpoint.onGoalRequest = goalRequested;
  const dashboardStore = new SessionDashboardStore(db);
  const processor = new SessionObservationProcessor(dashboardStore, registry, runtime, {
    now: () => 1_000,
    readThread: async () => ({ turns: endpoint.threadTurns ?? [] }),
    readGoal: async () => ({ goal: null }),
    onChanged: () => undefined,
    onError: (error) => { throw error; },
  });
  let nativeObserved = false;

  const status = service.status("payments", {
    observeNative: ({ nativeStatus, activeTurnId }) => {
      nativeObserved = true;
      const statusSequence = dashboardStore.allocateObservationSequence();
      runtime.reconcileNativeState("local", "thread", nativeStatus, activeTurnId ?? undefined, statusSequence);
    },
  });
  await waitingForGoal;
  processor.accept("local", "turn/started", { threadId: "thread", turn: { id: "new-turn", startedAt: 2 } });
  await processor.idle();
  releaseGoal();
  await status;

  assert.equal(nativeObserved, true);
  assert.equal(runtime.activeTurn("local", "thread"), "new-turn");
});

test("status orders a notification received during thread read before the response snapshot", async () => {
  const { db, endpoint, registry, runtime, service } = await fixture();
  endpoint.status = "active";
  endpoint.threadTurns = [{ id: "response-turn", status: "inProgress", items: [] }];
  let releaseRead!: () => void;
  endpoint.threadReadBarrier = new Promise<void>((resolve) => { releaseRead = resolve; });
  let readRequested!: () => void;
  const waitingForRead = new Promise<void>((resolve) => { readRequested = resolve; });
  endpoint.onThreadReadRequest = readRequested;
  const dashboardStore = new SessionDashboardStore(db);
  const processor = new SessionObservationProcessor(dashboardStore, registry, runtime, {
    now: () => 1_000,
    readThread: async () => ({ turns: endpoint.threadTurns ?? [] }),
    readGoal: async () => ({ goal: null }),
    onChanged: () => undefined,
    onError: (error) => { throw error; },
  });

  const status = service.status("payments", {
    observeNative: ({ nativeStatus, activeTurnId }) => {
      const statusSequence = dashboardStore.allocateObservationSequence();
      runtime.reconcileNativeState("local", "thread", nativeStatus, activeTurnId ?? undefined, statusSequence);
    },
  });
  await waitingForRead;
  processor.accept("local", "thread/status/changed", { threadId: "thread", status: { type: "idle" } });
  await processor.idle();
  assert.equal(runtime.getSession("local", "thread")?.nativeStatus, "idle");
  releaseRead();
  await status;

  assert.equal(runtime.getSession("local", "thread")?.nativeStatus, "active");
  assert.equal(runtime.activeTurn("local", "thread"), "response-turn");
});

test("a failed start retains pending settings and steer never consumes them", async () => {
  const { endpoint, runtime, service } = await fixture();
  runtime.setModel("local", "thread", "gpt-5");
  endpoint.failNextStart = true;
  await assert.rejects(service.send("payments", "first", { mode: "start" }), /start failed/);
  assert.deepEqual(runtime.settings("local", "thread"), { model: "gpt-5" });
  runtime.setActiveTurn("local", "thread", "active-1");
  const steered = await service.send("payments", "more", { mode: "steer", settings: { model: "ignored" } });
  assert.equal("appliedSettings" in steered, false);
  assert.deepEqual(runtime.settings("local", "thread"), { model: "gpt-5" });
});

test("uses the exact supplied settings snapshot and leaves a concurrent replacement pending", async () => {
  const { endpoint, runtime, service } = await fixture();
  runtime.setModel("local", "thread", "old-model");
  const dispatched = runtime.settings("local", "thread");
  runtime.setModel("local", "thread", "next-model");
  const result = await service.send("payments", "work", { mode: "start", settings: dispatched });
  assert.equal(endpoint.calls.find((call) => call.method === "turn/start")?.params.model, "old-model");
  assert.deepEqual(result.appliedSettings, { model: "old-model" });
  assert.deepEqual(runtime.settings("local", "thread"), { model: "next-model" });
});

test("a turn already terminal when turn/start resolves is not recorded as active", async () => {
  const { endpoint, runtime, service } = await fixture();
  endpoint.historyTurnStatus = "completed";
  await service.send("payments", "fast", { clientUserMessageId: "fast-message" });
  assert.equal(runtime.activeTurn("local", "thread"), undefined);
});

test("collect returns assistant bodies or creates chronological direct deliveries", async () => {
  const { finals, deliveries, service } = await fixture();
  finals.persistTerminalTurn("local", "thread", { id: "one", status: "completed", completedAt: 1, items: [{ type: "agentMessage", id: "i1", text: "old", phase: "final_answer" }] }, 1);
  finals.persistTerminalTurn("local", "thread", { id: "two", status: "completed", completedAt: 2, items: [{ type: "agentMessage", id: "i2", text: "new", phase: "final_answer" }] }, 2);
  assert.deepEqual((await service.collect("payments", 2)).map((message) => message.body), ["old", "new"]);
  const receipt = await service.collect("payments", 2, { direct: true, destination: "chat", deliveryKey: "request-1" });
  assert.equal(receipt.length, 2);
  assert.deepEqual(deliveries.listReady().map((delivery) => delivery.body), ["[payments] old", "[payments] new"]);
  const secondRequest = await service.collect("payments", 2, { direct: true, destination: "chat", deliveryKey: "request-2" });
  assert.notDeepEqual(secondRequest, receipt);
  assert.equal(deliveries.listReady().length, 4);
  await assert.rejects(service.collect("payments", 21), RangeError);
});

test("direct collection recovery fills a frozen partial selection and accepts an empty window", async () => {
  const { finals, deliveries, service } = await fixture();
  const one = finals.persistTerminalTurn("local", "thread", { id: "one", status: "completed", completedAt: 1, items: [{ type: "agentMessage", id: "i1", text: "one", phase: "final_answer" }] }, 1)[0]!;
  const two = finals.persistTerminalTurn("local", "thread", { id: "two", status: "completed", completedAt: 2, items: [{ type: "agentMessage", id: "i2", text: "two", phase: "final_answer" }] }, 2)[0]!;
  const three = finals.persistTerminalTurn("local", "thread", { id: "three", status: "completed", completedAt: 3, items: [{ type: "agentMessage", id: "i3", text: "three", phase: "final_answer" }] }, 3)[0]!;
  const selected = [one.id, two.id, three.id];
  await service.collectSelected("payments", selected.slice(0, 1), { destination: "chat", deliveryKey: "frozen" });
  const recovered = await service.collectSelected("payments", selected, { destination: "chat", deliveryKey: "frozen" });
  assert.equal(recovered.length, 3);
  assert.equal(deliveries.listReady().filter((delivery) => delivery.kind === "collection").length, 3);
  assert.deepEqual(await service.collectSelected("payments", [], { destination: "chat", deliveryKey: "empty" }), []);
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

test("a lost goal response is reconciled against native goal state", async () => {
  const { endpoint, service } = await fixture();
  endpoint.loseNextGoalResponse = true;
  const result = await service.setGoal("payments", "ship it", 1_000) as any;
  assert.equal(result.goal.objective, "ship it");
  assert.equal(endpoint.calls.filter((call) => call.method === "thread/goal/set").length, 1);
});
