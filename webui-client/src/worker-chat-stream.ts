export type WorkerProvider = "codex" | "claude" | string;

export interface WorkerChatMessage {
  id: string;
  turnId: string;
  body: string;
  completedAt: number;
  terminalStatus: string;
  role: "you" | "worker";
  clientId?: string;
  phase?: string;
  turnOrder?: number;
  itemOrder?: number;
  streaming: boolean;
  optimistic: boolean;
}

export type WorkerChatItem =
  | { type: "user-message"; id: string; clientId?: string; text: string }
  | { type: "agent-message"; id: string; text: string; phase?: string };

export type WorkerChatEvent =
  | { kind: "turn-started"; turnId: string; status?: string }
  | { kind: "turn-completed"; turnId: string; status?: string }
  | { kind: "item-started" | "item-completed"; turnId: string; item: WorkerChatItem; atMs?: number }
  | { kind: "agent-message-delta"; turnId: string; itemId: string; delta: string };

export interface WorkerEventEnvelope {
  type: "worker/event";
  nickname: string;
  requestId: string;
  subscriptionId: string;
  event: WorkerChatEvent;
}

export interface WorkerSnapshot {
  messages: Array<{
    id: string;
    turnId: string;
    body: string;
    completedAt: number;
    terminalStatus: string;
    role?: "you";
    clientId?: string;
    phase?: string;
    turnOrder?: number;
    itemOrder?: number;
  }>;
  hasOlder: boolean;
  nextCursor?: string;
  openTurnIds: string[];
  terminalTurnIds: string[];
}

export interface WorkerStreamState {
  nickname: string;
  provider: WorkerProvider;
  requestId: string;
  subscriptionId?: string;
  messages: WorkerChatMessage[];
  bufferedEvents: WorkerEventEnvelope[];
  bufferedBytes: number;
  snapshotPending: boolean;
  overflow: boolean;
  recoveryTurnIds: string[];
  pendingRecoveryTurnIds: string[];
  recoveredTurnIds: string[];
  observedTurnIds: string[];
  historyInFlight: boolean;
  historyLoaded: boolean;
  hasOlder: boolean;
  olderCursor: string | undefined;
}

const MAX_BUFFER_EVENTS = 2_048;
const MAX_BUFFER_BYTES = 1024 * 1024;
const utf8Bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export function beginWorkerSubscription(nickname: string, provider: WorkerProvider, requestId: string): WorkerStreamState {
  return {
    nickname, provider, requestId, messages: [], bufferedEvents: [], bufferedBytes: 0,
    snapshotPending: false, overflow: false, recoveryTurnIds: [], pendingRecoveryTurnIds: [],
    recoveredTurnIds: [], observedTurnIds: [], historyInFlight: false, historyLoaded: false, hasOlder: false, olderCursor: undefined,
  };
}

export function acknowledgeWorkerSubscription(state: WorkerStreamState, subscriptionId: string): WorkerStreamState {
  return { ...state, subscriptionId };
}

export function beginWorkerHistory(state: WorkerStreamState, snapshotPending: boolean): { state: WorkerStreamState; started: boolean } {
  if (state.historyInFlight) return { state, started: false };
  return { state: { ...state, historyInFlight: true, snapshotPending: state.snapshotPending || snapshotPending }, started: true };
}

export function addOptimisticWorkerMessage(state: WorkerStreamState, clientId: string, body: string, at: number): WorkerStreamState {
  const message: WorkerChatMessage = {
    id: `optimistic:${clientId}`, turnId: "", body, completedAt: at, terminalStatus: "",
    role: "you", clientId, streaming: false, optimistic: true,
  };
  return { ...state, messages: upsert(state.messages.filter((candidate) => candidate.clientId !== clientId), message) };
}

function upsert(messages: WorkerChatMessage[], message: WorkerChatMessage): WorkerChatMessage[] {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index < 0) return [...messages, message];
  const next = [...messages]; next[index] = message; return next;
}

function queueRecovery(state: WorkerStreamState, turnId: string): WorkerStreamState {
  if (state.recoveredTurnIds.includes(turnId) || state.pendingRecoveryTurnIds.includes(turnId)) return state;
  return { ...state, pendingRecoveryTurnIds: [...state.pendingRecoveryTurnIds, turnId] };
}

