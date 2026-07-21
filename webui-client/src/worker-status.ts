export interface WorkerStateSnapshot {
  lifecycleState: string;
  nativeStatus: string | null;
  activeTurnId: string | null;
  goal?: { status: string } | null;
}

export type WorkerStatus = {
  label: "working" | "idle" | "error" | "unavailable";
  tone: "working" | "idle" | "error" | "unavailable";
};

export function workerStatus(session: WorkerStateSnapshot): WorkerStatus {
  if (session.lifecycleState !== "managed" || session.nativeStatus === null) return { label: "unavailable", tone: "unavailable" };
  if (session.nativeStatus === "systemError") return { label: "error", tone: "error" };
  if (session.activeTurnId !== null || session.nativeStatus === "active") {
    return { label: "working", tone: "working" };
  }
  if (session.nativeStatus === "idle" || session.nativeStatus === "notLoaded") return { label: "idle", tone: "idle" };
  return { label: "unavailable", tone: "unavailable" };
}
