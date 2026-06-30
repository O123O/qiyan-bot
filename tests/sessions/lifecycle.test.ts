import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AppServerEndpoint } from "../../src/app-server/pool.ts";
import { AppServerPool } from "../../src/app-server/pool.ts";
import { AppError } from "../../src/core/errors.ts";
import { SessionRegistry } from "../../src/registry/session-registry.ts";
import { SessionLifecycle } from "../../src/sessions/lifecycle.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { RuntimeStore } from "../../src/storage/runtime-store.ts";

class LifecycleEndpoint implements AppServerEndpoint {
  readonly id = "local";
  state: AppServerEndpoint["state"] = "ready";
  readonly calls: Array<{ method: string; params: any }> = [];
  cwd = "";
  status = "idle";
  threadId = "thread-1";
  turns = [{ id: "historical" }];
  afterResume: (() => void) | undefined;
  failUnsubscribe = false;

  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    const thread = { id: this.threadId, cwd: this.cwd, status: { type: this.status }, turns: this.turns };
    if (method === "thread/start" || method === "thread/resume") {
      this.afterResume?.();
      return { thread: { ...thread, status: { type: this.status } }, cwd: this.cwd } as T;
    }
    if (method === "thread/read") return { thread } as T;
    if (method === "thread/unsubscribe" && this.failUnsubscribe) throw new Error("unsubscribe response lost");
    return {} as T;
  }
}

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "codex-bot-life-")));
  const registry = await SessionRegistry.open(join(dir, "sessions.json"), {
    version: 1,
    coordinator: { endpoint: "local", thread_id: "coordinator", project_dir: dir },
    sessions: {},
  });
  const endpoint = new LifecycleEndpoint();
  endpoint.cwd = dir;
  const runtime = new RuntimeStore(createTestDatabase());
  const lifecycle = new SessionLifecycle(new AppServerPool([endpoint], { maxConcurrentTurns: 2 }), registry, runtime, { now: () => 10_000 });
  return { dir, registry, endpoint, runtime, lifecycle };
}

test("create and adopt verify canonical cwd and establish a managed epoch baseline", async () => {
  const { dir, registry, endpoint, runtime, lifecycle } = await fixture();
  await lifecycle.create("payments", "local", dir);
  assert.equal(registry.get("payments")?.thread_id, "thread-1");
  assert.equal(runtime.getSession("local", "thread-1")?.managementState, "managed");
  assert.equal(runtime.currentEpoch("local", "thread-1")?.baselineTurnId, "historical");

  endpoint.threadId = "thread-2";
  await lifecycle.adopt("billing", "local", "thread-2", dir);
  assert.equal(registry.get("billing")?.thread_id, "thread-2");
  assert.equal(runtime.currentEpoch("local", "thread-2")?.baselineTurnId, "historical");
});

test("adoption rejects active or cwd-mismatched sessions", async () => {
  const { dir, endpoint, lifecycle } = await fixture();
  endpoint.status = "active";
  await assert.rejects(lifecycle.adopt("busy", "local", "thread-1", dir), (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY");
  endpoint.status = "idle";
  endpoint.cwd = tmpdir();
  await assert.rejects(lifecycle.adopt("wrong", "local", "thread-1", dir), (error: unknown) => error instanceof AppError && error.code === "CWD_MISMATCH");
});

test("detach ends the epoch and attach requires idle both before and after resume", async () => {
  const { dir, endpoint, runtime, lifecycle } = await fixture();
  await lifecycle.adopt("payments", "local", "thread-1", dir);
  await lifecycle.detach("payments");
  assert.equal(runtime.getSession("local", "thread-1")?.managementState, "detached");
  assert.ok(runtime.latestEpoch("local", "thread-1")?.endedAt);
  assert.ok(endpoint.calls.some((call) => call.method === "thread/unsubscribe"));

  endpoint.turns = [{ id: "detached-turn" }];
  endpoint.afterResume = () => { endpoint.status = "active"; };
  await assert.rejects(lifecycle.attach("payments"), (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY");
  assert.equal(runtime.getSession("local", "thread-1")?.managementState, "detached");
  assert.equal(endpoint.calls.at(-1)?.method, "thread/unsubscribe");

  endpoint.status = "idle";
  endpoint.afterResume = undefined;
  await lifecycle.attach("payments");
  assert.equal(runtime.currentEpoch("local", "thread-1")?.baselineTurnId, "detached-turn");
});

test("archive requires idle and startup reconciliation completes intermediate states", async () => {
  const { dir, endpoint, runtime, lifecycle } = await fixture();
  await lifecycle.adopt("payments", "local", "thread-1", dir);
  runtime.setSession("local", "thread-1", "detaching", "idle");
  await lifecycle.reconcileStartup();
  assert.equal(runtime.getSession("local", "thread-1")?.managementState, "detached");

  await lifecycle.attach("payments");
  await lifecycle.archive("payments");
  assert.equal(runtime.getSession("local", "thread-1")?.managementState, "archived");
  assert.ok(endpoint.calls.some((call) => call.method === "thread/archive"));
});

test("a failed attach rollback remains uncertain instead of being classified as no effect", async () => {
  const { dir, endpoint, runtime, lifecycle } = await fixture();
  await lifecycle.adopt("payments", "local", "thread-1", dir);
  await lifecycle.detach("payments");
  endpoint.afterResume = () => { endpoint.status = "active"; };
  endpoint.failUnsubscribe = true;
  await assert.rejects(lifecycle.attach("payments"), (error: unknown) => error instanceof AppError && error.code === "OPERATION_UNCERTAIN");
  assert.equal(runtime.getSession("local", "thread-1")?.managementState, "attaching");
});

test("endpoint loss preserves managed restore state for attach recovery", async () => {
  const { dir, runtime, lifecycle } = await fixture();
  await lifecycle.adopt("payments", "local", "thread-1", dir);
  runtime.setSession("local", "thread-1", "unavailable", "notLoaded");
  assert.deepEqual(runtime.getSession("local", "thread-1"), {
    managementState: "unavailable",
    restoreState: "managed",
    nativeStatus: "notLoaded",
  });
});
