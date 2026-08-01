// ManagedAppServerEndpoint-shaped adapter over a ClaudeHost.
//
// Model: one endpoint per host, multiplexing many sessions; threadId === Claude session
// id. `thread/start` reserves a session id and returns a synthetic idle thread — no
// session is loaded yet. `turn/start` opens the session on the host if needed and hands
// the message to its long-lived SDK query; the host's events drive `turn/started`,
// live `item/completed`, and `turn/completed` directly, rather than being inferred from
// transcript writes. `turn/interrupt` interrupts the running response and leaves the
// session usable.
//
// A QiYan turn id IS the caller's message uuid. The SDK preserves it into the native
// transcript as the user row's `uuid`, so the live stream and the reconstructed history
// agree on turn identity without QiYan writing a correlation marker into the transcript.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import { AppError } from "../core/errors.ts";
import { JsonRpcResponseError } from "../app-server/rpc-client.ts";
import type { PermissionBlockedEvent } from "../app-server/managed-endpoint.ts";
import { claudeMessagePhase, claudeNativeGoal, reconstructClaudeThread, type ClaudeThreadView } from "../sessions/claude-thread.ts";
import type { ClaudeArchiveStore } from "../sessions/claude-archives.ts";
import {
  CLAUDE_DEFAULT_REASONING_EFFORT,
  CLAUDE_REASONING_EFFORTS,
  claudeModelCatalog,
} from "./claude-models.ts";
import type { ClaudeCommandRunner } from "./claude-command-runner.ts";
import type { ClaudeHost } from "../claude-host/host.ts";
import type { HostEvent } from "../claude-host/protocol.ts";
import { ClaudeTranscriptHistory } from "./claude-history.ts";
import type { EndpointLossKind, EndpointLossReason, ManagedAppServerEndpoint, RuntimeIdentity } from "./types.ts";

interface ThreadState {
  cwd: string;
  threadSource?: string;
  materialized: boolean;                 // has at least one turn been run (transcript exists)?
  recoveryChecked: boolean;
  recovery?: Promise<void>;
  loaded: boolean;                       // is the session open on the host?
  // In-flight host.open, shared by every send that arrives while it is still resolving.
  opening?: Promise<void>;
  // Accepted turns that have not settled, oldest first. The SDK queues input while a turn
  // runs and executes it in order, so more than one can be outstanding and the head is the
  // one currently producing output.
  running: string[];
  // The last turn this endpoint saw complete normally, i.e. the newest turn the transcript
  // certainly holds. Native background output that arrives while the session is idle is
  // folded into that turn by reconstruction, so it is the only identity live and history
  // agree on for it.
  lastTurnId?: string;
  terminalTurns: Set<string>;            // turn ids known interrupted/failed
  // Assistant text this endpoint streamed, per turn, in the exact shape the terminal
  // notification carries. See LIVE_TURN_ITEM_BYTES for why it is kept at all.
  liveItems: Map<string, LiveTurnItems>;
}

interface LiveTurnItems {
  items: Array<{ type: string; id: string; text: string; phase: string }>;
  bytes: number;
  // Past the byte cap this turn stops being retained and the terminal falls back to reading
  // the transcript. Truncated items would be worse than a slow read: they would deliver a
  // partial answer as if it were the whole one.
  overflowed: boolean;
}

// Enough for the handful of workers one endpoint drives at a time, small enough that an
// endpoint touched by dozens of threads does not keep a `claude` process for each.
// Bounded tail scanned for the native goal marker. Generous enough that an active goal —
// which writes a Stop-hook row per continuation — always falls inside it, while never
// transferring a whole transcript over ssh on a status poll.
const GOAL_SCAN_TAIL_BYTES = 256 * 1024;
// How far back readNativeGoal will walk in total. A goal that scrolled out of one window is
// still a goal; a transcript with none pays this once per status read, so it stays modest.
const GOAL_SCAN_MAX_BYTES = 4 * 1024 * 1024;

// How long the DRAIN POLL waits for the host to confirm the tasks are gone — long enough to
// cover a stop that has to cross ssh and unwind a tool call. It does not bound the whole stop:
// the status read and the stop calls are transport requests with their own (much longer)
// deadline. They are issued concurrently and skipped entirely when nothing is running, so an
// interrupt of an ordinary turn pays one round trip rather than this budget.
const TASK_STOP_CONFIRMATION_MS = 5_000;

// Why the endpoint keeps a turn's assistant text at all, having already streamed it:
//
// `claude` reports a turn finished over its stream BEFORE it has appended that turn's last
// row to the transcript. A terminal that sends the relay to the transcript therefore races
// the write, and losing the race is silent and total — the turn reads as having no terminal
// row, which reconstruction can only interpret as `interrupted`, and every message in it is
// phased `commentary` because the row that would have been the final answer is not there yet.
// The relay then delivers nothing and warns that the turn was interrupted without a final
// response, while the worker's answer sits complete on screen.
//
// Streaming it is the same data, arriving earlier and from the process that produced it, so
// the terminal carries what it already knows instead of asking the disk to catch up. Item ids
// match the ones reconstruction assigns, so a later re-read dedups against these rather than
// double-delivering.
const LIVE_TURN_ITEM_BYTES = 512 * 1024;

const DEFAULT_LOADED_SESSION_BUDGET = 8;

// What a host that outlived QiYan still has for a thread: a turn mid-response, background work
// that belongs to no turn, or both. Absent entirely when the host does not hold the session.
export interface ClaudeReattachment {
  turnId?: string;
  activity?: { backgroundTasks: number; subagents: number };
}

export interface ClaudePersistentRuntime {
  start(): Promise<void>;
  closeConnection(): Promise<void>;
  shutdownRuntime(expectedIdentity: RuntimeIdentity): Promise<void>;
  runtimeIdentity(): Promise<RuntimeIdentity | undefined>;
  onUnavailable(listener: (kind: EndpointLossKind, reason?: EndpointLossReason) => void): () => void;
  // Reconnect-time reattach. The host already knows what is still running, so this only has
  // to report it — no process handles, PID markers, or transcript materialization scans.
  recoverTurn(threadId: string, cwd: string): Promise<ClaudeReattachment | undefined>;
  releaseThread(threadId: string): Promise<void>;
}

export class ClaudeCodeRuntime implements ManagedAppServerEndpoint {
  readonly id: string;
  readonly daemonless: boolean;
  private endpointState: "starting" | "ready" | "unavailable" | "stopped" = "starting";
  private readonly emitter = new EventEmitter();
  private readonly threads = new Map<string, ThreadState>();
  // Live background/subagent counts per session, fed by the host's task/set events and by
  // reattachment after a restart. Authoritative, not decorative: this is what makes a session
  // report active with no turn, and therefore what refuses its archive, unadopt, and restart.
  // A count lost here is a session archived on top of live work, so every path that ends the
  // work — session close, endpoint shutdown, archive, unsubscribe, a proven stop — clears it.
  private readonly taskActivity = new Map<string, { backgroundTasks: number; subagents: number }>();
  private readonly stateLoads = new Map<string, Promise<ThreadState>>();
  // Claude's own model list, read once a session is loaded and then reused (see models()).
  private modelCatalog?: unknown[];
  private readonly history: ClaudeTranscriptHistory;
  private persistentUnavailableSubscription?: () => void;
  private readonly hostSubscription: () => void;
  private lifecycleGeneration = 0;
  private evicting?: Promise<void>;
  private startingTurns = 0;

