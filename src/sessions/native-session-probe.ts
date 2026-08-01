import type { ThreadHistoryTurn } from "../app-server/thread-history.ts";
import type {
  NativeSessionIdentity,
  NativeSessionView,
} from "./native-session-state.ts";
import { NativeSessionState } from "./native-session-state.ts";

const ACTIVE_TURN_STATUSES = new Set(["active", "inProgress", "running"]);

function statusType(value: unknown): string {
  return typeof value === "string"
    ? value
    : value && typeof value === "object" && !Array.isArray(value)
      ? String((value as { type?: unknown }).type ?? "")
      : "";
}

export async function repairActiveTurnIdentity(input: {
  native: NativeSessionState;
  identity: NativeSessionIdentity;
  endpointGeneration: number;
  latestTurn(): Promise<ThreadHistoryTurn | undefined>;
  expectedLifecycleRevision?: number;
}): Promise<NativeSessionView | undefined> {
  const before = input.native.view(input.identity);
  if (!before || before.availability !== "ready" || before.endpointGeneration !== input.endpointGeneration) return before;
  // Nothing to repair: the session is busy with work that belongs to no turn, and no history
  // read can produce a turn id for it. Probing anyway finds no active turn and concludes the
  // state is unknown, which is how a worker with a live subagent came to fail every operation
  // as if its endpoint were unavailable.
  if (before.status === "active" && before.backgroundWork && before.activeTurnId === null) return before;
  if (input.expectedLifecycleRevision !== undefined) {
    if (before.lifecycleRevision !== input.expectedLifecycleRevision) return before;
  } else if (before.status !== "active" || before.activeTurnId !== null) {
    return before;
  }

  const token = input.native.captureRefresh(input.identity, input.endpointGeneration);
  const latest = await input.latestTurn();
  const activeTurnId = latest && ACTIVE_TURN_STATUSES.has(statusType(latest.status))
    ? latest.id
    : undefined;
  input.native.applyRefresh(token, activeTurnId
    ? { status: "active", activeTurnId }
    : { status: "unknown", activeTurnId: null });
  return input.native.view(input.identity);
}
