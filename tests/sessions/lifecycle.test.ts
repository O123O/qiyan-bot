import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AppServerEndpoint } from "../../src/app-server/pool.ts";
import { AppServerPool } from "../../src/app-server/pool.ts";
import { JsonRpcResponseError } from "../../src/app-server/json-rpc-client.ts";
import { isExactThreadNoRollout, isExactThreadNotLoaded } from "../../src/app-server/thread-errors.ts";
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
import { EndpointAuthenticationRequiredError } from "../../src/app-server/managed-endpoint.ts";

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
  failTurnsList = false;
  viewActiveTurnId: string | undefined;
  listError: Error | undefined;
  unsubscribeError: Error | undefined;
  archiveError: Error | undefined;
  nameError: Error | undefined;
  // Mirrors the measured app-server: thread/start writes no rollout, so resume fails until the
  // thread is materialized (by naming it, or by taking a turn). Keyed by thread id, because one
  // endpoint-wide flag would make an unrelated pre-registered mapping resume spuriously.
  unmaterializedThreads = new Set<string>();
  onResume: (() => void) | undefined;
  resumeBarrier: Promise<void> | undefined;

  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    const thread = { id: this.threadId, cwd: this.cwd, path: this.path, threadSource: this.createdThreadSource, status: { type: this.status }, turns: this.turns };
    if (method === "thread/start") {
      this.unmaterializedThreads.add(String(thread.id));
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
    if (method === "thread/turns/list") {
      if (this.failTurnsList) throw new Error("turn history must not be read");
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
    if (method === "thread/name/set") {
      if (this.nameError) throw this.nameError;
      this.unmaterializedThreads.delete(String((params as { threadId?: unknown }).threadId ?? ""));
      return {} as T;
    }
    if (method === "thread/list") {
      if (this.listError) throw this.listError;
      return {
        data: [{ ...thread, turns: [] }],
        nextCursor: null,
        backwardsCursor: null,
      } as T;
    }
    if (method === "thread/resume") {
      this.onResume?.();
      await this.resumeBarrier;
      if (this.resumeError) throw this.resumeError;
      // An unmaterialized thread has no rollout to resume from. This is the production behaviour
      // that made reconciliation reap brand-new workers, so the stub has to reproduce it or a test
      // for that bug asserts nothing.
      const resumeId = String((params as { threadId?: unknown }).threadId ?? "");
      if (this.unmaterializedThreads.has(resumeId)) {
        throw new JsonRpcResponseError(-32600, `no rollout found for thread id ${resumeId}`);
      }
      if (this.failResume) throw new Error("resume response lost");
      const resumedThread = {
        ...thread,
        id: this.resumeThreadId ?? this.threadId,
        cwd: this.cwd,
        status: { type: this.status },
        turns: this.turns,
        // A Claude endpoint names the running turn here, because a turn executes before
        // `claude` writes its user row and this response is requested without turns.
        ...(this.viewActiveTurnId === undefined ? {} : { activeTurnId: this.viewActiveTurnId }),
      };
      return {
        thread: {
          ...resumedThread,
          turns: params?.excludeTurns === true ? [] : resumedThread.turns,
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

async function fixture(options: {
  endpoints?: Pick<EndpointManager, "withWorkLease" | "runWithWorkLease">;
  beforeManagedReady?: (identity: { endpoint: string; thread_id: string; mapping_id: string }, lease?: EndpointWorkLease) => Promise<void>;
  provider?: (endpointId: string) => "codex" | "claude";
} = {}) {
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
  const pool = new AppServerPool([endpoint], {});
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
    options.endpoints === undefined ? undefined : {
      desiredState: () => "automatic",
      isClosing: () => false,
      awaitingAuthentication: () => false,
      endpointGeneration: (id: string) => pool.endpointGeneration(id),
      ...options.endpoints,
    } as never,
    options.beforeManagedReady,
    options.provider,
  );
  const setNative = (
    session: RegistrySession,
    status: "unknown" | "idle" | "active" | "error",
    activeTurnId: string | null = null,
  ) => {
    const identity = { endpointId: session.endpoint, threadId: session.thread_id, mappingId: session.mapping_id };
    const generation = pool.endpointGeneration(session.endpoint).generation;
    const existing = native.view(identity);
    if (!existing || existing.availability !== "ready" || existing.endpointGeneration !== generation) {
      native.register(identity, generation);
    }
    native.applyRefresh(native.captureRefresh(identity, generation), { status, activeTurnId });
  };
  return { db, dir, registry, endpoint, epochs, native, controls, pool, lifecycle, project, checked, gate, workspaceFailure, setNative };
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

test("adopt reserves before resume and promotes from the immediate resume response", async () => {
  const { dir, registry, endpoint, epochs, lifecycle, checked } = await fixture();
  endpoint.onResume = () => { assert.equal(required(registry).lifecycle_state, "adopting"); };
  const settings = await lifecycle.adopt("payments", "local", "thread-1");
  const session = required(registry);
  assert.deepEqual(settings, { model: "gpt-5", effort: "high" });
  assert.equal(session.project_dir, dir);
  assert.equal(session.lifecycle_state, "managed");
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/list", "thread/resume"]);
  assert.deepEqual(endpoint.calls.find((call) => call.method === "thread/resume")?.params, { threadId: "thread-1", excludeTurns: true });
  assert.deepEqual(checked, [dir, dir]);
  assert.equal(epochs.current("local", "thread-1", session.mapping_id)?.baselineTurnId, undefined);
});

test("adopt does not read turn history", async () => {
  const { registry, endpoint, lifecycle } = await fixture();
  endpoint.failTurnsList = true;

  await lifecycle.adopt("payments", "local", "thread-1");

  assert.equal(required(registry).lifecycle_state, "managed");
  assert.equal(endpoint.calls.some((call) => call.method === "thread/turns/list"), false);
});

test("adopt resumes a disk-backed notLoaded thread", async () => {
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
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/list", "thread/resume"]);
});

test("adopt resolves an active resume with one bounded latest-turn probe", async () => {
  const { registry, endpoint, lifecycle } = await fixture();
  endpoint.status = "active";
  endpoint.turns = [
    { id: "historical", status: "completed" },
    { id: "already-running", status: "inProgress" },
  ];

  await lifecycle.adopt("payments", "local", "thread-1");

  assert.equal(required(registry).lifecycle_state, "managed");
  assert.equal(endpoint.calls.some((call) => call.method === "thread/read"), false);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/list", "thread/resume", "thread/turns/list"]);
  assert.deepEqual(endpoint.calls.at(-1)?.params, {
    threadId: "thread-1",
    limit: 1,
    sortDirection: "desc",
    itemsView: "notLoaded",
  });
});

// A turn runs before `claude` writes its user row, and this response is requested without
// turns, so neither can name it. Unnamed, the identity is recorded as unresolved and probed
// for in history — where the newest turn is the previous, COMPLETED one — and that failure is
// stored as an unknown session state that fails every later operation on the worker.
test("a resume that names its running turn is not probed for, and is not left unknown", async () => {
  const { registry, endpoint, lifecycle, native } = await fixture();
  endpoint.status = "active";
  endpoint.turns = [{ id: "already-finished", status: "completed" }];
  endpoint.viewActiveTurnId = "running-now";

  await lifecycle.adopt("payments", "local", "thread-1");

  assert.equal(endpoint.calls.some((call) => call.method === "thread/turns/list"), false,
    "nothing has to go looking for a turn the endpoint already named");
  const view = native.view({
    endpointId: "local", threadId: "thread-1", mappingId: required(registry).mapping_id,
  });
  assert.equal(view?.status, "active");
  assert.equal(view?.activeTurnId, "running-now");
});

test("adopt accepts stale nonterminal history when this App Server reports idle or notLoaded", async (t) => {
  for (const status of ["idle", "notLoaded"] as const) await t.test(status, async () => {
    const { registry, endpoint, epochs, lifecycle } = await fixture();
    endpoint.status = status;
    endpoint.turns = [{ id: "nonterminal-history", status: "inProgress" }];
    endpoint.onResume = () => { endpoint.status = "idle"; };

    await lifecycle.adopt("payments", "local", "thread-1");

    const session = required(registry);
    assert.equal(session.lifecycle_state, "managed");
    assert.equal(epochs.current("local", "thread-1", session.mapping_id)?.baselineTurnId, undefined);
    assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/list", "thread/resume"]);
  });
});

test("adopt ignores interrupted historical state when live metadata is restorable", async () => {
  const { registry, endpoint, lifecycle } = await fixture();
  endpoint.status = "notLoaded";
  endpoint.turns = [{ id: "aborted-turn", status: "interrupted" }];
  endpoint.onResume = () => { endpoint.status = "idle"; };

  await lifecycle.adopt("payments", "local", "thread-1");

  assert.equal(required(registry).lifecycle_state, "managed");
});

test("adopt rejects a thread that resume proves has no durable rollout", async () => {
  const { registry, endpoint, lifecycle } = await fixture();
  endpoint.turns = [];
  endpoint.unmaterialized = true;
  endpoint.resumeError = new JsonRpcResponseError(-32600, "no rollout found for thread id thread-1");

  await assert.rejects(
    lifecycle.adopt("payments", "local", "thread-1"),
    (error: unknown) => error instanceof AppError && error.code === "THREAD_NOT_FOUND",
  );

  assert.equal(registry.get("payments"), undefined);
  assert.deepEqual(endpoint.calls.map((call) => [call.method, call.params?.includeTurns]), [
    ["thread/list", undefined],
    ["thread/resume", undefined],
  ]);
});

test("adopt uses listed metadata and validates resume before promotion", async () => {
  const { registry, endpoint, native, lifecycle } = await fixture();

  await lifecycle.adopt("payments", "local", "thread-1");

  const session = required(registry);
  assert.equal(session.lifecycle_state, "managed");
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: session.mapping_id })?.availability, "ready");
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/list", "thread/resume"]);
});

test("adopt keeps live active status when resume starts a goal continuation", async () => {
  const { registry, endpoint, epochs, native, lifecycle } = await fixture();
  endpoint.onResume = () => {
    endpoint.status = "active";
    endpoint.turns = [
      { id: "historical", status: "completed" },
      { id: "goal-continuation", status: "inProgress" },
    ];
  };

  await lifecycle.adopt("payments", "local", "thread-1");

  const session = required(registry);
  assert.equal(session.lifecycle_state, "managed");
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: session.mapping_id })?.activeTurnId, "goal-continuation");
  assert.equal(epochs.current("local", "thread-1", session.mapping_id)?.baselineTurnId, undefined);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/list", "thread/resume", "thread/turns/list"]);
});

