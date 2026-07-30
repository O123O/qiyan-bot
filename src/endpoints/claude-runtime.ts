// ManagedAppServerEndpoint-shaped adapter for headless `claude -p` sessions.
// Local Claude is daemonless; remote Claude composes this adapter with a persistent
// tmux controller so turns survive SSH and QiYan reconnects.
//
// Model: one endpoint per host, multiplexing many sessions; threadId === Claude
// session id. `thread/start` pre-reserves a session id (claude's --session-id) and
// returns a synthetic idle thread — no subprocess yet. `turn/start` runs `claude -p`
// asynchronously (fire-and-resume: --session-id on the first turn, --resume after)
// and, on exit, pushes a synthesized `turn/completed`; the relay then uses bounded
// transcript turn/item pages for authoritative content. `turn/interrupt`
// kills the subprocess.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { AppError } from "../core/errors.ts";
import { JsonRpcResponseError } from "../app-server/rpc-client.ts";
import type { PermissionBlockedEvent } from "../app-server/managed-endpoint.ts";
import { reconstructClaudeThread, type ClaudeThreadView } from "../sessions/claude-thread.ts";
import type { ClaudeGoalStore } from "../sessions/claude-goals.ts";
import type { ClaudeArchiveStore } from "../sessions/claude-archives.ts";
import {
  CLAUDE_DEFAULT_REASONING_EFFORT,
  claudeModelCatalog,
} from "./claude-models.ts";
import type { ClaudeCommandRunner, ClaudeLaunchFlags, ClaudeTurnHandle } from "./claude-command-runner.ts";
import { ClaudeTranscriptHistory } from "./claude-history.ts";
import type { EndpointLossKind, EndpointLossReason, ManagedAppServerEndpoint, RuntimeIdentity } from "./types.ts";

interface ThreadState {
  cwd: string;
  threadSource?: string;
  materialized: boolean;                 // has at least one turn been run (transcript exists)?
  recoveryChecked: boolean;
  recovery?: Promise<void>;
  starting?: { clientId: string; handle?: ClaudeTurnHandle };
  running?: { turnId: string; handle: ClaudeTurnHandle };
  terminalTurns: Set<string>;            // turn ids known interrupted/failed (no transcript end_turn)
}

export interface ClaudePersistentRuntime {
  start(): Promise<void>;
  closeConnection(): Promise<void>;
  shutdownRuntime(expectedIdentity: RuntimeIdentity): Promise<void>;
  runtimeIdentity(): Promise<RuntimeIdentity | undefined>;
  onUnavailable(listener: (kind: EndpointLossKind, reason?: EndpointLossReason) => void): () => void;
  recoverTurn(threadId: string, cwd: string): Promise<{ turnId: string; handle: ClaudeTurnHandle } | undefined>;
  releaseThread(threadId: string): Promise<void>;
}

export class ClaudeCodeRuntime implements ManagedAppServerEndpoint {
  readonly id: string;
  readonly daemonless: boolean;
  private endpointState: "starting" | "ready" | "unavailable" | "stopped" = "starting";
  private readonly emitter = new EventEmitter();
  private readonly threads = new Map<string, ThreadState>();
  private readonly stateLoads = new Map<string, Promise<ThreadState>>();
  private readonly history: ClaudeTranscriptHistory;
  private persistentUnavailableSubscription?: () => void;
  private lifecycleGeneration = 0;

