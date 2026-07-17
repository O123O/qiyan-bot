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
  scrollHeight: number;
  clientHeight: number;
}): string | undefined {
  if (!options.hasOlder || options.historyInFlight || options.loadingOlder || !options.cursor) return undefined;
  if (options.attempts >= MAX_WORKER_HISTORY_AUTO_FILLS) return undefined;
  return options.scrollHeight <= options.clientHeight ? options.cursor : undefined;
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