test("adopt proves a not-loaded empty thread without a rollout is no longer restorable", async () => {
  const { registry, endpoint, lifecycle } = await fixture();
  endpoint.status = "notLoaded";
  endpoint.resumeError = new JsonRpcResponseError(-32600, "no rollout found for thread id thread-1");

  await assert.rejects(lifecycle.adopt("payments", "local", "thread-1"), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "THREAD_NOT_FOUND", true);
    assert.deepEqual((error as AppError).details, { recovery: "thread_not_durable", threadId: "thread-1" });
    return true;
  });

  assert.equal(registry.get("payments"), undefined);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/list", "thread/resume"]);
});

test("adopt validates the immediate resume response identity before promotion", async () => {
  const { registry, endpoint, lifecycle } = await fixture();
  endpoint.resumeThreadId = "wrong-thread";

  await assert.rejects(lifecycle.adopt("payments", "local", "thread-1"), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "OPERATION_UNCERTAIN", true);
    return true;
  });

  assert.equal(registry.get("payments"), undefined);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/list", "thread/resume", "thread/unsubscribe"]);
});

test("a listed adoption rolls back wrong resume identity and surfaces rollback uncertainty", async () => {
  const first = await fixture();
  first.endpoint.onResume = () => { first.endpoint.threadId = "wrong-thread"; };

  await assert.rejects(first.lifecycle.adopt("payments", "local", "thread-1"), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "OPERATION_UNCERTAIN", true);
    return true;
  });
  assert.equal(first.registry.get("payments"), undefined);
  assert.deepEqual(first.endpoint.calls.map((call) => call.method), ["thread/list", "thread/resume", "thread/unsubscribe"]);

  const second = await fixture();
  second.endpoint.onResume = () => { second.endpoint.cwd = join(second.dir, "wrong"); };
  second.endpoint.unsubscribeError = new Error("rollback response lost");
  await assert.rejects(second.lifecycle.adopt("payments", "local", "thread-1"), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "OPERATION_UNCERTAIN", true);
    assert.match(String(error), /rollback could not be confirmed/u);
    return true;
  });
});

test("a listed adoption validates source before resume and rolls back a bad resume status", async () => {
  const source = await fixture();
  await assert.rejects(source.lifecycle.adopt("payments", "local", "thread-1", () => {
    throw new AppError("OPERATION_UNCERTAIN", "recovered worker thread has the wrong creation source");
  }), /creation source/u);
  assert.equal(source.registry.get("payments"), undefined);
  assert.deepEqual(source.endpoint.calls.map((call) => call.method), ["thread/list"]);

  const active = await fixture();
  active.endpoint.onResume = () => { active.endpoint.status = "systemError"; };
  await assert.rejects(active.lifecycle.adopt("payments", "local", "thread-1"), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "SESSION_BUSY", true);
    return true;
  });
  assert.equal(active.registry.get("payments"), undefined);
  assert.deepEqual(active.endpoint.calls.map((call) => call.method), ["thread/list", "thread/resume", "thread/unsubscribe"]);
});

