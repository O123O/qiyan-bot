import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AppServerEndpoint } from "../../src/app-server/pool.ts";
import { AppServerPool } from "../../src/app-server/pool.ts";
import { AppError } from "../../src/core/errors.ts";
import { SessionRegistry, type RegistrySession } from "../../src/registry/session-registry.ts";
import { SessionLifecycle } from "../../src/sessions/lifecycle.ts";
import { ThreadGate } from "../../src/sessions/thread-gate.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { RuntimeStore } from "../../src/storage/runtime-store.ts";
import type { EndpointWorkLease } from "../../src/endpoints/types.ts";
import type { EndpointManager } from "../../src/endpoints/manager.ts";

class LifecycleEndpoint implements AppServerEndpoint {
  readonly id = "local";
  state: AppServerEndpoint["state"] = "ready";
  readonly calls: Array<{ method: string; params: any }> = [];
  cwd = "";
  status = "idle";
  threadId = "thread-1";
  turns = [{ id: "historical" }];
  path = "/tmp/rollout-thread-1.jsonl";
  pathOnStart: string | null | undefined;
  failResume = false;
  onResume: (() => void) | undefined;

  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    const thread = { id: this.threadId, cwd: this.cwd, path: this.path, threadSource: params?.threadSource ?? null, status: { type: this.status }, turns: this.turns };
    if (method === "thread/start") return {
      thread: { ...thread, path: this.pathOnStart === undefined ? this.path : this.pathOnStart },
      cwd: this.cwd,
      model: "gpt-5",
      reasoningEffort: "high",
    } as T;
    if (method === "thread/read") return { thread } as T;
    if (method === "thread/resume") {
      this.onResume?.();
      if (this.failResume) throw new Error("resume response lost");
      return { thread, cwd: this.cwd, model: "gpt-5", reasoningEffort: "high" } as T;
    }
    return {} as T;
  }
}

async function fixture(ownership?: {
  initialize(identity: { endpoint: string; thread_id: string; mapping_id: string }, path: string): Promise<void>;
  inspectIfInitialized?(identity: { endpoint: string; thread_id: string; mapping_id: string }): Promise<
    { state: "uninitialized" | "owned" } | { state: "external" | "unclassified"; turnId: string }
  >;
  release(identity: { endpoint: string; thread_id: string; mapping_id: string }): void;
}, endpoints?: Pick<EndpointManager, "withWorkLease" | "runWithWorkLease">) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "qiyan-bot-life-")));
  const registry = await SessionRegistry.open(join(dir, "sessions.json"), {
    version: 3,
    assistant: { endpoint: "local", thread_id: "assistant", project_dir: dir },
    sessions: {},
  });
  const endpoint = new LifecycleEndpoint();
  endpoint.cwd = dir;
  const runtime = new RuntimeStore(createTestDatabase());
  const project = { path: dir, created: false, fallback: false, identity: { device: "1", inode: "1" } };
  const checked: string[] = [];
  const gate = new ThreadGate();
  const lifecycle = new SessionLifecycle(
    new AppServerPool([endpoint], { maxConcurrentTurns: 2 }),
    registry,
    runtime,
    { now: () => 10_000 },
    {
      prepareExisting: async (path) => { assert.equal(path, dir); return project; },
      assertDispatchable: async (prepared) => { checked.push(prepared.path); },
    },
    gate,
    endpoints,
    ownership,
  );
  return { dir, registry, endpoint, runtime, lifecycle, project, checked, gate };
}

function required(registry: SessionRegistry, nickname = "payments"): RegistrySession {
  const session = registry.get(nickname);
  assert.ok(session);
  return session;
}

test("create establishes one generation-safe managed epoch", async () => {
  const { registry, endpoint, runtime, lifecycle, project } = await fixture();
  const settings = await lifecycle.create("payments", "local", project, "operation-1");
  assert.deepEqual(settings, { model: "gpt-5", effort: "high" });
  const session = required(registry);
  assert.equal(session.lifecycle_state, "managed");
  assert.match(session.mapping_id, /^mapping_/u);
  assert.equal(runtime.getSession("local", endpoint.threadId, session.mapping_id)?.managementState, "managed");
  assert.equal(runtime.currentEpoch("local", endpoint.threadId, session.mapping_id)?.baselineTurnId, "historical");
});

test("create resolves a nullable start-response rollout path before managing the thread", async () => {
  const initialized: string[] = [];
  const { endpoint, lifecycle, project } = await fixture({
    initialize: async (_identity, path) => { initialized.push(path); },
    release: () => undefined,
  });
  endpoint.pathOnStart = null;

  await lifecycle.create("payments", "local", project, "operation-1");

  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/start", "thread/read"]);
  assert.deepEqual(initialized, [endpoint.path]);
});

