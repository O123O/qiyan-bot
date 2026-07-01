import { realpath } from "node:fs/promises";
import { JsonRpcResponseError } from "../app-server/json-rpc-client.ts";
import { AppError } from "../core/errors.ts";
import type { SessionRegistry } from "../registry/session-registry.ts";

interface CoordinatorEndpoint {
  id: string;
  request<T>(method: string, params: unknown): Promise<T>;
}

interface ThreadResponse {
  thread: { id: string; cwd: string; threadSource?: string | null; name?: string | null; status?: { type?: string } };
}

export async function resumeCoordinatorIdentity(input: {
  registry: SessionRegistry;
  endpoint: CoordinatorEndpoint;
  legacyEndpointId: string;
  coordinatorDir: string;
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  config: Record<string, unknown>;
  creationNonce?: string;
  pendingThreadId?: string | null;
  recordPendingThread?(threadId: string): Promise<void>;
  clearPendingThread?(threadId: string): Promise<void>;
}): Promise<{ threadId: string; nativeStatus: string }> {
  const { identity, configuredDir } = await validateRegistration(input.registry, input.endpoint.id, input.legacyEndpointId, input.coordinatorDir);
  let response: ThreadResponse;
  if (identity.thread_id === "pending") {
    const creation = requireCreationState(input);
    response = await createOrRecoverPendingThread(input, configuredDir, creation);
  } else {
    response = await input.endpoint.request<ThreadResponse>("thread/resume", { threadId: identity.thread_id, cwd: input.coordinatorDir, approvalPolicy: "never", sandbox: input.sandboxMode, config: input.config });
    await verifyThread(response.thread, { id: identity.thread_id, cwd: configuredDir });
    if (input.creationNonce !== undefined) {
      const creation = requireCreationMetadata(input.creationNonce);
      await verifyThread(response.thread, { id: identity.thread_id, cwd: configuredDir, nonce: creation.nonce });
    }
    if (input.pendingThreadId !== undefined && input.pendingThreadId !== null) {
      const creation = requireCreationState(input);
      if (input.pendingThreadId !== identity.thread_id) throw new AppError("CONFIGURATION_ERROR", "coordinator registry and pending creation receipt disagree");
      await verifyThread(response.thread, { id: identity.thread_id, cwd: configuredDir, nonce: creation.nonce, name: creation.name });
    }
  }
  const threadId = String(response.thread.id);
  await input.registry.setCoordinator({ endpoint: input.endpoint.id, thread_id: threadId, project_dir: input.coordinatorDir });
  if (input.pendingThreadId === threadId) await input.clearPendingThread?.(threadId);
  else if (identity.thread_id === "pending") await input.clearPendingThread?.(threadId);
  return { threadId, nativeStatus: response.thread.status?.type ?? "idle" };
}

export async function activateCoordinatorProfileIdentity(input: {
  registry: SessionRegistry;
  endpointId: string;
  legacyEndpointId: string;
  coordinatorDir: string;
  activationRequired: boolean;
  beforeReset(): Promise<void>;
  markActivated(): Promise<void>;
}): Promise<boolean> {
  if (!input.activationRequired) return false;
  await validateRegistration(input.registry, input.endpointId, input.legacyEndpointId, input.coordinatorDir);
  await input.beforeReset();
  await input.registry.setCoordinator({ endpoint: input.endpointId, thread_id: "pending", project_dir: input.coordinatorDir });
  await input.markActivated();
  return true;
}

function requireCreationState(input: {
  creationNonce?: string;
  pendingThreadId?: string | null;
  recordPendingThread?(threadId: string): Promise<void>;
  clearPendingThread?(threadId: string): Promise<void>;
}) {
  if (!input.creationNonce || !input.recordPendingThread || !input.clearPendingThread) {
    throw new AppError("CONFIGURATION_ERROR", "pending coordinator identity has incomplete creation state");
  }
  return { ...requireCreationMetadata(input.creationNonce), record: input.recordPendingThread, clear: input.clearPendingThread };
}

function requireCreationMetadata(nonce: string) {
  if (!nonce) throw new AppError("CONFIGURATION_ERROR", "coordinator identity has no creation nonce");
  return { nonce, name: `codex-bot-coordinator:${nonce}` };
}

