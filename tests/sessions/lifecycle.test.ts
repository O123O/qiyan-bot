import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AppServerEndpoint } from "../../src/app-server/pool.ts";
import { AppServerPool } from "../../src/app-server/pool.ts";
import { JsonRpcResponseError } from "../../src/app-server/json-rpc-client.ts";
import { isExactThreadNoRollout, isExactThreadNotLoaded, isExactThreadNotMaterialized } from "../../src/app-server/thread-errors.ts";
import { AppError } from "../../src/core/errors.ts";
import { SessionRegistry, type RegistrySession } from "../../src/registry/session-registry.ts";
import { SessionLifecycle } from "../../src/sessions/lifecycle.ts";
import { ThreadGate } from "../../src/sessions/thread-gate.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { ManagedEpochStore } from "../../src/storage/managed-epoch-store.ts";
import { NativeSessionState } from "../../src/sessions/native-session-state.ts";
import { SessionControlStore } from "../../src/storage/session-control-store.ts";
import type { EndpointWorkLease } from "../../src/endpoints/types.ts";
import type { EndpointManager } from "../../src/endpoints/manager.ts";
import { WorkspaceRouter } from "../../src/endpoints/workspace-router.ts";
import { LocalWorkspaceHost, type WorkspaceHost } from "../../src/endpoints/ssh-host.ts";
import { ProjectWorkspacePolicy } from "../../src/sessions/project-workspace.ts";
import { createManagedSessionRecoveryOwner, managedRetryKey } from "../../src/production-app.ts";

class LifecycleEndpoint implements AppServerEndpoint {
  constructor(readonly id = "local") {}
  state: AppServerEndpoint["state"] = "ready";
  readonly calls: Array<{ method: string; params: any }> = [];
  cwd = "";
  status = "idle";
  threadId = "thread-1";
  startThreadSource: string | null | undefined;
  createdThreadSource: string | null = null;
  startTurns: Array<{ id: string }> = [];
  resumeThreadId: string | undefined;
  turns: Array<{ id: string; status?: unknown }> = [{ id: "historical" }];
  path = "/tmp/rollout-thread-1.jsonl";
  pathOnStart: string | null | undefined;
  unmaterialized = false;
  failResume = false;
  resumeError: Error | undefined;
  readonly readErrors: Error[] = [];
  unsubscribeError: Error | undefined;
  archiveError: Error | undefined;
  onResume: (() => void) | undefined;
  resumeBarrier: Promise<void> | undefined;

  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    const thread = { id: this.threadId, cwd: this.cwd, path: this.path, threadSource: this.createdThreadSource, status: { type: this.status }, turns: this.turns };
    if (method === "thread/start") {
      this.createdThreadSource = this.startThreadSource === undefined ? params?.threadSource ?? null : this.startThreadSource;
      return {
      thread: {
        ...thread,
        path: this.pathOnStart === undefined ? this.path : this.pathOnStart,
        threadSource: this.createdThreadSource,
        turns: this.startTurns,
      },
      cwd: this.cwd,
      model: "gpt-5",
      reasoningEffort: "high",
      } as T;
    }
    if (method === "thread/read") {
      const error = this.readErrors.shift();
      if (error) throw error;
      if (this.unmaterialized && params.includeTurns === true) {
        throw new JsonRpcResponseError(-32600, `thread ${this.threadId} is not materialized yet; includeTurns is unavailable before first user message`);
      }
      return { thread } as T;
    }
    if (method === "thread/turns/list") {
      if (this.unmaterialized) {
        throw new JsonRpcResponseError(-32600, `thread ${this.threadId} is not materialized yet; thread/turns/list is unavailable before first user message`);
      }
      return {
        data: (params.sortDirection === "asc" ? this.turns : this.turns.slice().reverse())
          .map((turn) => ({ ...turn, status: turn.status ?? "completed", itemsView: params.itemsView ?? "summary", items: [] })),
        nextCursor: null,
        backwardsCursor: null,
      } as T;
    }
    if (method === "thread/resume") {
      this.onResume?.();
      await this.resumeBarrier;
      if (this.resumeError) throw this.resumeError;
      if (this.failResume) throw new Error("resume response lost");
      return {
        thread: {
          ...thread,
          id: this.resumeThreadId ?? thread.id,
          turns: params?.excludeTurns === true ? [] : thread.turns,
        },
        cwd: this.cwd,
        model: "gpt-5",
        reasoningEffort: "high",
      } as T;
    }
    if (method === "thread/unsubscribe" && this.unsubscribeError) throw this.unsubscribeError;
    if (method === "thread/archive" && this.archiveError) throw this.archiveError;
    return {} as T;
  }
}

async function fixture(ownership?: {
  recordUnmaterialized?(
    identity: { endpoint: string; thread_id: string; mapping_id: string },
    path?: string,
  ): void;
  initialize(
    identity: { endpoint: string; thread_id: string; mapping_id: string },
    path: string,
    lease?: EndpointWorkLease,
    options?: { allowUnmaterialized?: boolean; authorizedTurnId?: string },
  ): Promise<void>;
  inspectIfInitialized?(identity: { endpoint: string; thread_id: string; mapping_id: string }, lease?: EndpointWorkLease, options?: { requireMaterialized?: boolean }): Promise<
    { state: "uninitialized" | "owned" | "pending" | "lost" } | { state: "external" | "unclassified"; turnId: string }
  >;
  release(identity: { endpoint: string; thread_id: string; mapping_id: string }): void;
}, endpoints?: Pick<EndpointManager, "withWorkLease" | "runWithWorkLease">, beforeManagedOwnership?: (
  identity: { endpoint: string; thread_id: string; mapping_id: string },
  lease?: EndpointWorkLease,
  thread?: { id: string; turns: Array<{ id: string; status?: unknown }> },
) => Promise<void | { authorizedTurnId?: string; after?: () => void | Promise<void> }>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "qiyan-bot-life-")));
  const registry = await SessionRegistry.open(join(dir, "sessions.json"), {
    version: 3,
    assistant: { endpoint: "local", thread_id: "assistant", project_dir: dir },
    sessions: {},
  });
  const endpoint = new LifecycleEndpoint();
  endpoint.cwd = dir;
  const db = createTestDatabase();
  const epochs = new ManagedEpochStore(db);
  const native = new NativeSessionState();
  const controls = new SessionControlStore(db);
  const project = { path: dir, created: false, fallback: false, identity: { device: "1", inode: "1" } };
  const checked: string[] = [];
  const workspaceFailure: { error?: unknown } = {};
  const gate = new ThreadGate();
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 2 });
  const lifecycle = new SessionLifecycle(
    pool,
    registry,
    epochs,
    native,
    { now: () => 10_000 },
    {
      prepareExisting: async (path) => {
        if (workspaceFailure.error) throw workspaceFailure.error;
        if (path !== dir) throw new AppError("CONFIGURATION_ERROR", "project workspace path is unavailable");
        return project;
      },
      assertDispatchable: async (prepared) => { checked.push(prepared.path); },
    },
    gate,
    endpoints,
    ownership ? {
      ...ownership,
      recordUnmaterialized: ownership.recordUnmaterialized ?? (() => undefined),
    } : undefined,
    beforeManagedOwnership,
  );
  return { db, dir, registry, endpoint, epochs, native, controls, pool, lifecycle, project, checked, gate, workspaceFailure };
}

