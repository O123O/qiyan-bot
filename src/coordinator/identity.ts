import { realpath } from "node:fs/promises";
import type { SessionRegistry } from "../registry/session-registry.ts";

interface CoordinatorEndpoint {
  id: string;
  request<T>(method: string, params: unknown): Promise<T>;
}

interface ThreadResponse {
  thread: { id: string; cwd: string; status?: { type?: string } };
}

export async function resumeCoordinatorIdentity(input: {
  registry: SessionRegistry;
  endpoint: CoordinatorEndpoint;
  legacyEndpointId: string;
  coordinatorDir: string;
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  config: Record<string, unknown>;
}): Promise<{ threadId: string; nativeStatus: string }> {
  const identity = input.registry.snapshot().coordinator;
  if (identity.endpoint !== input.endpoint.id && identity.endpoint !== input.legacyEndpointId) {
    throw new Error("the coordinator registry entry uses an unknown endpoint");
  }
  if (await realpath(identity.project_dir) !== await realpath(input.coordinatorDir)) {
    throw new Error("the coordinator registry entry has an unexpected project directory");
  }
  const response = identity.thread_id === "pending"
    ? await input.endpoint.request<ThreadResponse>("thread/start", { cwd: input.coordinatorDir, approvalPolicy: "never", sandbox: input.sandboxMode, config: input.config, ephemeral: false })
    : await input.endpoint.request<ThreadResponse>("thread/resume", { threadId: identity.thread_id, cwd: input.coordinatorDir, approvalPolicy: "never", sandbox: input.sandboxMode, config: input.config });
  const threadId = String(response.thread.id);
  if (identity.thread_id !== "pending" && threadId !== identity.thread_id) throw new Error("coordinator resume returned a different thread identity");
  if (await realpath(response.thread.cwd) !== await realpath(input.coordinatorDir)) throw new Error("coordinator resume returned an unexpected working directory");
  await input.registry.setCoordinator({ endpoint: input.endpoint.id, thread_id: threadId, project_dir: input.coordinatorDir });
  return { threadId, nativeStatus: response.thread.status?.type ?? "idle" };
}