test("adoption rollback accepts exact unsubscribe absence but requires exact reservation removal", async () => {
  const absent = await fixture();
  absent.endpoint.resumeThreadId = "wrong-thread";
  absent.endpoint.unsubscribeError = new JsonRpcResponseError(-32600, "thread not loaded: thread-1");
  await assert.rejects(
    absent.lifecycle.adopt("payments", "local", "thread-1"),
    (error: unknown) => error instanceof AppError && error.code === "OPERATION_UNCERTAIN",
  );
  assert.equal(absent.registry.get("payments"), undefined);

  const fenced = await fixture();
  fenced.endpoint.onResume = () => { fenced.endpoint.cwd = join(fenced.dir, "wrong"); };
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

test("adopt propagates metadata-list failure without reserving or resuming", async () => {
  const { registry, endpoint, lifecycle } = await fixture();
  const error = new Error("metadata unavailable");
  endpoint.listError = error;

  await assert.rejects(lifecycle.adopt("payments", "local", "thread-1"), (actual: unknown) => actual === error);
  assert.equal(registry.get("payments"), undefined);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/list"]);
});

test("adopt rejects a bad resume status and rolls back its reservation", async () => {
  const { registry, endpoint, lifecycle } = await fixture();
  endpoint.status = "systemError";

  await assert.rejects(
    lifecycle.adopt("payments", "local", "thread-1"),
    (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY",
  );

  assert.equal(registry.get("payments"), undefined);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/list", "thread/resume", "thread/unsubscribe"]);
});

test("adopt fails closed when an active resume has no nonterminal latest turn", async () => {
  const { registry, endpoint, native, lifecycle } = await fixture();
  endpoint.onResume = () => { endpoint.status = "active"; };

  await lifecycle.adopt("payments", "local", "thread-1");

  const session = required(registry);
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: session.mapping_id })?.status, "unknown");
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: session.mapping_id })?.activeTurnId, null);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/list", "thread/resume", "thread/turns/list"]);
});

test("adopt does not let a stale resume response overwrite native completion notifications", async () => {
  const { registry, endpoint, epochs, native, lifecycle } = await fixture();
  endpoint.onResume = () => {
    const session = required(registry);
    assert.equal(session.lifecycle_state, "adopting");
    assert.equal(epochs.current("local", "thread-1", session.mapping_id)?.recoveryMode, "from_first_turn");
    epochs.recordFirstTurn("local", "thread-1", session.mapping_id, "goal-turn");
    const identity = { endpointId: "local", threadId: "thread-1", mappingId: session.mapping_id };
    const generation = native.view(identity)!.endpointGeneration;
    native.observe("local", generation, "turn/started", { threadId: "thread-1", turn: { id: "goal-turn" } });
    native.observe("local", generation, "turn/completed", { threadId: "thread-1", turn: { id: "goal-turn" } });
    endpoint.status = "active";
  };

  await lifecycle.adopt("payments", "local", "thread-1");

  const session = required(registry);
  const view = native.view({ endpointId: "local", threadId: "thread-1", mappingId: session.mapping_id });
  assert.equal(view?.status, "idle");
  assert.equal(view?.activeTurnId, null);
  assert.equal(epochs.current("local", "thread-1", session.mapping_id)?.firstTurnId, "goal-turn");
});

test("adopt fences a stale active resume response after a completion-only notification", async () => {
  const { registry, endpoint, native, lifecycle } = await fixture();
  endpoint.onResume = () => {
    const session = required(registry);
    const identity = { endpointId: "local", threadId: "thread-1", mappingId: session.mapping_id };
    const generation = native.view(identity)!.endpointGeneration;
    native.observe("local", generation, "turn/completed", { threadId: "thread-1", turn: { id: "fast-turn" } });
    endpoint.status = "active";
  };

  await lifecycle.adopt("payments", "local", "thread-1");

  const session = required(registry);
  const view = native.view({ endpointId: "local", threadId: "thread-1", mappingId: session.mapping_id });
  assert.equal(view?.status, "idle");
  assert.equal(view?.activeTurnId, null);
});

test("adopt fences a stale resume response when listed metadata was already active", async () => {
  const { registry, endpoint, native, lifecycle } = await fixture();
  endpoint.status = "active";
  endpoint.onResume = () => {
    const session = required(registry);
    const identity = { endpointId: "local", threadId: "thread-1", mappingId: session.mapping_id };
    const generation = native.view(identity)!.endpointGeneration;
    assert.equal(native.observe("local", generation, "turn/completed", {
      threadId: "thread-1", turn: { id: "fast-turn" },
    }), true);
  };

  await lifecycle.adopt("payments", "local", "thread-1");

  const session = required(registry);
  const view = native.view({ endpointId: "local", threadId: "thread-1", mappingId: session.mapping_id });
  assert.equal(view?.status, "unknown");
  assert.equal(view?.activeTurnId, null);
  assert.ok((view?.receiveSequence ?? 0) > 0);
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
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/resume"]);
  assert.deepEqual(endpoint.calls.find((call) => call.method === "thread/resume")?.params, { threadId: "thread-1", excludeTurns: true });
});

test("adopting reconciliation resumes the reserved durable mapping directly", async () => {
  const { dir, registry, endpoint, lifecycle } = await fixture();
  const adopting = {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-durable", lifecycle_state: "adopting" as const,
  };
  await registry.reserve("payments", adopting);
  await lifecycle.reconcileAdopting();

  assert.equal(required(registry).lifecycle_state, "managed");
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/resume"]);
});

test("adopting reconciliation removes a mapping that has no durable rollout", async () => {
  const { dir, registry, endpoint, epochs, native, lifecycle } = await fixture();
  const adopting = {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-gone", lifecycle_state: "adopting" as const,
  };
  await registry.reserve("payments", adopting);
  endpoint.resumeError = new JsonRpcResponseError(-32600, "no rollout found for thread id thread-1");

  await assert.rejects(
    lifecycle.reconcileAdopting(),
    (error: unknown) => error instanceof AppError && error.code === "THREAD_NOT_FOUND",
  );

  assert.equal(registry.get("payments"), undefined);
  assert.equal(epochs.current("local", "thread-1", adopting.mapping_id), undefined);
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: adopting.mapping_id }), undefined);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/resume"]);
});

test("adopting reconciliation does not read turn history", async () => {
  const { dir, registry, endpoint, lifecycle } = await fixture();
  await registry.reserve("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-no-history", lifecycle_state: "adopting",
  });
  endpoint.failTurnsList = true;

  await lifecycle.reconcileAdopting();

  assert.equal(required(registry).lifecycle_state, "managed");
  assert.equal(endpoint.calls.some((call) => call.method === "thread/read"), false);
  assert.equal(endpoint.calls.some((call) => call.method === "thread/turns/list"), false);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/resume"]);
});

test("adopting reconciliation accepts stale nonterminal history reported while notLoaded", async () => {
  const { dir, registry, endpoint, epochs, lifecycle } = await fixture();
  await registry.reserve("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-stale", lifecycle_state: "adopting",
  });
  endpoint.status = "notLoaded";
  endpoint.turns = [{ id: "nonterminal-history", status: "inProgress" }];
  endpoint.onResume = () => { endpoint.status = "idle"; };

  await lifecycle.reconcileAdopting();

  const session = required(registry);
  assert.equal(session.lifecycle_state, "managed");
  assert.equal(epochs.current("local", "thread-1", session.mapping_id)?.baselineTurnId, undefined);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/resume"]);
});

