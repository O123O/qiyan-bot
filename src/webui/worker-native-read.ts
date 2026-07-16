import type { EndpointWorkLease } from "../endpoints/types.ts";

export interface ReadyWorkerReadDeps {
  withReadyWorkLease<T>(endpointId: string, run: (lease: EndpointWorkLease) => Promise<T>): Promise<T>;
  request(endpointId: string, method: string, params: unknown, signal?: AbortSignal, lease?: EndpointWorkLease): Promise<unknown>;
}

// A passive Web UI read: withReadyWorkLease fails instead of activating an unavailable endpoint,
// and the existing lease prevents the pool's provider from racing into activating admission.
export async function readReadyWorkerTurns(
  deps: ReadyWorkerReadDeps,
  endpointId: string,
  threadId: string,
  signal: AbortSignal,
): Promise<unknown[]> {
  return deps.withReadyWorkLease(endpointId, async (lease) => {
    const result = await deps.request(
      endpointId, "thread/read", { threadId, includeTurns: true }, signal, lease,
    ) as { thread?: { turns?: unknown[] } };
    return result.thread?.turns ?? [];
  });
}
