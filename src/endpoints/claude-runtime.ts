// ClaudeCodeRuntime (Phase 1.3) — a ManagedAppServerEndpoint-shaped adapter that
// makes the existing pool/lifecycle/relay drive a headless `claude -p` session
// unchanged, WITHOUT the Codex initialize/account handshake (there is no daemon).
//
// Model: one endpoint per host, multiplexing many sessions; threadId === Claude
// session id. `thread/start` pre-reserves a session id (claude's --session-id) and
// returns a synthetic idle thread — no subprocess yet. `turn/start` runs `claude -p`
// asynchronously (fire-and-resume: --session-id on the first turn, --resume after)
// and, on exit, pushes a synthesized `turn/completed`; the relay then re-reads the
// transcript-reconstructed `thread/read` for authoritative content. `turn/interrupt`
// kills the subprocess.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { AppError } from "../core/errors.ts";
import { JsonRpcResponseError } from "../app-server/rpc-client.ts";
import type { PermissionBlockedEvent } from "../app-server/managed-endpoint.ts";
import { encodeClaudeClientMarker } from "../sessions/claude-transcript.ts";
import { reconstructClaudeThread, type ClaudeThreadView } from "../sessions/claude-thread.ts";
import type { ClaudeGoalStore } from "../sessions/claude-goals.ts";
import type { ClaudeCommandRunner, ClaudeLaunchFlags, ClaudeTurnHandle } from "./claude-command-runner.ts";
import type { EndpointLossKind, ManagedAppServerEndpoint, RuntimeIdentity } from "./types.ts";

interface ThreadState {
  cwd: string;
  threadSource?: string;
  materialized: boolean;                 // has at least one turn been run (transcript exists)?
  running?: { turnId: string; handle: ClaudeTurnHandle };
  terminalTurns: Set<string>;            // turn ids known interrupted/failed (no transcript end_turn)
}

export class ClaudeCodeRuntime implements ManagedAppServerEndpoint {
  readonly id: string;
  private endpointState: "starting" | "ready" | "unavailable" | "stopped" = "starting";
  private readonly emitter = new EventEmitter();
  private readonly threads = new Map<string, ThreadState>();

  constructor(private readonly options: {
    id: string;
    runner: ClaudeCommandRunner;
    launchFlags: ClaudeLaunchFlags;
    goals?: ClaudeGoalStore;
    now?: () => number;
  }) {
    this.id = options.id;
    this.emitter.setMaxListeners(100);
  }

  get state(): "starting" | "ready" | "unavailable" | "stopped" { return this.endpointState; }

  async start(): Promise<void> {
    // No daemon to connect: the endpoint is ready as soon as it exists.
    this.endpointState = "ready";
    this.emitter.emit("ready");
  }

  async closeConnection(): Promise<void> {
    for (const state of this.threads.values()) state.running?.handle.interrupt();
    this.endpointState = "stopped";
  }

  async shutdownRuntime(_expected: RuntimeIdentity): Promise<void> {
    await this.closeConnection();
  }

