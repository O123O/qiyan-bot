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
  live?: boolean;
}

export type WorkerChatItem =
  | { type: "user-message"; id: string; clientId?: string; text: string }
  | { type: "agent-message"; id: string; text: string; phase?: string };

export type WorkerChatEvent =
  | { kind: "stream-discontinuity" }
  | { kind: "turn-started"; turnId: string; status?: string }
  | { kind: "turn-completed"; turnId: string; status?: string }
  | { kind: "item-started" | "item-completed"; turnId: string; item: WorkerChatItem; atMs?: number }
  | { kind: "agent-message-delta"; turnId: string; itemId: string; delta: string };

export interface WorkerEventEnvelope {
  type: "worker/event";
  nickname: string;
  requestId: string;
  subscriptionId: string;
  streamId: string;
  seq: number;
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
  mappingId: string;
  provider: WorkerProvider;
  requestId: string;
  subscriptionId?: string;
  lastSeq: number;
  messages: WorkerChatMessage[];
  retainedMessageIds: string[];
  initialHistoryPending: boolean;
  recoveryTurnIds: string[];
  pendingRecoveryTurnIds: string[];
  reconcilePending: boolean;
  recoveredTurnIds: string[];
  observedTurnIds: string[];
  terminalTurns: Array<{ turnId: string; status: string }>;
  historyInFlight: boolean;
  historyLoaded: boolean;
  hasOlder: boolean;
  olderCursor: string | undefined;
  recentBoundaryPending: boolean;
}

const MAX_RETAINED_DRAFT_MESSAGES = 30;
const MAX_RETAINED_DRAFT_BYTES = 512 * 1024;
const MAX_RETAINED_WORKERS = 4;
const MAX_RETAINED_TOTAL_BYTES = 1024 * 1024;
const MAX_TERMINAL_TURNS = 50;
const MAX_TRACKED_TURN_IDS = 100;
const MAX_ACTIVE_MESSAGES = 1_000;
const MAX_ACTIVE_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_ACTIVE_MESSAGE_BODY_BYTES = 512 * 1024;
const LIVE_TRUNCATION_MARKER = "[earlier live output truncated by Web UI]\n";
const utf8Bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export type WorkerDraftCache = Map<string, WorkerChatMessage[]>;

export function beginWorkerSubscription(
  nickname: string,
  provider: WorkerProvider,
  requestId: string,
  retainedMessages: WorkerChatMessage[] = [],
  mappingId = "",
): WorkerStreamState {
  return {
    nickname, mappingId, provider, requestId, messages: [...retainedMessages], retainedMessageIds: retainedMessages.map((message) => message.id),
    lastSeq: 0,
    initialHistoryPending: false, recoveryTurnIds: [], pendingRecoveryTurnIds: [],
    reconcilePending: false,
    recoveredTurnIds: [], observedTurnIds: [], terminalTurns: [],
    historyInFlight: false, historyLoaded: false, hasOlder: false, olderCursor: undefined,
    recentBoundaryPending: false,
  };
}

export function beginWorkerReconnect(state: WorkerStreamState, requestId: string): WorkerStreamState {
  return {
    ...state,
    requestId,
    historyInFlight: false,
    initialHistoryPending: false,
  };
}

export function retainWorkerDraftMessages(state: WorkerStreamState): WorkerChatMessage[] {
  // A bounded native page is not proof that a previously observed live item does not exist. Keep the
  // recent foreground timeline across tab switches; mapping validation and stable item IDs make the
  // subsequent snapshot merge safe and deterministic.
  const candidates = state.messages;
  const retained: WorkerChatMessage[] = [];
  let bytes = 0;
  for (let index = candidates.length - 1; index >= 0 && retained.length < MAX_RETAINED_DRAFT_MESSAGES; index -= 1) {
    const message = candidates[index]!;
    const nextBytes = utf8Bytes(message);
    if (bytes + nextBytes > MAX_RETAINED_DRAFT_BYTES) break;
    retained.unshift(message);
    bytes += nextBytes;
  }
  return retained;
}

