// One loaded Claude session: owns a long-lived SDK Query, its streaming input queue,
// the in-flight turn identity, the native background-task set, and a bounded replay
// buffer for short client disconnects.
//
// Every rule here comes from a measured SDK behaviour (scripts/claude-sdk-spike.ts,
// results in docs/development/claude-agent-sdk-host-design.md):
//
//   - A turn settles on the result whose `user_message_uuid` matches the accepted
//     send, OR on an uncorrelated non-success result while exactly one turn is in
//     flight. An interrupted turn emits `error_during_execution` with NO
//     user_message_uuid, so uuid correlation alone would hang the turn forever.
//   - `session_state_changed` never fires, so idle is derived here: no in-flight turn
//     and an empty background-task set.
//   - Background work Claude starts for itself — backgrounded Bash and Task-tool
//     subagents — outlives the turn that started it. It is NOT conversation: when the
//     work finishes the agent reports, and that report is an ordinary end-of-turn. The
//     set is tracked only so a live "2 background tasks, 1 subagent" indicator can be
//     shown, and so a session that can still speak is never evicted.
//   - Subagent content carries `parent_tool_use_id`; it is nested, never top-level.
//   - Re-sending an accepted uuid is a no-op in the CLI, so retry after an ambiguous
//     transport failure is safe and must not enqueue a second message here either.
//
// Events are live fan-out only. Nothing is buffered for replay: a client that was away
// reloads the tail of the durable transcript, which is both simpler and the only complete
// source. The Web UI only renders an active panel, so there is nothing to catch up for an
// inactive one.
import { AppError } from "../core/errors.ts";
import type { HostEvent, SessionActivity, SessionStatus } from "./protocol.ts";

// The slice of the SDK's Query that a session actor uses. Narrowed to what the host
// calls so tests can drive the actor without spawning Claude.
export interface SessionQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  setModel(model?: string): Promise<void>;
  // Reasoning effort has no dedicated setter; it rides the flag-settings layer.
  applyFlagSettings(settings: { effortLevel?: string | null }): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  supportedModels(): Promise<unknown[]>;
  close(): void;
}

export interface SessionInput {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
  session_id: string;
  origin: { kind: "human" };
  uuid: string;
}

export interface SessionQueryFactory {
  (input: AsyncIterable<SessionInput>): SessionQuery;
}

// Push-based streaming input. The SDK consumes this for the life of the session, so it
// must stay open between turns — closing it ends the query.
class InputStream implements AsyncIterable<SessionInput> {
  private readonly pending: SessionInput[] = [];
  private readonly waiters: Array<(value: IteratorResult<SessionInput>) => void> = [];
  private closed = false;

