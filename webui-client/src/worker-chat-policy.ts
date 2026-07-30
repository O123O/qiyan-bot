export const MAX_WORKER_HISTORY_AUTO_FILLS = 8;

export interface WorkerHistoryAutoFillState {
  attempts: number;
  cursor: string | undefined;
}

export interface WorkerScrollPreservation {
  height: number;
  pending: boolean;
}

export interface WorkerSubscriptionTarget {
  socket: object;
  nickname: string;
  mappingId: string;
}

export function workerInputDisplayMode(
  provider: string | undefined,
  targetsSelectedWorker: boolean,
): "optimistic" | "authoritative" | "ephemeral" {
  if (!targetsSelectedWorker) return "ephemeral";
  // Claude's one-shot runtime learns the native user-row ids only after the exact
  // prompt is appended to JSONL. Let that authoritative row render the message.
  return provider === "claude" ? "authoritative" : "optimistic";
}

export function sameWorkerSubscriptionTarget(
  current: WorkerSubscriptionTarget | null,
  next: WorkerSubscriptionTarget,
): boolean {
  return current?.socket === next.socket
    && current.nickname === next.nickname
    && current.mappingId === next.mappingId;
}

export function nextWorkerHistoryAutoFill(options: {
  hasOlder: boolean;
  historyInFlight: boolean;
  loadingOlder: boolean;
  cursor: string | undefined;
  attempts: number;
  recentBoundaryPending: boolean;
  scrollHeight: number;
  clientHeight: number;
}): string | undefined {
  if (!options.hasOlder || options.historyInFlight || options.loadingOlder || !options.cursor) return undefined;
  if (options.attempts >= MAX_WORKER_HISTORY_AUTO_FILLS) return undefined;
  return options.recentBoundaryPending || options.scrollHeight <= options.clientHeight ? options.cursor : undefined;
}

export function workerViewportRevision(
  panelKey: string,
  messages: ReadonlyArray<{ id?: string; body: string }>,
  layoutRevision = "",
): string {
  const tail = messages.at(-1);
  return `${panelKey}\0${layoutRevision}\0${messages.length}\0${tail?.id ?? ""}\0${tail?.body.length ?? 0}`;
}

export function releaseWorkerHistoryAutoFill(
  state: WorkerHistoryAutoFillState | undefined,
  cursor: string,
): WorkerHistoryAutoFillState | undefined {
  return state?.cursor === cursor ? { attempts: state.attempts, cursor: undefined } : state;
}

export function advanceWorkerScrollPreservation(
  state: WorkerScrollPreservation,
  nextHeight: number,
): { scrollDelta: number; state: WorkerScrollPreservation | null } {
  return {
    scrollDelta: nextHeight - state.height,
    state: state.pending ? { height: nextHeight, pending: true } : null,
  };
}

export function settleWorkerScrollPreservation(
  state: WorkerScrollPreservation | null,
): WorkerScrollPreservation | null {
  return state ? { ...state, pending: false } : null;
}

export function shouldFollowWorkerTail(options: {
  pinned: boolean;
  preservePending: boolean;
  previousRevision: string;
  nextRevision: string;
}): boolean {
  return options.pinned && !options.preservePending && options.previousRevision !== options.nextRevision;
}

export function applyWorkerTailFollow(options: {
  viewport: { scrollTop: number; readonly scrollHeight: number };
  pinned: boolean;
  preservePending: boolean;
  previousRevision: string;
  nextRevision: string;
}): boolean {
  if (!shouldFollowWorkerTail(options)) return false;
  options.viewport.scrollTop = options.viewport.scrollHeight;
  return true;
}