  constructor(private readonly options: {
    id: string;
    // Runs turns: one long-lived SDK query per loaded session, local or remote.
    host: ClaudeHost;
    // Reads the native transcript for durable history and session discovery. Claude's
    // JSONL stays the only durable conversation store.
    runner: ClaudeCommandRunner;
    // The endpoint-wide defaults from its endpoints.json entry; a per-turn model/effort
    // overrides them. Nothing else is imposed on a managed session — it is an ordinary
    // Claude Code session.
    launchFlags: { model?: string; effort?: string };
    persistentRuntime?: ClaudePersistentRuntime;
    // Emulated archive state (Claude has no native archive) — thread/archive tombstones a
    // thread here so thread/list (discover) hides it, matching Codex archive semantics.
    archives?: ClaudeArchiveStore;
    now?: () => number;
    // How many sessions may stay loaded on the host. Each one pins a live SDK query and the
    // `claude` child behind it, so without a ceiling a long-running QiYan holds one process
    // per thread it has ever driven.
    loadedSessionBudget?: number;
    // How long a stop waits for the host to confirm the tasks are gone. Overridden only by
    // tests that want the give-up path without waiting out the real bound.
    taskStopConfirmationMs?: number;
  }) {
    this.id = options.id;
    this.daemonless = options.persistentRuntime === undefined;
    this.history = new ClaudeTranscriptHistory(options.runner);
    this.emitter.setMaxListeners(100);
    this.hostSubscription = options.host.subscribe((event) => this.onHostEvent(event));
  }

  // Host events are the live source of truth for an active turn. They are translated
  // straight into the provider-neutral notifications the relay and Web UI already
  // consume, so no consumer learns that Claude is behind them.
  private onHostEvent(event: HostEvent): void {
    const threadId = event.sessionId;
    const state = this.threads.get(threadId);
    if (!state) return;
    // The host no longer has this session — its query ended, or it was evicted. Its
    // in-flight turns arrive settled just before this, so only the load belief is stale:
    // drop it, or the next turn would send into a session that is gone.
    if (event.type === "session/closed") {
      state.loaded = false;
      // Its background work went with it. Nothing will ever emit the task/set that retires
      // those counts, so leaving them behind reports the thread active forever — and a
      // thread that never returns to idle can never be archived, unadopted, or restarted.
      if (this.taskActivity.delete(threadId)) this.publishActivityStatus(threadId);
      // Its retained turn text can no longer be republished — the only consumer is a background
      // report from a session that no longer exists — so it is dead weight from here.
      state.liveItems.clear();
      return;
    }
    // Claude's own background work — backgrounded Bash and Task-tool subagents — is never
    // conversation: when it finishes the agent reports and that report is an ordinary
    // end-of-turn. It is republished only as a live activity indicator, so the Web UI can
    // show "2 background tasks, 1 subagent running" while a panel is open.
    if (event.type === "task/set") {
      const running = event.background + event.subagents;
      if (running > 0) this.taskActivity.set(threadId, { backgroundTasks: event.background, subagents: event.subagents });
      else this.taskActivity.delete(threadId);
      // Emitted as thread/status/changed, not only as the tasks notification: session status
      // is read from NativeSessionState, which tracks that method. Reporting the counts
      // without it left get_session_status and the idle proof still calling the session
      // idle, so a worker with a live subagent read as finished and archive would close the
      // session out from under it.
      if (state.running.length === 0) this.publishActivityStatus(threadId);
      this.emitter.emit("notification", "thread/tasks/updated", {
        threadId,
        background: event.background,
        subagents: event.subagents,
        descriptions: event.descriptions,
      });
      return;
    }
    // compact_session waits for a contextCompaction item and times out without one, which
    // left the manager's turn blocked on a reconciliation that never terminated. Claude
    // reports its own boundary, so publish that as the item the tool is waiting for.
    if (event.type === "session/compacted") {
      const turnId = state.running[0] ?? state.lastTurnId;
      if (!turnId) return;
      this.emitter.emit("notification", "item/completed", {
        threadId,
        turnId,
        item: { type: "contextCompaction", id: `${turnId}:compaction:${event.at}` },
      });
      return;
    }
    if (event.type === "content/assistant") {
      // Top-level assistant text with no turn running is a native background task reporting
      // in after its parent turn. Claude writes those rows after the last turn's rows, and
      // reconstruction folds them into that turn, so attributing them to it is what keeps
      // the live stream and the reconstructed history keyed the same way.
      const turnId = state.running[0] ?? state.lastTurnId;
      if (!turnId) return;
      // Intermediate text — what Claude says before a tool call — is delivered as it
      // arrives, not withheld until the turn ends. Phase comes from the same rule
      // reconstruction uses, so the live item and its reconstructed twin agree once the
      // Web UI merges them by id.
      const phase = claudeMessagePhase(event.message);
      for (const [index, text] of assistantTextBlocks(event.message).entries()) {
        const item = { type: "agentMessage", id: `${messageUuid(event.message) ?? turnId}:${index}`, text, phase };
        this.retainLiveItem(state, turnId, item);
        this.emitter.emit("notification", "item/completed", {
          threadId,
          turnId,
          item,
        });
      }
      return;
    }
    if (event.type !== "turn/completed") return;
    // A background task's result is a real end-of-turn, but it has no turn of its own:
    // Claude is answering a `<task-notification>` row, which reconstruction deliberately
    // does not start a turn on, so its output belongs to the turn it follows. Republish
    // THAT turn's terminal so the newly folded response is still delivered. Synthesizing an
    // id from the result message instead would hand the relay a turn no transcript can ever
    // hold: bounded retries, then a degraded endpoint and a spurious recovery warning.
    if (event.origin === "task-notification") {
      // A running turn will carry the folded output through its own completion.
      if (state.running.length > 0 || state.lastTurnId === undefined) return;
      this.emitter.emit("notification", "turn/completed", {
        threadId,
        turn: this.terminalTurnPayload(state, state.lastTurnId, "completed"),
      });
      return;
    }
    const turnId = event.uuid ?? state.running[0];
    if (!turnId) return;
    state.materialized = true;
    const wasHead = state.running[0] === turnId;
    state.running = state.running.filter((id) => id !== turnId);
    // The queue moved on: the next send is now the one producing output, and nothing else
    // would ever announce it.
    if (wasHead && state.running[0] !== undefined) this.announceHead(threadId, state.running[0]);
    if (event.status !== "completed") state.terminalTurns.add(turnId);
    // Only a normally completed turn is certain to be a findable transcript turn: a turn
    // that failed before `claude` wrote its user row exists only as a synthesized terminal.
    else state.lastTurnId = turnId;
    this.emitter.emit("notification", "turn/completed", {
      threadId,
      turn: this.terminalTurnPayload(state, turnId, event.status === "completed" ? "completed" : "interrupted"),
    });
    // Keep only what a later terminal can still refer to: the turns still running, and the
    // last completed one, which a background task's report republishes.
    for (const id of [...state.liveItems.keys()]) {
      if (!state.running.includes(id) && id !== state.lastTurnId) state.liveItems.delete(id);
    }
    // A completed turn means idle to every consumer, and that is wrong when the turn left a
    // subagent or backgrounded command behind: it will speak again unprompted. Restate the
    // session's real activity here, because the task/set that started the work fired while
    // the turn was still running and was therefore not published as a status.
    if (state.running.length === 0 && this.nativeActivityOf(threadId)) this.publishActivityStatus(threadId);
    this.sweepIdleSessions();
  }

