import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatStartupError } from "../../src/cli.ts";
import { activateAssistantProfileIdentity, resumeAssistantIdentity } from "../../src/assistant/identity.ts";
import { JsonRpcResponseError } from "../../src/app-server/json-rpc-client.ts";
import { AppError } from "../../src/core/errors.ts";
import { SessionRegistry } from "../../src/registry/session-registry.ts";

test("a legacy local assistant mapping migrates atomically after exact resume verification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assistant-identity-"));
  const path = join(dir, "sessions.json");
  const registry = await SessionRegistry.open(path, {
    version: 2,
    assistant: { endpoint: "local", thread_id: "legacy-thread", project_dir: dir },
    sessions: {},
  });
  const calls: Array<{ method: string; params: any }> = [];
  const endpoint = {
    id: "assistant-local",
    request: async <T>(method: string, params: any) => {
      calls.push({ method, params });
      return { thread: { id: "legacy-thread", cwd: dir, status: { type: "idle" } } } as T;
    },
  };
  const resumed = await resumeAssistantIdentity({ registry, endpoint, legacyEndpointId: "local", assistantDir: dir, sandboxMode: "workspace-write", config: {} });
  assert.deepEqual(resumed, { threadId: "legacy-thread", nativeStatus: "idle" });
  assert.equal(calls[0]?.method, "thread/resume");
  assert.equal(calls[0]?.params.threadId, "legacy-thread");
  assert.equal(JSON.parse(await readFile(path, "utf8")).assistant.endpoint, "assistant-local");
  assert.equal(JSON.parse(await readFile(`${path}.last-good`, "utf8")).assistant.endpoint, "assistant-local");
});

test("legacy assistant migration does not rewrite identity when resumed cwd differs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assistant-identity-bad-"));
  const other = await mkdtemp(join(tmpdir(), "assistant-identity-other-"));
  const path = join(dir, "sessions.json");
  const registry = await SessionRegistry.open(path, {
    version: 2,
    assistant: { endpoint: "local", thread_id: "legacy-thread", project_dir: dir },
    sessions: {},
  });
  await assert.rejects(resumeAssistantIdentity({
    registry,
    endpoint: {
      id: "assistant-local",
      request: async <T>() => ({ thread: { id: "legacy-thread", cwd: other, status: { type: "idle" } } } as T),
    },
    legacyEndpointId: "local",
    assistantDir: dir,
    sandboxMode: "workspace-write",
    config: {},
  }), /working directory/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).assistant.endpoint, "local");
});

