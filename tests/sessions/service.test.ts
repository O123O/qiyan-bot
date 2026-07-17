import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AppServerEndpoint } from "../../src/app-server/pool.ts";
import { AppServerPool } from "../../src/app-server/pool.ts";
import { JsonRpcResponseError } from "../../src/app-server/rpc-client.ts";
import { SessionObservationProcessor } from "../../src/assistant/session-observer.ts";
import { AppError } from "../../src/core/errors.ts";
import { SessionRegistry } from "../../src/registry/session-registry.ts";
import { FinalMessageStore } from "../../src/sessions/final-messages.ts";
import { SessionService } from "../../src/sessions/service.ts";
import { SessionLifecycle } from "../../src/sessions/lifecycle.ts";
import { NativeSessionState } from "../../src/sessions/native-session-state.ts";
import type { OwnershipInspection } from "../../src/sessions/rollout-ownership.ts";
import { ThreadGate } from "../../src/sessions/thread-gate.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { SessionControlStore } from "../../src/storage/session-control-store.ts";
import { ManagedEpochStore } from "../../src/storage/managed-epoch-store.ts";
import { SessionDashboardStore } from "../../src/storage/session-dashboard-store.ts";

const mappingId = "mapping-1";

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
  cwd = "";
  goalBarrier: Promise<void> | undefined;
  onGoalRequest: (() => void) | undefined;
  onGoalSetRequest: (() => void) | undefined;
  loseNextGoalResponse = false;
  rejectNextGoalSetBeforeEffect = false;
  rejectNextGoalGet = false;
  legacyItemsUnsupported = false;
  onTurnStart: (() => void) | undefined;
  private historyTurns(): any[] {
    return this.threadTurns ?? (this.lastClientId ? [{
      id: "started-1",
      ...(this.historyTurnStatus ? { status: this.historyTurnStatus } : {}),
      items: [{ type: "userMessage", clientId: this.lastClientId }],
    }] : []);
  }
  private historyItems(turn: any): any[] {
    return (turn.items ?? []).map((item: any, index: number) => ({
      id: item.id ?? `${turn.id}-item-${index}`,
      ...item,
    }));
  }
  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    if (method === "turn/start") {
      if (this.failNextStart) { this.failNextStart = false; throw new Error("start failed"); }
      this.onTurnStart?.();
      this.lastClientId = params.clientUserMessageId;
      return { turn: { id: "started-1", ...(this.historyTurnStatus ? { status: this.historyTurnStatus } : {}) } } as T;
    }
    if (method === "turn/steer") return { turnId: params.expectedTurnId } as T;
    if (method === "thread/read") {
      this.onThreadReadRequest?.();
      await this.threadReadBarrier;
      return { thread: { id: "thread", cwd: this.cwd, status: { type: this.status }, turns: params.includeTurns ? this.historyTurns() : [] } } as T;
    }
    if (method === "thread/turns/list") {
      const source = params.sortDirection === "desc" ? [...this.historyTurns()].reverse() : this.historyTurns();
      return {
        data: source.map((turn) => ({
          ...turn,
          status: turn.status ?? "completed",
          itemsView: params.itemsView,
          items: params.itemsView === "notLoaded" ? [] : this.historyItems(turn),
        })),
        nextCursor: null,
        backwardsCursor: null,
      } as T;
    }
    if (method === "thread/items/list") {
      if (this.legacyItemsUnsupported) {
        throw new JsonRpcResponseError(-32601, "thread/items/list is not supported yet");
      }
      const turns = params.turnId === undefined
        ? this.historyTurns()
        : this.historyTurns().filter((candidate) => candidate.id === params.turnId);
      return {
        data: turns.flatMap((turn) => this.historyItems(turn)),
        nextCursor: null,
        backwardsCursor: null,
      } as T;
    }
    if (method === "thread/compact/start") {
      const turns = this.threadTurns ?? (this.threadTurns = []);
      turns.push({
        id: `compact-turn-${turns.length + 1}`,
        status: "completed",
        itemsView: "full",
        items: [{ type: "contextCompaction", id: "compact-1" }],
      });
      return {} as T;
    }
    if (method === "thread/goal/get") {
      this.onGoalRequest?.();
      await this.goalBarrier;
      if (this.rejectNextGoalGet) { this.rejectNextGoalGet = false; throw new Error("goal read failed"); }
      return { goal: this.goal } as T;
    }
    if (method === "model/list") return { data: [{ id: "gpt-5" }], nextCursor: null } as T;
    if (method === "thread/goal/set") {
      this.onGoalSetRequest?.();
      if (this.rejectNextGoalSetBeforeEffect) { this.rejectNextGoalSetBeforeEffect = false; throw new Error("goal set failed"); }
      this.goal = { ...(this.goal ?? {}), ...(params.objective ? { objective: params.objective } : {}), status: params.status, ...(params.tokenBudget ? { tokenBudget: params.tokenBudget } : {}) };
      if (this.loseNextGoalResponse) { this.loseNextGoalResponse = false; throw new Error("response lost"); }
      return { goal: this.goal } as T;
    }
    if (method === "thread/goal/clear") { this.goal = null; return { goal: null } as T; }
    return { goal: { objective: params.objective, status: params.status } } as T;
  }
}

