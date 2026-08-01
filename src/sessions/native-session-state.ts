export type NativeSessionStatus = "unknown" | "idle" | "active" | "error";

export interface NativeSessionIdentity {
  endpointId: string;
  threadId: string;
  mappingId: string;
}

export interface NativeSessionView {
  availability: "ready" | "unavailable";
  status: NativeSessionStatus;
  activeTurnId: string | null;
  // The session is busy with work that belongs to no turn — a Claude background command or
  // subagent still running after the turn that started it ended.
  //
  // This exists because `status: "active", activeTurnId: null` otherwise means two opposite
  // things: "busy, and there is genuinely no turn to name" versus "busy, and we have not
  // established which turn yet". The second is repaired by probing history for the active
  // turn and, failing that, declaring the state unknown — which for the first is both wrong
  // and unrecoverable, since no history read can ever reveal a turn that does not exist.
  backgroundWork: boolean;
  endpointGeneration: number;
  lifecycleRevision: number;
  receiveSequence: number;
  observedAt: number;
}

export interface NativeSessionSnapshot extends NativeSessionIdentity, NativeSessionView {}

export interface NativeRefreshToken extends NativeSessionIdentity {
  endpointGeneration: number;
  lifecycleRevision: number;
}

export type StartResponseDisposition = "active" | "terminal" | "refresh-required" | "stale-generation";

type Listener = (view: NativeSessionSnapshot, previous?: NativeSessionSnapshot) => void;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const string = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;

function nativeStatus(value: unknown): NativeSessionStatus {
  const raw = typeof value === "string" ? value : string(record(value)?.type);
  if (raw === "active" || raw === "inProgress" || raw === "running") return "active";
  if (raw === "idle" || raw === "notLoaded" || raw === "completed" || raw === "failed" || raw === "interrupted") return "idle";
  if (raw === "error" || raw === "systemError") return "error";
  return "unknown";
}

// Counts the provider reports alongside an active status for work that belongs to no turn.
// Absent for a provider that has no such concept, which is why absence means "no background
// work" rather than "unknown".
function hasNativeActivity(value: unknown): boolean {
  const activity = record(value);
  if (!activity) return false;
  return Object.values(activity).some((count) => typeof count === "number" && count > 0);
}

const keyOf = (identity: NativeSessionIdentity): string =>
  `${identity.endpointId}\u0000${identity.threadId}\u0000${identity.mappingId}`;

const threadKey = (endpointId: string, threadId: string): string => `${endpointId}\u0000${threadId}`;
const terminalKey = (generation: number, threadId: string, turnId: string): string => `${generation}\u0000${threadId}\u0000${turnId}`;

export class NativeSessionState {
  private readonly views = new Map<string, NativeSessionSnapshot>();
  private readonly byThread = new Map<string, Set<string>>();
  private readonly endpointSequences = new Map<string, number>();
  private readonly terminalTurns = new Map<string, Set<string>>();
  private readonly listeners = new Set<Listener>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  register(identity: NativeSessionIdentity, endpointGeneration: number): NativeSessionView {
    const key = keyOf(identity);
    const existing = this.views.get(key);
    if (existing?.endpointGeneration === endpointGeneration && existing.availability === "ready") return { ...existing };
    const view: NativeSessionSnapshot = {
      ...identity,
      availability: "ready",
      status: "unknown",
      activeTurnId: null,
      backgroundWork: false,
      endpointGeneration,
      lifecycleRevision: existing?.endpointGeneration === endpointGeneration ? existing.lifecycleRevision + 1 : 0,
      receiveSequence: this.currentSequence(identity.endpointId, endpointGeneration),
      observedAt: this.now(),
    };
    this.views.set(key, view);
    const index = this.byThread.get(threadKey(identity.endpointId, identity.threadId)) ?? new Set<string>();
    index.add(key);
    this.byThread.set(threadKey(identity.endpointId, identity.threadId), index);
    this.publish(view, existing);
    return this.publicView(view);
  }

  unregister(identity: NativeSessionIdentity): void {
    const key = keyOf(identity);
    const existing = this.views.get(key);
    if (!existing || !this.views.delete(key)) return;
    const indexKey = threadKey(identity.endpointId, identity.threadId);
    const index = this.byThread.get(indexKey);
    index?.delete(key);
    if (index?.size === 0) this.byThread.delete(indexKey);
    this.publish({
      ...existing,
      availability: "unavailable",
      status: "unknown",
      activeTurnId: null,
      backgroundWork: false,
      lifecycleRevision: existing.lifecycleRevision + 1,
      observedAt: this.now(),
    }, existing);
  }