  // A settled turn is the only moment a session can newly become evictable, so it is where
  // the loaded-session budget is applied. The host spares anything that can still produce
  // output — a running turn or a live background task — and announces each unload with
  // session/closed, which is what clears `loaded` above. Best effort: an unreachable host
  // has bigger problems than its session count, and the next turn tries again.
  private sweepIdleSessions(): void {
    if (this.endpointState !== "ready" || this.evicting || this.startingTurns > 0) return;
    this.evicting = this.options.host
      .evictIdle(this.options.loadedSessionBudget ?? DEFAULT_LOADED_SESSION_BUDGET)
      .then(() => undefined, () => undefined)
      .finally(() => { delete this.evicting; });
  }

  get state(): "starting" | "ready" | "unavailable" | "stopped" { return this.endpointState; }

  async start(): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    this.endpointState = "starting";
    if (this.options.persistentRuntime) {
      this.persistentUnavailableSubscription ??= this.options.persistentRuntime.onUnavailable((kind, reason) => {
        if (this.endpointState === "stopped") return;
        this.endpointState = "unavailable";
        this.emitter.emit("unavailable", kind, reason);
      });
      try {
        await this.options.persistentRuntime.start();
      } catch (error) {
        if (this.lifecycleGeneration === generation) this.endpointState = "unavailable";
        throw error;
      }
    }
    if (this.lifecycleGeneration !== generation) {
      await this.options.persistentRuntime?.closeConnection();
      return;
    }
    this.endpointState = "ready";
    this.emitter.emit("ready");
  }

  async closeConnection(): Promise<void> {
    this.lifecycleGeneration += 1;
    this.endpointState = "stopped";
    this.persistentUnavailableSubscription?.();
    delete this.persistentUnavailableSubscription;
    if (this.options.persistentRuntime) {
      // Only this client detaches; the remote host and its sessions keep running, which is
      // exactly what lets a remote turn outlive a QiYan restart. The thread map stays true.
      await this.options.persistentRuntime.closeConnection();
      return;
    }
    await this.options.host.shutdown();
    this.forgetLoadedSessions();
  }

  async shutdownRuntime(expected: RuntimeIdentity): Promise<void> {
    this.lifecycleGeneration += 1;
    this.endpointState = "stopped";
    this.persistentUnavailableSubscription?.();
    delete this.persistentUnavailableSubscription;
    if (this.options.persistentRuntime) await this.options.persistentRuntime.shutdownRuntime(expected);
    else await this.options.host.shutdown();
    // Both branches end the sessions themselves: the in-process host walks its own session
    // map, and the remote branch stops the host process that owned them.
    this.forgetLoadedSessions();
  }

  // Every session the host held is gone. This endpoint object outlives them — the manager
  // hands a builtin back unchanged across a restart, and a stopped endpoint is started in
  // place — so a thread still marked loaded would skip `host.open` on its next turn and
  // send into a session the host no longer has, failing UNKNOWN_SESSION for good.
  private forgetLoadedSessions(): void {
    for (const state of this.threads.values()) {
      state.loaded = false;
      // A turn that was running on a session that has since died can never be settled by a
      // host event, so leaving the reservation would wedge the thread as SESSION_BUSY.
      state.running = [];
      state.liveItems.clear();
    }
    // Claude's reported model list belongs to the host build that answered it; an operator
    // restarts an endpoint precisely to pick up an upgraded remote `claude`.
    delete this.modelCatalog;
    // The background work died with the sessions, and no task/set will ever arrive to retire
    // it. Keeping the counts would report every one of those threads active for good.
    this.taskActivity.clear();
  }

  async runtimeIdentity(): Promise<RuntimeIdentity | undefined> {
    return this.options.persistentRuntime?.runtimeIdentity();
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.emitter.on("notification", listener);
    return () => this.emitter.off("notification", listener);
  }
  onReady(listener: () => void): () => void {
    this.emitter.on("ready", listener);
    return () => this.emitter.off("ready", listener);
  }
  onUnavailable(listener: (kind: EndpointLossKind) => void): () => void {
    this.emitter.on("unavailable", listener);
    return () => this.emitter.off("unavailable", listener);
  }
  onPermissionBlocked(listener: (event: PermissionBlockedEvent) => void): () => void {
    this.emitter.on("permissionBlocked", listener);
    return () => this.emitter.off("permissionBlocked", listener);
  }

  async request<T>(method: string, params: unknown, _signal?: AbortSignal): Promise<T> {
    if (this.endpointState !== "ready") throw new AppError("ENDPOINT_UNAVAILABLE", `claude endpoint not ready: ${this.id}`);
    const args = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "thread/start": return this.threadStart(args) as T;
      case "thread/read": return this.threadRead(args) as unknown as T;
      case "thread/resume": return this.threadResume(args) as unknown as T;
      case "thread/turns/list": return await this.threadTurnsList(args) as T;
      case "turn/start": return await this.turnStart(args) as T;
      case "turn/interrupt": return await this.turnInterrupt(args) as T;
      case "thread/list": return await this.threadList(args) as T;
      case "thread/archive": {
        const id = typeof args.threadId === "string" ? args.threadId : "";
        const state = this.threads.get(id);
        if (id && this.options.persistentRuntime) await this.options.persistentRuntime.releaseThread(id);
        if (id && state?.loaded) await this.options.host.close(id);
        this.threads.delete(id);
        this.taskActivity.delete(id);
        // Claude has no native archive: tombstone the thread so discover hides it (Codex parity).
        if (id) this.options.archives?.add(this.id, id, this.options.now?.());
        return {} as T;
      }
      case "thread/unsubscribe": {
        const id = requireString(args.threadId, "threadId");
        if (this.threads.get(id)?.loaded) await this.options.host.close(id);
        if (this.options.persistentRuntime) await this.options.persistentRuntime.releaseThread(id);
        this.threads.delete(id);
        this.taskActivity.delete(id);
        return { status: "unsubscribed" } as T;
      }
      // The SDK can rename a session, but only ON the machine that holds its transcript, so
      // serving this needs a host method and therefore a protocol bump — which fails activation
      // for every remote host already running an older one until it is replaced by hand.
      // Until that is done deliberately, refuse: returning {} reported a rename that never
      // happened, and a caller cannot tell an unsupported operation from a silent no-op.
      case "thread/name/set":
        throw new AppError("UNSUPPORTED_CAPABILITY", "renaming a Claude session needs a host protocol bump");
      // Claude has no model-list API; return the curated catalog (Codex `{data,nextCursor}` shape)
      // so set_session_model / the model picker have real entries to validate against.
      case "model/list": return { data: await this.models(), nextCursor: null } as T;
      // A goal is Claude's own `/goal`, driven by its Stop hook. QiYan stores none and
      // reads the objective back out of the session's transcript, where the slash command
      // records it — so an installed goal is reported without a duplicate goal row, and it
      // survives a restart because the transcript does. Only a running goal's PROGRESS
      // (iterations, tokens) is unavailable; the SDK does not surface it.
      case "thread/goal/get": return { goal: await this.readNativeGoal(requireString(args.threadId, "threadId")) } as T;
      case "thread/goal/set": return await this.goalSet(args) as T;
      case "thread/goal/clear": return await this.goalClear(args) as T;
      // Claude's context compaction is its own `/compact` command, delivered like `/goal`.
      case "thread/compact/start": {
        await this.deliverGoalCommand(requireString(args.threadId, "threadId"), "/compact");
        return {} as T;
      }
      // Background work belongs to no turn, so turn/interrupt cannot name it. Stopping it is
      // what lets a session that is only running a subagent return to idle and be restarted.
      case "thread/tasks/stop": return await this.stopBackgroundWork(requireString(args.threadId, "threadId")) as T;
      case "turn/steer": return await this.turnSteer(args) as T;
      default: throw new AppError("UNSUPPORTED_CAPABILITY", `claude endpoint does not implement ${method}`);
    }
  }

  private threadStart(params: Record<string, unknown>): {
    thread: ClaudeThreadView;
    model?: string;
    reasoningEffort?: string;
  } {
    const cwd = requireString(params.cwd, "cwd");
    const threadSource = typeof params.threadSource === "string" ? params.threadSource : undefined;
    const id = randomUUID();
    this.threads.set(id, {
      cwd, materialized: false, recoveryChecked: true, loaded: false, running: [], terminalTurns: new Set(), liveItems: new Map(),
      ...(threadSource === undefined ? {} : { threadSource }),
    });
    return this.withCurrentSettings({
      id, cwd, itemsView: "full", status: { type: "idle" }, turns: [],
      ...(threadSource === undefined ? {} : { threadSource }),
      ...(this.options.launchFlags.model === undefined ? {} : { model: this.options.launchFlags.model }),
    });
  }

  private async threadRead(params: Record<string, unknown>): Promise<{ thread: ClaudeThreadView }> {
    const threadId = requireString(params.threadId, "threadId");
    const state = await this.ensureState(threadId);
    const projected = params.includeTurns === true
      ? await this.reconstruct(threadId, state)
      : this.stateOnlyThread(threadId, state);
    return { thread: params.includeTurns === true ? projected : { ...projected, turns: [] } };
  }

  private async threadResume(params: Record<string, unknown>): Promise<{
    thread: ClaudeThreadView;
    model?: string;
    reasoningEffort?: string;
  }> {
    const threadId = requireString(params.threadId, "threadId");
    const recoveryCwd = params.cwd === undefined ? undefined : requireString(params.cwd, "cwd");
    // Re-adopting a thread un-tombstones it (Codex parity: resuming an archived thread revives it).
    this.options.archives?.remove(this.id, threadId);
    const state = await this.ensureState(threadId, recoveryCwd);
    const projected = params.excludeTurns === true
      ? this.stateOnlyThread(threadId, state)
      : await this.reconstruct(threadId, state);
    return this.withCurrentSettings(
      params.excludeTurns === true ? { ...projected, turns: [] } : projected,
    );
  }

  private async ensureState(threadId: string, recoveryCwd?: string): Promise<ThreadState> {
    let state = this.threads.get(threadId);
    // Cold-start recovery: after a QiYan restart the in-memory map is empty, but the
    // Claude transcript is durable on disk. Rehydrate an unknown-but-on-disk session
    // (cwd read from the transcript itself) rather than falsely reporting it gone.
    // A reserved-but-unmaterialized thread (state present, materialized false) reads
    // as an empty idle thread. A truly unknown thread with no transcript reproduces
    // the exact Codex `no rollout` error so recovery paths behave.
    if (!state) {
      let loading = this.stateLoads.get(threadId);
      if (!loading) {
        loading = this.loadState(threadId, recoveryCwd);
        this.stateLoads.set(threadId, loading);
      }
      try {
        state = await loading;
      } finally {
        if (this.stateLoads.get(threadId) === loading) this.stateLoads.delete(threadId);
      }
    }
    if (!state.recoveryChecked) {
      state.recovery ??= this.recoverState(threadId, state);
      await state.recovery;
    }
    return state;
  }

  private async loadState(threadId: string, recoveryCwd?: string): Promise<ThreadState> {
    const cwd = await this.history.sessionCwd(threadId, "");
    if (cwd === undefined && recoveryCwd === undefined) throw noRollout(threadId);
    const state: ThreadState = {
      cwd: cwd ?? recoveryCwd!,
      materialized: cwd !== undefined,
      recoveryChecked: false,
      loaded: false,
      running: [],
      terminalTurns: new Set(),
      liveItems: new Map(),
    };
    this.threads.set(threadId, state);
    return state;
  }

  private async recoverState(threadId: string, state: ThreadState): Promise<void> {
    try {
      const recovered = await this.options.persistentRuntime?.recoverTurn(threadId, state.cwd);
      state.recoveryChecked = true;
      // The host kept running while QiYan was away; adopt its in-flight turn so the
      // relay still settles it when the host reports completion.
      if (recovered) {
        if (recovered.turnId !== undefined) state.running = [recovered.turnId];
        state.loaded = true;
        // And adopt its background work. Nothing else rebuilds this: task/set events only
        // report CHANGES, so work that merely continued across the restart would otherwise be
        // invisible, and the session would read idle to every archive and restart check.
        if (recovered.activity) {
          this.taskActivity.set(threadId, recovered.activity);
          this.publishActivityStatus(threadId);
        }
      }
    } finally {
      delete state.recovery;
    }
  }

  private withCurrentSettings(thread: ClaudeThreadView): {
    thread: ClaudeThreadView;
    model: string;
    reasoningEffort: string;
  } {
    return {
      thread,
      model: this.options.launchFlags.model ?? "default",
      reasoningEffort: this.options.launchFlags.effort ?? CLAUDE_DEFAULT_REASONING_EFFORT,
    };
  }

  private async reconstruct(threadId: string, knownState?: ThreadState): Promise<ClaudeThreadView> {
    const state = knownState ?? await this.ensureState(threadId);
    const records = state.materialized === false
      ? []
      : await this.history.recentRecords(threadId, state.cwd) ?? [];
    return reconstructClaudeThread({
      threadId, cwd: state.cwd, records,
      interruptedTurnIds: state.terminalTurns,
      ...(state.running[0] === undefined ? {} : { runningTurnId: state.running[0] }),
      ...(state.threadSource === undefined ? {} : { threadSource: state.threadSource }),
      ...(this.options.launchFlags.model === undefined ? {} : { model: this.options.launchFlags.model }),
    });
  }

  private async threadTurnsList(params: Record<string, unknown>): Promise<unknown> {
    const threadId = requireString(params.threadId, "threadId");
    const state = await this.ensureState(threadId);
    const limit = requirePositiveInteger(params.limit, "limit");
    const sortDirection = requireDirection(params.sortDirection);
    const itemsView = requireItemsView(params.itemsView);
    const page = await this.history.turnsPage(threadId, state.cwd, {
      ...(typeof params.cursor === "string" ? { cursor: params.cursor } : {}),
      limit,
      sortDirection,
      itemsView,
    });
    if (state.running.length === 0) return page;
    return {
      ...page,
      data: page.data.map((turn) => state.running.includes(turn.id)
        ? { ...turn, status: "inProgress" }
        : turn),
    };
  }

  private stateOnlyThread(threadId: string, state: ThreadState): ClaudeThreadView {
    // Reported only when no turn owns the session — the same rule publishActivityStatus
    // follows, and for the same reason. This view is what a reconnect settles state from, and
    // it is sent with its turns stripped: activity beside a running turn is therefore
    // indistinguishable from activity INSTEAD of one, and the consumer stops looking for the
    // turn's identity. It is still reported active here, by the turn.
    const activity = state.running.length > 0 ? undefined : this.nativeActivityOf(threadId);
    return {
      id: threadId,
      cwd: state.cwd,
      // Named here because this view is sent with its turns stripped, so a consumer cannot
      // read the running turn's identity out of them — and a turn executes before `claude`
      // flushes its user row, so looking for it in the transcript can find only the previous,
      // COMPLETED turn. That answer makes the identity probe record the session state as
      // unknown, after which every operation on the worker fails as if its endpoint were gone.
      ...(state.running[0] === undefined ? {} : { activeTurnId: state.running[0] }),
      // A session with a background task or subagent still running is NOT idle in any sense
      // the manager cares about: it will speak again without being prompted. Reporting it
      // as plain idle invited concluding the work was finished.
      status: { type: state.running.length > 0 || this.nativeActivityOf(threadId) ? "active" : "idle" },
      ...(activity === undefined ? {} : { nativeActivity: activity }),
      itemsView: "full",
      turns: [],
      ...(state.threadSource === undefined ? {} : { threadSource: state.threadSource }),
      ...(this.options.launchFlags.model === undefined ? {} : { model: this.options.launchFlags.model }),
    };
  }


  // Discover sessions for the endpoint (Claude has no thread/list API — enumerate the
  // transcript store via the runner). Emulated archive tombstones split the two `archived`
  // pages the discovery layer requests. One page, no cursor — Claude session counts are small.
  private async threadList(params: Record<string, unknown>): Promise<{ data: unknown[]; nextCursor: null }> {
    const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
    const wantArchived = params.archived === true;
    const metas = await this.options.runner.listThreads(cwd);
    const data = metas
      .filter((meta) => (this.options.archives?.has(this.id, meta.id) ?? false) === wantArchived)
      // status/turns are REQUIRED by adoption: SessionLifecycle reads thread.status.type on
      // this row before it resumes the thread, so omitting them threw a TypeError and made
      // adopt_session — and the adopt leg of crash recovery — fail outright. A discovery row
      // has no live state to report, and the true status is re-read by thread/resume, so
      // idle-with-no-turns is the honest placeholder rather than a claim.
      .map((meta) => ({
        id: meta.id,
        cwd: meta.cwd,
        updatedAt: meta.updatedAt,
        preview: meta.preview,
        status: { type: "idle" as const },
        turns: [],
      }));
    return { data, nextCursor: null };
  }

  private async turnStart(params: Record<string, unknown>): Promise<{ turn: { id: string; status: string } }> {
    const threadId = requireString(params.threadId, "threadId");
    const state = this.threads.get(threadId);
    if (!state) throw noRollout(threadId);
    // No SESSION_BUSY. The SDK accepts input while a turn runs and executes it in order,
    // so a second send is queued rather than refused — that native queue is why the
    // persistent host exists, and refusing here was a `claude -p` limitation.
    const clientId = requireString(params.clientUserMessageId, "clientUserMessageId");
    const message = inputToText(params.input);
    // A driven turn revives an (emulated) archived thread — clear the tombstone (Codex parity).
    this.options.archives?.remove(this.id, threadId);

    // Reserve the turn BEFORE the first await: opening and sending both suspend, and a
    // second turn/start slipping through in between would orphan this one and lose
    // interrupt control over it.
    state.running.push(clientId);
    // Everything below is fenced against a concurrent closeConnection/archive: a session
    // opened after the endpoint stopped would outlive it (host.shutdown has already walked
    // its session map), running a turn nobody can observe or interrupt.
    const generation = this.lifecycleGeneration;
    const current = (): boolean =>
      this.lifecycleGeneration === generation && this.threads.get(threadId) === state;
    let accepted: boolean;
    let alreadySettled = false;
    // A session is idle on the host between being opened and taking this message, so an
    // eviction sweep racing that window would unload it out from under the send.
    this.startingTurns += 1;
    try {
      // Lazily load the session. `materialized` distinguishes creating the caller-chosen
      // native session id from resuming one that already exists on disk.
      // Sends now queue instead of being refused, so several can reach this line before the
      // first open resolves. They share one open: opening twice would race two SDK queries
      // onto the same native session id.
      if (!state.loaded) {
        state.opening ??= this.options.host.open({
          sessionId: threadId,
          mode: state.materialized ? "resume" : "create",
          cwd: state.cwd,
          ...(typeof params.model === "string"
            ? { model: params.model }
            : this.options.launchFlags.model === undefined ? {} : { model: this.options.launchFlags.model }),
          ...(typeof params.effort === "string"
            ? { effort: params.effort }
            : this.options.launchFlags.effort === undefined ? {} : { effort: this.options.launchFlags.effort }),
        }).then(() => { state.loaded = true; })
          .finally(() => { delete state.opening; });
        await state.opening;
      }
      // Per-session model/effort: `service.send` spreads the sticky settings into these
      // params, and an already-loaded session takes them through the live query rather
      // than a relaunch.
      if (typeof params.model === "string") await this.options.host.setModel(threadId, params.model);
      if (typeof params.effort === "string") await this.options.host.setEffort(threadId, params.effort);
      if (!current()) await this.abandonStartingTurn(threadId, state);

      // The uuid IS the turn id: the SDK preserves it into the transcript's user row, so
      // the live stream and reconstructed history agree without a correlation marker.
      accepted = await this.options.host.send(threadId, clientId, message);
      if (!current()) await this.abandonStartingTurn(threadId, state);
      // A refused send only says the host has seen this uuid before; it never forgets one.
      // That means "still running" only while the host still has it in flight — a retry
      // whose turn already ran (a scheduled fire re-armed from the outbox after a crash,
      // reusing its single-fire key) would otherwise adopt a reservation no event can ever
      // clear, wedging the thread as SESSION_BUSY and dropping the message silently.
      if (!accepted) {
        const status = await this.options.host.status(threadId);
        if (!current()) await this.abandonStartingTurn(threadId, state);
        alreadySettled = !status.inFlightTurns.includes(clientId);
      }
    } catch (error) {
      state.running = state.running.filter((id) => id !== clientId);
      throw error;
    } finally {
      this.startingTurns -= 1;
    }
    if (accepted) {
      // turn/started ONLY for the turn actually executing. A queued send announced as
      // started makes it the tracked active turn, and an interrupt then names the queued
      // uuid while the SDK aborts the executing head — killing the wrong work and marking
      // the survivor terminal. The queued one is announced when it reaches the head.
      if (state.running[0] === clientId) this.announceHead(threadId, clientId);
      // The user's message is shown immediately even while queued, so a follow-up sent
      // during a long turn does not vanish from the panel until that turn ends.
      this.emitter.emit("notification", "item/started", {
        threadId,
        turnId: clientId,
        item: {
          type: "userMessage",
          id: clientId,
          clientId,
          content: [{ type: "text", text: message, text_elements: [] }],
        },
      });
      return { turn: { id: clientId, status: "inProgress" } };
    }
    if (!alreadySettled) return { turn: { id: clientId, status: "inProgress" } };
    // The duplicate's turn is over. Release the reservation and republish its terminal, so
    // the response it produced while QiYan was away is still delivered instead of lost.
    state.running = state.running.filter((id) => id !== clientId);
    state.materialized = true;
    state.lastTurnId = clientId;
    this.emitter.emit("notification", "turn/completed", { threadId, turn: { id: clientId } });
    return { turn: { id: clientId, status: "completed" } };
  }

  // A turn whose endpoint changed mid-start must not be left running on the host: closing
  // the session ends its query, which settles any message already accepted as interrupted
  // instead of leaving it to produce output nothing is listening for. The thread is marked
  // unloaded so a later turn reopens it rather than sending into a session that is gone.
  private async abandonStartingTurn(threadId: string, state: ThreadState): Promise<never> {
    state.loaded = false;
    try { await this.options.host.close(threadId); } catch { /* the host may already be gone */ }
    throw new AppError("ENDPOINT_UNAVAILABLE", `claude endpoint changed while its turn was starting: ${threadId}`);
  }

  // The manager's set_goal installs Claude's own goal by delivering `/goal <objective>`;
  // its Stop hook then drives the session until the condition is met. QiYan keeps no goal
  // row, so the returned projection is synthesized for the caller, not persisted.
  //
  // Native `/goal` has no pause/resume: without stored state there is no objective to
  // reinstate, so a status-only change is refused rather than silently dropped.
  private async goalSet(params: Record<string, unknown>): Promise<{ goal: unknown }> {
    const threadId = requireString(params.threadId, "threadId");
    const objective = typeof params.objective === "string" ? params.objective.trim() : "";
    if (objective.length === 0) {
      throw new AppError("UNSUPPORTED_CAPABILITY",
        "claude goals are native /goal: set an objective, or clear it — pause/resume has no native equivalent");
    }
    await this.deliverGoalCommand(threadId, `/goal ${objective}`);
    return { goal: { objective, status: "active" } };
  }

  // The models Claude itself reports, which is the only source that knows which EFFORT levels
  // each model actually supports — the static catalog asserts the same set for every model, so
  // set_session_model would accept an effort a model does not offer.
  //
  // model/list is endpoint-scoped and the SDK answers per session, so this asks whichever
  // session is loaded and remembers the answer: the set does not vary by session, and without
  // remembering it the picker would report different models depending on what happened to be
  // open. Falls back to the catalog until a session has ever been loaded.
  private async models(): Promise<unknown[]> {
    if (this.modelCatalog) return this.modelCatalog;
    // The catalog is the FLOOR, never replaced by what Claude reports. It is what guarantees a
    // `default` row — the documented way to clear a model override — the endpoint's pinned
    // alias, and exactly one isDefault. Claude reports concrete ids, so replacing the catalog
    // with them makes `default` unknown, and `set_reasoning_effort` looks the session's CURRENT
    // model up in this list: a Claude endpoint with no pinned model reports that as the literal
    // "default", so replacing would break setting effort on the default configuration of every
    // Claude endpoint. Live rows are overlaid onto it for the one thing only they know.
    const catalog = claudeModelCatalog(this.options.launchFlags.model);
    const loaded = [...this.threads].find(([, state]) => state.loaded)?.[0];
    const reported = loaded === undefined
      ? undefined
      : await this.options.host.models(loaded).catch(() => undefined);
    if (!reported || reported.length === 0) return catalog;
    const live = new Map<string, { displayName?: string; efforts: string[] }>();
    for (const model of reported) {
      const row = model as { value?: unknown; resolvedModel?: unknown; displayName?: unknown; supportedEffortLevels?: unknown };
      if (typeof row.value !== "string" || row.value.length === 0) continue;
      const entry = {
        ...(typeof row.displayName === "string" && row.displayName.length > 0 ? { displayName: row.displayName } : {}),
        efforts: Array.isArray(row.supportedEffortLevels)
          ? row.supportedEffortLevels.filter((effort): effort is string => typeof effort === "string")
          : [],
      };
      live.set(row.value, entry);
      // An alias row names the wire id it resolves to, so a catalog entry keyed either way finds it.
      if (typeof row.resolvedModel === "string" && row.resolvedModel.length > 0 && !live.has(row.resolvedModel)) {
        live.set(row.resolvedModel, entry);
      }
    }
    const merged = catalog.map((entry) => {
      const match = live.get(entry.id);
      if (!match || match.efforts.length === 0) return entry;
      return {
        ...entry,
        ...(match.displayName === undefined ? {} : { displayName: match.displayName }),
        supportedReasoningEfforts: match.efforts.map((reasoningEffort) => ({ reasoningEffort })),
        // Keep the configured default when the model offers it; otherwise the CHEAPEST it
        // offers, because a model silently defaulted to its most expensive level is a surprise
        // nobody asked for.
        defaultReasoningEffort: match.efforts.includes(entry.defaultReasoningEffort)
          ? entry.defaultReasoningEffort
          : cheapestEffort(match.efforts),
      };
    });
    const known = new Set(catalog.map((entry) => entry.id));
    for (const [id, match] of live) {
      if (known.has(id) || match.efforts.length === 0) continue;
      known.add(id);
      merged.push({
        id,
        model: id,
        displayName: match.displayName ?? id,
        hidden: false,
        supportedReasoningEfforts: match.efforts.map((reasoningEffort) => ({ reasoningEffort })),
        defaultReasoningEffort: match.efforts.includes(CLAUDE_DEFAULT_REASONING_EFFORT)
          ? CLAUDE_DEFAULT_REASONING_EFFORT
          : cheapestEffort(match.efforts),
        isDefault: false,
      });
    }
    this.modelCatalog = merged;
    return merged;
  }

  // The live background/subagent set the host tracks for this session. Undefined when the
  // session is not loaded or nothing is running, so callers cannot mistake "none" for
  // "unknown" — a loaded session with no tasks reports no activity rather than a zero.
  private nativeActivityOf(threadId: string): { backgroundTasks: number; subagents: number } | undefined {
    const tasks = this.taskActivity.get(threadId);
    return tasks && (tasks.backgroundTasks > 0 || tasks.subagents > 0) ? tasks : undefined;
  }

  // Stops every background task and subagent the session still has running, and proves it.
  // The SDK gives each one an id and a targeted stopTask, so this is exact rather than a
  // session teardown.
  //
  // `remaining` is the point of the return, not `stopped`: the caller's next move is an archive
  // or a restart, and both are only safe once the work is gone. It counts the session's WHOLE
  // live set, not just the tasks this call targeted, so a task that started while the stop was
  // in flight still holds the session busy instead of being certified away.
  private async stopBackgroundWork(threadId: string): Promise<{ stopped: number; remaining: number }> {
    // ensureState, not a bare map lookup: after a QiYan restart this endpoint object is new and
    // knows no threads, while a REMOTE host has outlived the restart and is still running the
    // work. Reading the map alone answered "nothing to stop" without ever asking the host —
    // which is exactly when a caller most needs the real answer.
    //
    // Its failures are NOT caught. This does real I/O — a transcript read, and a reattach RPC
    // over ssh — and a hung remote host is the most likely way it fails. Treating "I could not
    // find out" as "nothing is running" would retract a true active and hand the next archive
    // the go-ahead to close a session whose work is still going.
    const state = await this.ensureState(threadId);
    // The host affirmatively has no session for this thread, so there is no live work whatever
    // this endpoint last published. Correct the record rather than only reporting zero: a stale
    // "active" that nothing ever retracts is a session that can never be archived or restarted.
    if (!state.loaded) {
      if (this.taskActivity.delete(threadId)) this.publishActivityStatus(threadId);
      return { stopped: 0, remaining: 0 };
    }
    // UNKNOWN_SESSION is the host saying it does not hold this session, which is an answer:
    // nothing is running. Any other failure is not an answer and must not be read as one.
    const status = await this.options.host.status(threadId).catch((error: unknown) => {
      if (error instanceof AppError && error.code === "UNKNOWN_SESSION") return undefined;
      throw error;
    });
    if (!status) {
      // Act on the whole answer. The session is not merely idle — it is GONE, and nothing else
      // will say so: session/closed cannot arrive for a session the host does not have. Leaving
      // it marked loaded makes every later turn skip host.open and send into nothing, failing
      // UNKNOWN_SESSION over and over until the endpoint generation changes.
      state.loaded = false;
      if (this.taskActivity.delete(threadId)) this.publishActivityStatus(threadId);
      return { stopped: 0, remaining: 0 };
    }
    const targets = status.backgroundTasks.map((task) => task.taskId);
    // Nothing running: skip the drain wait entirely. turn/interrupt calls this on every
    // interrupt, and an interrupt of an ordinary turn must not pay for a poll it cannot need.
    if (targets.length === 0) {
      if (this.taskActivity.delete(threadId)) this.publishActivityStatus(threadId);
      return { stopped: 0, remaining: 0 };
    }
    // Concurrently, and one refusal must not hide the others: every target gets its attempt,
    // and the drain below — not the call that threw — decides the outcome. Sequentially, a
    // degraded ssh link multiplied one transport timeout by the number of tasks.
    await Promise.all(targets.map((taskId) => this.options.host.stopTask(threadId, taskId).catch(() => undefined)));
    const live = await this.drainedTasks(threadId);
    // Only when the session has NO live work at all — not merely none of the tasks this call
    // targeted. A task that started while the stop was in flight is live work, and claiming
    // idle over it is what would let the following archive close the session on top of it.
    if (live.size === 0) {
      this.taskActivity.delete(threadId);
      this.publishActivityStatus(threadId);
    }
    return { stopped: targets.filter((taskId) => !live.has(taskId)).length, remaining: live.size };
  }

  // stopTask is acknowledged the moment the CLI accepts it; the task only retires when the
  // SDK emits its task_notification. Counting the accepted calls would therefore report a
  // session idle while its subagent is still running — the exact lie that let archive close
  // a session out from under live work. Poll the host's own set until it is empty, and return
  // whatever is still there when the wait runs out.
  private async drainedTasks(threadId: string): Promise<Set<string>> {
    const deadline = Date.now() + (this.options.taskStopConfirmationMs ?? TASK_STOP_CONFIRMATION_MS);
    let delayMs = 25;
    while (true) {
      const live = new Set((await this.options.host.status(threadId)).backgroundTasks.map((task) => task.taskId));
      const remainingMs = deadline - Date.now();
      if (live.size === 0 || remainingMs <= 0) return live;
      await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remainingMs)));
      delayMs = Math.min(delayMs * 2, 250);
    }
  }

  // Publishes what the session is doing when no turn owns it: active on its own background
  // work, or idle. The activity travels WITH the status because "active with no turn id" is
  // otherwise indistinguishable from a turn whose identity has not been established yet —
  // and the consumer's repair for that case concludes the session state is unknowable, which
  // failed every operation on a worker that merely had a subagent running.
  private publishActivityStatus(threadId: string): void {
    if ((this.threads.get(threadId)?.running.length ?? 0) > 0) return;
    const activity = this.nativeActivityOf(threadId);
    this.emitter.emit("notification", "thread/status/changed", {
      threadId,
      status: { type: activity ? "active" : "idle" },
      ...(activity ? { nativeActivity: activity } : {}),
    });
  }

  // The terminal the relay acts on. Carries the turn's assistant text when this endpoint
  // streamed the whole turn, so delivery reads what Claude actually said instead of racing
  // `claude` to the transcript; falls back to the id alone when it did not, and the relay
  // then hydrates from the transcript as before — a reattached turn, or one too large to hold.
  private terminalTurnPayload(
    state: ThreadState,
    turnId: string,
    status: "completed" | "interrupted",
  ): Record<string, unknown> {
    const live = state.liveItems.get(turnId);
    if (!live || live.overflowed) {
      return status === "completed" ? { id: turnId } : { id: turnId, status };
    }
    return { id: turnId, status, itemsView: "full", items: finalAnswerResolved(live.items, status) };
  }

  private retainLiveItem(
    state: ThreadState,
    turnId: string,
    item: { type: string; id: string; text: string; phase: string },
  ): void {
    const live = state.liveItems.get(turnId) ?? { items: [], bytes: 0, overflowed: false };
    state.liveItems.set(turnId, live);
    if (live.overflowed) return;
    live.bytes += Buffer.byteLength(item.text, "utf8");
    if (live.bytes > LIVE_TURN_ITEM_BYTES) {
      live.overflowed = true;
      live.items = [];
      return;
    }
    live.items.push(item);
  }

  // Announce the turn now executing. Called when a send is accepted into an empty queue,
  // and again each time the head settles and the next send takes over.
  private announceHead(threadId: string, turnId: string): void {
    this.emitter.emit("notification", "turn/started", {
      threadId,
      turn: { id: turnId, status: "inProgress" },
    });
  }

  // Reads the goal from the END of the transcript, walking backwards in windows.
  //
  // A single tail window was not enough. The marker only has to be one byte further back than
  // the window for the goal to read as ABSENT — measured in production at 269,759 bytes from
  // the end against a 262,144-byte window, a miss of 3% — and the session then reports no goal
  // while Claude is still pursuing one. That silence is not harmless: the restart resume asks
  // this before deciding whether to restart a parked worker, so a goal that scrolled out of the
  // window is a worker that never gets going again.
  //
  // The assumption it replaces was that an active goal always leaves recent traces, because the
  // Stop hook writes a row per continuation. Those rows exist, but a verbose turn can bury the
  // objective far enough back that a fixed window misses it.
  //
  // Bounded, not unbounded: each step reads one window and stops at the first marker found
  // walking back — which IS the last marker in the file, and the last marker wins. A transcript
  // with no goal at all costs the whole budget once, which is why the budget is modest.
  private async readNativeGoal(threadId: string): Promise<{ objective: string; status: string } | null> {
    const state = this.threads.get(threadId);
    if (!state?.materialized) return null;
    let end: number | undefined;
    for (let scanned = 0; scanned < GOAL_SCAN_MAX_BYTES; scanned += GOAL_SCAN_TAIL_BYTES) {
      const chunk = await this.options.runner
        .readTranscriptChunk(threadId, state.cwd, {
          offset: end === undefined ? "tail" : Math.max(0, end - GOAL_SCAN_TAIL_BYTES),
          length: GOAL_SCAN_TAIL_BYTES,
        })
        .catch(() => undefined);
      if (!chunk || chunk.bytes.length === 0) return null;
      const text = Buffer.from(chunk.bytes).toString("utf8");
      // A window can start mid-line; that partial first line is not valid JSON and would be
      // dropped by the parser anyway, but skip it explicitly when the window was clipped.
      const lines = text.split("\n");
      if (chunk.offset > 0) lines.shift();
      const records: unknown[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try { records.push(JSON.parse(line)); } catch { /* partial or non-JSON line */ }
      }
      const goal = claudeNativeGoal(records);
      // Claude drives its own goal to completion, so an installed goal is by definition still
      // being pursued; there is no paused or blocked state to distinguish.
      if (goal) return { ...goal, status: "active" };
      // claudeNativeGoal reports null both for "no marker here" and for "the last marker was a
      // clear". Walking further back would then resurrect a goal the user cancelled, so stop as
      // soon as this window held any marker at all.
      if (/Goal (set:|cleared)/u.test(text)) return null;
      if (chunk.offset === 0) return null;
      end = chunk.offset;
    }
    return null;
  }

  private async goalClear(params: Record<string, unknown>): Promise<{ goal: null }> {
    await this.deliverGoalCommand(requireString(params.threadId, "threadId"), "/goal clear");
    return { goal: null };
  }

  // A slash command must arrive as its own turn for the CLI to parse the leading slash.
  // That is just an ordinary send: the SDK queues it behind a running turn and runs it next.
  private async deliverGoalCommand(threadId: string, command: string): Promise<void> {
    await this.turnStart({
      threadId,
      clientUserMessageId: randomUUID(),
      input: [{ type: "text", text: command }],
    });
  }

  // Steer IS an ordinary send now: the SDK queues input arriving mid-turn and runs it in
  // order once the current response finishes. QiYan used to hold the message in a durable
  // schedule row and redeliver it as a later turn, because a one-shot `claude -p` had
  // nowhere to put it. Nothing is held back here any more.
  private async turnSteer(params: Record<string, unknown>): Promise<{ turnId: string }> {
    if (inputToText(params.input).length === 0) {
      throw new AppError("CONFIGURATION_ERROR", "turn/steer requires input text");
    }
    // The caller steers a SPECIFIC turn. Honour that: if the turn it meant has already
    // finished and another is running, appending to the new one silently redirects the
    // message to work the user never saw.
    const expected = typeof params.expectedTurnId === "string" ? params.expectedTurnId : undefined;
    if (expected !== undefined) {
      const running = this.threads.get(requireString(params.threadId, "threadId"))?.running[0];
      if (running !== expected) {
        throw new AppError("OPERATION_CONFLICT",
          `turn ${expected} is no longer running${running ? ` (${running} is)` : ""}; send it as a new turn instead`);
      }
    }
    const started = await this.turnStart({
      ...params,
      clientUserMessageId: typeof params.clientUserMessageId === "string" ? params.clientUserMessageId : randomUUID(),
    });
    return { turnId: started.turn.id };
  }

  private async turnInterrupt(params: Record<string, unknown>): Promise<Record<string, never>> {
    const threadId = requireString(params.threadId, "threadId");
    const turnId = requireString(params.turnId, "turnId");
    const state = this.threads.get(threadId);
    // interrupt() ends only the active response; the session stays usable for the next
    // message, so the thread is never closed here.
    //
    // It aborts whatever is EXECUTING, which is the head of the queue. Asking to interrupt
    // a merely-queued turn must therefore be refused rather than served: interrupting would
    // kill the running turn instead, and reporting the queued one terminal while it later
    // runs is the corruption this refuses to produce. The SDK exposes no targeted cancel for
    // one queued message, so refusing is the honest answer.
    if (state?.running.includes(turnId) && state.running[0] !== turnId) {
      throw new AppError("OPERATION_CONFLICT",
        `turn ${turnId} is queued behind ${state.running[0]} on ${threadId}; interrupt the running turn instead`);
    }
    if (state?.running[0] === turnId) await this.options.host.interrupt(threadId);
    // And then stop the session's background work — all of it, not only what this turn
    // started, because the host records no parentage and interrupt is what QiYan offers for
    // "stop and let me restart it". Leaving a subagent alive keeps the session non-idle,
    // therefore unarchivable and unrestartable, with nothing left that could ever stop it.
    //
    // Best-effort: the turn IS interrupted by this point, and failing the call over the
    // cleanup would report otherwise. A stop that did not take leaves the session active,
    // which is the honest state and what the next interrupt acts on.
    await this.stopBackgroundWork(threadId).catch(() => undefined);
    // Re-read: the stop rehydrates a thread this endpoint did not know, so the local captured
    // above can be undefined for a thread that exists by now — and the turn would go unrecorded.
    (this.threads.get(threadId) ?? state)?.terminalTurns.add(turnId);
    return {};
  }
}