async function fixture(ownership?: {
  inspect(identity: { endpoint: string; thread_id: string; mapping_id: string }): Promise<OwnershipInspection>;
  authorizeTurn?(identity: { endpoint: string; thread_id: string; mapping_id: string }, turnId: string): void;
}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "qiyan-bot-service-")));
  const registry = await SessionRegistry.open(join(dir, "sessions.json"), {
    version: 3, assistant: { endpoint: "local", thread_id: "coord", project_dir: dir },
    sessions: { payments: { endpoint: "local", thread_id: "thread", project_dir: dir, mapping_id: mappingId, lifecycle_state: "managed" } },
  });
  const db = createTestDatabase();
  const endpoint = new ServiceEndpoint();
  endpoint.cwd = dir;
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 4, reconciliationTimeoutMs: 20, reconciliationPollMs: 1 });
  const native = new NativeSessionState();
  const nativeGeneration = pool.endpointGeneration("local").generation;
  native.register({ endpointId: "local", threadId: "thread", mappingId }, nativeGeneration);
  native.applyRefresh(native.captureRefresh({ endpointId: "local", threadId: "thread", mappingId }, nativeGeneration), { status: "idle" });
  const controls = new SessionControlStore(db);
  const finals = new FinalMessageStore(db);
  const deliveries = new DeliveryStore(db);
  let workspaceFailure: Error | undefined;
  let workspaceBarrier: Promise<void> | undefined;
  let onWorkspaceCheck: (() => void) | undefined;
  const workspaces = {
    prepareExisting: async (path: string) => ({ path, created: false, fallback: false, identity: { device: "1", inode: "1" } }),
    assertDispatchable: async () => { onWorkspaceCheck?.(); await workspaceBarrier; if (workspaceFailure) throw workspaceFailure; },
  };
  const gate = new ThreadGate();
  const service = new SessionService(pool, registry, native, controls, finals, deliveries, workspaces, gate, undefined, ownership);
  const observeNative = (status: "idle" | "active", turnId?: string) => {
    if (status === "active" && turnId) {
      native.observe("local", nativeGeneration, "turn/started", { threadId: "thread", turn: { id: turnId, status: "inProgress" } });
    } else {
      native.observe("local", nativeGeneration, "thread/status/changed", { threadId: "thread", status: { type: status } });
    }
  };
  return {
    db, dir, endpoint, pool, registry, native, nativeGeneration, controls, finals, deliveries, service, gate, workspaces,
    observeNative,
    failWorkspace: () => { workspaceFailure = new AppError("CONFIGURATION_ERROR", "project workspace changed unexpectedly"); },
    setWorkspaceBarrier: (barrier: Promise<void> | undefined, onCheck?: () => void) => { workspaceBarrier = barrier; onWorkspaceCheck = onCheck; },
  };
}

test("starts idle sessions, steers active sessions, and interrupts the exact turn", async () => {
  const { endpoint, controls, service } = await fixture();
  await service.setModel("payments", "gpt-5");
  await service.setEffort("payments", "high");
  const started = await service.send("payments", "hello", { clientUserMessageId: "msg-1" });
  assert.equal(started.turnId, "started-1");
  assert.deepEqual(endpoint.calls.find((call) => call.method === "turn/start")?.params, {
    threadId: "thread", cwd: endpoint.cwd, clientUserMessageId: "msg-1", input: [{ type: "text", text: "hello", text_elements: [] }], model: "gpt-5", effort: "high",
  });
  assert.deepEqual(started.appliedSettings, { model: "gpt-5", effort: "high" });
  assert.deepEqual(controls.settings("local", "thread", mappingId), {});

  assert.equal((await service.send("payments", "more")).mode, "steer");
  await service.interrupt("payments", "started-1");
  assert.ok(endpoint.calls.some((call) => call.method === "turn/interrupt" && call.params.turnId === "started-1"));
});