  constructor(private readonly options: {
    id: string;
    runner: ClaudeCommandRunner;
    launchFlags: ClaudeLaunchFlags;
    persistentRuntime?: ClaudePersistentRuntime;
    goals?: ClaudeGoalStore;
    // Emulated archive state (Claude has no native archive) — thread/archive tombstones a
    // thread here so thread/list (discover) hides it, matching Codex archive semantics.
    archives?: ClaudeArchiveStore;
    now?: () => number;
    // Returns the stable per-session --mcp-config path exposing the worker scheduling
    // tools, or undefined. Attached to every turn (byte-identical per session).
    workerMcpConfigPath?: (threadId: string) => Promise<string | undefined>;
    // Claude has no native mid-turn steer (spike 0.4). turn/steer durably enqueues the
    // message; it is delivered as the next turn once the running one completes.
    steer?: (threadId: string, message: string) => Promise<void>;
  }) {
    this.id = options.id;
    this.daemonless = options.persistentRuntime === undefined;
    this.history = new ClaudeTranscriptHistory(options.runner);
    this.emitter.setMaxListeners(100);
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
      await this.options.persistentRuntime.closeConnection();
      return;
    }
    for (const state of this.threads.values()) {
      state.starting?.handle?.interrupt();
      state.running?.handle.interrupt();
    }
  }

  async shutdownRuntime(expected: RuntimeIdentity): Promise<void> {
    this.lifecycleGeneration += 1;
    if (!this.options.persistentRuntime) {
      this.endpointState = "stopped";
      this.persistentUnavailableSubscription?.();
      delete this.persistentUnavailableSubscription;
      for (const state of this.threads.values()) {
        await state.starting?.handle?.interrupt();
        await state.running?.handle.interrupt();
      }
      return;
    }
    this.endpointState = "stopped";
    this.persistentUnavailableSubscription?.();
    delete this.persistentUnavailableSubscription;
    await this.options.persistentRuntime.shutdownRuntime(expected);
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
        if (id && this.options.persistentRuntime) {
          await this.options.persistentRuntime.releaseThread(id);
        } else {
          state?.starting?.handle?.interrupt();
          state?.running?.handle.interrupt();
        }
        this.threads.delete(id);
        // Claude has no native archive: tombstone the thread so discover hides it (Codex parity).
        if (id) this.options.archives?.add(this.id, id, this.options.now?.());
        return {} as T;
      }
      case "thread/unsubscribe": {
        const id = requireString(args.threadId, "threadId");
        if (this.options.persistentRuntime) {
          await this.options.persistentRuntime.releaseThread(id);
          this.threads.delete(id);
        }
        return { status: "unsubscribed" } as T;
      }
      case "thread/name/set": return {} as T;
      // Claude has no model-list API; return the curated catalog (Codex `{data,nextCursor}` shape)
      // so set_session_model / the model picker have real entries to validate against.
      case "model/list": return { data: claudeModelCatalog(this.options.launchFlags.model), nextCursor: null } as T;
      // An endpoint without a goal store (e.g. a remote Claude endpoint — goals are scoped to
      // the local endpoint) simply has no goal; reading it must not fail get_session_status.
      case "thread/goal/get": return { goal: this.options.goals ? this.options.goals.get(this.id, requireString(args.threadId, "threadId")) : null } as T;
      case "thread/goal/set": return this.goalSet(args) as T;
      case "thread/goal/clear": { this.goals().clear(this.id, requireString(args.threadId, "threadId")); return { goal: null } as T; }
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
      cwd, materialized: false, recoveryChecked: true, terminalTurns: new Set(),
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
      terminalTurns: new Set(),
    };
    this.threads.set(threadId, state);
    return state;
  }

  private async recoverState(threadId: string, state: ThreadState): Promise<void> {
    try {
      const recovered = await this.options.persistentRuntime?.recoverTurn(threadId, state.cwd);
      state.recoveryChecked = true;
      if (recovered) {
        state.running = recovered;
        this.observeTurnHandle(threadId, state, recovered.turnId, recovered.handle);
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
      : await this.history.fullRecords(threadId, state.cwd) ?? [];
    return reconstructClaudeThread({
      threadId, cwd: state.cwd, records,
      interruptedTurnIds: state.terminalTurns,
      ...(state.running === undefined ? {} : { runningTurnId: state.running.turnId }),
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
    if (!state.running) return page;
    return {
      ...page,
      data: page.data.map((turn) => turn.id === state.running?.turnId
        ? { ...turn, status: "inProgress" }
        : turn),
    };
  }

  private stateOnlyThread(threadId: string, state: ThreadState): ClaudeThreadView {
    return {
      id: threadId,
      cwd: state.cwd,
      status: { type: state.running || state.starting ? "active" : "idle" },
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
      .map((meta) => ({ id: meta.id, cwd: meta.cwd, updatedAt: meta.updatedAt, preview: meta.preview }));
    return { data, nextCursor: null };
  }

  private async turnStart(params: Record<string, unknown>): Promise<{ turn: { id: string; status: string } }> {
    const lifecycleGeneration = this.lifecycleGeneration;
    const threadId = requireString(params.threadId, "threadId");
    const state = this.threads.get(threadId);
    if (!state) throw noRollout(threadId);
    // Defense-in-depth: the pool/lifecycle serialize turns per thread, but never let
    // a second turn/start silently orphan a running child (losing interrupt control).
    if (state.running || state.starting) {
      throw new AppError("SESSION_BUSY", `claude turn already running: ${threadId}`);
    }
    const clientId = requireString(params.clientUserMessageId, "clientUserMessageId");
    const message = inputToText(params.input);
    // A driven turn revives an (emulated) archived thread — clear the tombstone (Codex parity).
    this.options.archives?.remove(this.id, threadId);
    const starting: NonNullable<ThreadState["starting"]> = { clientId };
    state.starting = starting;
    try {
      // Per-session model/effort: `service.send` spreads the sticky settings into these params;
      // prefer them over the endpoint-wide launch defaults (Claude applies them as `--model`/
      // `--effort` per invocation). Attach the worker scheduling tools (stable per session).
      const workerConfig = await this.options.workerMcpConfigPath?.(threadId);
      const flags: ClaudeLaunchFlags = {
        ...this.options.launchFlags,
        ...(typeof params.model === "string" ? { model: params.model } : {}),
        ...(typeof params.effort === "string" ? { effort: params.effort } : {}),
        ...(workerConfig === undefined ? {} : { mcpConfig: [...(this.options.launchFlags.mcpConfig ?? []), workerConfig] }),
      };
      if (!this.turnGenerationIsCurrent(lifecycleGeneration, threadId, state, starting)) {
        throw new AppError("ENDPOINT_UNAVAILABLE", `claude endpoint changed while its turn was starting: ${threadId}`);
      }

      const handle = await this.options.runner.startTurn({
        threadId, cwd: state.cwd, message, resume: state.materialized, flags,
      });
      starting.handle = handle;
      if (!this.turnGenerationIsCurrent(lifecycleGeneration, threadId, state, starting)) {
        if (this.options.persistentRuntime) await this.options.persistentRuntime.closeConnection();
        else await handle.interrupt();
        throw new AppError("ENDPOINT_UNAVAILABLE", `claude endpoint changed while its turn was starting: ${threadId}`);
      }
      const materialization = await handle.materialization;
      if (!this.turnGenerationIsCurrent(lifecycleGeneration, threadId, state, starting)) {
        if (this.options.persistentRuntime) await this.options.persistentRuntime.closeConnection();
        else await handle.interrupt();
        throw new AppError("ENDPOINT_UNAVAILABLE", `claude endpoint changed while its turn was starting: ${threadId}`);
      }
      if (materialization === undefined) {
        await handle.interrupt();
        state.terminalTurns.add(clientId);
        return { turn: { id: clientId, status: "interrupted" } };
      }
      const { turnId: nativeTurnId, userItemId } = materialization;
      state.running = { turnId: nativeTurnId, handle };
      this.observeTurnHandle(threadId, state, nativeTurnId, handle);
      this.emitter.emit("notification", "turn/started", {
        threadId,
        turn: { id: nativeTurnId, status: "inProgress" },
      });
      this.emitter.emit("notification", "item/started", {
        threadId,
        turnId: nativeTurnId,
        item: {
          type: "userMessage",
          id: userItemId,
          clientId: null,
          content: [{ type: "text", text: message, text_elements: [] }],
        },
      });
      return { turn: { id: nativeTurnId, status: "inProgress" } };
    } finally {
      if (state.starting === starting) delete state.starting;
    }
  }

  private turnGenerationIsCurrent(
    generation: number,
    threadId: string,
    state: ThreadState,
    starting: NonNullable<ThreadState["starting"]>,
  ): boolean {
    return this.endpointState === "ready"
      && this.lifecycleGeneration === generation
      && this.threads.get(threadId) === state
      && state.starting === starting;
  }

  private observeTurnHandle(
    threadId: string,
    state: ThreadState,
    turnId: string,
    handle: ClaudeTurnHandle,
  ): void {
    void handle.done.then((status) => {
      if (state.running?.turnId !== turnId || state.running.handle !== handle) return;
      state.materialized = true;
      delete state.running;
      // A failed turn is marked terminal so reconstruct synthesizes a findable
      // terminal turn even if `claude` never wrote its user row (relay would else hang).
      if (status === "failed") state.terminalTurns.add(turnId);
      // Successful turns use the minimal trigger and are hydrated through bounded native
      // paging. A failure may have no JSONL user row, so emit its complete synthetic terminal.
      this.emitter.emit("notification", "turn/completed", {
        threadId,
        turn: status === "failed"
          ? { id: turnId, status: "interrupted" }
          : { id: turnId },
      });
    }).catch(() => {
      if (state.running?.turnId !== turnId || state.running.handle !== handle) return;
      delete state.running;
      state.terminalTurns.add(turnId);
      this.emitter.emit("notification", "turn/completed", {
        threadId,
        turn: { id: turnId, status: "interrupted" },
      });
    });
  }

  private goals(): ClaudeGoalStore {
    if (!this.options.goals) throw new AppError("UNSUPPORTED_CAPABILITY", "claude endpoint has no goal store configured");
    return this.options.goals;
  }

  // thread/goal/set carries either a fresh objective (set) or a status-only change
  // (pause/resume/blocked/complete), mirroring the Codex goal RPC the service calls.
  private goalSet(params: Record<string, unknown>): { goal: unknown } {
    const threadId = requireString(params.threadId, "threadId");
    const now = this.options.now?.() ?? Date.now();
    const status = typeof params.status === "string" ? requireGoalStatus(params.status) : undefined;
    if (typeof params.objective === "string" && params.objective.length > 0) {
      return { goal: this.goals().set(this.id, threadId, {
        objective: params.objective,
        ...(status === undefined ? {} : { status }),
        ...(typeof params.tokenBudget === "number" ? { tokenBudget: params.tokenBudget } : {}),
      }, now) };
    }
    if (status !== undefined) return { goal: this.goals().setStatus(this.id, threadId, status, now) };
    throw new AppError("CONFIGURATION_ERROR", "thread/goal/set requires an objective or a status");
  }

  // Claude steer = durable enqueue (never abort the running turn). Delivered as the
  // next turn once the running one completes (the schedule engine retries while the
  // session is SESSION_BUSY).
  private async turnSteer(params: Record<string, unknown>): Promise<{ turnId: string }> {
    const threadId = requireString(params.threadId, "threadId");
    if (!this.options.steer) throw new AppError("UNSUPPORTED_CAPABILITY", "claude endpoint has no steer queue configured");
    const message = inputToText(params.input);
    if (message.length === 0) throw new AppError("CONFIGURATION_ERROR", "turn/steer requires input text");
    await this.options.steer(threadId, message);
    return { turnId: typeof params.clientUserMessageId === "string" ? params.clientUserMessageId : randomUUID() };
  }

  private async turnInterrupt(params: Record<string, unknown>): Promise<Record<string, never>> {
    const threadId = requireString(params.threadId, "threadId");
    const turnId = requireString(params.turnId, "turnId");
    const state = this.threads.get(threadId);
    if (state?.running?.turnId === turnId) await state.running.handle.interrupt();
    if (state?.starting?.clientId === turnId) await state.starting.handle?.interrupt();
    state?.terminalTurns.add(turnId);
    return {};
  }
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

// The goal statuses QiYan's recovery/dashboard accept (production-app parseManagedGoal);
// reject anything else at write time rather than letting recovery throw later.
const CLAUDE_GOAL_STATUSES = new Set(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);
function requireGoalStatus(status: string): string {
  if (!CLAUDE_GOAL_STATUSES.has(status)) throw new AppError("CONFIGURATION_ERROR", `invalid goal status: ${status}`);
  return status;
}

// Render the Codex-shaped input items as text for `claude -p`. Text items pass through;
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
    // localImage/mention from the file bridge), and a skill reference has no meaning for `claude -p`.
  }
  return parts.join("\n");
}

function noRollout(threadId: string): JsonRpcResponseError {
  // Exact Codex message so `isExactThreadNoRollout` recovery paths behave.
  return new JsonRpcResponseError(-32600, `no rollout found for thread id ${threadId}`);
}