test("adopting reconciliation removes a loaded empty mapping after resume proves no rollout", async () => {
  const { dir, registry, endpoint, lifecycle } = await fixture();
  await registry.reserve("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-empty", lifecycle_state: "adopting",
  });
  endpoint.turns = [];
  endpoint.unmaterialized = true;
  endpoint.resumeError = new JsonRpcResponseError(-32600, "no rollout found for thread id thread-1");

  await assert.rejects(
    lifecycle.reconcileAdopting(),
    (error: unknown) => error instanceof AppError && error.code === "THREAD_NOT_FOUND",
  );

  assert.equal(registry.get("payments"), undefined);
  assert.deepEqual(endpoint.calls.map((call) => [call.method, call.params?.includeTurns]), [
    ["thread/resume", undefined],
  ]);
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

  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/resume"]);
  assert.equal(resumed.thread.id, "thread-1");
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: "mapping-durable" })?.availability, "ready");
  assert.equal(epochs.current("local", "thread-1", "mapping-durable")?.baselineTurnId, undefined);
  assert.equal(epochs.current("local", "thread-1", "mapping-durable")?.recoveryMode, "from_first_turn");
});

test("managed recovery supplies authoritative cwd to recreate an empty Claude thread", async () => {
  const { dir, registry, endpoint, native, lifecycle } = await fixture({
    provider: () => "claude",
  });
  await registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-empty",
  });
  endpoint.turns = [];
  endpoint.unmaterialized = true;

  const recovered = await lifecycle.reconcileManaged("payments", required(registry));

  assert.equal(recovered.thread.id, "thread-1");
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: "mapping-empty" })?.availability, "ready");
  assert.deepEqual(endpoint.calls, [{
    method: "thread/resume",
    params: { threadId: "thread-1", excludeTurns: true, cwd: dir },
  }]);
});

test("managed recovery of an idle thread resumes with turns excluded", async () => {
  const { dir, registry, endpoint, epochs, native, lifecycle } = await fixture();
  await registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-idle",
  });
  endpoint.status = "idle";
  endpoint.turns = [{ id: "t1", status: "completed" }, { id: "t2", status: "completed" }]; // has rollout history
  // A persisted epoch (as after a bot restart) means the delivery baseline is already known.
  epochs.begin("local", "thread-1", "mapping-idle", "t2", 0);

  const recovered = await lifecycle.reconcileManaged("payments", required(registry));

  assert.equal(recovered.thread.id, "thread-1");
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: "mapping-idle" })?.status, "idle");
  assert.deepEqual(endpoint.calls, [{
    method: "thread/resume",
    params: { threadId: "thread-1", excludeTurns: true },
  }]);
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
  );

  assert.equal(recovered.thread.id, "thread-1");
  assert.deepEqual(recovered.thread.turns, []);
  assert.deepEqual(endpoint.turns.map((turn) => turn.id), ["t1", "t2"]);
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: "mapping-rebound" })?.status, "idle");
  assert.deepEqual(endpoint.calls, [
    { method: "thread/resume", params: { threadId: "thread-1", excludeTurns: true } },
  ]);
});

test("managed connection recovery preserves an active turn without transferring persisted history", async () => {
  const { dir, registry, endpoint, epochs, native, lifecycle } = await fixture();
  await registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-active-rebound",
  });
  endpoint.status = "active";
  endpoint.turns = [{ id: "t1", status: "completed" }, { id: "t2", status: "inProgress" }];
  epochs.begin("local", "thread-1", "mapping-active-rebound", "t1", 0);

  const recovered = await lifecycle.reconcileManaged(
    "payments",
    required(registry),
  );

  assert.equal(recovered.thread.status.type, "active");
  assert.deepEqual(recovered.thread.turns, []);
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: "mapping-active-rebound" })?.activeTurnId, "t2");
  assert.deepEqual(endpoint.turns.map((turn) => turn.id), ["t1", "t2"]);
  assert.deepEqual(endpoint.calls, [
    { method: "thread/resume", params: { threadId: "thread-1", excludeTurns: true } },
    {
      method: "thread/turns/list",
      params: { threadId: "thread-1", limit: 1, sortDirection: "desc", itemsView: "notLoaded" },
    },
  ]);
});

test("managed connection recovery starts a future-turn epoch without reading old history", async () => {
  const { dir, registry, endpoint, epochs, native, lifecycle } = await fixture();
  await registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-empty-rebound",
  });
  endpoint.status = "idle";
  endpoint.turns = [{ id: "t1", status: "completed" }, { id: "t2", status: "completed" }];

  const recovered = await lifecycle.reconcileManaged(
    "payments",
    required(registry),
  );

  assert.equal(recovered.thread.id, "thread-1");
  assert.deepEqual(recovered.thread.turns, []);
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: "mapping-empty-rebound" })?.status, "idle");
  assert.equal(epochs.current("local", "thread-1", "mapping-empty-rebound")?.baselineTurnId, undefined);
  assert.equal(epochs.current("local", "thread-1", "mapping-empty-rebound")?.recoveryMode, "from_first_turn");
  assert.deepEqual(endpoint.calls, [
    { method: "thread/resume", params: { threadId: "thread-1", excludeTurns: true } },
  ]);
});

test("managed connection recovery handles an unmaterialized empty thread without history", async () => {
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
  );

  assert.deepEqual(recovered.thread.turns, []);
  assert.equal(epochs.current("local", "thread-1", "mapping-never-started")?.baselineTurnId, undefined);
  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: "mapping-never-started" })?.status, "idle");
});

test("Codex managed recovery removes a thread whose rollout is not durable", async () => {
  const { dir, registry, endpoint, lifecycle } = await fixture();
  await registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-live",
  });
  endpoint.turns = [];
  endpoint.unmaterialized = true;
  endpoint.resumeError = new JsonRpcResponseError(-32600, "no rollout found for thread id thread-1");

  await assert.rejects(
    lifecycle.reconcileManaged("payments", required(registry)),
    (error: unknown) => error instanceof AppError && error.code === "THREAD_NOT_FOUND",
  );
  assert.equal(registry.get("payments"), undefined);
});

test("create recovery removes an exact managed mapping whose native thread is not restorable", async () => {
  const { dir, registry, endpoint, epochs, native, lifecycle } = await fixture();
  const session = {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-phantom",
  };
  await registry.createManaged("payments", session);
  epochs.begin(session.endpoint, session.thread_id, session.mapping_id, undefined, 1);
  native.register({ endpointId: session.endpoint, threadId: session.thread_id, mappingId: session.mapping_id }, 1);
  endpoint.resumeError = new JsonRpcResponseError(-32600, "no rollout found for thread id thread-1");

  await assert.rejects(
    lifecycle.reconcileManaged("payments", required(registry)),
    (error: unknown) => error instanceof AppError && error.code === "THREAD_NOT_FOUND"
      && error.details?.recovery === "thread_not_durable",
  );

  assert.equal(registry.get("payments"), undefined);
  assert.equal(epochs.current(session.endpoint, session.thread_id, session.mapping_id), undefined);
  assert.equal(native.view({ endpointId: session.endpoint, threadId: session.thread_id, mappingId: session.mapping_id }), undefined);
});