function required(registry: SessionRegistry, nickname = "payments"): RegistrySession {
  const session = registry.get(nickname);
  assert.ok(session);
  return session;
}

test("thread-not-loaded evidence requires the exact RPC code, message, and thread identity", () => {
  assert.equal(isExactThreadNotLoaded(new JsonRpcResponseError(-32600, "thread not loaded: thread-1"), "thread-1"), true);
  assert.equal(isExactThreadNotLoaded(new JsonRpcResponseError(-32000, "thread not loaded: thread-1"), "thread-1"), false);
  assert.equal(isExactThreadNotLoaded(new JsonRpcResponseError(-32600, "thread not loaded: thread-2"), "thread-1"), false);
  assert.equal(isExactThreadNotLoaded(new JsonRpcResponseError(-32600, "thread missing: thread-1"), "thread-1"), false);
  assert.equal(isExactThreadNotLoaded(new Error("thread not loaded: thread-1"), "thread-1"), false);
});

test("thread-not-materialized evidence requires the exact RPC code, message, and thread identity", () => {
  const message = "thread thread-1 is not materialized yet; includeTurns is unavailable before first user message";
  assert.equal(isExactThreadNotMaterialized(new JsonRpcResponseError(-32600, message), "thread-1"), true);
  assert.equal(isExactThreadNotMaterialized(new JsonRpcResponseError(-32000, message), "thread-1"), false);
  assert.equal(isExactThreadNotMaterialized(new JsonRpcResponseError(-32600, message), "thread-2"), false);
  assert.equal(isExactThreadNotMaterialized(new Error(message), "thread-1"), false);
});

test("thread-without-rollout evidence requires the exact RPC code, message, and thread identity", () => {
  assert.equal(isExactThreadNoRollout(new JsonRpcResponseError(-32600, "no rollout found for thread id thread-1"), "thread-1"), true);
  assert.equal(isExactThreadNoRollout(new JsonRpcResponseError(-32000, "no rollout found for thread id thread-1"), "thread-1"), false);
  assert.equal(isExactThreadNoRollout(new JsonRpcResponseError(-32600, "no rollout found for thread id thread-2"), "thread-1"), false);
  assert.equal(isExactThreadNoRollout(new Error("no rollout found for thread id thread-1"), "thread-1"), false);
});

test("create establishes one generation-safe managed epoch", async () => {
  const { registry, endpoint, epochs, native, lifecycle, project } = await fixture();
  const settings = await lifecycle.create("payments", "local", project, "operation-1");
  assert.deepEqual(settings, { model: "gpt-5", effort: "high" });
  const session = required(registry);
  assert.equal(session.lifecycle_state, "managed");
  assert.match(session.mapping_id, /^mapping_/u);
  assert.equal(native.view({ endpointId: "local", threadId: endpoint.threadId, mappingId: session.mapping_id })?.status, "idle");
  assert.equal(epochs.current("local", endpoint.threadId, session.mapping_id)?.baselineTurnId, undefined);
});

test("create accepts a nullable start-response rollout path without a follow-up read", async () => {
  const recorded: Array<string | undefined> = [];
  const { endpoint, lifecycle, project } = await fixture({
    recordUnmaterialized: (_identity, path) => { recorded.push(path); },
    initialize: async () => { assert.fail("fresh creation must not scan rollout ownership"); },
    release: () => undefined,
  });
  endpoint.pathOnStart = null;
  endpoint.turns = [];

  await lifecycle.create("payments", "local", project, "operation-1");

  assert.deepEqual(endpoint.calls.map((call) => [call.method, call.params?.includeTurns]), [
    ["thread/start", undefined],
  ]);
  assert.deepEqual(recorded, [undefined]);
});

test("create records an unmaterialized rollout without scanning after thread/start", async () => {
  const recorded: Array<string | undefined> = [];
  const { registry, endpoint, lifecycle, project, checked } = await fixture({
    recordUnmaterialized: (_identity, path) => { recorded.push(path); },
    initialize: async () => { assert.fail("fresh creation must not scan rollout ownership"); },
    release: () => undefined,
  });
  endpoint.turns = [];

  await lifecycle.create("payments", "local", project, "operation-1");

  assert.equal(required(registry).lifecycle_state, "managed");
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/start"]);
  assert.deepEqual(checked, [project.path]);
  assert.deepEqual(recorded, [endpoint.path]);
});

test("create rejects malformed successful start responses before registry publication", async (t) => {
  const cases: Array<{ name: string; mutate(endpoint: LifecycleEndpoint): void; pattern: RegExp }> = [
    { name: "empty ID", mutate: (endpoint) => { endpoint.threadId = ""; }, pattern: /identity/iu },
    { name: "wrong source", mutate: (endpoint) => { endpoint.startThreadSource = "other"; }, pattern: /creation source/iu },
    { name: "wrong cwd", mutate: (endpoint) => { endpoint.cwd = "/wrong"; }, pattern: /cwd/iu },
    { name: "non-idle status", mutate: (endpoint) => { endpoint.status = "active"; }, pattern: /active/iu },
    { name: "non-empty turns", mutate: (endpoint) => { endpoint.startTurns = [{ id: "unexpected" }]; }, pattern: /turns/iu },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const { registry, endpoint, lifecycle, project } = await fixture();
    item.mutate(endpoint);
    await assert.rejects(lifecycle.create("payments", "local", project, "operation-1"), item.pattern);
    assert.equal(registry.get("payments"), undefined);
  });
});

test("adopt reserves before resume, uses only native cwd, and promotes after a second idle read", async () => {
  const { dir, registry, endpoint, epochs, lifecycle, checked } = await fixture();
  endpoint.onResume = () => { assert.equal(required(registry).lifecycle_state, "adopting"); };
  await lifecycle.adopt("payments", "local", "thread-1");
  const session = required(registry);
  assert.equal(session.project_dir, dir);
  assert.equal(session.lifecycle_state, "managed");
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/turns/list", "thread/resume", "thread/read", "thread/turns/list"]);
  assert.deepEqual(endpoint.calls.find((call) => call.method === "thread/resume")?.params, { threadId: "thread-1", excludeTurns: true });
  assert.deepEqual(checked, [dir, dir]);
  assert.equal(epochs.current("local", "thread-1", session.mapping_id)?.baselineTurnId, "historical");
});

test("adopt resumes a disk-backed notLoaded thread before enforcing idle", async () => {
  const { registry, endpoint, native, lifecycle } = await fixture();
  endpoint.status = "notLoaded";
  endpoint.onResume = () => {
    assert.equal(required(registry).lifecycle_state, "adopting");
    endpoint.status = "idle";
  };

  await lifecycle.adopt("payments", "local", "thread-1");

  const session = required(registry);
  assert.equal(session.lifecycle_state, "managed");
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: session.mapping_id })?.status, "idle");
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/turns/list", "thread/resume", "thread/read", "thread/turns/list"]);
});

test("adopt manages a loaded empty thread without requiring a nonexistent rollout resume", async () => {
  const initialized: Array<{ allowUnmaterialized?: boolean }> = [];
  const { registry, endpoint, lifecycle } = await fixture({
    initialize: async (_identity, _path, _lease, options) => { initialized.push(options ?? {}); },
    release: () => undefined,
  });
  endpoint.turns = [];
  endpoint.unmaterialized = true;
  endpoint.failResume = true;

  await lifecycle.adopt("payments", "local", "thread-1");

  assert.equal(required(registry).lifecycle_state, "managed");
  assert.deepEqual(endpoint.calls.map((call) => [call.method, call.params?.includeTurns]), [
    ["thread/read", false],
    ["thread/turns/list", undefined],
  ]);
  assert.deepEqual(initialized, [{ allowUnmaterialized: true }]);
});