const retainedBytes = (messages: WorkerChatMessage[]): number => messages.reduce((total, message) => total + utf8Bytes(message), 0);

const workerDraftKey = (nickname: string, mappingId: string): string => `${nickname}\0${mappingId}`;

export function storeWorkerDraftMessages(cache: WorkerDraftCache, state: WorkerStreamState): void {
  const retained = retainWorkerDraftMessages(state);
  const key = workerDraftKey(state.nickname, state.mappingId);
  cache.delete(key);
  if (retained.length > 0) cache.set(key, retained);
  let totalBytes = [...cache.values()].reduce((total, messages) => total + retainedBytes(messages), 0);
  while (cache.size > MAX_RETAINED_WORKERS || totalBytes > MAX_RETAINED_TOTAL_BYTES) {
    const oldest = cache.entries().next().value as [string, WorkerChatMessage[]] | undefined;
    if (!oldest) break;
    cache.delete(oldest[0]);
    totalBytes -= retainedBytes(oldest[1]);
  }
}

export function takeWorkerDraftMessages(cache: WorkerDraftCache, nickname: string, mappingId: string): WorkerChatMessage[] {
  const key = workerDraftKey(nickname, mappingId);
  const retained = cache.get(key) ?? [];
  cache.delete(key);
  return retained;
}

export function acknowledgeWorkerSubscription(
  state: WorkerStreamState,
  subscriptionId: string,
  mappingId = state.mappingId,
  replay: { resumed?: boolean; replayGap?: boolean; latestSeq?: number } = {},
): WorkerStreamState {
  if (mappingId === state.mappingId) return {
    ...state,
    subscriptionId,
    lastSeq: replay.resumed ? (replay.replayGap ? replay.latestSeq ?? state.lastSeq : state.lastSeq) : 0,
  };
  const retainedIds = new Set(state.retainedMessageIds);
  return {
    ...state, mappingId, subscriptionId, lastSeq: 0,
    messages: state.messages.filter((message) => !retainedIds.has(message.id)),
    retainedMessageIds: [],
  };
}

export function beginWorkerHistory(state: WorkerStreamState, initialHistory: boolean): { state: WorkerStreamState; started: boolean } {
  if (state.historyInFlight) return { state, started: false };
  return { state: { ...state, historyInFlight: true, initialHistoryPending: state.initialHistoryPending || initialHistory }, started: true };
}

export function addOptimisticWorkerMessage(state: WorkerStreamState, clientId: string, body: string, at: number): WorkerStreamState {
  const message: WorkerChatMessage = {
    id: `optimistic:${clientId}`, turnId: "", body, completedAt: at, terminalStatus: "",
    role: "you", clientId, streaming: false, optimistic: true,
    live: true,
  };
  return { ...state, messages: capMessages(upsert(state.messages.filter((candidate) => candidate.clientId !== clientId), message)) };
}

export function removeOptimisticWorkerMessage(state: WorkerStreamState, clientId: string): WorkerStreamState {
  return { ...state, messages: state.messages.filter((message) => !(message.optimistic && message.clientId === clientId)) };
}

function upsert(messages: WorkerChatMessage[], message: WorkerChatMessage): WorkerChatMessage[] {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index < 0) return [...messages, message];
  const next = [...messages]; next[index] = message; return next;
}

