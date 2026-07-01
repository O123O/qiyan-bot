import { realpath } from "node:fs/promises";
import { AppError } from "../core/errors.ts";
import type { SessionRegistry } from "../registry/session-registry.ts";

interface CoordinatorEndpoint {
  id: string;
  request<T>(method: string, params: unknown): Promise<T>;
}

interface ThreadResponse {
  thread: { id: string; cwd: string; threadSource?: string | null; status?: { type?: string } };
}

interface CoordinatorCandidate { id: string; threadSource: string | null }

export async function resumeCoordinatorIdentity(input: {
  registry: SessionRegistry;
  endpoint: CoordinatorEndpoint;
  legacyEndpointId: string;
  coordinatorDir: string;
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  config: Record<string, unknown>;
  creationNonce?: string;
  creationBaseline?: readonly string[];
}): Promise<{ threadId: string; nativeStatus: string }> {
  const { identity, configuredDir } = await validateRegistration(input.registry, input.endpoint.id, input.legacyEndpointId, input.coordinatorDir);
  let expectedThreadId: string | undefined = identity.thread_id === "pending" ? undefined : identity.thread_id;
  let requireCreationNonce = false;
  let response: ThreadResponse;
  if (identity.thread_id === "pending") {
    if (!input.creationNonce) throw new AppError("CONFIGURATION_ERROR", "pending coordinator identity has no creation nonce");
    const baseline = new Set(input.creationBaseline ?? []);
    const candidates = (await listCoordinatorThreadCandidates(input.endpoint, configuredDir))
      .filter((candidate) => candidate.threadSource === input.creationNonce && !baseline.has(candidate.id));
    if (candidates.length > 1) throw new AppError("CONFIGURATION_ERROR", "multiple bot-created coordinator threads match the pending identity");
    const candidate = candidates[0];
    expectedThreadId = candidate?.id;
    requireCreationNonce = true;
    response = candidate
      ? await input.endpoint.request<ThreadResponse>("thread/resume", { threadId: candidate.id, cwd: input.coordinatorDir, approvalPolicy: "never", sandbox: input.sandboxMode, config: input.config })
      : await input.endpoint.request<ThreadResponse>("thread/start", { cwd: input.coordinatorDir, approvalPolicy: "never", sandbox: input.sandboxMode, config: input.config, ephemeral: false, threadSource: input.creationNonce });
  } else {
    response = await input.endpoint.request<ThreadResponse>("thread/resume", { threadId: identity.thread_id, cwd: input.coordinatorDir, approvalPolicy: "never", sandbox: input.sandboxMode, config: input.config });
  }
  const threadId = String(response.thread.id);
  if (expectedThreadId !== undefined && threadId !== expectedThreadId) throw new AppError("CONFIGURATION_ERROR", "coordinator resume returned a different thread identity");
  if (requireCreationNonce && response.thread.threadSource !== input.creationNonce) throw new AppError("CONFIGURATION_ERROR", "coordinator app-server returned a thread with the wrong creation nonce");
  if (!await sameDirectory(response.thread.cwd, configuredDir)) throw new AppError("CONFIGURATION_ERROR", `coordinator app-server did not use configured working directory ${configuredDir}`);
  await input.registry.setCoordinator({ endpoint: input.endpoint.id, thread_id: threadId, project_dir: input.coordinatorDir });
  return { threadId, nativeStatus: response.thread.status?.type ?? "idle" };
}

export async function activateCoordinatorProfileIdentity(input: {
  registry: SessionRegistry;
  endpointId: string;
  legacyEndpointId: string;
  coordinatorDir: string;
  activationRequired: boolean;
  beforeReset(): Promise<void>;
  captureCreationBaseline(): Promise<readonly string[]>;
  markActivated(creationBaseline: readonly string[]): Promise<void>;
}): Promise<boolean> {
  if (!input.activationRequired) return false;
  await validateRegistration(input.registry, input.endpointId, input.legacyEndpointId, input.coordinatorDir);
  await input.beforeReset();
  const creationBaseline = await input.captureCreationBaseline();
  await input.registry.setCoordinator({ endpoint: input.endpointId, thread_id: "pending", project_dir: input.coordinatorDir });
  await input.markActivated(creationBaseline);
  return true;
}

export async function listCoordinatorThreadCandidates(endpoint: CoordinatorEndpoint, coordinatorDir: string): Promise<CoordinatorCandidate[]> {
  const configuredDir = await realpath(coordinatorDir);
  const candidates: CoordinatorCandidate[] = [];
  let cursor: string | null = null;
  do {
    const params: Record<string, unknown> = {
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["appServer"],
      archived: false,
      useStateDbOnly: false,
      cwd: configuredDir,
    };
    if (cursor !== null) params.cursor = cursor;
    const page = await endpoint.request<{ data: Array<Record<string, unknown>>; nextCursor: string | null }>("thread/list", params);
    for (const raw of page.data) {
      if (raw.ephemeral === true || raw.parentThreadId != null || typeof raw.id !== "string" || !await sameDirectory(String(raw.cwd), configuredDir)) continue;
      candidates.push({ id: raw.id, threadSource: typeof raw.threadSource === "string" ? raw.threadSource : null });
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return candidates;
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