test("loaded-empty adoption failure removes only its reservation and preserves ownership evidence", async () => {
  const released: string[] = [];
  const { registry, endpoint, lifecycle } = await fixture({
    initialize: async () => { throw new AppError("SESSION_BUSY", "external first turn was classified"); },
    release: (identity) => { released.push(identity.mapping_id); },
  });
  endpoint.turns = [];
  endpoint.unmaterialized = true;
  endpoint.failResume = true;

  await assert.rejects(
    lifecycle.adopt("payments", "local", "thread-1", undefined, "mapping-empty-failure"),
    (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY",
  );

  assert.equal(registry.get("payments"), undefined);
  assert.deepEqual(endpoint.calls.map((call) => [call.method, call.params?.includeTurns]), [
    ["thread/read", false],
    ["thread/turns/list", undefined],
  ]);
  assert.deepEqual(released, []);
});

test("adopt resumes an exact read-not-loaded thread and validates it before promotion", async () => {
  const { registry, endpoint, native, lifecycle } = await fixture();
  endpoint.readErrors.push(new JsonRpcResponseError(-32600, "thread not loaded: thread-1"));

  await lifecycle.adopt("payments", "local", "thread-1");

  const session = required(registry);
  assert.equal(session.lifecycle_state, "managed");
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: session.mapping_id })?.availability, "ready");
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/resume", "thread/read", "thread/turns/list"]);
});

test("adopt proves a not-loaded empty thread without a rollout is no longer restorable", async () => {
  const { registry, endpoint, lifecycle } = await fixture();
  endpoint.readErrors.push(new JsonRpcResponseError(-32600, "thread not loaded: thread-1"));
  endpoint.resumeError = new JsonRpcResponseError(-32600, "no rollout found for thread id thread-1");

  await assert.rejects(lifecycle.adopt("payments", "local", "thread-1"), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "THREAD_NOT_FOUND", true);
    assert.deepEqual((error as AppError).details, { recovery: "thread_not_durable", threadId: "thread-1" });
    return true;
  });

  assert.equal(registry.get("payments"), undefined);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/resume"]);
});

test("adopt validates the immediate resume response identity before trusting a later read", async () => {
  const { registry, endpoint, lifecycle } = await fixture();
  endpoint.readErrors.push(new JsonRpcResponseError(-32600, "thread not loaded: thread-1"));
  endpoint.resumeThreadId = "wrong-thread";

  await assert.rejects(lifecycle.adopt("payments", "local", "thread-1"), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "OPERATION_UNCERTAIN", true);
    return true;
  });

  assert.equal(registry.get("payments"), undefined);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/resume", "thread/unsubscribe"]);
});

test("an early adoption resume rolls back wrong identity and surfaces rollback uncertainty", async () => {
  const first = await fixture();
  first.endpoint.readErrors.push(new JsonRpcResponseError(-32600, "thread not loaded: thread-1"));
  first.endpoint.onResume = () => { first.endpoint.threadId = "wrong-thread"; };

  await assert.rejects(first.lifecycle.adopt("payments", "local", "thread-1"), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "OPERATION_UNCERTAIN", true);
    return true;
  });
  assert.equal(first.registry.get("payments"), undefined);
  assert.deepEqual(first.endpoint.calls.map((call) => call.method), ["thread/read", "thread/resume", "thread/read", "thread/turns/list", "thread/unsubscribe"]);

  const second = await fixture();
  second.endpoint.readErrors.push(new JsonRpcResponseError(-32600, "thread not loaded: thread-1"));
  second.endpoint.onResume = () => { second.endpoint.cwd = join(second.dir, "wrong"); };
  second.endpoint.unsubscribeError = new Error("rollback response lost");
  await assert.rejects(second.lifecycle.adopt("payments", "local", "thread-1"), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "OPERATION_UNCERTAIN", true);
    assert.match(String(error), /rollback could not be confirmed/u);
    return true;
  });
});

test("an early adoption resume rolls back source and status validation failures", async () => {
  const source = await fixture();
  source.endpoint.readErrors.push(new JsonRpcResponseError(-32600, "thread not loaded: thread-1"));
  await assert.rejects(source.lifecycle.adopt("payments", "local", "thread-1", () => {
    throw new AppError("OPERATION_UNCERTAIN", "recovered worker thread has the wrong creation source");
  }), /creation source/u);
  assert.equal(source.registry.get("payments"), undefined);
  assert.deepEqual(source.endpoint.calls.map((call) => call.method), ["thread/read", "thread/resume", "thread/read", "thread/turns/list", "thread/unsubscribe"]);

  const active = await fixture();
  active.endpoint.readErrors.push(new JsonRpcResponseError(-32600, "thread not loaded: thread-1"));
  active.endpoint.onResume = () => { active.endpoint.status = "active"; };
  await assert.rejects(active.lifecycle.adopt("payments", "local", "thread-1"), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "SESSION_BUSY", true);
    return true;
  });
  assert.equal(active.registry.get("payments"), undefined);
  assert.deepEqual(active.endpoint.calls.map((call) => call.method), ["thread/read", "thread/resume", "thread/read", "thread/turns/list", "thread/unsubscribe"]);
});

test("adoption rollback accepts exact unsubscribe absence but requires exact reservation removal", async () => {
  const absent = await fixture();
  absent.endpoint.readErrors.push(new JsonRpcResponseError(-32600, "thread not loaded: thread-1"));
  absent.endpoint.unsubscribeError = new JsonRpcResponseError(-32600, "thread not loaded: thread-1");
  await assert.rejects(absent.lifecycle.adopt("payments", "local", "thread-1", () => {
    throw new AppError("OPERATION_UNCERTAIN", "source validation failed");
  }), /source validation failed/u);
  assert.equal(absent.registry.get("payments"), undefined);

  const fenced = await fixture();
  fenced.endpoint.onResume = () => { fenced.endpoint.status = "active"; };
  const registryWithFailedRemoval = fenced.registry as SessionRegistry & {
    removeIfMatch(nickname: string, expected: RegistrySession): Promise<boolean>;
  };
  registryWithFailedRemoval.removeIfMatch = async () => false;
  await assert.rejects(fenced.lifecycle.adopt("payments", "local", "thread-1"), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "OPERATION_UNCERTAIN", true);
    assert.match(String(error), /rollback could not be confirmed/u);
    return true;
  });
  assert.equal(required(fenced.registry).lifecycle_state, "adopting");
});

test("direct adoption retains ownership until rollback and exact reservation removal both succeed", async () => {
  for (const failure of ["unsubscribe", "remove"] as const) {
    const initialized: string[] = [];
    const released: string[] = [];
    const value = await fixture({
      initialize: async (identity) => { initialized.push(identity.mapping_id); },
      release: (identity) => { released.push(identity.mapping_id); },
    });
    const registryWithFailure = value.registry as SessionRegistry & {
      promote(nickname: string, expected: RegistrySession): Promise<void>;
      removeIfMatch(nickname: string, expected: RegistrySession): Promise<boolean>;
    };
    registryWithFailure.promote = async () => { throw new Error("promotion failed after ownership initialization"); };
    if (failure === "unsubscribe") value.endpoint.unsubscribeError = new Error("unsubscribe response lost");
    else registryWithFailure.removeIfMatch = async () => false;

    await assert.rejects(value.lifecycle.adopt("payments", "local", "thread-1"), (error: unknown) => {
      assert.equal(error instanceof AppError && error.code === "OPERATION_UNCERTAIN", true);
      return true;
    });

    assert.equal(initialized.length, 1);
    assert.deepEqual(released, [], `ownership must survive ${failure} rollback failure`);
    assert.equal(required(value.registry).lifecycle_state, "adopting");
  }
});

