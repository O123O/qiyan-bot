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
import { AppError } from "../core/errors.ts";
import { JsonRpcResponseError } from "../app-server/rpc-client.ts";
import type { PermissionBlockedEvent } from "../app-server/managed-endpoint.ts";
import { reconstructClaudeThread, type ClaudeThreadView } from "../sessions/claude-thread.ts";
import type { ClaudeArchiveStore } from "../sessions/claude-archives.ts";
import {
  CLAUDE_DEFAULT_REASONING_EFFORT,
  claudeModelCatalog,
} from "./claude-models.ts";
import type { ClaudeCommandRunner, ClaudeLaunchFlags } from "./claude-command-runner.ts";
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
  running?: { turnId: string };
  terminalTurns: Set<string>;            // turn ids known interrupted/failed
}

export interface ClaudePersistentRuntime {
  start(): Promise<void>;
  closeConnection(): Promise<void>;
  shutdownRuntime(expectedIdentity: RuntimeIdentity): Promise<void>;
  runtimeIdentity(): Promise<RuntimeIdentity | undefined>;
  onUnavailable(listener: (kind: EndpointLossKind, reason?: EndpointLossReason) => void): () => void;
  // Reconnect-time reattach. The host already knows whether a response is still running,
  // so this only has to report the turn id it belongs to — no process handles, PID
  // markers, or transcript materialization scans.
  recoverTurn(threadId: string, cwd: string): Promise<{ turnId: string } | undefined>;
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
  private readonly hostSubscription: () => void;
  private lifecycleGeneration = 0;