test("adopt reserves before resume, uses only native cwd, and promotes after a second idle read", async () => {
  const { dir, registry, endpoint, runtime, lifecycle, checked } = await fixture();
  endpoint.onResume = () => { assert.equal(required(registry).lifecycle_state, "adopting"); };
  await lifecycle.adopt("payments", "local", "thread-1");
  const session = required(registry);
  assert.equal(session.project_dir, dir);
  assert.equal(session.lifecycle_state, "managed");
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/resume", "thread/read"]);
  assert.deepEqual(endpoint.calls[1]?.params, { threadId: "thread-1" });
  assert.deepEqual(checked, [dir, dir]);
  assert.equal(runtime.currentEpoch("local", "thread-1", session.mapping_id)?.baselineTurnId, "historical");
});

test("adopt resumes a disk-backed notLoaded thread before enforcing idle", async () => {
  const { registry, endpoint, runtime, lifecycle } = await fixture();
  endpoint.status = "notLoaded";
  endpoint.onResume = () => {
    assert.equal(required(registry).lifecycle_state, "adopting");
    endpoint.status = "idle";
  };

  await lifecycle.adopt("payments", "local", "thread-1");

  const session = required(registry);
  assert.equal(session.lifecycle_state, "managed");
  assert.equal(runtime.getSession("local", "thread-1", session.mapping_id)?.nativeStatus, "idle");
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/resume", "thread/read"]);
});