test("adopt never treats a near-match read error as thread absence", async () => {
  for (const error of [
    new JsonRpcResponseError(-32000, "thread not loaded: thread-1"),
    new JsonRpcResponseError(-32600, "thread not loaded: another-thread"),
  ]) {
    const { registry, endpoint, lifecycle } = await fixture();
    endpoint.readErrors.push(error);
    await assert.rejects(lifecycle.adopt("payments", "local", "thread-1"), (actual: unknown) => actual === error);
    assert.equal(registry.get("payments"), undefined);
    assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read"]);
  }
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
    assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/turns/list"]);
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
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/turns/list", "thread/resume", "thread/read", "thread/turns/list", "thread/unsubscribe"]);
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
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/turns/list", "thread/resume", "thread/read", "thread/turns/list", "thread/unsubscribe"]);
  assert.equal(released.length, 0, "rollback must preserve durable external-turn evidence");
});

test("adoption retries preserve failed ownership classification across rollback", async () => {
  let classifications = 0;
  const released: string[] = [];
  const value = await fixture({
    initialize: async () => {
      classifications += 1;
      throw new AppError("SESSION_BUSY", "external first turn is durably classified");
    },
    release: (identity) => { released.push(identity.mapping_id); },
  });
  value.endpoint.turns = [];
  const run = () => value.lifecycle.adopt("payments", "local", "thread-1", undefined, "mapping-retry");

  await assert.rejects(run(), (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY");
  await assert.rejects(run(), (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY");

  assert.equal(value.registry.get("payments"), undefined);
  assert.equal(classifications, 2);
  assert.deepEqual(released, []);
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
  const { registry, endpoint, lifecycle } = await fixture();
  endpoint.failResume = true;
  await assert.rejects(lifecycle.adopt("payments", "local", "thread-1"), /resume response lost/);
  const reserved = required(registry);
  assert.equal(reserved.lifecycle_state, "adopting");
  assert.equal(reserved.lifecycle_state, "adopting");

  endpoint.failResume = false;
  endpoint.status = "notLoaded";
  endpoint.onResume = () => { endpoint.status = "idle"; };
  endpoint.calls.length = 0;
  await lifecycle.reconcileAdopting();
  assert.equal(required(registry).mapping_id, reserved.mapping_id);
  assert.equal(required(registry).lifecycle_state, "managed");
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/turns/list", "thread/resume", "thread/read", "thread/turns/list"]);
  assert.deepEqual(endpoint.calls.find((call) => call.method === "thread/resume")?.params, { threadId: "thread-1", excludeTurns: true });
});

test("adopting reconciliation resumes an exact read-not-loaded durable mapping", async () => {
  const { dir, registry, endpoint, lifecycle } = await fixture();
  const adopting = {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-durable", lifecycle_state: "adopting" as const,
  };
  await registry.reserve("payments", adopting);
  endpoint.readErrors.push(new JsonRpcResponseError(-32600, "thread not loaded: thread-1"));

  await lifecycle.reconcileAdopting();

  assert.equal(required(registry).lifecycle_state, "managed");
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/resume", "thread/read", "thread/turns/list"]);
});

test("adopting reconciliation promotes a loaded empty thread without rollout resume", async () => {
  const { dir, registry, endpoint, lifecycle } = await fixture();
  await registry.reserve("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-empty", lifecycle_state: "adopting",
  });
  endpoint.turns = [];
  endpoint.unmaterialized = true;
  endpoint.failResume = true;

  await lifecycle.reconcileAdopting();

  assert.equal(required(registry).lifecycle_state, "managed");
  assert.deepEqual(endpoint.calls.map((call) => [call.method, call.params?.includeTurns]), [
    ["thread/read", false],
    ["thread/turns/list", undefined],
  ]);
});

test("loaded-empty adopting reconciliation failure retains its mapping without unsubscribe", async () => {
  const released: string[] = [];
  const { dir, registry, endpoint, lifecycle } = await fixture({
    initialize: async () => { throw new AppError("OPERATION_UNCERTAIN", "ownership scan is temporarily unavailable"); },
    release: (identity) => { released.push(identity.mapping_id); },
  });
  await registry.reserve("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-empty-retry", lifecycle_state: "adopting",
  });
  endpoint.turns = [];
  endpoint.unmaterialized = true;
  endpoint.failResume = true;

  await assert.rejects(lifecycle.reconcileAdopting(), /temporarily unavailable/u);

  assert.equal(required(registry).lifecycle_state, "adopting");
  assert.deepEqual(endpoint.calls.map((call) => [call.method, call.params?.includeTurns]), [
    ["thread/read", false],
    ["thread/turns/list", undefined],
  ]);
  assert.deepEqual(released, []);
});

test("startup reconciliation can isolate one unavailable transitional mapping", async () => {
  const { dir, registry, endpoint, lifecycle } = await fixture();
  const adopting = { endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-offline", lifecycle_state: "adopting" as const };
  await registry.reserve("offline", adopting);
  endpoint.failResume = true;
  const failures: string[] = [];
  await lifecycle.reconcileAdopting({ onError: (nickname) => { failures.push(nickname); } });
  assert.deepEqual(failures, ["offline"]);
  assert.equal(registry.get("offline")?.lifecycle_state, "adopting");
});

test("startup reconstructs live state for an exact managed generation", async () => {
  const { dir, registry, endpoint, epochs, native, lifecycle } = await fixture();
  const managed = { endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-durable" };
  await registry.createManaged("payments", managed);

  const resumed = await lifecycle.reconcileManaged("payments", required(registry));

  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/turns/list", "thread/resume", "thread/read", "thread/turns/list"]);
  assert.deepEqual(endpoint.calls.find((call) => call.method === "thread/resume")?.params, { threadId: "thread-1", excludeTurns: true });
  assert.equal(resumed.thread.id, "thread-1");
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: "mapping-durable" })?.availability, "ready");
  assert.equal(epochs.current("local", "thread-1", "mapping-durable")?.baselineTurnId, "historical");
});

test("missing goal-control intent is unknown before goal validation and ownership", async () => {
  let value!: Awaited<ReturnType<typeof fixture>>;
  const seen: string[] = [];
  value = await fixture({
    initialize: async (_identity, _path, _lease, options) => {
      seen.push(`initialize:${options?.authorizedTurnId ?? "none"}`);
    },
    inspectIfInitialized: async (identity) => {
      seen.push("ownership");
      assert.equal(value.controls.goalControlled(identity.endpoint, identity.thread_id, identity.mapping_id), true);
      return { state: "owned" };
    },
    release: () => undefined,
  }, undefined, async (identity, _lease, thread) => {
    const control = value.controls.goalControl(identity.endpoint, identity.thread_id, identity.mapping_id);
    assert.equal(control.known, false);
    assert.equal(thread?.turns.at(-1)?.id, "legacy-goal-turn");
    seen.push("goal");
    value.controls.setGoalControlled(identity.endpoint, identity.thread_id, identity.mapping_id, true);
    return { authorizedTurnId: thread!.turns.at(-1)!.id };
  });
  await value.registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: value.dir, mapping_id: "mapping-legacy",
  });
  value.endpoint.status = "active";
  value.endpoint.turns = [{ id: "legacy-goal-turn", status: "inProgress" }];

  await value.lifecycle.reconcileManaged("payments", required(value.registry));

  assert.deepEqual(seen, ["goal", "ownership", "initialize:legacy-goal-turn"]);
  assert.equal(value.controls.goalControlled("local", "thread-1", "mapping-legacy"), true);
});