function mergeSnapshotMessage(messages: WorkerChatMessage[], snapshot: WorkerChatMessage): WorkerChatMessage[] {
  let index = messages.findIndex((candidate) => candidate.id === snapshot.id);
  if (index < 0 && snapshot.clientId) {
    index = messages.findIndex((candidate) => candidate.clientId === snapshot.clientId && candidate.role === snapshot.role);
  }
  if (index < 0) {
    const matches = messages.map((candidate, candidateIndex) => ({ candidate, candidateIndex })).filter(({ candidate }) => (
      candidate.turnId === snapshot.turnId && candidate.role === snapshot.role
      && candidate.body === snapshot.body && (candidate.phase ?? "") === (snapshot.phase ?? "")
    ));
    if (matches.length === 1) index = matches[0]!.candidateIndex;
  }
  if (index < 0) return [...messages, snapshot];
  const existing = messages[index]!;
  let merged = snapshot;
  if (existing.live) {
    const snapshotTerminal = ["completed", "failed", "interrupted"].includes(snapshot.terminalStatus);
    if (!existing.streaming || !snapshotTerminal) {
      merged = {
        ...snapshot,
        id: existing.id,
        body: existing.streaming ? mergeStreamingText(snapshot.body, existing.body) : existing.body,
        completedAt: snapshot.completedAt || existing.completedAt,
        terminalStatus: existing.terminalStatus || snapshot.terminalStatus,
        streaming: existing.streaming,
        optimistic: false,
        live: true,
        ...(existing.clientId ? { clientId: existing.clientId } : {}),
        ...(existing.phase ? { phase: existing.phase } : {}),
      };
    }
  }
  const next = [...messages];
  next[index] = merged;
  return next;
}

function mergeStreamingText(history: string, live: string): string {
  if (!history) return live;
  if (!live) return history;
  if (live.startsWith(history)) return live;
  if (history.startsWith(live)) return history;
  const maximum = Math.min(history.length, live.length);
  for (let overlap = maximum; overlap > 0; overlap -= 1) {
    if (history.endsWith(live.slice(0, overlap))) return history + live.slice(overlap);
  }
  return history + live;
}

function capMessages(messages: WorkerChatMessage[]): WorkerChatMessage[] {
  const bounded = messages.map(capMessageBody);
  const retained: WorkerChatMessage[] = [];
  let bytes = 0;
  for (let index = bounded.length - 1; index >= 0 && retained.length < MAX_ACTIVE_MESSAGES; index -= 1) {
    const message = bounded[index]!;
    const nextBytes = utf8Bytes(message);
    if (bytes + nextBytes > MAX_ACTIVE_MESSAGE_BYTES) break;
    retained.unshift(message);
    bytes += nextBytes;
  }
  return retained;
}

function capMessageBody(message: WorkerChatMessage): WorkerChatMessage {
  const encoded = new TextEncoder().encode(message.body);
  if (encoded.byteLength <= MAX_ACTIVE_MESSAGE_BODY_BYTES) return message;
  const markerBytes = new TextEncoder().encode(LIVE_TRUNCATION_MARKER).byteLength;
  const tail = encoded.subarray(encoded.byteLength - (MAX_ACTIVE_MESSAGE_BODY_BYTES - markerBytes));
  return { ...message, body: LIVE_TRUNCATION_MARKER + new TextDecoder().decode(tail) };
}

function queueRecovery(state: WorkerStreamState, turnId: string): WorkerStreamState {
  if (state.recoveredTurnIds.includes(turnId) || state.pendingRecoveryTurnIds.includes(turnId)) return state;
  return { ...state, pendingRecoveryTurnIds: [...state.pendingRecoveryTurnIds, turnId].slice(-MAX_TRACKED_TURN_IDS) };
}