test("an id-less active event refreshes once and fails closed instead of starting a second turn", async () => {
  const value = await fixture();
  value.endpoint.status = "active";
  value.endpoint.threadTurns = [];
  value.native.observe("local", value.nativeGeneration, "thread/status/changed", {
    threadId: "thread",
    status: { type: "active" },
  });

  await assert.rejects(value.service.send("payments", "must not overlap", { mode: "start" }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "SESSION_BUSY");
    return true;
  });
  assert.equal(value.endpoint.calls.filter((call) => call.method === "thread/read").length, 2, "workspace check plus one status refresh");
  assert.equal(value.endpoint.calls.some((call) => call.method === "turn/start"), false);
});

test("native error state cannot admit a new turn", async () => {
  const value = await fixture();
  const identity = { endpointId: "local", threadId: "thread", mappingId };
  value.native.applyRefresh(value.native.captureRefresh(identity, value.nativeGeneration), { status: "error" });

  await assert.rejects(value.service.send("payments", "must not start"), (error: unknown) => (
    error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE"
  ));
  assert.equal(value.endpoint.calls.some((call) => call.method === "turn/start"), false);
});

test("prepares worker input inside the verified execution fence before native dispatch", async () => {
  const { endpoint, service } = await fixture();
  let prepared = false;
  await service.send("payments", "attached", {
    prepareInput: async ({ session, projectRoot }) => {
      prepared = true;
      assert.equal(session.mapping_id, mappingId);
      assert.equal(projectRoot, endpoint.cwd);
      assert.equal(endpoint.calls.at(-1)?.method, "thread/read");
      return [{ type: "mention", name: "notes.txt", path: "/remote/notes.txt" }];
    },
  });
  assert.equal(prepared, true);
  assert.deepEqual(endpoint.calls.find((call) => call.method === "turn/start")?.params.input, [
    { type: "mention", name: "notes.txt", path: "/remote/notes.txt" },
  ]);
});

test("execution performs a fresh native cwd and project check before every mutation", async () => {
  const { endpoint, service, failWorkspace } = await fixture();
  await service.send("payments", "start");
  assert.deepEqual(endpoint.calls.slice(0, 3).map((call) => call.method), ["thread/read", "thread/turns/list", "turn/start"]);
  assert.equal(endpoint.calls[2]?.params.cwd, endpoint.cwd);

  endpoint.calls.length = 0;
  failWorkspace();
  await assert.rejects(service.send("payments", "blocked"), /changed unexpectedly/);
  assert.equal(endpoint.calls.some((call) => call.method === "turn/start" || call.method === "turn/steer"), false);
});

test("execution checks rollout ownership before reading or mutating the native thread", async () => {
  const checked: string[] = [];
  const value = await fixture({
    inspect: async (identity) => {
      checked.push(identity.mapping_id);
      throw new AppError("SESSION_DETACHED", "external turn detected");
    },
  });

  await assert.rejects(value.service.send("payments", "must not run"), (error: unknown) => error instanceof AppError && error.code === "SESSION_DETACHED");
  assert.deepEqual(checked, [mappingId]);
  assert.deepEqual(value.endpoint.calls, []);
});

test("execution waits for a pathless rollout before native dispatch", async () => {
  const value = await fixture({ inspect: async () => ({ state: "pending" }) });

  await assert.rejects(value.service.send("payments", "must not run"), (error: unknown) => (
    error instanceof AppError && error.code === "SESSION_BUSY"
  ));

  assert.deepEqual(value.endpoint.calls, []);
});

test("execution rechecks rollout ownership after input preparation and immediately before dispatch", async () => {
  let external = false;
  let checks = 0;
  const value = await fixture({
    inspect: async () => {
      checks += 1;
      return external ? { state: "external", turnId: "outside" } : { state: "owned" };
    },
  });

  await assert.rejects(value.service.send("payments", "must not run", {
    prepareInput: async () => {
      external = true;
      return [{ type: "text", text: "prepared", text_elements: [] }];
    },
  }), (error: unknown) => error instanceof AppError && error.code === "SESSION_DETACHED");

  assert.equal(checks, 2);
  assert.equal(value.endpoint.calls.some((call) => call.method === "turn/start" || call.method === "turn/steer"), false);
});