  view(identity: NativeSessionIdentity): NativeSessionView | undefined {
    const view = this.views.get(keyOf(identity));
    return view ? this.publicView(view) : undefined;
  }

  list(endpointId?: string): NativeSessionSnapshot[] {
    return [...this.views.values()]
      .filter((view) => endpointId === undefined || view.endpointId === endpointId)
      .map((view) => ({ ...view }));
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  captureRefresh(identity: NativeSessionIdentity, endpointGeneration: number): NativeRefreshToken {
    const view = this.requiredCurrent(identity, endpointGeneration);
    return { ...identity, endpointGeneration, lifecycleRevision: view.lifecycleRevision };
  }

  captureStart(identity: NativeSessionIdentity, endpointGeneration: number): NativeRefreshToken {
    return this.captureRefresh(identity, endpointGeneration);
  }

  // `nativeActivity` is the same payload the notification carries, read here so a thread VIEW
  // establishes background work exactly as an event does. A reconnect settles state through
  // this path, not through notifications: without it the flag reverted to false on every
  // resume, and the identity repair that false enables then recorded the session as unknown.
  applyRefresh(
    token: NativeRefreshToken,
    observation: { status: unknown; activeTurnId?: string | null; nativeActivity?: unknown },
  ): boolean {
    const current = this.views.get(keyOf(token));
    if (!current || current.endpointGeneration !== token.endpointGeneration
      || current.lifecycleRevision !== token.lifecycleRevision || current.availability !== "ready") return false;
    const status = nativeStatus(observation.status);
    const activeTurnId = status === "active" ? observation.activeTurnId ?? current.activeTurnId : null;
    this.apply(current, {
      status,
      activeTurnId,
      backgroundWork: status === "active" && hasNativeActivity(observation.nativeActivity),
    });
    return true;
  }

  applyStartResponse(token: NativeRefreshToken, turnId: string): StartResponseDisposition {
    const current = this.views.get(keyOf(token));
    if (!current || current.endpointGeneration !== token.endpointGeneration || current.availability !== "ready") {
      return "stale-generation";
    }
    if (this.isTerminal(token.endpointId, token.endpointGeneration, token.threadId, turnId)) return "terminal";
    if (current.status === "active" && current.activeTurnId === turnId) return "active";
    if (current.lifecycleRevision !== token.lifecycleRevision) return "refresh-required";
    this.apply(current, { status: "active", activeTurnId: turnId });
    return "active";
  }

  observe(endpointId: string, endpointGeneration: number, method: string, params: unknown): boolean {
    const values = record(params);
    const threadId = string(values?.threadId);
    if (!threadId) return false;
    const keys = this.byThread.get(threadKey(endpointId, threadId));
    if (!keys) return false;
    const sequence = this.nextSequence(endpointId, endpointGeneration);
    const turn = record(values?.turn);
    const turnId = string(turn?.id);
    const directTurnId = string(values?.turnId);
    let refreshRequired = method === "turn/started" && !turnId;

    for (const key of keys) {
      const current = this.views.get(key);
      if (!current || current.endpointGeneration !== endpointGeneration || current.availability !== "ready") continue;
      if (method === "turn/started" && turnId) {
        if (this.isTerminal(endpointId, endpointGeneration, threadId, turnId)) continue;
        this.apply(current, { status: "active", activeTurnId: turnId, receiveSequence: sequence });
        continue;
      }
      if (method === "turn/completed" && turnId) {
        this.rememberTerminal(endpointId, endpointGeneration, threadId, turnId);
        if (current.activeTurnId === turnId) {
          this.apply(current, { status: "idle", activeTurnId: null, receiveSequence: sequence });
        } else if (current.status !== "idle") {
          // Preserve the possibly different active turn, but fence every response dispatched
          // before this terminal evidence. The requested refresh will settle current truth.
          this.apply(current, {
            status: current.status,
            activeTurnId: current.activeTurnId,
            receiveSequence: sequence,
          });
          refreshRequired = true;
        } else {
          // Even a completion whose start was missed is lifecycle evidence. Advance the revision
          // so an older read/resume response cannot resurrect the completed turn as active.
          this.apply(current, { status: "idle", activeTurnId: null, receiveSequence: sequence });
        }
        continue;
      }
      if (method.startsWith("item/") && directTurnId
        && !this.isTerminal(endpointId, endpointGeneration, threadId, directTurnId)) {
        this.apply(current, { status: "active", activeTurnId: directTurnId, receiveSequence: sequence });
        continue;
      }
      if (method === "thread/status/changed") {
        const status = nativeStatus(values?.status);
        const backgroundWork = status === "active" && hasNativeActivity(values?.nativeActivity);
        // Background work is a complete explanation for an active session that names no turn,
        // so it must NOT request the identity refresh: there is no turn for the refresh to
        // find, and its failure to find one is recorded as an unknown state that fails every
        // later operation on the session.
        if (status === "active" && current.activeTurnId === null && !backgroundWork) refreshRequired = true;
        this.apply(current, {
          status,
          activeTurnId: status === "active" ? current.activeTurnId : null,
          backgroundWork,
          receiveSequence: sequence,
        });
      }
    }
    return refreshRequired;
  }

  invalidateEndpoint(endpointId: string, endpointGeneration?: number): void {
    const sequenceGeneration = endpointGeneration ?? Math.max(0, ...this.list(endpointId).map((view) => view.endpointGeneration));
    const sequence = this.nextSequence(endpointId, sequenceGeneration);
    for (const current of this.views.values()) {
      if (current.endpointId !== endpointId || (endpointGeneration !== undefined && current.endpointGeneration !== endpointGeneration)) continue;
      this.apply(current, {
        availability: "unavailable",
        status: "unknown",
        activeTurnId: null,
        backgroundWork: false,
        receiveSequence: sequence,
      });
    }
    this.terminalTurns.delete(`${endpointId}\u0000${sequenceGeneration}`);
  }

  private requiredCurrent(identity: NativeSessionIdentity, endpointGeneration: number): NativeSessionSnapshot {
    const current = this.views.get(keyOf(identity));
    if (!current || current.endpointGeneration !== endpointGeneration || current.availability !== "ready") {
      throw new Error(`native session generation is unavailable: ${identity.endpointId}/${identity.threadId}`);
    }
    return current;
  }

  private apply(current: NativeSessionSnapshot, change: Partial<Pick<NativeSessionView, "availability" | "status" | "activeTurnId" | "backgroundWork" | "receiveSequence">>): void {
    const next: NativeSessionSnapshot = {
      ...current,
      ...change,
      lifecycleRevision: current.lifecycleRevision + 1,
      observedAt: this.now(),
    };
    // Background work is a KIND of busy, so it cannot outlive being busy. A turn completing is
    // the ordinary way this state goes idle without any task event, and a flag left true there
    // suppresses identity repair for the mapping from then on.
    if (next.status !== "active") next.backgroundWork = false;
    this.views.set(keyOf(next), next);
    this.publish(next, current);
  }

  private publish(view: NativeSessionSnapshot, previous?: NativeSessionSnapshot): void {
    for (const listener of this.listeners) listener({ ...view }, previous ? { ...previous } : undefined);
  }

  private publicView(view: NativeSessionSnapshot): NativeSessionView {
    return {
      availability: view.availability,
      status: view.status,
      activeTurnId: view.activeTurnId,
      backgroundWork: view.backgroundWork,
      endpointGeneration: view.endpointGeneration,
      lifecycleRevision: view.lifecycleRevision,
      receiveSequence: view.receiveSequence,
      observedAt: view.observedAt,
    };
  }

  private currentSequence(endpointId: string, generation: number): number {
    return this.endpointSequences.get(`${endpointId}\u0000${generation}`) ?? 0;
  }

  private nextSequence(endpointId: string, generation: number): number {
    const key = `${endpointId}\u0000${generation}`;
    const value = (this.endpointSequences.get(key) ?? 0) + 1;
    this.endpointSequences.set(key, value);
    return value;
  }

  private rememberTerminal(endpointId: string, generation: number, threadId: string, turnId: string): void {
    const endpointKey = `${endpointId}\u0000${generation}`;
    const values = this.terminalTurns.get(endpointKey) ?? new Set<string>();
    values.add(terminalKey(generation, threadId, turnId));
    while (values.size > 1_000) values.delete(values.values().next().value!);
    this.terminalTurns.set(endpointKey, values);
  }

  private isTerminal(endpointId: string, generation: number, threadId: string, turnId: string): boolean {
    return this.terminalTurns.get(`${endpointId}\u0000${generation}`)?.has(terminalKey(generation, threadId, turnId)) ?? false;
  }
}