function rememberTerminalTurn(state: WorkerStreamState, turnId: string, status: string): WorkerStreamState {
  const terminalTurns = [
    ...state.terminalTurns.filter((turn) => turn.turnId !== turnId),
    { turnId, status },
  ].slice(-MAX_TERMINAL_TURNS);
  return { ...state, terminalTurns };
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
  if (event.kind === "stream-discontinuity") return { ...state, reconcilePending: true };
  if (event.kind === "turn-started") return state.observedTurnIds.includes(event.turnId)
    ? state
    : { ...state, observedTurnIds: [...state.observedTurnIds, event.turnId].slice(-MAX_TRACKED_TURN_IDS) };
  if (event.kind === "turn-completed") {
    const terminalStatus = event.status ?? "completed";
    let next = rememberTerminalTurn({
      ...state,
      // Turn completion proves the turn status, not that every item draft was delivered. Keep
      // unfinished items streaming so the durable terminal snapshot replaces their partial body.
      messages: state.messages.map((message) => message.turnId === event.turnId ? { ...message, terminalStatus } : message),
    }, event.turnId, terminalStatus);
    next = queueRecovery(next, event.turnId);
    return next;
  }
  if (event.kind === "agent-message-delta") {
    const id = `a:${event.turnId}:${event.itemId}`;
    const existing = state.messages.find((message) => message.id === id);
    if (existing && !existing.streaming) return state;
    const message: WorkerChatMessage = existing
      ? { ...existing, body: existing.body + event.delta, streaming: true, live: true }
      : { id, turnId: event.turnId, body: event.delta, completedAt: Date.now(), terminalStatus: "", role: "worker", streaming: true, optimistic: false, live: true };
    return { ...state, messages: capMessages(upsert(state.messages, message)) };
  }

  const completed = event.kind === "item-completed";
  const role = event.item.type === "user-message" ? "you" as const : "worker" as const;
  const id = `${role === "you" ? "u" : "a"}:${event.turnId}:${event.item.id}`;
  let messages = state.messages;
  const clientId = event.item.type === "user-message" ? event.item.clientId : undefined;
  const correlated = clientId
    ? messages.find((message) => message.clientId === clientId && message.role === role)
    : undefined;
  if (clientId) messages = messages.filter((message) => message.id === id || message.clientId !== clientId || message.role !== role);
  const existingById = messages.find((message) => message.id === id);
  const existing = existingById ?? correlated;
  if (!completed && existingById && !existingById.streaming) return messages === state.messages ? state : { ...state, messages };
  const resolvedClientId = clientId ?? existing?.clientId;
  const resolvedPhase = event.item.type === "agent-message" ? event.item.phase ?? existing?.phase : undefined;
  const message: WorkerChatMessage = {
    id, turnId: event.turnId, body: event.item.text,
    completedAt: event.atMs ?? existing?.completedAt ?? Date.now(), terminalStatus: existing?.terminalStatus ?? "",
    role, ...(resolvedClientId ? { clientId: resolvedClientId } : {}),
    ...(resolvedPhase ? { phase: resolvedPhase } : {}),
    ...(existing?.turnOrder === undefined ? {} : { turnOrder: existing.turnOrder }),
    ...(existing?.itemOrder === undefined ? {} : { itemOrder: existing.itemOrder }),
    streaming: !completed, optimistic: false, live: true,
  };
  return { ...state, messages: capMessages(upsert(messages, message)) };
}

export function receiveWorkerEvent(state: WorkerStreamState, envelope: WorkerEventEnvelope): WorkerStreamState {
  if (envelope.nickname !== state.nickname || envelope.requestId !== state.requestId
    || envelope.subscriptionId !== state.subscriptionId || envelope.streamId !== state.subscriptionId
    || !Number.isSafeInteger(envelope.seq) || envelope.seq <= 0 || envelope.seq <= state.lastSeq) return state;
  const gap = state.lastSeq > 0 && envelope.seq !== state.lastSeq + 1;
  const next = applyEvent(state, envelope);
  return { ...next, lastSeq: envelope.seq, reconcilePending: next.reconcilePending || gap };
}