test("managed recovery rejects a wrong immediate resume identity without publishing live state", async () => {
  const { dir, registry, endpoint, native, controls, lifecycle } = await fixture();
  await registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-durable",
  });
  endpoint.resumeThreadId = "wrong-thread";

  await assert.rejects(lifecycle.reconcileManaged(
    "payments", required(registry),
  ), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "OPERATION_UNCERTAIN", true);
    return true;
  });

  assert.equal(native.view({ endpointId: "local", threadId: "thread-1", mappingId: "mapping-durable" }), undefined);
  assert.equal(controls.goalControl("local", "thread-1", "mapping-durable").known, false);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/resume"]);
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
  const { dir, registry, endpoint, epochs, native, lifecycle } = await fixture({ endpoints });
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
      await lifecycle.reconcileManaged(
        "payments", required(registry), currentLease, isCurrent,
      );
      if (!isCurrent()) throw new AppError("ENDPOINT_UNAVAILABLE", "managed recovery owner stopped");
      capacityPublications += 1;
      dashboardPublications += 1;
      observationPublications += 1;
      return { restored: true, restoredKeys: keys, settledKeys: [], failures: [] };
    },
    wakeShared: async () => undefined,
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

test("adopting reconciliation validates native cwd returned by resume", async () => {
  const { dir, registry, endpoint, lifecycle } = await fixture();
  await registry.reserve("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-durable", lifecycle_state: "adopting",
  });
  endpoint.cwd = join(dir, "drifted");

  await assert.rejects(lifecycle.reconcileAdopting(), /cwd|directory/iu);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/resume", "thread/unsubscribe"]);
  assert.equal(registry.get("payments"), undefined);
});

test("adopting reconciliation rolls back a proven subscription when post-resume validation fails", async () => {
  const { dir, registry, endpoint, lifecycle } = await fixture();
  await registry.reserve("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-durable", lifecycle_state: "adopting",
  });
  endpoint.onResume = () => { endpoint.cwd = join(dir, "drifted-after-resume"); };

  await assert.rejects(lifecycle.reconcileAdopting(), /cwd|directory/iu);

  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/resume", "thread/unsubscribe"]);
  assert.equal(registry.get("payments"), undefined);
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
    new AppServerPool([endpoint], {}),
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
  // thread/name/set is what materializes the rollout; the property this test guards is that no
  // workspace check follows the start, and none does.
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/start", "thread/name/set"]);
  assert.equal(required(registry).lifecycle_state, "managed");
});

test("unadopt is idle-only, unsubscribes without archive, and removes exactly one mapping", async () => {
  const { registry, endpoint, epochs, lifecycle, setNative } = await fixture();
  await lifecycle.adopt("payments", "local", "thread-1");
  const session = required(registry);
  endpoint.status = "active";
  setNative(session, "active", "active-turn");
  endpoint.calls.length = 0;
  endpoint.failTurnsList = true;
  await assert.rejects(lifecycle.unadopt("payments"), (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY");
  assert.equal(required(registry).lifecycle_state, "managed");
  assert.equal(endpoint.calls.some((call) => call.method === "thread/unsubscribe"), false);

  endpoint.status = "idle";
  setNative(session, "idle");
  endpoint.calls.length = 0;
  const checkpoints: string[] = [];
  await lifecycle.unadopt("payments", (checkpoint) => { checkpoints.push(checkpoint.step); });
  assert.equal(registry.get("payments"), undefined);
  assert.deepEqual(checkpoints, ["transition_intent", "transitioned", "native_unsubscribed", "removed"]);
  assert.ok(epochs.latest("local", "thread-1", session.mapping_id)?.endedAt);
  assert.equal(endpoint.calls.some((call) => call.method === "thread/unsubscribe"), true);
  assert.equal(endpoint.calls.some((call) => call.method === "thread/archive" || call.method === "thread/delete"), false);
});

// Releasing a session needs one fact: no turn is running. An error view carries that by
// construction, and #45 already opened this path for an unreachable endpoint -- but a REACHABLE
// endpoint whose session had failed one turn was still refused, which is what left a worker with
// no escape hatch at all on 2026-08-31. An active turn must still refuse.
test("unadopt releases an errored session but still refuses an active one", async () => {
  const { registry, endpoint, lifecycle, setNative } = await fixture();
  await lifecycle.adopt("payments", "local", "thread-1");
  const session = required(registry);

  setNative(session, "active", "active-turn");
  await assert.rejects(lifecycle.unadopt("payments"),
    (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY");
  assert.equal(required(registry).lifecycle_state, "managed", "an active turn is still protected");

  endpoint.status = "idle";
  setNative(session, "error");
  endpoint.calls.length = 0;
  await lifecycle.unadopt("payments");
  assert.equal(registry.get("payments"), undefined, "the errored session was releasable");
  assert.equal(endpoint.calls.some((call) => call.method === "thread/unsubscribe"), true);
});

// requireCurrentNativeIdle has two callers, so relaxing it for unadopt relaxed archive too.
// Stated and pinned rather than left as an unremarked consequence.
test("archive also releases an errored session but still refuses an active one", async () => {
  const { registry, endpoint, lifecycle, setNative } = await fixture();
  await lifecycle.adopt("payments", "local", "thread-1");
  const session = required(registry);

  setNative(session, "active", "active-turn");
  await assert.rejects(lifecycle.archive("payments"),
    (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY");
  assert.equal(required(registry).lifecycle_state, "managed");

  endpoint.status = "idle";
  setNative(session, "error");
  await lifecycle.archive("payments");
  assert.equal(registry.get("payments"), undefined, "an errored session can be archived");
});

test("unadopt accepts exact native absence from unsubscribe", async () => {
  for (const absence of ["notLoaded", "noRollout"] as const) {
    const { dir, registry, endpoint, lifecycle, setNative } = await fixture();
    await registry.createManaged("payments", {
      endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: `mapping-${absence}`,
    });
    const session = required(registry);
    setNative(session, "idle");
    endpoint.unsubscribeError = new JsonRpcResponseError(
      -32600,
      absence === "notLoaded" ? "thread not loaded: thread-1" : "no rollout found for thread id thread-1",
    );
    const checkpoints: string[] = [];

    await lifecycle.unadopt("payments", (checkpoint) => { checkpoints.push(checkpoint.step); });

    assert.equal(registry.get("payments"), undefined);
    assert.equal(endpoint.calls.some((call) => call.method === "thread/unsubscribe"), true);
    assert.deepEqual(checkpoints, ["transition_intent", "transitioned", "native_unsubscribed", "removed"]);
  }
});

test("unadopt accepts exact absence returned by unsubscribe but not broader failures", async () => {
  const exact = await fixture();
  await exact.registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: exact.dir, mapping_id: "mapping-exact",
  });
  exact.setNative(required(exact.registry), "idle");
  exact.endpoint.unsubscribeError = new JsonRpcResponseError(-32600, "thread not loaded: thread-1");
  await exact.lifecycle.unadopt("payments");
  assert.equal(exact.registry.get("payments"), undefined);

  const broad = await fixture();
  await broad.registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: broad.dir, mapping_id: "mapping-broad",
  });
  broad.setNative(required(broad.registry), "idle");
  const failure = new JsonRpcResponseError(-32000, "thread not loaded: thread-1");
  broad.endpoint.unsubscribeError = failure;
  await assert.rejects(broad.lifecycle.unadopt("payments"), (error: unknown) => error === failure);
  assert.equal(required(broad.registry).lifecycle_state, "unadopting");
});

test("direct unadoption reports uncertainty when exact registry removal loses its fence", async () => {
  const value = await fixture();
  await value.registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: value.dir, mapping_id: "mapping-direct-fence",
  });
  value.setNative(required(value.registry), "idle");
  const registryWithFailedRemoval = value.registry as SessionRegistry & {
    removeIfMatch(nickname: string, expected: RegistrySession): Promise<boolean>;
  };
  registryWithFailedRemoval.removeIfMatch = async () => false;

  await assert.rejects(value.lifecycle.unadopt("payments"), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "OPERATION_UNCERTAIN", true);
    return true;
  });

  assert.equal(required(value.registry).lifecycle_state, "unadopting");
});