  // A host endpoint has no persistent daemon process; there is no single runtime
  // identity to fence. Individual turn subprocesses are ephemeral.
  async runtimeIdentity(): Promise<RuntimeIdentity | undefined> { return undefined; }

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
      case "turn/start": return this.turnStart(args) as T;
      case "turn/interrupt": return this.turnInterrupt(args) as T;
      case "thread/archive": { const id = typeof args.threadId === "string" ? args.threadId : ""; this.threads.get(id)?.running?.handle.interrupt(); this.threads.delete(id); return {} as T; }
      case "thread/unsubscribe": return { status: "unsubscribed" } as T;
      case "thread/name/set": return {} as T;
      case "model/list": return { models: this.options.launchFlags.model ? [{ id: this.options.launchFlags.model }] : [] } as T;
      case "thread/goal/get": return { goal: this.goals().get(this.id, requireString(args.threadId, "threadId")) } as T;
      case "thread/goal/set": return this.goalSet(args) as T;
      case "thread/goal/clear": { this.goals().clear(this.id, requireString(args.threadId, "threadId")); return { goal: null } as T; }
      // turn/steer (Claude enqueue) is Phase 2.3.
      default: throw new AppError("UNSUPPORTED_CAPABILITY", `claude endpoint does not implement ${method}`);
    }
  }

  private threadStart(params: Record<string, unknown>): { thread: ClaudeThreadView } {
    const cwd = requireString(params.cwd, "cwd");
    const threadSource = typeof params.threadSource === "string" ? params.threadSource : undefined;
    const id = randomUUID();
    this.threads.set(id, {
      cwd, materialized: false, terminalTurns: new Set(),
      ...(threadSource === undefined ? {} : { threadSource }),
    });
    return {
      thread: {
        id, cwd, itemsView: "full", status: { type: "idle" }, turns: [],
        ...(threadSource === undefined ? {} : { threadSource }),
        ...(this.options.launchFlags.model === undefined ? {} : { model: this.options.launchFlags.model }),
      },
    };
  }

  private async threadRead(params: Record<string, unknown>): Promise<{ thread: ClaudeThreadView }> {
    const threadId = requireString(params.threadId, "threadId");
    return { thread: await this.withPath(threadId, await this.reconstruct(threadId)) };
  }

  private async threadResume(params: Record<string, unknown>): Promise<{ thread: ClaudeThreadView }> {
    const threadId = requireString(params.threadId, "threadId");
    return { thread: await this.withPath(threadId, await this.reconstruct(threadId)) };
  }

  // Attach the transcript path so the ownership path-resolver (which reads
  // thread.path from thread/read) can materialize a Claude session. Undefined
  // before the first turn — same "pending" outcome as an unmaterialized Codex thread.
  private async withPath(threadId: string, view: ClaudeThreadView): Promise<ClaudeThreadView> {
    const state = this.threads.get(threadId);
    const path = await this.options.runner.transcriptPath(threadId, state?.cwd ?? "");
    return path === undefined ? view : { ...view, path };
  }

  private async reconstruct(threadId: string): Promise<ClaudeThreadView> {
    let state = this.threads.get(threadId);
    // Cold-start recovery: after a QiYan restart the in-memory map is empty, but the
    // Claude transcript is durable on disk. Rehydrate an unknown-but-on-disk session
    // (cwd read from the transcript itself) rather than falsely reporting it gone.
    // A reserved-but-unmaterialized thread (state present, materialized false) reads
    // as an empty idle thread. A truly unknown thread with no transcript reproduces
    // the exact Codex `no rollout` error so recovery paths behave.
    const records = state?.materialized === false ? [] : await this.options.runner.readTranscript(threadId, state?.cwd ?? "");
    if (!state) {
      if (records.length === 0) throw noRollout(threadId);
      state = { cwd: cwdFromRecords(records), materialized: true, terminalTurns: new Set() };
      this.threads.set(threadId, state);
    }
    return reconstructClaudeThread({
      threadId, cwd: state.cwd, records,
      interruptedTurnIds: state.terminalTurns,
      ...(state.threadSource === undefined ? {} : { threadSource: state.threadSource }),
      ...(this.options.launchFlags.model === undefined ? {} : { model: this.options.launchFlags.model }),
    });
  }

  private turnStart(params: Record<string, unknown>): { turn: { id: string; status: string } } {
    const threadId = requireString(params.threadId, "threadId");
    const state = this.threads.get(threadId);
    if (!state) throw noRollout(threadId);
    // Defense-in-depth: the pool/lifecycle serialize turns per thread, but never let
    // a second turn/start silently orphan a running child (losing interrupt control).
    if (state.running) throw new AppError("SESSION_BUSY", `claude turn already running: ${threadId}`);
    const clientId = requireString(params.clientUserMessageId, "clientUserMessageId");
    const message = `${inputToText(params.input)}\n\n${encodeClaudeClientMarker(clientId)}`;

    const handle = this.options.runner.startTurn({
      threadId, cwd: state.cwd, message, resume: state.materialized, flags: this.options.launchFlags,
    });
    state.running = { turnId: clientId, handle };

    void handle.done.then((status) => {
      state.materialized = true;
      delete state.running;
      // A failed turn is marked terminal so reconstruct synthesizes a findable
      // terminal turn even if `claude` never wrote its user row (relay would else hang).
      if (status === "failed") state.terminalTurns.add(clientId);
      // The relay ignores this body and re-reads thread/read; {threadId, turn:{id}}
      // is the minimal trigger.
      this.emitter.emit("notification", "turn/completed", { threadId, turn: { id: clientId } });
    }).catch(() => {
      delete state.running;
      state.terminalTurns.add(clientId);
      this.emitter.emit("notification", "turn/completed", { threadId, turn: { id: clientId } });
    });

    return { turn: { id: clientId, status: "inProgress" } };
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

  private turnInterrupt(params: Record<string, unknown>): Record<string, never> {
    const threadId = requireString(params.threadId, "threadId");
    const turnId = requireString(params.turnId, "turnId");
    const state = this.threads.get(threadId);
    if (state?.running?.turnId === turnId) state.running.handle.interrupt();
    state?.terminalTurns.add(turnId);
    return {};
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new AppError("CONFIGURATION_ERROR", `claude endpoint: missing ${field}`);
  return value;
}

// The goal statuses QiYan's recovery/dashboard accept (production-app parseManagedGoal);
// reject anything else at write time rather than letting recovery throw later.
const CLAUDE_GOAL_STATUSES = new Set(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);
function requireGoalStatus(status: string): string {
  if (!CLAUDE_GOAL_STATUSES.has(status)) throw new AppError("CONFIGURATION_ERROR", `invalid goal status: ${status}`);
  return status;
}

// Concatenate the text of the Codex-shaped input items; non-text items (files) are
// not yet supported by the Claude adapter.
function inputToText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  const parts: string[] = [];
  for (const item of input) {
    if (item && typeof item === "object" && (item as Record<string, unknown>).type === "text") {
      const text = (item as Record<string, unknown>).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

// Every transcript row carries the session cwd; used to rehydrate a cold-started
// session whose in-memory state was lost on QiYan restart.
function cwdFromRecords(records: readonly unknown[]): string {
  for (const record of records) {
    if (record && typeof record === "object" && !Array.isArray(record)) {
      const cwd = (record as Record<string, unknown>).cwd;
      if (typeof cwd === "string" && cwd.length > 0) return cwd;
    }
  }
  return "";
}

function noRollout(threadId: string): JsonRpcResponseError {
  // Exact Codex message so `isExactThreadNoRollout` recovery paths behave.
  return new JsonRpcResponseError(-32600, `no rollout found for thread id ${threadId}`);
}