test("configured assistant directory mismatch is a safe startup error before app-server access", async () => {
  const registered = await mkdtemp(join(tmpdir(), "assistant-identity-registered-"));
  const configured = await mkdtemp(join(tmpdir(), "assistant-identity-configured-"));
  const path = join(registered, "sessions.json");
  const registry = await SessionRegistry.open(path, {
    version: 2,
    assistant: { endpoint: "assistant-local", thread_id: "thread", project_dir: registered },
    sessions: {},
  });
  let requests = 0;
  let failure: unknown;
  try {
    await resumeAssistantIdentity({
      registry,
      endpoint: { id: "assistant-local", request: async <T>() => { requests += 1; return {} as T; } },
      legacyEndpointId: "local",
      assistantDir: configured,
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

test("first profile activation validates, resets only assistant, then marks", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-profile-activation-"));
  const assistantDir = join(root, "assistant");
  const projectOne = join(root, "one");
  const projectTwo = join(root, "two");
  await Promise.all([mkdir(assistantDir), mkdir(projectOne), mkdir(projectTwo)]);
  const path = join(root, "sessions.json");
  const sessions = {
    one: { endpoint: "local", thread_id: "one-thread", project_dir: projectOne },
    two: { endpoint: "local", thread_id: "two-thread", project_dir: projectTwo },
  };
  const registry = await SessionRegistry.open(path, {
    version: 2,
    assistant: { endpoint: "assistant-local", thread_id: "legacy", project_dir: assistantDir },
    sessions,
  });
  const order: string[] = [];
  const activated = await activateAssistantProfileIdentity({
    registry,
    endpointId: "assistant-local",
    legacyEndpointId: "local",
    assistantDir,
    activationRequired: true,
    beforeReset: async () => {
      order.push("reconcile");
      assert.equal(registry.snapshot().assistant.thread_id, "legacy");
    },
    markActivated: async () => {
      order.push("marker");
      assert.equal(JSON.parse(await readFile(path, "utf8")).assistant.thread_id, "pending");
    },
  });
  assert.equal(activated, true);
  assert.deepEqual(order, ["reconcile", "marker"]);
  assert.equal(registry.snapshot().assistant.thread_id, "pending");
  assert.equal(registry.snapshot().assistant.endpoint, "assistant-local");
  assert.deepEqual(registry.snapshot().sessions, sessions);
});

test("profile activation is skipped when durable and fails before unsafe mutation", async () => {
  const registered = await mkdtemp(join(tmpdir(), "assistant-profile-registered-"));
  const configured = await mkdtemp(join(tmpdir(), "assistant-profile-configured-"));
  const path = join(registered, "sessions.json");
  const registry = await SessionRegistry.open(path, {
    version: 2,
    assistant: { endpoint: "assistant-local", thread_id: "thread", project_dir: registered },
    sessions: {},
  });
  let callbacks = 0;
  assert.equal(await activateAssistantProfileIdentity({
    registry, endpointId: "assistant-local", legacyEndpointId: "local", assistantDir: registered, activationRequired: false,
    beforeReset: async () => { callbacks += 1; }, markActivated: async () => { callbacks += 1; },
  }), false);
  assert.equal(callbacks, 0);

  await assert.rejects(activateAssistantProfileIdentity({
    registry, endpointId: "assistant-local", legacyEndpointId: "local", assistantDir: configured, activationRequired: true,
    beforeReset: async () => { callbacks += 1; }, markActivated: async () => {},
  }), /does not match configured workdir/);
  assert.equal(callbacks, 0);
  assert.equal(registry.snapshot().assistant.thread_id, "thread");

  await assert.rejects(activateAssistantProfileIdentity({
    registry, endpointId: "assistant-local", legacyEndpointId: "local", assistantDir: registered, activationRequired: true,
    beforeReset: async () => {}, markActivated: async () => { throw new Error("marker failed"); },
  }), /marker failed/);
  assert.equal(registry.snapshot().assistant.thread_id, "pending");
});

test("fresh pending identity records, materializes, commits, and clears in order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assistant-two-phase-"));
  const registry = await SessionRegistry.open(join(dir, "sessions.json"), {
    version: 2, assistant: { endpoint: "assistant-local", thread_id: "pending", project_dir: dir }, sessions: {},
  });
  const order: string[] = [];
  const endpoint = {
    id: "assistant-local",
    request: async <T>(method: string, params: any) => {
      order.push(method);
      if (method === "thread/start") {
        assert.equal(params.threadSource, "bot-nonce");
        return { thread: { id: "created", cwd: dir, threadSource: "bot-nonce", name: null, status: { type: "idle" } } } as T;
      }
      if (method === "thread/name/set") {
        assert.equal(params.name, "qiyan-bot-assistant:bot-nonce");
        assert.equal(registry.snapshot().assistant.thread_id, "pending");
        return {} as T;
      }
      if (method === "thread/read") return { thread: { id: "created", cwd: dir, threadSource: "bot-nonce", name: "qiyan-bot-assistant:bot-nonce", status: { type: "idle" } } } as T;
      throw new Error(`unexpected ${method}`);
    },
  };
  const result = await resumeAssistantIdentity({
    registry, endpoint, legacyEndpointId: "local", assistantDir: dir, sandboxMode: "workspace-write", config: {},
    creationNonce: "bot-nonce", pendingThreadId: null,
    recordPendingThread: async (id) => { order.push(`record:${id}`); assert.equal(registry.snapshot().assistant.thread_id, "pending"); },
    clearPendingThread: async (id) => { order.push(`clear:${id}`); assert.equal(registry.snapshot().assistant.thread_id, id); },
  });
  assert.equal(result.threadId, "created");
  assert.deepEqual(order, ["thread/start", "record:created", "thread/name/set", "thread/read", "clear:created"]);
});

test("pending receipt resumes only exact durable provenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assistant-receipt-"));
  const registry = await SessionRegistry.open(join(dir, "sessions.json"), {
    version: 2, assistant: { endpoint: "assistant-local", thread_id: "pending", project_dir: dir }, sessions: {},
  });
  const calls: string[] = [];
  const endpoint = {
    id: "assistant-local",
    request: async <T>(method: string, params: any) => {
      calls.push(method);
      assert.equal(params.threadId, "receipt-thread");
      return { thread: { id: "receipt-thread", cwd: dir, threadSource: "bot-nonce", name: "qiyan-bot-assistant:bot-nonce", status: { type: "idle" } } } as T;
    },
  };
  let cleared: string | undefined;
  const result = await resumeAssistantIdentity({
    registry, endpoint, legacyEndpointId: "local", assistantDir: dir, sandboxMode: "workspace-write", config: {},
    creationNonce: "bot-nonce", pendingThreadId: "receipt-thread",
    recordPendingThread: async () => { throw new Error("must not record"); }, clearPendingThread: async (id) => { cleared = id; },
  });
  assert.deepEqual(calls, ["thread/read", "thread/resume"]);
  assert.equal(result.threadId, "receipt-thread");
  assert.equal(cleared, "receipt-thread");
});