export function applyWorkerSnapshot(
  state: WorkerStreamState,
  snapshot: WorkerSnapshot,
  recoveredTurnId?: string,
  preserveOlderCursor = false,
): WorkerStreamState {
  const open = new Set(snapshot.openTurnIds);
  const liveTerminalStatus = new Map(state.terminalTurns.map((turn) => [turn.turnId, turn.status]));
  const initialSnapshot = state.initialHistoryPending;
  const fullyObserved = new Set(state.observedTurnIds);
  const snapshotMessages = snapshot.messages.map((message): WorkerChatMessage => ({
    ...message,
    role: message.role === "you" ? "you" : "worker",
    terminalStatus: open.has(message.turnId) ? liveTerminalStatus.get(message.turnId) ?? "" : message.terminalStatus,
    streaming: false,
    optimistic: false,
    live: false,
  }));
  let messages = state.messages;
  for (const message of snapshotMessages) {
    if (message.clientId) messages = messages.filter((candidate) => !(candidate.optimistic && candidate.clientId === message.clientId));
    messages = mergeSnapshotMessage(messages, message);
  }
  const recovery = new Set(state.recoveryTurnIds);
  if (initialSnapshot) {
    for (const turnId of snapshot.openTurnIds) if (!fullyObserved.has(turnId)) recovery.add(turnId);
  }
  const recoveryConfirmed = recoveredTurnId !== undefined && snapshot.terminalTurnIds.includes(recoveredTurnId);
  const firstHistory = !state.historyLoaded;
  let recentBoundaryPending = state.recentBoundaryPending;
  if (firstHistory) {
    recentBoundaryPending = snapshot.hasOlder && snapshot.terminalTurnIds.length === 0;
  } else if (recentBoundaryPending && (!snapshot.hasOlder || snapshot.terminalTurnIds.length > 0)) {
    recentBoundaryPending = false;
  }
  if (recoveryConfirmed) recovery.delete(recoveredTurnId);
  let pendingRecoveryTurnIds = state.pendingRecoveryTurnIds;
  let recoveredTurnIds = state.recoveredTurnIds;
  if (recoveredTurnId) {
    if (recoveryConfirmed) {
      pendingRecoveryTurnIds = pendingRecoveryTurnIds.filter((id) => id !== recoveredTurnId);
      recoveredTurnIds = [...new Set([...recoveredTurnIds, recoveredTurnId])].slice(-MAX_TRACKED_TURN_IDS);
    } else if (!pendingRecoveryTurnIds.includes(recoveredTurnId)) {
      pendingRecoveryTurnIds = [...pendingRecoveryTurnIds, recoveredTurnId];
    }
  }
  let next: WorkerStreamState = {
    ...state, messages, retainedMessageIds: [], initialHistoryPending: false,
    reconcilePending: state.reconcilePending,
    historyInFlight: false, recoveryTurnIds: [...recovery], pendingRecoveryTurnIds, recoveredTurnIds,
    historyLoaded: true,
    hasOlder: preserveOlderCursor ? state.hasOlder : snapshot.hasOlder,
    olderCursor: preserveOlderCursor ? state.olderCursor : snapshot.nextCursor,
    recentBoundaryPending,
  };
  return { ...next, messages: capMessages([...next.messages].sort(compareMessages)) };
}

export function finishWorkerHistory(state: WorkerStreamState): WorkerStreamState {
  return { ...state, historyInFlight: false, initialHistoryPending: false };
}

export function failWorkerHistory(state: WorkerStreamState): WorkerStreamState {
  return { ...state, historyInFlight: false, initialHistoryPending: false };
}

export function dequeueWorkerRecovery(state: WorkerStreamState): { state: WorkerStreamState; turnId?: string; reconcileLatest?: true } {
  if (state.historyInFlight) return { state };
  if (state.reconcilePending) return { state: { ...state, reconcilePending: false }, reconcileLatest: true };
  if (state.pendingRecoveryTurnIds.length === 0) return { state };
  const [turnId, ...pendingRecoveryTurnIds] = state.pendingRecoveryTurnIds;
  return turnId === undefined ? { state } : { state: { ...state, pendingRecoveryTurnIds }, turnId };
}

export function drainWorkerRecoveryAfterAttempt(
  state: WorkerStreamState,
  attemptedTurnId: string | undefined,
  retryScheduled: boolean,
): { state: WorkerStreamState; turnId?: string; reconcileLatest?: true } {
  if (attemptedTurnId && state.pendingRecoveryTurnIds.includes(attemptedTurnId)) {
    if (retryScheduled) return { state };
    state = { ...state, pendingRecoveryTurnIds: state.pendingRecoveryTurnIds.filter((id) => id !== attemptedTurnId) };
  }
  return dequeueWorkerRecovery(state);
}