  push(message: SessionInput): void {
    if (this.closed) throw new AppError("SESSION_DETACHED", "claude session input is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.pending.push(message);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SessionInput> {
    return {
      next: async (): Promise<IteratorResult<SessionInput>> => {
        const ready = this.pending.shift();
        if (ready) return { value: ready, done: false };
        if (this.closed) return { value: undefined as never, done: true };
        return await new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

interface AcceptedTurn {
  uuid: string;
  startedAt: number;
}

interface LiveTask {
  // The SDK sets subagent_type only for Task-tool subagents; anything else Claude
  // backgrounded (a long Bash command, a workflow) counts as a background task.
  kind: "subagent" | "background";
  description?: string;
  startedAt: number;
}

function classifyTask(record: Record<string, unknown>): LiveTask["kind"] {
  return typeof record.subagent_type === "string" && record.subagent_type.length > 0
    ? "subagent"
    : "background";
}

export class ClaudeHostSession {
  private readonly input = new InputStream();
  private readonly query: SessionQuery;
  private readonly listeners = new Set<(event: HostEvent) => void>();
  // Accepted sends that have not yet settled, in submission order. The SDK executes
  // queued messages in order, so the head is the turn a uuid-less result belongs to.
  private readonly inFlight: AcceptedTurn[] = [];
  private readonly acceptedUuids = new Set<string>();
  private readonly backgroundTasks = new Map<string, LiveTask>();
  private closed = false;
  private lastActiveAt = 0;
  readonly drained: Promise<void>;

  constructor(
    readonly sessionId: string,
    createQuery: SessionQueryFactory,
    private readonly options: { now?: () => number } = {},
  ) {
    this.lastActiveAt = this.now();
    this.query = createQuery(this.input);
    this.drained = this.drain();
  }

  // When this session last did anything observable. Eviction orders on it, so a session a
  // worker uses constantly outlives one that was merely opened earlier.
  get activeAt(): number { return this.lastActiveAt; }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  // Accepting a send is what the caller's idempotency key buys: a duplicate uuid is
  // dropped here rather than becoming a second turn. Returns false when it was a
  // duplicate, so the caller can report "already accepted" instead of re-queueing.
  send(uuid: string, text: string): boolean {
    if (this.closed) throw new AppError("SESSION_DETACHED", `claude session is closed: ${this.sessionId}`);
    if (this.acceptedUuids.has(uuid)) return false;
    this.acceptedUuids.add(uuid);
    this.inFlight.push({ uuid, startedAt: this.now() });
    this.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      origin: { kind: "human" },
      uuid,
    });
    this.emit({ type: "turn/accepted", sessionId: this.sessionId, uuid, at: this.now() });
    return true;
  }

  async interrupt(): Promise<void> {
    if (this.closed) return;
    await this.query.interrupt();
  }

  async setModel(model?: string): Promise<void> { await this.query.setModel(model); }
  // null clears the flag-layer override and falls back to the user's own settings.
  async setEffort(effort?: string): Promise<void> {
    await this.query.applyFlagSettings({ effortLevel: effort ?? null });
  }
  async stopTask(taskId: string): Promise<void> { await this.query.stopTask(taskId); }
  async supportedModels(): Promise<unknown[]> { return await this.query.supportedModels(); }

  status(): SessionStatus {
    return {
      sessionId: this.sessionId,
      activity: this.activity(),
      inFlightTurns: this.inFlight.map((turn) => turn.uuid),
      backgroundTasks: [...this.backgroundTasks.entries()].map(([id, task]) => ({
        taskId: id,
        kind: task.kind,
        ...(task.description === undefined ? {} : { description: task.description }),
        startedAt: task.startedAt,
      })),
    };
  }

  // Idle means nothing can still produce output: no turn in flight AND no native
  // background task outstanding. Eviction uses the same rule — a session with a live
  // background task must not be unloaded, or the task's result is lost.
  private activity(): SessionActivity {
    if (this.inFlight.length > 0) return "working";
    return this.backgroundTasks.size > 0 ? "background" : "idle";
  }

  isEvictable(): boolean { return this.activity() === "idle"; }

  subscribe(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close(): void { this.markClosed(); }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.close();
    this.query.close();
    this.emit({ type: "session/closed", sessionId: this.sessionId, at: this.now() });
  }

  // Everything the session does — an accepted send, streamed content, a task change, a
  // settled turn — passes through here, so this is the one place activity is observed.
  // One event carrying the whole live set, so a consumer renders "2 background tasks,
  // 1 subagent" from a single payload instead of maintaining its own counters.
  private emitTaskSet(): void {
    const tasks = [...this.backgroundTasks.values()];
    this.emit({
      type: "task/set",
      sessionId: this.sessionId,
      background: tasks.filter((task) => task.kind === "background").length,
      subagents: tasks.filter((task) => task.kind === "subagent").length,
      descriptions: tasks.map((task) => task.description).filter((text): text is string => text !== undefined),
      at: this.now(),
    });
  }

  private emit(event: HostEvent): void {
    this.lastActiveAt = this.now();
    for (const listener of this.listeners) listener(event);
  }

  private async drain(): Promise<void> {
    try {
      for await (const raw of this.query) {
        this.consume(raw as Record<string, unknown>);
      }
    } catch (error) {
      this.emit({
        type: "session/error",
        sessionId: this.sessionId,
        message: error instanceof Error ? error.message : String(error),
        at: this.now(),
      });
    } finally {
      // A query that ends with turns still in flight settles them as interrupted;
      // otherwise a caller waits forever on a turn that can never complete.
      for (const turn of this.inFlight.splice(0)) {
        this.emit({
          type: "turn/completed", sessionId: this.sessionId, origin: "human",
          uuid: turn.uuid, status: "interrupted", at: this.now(),
        });
      }
      // The query is gone whether it ended cleanly or the `claude` child died under it, and
      // nothing closes the session in that second case. Retire it here — settling the
      // in-flight turns first, since closing is what tells the host to drop it — so a later
      // send fails loudly instead of disappearing into an input stream nobody reads.
      this.markClosed();
    }
  }

  private consume(message: Record<string, unknown>): void {
    const type = String(message.type ?? "");
    if (type === "system") { this.consumeSystem(message); return; }
    if (type === "result") { this.consumeResult(message); return; }
    // Subagent output is nested content, never a top-level bubble.
    const nested = message.parent_tool_use_id != null;
    if (type === "assistant") {
      this.emit({
        type: nested ? "content/nested" : "content/assistant",
        sessionId: this.sessionId,
        message,
        at: this.now(),
      });
      return;
    }
    // A user-role message from the SDK is a tool result, replay, or subagent echo —
    // never the human input, which the SDK does not echo back. It must not become a
    // visible user bubble.
    if (type === "user") return;
  }

  private consumeSystem(message: Record<string, unknown>): void {
    const subtype = String(message.subtype ?? "");
    const taskId = typeof message.task_id === "string" ? message.task_id : undefined;
    if (subtype === "task_started" && taskId) {
      // skip_transcript marks ambient housekeeping the SDK asks consumers to hide from the
      // conversation. It still belongs in a task indicator, which is all this set feeds.
      this.backgroundTasks.set(taskId, {
        kind: classifyTask(message),
        ...(typeof message.description === "string" && message.description.length > 0
          ? { description: message.description } : {}),
        startedAt: this.now(),
      });
      this.emitTaskSet();
      return;
    }
    if (subtype === "task_notification" && taskId) {
      this.backgroundTasks.delete(taskId);
      this.emitTaskSet();
      return;
    }
    if (subtype === "background_tasks_changed") {
      // REPLACE semantics per the SDK: this payload is the authoritative live set, so
      // reconcile against it rather than trusting the task_started/notification deltas.
      const tasks = Array.isArray(message.tasks) ? message.tasks as Array<Record<string, unknown>> : [];
      const live = new Set<string>();
      for (const task of tasks) {
        const id = typeof task.task_id === "string" ? task.task_id : undefined;
        if (!id) continue;
        live.add(id);
        const existing = this.backgroundTasks.get(id);
        this.backgroundTasks.set(id, {
          kind: existing?.kind ?? classifyTask(task),
          ...(typeof task.description === "string" && task.description.length > 0
            ? { description: task.description }
            : existing?.description === undefined ? {} : { description: existing.description }),
          startedAt: existing?.startedAt ?? this.now(),
        });
      }
      for (const id of [...this.backgroundTasks.keys()]) if (!live.has(id)) this.backgroundTasks.delete(id);
      this.emitTaskSet();
      return;
    }
    if (subtype === "init") {
      this.emit({ type: "session/init", sessionId: this.sessionId, message, at: this.now() });
    }
  }

  private consumeResult(message: Record<string, unknown>): void {
    const uuid = typeof message.user_message_uuid === "string" ? message.user_message_uuid : undefined;
    const origin = (message.origin ?? {}) as Record<string, unknown>;
    const isTaskNotification = origin.kind === "task-notification";
    const failed = message.subtype !== "success";

    // A task-notification result belongs to a background task, not to any accepted
    // send. It is still a top-level end-of-turn and is delivered, but it must never
    // settle a human turn.
    if (isTaskNotification) {
      this.emit({
        type: "turn/completed",
        sessionId: this.sessionId,
        origin: "task-notification",
        status: failed ? "failed" : "completed",
        result: message,
        at: this.now(),
      });
      return;
    }

    let settled: AcceptedTurn | undefined;
    if (uuid) {
      const index = this.inFlight.findIndex((turn) => turn.uuid === uuid);
      if (index >= 0) settled = this.inFlight.splice(index, 1)[0];
    } else if (this.inFlight.length > 0) {
      // Measured: an interrupted turn's result carries no user_message_uuid. Attribute
      // it to the oldest in-flight turn — the one the SDK was executing.
      settled = this.inFlight.shift();
    }

    this.emit({
      type: "turn/completed",
      sessionId: this.sessionId,
      origin: "human",
      status: failed ? (message.subtype === "error_during_execution" ? "interrupted" : "failed") : "completed",
      ...(settled === undefined ? {} : { uuid: settled.uuid }),
      result: message,
      at: this.now(),
    });
  }
}