test("managed recovery restores a loaded empty thread without rollout resume", async () => {
  const { dir, registry, endpoint, native, lifecycle } = await fixture();
  await registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-empty",
  });
  endpoint.turns = [];
  endpoint.unmaterialized = true;
  endpoint.failResume = true;

  const recovered = await lifecycle.reconcileManaged("payments", required(registry));

  assert.equal(recovered.thread.id, "thread-1");
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: "mapping-empty" })?.availability, "ready");
  assert.deepEqual(endpoint.calls.map((call) => [call.method, call.params?.includeTurns]), [
    ["thread/read", false],
    ["thread/turns/list", undefined],
  ]);
});

test("managed recovery of an already-managed idle thread reads metadata only (no full read, no resume)", async () => {
  const { dir, registry, endpoint, epochs, native, lifecycle } = await fixture();
  await registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-idle",
  });
  endpoint.status = "idle";
  endpoint.turns = [{ id: "t1", status: "completed" }, { id: "t2", status: "completed" }]; // has rollout history
  endpoint.failResume = true; // resume would throw — proves an already-loaded thread is never resumed
  // A persisted epoch (as after a bot restart) means the delivery baseline is already known.
  epochs.begin("local", "thread-1", "mapping-idle", "t2", 0);

  const recovered = await lifecycle.reconcileManaged("payments", required(registry));

  assert.equal(recovered.thread.id, "thread-1");
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: "mapping-idle" })?.status, "idle");
  // The whole point: an idle, already-managed thread is recovered from a single metadata-only read —
  // codex is NOT asked to re-materialize the full rollout, and the thread is not resumed.
  assert.deepEqual(endpoint.calls.map((call) => [call.method, call.params?.includeTurns]), [["thread/read", false]]);
});

test("managed recovery rebinds an idle thread to a replacement notification connection", async () => {
  const { dir, registry, endpoint, epochs, native, lifecycle } = await fixture();
  await registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-rebound",
  });
  endpoint.status = "idle";
  endpoint.turns = [{ id: "t1", status: "completed" }, { id: "t2", status: "completed" }];
  epochs.begin("local", "thread-1", "mapping-rebound", "t2", 0);

  const recovered = await lifecycle.reconcileManaged(
    "payments",
    required(registry),
    undefined,
    undefined,
    { resumeForConnection: true },
  );

  assert.equal(recovered.thread.id, "thread-1");
  assert.deepEqual(recovered.thread.turns, []);
  assert.deepEqual(endpoint.turns.map((turn) => turn.id), ["t1", "t2"]);
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: "mapping-rebound" })?.status, "idle");
  assert.deepEqual(endpoint.calls, [
    { method: "thread/read", params: { threadId: "thread-1", includeTurns: false } },
    { method: "thread/turns/list", params: { threadId: "thread-1", limit: 1, sortDirection: "desc", itemsView: "notLoaded" } },
    { method: "thread/resume", params: { threadId: "thread-1", excludeTurns: true } },
  ]);
});

test("managed connection recovery preserves an active turn without transferring persisted history", async () => {
  const { dir, registry, endpoint, epochs, native, lifecycle } = await fixture(undefined, undefined, async (_identity, _lease, thread) => {
    assert.deepEqual(thread?.turns.map((turn) => turn.id), ["t2"]);
  });
  await registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-active-rebound",
  });
  endpoint.status = "active";
  endpoint.turns = [{ id: "t1", status: "completed" }, { id: "t2", status: "inProgress" }];
  epochs.begin("local", "thread-1", "mapping-active-rebound", "t1", 0);

  const recovered = await lifecycle.reconcileManaged(
    "payments",
    required(registry),
    undefined,
    undefined,
    { resumeForConnection: true },
  );

  assert.equal(recovered.thread.status.type, "active");
  assert.deepEqual(recovered.thread.turns, []);
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: "mapping-active-rebound" })?.activeTurnId, "t2");
  assert.deepEqual(endpoint.turns.map((turn) => turn.id), ["t1", "t2"]);
  assert.deepEqual(endpoint.calls, [
    { method: "thread/read", params: { threadId: "thread-1", includeTurns: false } },
    { method: "thread/turns/list", params: { threadId: "thread-1", limit: 1, sortDirection: "desc", itemsView: "notLoaded" } },
    { method: "thread/resume", params: { threadId: "thread-1", excludeTurns: true } },
  ]);
});

test("managed connection recovery establishes a baseline from one bounded turn summary", async () => {
  const initialization: Array<{ allowUnmaterialized?: boolean }> = [];
  const { dir, registry, endpoint, epochs, native, lifecycle } = await fixture({
    initialize: async (_identity, _path, _lease, options) => { initialization.push(options ?? {}); },
    inspectIfInitialized: async () => ({ state: "uninitialized" }),
    release: () => undefined,
  });
  await registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-empty-rebound",
  });
  endpoint.status = "idle";
  endpoint.turns = [{ id: "t1", status: "completed" }, { id: "t2", status: "completed" }];

  const recovered = await lifecycle.reconcileManaged(
    "payments",
    required(registry),
    undefined,
    undefined,
    { resumeForConnection: true },
  );

  assert.equal(recovered.thread.id, "thread-1");
  assert.deepEqual(recovered.thread.turns, []);
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: "mapping-empty-rebound" })?.status, "idle");
  assert.equal(epochs.current("local", "thread-1", "mapping-empty-rebound")?.baselineTurnId, "t2");
  assert.deepEqual(initialization, [{ allowUnmaterialized: false }]);
  assert.deepEqual(endpoint.calls, [
    { method: "thread/read", params: { threadId: "thread-1", includeTurns: false } },
    { method: "thread/turns/list", params: { threadId: "thread-1", limit: 1, sortDirection: "desc", itemsView: "notLoaded" } },
    { method: "thread/resume", params: { threadId: "thread-1", excludeTurns: true } },
  ]);
});

test("managed connection recovery treats the exact pre-message turns-list error as empty", async () => {
  const { dir, registry, endpoint, epochs, native, lifecycle } = await fixture();
  await registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-never-started",
  });
  endpoint.status = "idle";
  endpoint.turns = [];
  endpoint.unmaterialized = true;

  const recovered = await lifecycle.reconcileManaged(
    "payments",
    required(registry),
    undefined,
    undefined,
    { resumeForConnection: true },
  );

  assert.deepEqual(recovered.thread.turns, []);
  assert.equal(epochs.current("local", "thread-1", "mapping-never-started")?.baselineTurnId, undefined);
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: "mapping-never-started" })?.status, "idle");
});