// Ranked against the known levels rather than trusting the reported order: taking the first
// element assumes the provider lists levels ascending, and a descending list would silently
// default a model to its most expensive level — the exact outcome choosing a cheapest default
// exists to prevent. An unrecognised level cannot be ranked, so it is only reached for.
function cheapestEffort(efforts: readonly string[]): string {
  return CLAUDE_REASONING_EFFORTS.find((level) => efforts.includes(level))
    ?? efforts[0]
    ?? CLAUDE_DEFAULT_REASONING_EFFORT;
}

// The stream carries an assistant message before its stop reason is settled — the transcript row
// gets it later — so a turn's last message can still look like commentary when the turn has
// plainly ended. Delivery selects on `final_answer`, so a terminal carrying only commentary
// delivers nothing AND reports `completed`, which suppresses the warning too: the worker answers
// and the answer is dropped in silence.
//
// The endpoint does not have to guess here. It knows the turn completed, and the last thing a
// completed turn said is its answer. An interrupted turn never reached one, so it promotes
// nothing.
function finalAnswerResolved(
  items: ReadonlyArray<{ type: string; id: string; text: string; phase: string }>,
  status: "completed" | "interrupted",
): Array<{ type: string; id: string; text: string; phase: string }> {
  if (status !== "completed" || items.some((item) => item.phase === "final_answer")) return [...items];
  const last = items.map((item, index) => ({ item, index })).filter(({ item }) => item.type === "agentMessage").at(-1);
  if (!last) return [...items];
  return items.map((item, index) => (index === last.index ? { ...item, phase: "final_answer" } : item));
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new AppError("CONFIGURATION_ERROR", `claude endpoint: missing ${field}`);
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new AppError("CONFIGURATION_ERROR", `claude endpoint: invalid ${field}`);
  }
  return Number(value);
}