  constructor(private readonly options: {
    id: string;
    // Runs turns: one long-lived SDK query per loaded session, local or remote.
    host: ClaudeHost;
    // Reads the native transcript for durable history and session discovery. Claude's
    // JSONL stays the only durable conversation store.
    runner: ClaudeCommandRunner;
    launchFlags: ClaudeLaunchFlags;
    persistentRuntime?: ClaudePersistentRuntime;
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
    this.hostSubscription = options.host.subscribe((event) => this.onHostEvent(event));
  }

  // Host events are the live source of truth for an active turn. They are translated
  // straight into the provider-neutral notifications the relay and Web UI already
  // consume, so no consumer learns that Claude is behind them.
  private onHostEvent(event: HostEvent): void {
    const threadId = event.sessionId;
    const state = this.threads.get(threadId);
    if (!state) return;
    if (event.type === "content/assistant") {
      const turnId = state.running?.turnId;
      if (!turnId) return;
      for (const [index, text] of assistantTextBlocks(event.message).entries()) {
        this.emitter.emit("notification", "item/completed", {
          threadId,
          turnId,
          item: { type: "agentMessage", id: `${messageUuid(event.message) ?? turnId}:${index}`, text },
        });
      }
      return;
    }
    if (event.type !== "turn/completed") return;
    // A background task's result is a real end-of-turn and is delivered, but it settles
    // no accepted send, so it must not close the running human turn.
    if (event.origin === "task-notification") {
      this.emitter.emit("notification", "turn/completed", {
        threadId,
        turn: { id: messageUuid(event.result ?? {}) ?? `${threadId}:task`, status: "completed" },
      });
      return;
    }
    const turnId = event.uuid ?? state.running?.turnId;
    if (!turnId) return;
    state.materialized = true;
    if (state.running?.turnId === turnId) delete state.running;
    if (event.status !== "completed") state.terminalTurns.add(turnId);
    this.emitter.emit("notification", "turn/completed", {
      threadId,
      turn: event.status === "completed" ? { id: turnId } : { id: turnId, status: "interrupted" },
    });
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
    await this.options.host.shutdown();
  }

  async shutdownRuntime(expected: RuntimeIdentity): Promise<void> {
    this.lifecycleGeneration += 1;
    if (!this.options.persistentRuntime) {
      this.endpointState = "stopped";
      this.persistentUnavailableSubscription?.();
      delete this.persistentUnavailableSubscription;
      await this.options.host.shutdown();
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
        if (id && this.options.persistentRuntime) await this.options.persistentRuntime.releaseThread(id);
        if (id && state?.loaded) await this.options.host.close(id);
        this.threads.delete(id);
        // Claude has no native archive: tombstone the thread so discover hides it (Codex parity).
        if (id) this.options.archives?.add(this.id, id, this.options.now?.());
        return {} as T;
      }
      case "thread/unsubscribe": {
        const id = requireString(args.threadId, "threadId");
        if (this.threads.get(id)?.loaded) await this.options.host.close(id);
        if (this.options.persistentRuntime) await this.options.persistentRuntime.releaseThread(id);
        this.threads.delete(id);
        return { status: "unsubscribed" } as T;
      }
      case "thread/name/set": return {} as T;
      // Claude has no model-list API; return the curated catalog (Codex `{data,nextCursor}` shape)
      // so set_session_model / the model picker have real entries to validate against.
      case "model/list": return { data: claudeModelCatalog(this.options.launchFlags.model), nextCursor: null } as T;
      // A goal is Claude's own `/goal`, driven by its Stop hook. QiYan stores none: the
      // manager's goal tools install and clear the NATIVE goal by delivering the command,
      // and `thread/goal/get` reports "no goal" because native goal state is not exposed
      // to the SDK stream (see docs/development/claude-agent-sdk-host-design.md).
      case "thread/goal/get": return { goal: null } as T;
      case "thread/goal/set": return await this.goalSet(args) as T;
      case "thread/goal/clear": return await this.goalClear(args) as T;
      // Claude's context compaction is its own `/compact` command, delivered like `/goal`.
      case "thread/compact/start": {
        await this.deliverGoalCommand(requireString(args.threadId, "threadId"), "/compact");
        return {} as T;
      }
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
      cwd, materialized: false, recoveryChecked: true, loaded: false, terminalTurns: new Set(),
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
      terminalTurns: new Set(),
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
        state.running = { turnId: recovered.turnId };
        state.loaded = true;
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
      status: { type: state.running ? "active" : "idle" },
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
    const threadId = requireString(params.threadId, "threadId");
    const state = this.threads.get(threadId);
    if (!state) throw noRollout(threadId);
    // Defense-in-depth: the pool serializes turns per thread, but a second turn/start
    // must never orphan a running one and lose interrupt control over it.
    if (state.running) throw new AppError("SESSION_BUSY", `claude turn already running: ${threadId}`);
    const clientId = requireString(params.clientUserMessageId, "clientUserMessageId");
    const message = inputToText(params.input);
    // A driven turn revives an (emulated) archived thread — clear the tombstone (Codex parity).
    this.options.archives?.remove(this.id, threadId);

    // Lazily load the session. `materialized` distinguishes creating the caller-chosen
    // native session id from resuming one that already exists on disk.
    if (!state.loaded) {
      await this.options.host.open({
        sessionId: threadId,
        mode: state.materialized ? "resume" : "create",
        cwd: state.cwd,
        ...(typeof params.model === "string"
          ? { model: params.model }
          : this.options.launchFlags.model === undefined ? {} : { model: this.options.launchFlags.model }),
      });
      state.loaded = true;
    }
    if (typeof params.model === "string") await this.options.host.setModel(threadId, params.model);

    // The uuid IS the turn id: the SDK preserves it into the transcript's user row, so
    // the live stream and reconstructed history agree without a correlation marker.
    const accepted = await this.options.host.send(threadId, clientId, message);
    state.running = { turnId: clientId };
    if (accepted) {
      this.emitter.emit("notification", "turn/started", {
        threadId,
        turn: { id: clientId, status: "inProgress" },
      });
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
    }
    return { turn: { id: clientId, status: "inProgress" } };
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

  private async goalClear(params: Record<string, unknown>): Promise<{ goal: null }> {
    await this.deliverGoalCommand(requireString(params.threadId, "threadId"), "/goal clear");
    return { goal: null };
  }

  // A slash command must arrive as its own turn for the CLI to parse the leading slash, so
  // it rides the same durable enqueue as steer rather than racing a running turn.
  private async deliverGoalCommand(threadId: string, command: string): Promise<void> {
    if (!this.options.steer) {
      throw new AppError("UNSUPPORTED_CAPABILITY", "claude endpoint has no delivery queue for slash commands");
    }
    await this.options.steer(threadId, command);
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
    // interrupt() ends only the active response; the session stays usable for the next
    // message, so the thread is never closed here.
    if (state?.running?.turnId === turnId) await this.options.host.interrupt(threadId);
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

// Top-level assistant text from an SDK event. Nested (subagent) content never reaches
// here: the host classifies it separately so it cannot appear as a top-level message.
function assistantTextBlocks(message: Record<string, unknown>): string[] {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .filter((text) => text.length > 0);
}

function messageUuid(message: Record<string, unknown>): string | undefined {
  return typeof message.uuid === "string" && message.uuid.length > 0 ? message.uuid : undefined;
}