test("create-completion recovery drops a managed mapping whose rollout never materialized", async () => {
  const requireFlags: Array<boolean | undefined> = [];
  const released: string[] = [];
  const { dir, registry, endpoint, epochs, lifecycle } = await fixture({
    initialize: async () => { assert.fail("a non-durable create must be dropped before ownership initialization"); },
    inspectIfInitialized: async (_identity, _lease, options) => {
      requireFlags.push(options?.requireMaterialized);
      // The guard reports "lost" only under the materialization-required create-recovery check.
      return options?.requireMaterialized ? { state: "lost" } : { state: "owned" };
    },
    release: (identity) => { released.push(identity.mapping_id); },
  });
  await registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-phantom",
  });
  endpoint.turns = [];
  endpoint.unmaterialized = true;
  endpoint.failResume = true;

  await assert.rejects(
    lifecycle.reconcileManaged("payments", required(registry), undefined, undefined, { requireDurableRollout: true }),
    (error: unknown) => error instanceof AppError && error.code === "THREAD_NOT_FOUND",
  );

  assert.deepEqual(requireFlags, [true]);
  assert.equal(registry.get("payments"), undefined, "the phantom mapping must be removed");
  assert.deepEqual(released, ["mapping-phantom"]);
  assert.equal(epochs.current("local", "thread-1", "mapping-phantom"), undefined);
});

test("default managed recovery still restores an unmaterialized 0-turn thread", async () => {
  const { dir, registry, native, endpoint, lifecycle } = await fixture({
    initialize: async () => undefined,
    inspectIfInitialized: async (_identity, _lease, options) => (options?.requireMaterialized ? { state: "lost" } : { state: "owned" }),
    release: () => undefined,
  });
  await registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-live",
  });
  endpoint.turns = [];
  endpoint.unmaterialized = true;
  endpoint.failResume = true;

  const recovered = await lifecycle.reconcileManaged("payments", required(registry));

  assert.equal(recovered.thread.id, "thread-1");
  assert.equal(registry.get("payments")?.lifecycle_state, "managed");
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: "mapping-live" })?.availability, "ready");
});

test("managed recovery validates native goal state before ownership after resuming an exact read-not-loaded mapping", async () => {
  const seen: string[] = [];
  const goalCheck = async () => {
    seen.push("goal");
    return { after: () => { seen.push("goal-cleanup"); } };
  };
  const { dir, registry, endpoint, lifecycle } = await fixture({
    initialize: async () => { seen.push("initialize"); },
    inspectIfInitialized: async () => { seen.push("ownership"); return { state: "owned" }; },
    release: () => undefined,
  }, undefined, goalCheck);
  await registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-durable",
  });
  endpoint.readErrors.push(new JsonRpcResponseError(-32600, "thread not loaded: thread-1"));
  endpoint.onResume = () => { seen.push("resume"); };

  await lifecycle.reconcileManaged("payments", required(registry));

  assert.deepEqual(seen, ["resume", "goal", "ownership", "initialize", "goal-cleanup"]);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/resume", "thread/read", "thread/turns/list"]);
});

test("managed recovery rejects a wrong immediate resume identity without publishing live state", async () => {
  const { dir, registry, endpoint, native, controls, lifecycle } = await fixture();
  await registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-durable",
  });
  endpoint.resumeThreadId = "wrong-thread";

  await assert.rejects(lifecycle.reconcileManaged("payments", required(registry)), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "OPERATION_UNCERTAIN", true);
    return true;
  });

  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: "mapping-durable" }), undefined);
  assert.equal(controls.goalControl("local", "thread-1", "mapping-durable").known, false);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/turns/list", "thread/resume"]);
});

test("stopping managed recovery while native resume is blocked fences every success publication", async () => {
  const lease: EndpointWorkLease = {
    endpointId: "local", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "blocked-recovery",
  };
  const endpoints = {
    withWorkLease: async <T>(
      _endpointId: string | undefined,
      _kind: "rpc" | "session-mutation" | "file-transfer",
      run: (endpoint: never, current: EndpointWorkLease) => Promise<T>,
    ): Promise<T> => run(undefined as never, lease),
    runWithWorkLease: async <T>(
      _endpointId: string,
      existing: EndpointWorkLease | undefined,
      run: (current: EndpointWorkLease | undefined) => Promise<T>,
    ): Promise<T> => run(existing ?? lease),
  } satisfies Pick<EndpointManager, "withWorkLease" | "runWithWorkLease">;
  const { dir, registry, endpoint, epochs, native, lifecycle } = await fixture(undefined, endpoints);
  const session = {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-durable",
  };
  await registry.createManaged("payments", session);
  let signalResume!: () => void;
  let releaseResume!: () => void;
  const resumeStarted = new Promise<void>((resolve) => { signalResume = resolve; });
  endpoint.resumeBarrier = new Promise<void>((resolve) => { releaseResume = resolve; });
  endpoint.onResume = signalResume;
  let capacityPublications = 0;
  let dashboardPublications = 0;
  let observationPublications = 0;
  const key = managedRetryKey("local", "thread-1", session.mapping_id);
  const owner = createManagedSessionRecoveryOwner({
    endpoints: { withReadyWorkLease: async (_endpointId, run) => run(lease) },
    isLeaseCurrent: () => true,
    recover: async (_endpointId, keys, currentLease, isCurrent) => {
      await lifecycle.reconcileManaged("payments", required(registry), currentLease, isCurrent);
      if (!isCurrent()) throw new AppError("ENDPOINT_UNAVAILABLE", "managed recovery owner stopped");
      capacityPublications += 1;
      dashboardPublications += 1;
      observationPublications += 1;
      return { restored: true, restoredKeys: keys, settledKeys: [], failures: [] };
    },
    beforeShared: async () => [],
    wakeShared: async () => undefined,
    afterShared: async () => undefined,
    onSafetyFailure: () => assert.fail("stale recovery must not reach safety handling"),
    onError: () => undefined,
  });
  owner.recordFailure(key, "endpoint");

  const recovering = owner.endpointReady("local", lease);
  await resumeStarted;
  const stopping = owner.stop();
  releaseResume();
  assert.deepEqual(await recovering, { recovery: "none", sharedWake: "stale" });
  await stopping;

  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: session.mapping_id }), undefined);
  assert.equal(epochs.current("local", "thread-1", session.mapping_id), undefined);
  assert.equal(capacityPublications, 0);
  assert.equal(dashboardPublications, 0);
  assert.equal(observationPublications, 0);
});

test("managed recovery checks an existing rollout guard after validating native history", async () => {
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
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/turns/list"]);
});

test("managed recovery retry-tags only an unclassified ownership boundary", async () => {
  const { dir, registry, endpoint, native, lifecycle } = await fixture({
    initialize: async () => undefined,
    inspectIfInitialized: async () => ({ state: "unclassified", turnId: "not-classified" }),
    release: () => undefined,
  });
  await registry.createManaged("payments", { endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-durable" });
  endpoint.status = "active";
  endpoint.turns = [{ id: "not-classified", status: "inProgress" }];

  await assert.rejects(lifecycle.reconcileManaged("payments", required(registry)), (error: unknown) => {
    assert.equal((error as AppError).code, "OPERATION_UNCERTAIN");
    assert.equal((error as AppError).details?.recovery, "ownership_unclassified");
    return true;
  });
  assert.deepEqual(native.view({ endpointId: "local", threadId: "thread-1", mappingId: "mapping-durable" })?.status, "active");
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/turns/list"]);
});

test("managed recovery terminally removes a pathless mapping whose volatile thread was lost", async () => {
  const released: string[] = [];
  const { dir, registry, endpoint, epochs, lifecycle } = await fixture({
    initialize: async () => undefined,
    inspectIfInitialized: async () => ({ state: "lost" }),
    release: (identity) => { released.push(identity.mapping_id); },
  });
  await registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-pathless",
  });
  epochs.begin("local", "thread-1", "mapping-pathless", undefined, 1);

  await assert.rejects(lifecycle.reconcileManaged("payments", required(registry)), (error: unknown) => (
    error instanceof AppError && error.code === "THREAD_NOT_FOUND" && error.details?.recovery === "pathless_thread_lost"
  ));

  assert.equal(registry.get("payments"), undefined);
  assert.equal(epochs.current("local", "thread-1", "mapping-pathless"), undefined);
  assert.deepEqual(released, ["mapping-pathless"]);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read"]);
});