test("archive is idle-only, invokes native archive, removes the mapping, and never deletes", async () => {
  const { registry, endpoint, lifecycle, setNative } = await fixture();
  await lifecycle.adopt("payments", "local", "thread-1");
  const session = required(registry);
  endpoint.status = "active";
  setNative(session, "active", "active-turn");
  endpoint.calls.length = 0;
  endpoint.failTurnsList = true;
  await assert.rejects(lifecycle.archive("payments"), (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY");
  assert.equal(required(registry).lifecycle_state, "managed");

  endpoint.status = "idle";
  setNative(session, "idle");
  endpoint.calls.length = 0;
  const checkpoints: string[] = [];
  await lifecycle.archive("payments", (checkpoint) => { checkpoints.push(checkpoint.step); });
  assert.equal(registry.get("payments"), undefined);
  assert.deepEqual(checkpoints, ["transition_intent", "transitioned", "native_archived", "removed"]);
  assert.equal(endpoint.calls.some((call) => call.method === "thread/archive"), true);
  assert.equal(endpoint.calls.some((call) => call.method === "thread/delete"), false);
});

test("archive accepts exact no-rollout evidence from the native archive", async () => {
  const { registry, endpoint, lifecycle } = await fixture();
  await lifecycle.adopt("payments", "local", "thread-1");
  endpoint.status = "idle";
  endpoint.calls.length = 0;
  endpoint.archiveError = new JsonRpcResponseError(-32600, "no rollout found for thread id thread-1");
  const checkpoints: string[] = [];
  await lifecycle.archive("payments", (checkpoint) => { checkpoints.push(checkpoint.step); });
  assert.equal(registry.get("payments"), undefined);
  assert.deepEqual(checkpoints, ["transition_intent", "transitioned", "native_archived", "removed"]);
  assert.equal(endpoint.calls.some((call) => call.method === "thread/archive"), true);
});

test("archive completes when a loaded empty thread reports no rollout during the native archive", async () => {
  const { registry, endpoint, lifecycle } = await fixture();
  await lifecycle.adopt("payments", "local", "thread-1");
  endpoint.status = "idle";
  endpoint.calls.length = 0;
  endpoint.archiveError = new JsonRpcResponseError(-32600, "no rollout found for thread id thread-1");
  const checkpoints: string[] = [];

  await lifecycle.archive("payments", (checkpoint) => { checkpoints.push(checkpoint.step); });

  assert.equal(registry.get("payments"), undefined);
  assert.deepEqual(checkpoints, ["transition_intent", "transitioned", "native_archived", "removed"]);
  assert.deepEqual(endpoint.calls.map((call) => call.method), ["thread/archive"]);
});

test("unadopt clears a never-materialized thread after exact no-rollout unsubscribe evidence", async () => {
  const { registry, endpoint, lifecycle } = await fixture();
  await lifecycle.adopt("payments", "local", "thread-1");
  endpoint.status = "idle";
  endpoint.calls.length = 0;
  endpoint.unsubscribeError = new JsonRpcResponseError(-32600, "no rollout found for thread id thread-1");
  await lifecycle.unadopt("payments");
  assert.equal(registry.get("payments"), undefined);
  assert.equal(endpoint.calls.some((call) => call.method === "thread/unsubscribe"), true);
});

test("removal reconciliation confirms absence or reloads before archiving", async () => {
  const unadopting = await fixture();
  await unadopting.registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: unadopting.dir, mapping_id: "mapping-unadopt",
  });
  const managed = required(unadopting.registry);
  await unadopting.registry.transition("payments", managed, "unadopting");
  const removing = required(unadopting.registry);
  unadopting.endpoint.failTurnsList = true;
  unadopting.endpoint.unsubscribeError = new JsonRpcResponseError(-32600, "thread not loaded: thread-1");
  await unadopting.lifecycle.reconcileRemoval("payments", removing);
  assert.equal(unadopting.registry.get("payments"), undefined);
  assert.deepEqual(unadopting.endpoint.calls.map((call) => call.method), ["thread/unsubscribe"]);

  const archiving = await fixture();
  await archiving.registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: archiving.dir, mapping_id: "mapping-archive",
  });
  const archiveManaged = required(archiving.registry);
  await archiving.registry.transition("payments", archiveManaged, "archiving");
  archiving.endpoint.archiveError = new JsonRpcResponseError(-32600, "thread not loaded: thread-1");
  archiving.endpoint.onResume = () => { archiving.endpoint.archiveError = undefined; };
  await archiving.lifecycle.reconcileRemoval("payments", required(archiving.registry));
  assert.equal(archiving.registry.get("payments"), undefined);
  assert.deepEqual(archiving.endpoint.calls.map((call) => call.method), ["thread/archive", "thread/resume", "thread/archive"]);

  const absent = await fixture();
  await absent.registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: absent.dir, mapping_id: "mapping-archive-absent",
  });
  const absentManaged = required(absent.registry);
  await absent.registry.transition("payments", absentManaged, "archiving");
  absent.endpoint.archiveError = new JsonRpcResponseError(-32600, "no rollout found for thread id thread-1");
  await absent.lifecycle.reconcileRemoval("payments", required(absent.registry));
  assert.equal(absent.registry.get("payments"), undefined);
  assert.deepEqual(absent.endpoint.calls.map((call) => call.method), ["thread/archive"]);

  const coldAbsent = await fixture();
  await coldAbsent.registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: coldAbsent.dir, mapping_id: "mapping-archive-cold-absent",
  });
  const coldAbsentManaged = required(coldAbsent.registry);
  await coldAbsent.registry.transition("payments", coldAbsentManaged, "archiving");
  coldAbsent.endpoint.archiveError = new JsonRpcResponseError(-32600, "thread not loaded: thread-1");
  coldAbsent.endpoint.resumeError = new JsonRpcResponseError(-32600, "no rollout found for thread id thread-1");
  await coldAbsent.lifecycle.reconcileRemoval("payments", required(coldAbsent.registry));
  assert.equal(coldAbsent.registry.get("payments"), undefined);
  assert.deepEqual(coldAbsent.endpoint.calls.map((call) => call.method), ["thread/archive", "thread/resume"]);
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
    endpointGeneration: 1,
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
  const { dir, registry, endpoint, lifecycle, setNative } = await fixture({ endpoints });
  await registry.createManaged("payments", {
    endpoint: "local", thread_id: "thread-1", project_dir: dir, mapping_id: "mapping-1",
  });
  setNative(required(registry), "idle");

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