test("a poisoned persisted active turn cannot authorize interrupt", async () => {
  const value = await fixture({ inspect: async () => ({ state: "external", turnId: "outside" }) });
  assert.equal(value.db.prepare("SELECT name FROM sqlite_master WHERE name = 'session_runtime'").get(), undefined);

  await assert.rejects(value.service.interrupt("payments", "outside"), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "SESSION_IDLE");
    return true;
  });

  assert.equal(value.endpoint.calls.some((call) => call.method === "turn/interrupt"), false);
});

test("interrupt recovery resumes the exact native active turn when runtime cache is empty", async () => {
  const value = await fixture({ inspect: async () => ({ state: "owned" }) });
  value.endpoint.status = "active";
  value.endpoint.threadTurns = [{ id: "recovered-active", status: "inProgress", items: [] }];

  await value.service.interrupt("payments", "recovered-active", { recoverExactTurn: true });

  assert.ok(value.endpoint.calls.some((call) => call.method === "turn/interrupt"
    && call.params.turnId === "recovered-active"));
});

test("an unavailable live view is refreshed and interrupted without persisted restore state", async () => {
  const value = await fixture({ inspect: async () => ({ state: "owned" }) });
  value.native.invalidateEndpoint("local", value.nativeGeneration);
  value.endpoint.status = "active";
  value.endpoint.threadTurns = [{ id: "remote-active", status: "inProgress", itemsView: "full", items: [] }];

  assert.equal(await value.service.interrupt("payments"), "remote-active");

  assert.ok(value.endpoint.calls.some((call) => call.method === "turn/interrupt" && call.params.turnId === "remote-active"));
  assert.equal(value.native.view({ endpointId: "local", threadId: "thread", mappingId })?.activeTurnId, null);
});

test("registry-managed interrupt has no persisted management mirror to poison", async () => {
  const value = await fixture({ inspect: async () => ({ state: "owned" }) });
  assert.equal(value.db.prepare("SELECT name FROM sqlite_master WHERE name = 'session_runtime'").get(), undefined);
  value.endpoint.status = "active";
  value.endpoint.threadTurns = [{ id: "remote-active", status: "inProgress", itemsView: "full", items: [] }];
  value.native.invalidateEndpoint("local", value.nativeGeneration);

  assert.equal(await value.service.interrupt("payments"), "remote-active");
  assert.equal(value.endpoint.calls.some((call) => call.method === "turn/interrupt"), true);
});

test("compaction requires an idle managed worker and observes a new native compaction item", async () => {
  const value = await fixture({ inspect: async () => ({ state: "owned" }) });
  value.endpoint.threadTurns = [{ id: "finished", status: "completed", itemsView: "full", items: [] }];
  let checkpoint: unknown;

  const result = await value.service.compact("payments", {
    onBeforeNativeDispatch: (evidence) => { checkpoint = evidence; },
  });

  assert.deepEqual(checkpoint, {
    endpointId: "local", threadId: "thread", mappingId, baselineCompactionItemIds: [], baselineTurnId: "finished",
  });
  assert.deepEqual(result, { compactionItemId: "compact-1", baselineCompactionItemIds: [] });
  assert.ok(value.endpoint.calls.some((call) => call.method === "thread/compact/start" && call.params.threadId === "thread"));
  const itemReads = value.endpoint.calls.filter((call) => call.method === "thread/items/list");
  assert.equal(itemReads.length, 2);
  assert.deepEqual(itemReads.map((call) => call.params.turnId), ["finished", "compact-turn-2"]);

  value.endpoint.status = "active";
  value.endpoint.threadTurns.push({ id: "active", status: "inProgress", itemsView: "full", items: [] });
  await assert.rejects(value.service.compact("payments"), (error: unknown) => (
    error instanceof AppError && error.code === "SESSION_BUSY"
  ));
});

test("all turn-starting mutations fail closed when the authoritative native state is error", async () => {
  const value = await fixture();
  value.endpoint.status = "error";

  for (const mutate of [
    () => value.service.compact("payments"),
    () => value.service.setGoal("payments", "ship it"),
    () => value.service.resumeGoal("payments"),
  ]) {
    await assert.rejects(mutate(), (error: unknown) => (
      error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE"
    ));
  }
  assert.equal(value.endpoint.calls.some((call) => call.method === "thread/compact/start"), false);
  assert.equal(value.endpoint.calls.some((call) => call.method === "thread/goal/set"), false);
});

