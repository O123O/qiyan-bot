import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatStartupError } from "../../src/cli.ts";
import { activateCoordinatorProfileIdentity, listCoordinatorThreadCandidates, resumeCoordinatorIdentity } from "../../src/coordinator/identity.ts";
import { AppError } from "../../src/core/errors.ts";
import { SessionRegistry } from "../../src/registry/session-registry.ts";

test("a legacy local coordinator mapping migrates atomically after exact resume verification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coordinator-identity-"));
  const path = join(dir, "sessions.json");
  const registry = await SessionRegistry.open(path, {
    version: 1,
    coordinator: { endpoint: "local", thread_id: "legacy-thread", project_dir: dir },
    sessions: {},
  });
  const calls: Array<{ method: string; params: any }> = [];
  const endpoint = {
    id: "coordinator-local",
    request: async <T>(method: string, params: any) => {
      calls.push({ method, params });
      return { thread: { id: "legacy-thread", cwd: dir, status: { type: "idle" } } } as T;
    },
  };
  const resumed = await resumeCoordinatorIdentity({ registry, endpoint, legacyEndpointId: "local", coordinatorDir: dir, sandboxMode: "workspace-write", config: {} });
  assert.deepEqual(resumed, { threadId: "legacy-thread", nativeStatus: "idle" });
  assert.equal(calls[0]?.method, "thread/resume");
  assert.equal(calls[0]?.params.threadId, "legacy-thread");
  assert.equal(JSON.parse(await readFile(path, "utf8")).coordinator.endpoint, "coordinator-local");
  assert.equal(JSON.parse(await readFile(`${path}.last-good`, "utf8")).coordinator.endpoint, "coordinator-local");
});

test("legacy coordinator migration does not rewrite identity when resumed cwd differs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coordinator-identity-bad-"));
  const other = await mkdtemp(join(tmpdir(), "coordinator-identity-other-"));
  const path = join(dir, "sessions.json");
  const registry = await SessionRegistry.open(path, {
    version: 1,
    coordinator: { endpoint: "local", thread_id: "legacy-thread", project_dir: dir },
    sessions: {},
  });
  await assert.rejects(resumeCoordinatorIdentity({
    registry,
    endpoint: {
      id: "coordinator-local",
      request: async <T>() => ({ thread: { id: "legacy-thread", cwd: other, status: { type: "idle" } } } as T),
    },
    legacyEndpointId: "local",
    coordinatorDir: dir,
    sandboxMode: "workspace-write",
    config: {},
  }), /working directory/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).coordinator.endpoint, "local");
});