// Unadopt releases a session without archiving its thread or touching project files, so it is
// bookkeeping -- yet it took a work lease on the session's endpoint and could not run at all while
// the host was unreachable. A cluster that goes down for maintenance (or for good) then leaves
// entries that can never be removed. Seen with two workers on a cluster whose SSH was refusing auth.
test("unadopt releases a session whose endpoint cannot be reached", async () => {
  const unreachable = new AppError("ENDPOINT_UNAVAILABLE", "endpoint is unreachable: local");
  const { registry, endpoint, lifecycle } = await fixture({
    endpoints: {
      withWorkLease: async () => { throw unreachable; },
      runWithWorkLease: async () => { throw unreachable; },
      // The endpoint's own state is what proves unreachability; the error only raises the question.
      endpointGeneration: () => ({ endpoint: { state: "unavailable" }, generation: 1 }),
    } as never,
  });
  await registry.createManaged("payments", { endpoint: "local", thread_id: "thread-1", project_dir: "/projects/payments", mapping_id: "mapping-unreachable" });
  endpoint.calls.length = 0;

  const checkpoints: string[] = [];
  await lifecycle.unadopt("payments", (checkpoint) => { checkpoints.push(checkpoint.step); });

  assert.equal(registry.get("payments"), undefined, "the mapping is released even though the host never answered");
  // No native_unsubscribed step: there is no connection to unsubscribe from, and claiming one
  // would assert something about the host that was never true. No `transitioned` step either --
  // removal is a single durable write, so a crash mid-release leaves the session `managed` and
  // recovery retires it as no-effect, instead of stranding an `unadopting` row that would fence
  // every later restart of the endpoint.
  assert.deepEqual(checkpoints, ["transition_intent", "removed"]);
  assert.equal(endpoint.calls.length, 0, "an unreachable endpoint is never called");
});