function requireDirection(value: unknown): "asc" | "desc" {
  if (value !== "asc" && value !== "desc") throw new AppError("CONFIGURATION_ERROR", "claude endpoint: invalid sortDirection");
  return value;
}

function requireItemsView(value: unknown): "full" | "summary" | "notLoaded" {
  if (value !== "full" && value !== "summary" && value !== "notLoaded") {
    throw new AppError("CONFIGURATION_ERROR", "claude endpoint: invalid itemsView");
  }
  return value;
}

// Render the Codex-shaped input items as the session's message text. Text items pass through;
// file attachments become a path reference — the worker file bridge has already staged the
// file at a path valid on THIS worker's host (local fs, or the remote runtime dir for a
// remote worker), and `claude` reads files by path (its Read tool handles text and images).
function inputToText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  const parts: string[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : undefined;
    if (record.type === "text") {
      if (typeof record.text === "string") parts.push(record.text);
    } else if ((record.type === "localImage" || record.type === "mention") && typeof record.path === "string") {
      parts.push(name ? `[Attached file "${name}" (read it at ${record.path})]` : `[Attached file: read it at ${record.path}]`);
    } else if (record.type === "image" && typeof record.url === "string") {
      parts.push(`[Attached image: ${record.url}]`);
    }
    // `skill` items are intentionally omitted: the worker send path never emits them (only text +
    // localImage/mention from the file bridge), and a skill reference has no meaning to Claude.
  }
  return parts.join("\n");
}

function noRollout(threadId: string): JsonRpcResponseError {
  // Exact Codex message so `isExactThreadNoRollout` recovery paths behave.
  return new JsonRpcResponseError(-32600, `no rollout found for thread id ${threadId}`);
}

// Top-level assistant text from an SDK event. Nested (subagent) content never reaches
// here: the host classifies it separately so it cannot appear as a top-level message.
// Must enumerate exactly as reconstructClaudeThread's textBlocks does, because the live
// item id is `${uuid}:${index}` and the reconstructed one is `${uuid}:${blockIndex}`.
// A divergent index would key the same message twice and the Web UI would show duplicates.
function assistantTextBlocks(message: Record<string, unknown>): string[] {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content.length > 0 ? [content] : [];
  if (!Array.isArray(content)) return [];
  const blocks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const value = block as Record<string, unknown>;
    if (value.type !== "text") continue;
    if (typeof value.text === "string" && value.text.length > 0) blocks.push(value.text);
  }
  return blocks;
}

function messageUuid(message: Record<string, unknown>): string | undefined {
  return typeof message.uuid === "string" && message.uuid.length > 0 ? message.uuid : undefined;
}