test("a resume failure preserves an already-proven durable pending receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assistant-receipt-resume-failure-"));
  const registry = await SessionRegistry.open(join(dir, "sessions.json"), {
    version: 2, assistant: { endpoint: "assistant-local", thread_id: "pending", project_dir: dir }, sessions: {},
  });
  const failure = new JsonRpcResponseError(-32600, "thread not loaded: receipt-thread");
  const endpoint = {
    id: "assistant-local",
    request: async <T>(method: string) => {
      if (method === "thread/read") {
        return {
          thread: {
            id: "receipt-thread",
            cwd: dir,
            threadSource: "bot-nonce",
            name: "qiyan-bot-assistant:bot-nonce",
            status: { type: "idle" },
          },
        } as T;
      }
      if (method === "thread/resume") throw failure;
      throw new Error(`unexpected ${method}`);
    },
  };
  let cleared = false;
  await assert.rejects(resumeAssistantIdentity({
    registry, endpoint, legacyEndpointId: "local", assistantDir: dir, sandboxMode: "workspace-write", config: {},
    creationNonce: "bot-nonce", pendingThreadId: "receipt-thread",
    recordPendingThread: async () => { throw new Error("must not record"); },
    clearPendingThread: async () => { cleared = true; },
  }), (error: unknown) => error === failure);
  assert.equal(cleared, false);
  assert.equal(registry.snapshot().assistant.thread_id, "pending");
});

test("registered identity clears a matching stale creation receipt after verified resume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assistant-stale-receipt-"));
  const registry = await SessionRegistry.open(join(dir, "sessions.json"), {
    version: 2, assistant: { endpoint: "assistant-local", thread_id: "registered-thread", project_dir: dir }, sessions: {},
  });
  const calls: string[] = [];
  const endpoint = {
    id: "assistant-local",
    request: async <T>(method: string, params: any) => {
      calls.push(method);
      assert.equal(params.threadId, "registered-thread");
      return {
        thread: {
          id: "registered-thread",
          cwd: dir,
          threadSource: "bot-nonce",
          name: "qiyan-bot-assistant:bot-nonce",
          status: { type: "idle" },
        },
      } as T;
    },
  };
  let cleared: string | undefined;
  const result = await resumeAssistantIdentity({
    registry, endpoint, legacyEndpointId: "local", assistantDir: dir, sandboxMode: "workspace-write", config: {},
    creationNonce: "bot-nonce", pendingThreadId: "registered-thread",
    recordPendingThread: async () => { throw new Error("must not record"); },
    clearPendingThread: async (id) => { cleared = id; },
  });
  assert.deepEqual(calls, ["thread/resume"]);
  assert.equal(result.threadId, "registered-thread");
  assert.equal(cleared, "registered-thread");
});

test("registered isolated identity always requires its immutable creation nonce", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assistant-registered-provenance-"));
  const registry = await SessionRegistry.open(join(dir, "sessions.json"), {
    version: 2, assistant: { endpoint: "assistant-local", thread_id: "registered-thread", project_dir: dir }, sessions: {},
  });
  const thread = {
    id: "registered-thread",
    cwd: dir,
    threadSource: "attacker-value",
    name: "qiyan-bot-assistant:bot-nonce",
    status: { type: "idle" },
  };
  await assert.rejects(resumeAssistantIdentity({
    registry,
    endpoint: { id: "assistant-local", request: async <T>() => ({ thread } as T) },
    legacyEndpointId: "local", assistantDir: dir, sandboxMode: "workspace-write", config: {},
    creationNonce: "bot-nonce", pendingThreadId: null,
    recordPendingThread: async () => {}, clearPendingThread: async () => {},
  }), /creation nonce/);
  assert.equal(registry.snapshot().assistant.thread_id, "registered-thread");
});