async function createOrRecoverPendingThread(
  input: {
    endpoint: CoordinatorEndpoint;
    coordinatorDir: string;
    sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
    config: Record<string, unknown>;
    pendingThreadId?: string | null;
  },
  configuredDir: string,
  creation: { nonce: string; name: string; record(threadId: string): Promise<void>; clear(threadId: string): Promise<void> },
): Promise<ThreadResponse> {
  if (input.pendingThreadId) {
    let read: ThreadResponse | undefined;
    try {
      read = await input.endpoint.request<ThreadResponse>("thread/read", { threadId: input.pendingThreadId, includeTurns: false });
    } catch (error) {
      if (!isExactThreadNotLoaded(error, input.pendingThreadId)) throw error;
      await creation.clear(input.pendingThreadId);
    }
    if (read) {
      await verifyThread(read.thread, { id: input.pendingThreadId, cwd: configuredDir, nonce: creation.nonce, name: creation.name });
      const resumed = await input.endpoint.request<ThreadResponse>("thread/resume", {
        threadId: input.pendingThreadId, cwd: input.coordinatorDir, approvalPolicy: "never", sandbox: input.sandboxMode, config: input.config,
      });
      await verifyThread(resumed.thread, { id: input.pendingThreadId, cwd: configuredDir, nonce: creation.nonce, name: creation.name });
      return resumed;
    }
  }

  const started = await input.endpoint.request<ThreadResponse>("thread/start", {
    cwd: input.coordinatorDir, approvalPolicy: "never", sandbox: input.sandboxMode, config: input.config, ephemeral: false, threadSource: creation.nonce,
  });
  await verifyThread(started.thread, { cwd: configuredDir, nonce: creation.nonce });
  const threadId = String(started.thread.id);
  await creation.record(threadId);
  await input.endpoint.request("thread/name/set", { threadId, name: creation.name });
  const materialized = await input.endpoint.request<ThreadResponse>("thread/read", { threadId, includeTurns: false });
  await verifyThread(materialized.thread, { id: threadId, cwd: configuredDir, nonce: creation.nonce, name: creation.name });
  return materialized;
}

async function verifyThread(thread: ThreadResponse["thread"], expected: { id?: string; cwd: string; nonce?: string; name?: string }): Promise<void> {
  if (expected.id !== undefined && thread.id !== expected.id) throw new AppError("CONFIGURATION_ERROR", "coordinator resume returned a different thread identity");
  if (!await sameDirectory(thread.cwd, expected.cwd)) throw new AppError("CONFIGURATION_ERROR", `coordinator app-server did not use configured working directory ${expected.cwd}`);
  if (expected.nonce !== undefined && thread.threadSource !== expected.nonce) throw new AppError("CONFIGURATION_ERROR", "coordinator app-server returned a thread with the wrong creation nonce");
  if (expected.name !== undefined && thread.name !== expected.name) throw new AppError("CONFIGURATION_ERROR", "coordinator app-server returned a thread with the wrong creation name");
}

function isExactThreadNotLoaded(error: unknown, threadId: string): boolean {
  return error instanceof JsonRpcResponseError && error.code === -32600 && error.rpcMessage === `thread not loaded: ${threadId}`;
}

async function validateRegistration(registry: SessionRegistry, endpointId: string, legacyEndpointId: string, coordinatorDir: string) {
  const identity = registry.snapshot().coordinator;
  if (identity.endpoint !== endpointId && identity.endpoint !== legacyEndpointId) {
    throw new AppError("CONFIGURATION_ERROR", "the coordinator registry entry uses an unknown endpoint");
  }
  const configuredDir = await realpath(coordinatorDir);
  if (!await sameDirectory(identity.project_dir, configuredDir)) {
    throw new AppError("CONFIGURATION_ERROR", `the coordinator registry does not match configured workdir ${configuredDir}`);
  }
  return { identity, configuredDir };
}

async function sameDirectory(candidate: string, expected: string): Promise<boolean> {
  try { return await realpath(candidate) === expected; }
  catch { return false; }
}