test("adopting reconciliation validates native cwd before resuming", async () => {
  const { dir, registry, endpoint, lifecycle } = await fixture();
  await registry.reserve("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-durable", lifecycle_state: "adopting",
  });
  endpoint.cwd = join(dir, "drifted");

  await assert.rejects(lifecycle.reconcileAdopting(), /cwd|directory/iu);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/turns/list"]);
  assert.equal(required(registry).lifecycle_state, "adopting");
});

test("adopting reconciliation rolls back a proven subscription when post-resume validation fails", async () => {
  const { dir, registry, endpoint, lifecycle } = await fixture();
  await registry.reserve("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-durable", lifecycle_state: "adopting",
  });
  endpoint.onResume = () => { endpoint.cwd = join(dir, "drifted-after-resume"); };

  await assert.rejects(lifecycle.reconcileAdopting(), /cwd|directory/iu);

  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/read", "thread/turns/list", "thread/resume", "thread/read", "thread/turns/list", "thread/unsubscribe"]);
  assert.equal(registry.get("payments"), undefined);
});

test("adopting reconciliation retains ownership until its exact rollback commits", async () => {
  const preResumeReleased: string[] = [];
  const preResume = await fixture({
    initialize: async () => undefined,
    release: (identity) => { preResumeReleased.push(identity.mapping_id); },
  });
  await preResume.registry.reserve("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: preResume.dir, mapping_id: "mapping-pre", lifecycle_state: "adopting",
  });
  preResume.endpoint.cwd = join(preResume.dir, "drifted");
  await assert.rejects(preResume.lifecycle.reconcileAdopting(), /cwd|directory/iu);
  assert.deepEqual(preResumeReleased, [], "pre-resume validation cannot release a pre-existing ownership row");
  assert.equal(required(preResume.registry).lifecycle_state, "adopting");

  for (const failure of ["unsubscribe", "remove"] as const) {
    const released: string[] = [];
    const value = await fixture({
      initialize: async () => undefined,
      release: (identity) => { released.push(identity.mapping_id); },
    });
    await value.registry.reserve("payments", {
      endpoint: "local", thread_id: "thread-1", project_dir: value.dir, mapping_id: `mapping-${failure}`, lifecycle_state: "adopting",
    });
    const registryWithFailure = value.registry as SessionRegistry & {
      promote(nickname: string, expected: RegistrySession): Promise<void>;
      removeIfMatch(nickname: string, expected: RegistrySession): Promise<boolean>;
    };
    registryWithFailure.promote = async () => { throw new Error("promotion failed after ownership initialization"); };
    if (failure === "unsubscribe") value.endpoint.unsubscribeError = new Error("unsubscribe response lost");
    else registryWithFailure.removeIfMatch = async () => false;

    await assert.rejects(value.lifecycle.reconcileAdopting(), (error: unknown) => {
      assert.equal(error instanceof AppError && error.code === "OPERATION_UNCERTAIN", true);
      return true;
    });
    assert.deepEqual(released, [], `ownership must survive ${failure} reconciliation rollback failure`);
    assert.equal(required(value.registry).lifecycle_state, "adopting");
  }
});

test("adoption workspace verification preserves endpoint failures", async () => {
  const unavailable = await fixture();
  unavailable.workspaceFailure.error = new AppError("ENDPOINT_UNAVAILABLE", "SSH process failed (exit 1)");
  await assert.rejects(unavailable.lifecycle.adopt("payments", "local", "thread-1"), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE", true);
    assert.match(String(error), /SSH process failed/u);
    return true;
  });

  const unknown = await fixture();
  const transportFailure = new Error("raw transport timeout");
  unknown.workspaceFailure.error = transportFailure;
  await assert.rejects(
    unknown.lifecycle.adopt("payments", "local", "thread-1"),
    (error: unknown) => error === transportFailure,
  );
});

test("successful remote thread/start performs no later SSH workspace checks", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "qiyan-bot-remote-policy-")));
  const userHome = join(root, "home");
  const qiyanHome = join(userHome, ".qiyan-bot");
  const assistantWorkdir = join(qiyanHome, "assistant");
  const dataDir = join(qiyanHome, "data");
  const projectDir = join(userHome, "projects", "worker");
  await Promise.all([
    mkdir(assistantWorkdir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(projectDir, { recursive: true }),
  ]);
  const localHost = new LocalWorkspaceHost(userHome);
  let projectStats = 0;
  let failAt = Number.POSITIVE_INFINITY;
  const failure = new AppError("ENDPOINT_UNAVAILABLE", "SSH process failed (exit 1)");
  const host: WorkspaceHost = {
    endpointId: "devbox",
    home: () => localHost.home(),
    lstat: async (path) => {
      if (path === projectDir && ++projectStats === failAt) throw failure;
      return localHost.lstat(path);
    },
    realpath: (path) => localHost.realpath(path),
    mkdir: (path, options) => localHost.mkdir(path, options),
    chmod: (path, mode) => localHost.chmod(path, mode),
  };
  const policy = new ProjectWorkspacePolicy({
    userHome,
    qiyanHome,
    assistantWorkdir,
    dataDir,
    registryPath: join(dataDir, "sessions.json"),
    host,
  });
  const project = await policy.prepareExisting(projectDir);
  projectStats = 0;
  failAt = 3;
  const registry = await SessionRegistry.open(join(dataDir, "sessions.json"), {
    version: 3,
    assistant: { endpoint: "local", thread_id: "assistant", project_dir: assistantWorkdir },
    sessions: {},
  });
  const endpoint = new LifecycleEndpoint("devbox");
  endpoint.cwd = projectDir;
  const db = createTestDatabase();
  const lifecycle = new SessionLifecycle(
    new AppServerPool([endpoint], { maxConcurrentTurns: 2 }),
    registry,
    new ManagedEpochStore(db),
    new NativeSessionState(),
    { now: () => 10_000 },
    new WorkspaceRouter(() => policy) as never,
    new ThreadGate(),
  );
  let dispatchStarted = false;

  await lifecycle.create("payments", "devbox", project, "operation-remote", undefined, () => { dispatchStarted = true; });

  assert.equal(dispatchStarted, true);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/start"]);
  assert.equal(required(registry).lifecycle_state, "managed");
});

test("unadopt is idle-only, unsubscribes without archive, and removes exactly one mapping", async () => {
  const { registry, endpoint, epochs, lifecycle } = await fixture();
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
  assert.ok(epochs.latest("local", "thread-1", session.mapping_id)?.endedAt);
  assert.equal(endpoint.calls.some((call) => call.method === "thread/unsubscribe"), true);
  assert.equal(endpoint.calls.some((call) => call.method === "thread/archive" || call.method === "thread/delete"), false);
});