test("configured coordinator directory mismatch is a safe startup error before app-server access", async () => {
  const registered = await mkdtemp(join(tmpdir(), "coordinator-identity-registered-"));
  const configured = await mkdtemp(join(tmpdir(), "coordinator-identity-configured-"));
  const path = join(registered, "sessions.json");
  const registry = await SessionRegistry.open(path, {
    version: 1,
    coordinator: { endpoint: "coordinator-local", thread_id: "thread", project_dir: registered },
    sessions: {},
  });
  let requests = 0;
  let failure: unknown;
  try {
    await resumeCoordinatorIdentity({
      registry,
      endpoint: { id: "coordinator-local", request: async <T>() => { requests += 1; return {} as T; } },
      legacyEndpointId: "local",
      coordinatorDir: configured,
      sandboxMode: "workspace-write",
      config: {},
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof AppError);
  assert.equal(failure.code, "CONFIGURATION_ERROR");
  assert.match(formatStartupError(failure), new RegExp(configured.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.equal(requests, 0);
});

test("first profile activation validates, captures a baseline, resets only coordinator, then marks", async () => {
  const root = await mkdtemp(join(tmpdir(), "coordinator-profile-activation-"));
  const coordinatorDir = join(root, "coordinator");
  const projectOne = join(root, "one");
  const projectTwo = join(root, "two");
  await Promise.all([mkdir(coordinatorDir), mkdir(projectOne), mkdir(projectTwo)]);
  const path = join(root, "sessions.json");
  const sessions = {
    one: { endpoint: "local", thread_id: "one-thread", project_dir: projectOne },
    two: { endpoint: "local", thread_id: "two-thread", project_dir: projectTwo },
  };
  const registry = await SessionRegistry.open(path, {
    version: 1,
    coordinator: { endpoint: "coordinator-local", thread_id: "legacy", project_dir: coordinatorDir },
    sessions,
  });
  const order: string[] = [];
  const activated = await activateCoordinatorProfileIdentity({
    registry,
    endpointId: "coordinator-local",
    legacyEndpointId: "local",
    coordinatorDir,
    activationRequired: true,
    beforeReset: async () => {
      order.push("reconcile");
      assert.equal(registry.snapshot().coordinator.thread_id, "legacy");
    },
    captureCreationBaseline: async () => {
      order.push("baseline");
      assert.equal(registry.snapshot().coordinator.thread_id, "legacy");
      return ["pre-existing"];
    },
    markActivated: async (baseline) => {
      order.push(`marker:${baseline.join(",")}`);
      assert.equal(JSON.parse(await readFile(path, "utf8")).coordinator.thread_id, "pending");
    },
  });
  assert.equal(activated, true);
  assert.deepEqual(order, ["reconcile", "baseline", "marker:pre-existing"]);
  assert.equal(registry.snapshot().coordinator.thread_id, "pending");
  assert.equal(registry.snapshot().coordinator.endpoint, "coordinator-local");
  assert.deepEqual(registry.snapshot().sessions, sessions);
});

test("profile activation is skipped when durable and fails before unsafe mutation", async () => {
  const registered = await mkdtemp(join(tmpdir(), "coordinator-profile-registered-"));
  const configured = await mkdtemp(join(tmpdir(), "coordinator-profile-configured-"));
  const path = join(registered, "sessions.json");
  const registry = await SessionRegistry.open(path, {
    version: 1,
    coordinator: { endpoint: "coordinator-local", thread_id: "thread", project_dir: registered },
    sessions: {},
  });
  let callbacks = 0;
  assert.equal(await activateCoordinatorProfileIdentity({
    registry, endpointId: "coordinator-local", legacyEndpointId: "local", coordinatorDir: registered, activationRequired: false,
    beforeReset: async () => { callbacks += 1; }, captureCreationBaseline: async () => { callbacks += 1; return []; }, markActivated: async () => { callbacks += 1; },
  }), false);
  assert.equal(callbacks, 0);

  await assert.rejects(activateCoordinatorProfileIdentity({
    registry, endpointId: "coordinator-local", legacyEndpointId: "local", coordinatorDir: configured, activationRequired: true,
    beforeReset: async () => { callbacks += 1; }, captureCreationBaseline: async () => [], markActivated: async () => {},
  }), /does not match configured workdir/);
  assert.equal(callbacks, 0);
  assert.equal(registry.snapshot().coordinator.thread_id, "thread");

  await assert.rejects(activateCoordinatorProfileIdentity({
    registry, endpointId: "coordinator-local", legacyEndpointId: "local", coordinatorDir: registered, activationRequired: true,
    beforeReset: async () => {}, captureCreationBaseline: async () => { throw new Error("list failed"); }, markActivated: async () => {},
  }), /list failed/);
  assert.equal(registry.snapshot().coordinator.thread_id, "thread");

  await assert.rejects(activateCoordinatorProfileIdentity({
    registry, endpointId: "coordinator-local", legacyEndpointId: "local", coordinatorDir: registered, activationRequired: true,
    beforeReset: async () => {}, captureCreationBaseline: async () => [], markActivated: async () => { throw new Error("marker failed"); },
  }), /marker failed/);
  assert.equal(registry.snapshot().coordinator.thread_id, "pending");
});

test("candidate discovery exhausts pages and filters nonpersistent or mismatched threads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coordinator-candidates-"));
  const other = await mkdtemp(join(tmpdir(), "coordinator-candidates-other-"));
  const calls: any[] = [];
  const endpoint = {
    id: "coordinator-local",
    request: async <T>(method: string, params: any) => {
      assert.equal(method, "thread/list");
      calls.push(params);
      return (params.cursor ? {
        data: [
          { id: "child", cwd: dir, ephemeral: false, parentThreadId: "parent", threadSource: "nonce" },
          { id: "other", cwd: other, ephemeral: false, parentThreadId: null, threadSource: "nonce" },
        ], nextCursor: null,
      } : {
        data: [
          { id: "valid", cwd: dir, ephemeral: false, parentThreadId: null, threadSource: "nonce" },
          { id: "ephemeral", cwd: dir, ephemeral: true, parentThreadId: null, threadSource: "nonce" },
        ], nextCursor: "next",
      }) as T;
    },
  };
  assert.deepEqual(await listCoordinatorThreadCandidates(endpoint, dir), [{ id: "valid", threadSource: "nonce" }]);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.cwd, dir);
    assert.equal(call.archived, false);
    assert.equal(call.useStateDbOnly, false);
    assert.deepEqual(call.sourceKinds, ["appServer"]);
  }
});

