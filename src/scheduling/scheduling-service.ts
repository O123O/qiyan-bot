// Scheduling service (Phase 2 wiring) — ties the durable store, the idempotent send
// outbox, the trigger engine, and the worker-facing MCP server together, and manages
// per-session worker tokens + --mcp-config files. production-app constructs one and
// injects `send` (→ send_to_session) and `runCheck` (→ shell on the session's host).
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "../core/errors.ts";
import type { Database } from "../storage/database.ts";
import { ScheduleStore, type ScheduleRow } from "./schedule-store.ts";
import { ScheduledSendOutbox } from "./send-outbox.ts";
import { TriggerEngine } from "./trigger-engine.ts";
import { WorkerScheduleMcpServer, type WorkerScheduleSession } from "./worker-mcp.ts";
import type { ClaudeGoalStore } from "../sessions/claude-goals.ts";

export interface SchedulingServiceDeps {
  db: Database;
  // Drive a turn on the target session (production-app wires this to the durable
  // send_to_session, passing singleFireKey as the clientUserMessageId).
  send(nickname: string, message: string, singleFireKey: string): Promise<void>;
  // Run a monitor's shell predicate on the session's endpoint; true iff exit 0.
  runCheck(row: ScheduleRow): Promise<boolean>;
  now(): number;
  // Directory for per-session worker --mcp-config files (0700).
  mcpConfigDir: string;
  pollIntervalMs?: number;
  // Enables the set_goal_status worker tool: the worker marks its own goal
  // complete/blocked, and QiYan's goal driver stops.
  goals?: ClaudeGoalStore;
  // Notified after a worker marks its goal via set_goal_status, so the dashboard is
  // refreshed (the worker write bypasses the manager tools' observeGoal).
  onGoalStatusChanged?(session: WorkerScheduleSession): void;
  // Whether the `monitor` tool is available to a session — false for a remote worker, whose
  // check would run on the QiYan host, not the worker's (see remote-worker-scheduling §3.5).
  supportsMonitor?(session: WorkerScheduleSession): boolean;
}

// Inter-drive pacing for goal auto-drive turns (F3/F6): bounds a failing goal to one
// claude turn per this interval rather than at poll speed.
const GOAL_DRIVE_DELAY_MS = 5_000;

export class SchedulingService {
  readonly store: ScheduleStore;
  private readonly outbox: ScheduledSendOutbox;
  private readonly server: WorkerScheduleMcpServer;
  private readonly engine: TriggerEngine;
  private readonly tokenBySession = new Map<string, string>();   // `${endpointId}\0${threadId}` -> token
  private readonly sessionByToken = new Map<string, WorkerScheduleSession>();

  constructor(private readonly deps: SchedulingServiceDeps) {
    this.store = new ScheduleStore(deps.db);
    this.outbox = new ScheduledSendOutbox(deps.db);
    this.server = new WorkerScheduleMcpServer({
      store: this.store, now: deps.now, resolveToken: (token) => this.sessionByToken.get(token),
      ...(deps.supportsMonitor ? { supportsMonitor: deps.supportsMonitor } : {}),
      ...(deps.goals ? { setGoalStatus: (session, status) => {
        deps.goals!.setStatus(session.endpointId, session.threadId, status, deps.now());
        deps.onGoalStatusChanged?.(session);
      } } : {}),
    });
    this.engine = new TriggerEngine({
      store: this.store,
      now: deps.now,
      fire: (row, key) => this.fire(row, key),
      runCheck: deps.runCheck,
      // Above pool.startTurn's ~30s reconciliation budget, so a slow-but-live send
      // isn't spuriously orphaned by the engine's op timeout.
      opTimeoutMs: 120_000,
      ...(deps.pollIntervalMs === undefined ? {} : { pollIntervalMs: deps.pollIntervalMs }),
    });
  }

  async start(): Promise<void> {
    await mkdir(this.deps.mcpConfigDir, { recursive: true, mode: 0o700 });
    await this.server.start();
    // Recovery (2.5): the store is durable, so starting just resumes polling; armed
    // rows (including any missed while down) fire on the first tick.
    this.engine.start();
  }

  async stop(): Promise<void> {
    this.engine.stop();
    await this.server.stop();
  }

  // Drive one engine pass (tests / manual flush).
  runDueOnce(): Promise<void> { return this.engine.tick(); }