export function requeueWorkerRecovery(state: WorkerStreamState, turnId: string): WorkerStreamState {
  return queueRecovery(state, turnId);
}

function compareMessages(left: WorkerChatMessage, right: WorkerChatMessage): number {
  const byTime = left.completedAt - right.completedAt;
  if (byTime !== 0) return byTime;
  if (left.turnOrder === undefined && right.turnOrder === undefined) return 0;
  return (left.turnOrder ?? Number.MAX_SAFE_INTEGER) - (right.turnOrder ?? Number.MAX_SAFE_INTEGER)
    || (left.itemOrder ?? Number.MAX_SAFE_INTEGER) - (right.itemOrder ?? Number.MAX_SAFE_INTEGER);
}

function applyEvent(state: WorkerStreamState, envelope: WorkerEventEnvelope): WorkerStreamState {
  const event = envelope.event;
  if (event.kind === "turn-started") return state.observedTurnIds.includes(event.turnId)
    ? state
    : { ...state, observedTurnIds: [...state.observedTurnIds, event.turnId] };
  if (event.kind === "turn-completed") {
    const terminalStatus = event.status ?? "completed";
    let next = { ...state, messages: state.messages.map((message) => message.turnId === event.turnId ? { ...message, terminalStatus, streaming: false } : message) };
    if (state.provider === "claude" || state.recoveryTurnIds.includes(event.turnId)) next = queueRecovery(next, event.turnId);
    return next;
  }
  if (event.kind === "agent-message-delta") {
    const id = `a:${event.turnId}:${event.itemId}`;
    const existing = state.messages.find((message) => message.id === id);
    if (existing && !existing.streaming) return state;
    const message: WorkerChatMessage = existing
      ? { ...existing, body: existing.body + event.delta, streaming: true }
      : { id, turnId: event.turnId, body: event.delta, completedAt: Date.now(), terminalStatus: "", role: "worker", streaming: true, optimistic: false };
    return { ...state, messages: upsert(state.messages, message) };
  }

  const completed = event.kind === "item-completed";
  const role = event.item.type === "user-message" ? "you" as const : "worker" as const;
  const id = `${role === "you" ? "u" : "a"}:${event.turnId}:${event.item.id}`;
  let messages = state.messages;
  const clientId = event.item.type === "user-message" ? event.item.clientId : undefined;
  if (clientId) messages = messages.filter((message) => !(message.optimistic && message.clientId === clientId));
  const existing = messages.find((message) => message.id === id);
  if (!completed && existing && !existing.streaming) return messages === state.messages ? state : { ...state, messages };
  const resolvedClientId = clientId ?? existing?.clientId;
  const resolvedPhase = event.item.type === "agent-message" ? event.item.phase ?? existing?.phase : undefined;
  const message: WorkerChatMessage = {
    id, turnId: event.turnId, body: event.item.text,
    completedAt: event.atMs ?? existing?.completedAt ?? Date.now(), terminalStatus: existing?.terminalStatus ?? "",
    role, ...(resolvedClientId ? { clientId: resolvedClientId } : {}),
    ...(resolvedPhase ? { phase: resolvedPhase } : {}),
    ...(existing?.turnOrder === undefined ? {} : { turnOrder: existing.turnOrder }),
    ...(existing?.itemOrder === undefined ? {} : { itemOrder: existing.itemOrder }),
    streaming: !completed, optimistic: false,
  };
  return { ...state, messages: upsert(messages, message) };
}

export function receiveWorkerEvent(state: WorkerStreamState, envelope: WorkerEventEnvelope): WorkerStreamState {
  if (envelope.nickname !== state.nickname || envelope.requestId !== state.requestId || envelope.subscriptionId !== state.subscriptionId) return state;
  if (!state.snapshotPending) return applyEvent(state, envelope);
  const bytes = state.bufferedBytes + utf8Bytes(envelope);
  if (state.bufferedEvents.length + 1 > MAX_BUFFER_EVENTS || bytes > MAX_BUFFER_BYTES) {
    return { ...state, bufferedEvents: [], bufferedBytes: 0, overflow: true };
  }
  return { ...state, bufferedEvents: [...state.bufferedEvents, envelope], bufferedBytes: bytes };
}

