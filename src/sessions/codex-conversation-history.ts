import { basename, isAbsolute } from "node:path";
import { AppError } from "../core/errors.ts";
import type { WorkerNativeHistoryPage } from "../webui/worker-history-reader.ts";
import type { NativeSessionView } from "./native-session-state.ts";

interface RolloutLocation {
  path: string;
  allowMissing: boolean;
}

interface ThreadPathView {
  id?: unknown;
  path?: unknown;
  preview?: unknown;
}

const identityKey = (endpointId: string, threadId: string): string => `${endpointId}\0${threadId}`;
const MAX_LOCATIONS = 1_024;
const MAX_CACHED_BODY_CHARS = 1_000_000;

export class CodexRolloutLocations {
  private readonly locations = new Map<string, RolloutLocation>();

  observe(endpointId: string, thread: ThreadPathView): void {
    const threadId = typeof thread.id === "string" ? thread.id : "";
    const path = typeof thread.path === "string" ? thread.path : "";
    if (!threadId || !isAbsolute(path)) return;
    const name = basename(path);
    if (!name.startsWith("rollout-") || !name.endsWith(`-${threadId}.jsonl`)) return;
    const key = identityKey(endpointId, threadId);
    this.locations.delete(key);
    this.locations.set(key, {
      path,
      allowMissing: thread.preview === "",
    });
    while (this.locations.size > MAX_LOCATIONS) this.locations.delete(this.locations.keys().next().value!);
  }

  get(endpointId: string, threadId: string): RolloutLocation | undefined {
    const location = this.locations.get(identityKey(endpointId, threadId));
    return location ? { ...location } : undefined;
  }

  markMaterialized(endpointId: string, threadId: string): void {
    const key = identityKey(endpointId, threadId);
    const location = this.locations.get(key);
    if (!location?.allowMissing) return;
    this.locations.set(key, { ...location, allowMissing: false });
  }
}

export function createCodexConversationHistoryRead(deps: {
  locations: CodexRolloutLocations;
  nativeSession(endpointId: string, threadId: string, mappingId: string): NativeSessionView | undefined;
  readPage(
    input: {
      endpointId: string;
      path: string;
      threadId: string;
      nativeStatus: string;
      activeTurnId: string | null;
      limit: number;
      cursor?: string;
      allowMissing: boolean;
    },
    signal: AbortSignal,
  ): Promise<WorkerNativeHistoryPage>;
  maxCachedPages?: number;
}) {
  const pages = new Map<string, WorkerNativeHistoryPage>();
  const maxCachedPages = Math.max(1, Math.trunc(deps.maxCachedPages ?? 32));

  return async (
    endpointId: string,
    threadId: string,
    mappingId: string,
    limit: number,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<WorkerNativeHistoryPage> => {
    if (signal.aborted) throw signal.reason ?? new Error("worker history read cancelled");
    const location = deps.locations.get(endpointId, threadId);
    const native = deps.nativeSession(endpointId, threadId, mappingId);
    if (!location) {
      // Rollout locations are learned only from a thread/read on the worker's own endpoint,
      // and this map starts empty on every boot. So an endpoint QiYan cannot reach has no
      // location yet — history is genuinely unavailable, but only until it reconnects, and
      // reporting that as a bare error made a self-healing outage read as corruption.
      if (native?.availability !== "ready") {
        throw new AppError("ENDPOINT_UNAVAILABLE",
          `${endpointId} is not connected, so this worker's history cannot be read yet; it loads once the endpoint reconnects`);
      }
      // Reachable endpoint, no location: the entry was evicted (the map is bounded) or the
      // thread was never read. A read of the thread repopulates it.
      throw new AppError("OPERATION_FAILED",
        `no rollout location is known for thread ${threadId} on ${endpointId}; open the worker to re-read it`);
    }
    const nativeStatus = native?.availability === "ready" ? native.status : "unknown";
    const activeTurnId = native?.availability === "ready" ? native.activeTurnId : null;
    const keyFor = (value: RolloutLocation): string => JSON.stringify([
      endpointId, threadId, mappingId, value.path, value.allowMissing && cursor === undefined,
      native?.endpointGeneration ?? null, native?.receiveSequence ?? null, nativeStatus,
      activeTurnId, limit, cursor ?? null,
    ]);
    const key = keyFor(location);
    const cacheable = cursor === undefined;
    const cached = cacheable ? pages.get(key) : undefined;
    if (cached) {
      pages.delete(key);
      pages.set(key, cached);
      return cached;
    }
    const page = await deps.readPage({
      path: location.path,
      allowMissing: location.allowMissing && cursor === undefined,
      endpointId,
      threadId,
      nativeStatus,
      activeTurnId,
      limit,
      ...(cursor ? { cursor } : {}),
    }, signal);
    if (signal.aborted) throw signal.reason ?? new Error("worker history read cancelled");
    if (cacheable && page.messages.reduce((size, message) => size + message.body.length, 0) <= MAX_CACHED_BODY_CHARS) {
      const current = deps.locations.get(endpointId, threadId);
      pages.set(current?.path === location.path ? keyFor(current) : key, page);
      while (pages.size > maxCachedPages) pages.delete(pages.keys().next().value!);
    }
    return page;
  };
}