test("registered isolated identity tolerates a user-renamed thread after receipt clearance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assistant-registered-name-"));
  const registry = await SessionRegistry.open(join(dir, "sessions.json"), {
    version: 2, assistant: { endpoint: "assistant-local", thread_id: "registered-thread", project_dir: dir }, sessions: {},
  });
  const result = await resumeAssistantIdentity({
    registry,
    endpoint: {
      id: "assistant-local",
      request: async <T>() => ({
        thread: { id: "registered-thread", cwd: dir, threadSource: "bot-nonce", name: "My manager", status: { type: "idle" } },
      } as T),
    },
    legacyEndpointId: "local", assistantDir: dir, sandboxMode: "workspace-write", config: {},
    creationNonce: "bot-nonce", pendingThreadId: null,
    recordPendingThread: async () => {}, clearPendingThread: async () => {},
  });
  assert.equal(result.threadId, "registered-thread");
});

test("only exact thread-not-loaded clears a pending receipt", async () => {
  const run = async (failure: Error) => {
    const dir = await mkdtemp(join(tmpdir(), "assistant-receipt-error-"));
    const registry = await SessionRegistry.open(join(dir, "sessions.json"), {
      version: 2, assistant: { endpoint: "assistant-local", thread_id: "pending", project_dir: dir }, sessions: {},
    });
    const cleared: string[] = [];
    const recorded: string[] = [];
    const endpoint = {
      id: "assistant-local",
      request: async <T>(method: string, params: any) => {
        if (method === "thread/read" && params.threadId === "lost") throw failure;
        if (method === "thread/start") return { thread: { id: "replacement", cwd: dir, threadSource: "bot-nonce", name: null, status: { type: "idle" } } } as T;
        if (method === "thread/name/set") return {} as T;
        if (method === "thread/read") return { thread: { id: "replacement", cwd: dir, threadSource: "bot-nonce", name: "qiyan-bot-assistant:bot-nonce", status: { type: "idle" } } } as T;
        throw new Error(`unexpected ${method}`);
      },
    };
    const action = resumeAssistantIdentity({
      registry, endpoint, legacyEndpointId: "local", assistantDir: dir, sandboxMode: "workspace-write", config: {},
      creationNonce: "bot-nonce", pendingThreadId: "lost",
      recordPendingThread: async (id) => { recorded.push(id); }, clearPendingThread: async (id) => { cleared.push(id); },
    });
    return { action, cleared, recorded, registry };
  };

  const missing = await run(new JsonRpcResponseError(-32600, "thread not loaded: lost"));
  assert.equal((await missing.action).threadId, "replacement");
  assert.deepEqual(missing.cleared, ["lost", "replacement"]);
  assert.deepEqual(missing.recorded, ["replacement"]);

  for (const failure of [
    new JsonRpcResponseError(-32600, "invalid request"),
    new JsonRpcResponseError(-32000, "thread not loaded: lost"),
    new Error("app-server request timed out: thread/read"),
  ]) {
    const unsafe = await run(failure);
    await assert.rejects(unsafe.action, (error: unknown) => error === failure);
    assert.deepEqual(unsafe.cleared, []);
    assert.deepEqual(unsafe.recorded, []);
    assert.equal(unsafe.registry.snapshot().assistant.thread_id, "pending");
  }
});

test("pending receipt provenance mismatch fails without clearing", async () => {
  for (const field of ["id", "cwd", "threadSource", "name"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "assistant-provenance-"));
    const other = await mkdtemp(join(tmpdir(), "assistant-provenance-other-"));
    const registry = await SessionRegistry.open(join(dir, "sessions.json"), {
      version: 2, assistant: { endpoint: "assistant-local", thread_id: "pending", project_dir: dir }, sessions: {},
    });
    let cleared = false;
    const thread = { id: "receipt", cwd: dir, threadSource: "nonce", name: "qiyan-bot-assistant:nonce", status: { type: "idle" } };
    if (field === "id") thread.id = "other";
    if (field === "cwd") thread.cwd = other;
    if (field === "threadSource") thread.threadSource = "other";
    if (field === "name") thread.name = "other";
    await assert.rejects(resumeAssistantIdentity({
      registry,
      endpoint: { id: "assistant-local", request: async <T>() => ({ thread } as T) },
      legacyEndpointId: "local", assistantDir: dir, sandboxMode: "workspace-write", config: {},
      creationNonce: "nonce", pendingThreadId: "receipt", recordPendingThread: async () => {}, clearPendingThread: async () => { cleared = true; },
    }), /identity|working directory|nonce|name/);
    assert.equal(cleared, false);
  }
});