test("unadopt treats native notLoaded status and exact read absence as already unsubscribed", async () => {
  for (const absence of ["status", "error"] as const) {
    const released: string[] = [];
    const { dir, registry, endpoint, lifecycle } = await fixture({
      initialize: async () => undefined,
      release: (identity) => { released.push(identity.mapping_id); },
    });
    await registry.createManaged("payments", {
      endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: `mapping-${absence}`,
    });
    if (absence === "status") endpoint.status = "notLoaded";
    else endpoint.readErrors.push(new JsonRpcResponseError(-32600, "thread not loaded: thread-1"));
    const checkpoints: string[] = [];

    await lifecycle.unadopt("payments", (checkpoint) => { checkpoints.push(checkpoint.step); });

    assert.equal(registry.get("payments"), undefined);
    assert.equal(endpoint.calls.some((call) => call.method === "thread/unsubscribe"), false);
    assert.deepEqual(checkpoints, ["transition_intent", "transitioned", "native_unsubscribed", "removed"]);
    assert.deepEqual(released, [`mapping-${absence}`]);
  }
});

test("unadopt accepts exact absence returned by unsubscribe but not broader failures", async () => {
  const exact = await fixture();
  await exact.registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: exact.dir, mapping_id: "mapping-exact",
  });
  exact.endpoint.unsubscribeError = new JsonRpcResponseError(-32600, "thread not loaded: thread-1");
  await exact.lifecycle.unadopt("payments");
  assert.equal(exact.registry.get("payments"), undefined);

  const broad = await fixture();
  await broad.registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: broad.dir, mapping_id: "mapping-broad",
  });
  const failure = new JsonRpcResponseError(-32000, "thread not loaded: thread-1");
  broad.endpoint.unsubscribeError = failure;
  await assert.rejects(broad.lifecycle.unadopt("payments"), (error: unknown) => error === failure);
  assert.equal(required(broad.registry).lifecycle_state, "unadopting");
});

test("direct unadoption reports uncertainty when exact registry removal loses its fence", async () => {
  const released: string[] = [];
  const value = await fixture({
    initialize: async () => undefined,
    release: (identity) => { released.push(identity.mapping_id); },
  });
  await value.registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: value.dir, mapping_id: "mapping-direct-fence",
  });
  const registryWithFailedRemoval = value.registry as SessionRegistry & {
    removeIfMatch(nickname: string, expected: RegistrySession): Promise<boolean>;
  };
  registryWithFailedRemoval.removeIfMatch = async () => false;

  await assert.rejects(value.lifecycle.unadopt("payments"), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "OPERATION_UNCERTAIN", true);
    return true;
  });

  assert.equal(required(value.registry).lifecycle_state, "unadopting");
  assert.deepEqual(released, []);
});

test("direct archive reports uncertainty without releasing ownership when exact removal loses its fence", async () => {
  const released: string[] = [];
  const value = await fixture({
    initialize: async () => undefined,
    release: (identity) => { released.push(identity.mapping_id); },
  });
  await value.registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: value.dir, mapping_id: "mapping-archive-fence",
  });
  const registryWithFailedRemoval = value.registry as SessionRegistry & {
    removeIfMatch(nickname: string, expected: RegistrySession): Promise<boolean>;
  };
  registryWithFailedRemoval.removeIfMatch = async () => false;

  await assert.rejects(value.lifecycle.archive("payments"), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "OPERATION_UNCERTAIN", true);
    return true;
  });

  assert.equal(required(value.registry).lifecycle_state, "archiving");
  assert.deepEqual(released, []);
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

test("archive clears a never-materialized (no rollout) thread without a native archive", async () => {
  // A Claude session created but never driven a turn has no transcript; thread/read throws
  // "no rollout found". Archive must still drop the dangling registry entry (previously it
  // threw at the read, leaving the session unarchivable — "durable removal not committed").
  const { registry, endpoint, lifecycle } = await fixture();
  await lifecycle.adopt("payments", "local", "thread-1");
  endpoint.status = "idle";
  endpoint.calls.length = 0;
  endpoint.readErrors.push(new JsonRpcResponseError(-32600, "no rollout found for thread id thread-1"));
  const checkpoints: string[] = [];
  await lifecycle.archive("payments", (checkpoint) => { checkpoints.push(checkpoint.step); });
  assert.equal(registry.get("payments"), undefined);
  assert.deepEqual(checkpoints, ["transition_intent", "transitioned", "native_archived", "removed"]);
  assert.equal(endpoint.calls.some((call) => call.method === "thread/archive"), false);
});

test("unadopt clears a never-materialized (no rollout) thread without unsubscribing", async () => {
  const { registry, endpoint, lifecycle } = await fixture();
  await lifecycle.adopt("payments", "local", "thread-1");
  endpoint.status = "idle";
  endpoint.calls.length = 0;
  endpoint.readErrors.push(new JsonRpcResponseError(-32600, "no rollout found for thread id thread-1"));
  await lifecycle.unadopt("payments");
  assert.equal(registry.get("payments"), undefined);
  assert.equal(endpoint.calls.some((call) => call.method === "thread/unsubscribe"), false);
});

test("removal reconciliation accepts exact absence only for unadoption", async () => {
  const unadopting = await fixture();
  await unadopting.registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: unadopting.dir, mapping_id: "mapping-unadopt",
  });
  const managed = required(unadopting.registry);
  await unadopting.registry.transition("payments", managed, "unadopting");
  const removing = required(unadopting.registry);
  unadopting.endpoint.readErrors.push(new JsonRpcResponseError(-32600, "thread not loaded: thread-1"));
  await unadopting.lifecycle.reconcileRemoval("payments", removing);
  assert.equal(unadopting.registry.get("payments"), undefined);
  assert.deepEqual(unadopting.endpoint.calls.map((call) => call.method), ["thread/read"]);

  const archiving = await fixture();
  await archiving.registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: archiving.dir, mapping_id: "mapping-archive",
  });
  const archiveManaged = required(archiving.registry);
  await archiving.registry.transition("payments", archiveManaged, "archiving");
  archiving.endpoint.archiveError = new JsonRpcResponseError(-32600, "thread not loaded: thread-1");
  const archiveError = archiving.endpoint.archiveError;
  await assert.rejects(archiving.lifecycle.reconcileRemoval("payments", required(archiving.registry)), (error: unknown) => error === archiveError);
  assert.equal(required(archiving.registry).lifecycle_state, "archiving");
});

test("removal reconciliation never releases ownership when exact registry removal loses its fence", async () => {
  const released: string[] = [];
  const value = await fixture({
    initialize: async () => undefined,
    release: (identity) => { released.push(identity.mapping_id); },
  });
  await value.registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: value.dir, mapping_id: "mapping-fenced",
  });
  const managed = required(value.registry);
  await value.registry.transition("payments", managed, "unadopting");
  const registryWithFailedRemoval = value.registry as SessionRegistry & {
    removeIfMatch(nickname: string, expected: RegistrySession): Promise<boolean>;
  };
  registryWithFailedRemoval.removeIfMatch = async () => false;

  await assert.rejects(value.lifecycle.reconcileRemoval("payments", required(value.registry)), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "OPERATION_UNCERTAIN", true);
    return true;
  });

  assert.equal(required(value.registry).lifecycle_state, "unadopting");
  assert.deepEqual(released, []);
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