test("pending identity resumes only the sole bot-nonce post-baseline candidate", async () => {
  const run = async (rows: any[], baseline: string[]) => {
    const dir = await mkdtemp(join(tmpdir(), "coordinator-pending-"));
    const path = join(dir, "sessions.json");
    const registry = await SessionRegistry.open(path, {
      version: 1, coordinator: { endpoint: "coordinator-local", thread_id: "pending", project_dir: dir }, sessions: {},
    });
    const calls: Array<{ method: string; params: any }> = [];
    const endpoint = {
      id: "coordinator-local",
      request: async <T>(method: string, params: any) => {
        calls.push({ method, params });
        if (method === "thread/list") return { data: rows.map((row) => ({ cwd: dir, ephemeral: false, parentThreadId: null, ...row })), nextCursor: null } as T;
        const id = method === "thread/start" ? "created" : params.threadId;
        return { thread: { id, cwd: dir, threadSource: "bot-nonce", status: { type: "idle" } } } as T;
      },
    };
    const result = await resumeCoordinatorIdentity({
      registry, endpoint, legacyEndpointId: "local", coordinatorDir: dir, sandboxMode: "workspace-write", config: {},
      creationNonce: "bot-nonce", creationBaseline: baseline,
    });
    return { result, calls, registry };
  };

  const recovered = await run([
    { id: "baseline", threadSource: "bot-nonce" },
    { id: "foreign", threadSource: "other" },
    { id: "created-before-crash", threadSource: "bot-nonce" },
  ], ["baseline"]);
  assert.equal(recovered.calls.at(-1)?.method, "thread/resume");
  assert.equal(recovered.calls.at(-1)?.params.threadId, "created-before-crash");
  assert.equal(recovered.result.threadId, "created-before-crash");

  const fresh = await run([
    { id: "baseline", threadSource: "bot-nonce" },
    { id: "foreign", threadSource: "other" },
  ], ["baseline"]);
  assert.equal(fresh.calls.at(-1)?.method, "thread/start");
  assert.equal(fresh.calls.at(-1)?.params.threadSource, "bot-nonce");
  assert.equal(fresh.result.threadId, "created");
});

test("pending identity fails closed on multiple matching post-baseline candidates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coordinator-pending-ambiguous-"));
  const registry = await SessionRegistry.open(join(dir, "sessions.json"), {
    version: 1, coordinator: { endpoint: "coordinator-local", thread_id: "pending", project_dir: dir }, sessions: {},
  });
  let mutations = 0;
  const endpoint = {
    id: "coordinator-local",
    request: async <T>(method: string) => {
      if (method === "thread/list") return { data: ["one", "two"].map((id) => ({ id, cwd: dir, ephemeral: false, parentThreadId: null, threadSource: "bot-nonce" })), nextCursor: null } as T;
      mutations += 1;
      return {} as T;
    },
  };
  await assert.rejects(resumeCoordinatorIdentity({
    registry, endpoint, legacyEndpointId: "local", coordinatorDir: dir, sandboxMode: "workspace-write", config: {},
    creationNonce: "bot-nonce", creationBaseline: [],
  }), (error: unknown) => error instanceof AppError && error.code === "CONFIGURATION_ERROR" && /multiple/.test(error.message));
  assert.equal(mutations, 0);
  assert.equal(registry.snapshot().coordinator.thread_id, "pending");
});
