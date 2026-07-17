import type { AppServerPool } from "../app-server/pool.ts";
import type { NativeSessionState } from "../sessions/native-session-state.ts";

export class NativeCapacityBridge {
  private readonly unsubscribe: () => void;

  constructor(
    native: NativeSessionState,
    pool: Pick<AppServerPool, "restoreObservedActiveTurn" | "markTurnTerminal">,
  ) {
    this.unsubscribe = native.onChange((current, previous) => {
      if (current.availability === "ready" && current.status === "active" && current.activeTurnId
        && previous?.availability === "ready" && previous.status === "active" && previous.activeTurnId
        && previous.activeTurnId !== current.activeTurnId) {
        pool.markTurnTerminal(previous.endpointId, previous.threadId, previous.activeTurnId);
      }
      if (current.availability === "ready" && current.status === "active" && current.activeTurnId) {
        pool.restoreObservedActiveTurn(current.endpointId, current.threadId, current.activeTurnId);
      }
      if (current.availability === "ready" && current.status === "idle"
        && previous?.availability === "ready" && previous.status === "active" && previous.activeTurnId) {
        pool.markTurnTerminal(previous.endpointId, previous.threadId, previous.activeTurnId);
      }
    });
  }

  close(): void { this.unsubscribe(); }
}