export function applyWorkerSnapshot(state: WorkerStreamState, snapshot: WorkerSnapshot, recoveredTurnId?: string): WorkerStreamState {
  const open = new Set(snapshot.openTurnIds);
  const terminalMessages = snapshot.messages.filter((message) => !open.has(message.turnId)).map((message): WorkerChatMessage => ({
    ...message, role: message.role === "you" ? "you" : "worker", streaming: false, optimistic: false,
  }));
  let messages = state.messages;
  for (const message of terminalMessages) {
    if (message.clientId) messages = messages.filter((candidate) => !(candidate.optimistic && candidate.clientId === message.clientId));
    messages = upsert(messages, message);
  }
  const fullyObserved = new Set([
    ...state.observedTurnIds,
    ...state.bufferedEvents.flatMap((envelope) => envelope.event.kind === "turn-started" ? [envelope.event.turnId] : []),
  ]);
  const recovery = new Set(state.recoveryTurnIds);
  for (const turnId of snapshot.openTurnIds) if (!fullyObserved.has(turnId)) recovery.add(turnId);
  const recoveryConfirmed = recoveredTurnId !== undefined && snapshot.terminalTurnIds.includes(recoveredTurnId);
  if (recoveryConfirmed) recovery.delete(recoveredTurnId);
  let pendingRecoveryTurnIds = state.pendingRecoveryTurnIds;
  let recoveredTurnIds = state.recoveredTurnIds;
  if (recoveredTurnId) {
    if (recoveryConfirmed) {
      pendingRecoveryTurnIds = pendingRecoveryTurnIds.filter((id) => id !== recoveredTurnId);
      recoveredTurnIds = [...new Set([...recoveredTurnIds, recoveredTurnId])];
    } else if (!pendingRecoveryTurnIds.includes(recoveredTurnId)) {
      pendingRecoveryTurnIds = [...pendingRecoveryTurnIds, recoveredTurnId];
    }
  }
  let next: WorkerStreamState = {
    ...state, messages, bufferedEvents: [], bufferedBytes: 0, snapshotPending: false,
    historyInFlight: false, recoveryTurnIds: [...recovery], pendingRecoveryTurnIds, recoveredTurnIds,
    historyLoaded: true, hasOlder: snapshot.hasOlder, olderCursor: snapshot.nextCursor,
  };
  for (const envelope of state.bufferedEvents) next = applyEvent(next, envelope);
  return { ...next, messages: [...next.messages].sort(compareMessages) };
}

export function finishWorkerHistory(state: WorkerStreamState): WorkerStreamState {
  return { ...state, historyInFlight: false, snapshotPending: false };
}

export function failWorkerHistory(state: WorkerStreamState): WorkerStreamState {
  let next: WorkerStreamState = { ...state, historyInFlight: false, snapshotPending: false, bufferedEvents: [], bufferedBytes: 0 };
  for (const envelope of state.bufferedEvents) next = applyEvent(next, envelope);
  return next;
}

export function dequeueWorkerRecovery(state: WorkerStreamState): { state: WorkerStreamState; turnId?: string } {
  if (state.historyInFlight || state.pendingRecoveryTurnIds.length === 0) return { state };
  const [turnId, ...pendingRecoveryTurnIds] = state.pendingRecoveryTurnIds;
  return turnId === undefined ? { state } : { state: { ...state, pendingRecoveryTurnIds }, turnId };
}

export function drainWorkerRecoveryAfterAttempt(
  state: WorkerStreamState,
  attemptedTurnId: string | undefined,
  retryScheduled: boolean,
): { state: WorkerStreamState; turnId?: string } {
  if (attemptedTurnId && state.pendingRecoveryTurnIds.includes(attemptedTurnId)) {
    if (retryScheduled) return { state };
    state = { ...state, pendingRecoveryTurnIds: state.pendingRecoveryTurnIds.filter((id) => id !== attemptedTurnId) };
  }
  return dequeueWorkerRecovery(state);
}