test("adopt rejects active and systemError threads before reservation or resume", async (context) => {
  for (const status of ["active", "systemError"]) await context.test(status, async () => {
    const { registry, endpoint, lifecycle } = await fixture();
    endpoint.status = status;

    await assert.rejects(
      lifecycle.adopt("payments", "local", "thread-1"),
      (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY",
    );

    assert.equal(registry.get("payments"), undefined);
    assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read"]);
  });
});

test("adopt rolls back a proven subscription when the resumed thread is active", async () => {
  const { registry, endpoint, lifecycle } = await fixture();
  endpoint.onResume = () => { endpoint.status = "active"; };

  await assert.rejects(
    lifecycle.adopt("payments", "local", "thread-1"),
    (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY",
  );

  assert.equal(registry.get("payments"), undefined);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/resume", "thread/read", "thread/unsubscribe"]);
});

test("adopt rolls back when rollout ownership finds an external active turn", async () => {
  const released: string[] = [];
  const { registry, endpoint, lifecycle } = await fixture({
    initialize: async () => { throw new AppError("SESSION_BUSY", "external turn"); },
    release: (identity) => { released.push(identity.mapping_id); },
  });

  await assert.rejects(
    lifecycle.adopt("payments", "local", "thread-1"),
    (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY",
  );

  assert.equal(registry.get("payments"), undefined);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/resume", "thread/read", "thread/unsubscribe"]);
  assert.equal(released.length, 1);
});

test("duplicate nickname or native identity fails before resume", async () => {
  const { registry, endpoint, lifecycle } = await fixture();
  await lifecycle.adopt("payments", "local", "thread-1");
  endpoint.calls.length = 0;
  await assert.rejects(lifecycle.adopt("other", "local", "thread-1"), /registered|mapping|exists/iu);
  await assert.rejects(lifecycle.adopt("payments", "local", "thread-2"), /nickname|mapping|exists/iu);
  assert.equal(endpoint.calls.length, 0);
  assert.equal(required(registry).thread_id, "thread-1");
});

test("an uncertain resume remains adopting and startup reconciliation promotes only that generation", async () => {
  const { registry, endpoint, runtime, lifecycle } = await fixture();
  endpoint.failResume = true;
  await assert.rejects(lifecycle.adopt("payments", "local", "thread-1"), /resume response lost/);
  const reserved = required(registry);
  assert.equal(reserved.lifecycle_state, "adopting");
  assert.equal(runtime.getSession("local", "thread-1", reserved.mapping_id)?.managementState, "adopting");

  endpoint.failResume = false;
  endpoint.status = "notLoaded";
  endpoint.onResume = () => { endpoint.status = "idle"; };
  endpoint.calls.length = 0;
  await lifecycle.reconcileAdopting();
  assert.equal(required(registry).mapping_id, reserved.mapping_id);
  assert.equal(required(registry).lifecycle_state, "managed");
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/resume", "thread/read"]);
  assert.deepEqual(endpoint.calls[1]?.params, { threadId: "thread-1" });
});

test("startup reconciliation can isolate one unavailable transitional mapping", async () => {
  const { dir, registry, endpoint, runtime, lifecycle } = await fixture();
  const adopting = { endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-offline", lifecycle_state: "adopting" as const };
  await registry.reserve("offline", adopting);
  runtime.setSession("local", "thread-1", adopting.mapping_id, "adopting", "notLoaded");
  endpoint.failResume = true;
  const failures: string[] = [];
  await lifecycle.reconcileAdopting({ onError: (nickname) => { failures.push(nickname); } });
  assert.deepEqual(failures, ["offline"]);
  assert.equal(registry.get("offline")?.lifecycle_state, "adopting");
});

test("startup reconstructs a missing runtime row for an exact managed generation", async () => {
  const { dir, registry, endpoint, runtime, lifecycle } = await fixture();
  const managed = { endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-durable" };
  await registry.createManaged("payments", managed);

  const resumed = await lifecycle.reconcileManaged("payments", required(registry));

  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/resume", "thread/read"]);
  assert.deepEqual(endpoint.calls[1]?.params, { threadId: "thread-1" });
  assert.equal(resumed.thread.id, "thread-1");
  assert.equal(runtime.getSession("local", "thread-1", "mapping-durable")?.managementState, "managed");
  assert.equal(runtime.currentEpoch("local", "thread-1", "mapping-durable")?.baselineTurnId, "historical");
});

test("managed recovery checks an existing rollout guard before reading native history", async () => {
  const seen: string[] = [];
  const { dir, registry, endpoint, lifecycle } = await fixture({
    initialize: async () => undefined,
    inspectIfInitialized: async () => { seen.push("ownership"); return { state: "external", turnId: "external-active" }; },
    release: () => undefined,
  });
  await registry.createManaged("payments", { endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-durable" });

  await assert.rejects(lifecycle.reconcileManaged("payments", required(registry)), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "SESSION_BUSY");
    assert.equal((error as AppError).details?.recovery, "external_turn");
    return true;
  });

  assert.deepEqual(seen, ["ownership"]);
  assert.deepEqual(endpoint.calls, []);
});

test("managed recovery retry-tags only an unclassified ownership boundary", async () => {
  const { dir, registry, endpoint, lifecycle } = await fixture({
    initialize: async () => undefined,
    inspectIfInitialized: async () => ({ state: "unclassified", turnId: "not-classified" }),
    release: () => undefined,
  });
  await registry.createManaged("payments", { endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-durable" });

  await assert.rejects(lifecycle.reconcileManaged("payments", required(registry)), (error: unknown) => {
    assert.equal((error as AppError).code, "OPERATION_UNCERTAIN");
    assert.equal((error as AppError).details?.recovery, "ownership_unclassified");
    return true;
  });
  assert.deepEqual(endpoint.calls, []);
});

test("adopting reconciliation validates native cwd before resuming", async () => {
  const { dir, registry, endpoint, lifecycle } = await fixture();
  await registry.reserve("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-durable", lifecycle_state: "adopting",
  });
  endpoint.cwd = join(dir, "drifted");

  await assert.rejects(lifecycle.reconcileAdopting(), /cwd|directory/iu);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read"]);
  assert.equal(required(registry).lifecycle_state, "adopting");
});

test("adopting reconciliation rolls back a proven subscription when post-resume validation fails", async () => {
  const { dir, registry, endpoint, lifecycle } = await fixture();
  await registry.reserve("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-durable", lifecycle_state: "adopting",
  });
  endpoint.onResume = () => { endpoint.cwd = join(dir, "drifted-after-resume"); };

  await assert.rejects(lifecycle.reconcileAdopting(), /cwd|directory/iu);

  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/resume", "thread/read", "thread/unsubscribe"]);
  assert.equal(registry.get("payments"), undefined);
});

test("unadopt is idle-only, unsubscribes without archive, and removes exactly one mapping", async () => {
  const { registry, endpoint, runtime, lifecycle } = await fixture();
  await lifecycle.adopt("payments", "local", "thread-1");
  const session = required(registry);
  endpoint.status = "active";
  endpoint.calls.length = 0;
  await assert.rejects(lifecycle.unadopt("payments"), (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY");
  assert.equal(required(registry).lifecycle_state, "managed");
  assert.equal(endpoint.calls.some((call) => call.method === "thread/unsubscribe"), false);

  endpoint.status = "idle";
  endpoint.calls.length = 0;
  const checkpoints: string[] = [];
  await lifecycle.unadopt("payments", (checkpoint) => { checkpoints.push(checkpoint.step); });
  assert.equal(registry.get("payments"), undefined);
  assert.deepEqual(checkpoints, ["transition_intent", "transitioned", "native_unsubscribed", "removed"]);
  assert.ok(runtime.latestEpoch("local", "thread-1", session.mapping_id)?.endedAt);
  assert.equal(endpoint.calls.some((call) => call.method === "thread/unsubscribe"), true);
  assert.equal(endpoint.calls.some((call) => call.method === "thread/archive" || call.method === "thread/delete"), false);
});

test("archive is idle-only, invokes native archive, removes the mapping, and never deletes", async () => {
  const { registry, endpoint, lifecycle } = await fixture();
  await lifecycle.adopt("payments", "local", "thread-1");
  endpoint.status = "active";
  endpoint.calls.length = 0;
  await assert.rejects(lifecycle.archive("payments"), (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY");
  assert.equal(required(registry).lifecycle_state, "managed");

  endpoint.status = "idle";
  endpoint.calls.length = 0;
  const checkpoints: string[] = [];
  await lifecycle.archive("payments", (checkpoint) => { checkpoints.push(checkpoint.step); });
  assert.equal(registry.get("payments"), undefined);
  assert.deepEqual(checkpoints, ["transition_intent", "transitioned", "native_archived", "removed"]);
  assert.equal(endpoint.calls.some((call) => call.method === "thread/archive"), true);
  assert.equal(endpoint.calls.some((call) => call.method === "thread/delete"), false);
});

test("startup completes exact unadopting and archiving mappings before managed resume", async () => {
  const { registry, endpoint, lifecycle } = await fixture();
  await lifecycle.adopt("payments", "local", "thread-1");
  const removing = required(registry);
  await registry.transition("payments", removing, "unadopting");
  await lifecycle.reconcileRemovals();
  assert.equal(registry.get("payments"), undefined);

  endpoint.threadId = "thread-2";
  await lifecycle.adopt("billing", "local", "thread-2");
  const archiving = required(registry, "billing");
  await registry.transition("billing", archiving, "archiving");
  await lifecycle.reconcileRemovals();
  assert.equal(registry.get("billing"), undefined);
  assert.equal(endpoint.calls.some((call) => call.method === "thread/unsubscribe"), true);
  assert.equal(endpoint.calls.some((call) => call.method === "thread/archive"), true);
});

test("external removal reuses one existing endpoint lease through unadopt and resumption", async () => {
  const lease: EndpointWorkLease = {
    endpointId: "local",
    lifecycleGeneration: 1,
    endpointGeneration: 2,
    leaseId: "external-monitor",
  };
  const seen: Array<EndpointWorkLease | undefined> = [];
  const endpoints = {
    withWorkLease: async () => { assert.fail("an existing lease must not acquire a replacement"); },
    runWithWorkLease: async <T>(endpointId: string, existing: EndpointWorkLease | undefined, run: (value: EndpointWorkLease | undefined) => Promise<T>) => {
      assert.equal(endpointId, "local");
      seen.push(existing);
      return run(existing);
    },
  } as Pick<EndpointManager, "withWorkLease" | "runWithWorkLease">;
  const { dir, registry, endpoint, lifecycle } = await fixture(undefined, endpoints);
  await registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-1",
  });

  await lifecycle.unadopt("payments", undefined, lease);
  assert.equal(registry.get("payments"), undefined);

  endpoint.threadId = "thread-2";
  const removing = {
    endpoint: "local", thread_id: "thread-2", project_dir: dir, mapping_id: "mapping-2", lifecycle_state: "unadopting" as const,
  };
  const adopting: RegistrySession = { ...removing, lifecycle_state: "adopting" };
  const managed: RegistrySession = { ...removing, lifecycle_state: "managed" };
  await registry.reserve("billing", adopting);
  await registry.promote("billing", adopting);
  await registry.transition("billing", managed, "unadopting");

  await lifecycle.reconcileRemoval("billing", removing, lease);
  assert.equal(registry.get("billing"), undefined);
  assert.deepEqual(seen, [lease, lease]);
});

test("a rename waiting on the gate cannot rename a reused nickname generation", async () => {
  const { dir, registry, lifecycle, gate } = await fixture();
  await lifecycle.adopt("payments", "local", "thread-1");
  const old = required(registry);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { entered = resolve; });
  const blocker = gate.run("local", "thread-1", async () => { entered(); await barrier; });
  await held;
  const rename = lifecycle.rename("payments", "billing");
  await registry.transition("payments", old, "unadopting");
  await registry.removeIfMatch("payments", old);
  const replacement = { endpoint: "local", thread_id: "thread-2", project_dir: dir, mapping_id: "mapping-replacement", lifecycle_state: "adopting" as const };
  await registry.reserve("payments", replacement);
  await registry.promote("payments", replacement);
  release();
  await blocker;
  await assert.rejects(rename, /mapping changed|managed/iu);
  assert.equal(required(registry).mapping_id, "mapping-replacement");
  assert.equal(registry.get("billing"), undefined);
});