  // Idempotent fire. The outbox is the sole dedup ledger, so it must NOT drop the
  // record on an ambiguous outcome (that would let a re-fire double-deliver on the
  // shared-NFS deployment). Rules:
  //   - claimed  → send. On success mark sent (advance). On a PROVEN-not-dispatched
  //     error release + throw (re-fire cleanly). On any AMBIGUOUS error mark sent
  //     anyway (the turn may have run — bias to no-double) and advance.
  //   - delivered → someone already sent it; advance.
  //   - in-flight → a live/crashed peer holds the claim; THROW so the schedule stays
  //     armed (never advance) until it is proven sent or the claim goes stale and is
  //     reclaimed. This closes the orphaned-send / lost-delivery hole.
  private async fire(row: ScheduleRow, singleFireKey: string): Promise<void> {
    // A goal auto-drive send (spec "goal", paced GOAL_DRIVE_DELAY_MS after the prior turn) is
    // stale if the goal stopped being active between enqueue and now — cancel_goal (deletes the
    // goal), pause_goal, or the worker marking it complete|blocked. Drop it here, the single fire
    // choke point, so a stopped goal never drives another turn (nor collides with a later manual
    // send). This mirrors the driver's own active-check, so every stop path quiesces driving
    // without having to find and cancel the pending row.
    // `kind === "wakeup"` distinguishes a goal drive from a worker `monitor` whose free-form
    // check string could also be "goal" (that row is kind "monitor").
    if (row.kind === "wakeup" && row.spec === "goal" && this.deps.goals
      && this.deps.goals.get(row.endpointId, row.threadId)?.status !== "active") return;
    const outcome = this.outbox.claim(singleFireKey, row.nickname, row.message, this.deps.now());
    if (outcome === "delivered") return;
    if (outcome === "in-flight") throw new AppError("OPERATION_UNCERTAIN", `schedule send in-flight: ${singleFireKey}`);
    try {
      await this.deps.send(row.nickname, row.message, singleFireKey);
      this.outbox.markSent(singleFireKey);
    } catch (error) {
      if (isProvenNotDispatched(error)) { this.outbox.release(singleFireKey); throw error; }
      // Ambiguous: the turn may already be running/done. Do NOT re-send (avoid the
      // duplicate-delivery class this deployment is sensitive to); accept it.
      this.outbox.markSent(singleFireKey);
    }
  }

  // Claude steer: enqueue the message as an immediate one-shot so the engine delivers
  // it as the next turn (retrying while the session is busy). Durable + recovers.
  enqueueSteer(session: WorkerScheduleSession, message: string): void {
    this.enqueueImmediate(session, "steer", message);
  }

  // Goal auto-drive: deliver the next goal-pursuit turn. Paced by a small delay so a
  // failing/looping goal can't spawn back-to-back claude turns at poll speed.
  enqueueGoalDrive(session: WorkerScheduleSession, message: string): void {
    this.store.create({ nickname: session.nickname, endpointId: session.endpointId, threadId: session.threadId, kind: "wakeup", spec: "goal", message, nextFireAt: this.deps.now() + GOAL_DRIVE_DELAY_MS }, this.deps.now());
  }

  // Is a goal drive already pending for this session? (dedup — one drive lane.)
  hasPendingGoalDrive(session: WorkerScheduleSession): boolean {
    return this.store.hasArmedSpec(session.endpointId, session.threadId, "goal");
  }

  private enqueueImmediate(session: WorkerScheduleSession, spec: string, message: string): void {
    this.store.create({ nickname: session.nickname, endpointId: session.endpointId, threadId: session.threadId, kind: "wakeup", spec, message, nextFireAt: this.deps.now() }, this.deps.now());
  }

  // Register a worker session so it can reach the scheduling tools; returns the stable
  // per-session --mcp-config path (byte-identical across the session's turns, so it
  // doesn't break the prompt cache). Idempotent per session.
  // The loopback port the worker MCP listens on (for the remote reverse tunnel's local end).
  get mcpPort(): number { return this.server.port; }

  // The stable per-session bearer token (minted on first use). A remote worker's config uses
  // the same token; the token→session map resolves the caller regardless of which tunnel.
  workerMcpToken(session: WorkerScheduleSession): string {
    const sessionKey = `${session.endpointId}\0${session.threadId}`;
    let token = this.tokenBySession.get(sessionKey);
    if (!token) {
      token = randomUUID();
      this.tokenBySession.set(sessionKey, token);
      this.sessionByToken.set(token, session);
    }
    return token;
  }

  // The --mcp-config JSON pointing the worker at `url`. Local uses the loopback url; a remote
  // worker uses `http://127.0.0.1:<remotePort>/mcp` (its reverse-tunneled port).
  workerMcpConfigContent(session: WorkerScheduleSession, url: string): string {
    return JSON.stringify({
      mcpServers: { "qiyan-worker-scheduling": { type: "http", url, headers: { Authorization: `Bearer ${this.workerMcpToken(session)}` } } },
    });
  }

  async workerMcpConfigPath(session: WorkerScheduleSession): Promise<string> {
    // Ensure the config dir exists independently of start() ordering — a session's first
    // turn can write here before (or without) the scheduler component's start() mkdir,
    // e.g. the very first Claude session on a fresh dataDir.
    await mkdir(this.deps.mcpConfigDir, { recursive: true, mode: 0o700 });
    const path = join(this.deps.mcpConfigDir, `${session.threadId}.json`);
    await writeFile(path, this.workerMcpConfigContent(session, this.server.url), { mode: 0o600 });
    return path;
  }
}

// Errors that PROVE the turn never dispatched — safe to release + re-fire. Anything
// else (uncertain / failed) is treated as maybe-delivered to avoid double-sending.
const PROVEN_NOT_DISPATCHED = new Set([
  "SESSION_BUSY", "SESSION_DETACHED", "SESSION_IDLE", "UNKNOWN_SESSION", "AMBIGUOUS_SESSION",
  "THREAD_NOT_FOUND", "ENDPOINT_UNAVAILABLE", "ENDPOINT_IDENTITY_CHANGED", "CWD_MISMATCH",
  "CONFIGURATION_ERROR", "CAPACITY_EXCEEDED", "PERMISSION_BLOCKED", "UNSUPPORTED_CAPABILITY",
]);
function isProvenNotDispatched(error: unknown): boolean {
  return error instanceof AppError && PROVEN_NOT_DISPATCHED.has(error.code);
}