// The fallback must be reserved for an unreachable ENDPOINT. Work inside the lease can raise the
// same error code -- an idleness read on a reachable host that reports unknown state does exactly
// that -- and treating it as unreachable would drop the idle check on a session that may be running.
test("unadopt still refuses when the endpoint answers but the session is not idle", async () => {
  const { registry, lifecycle, endpoint, setNative } = await fixture();
  await lifecycle.adopt("payments", "local", "thread-1");
  const session = required(registry);
  endpoint.status = "active";
  setNative(session, "active", "active-turn");
  endpoint.failTurnsList = true;

  await assert.rejects(lifecycle.unadopt("payments"),
    (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY");
  assert.equal(required(registry).lifecycle_state, "managed", "a busy session is left exactly as it was");
});

// An attempt that lost its endpoint mid-transition leaves the session in `unadopting`. That must be
// completable, not stranded: requireManaged alone would refuse it forever.
test("unadopt completes a session already left part-way through", async () => {
  const unreachable = new AppError("ENDPOINT_UNAVAILABLE", "endpoint is unreachable: local");
  const { registry, lifecycle } = await fixture({
    endpoints: {
      withWorkLease: async () => { throw unreachable; },
      runWithWorkLease: async () => { throw unreachable; },
      // The endpoint's own state is what proves unreachability; the error only raises the question.
      endpointGeneration: () => ({ endpoint: { state: "unavailable" }, generation: 1 }),
    } as never,
  });
  await registry.createManaged("payments", { endpoint: "local", thread_id: "thread-1", project_dir: "/projects/payments", mapping_id: "mapping-unreachable" });
  await registry.transition("payments", required(registry), "unadopting");
  assert.equal(required(registry).lifecycle_state, "unadopting");

  await lifecycle.unadopt("payments");
  assert.equal(registry.get("payments"), undefined);
});

// The `entered` guard, pinned. A reachable endpoint whose native state is unknown raises the SAME
// ENDPOINT_UNAVAILABLE code as a host that never answered -- requireCurrentNativeIdle does exactly
// that. Classifying on the code alone would fall back and release a session that may be mid-turn on
// a host we can still talk to. Only failing to reach the endpoint at all may take the local path.
test("unadopt does not release when the endpoint answers but native state is unknown", async () => {
  const { registry, lifecycle, setNative } = await fixture();
  await lifecycle.adopt("payments", "local", "thread-1");
  // Reachable endpoint, but the native session reports unknown -- the shape that made a live
  // worker unreadable earlier, where the host answered and the thread state did not.
  setNative(required(registry), "unknown");

  await assert.rejects(lifecycle.unadopt("payments"),
    (error: unknown) => error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE");
  assert.equal(required(registry).lifecycle_state, "managed",
    "an unknown-but-reachable session is left registered, not silently released");
});

// The error code alone cannot decide this. withWorkLease raises ENDPOINT_UNAVAILABLE for a manager
// shutting down, for an endpoint deliberately drained, and for a generation that moved mid-acquire
// -- the last two describe a HEALTHY host. A concurrent restart drains before it checks idleness,
// so an unadopt racing one would otherwise release a running session's mapping, and the relay would
// then discard that turn's answer. The endpoint's own state is what settles it.
test("unadopt refuses a drained endpoint, which is healthy despite the same error code", async () => {
  const drained = new AppError("ENDPOINT_UNAVAILABLE", "endpoint is draining: local");
  const { registry, lifecycle } = await fixture({
    endpoints: {
      withWorkLease: async () => { throw drained; },
      runWithWorkLease: async () => { throw drained; },
      desiredState: () => "draining",
      endpointGeneration: () => ({ endpoint: { state: "ready" }, generation: 1 }),
    } as never,
  });
  await registry.createManaged("payments", { endpoint: "local", thread_id: "thread-1", project_dir: "/projects/payments", mapping_id: "mapping-drained" });

  await assert.rejects(lifecycle.unadopt("payments"),
    (error: unknown) => error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE");
  assert.equal(required(registry).lifecycle_state, "managed", "a drained endpoint is not an absent one");
});

// A caller-supplied lease never runs ensureReady, so a failure there means the LEASE is stale, not
// that the host is gone. Releasing locally on that would be a release against a reachable endpoint.
test("unadopt refuses to release locally when given a stale caller lease", async () => {
  const stale = new AppError("ENDPOINT_UNAVAILABLE", "invalid endpoint work lease");
  const { registry, lifecycle } = await fixture({
    endpoints: {
      withWorkLease: async () => { throw stale; },
      runWithWorkLease: async () => { throw stale; },
      endpointGeneration: () => ({ endpoint: { state: "unavailable" }, generation: 1 }),
    } as never,
  });
  await registry.createManaged("payments", { endpoint: "local", thread_id: "thread-1", project_dir: "/projects/payments", mapping_id: "mapping-lease" });

  await assert.rejects(
    lifecycle.unadopt("payments", undefined, { endpointId: "local", endpointGeneration: 1 } as never),
    (error: unknown) => error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE");
  assert.equal(required(registry).lifecycle_state, "managed");
});

// A concurrent archive claims the mapping WHILE our lease attempt is failing -- after the initial
// state check has already passed. Removing it then would retire a thread that was never archived,
// and settle the archive's own recovery as though it had succeeded. The stub performs the
// transition mid-attempt, which is the only way to reach the re-check inside the gate.
test("unadopt refuses a mapping a concurrent archive claims mid-attempt", async () => {
  const unreachable = new AppError("ENDPOINT_UNAVAILABLE", "endpoint is unreachable: local");
  let onLeaseAttempt: () => Promise<void> = async () => {};
  const { registry, lifecycle } = await fixture({
    endpoints: {
      withWorkLease: async () => { await onLeaseAttempt(); throw unreachable; },
      runWithWorkLease: async () => { await onLeaseAttempt(); throw unreachable; },
      endpointGeneration: () => ({ endpoint: { state: "unavailable" }, generation: 1 }),
    } as never,
  });
  await registry.createManaged("payments", { endpoint: "local", thread_id: "thread-1", project_dir: "/projects/payments", mapping_id: "mapping-archiving" });
  onLeaseAttempt = async () => { await registry.transition("payments", required(registry), "archiving"); };

  await assert.rejects(lifecycle.unadopt("payments"),
    (error: unknown) => error instanceof AppError && error.code === "OPERATION_CONFLICT");
  assert.equal(required(registry).lifecycle_state, "archiving", "the archive's claim is left intact");
});

// Shutdown closes every connection, so each endpoint reports not-ready. That is us stopping, not
// the host vanishing, and it must not licence a durable removal during teardown -- the distinction
// this guard exists to make is exactly the one that disappears once connections are closed.
test("unadopt refuses during shutdown, when every endpoint looks not-ready", async () => {
  const stopping = new AppError("ENDPOINT_UNAVAILABLE", "endpoint manager is shutting down");
  const { registry, lifecycle } = await fixture({
    endpoints: {
      withWorkLease: async () => { throw stopping; },
      runWithWorkLease: async () => { throw stopping; },
      isClosing: () => true,
      endpointGeneration: () => ({ endpoint: { state: "stopped" }, generation: 1 }),
    } as never,
  });
  await registry.createManaged("payments", { endpoint: "local", thread_id: "thread-1", project_dir: "/projects/payments", mapping_id: "mapping-closing" });

  await assert.rejects(lifecycle.unadopt("payments"),
    (error: unknown) => error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE");
  assert.equal(required(registry).lifecycle_state, "managed", "teardown is not absence");
});

// Ordering: the registry write commits before the epoch is ended. Recovery keeps a session whose
// removal did not commit, and an epoch ended ahead of that write would leave that kept session
// unable to deliver at all -- the relay requires a current epoch. Forcing the epoch write to throw
// is what makes the order observable: the mapping is gone only if it was removed first.
test("unadopt commits the removal before ending the epoch", async () => {
  const unreachable = new AppError("ENDPOINT_UNAVAILABLE", "endpoint is unreachable: local");
  const { registry, lifecycle, epochs } = await fixture({
    endpoints: {
      withWorkLease: async () => { throw unreachable; },
      runWithWorkLease: async () => { throw unreachable; },
      endpointGeneration: () => ({ endpoint: { state: "unavailable" }, generation: 1 }),
    } as never,
  });
  await registry.createManaged("payments", { endpoint: "local", thread_id: "thread-1", project_dir: "/projects/payments", mapping_id: "mapping-order" });
  (epochs as { end: unknown }).end = () => { throw new Error("epoch store unavailable"); };

  await assert.rejects(lifecycle.unadopt("payments"), /epoch store unavailable/u);
  assert.equal(registry.get("payments"), undefined,
    "the mapping was already removed, so the epoch write came after it");
});

// Codex authentication expiring raises CONFIGURATION_ERROR, not ENDPOINT_UNAVAILABLE, and is thrown
// during start() so the connection never reaches ready. Deliberately re-admitted after a review
// found the earlier version had stopped covering it, so it gets a test rather than an assumption.
test("unadopt releases when the endpoint needs authentication it cannot get", async () => {
  const { registry, lifecycle } = await fixture({
    endpoints: {
      withWorkLease: async () => { throw new EndpointAuthenticationRequiredError("local"); },
      runWithWorkLease: async () => { throw new EndpointAuthenticationRequiredError("local"); },
      endpointGeneration: () => ({ endpoint: { state: "unavailable" }, generation: 1 }),
    } as never,
  });
  await registry.createManaged("payments", { endpoint: "local", thread_id: "thread-1", project_dir: "/projects/payments", mapping_id: "mapping-auth" });

  const released = await lifecycle.unadopt("payments");
  assert.equal(registry.get("payments"), undefined);
  assert.deepEqual(released, { endpointUnreachable: true }, "the caller is told idleness was never proven");
});

// The bug this closes: thread/start writes NO rollout -- measured against a live app-server -- and
// a Codex rollout only appears at the first turn. Until then thread/resume fails with "no rollout",
// which managed reconciliation reads as an unrestorable thread and removes the mapping for. A
// worker created and not yet used was therefore deleted by the next reconnect: created, healthy,
// gone. Naming the thread writes the rollout immediately, so the window never opens.
test("a created worker is materialized, so reconciliation can resume it before first use", async () => {
  const { dir, registry, endpoint, lifecycle, project } = await fixture();
  await lifecycle.create("payments", "local", project, "operation-1");
  const named = endpoint.calls.find((call) => call.method === "thread/name/set");
  assert.ok(named, "creation names the thread, which is what writes the rollout");
  assert.equal((named.params as { name?: string }).name, "payments");

  // The consequence that matters: a reconcile immediately after creation resumes rather than reaps.
  endpoint.calls.length = 0;
  const resumed = await lifecycle.reconcileManaged("payments", required(registry));
  assert.equal(resumed.thread.id, required(registry).thread_id);
  assert.equal(required(registry).lifecycle_state, "managed", "the brand-new worker survives");
  assert.equal(dir.length > 0, true);
});

// Materializing is a courtesy, not a precondition. An endpoint that cannot name a thread should
// still produce a worker -- refusing to create one because a label failed would be worse than the
// window this closes.
test("creation still succeeds when the endpoint cannot name the thread, and says so", async () => {
  const { registry, endpoint, lifecycle, project } = await fixture();
  endpoint.nameError = new JsonRpcResponseError(-32601, "unknown method thread/name/set");
  let warned = 0;

  await lifecycle.create("payments", "local", project, "operation-1", undefined, undefined,
    undefined, undefined, () => { warned += 1; });

  assert.equal(required(registry).lifecycle_state, "managed");
  // Not silent: this worker was born into the unresumable window, which is the one warning that
  // predicts the loss. Note the failure can itself be "no rollout found for thread id ...", the
  // same signal reconciliation later reaps on -- swallowing it is how this survived two incidents.
  assert.equal(warned, 1, "a worker that could not be materialized is reported");
});

// Claude refuses thread/name/set deliberately: renaming there needs a host protocol bump, and its
// resume recreates an unmaterialized thread anyway, so it never had this window. Calling it would
// be a guaranteed-to-throw round trip whose refusal is then swallowed -- exactly the "cannot tell
// unsupported from a silent no-op" ambiguity that refusal exists to prevent.
test("a Claude worker is created without attempting to name its thread", async () => {
  const { registry, endpoint, lifecycle, project } = await fixture({ provider: () => "claude" });
  let warned = 0;

  await lifecycle.create("payments", "local", project, "operation-1", undefined, undefined,
    undefined, undefined, () => { warned += 1; });

  assert.equal(required(registry).lifecycle_state, "managed");
  assert.equal(endpoint.calls.some((call) => call.method === "thread/name/set"), false,
    "no round trip to a method this provider refuses");
  assert.equal(warned, 0, "and no warning, because nothing needed materializing");
});