test("legacy compaction recovery stays unresolved without dispatching another compaction", async () => {
  const value = await fixture({ inspect: async () => ({ state: "owned" }) });
  value.endpoint.threadTurns = [{ id: "finished", status: "completed", itemsView: "full", items: [] }];
  value.endpoint.legacyItemsUnsupported = true;

  await assert.rejects(value.service.compact("payments"), (error: unknown) => (
    error instanceof AppError && error.code === "OPERATION_UNCERTAIN"
  ));
  assert.equal(value.endpoint.calls.some((call) => call.method === "thread/compact/start"), false);
});

test("active goal transition snapshots exact native turn ownership before marker revocation", async () => {
  const authorized: string[] = [];
  const value = await fixture({
    inspect: async () => ({ state: "owned" }),
    authorizeTurn: (_identity, turnId) => { authorized.push(turnId); },
  });
  value.endpoint.status = "active";
  value.endpoint.threadTurns = [{ id: "goal-active", status: "inProgress", items: [] }];

  assert.equal(await value.service.authorizeActiveTurn("payments"), "goal-active");
  assert.deepEqual(authorized, ["goal-active"]);
});

test("an unclassified live active turn cannot be steered or interrupted", async () => {
  const value = await fixture({ inspect: async () => ({ state: "unclassified", turnId: "boundary-turn" }) });
  value.observeNative("active", "boundary-turn");

  await assert.rejects(value.service.send("payments", "do not steer"), (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY");
  await assert.rejects(value.service.interrupt("payments", "boundary-turn"), (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY");

  assert.equal(value.endpoint.calls.some((call) => call.method === "turn/steer" || call.method === "turn/interrupt"), false);
});

test("native cwd drift and mapping generation replacement block execution inside the gate", async () => {
  const drift = await fixture();
  drift.endpoint.cwd = join(drift.dir, "other-project");
  await assert.rejects(drift.service.send("payments", "blocked"), (error: unknown) => error instanceof AppError && error.code === "CWD_MISMATCH");
  assert.equal(drift.endpoint.calls.some((call) => call.method === "turn/start"), false);

  const replaced = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const checking = new Promise<void>((resolve) => { entered = resolve; });
  replaced.setWorkspaceBarrier(barrier, entered);
  const sending = replaced.service.send("payments", "blocked");
  await checking;
  const old = replaced.registry.get("payments")!;
  await replaced.registry.transition("payments", old, "unadopting");
  await replaced.registry.removeIfMatch("payments", old);
  const replacement = { ...old, mapping_id: "mapping-new", lifecycle_state: "adopting" as const };
  await replaced.registry.reserve("payments", replacement);
  await replaced.registry.promote("payments", replacement);
  release();
  await assert.rejects(sending, /mapping changed|not managed/iu);
  assert.equal(replaced.endpoint.calls.some((call) => call.method === "turn/start" || call.method === "turn/steer"), false);
});

test("unadopt waits for an in-flight execution check and cannot transition after the turn starts", async () => {
  const value = await fixture();
  const lifecycle = new SessionLifecycle(value.pool, value.registry, new ManagedEpochStore(value.db), value.native, { now: () => 10 }, value.workspaces, value.gate);
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const checking = new Promise<void>((resolve) => { entered = resolve; });
  value.setWorkspaceBarrier(barrier, entered);
  value.endpoint.onTurnStart = () => { value.endpoint.status = "active"; };

  const sending = value.service.send("payments", "start");
  await checking;
  const removing = lifecycle.unadopt("payments");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.registry.get("payments")?.lifecycle_state, "managed");
  release();
  await sending;
  await assert.rejects(removing, (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY");
  assert.equal(value.registry.get("payments")?.lifecycle_state, "managed");
});

test("send enforces managed state and start/steer preconditions", async () => {
  const { registry, service } = await fixture();
  await registry.transition("payments", registry.get("payments")!, "unadopting");
  await assert.rejects(service.send("payments", "x"), (error: unknown) => error instanceof AppError && error.code === "SESSION_DETACHED");
  await assert.rejects(service.setModel("payments", "gpt-5"), (error: unknown) => error instanceof AppError && error.code === "SESSION_DETACHED");
  await assert.rejects(service.setGoal("payments", "do not mutate"), (error: unknown) => error instanceof AppError && error.code === "SESSION_DETACHED");
  const idle = await fixture();
  await assert.rejects(idle.service.send("payments", "x", { mode: "steer" }), (error: unknown) => error instanceof AppError && error.code === "SESSION_IDLE");
});

test("execution is rejected for every transitional mapping lifecycle", async () => {
  for (const state of ["adopting", "unadopting", "archiving"] as const) {
    const { registry, endpoint, service } = await fixture();
    const current = registry.get("payments")!;
    if (state === "adopting") {
      await registry.transition("payments", current, "unadopting");
      await registry.removeIfMatch("payments", current);
      await registry.reserve("payments", { ...current, mapping_id: "mapping-adopting", lifecycle_state: "adopting" });
    } else {
      await registry.transition("payments", current, state);
    }
    endpoint.calls.length = 0;
    await assert.rejects(service.send("payments", "must not run"), (error: unknown) => error instanceof AppError && error.code === "SESSION_DETACHED");
    assert.equal(endpoint.calls.some((call) => call.method === "turn/start" || call.method === "turn/steer"), false);
  }
});

test("status composes registry, live native state, and goal", async () => {
  const { controls, service } = await fixture();
  controls.setModel("local", "thread", mappingId, "gpt-5");
  const status = await service.status("payments") as any;
  assert.equal(status.nickname, "payments");
  assert.equal(status.managementState, "managed");
  assert.equal(status.nativeStatus, "idle");
  assert.deepEqual(status.identity, { endpoint: "local", threadId: "thread", projectDir: status.identity.projectDir });
  assert.equal("pendingSettings" in status, false);
  assert.equal("configuredSettings" in status, false);
  assert.equal(status.goal, null);
});

test("status derives the active turn from authoritative history without a runtime cache", async () => {
  const { endpoint, service } = await fixture();
  endpoint.status = "active";
  endpoint.threadTurns = [
    { id: "finished", status: "completed", items: [] },
    { id: "active-turn", status: "inProgress", items: [] },
  ];

  const status = await service.status("payments") as any;
  assert.equal(status.activeTurnId, "active-turn");
  assert.equal(endpoint.calls.find((call) => call.method === "thread/read")?.params.includeTurns, false);
  assert.ok(endpoint.calls.some((call) => call.method === "thread/turns/list"));
});

test("status binds its native snapshot before a blocked goal read so a newer notification wins", async () => {
  const { endpoint, native, nativeGeneration, service } = await fixture();
  endpoint.status = "active";
  endpoint.threadTurns = [{ id: "old-turn", status: "inProgress", items: [] }];
  let releaseGoal!: () => void;
  endpoint.goalBarrier = new Promise<void>((resolve) => { releaseGoal = resolve; });
  let goalRequested!: () => void;
  const waitingForGoal = new Promise<void>((resolve) => { goalRequested = resolve; });
  endpoint.onGoalRequest = goalRequested;
  let nativeObserved = false;

  const status = service.status("payments", {
    observeNative: ({ nativeStatus, activeTurnId }) => {
      nativeObserved = true;
    },
  });
  await waitingForGoal;
  native.observe("local", nativeGeneration, "turn/started", { threadId: "thread", turn: { id: "new-turn", startedAt: 2 } });
  releaseGoal();
  await status;

  assert.equal(nativeObserved, true);
  assert.equal(native.view({ endpointId: "local", threadId: "thread", mappingId })?.activeTurnId, "new-turn");
});

test("status orders a notification received during thread read before the response snapshot", async () => {
  const { endpoint, native, nativeGeneration, service } = await fixture();
  endpoint.status = "active";
  endpoint.threadTurns = [{ id: "response-turn", status: "inProgress", items: [] }];
  let releaseRead!: () => void;
  endpoint.threadReadBarrier = new Promise<void>((resolve) => { releaseRead = resolve; });
  let readRequested!: () => void;
  const waitingForRead = new Promise<void>((resolve) => { readRequested = resolve; });
  endpoint.onThreadReadRequest = readRequested;
  const status = service.status("payments");
  await waitingForRead;
  native.observe("local", nativeGeneration, "thread/status/changed", { threadId: "thread", status: { type: "idle" } });
  assert.equal(native.view({ endpointId: "local", threadId: "thread", mappingId })?.status, "idle");
  releaseRead();
  const result = await status as any;

  assert.equal(result.nativeStatus, "idle");
  assert.equal(native.view({ endpointId: "local", threadId: "thread", mappingId })?.status, "idle");
  assert.equal(native.view({ endpointId: "local", threadId: "thread", mappingId })?.activeTurnId, null);
});

test("a failed start retains pending settings and steer never consumes them", async () => {
  const { endpoint, controls, observeNative, service } = await fixture();
  controls.setModel("local", "thread", mappingId, "gpt-5");
  endpoint.failNextStart = true;
  await assert.rejects(service.send("payments", "first", { mode: "start" }), /start failed/);
  assert.deepEqual(controls.settings("local", "thread", mappingId), { model: "gpt-5" });
  observeNative("active", "active-1");
  const steered = await service.send("payments", "more", { mode: "steer", settings: { model: "ignored" } });
  assert.equal("appliedSettings" in steered, false);
  assert.deepEqual(controls.settings("local", "thread", mappingId), { model: "gpt-5" });
});

test("uses the exact supplied settings snapshot and leaves a concurrent replacement pending", async () => {
  const { endpoint, controls, service } = await fixture();
  controls.setModel("local", "thread", mappingId, "old-model");
  const dispatched = controls.settings("local", "thread", mappingId);
  controls.setModel("local", "thread", mappingId, "next-model");
  const result = await service.send("payments", "work", { mode: "start", settings: dispatched });
  assert.equal(endpoint.calls.find((call) => call.method === "turn/start")?.params.model, "old-model");
  assert.deepEqual(result.appliedSettings, { model: "old-model" });
  assert.deepEqual(controls.settings("local", "thread", mappingId), { model: "next-model" });
});

test("a turn already terminal when turn/start resolves is not recorded as active", async () => {
  const { endpoint, native, service } = await fixture();
  endpoint.historyTurnStatus = "completed";
  await service.send("payments", "fast", { clientUserMessageId: "fast-message" });
  assert.equal(native.view({ endpointId: "local", threadId: "thread", mappingId })?.activeTurnId, null);
});

test("collect returns assistant bodies or creates chronological direct deliveries", async () => {
  const { finals, deliveries, service } = await fixture();
  finals.persistTerminalTurn("local", "thread", { id: "one", status: "completed", completedAt: 1, items: [{ type: "agentMessage", id: "i1", text: "old", phase: "final_answer" }] }, 1);
  finals.persistTerminalTurn("local", "thread", { id: "two", status: "completed", completedAt: 2, items: [{ type: "agentMessage", id: "i2", text: "new", phase: "final_answer" }] }, 2);
  assert.deepEqual((await service.collect("payments", 2)).map((message) => message.body), ["old", "new"]);
  const binding = { adapterId: "telegram", conversationKey: "telegram:chat", destination: { chatId: "chat" } } as const;
  const receipt = await service.collect("payments", 2, { direct: true, binding, deliveryKey: "request-1" });
  assert.equal(receipt.length, 2);
  assert.deepEqual(deliveries.listReady().map((delivery) => delivery.body), ["[payments] old", "[payments] new"]);
  const secondRequest = await service.collect("payments", 2, { direct: true, binding, deliveryKey: "request-2" });
  assert.notDeepEqual(secondRequest, receipt);
  assert.equal(deliveries.listReady().length, 4);
  await assert.rejects(service.collect("payments", 51), RangeError);
});

test("direct collection recovery fills a frozen partial selection and accepts an empty window", async () => {
  const { finals, deliveries, service } = await fixture();
  const one = finals.persistTerminalTurn("local", "thread", { id: "one", status: "completed", completedAt: 1, items: [{ type: "agentMessage", id: "i1", text: "one", phase: "final_answer" }] }, 1)[0]!;
  const two = finals.persistTerminalTurn("local", "thread", { id: "two", status: "completed", completedAt: 2, items: [{ type: "agentMessage", id: "i2", text: "two", phase: "final_answer" }] }, 2)[0]!;
  const three = finals.persistTerminalTurn("local", "thread", { id: "three", status: "completed", completedAt: 3, items: [{ type: "agentMessage", id: "i3", text: "three", phase: "final_answer" }] }, 3)[0]!;
  const selected = [one.id, two.id, three.id];
  const binding = { adapterId: "telegram", conversationKey: "telegram:chat", destination: { chatId: "chat" } } as const;
  await service.collectSelected("payments", selected.slice(0, 1), { binding, deliveryKey: "frozen" });
  const recovered = await service.collectSelected("payments", selected, { binding, deliveryKey: "frozen" });
  assert.equal(recovered.length, 3);
  assert.equal(deliveries.listReady().filter((delivery) => delivery.kind === "collection").length, 3);
  assert.deepEqual(await service.collectSelected("payments", [], { binding, deliveryKey: "empty" }), []);
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

test("goal activation arms ownership after preflight and before native dispatch", async () => {
  let controlled = false;
  const value = await fixture({
    inspect: async () => {
      assert.equal(controlled, false, "goal control must not weaken the external-turn preflight");
      return { state: "owned" };
    },
  });
  value.endpoint.onGoalSetRequest = () => {
    assert.equal(controlled, true, "goal control must be armed before the App Server can emit turn/started");
  };

  await value.service.setGoal("payments", "ship it", undefined, () => { controlled = true; });

  assert.equal(controlled, true);
});

test("goal activation and resume are verified while pause and cancel remain available to stop unsafe work", async () => {
  const { endpoint, service, failWorkspace } = await fixture();
  failWorkspace();
  await assert.rejects(service.setGoal("payments", "blocked"), /changed unexpectedly/);
  await assert.rejects(service.resumeGoal("payments"), /changed unexpectedly/);
  endpoint.calls.length = 0;
  await service.pauseGoal("payments");
  await service.cancelGoal("payments");
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/goal/set", "thread/goal/clear"]);
});

test("a lost goal response is reconciled against native goal state", async () => {
  const { endpoint, service } = await fixture();
  endpoint.loseNextGoalResponse = true;
  const result = await service.setGoal("payments", "ship it", 1_000) as any;
  assert.equal(result.goal.objective, "ship it");
  assert.equal(endpoint.calls.filter((call) => call.method === "thread/goal/set").length, 1);
});

test("a proven goal activation mismatch disarms ownership while an unreadable result remains armed", async () => {
  const mismatch = await fixture();
  let controlled = false;
  mismatch.endpoint.rejectNextGoalSetBeforeEffect = true;
  await assert.rejects(mismatch.service.setGoal(
    "payments",
    "ship it",
    undefined,
    () => { controlled = true; },
    () => { controlled = false; },
  ), /goal set failed/u);
  assert.equal(controlled, false);

  const unreadable = await fixture();
  controlled = false;
  unreadable.endpoint.rejectNextGoalSetBeforeEffect = true;
  unreadable.endpoint.rejectNextGoalGet = true;
  await assert.rejects(unreadable.service.setGoal(
    "payments",
    "ship it",
    undefined,
    () => { controlled = true; },
    () => { controlled = false; },
  ), /goal set failed/u);
  assert.equal(controlled, true);
});

test("a proven goal resume mismatch disarms ownership", async () => {
  const value = await fixture();
  value.endpoint.goal = { objective: "ship it", status: "paused" };
  value.endpoint.rejectNextGoalSetBeforeEffect = true;
  let controlled = false;

  await assert.rejects(value.service.resumeGoal(
    "payments",
    () => { controlled = true; },
    () => { controlled = false; },
  ), /goal set failed/u);

  assert.equal(controlled, false);
});

test("goal mismatch authorizes the native active turn inside the existing execution gate", async () => {
  const events: string[] = [];
  const value = await fixture({
    inspect: async () => ({ state: "owned" }),
    authorizeTurn: (_identity, turnId) => { events.push(`authorize:${turnId}`); },
  });
  value.endpoint.status = "active";
  value.endpoint.threadTurns = [{ id: "goal-race", status: "inProgress", items: [] }];
  value.endpoint.rejectNextGoalSetBeforeEffect = true;

  await assert.rejects(value.service.setGoal(
    "payments",
    "replacement",
    undefined,
    () => undefined,
    () => { events.push("mismatch"); },
  ), /goal set failed/u);

  assert.deepEqual(events, ["authorize:goal-race", "mismatch"]);
});

test("consumeSettingsIfNative clears pending settings for a native (Codex) endpoint but keeps them sticky for Claude", () => {
  // This is the single shared guard behind BOTH the live send AND the crashed-send recovery
  // path in production-app — the site the parity plan flagged as the blocking regression.
  const db = createTestDatabase();
  const controls = new SessionControlStore(db);
  const native = new NativeSessionState();
  for (const endpoint of ["codex-ep", "claude-local"]) {
    controls.setModel(endpoint, "thread", "m", "some-model");
    controls.setEffort(endpoint, "thread", "m", "high");
  }
  const service = new SessionService(
    undefined as never, undefined as never, native, controls, undefined as never, undefined as never,
    undefined as never, undefined as never, undefined, undefined,
    (id: string) => id !== "claude-local", // Codex persists natively; Claude does not
  );

  service.consumeSettingsIfNative("codex-ep", "thread", "m", { model: "some-model", effort: "high" });
  assert.deepEqual(controls.settings("codex-ep", "thread", "m"), {}, "Codex pending settings consumed");

  service.consumeSettingsIfNative("claude-local", "thread", "m", { model: "some-model", effort: "high" });
  assert.deepEqual(controls.settings("claude-local", "thread", "m"), { model: "some-model", effort: "high" },
    "Claude settings stay sticky (never consumed) so they re-apply every turn / survive recovery");
});
