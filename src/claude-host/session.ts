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

// Every terminal error the SDK can end a turn with. `SDKResultError` declares no
// `user_message_uuid` on ANY of them -- only a success result carries one -- so position is
// the only attribution available for all four. Handling just `error_during_execution` left
// the other three falling through as uncorrelated, stranding the turn in flight forever:
// the same permanent `working` as a folded send, reached by a different subtype.
const RESULT_ERROR_SUBTYPES = new Set([
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
]);

// Whether a result may settle an accepted human send by POSITION. `origin` is an eight-member
// union, of which exactly one kind — `human` — is a send this host made; the rest are Claude
// speaking for itself or for another session. Excluding only `task-notification` let the other
// six claim a turn they never owned. The pairing that bites: QiYan's goal feature drives sessions through Claude's
// Stop hook, i.e. auto-continuation, which is far and away the likeliest source of
// error_max_turns — so a goal-driven worker hitting the cap reported the user's still-running
// turn terminal, and the relay announced it "interrupted without a final response" while the
// worker was still writing one. That is the exact regression the positional branch was
// written to avoid, and widening the subtype list tripled how reachable it was.
//
// An UNSTAMPED origin stays permissive, unchanged: every measured abort result carries
// {kind:"human"}, but nothing proves the CLI always stamps one, and refusing those would
// strand the turn — the leak this whole change exists to close. The known-not-human kinds are
// what the evidence covers, so they are what this excludes.
function claimsHumanTurn(origin: Record<string, unknown>): boolean {
  return origin.kind === undefined || origin.kind === "human";
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
  // The turn a pending interrupt is aborting. Deliberately not a boolean: a flag set before
  // the round trip has no reliable clear -- an interrupt over nothing in flight, a round trip
  // that throws, or an abort result arriving on an empty queue all leave it set forever, and
  // it then disables this reconciliation for the rest of the session's life with no signal.
  // Held as the identity instead, so every route that retires that turn clears it implicitly.
  private abortingUuid?: string;
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
    // Read the turn being aborted BEFORE the round trip. The SDK writes the receipt before
    // the abort's result on a clean interrupt but may emit that result first when the turn
    // crashes during interrupt handling, and then the aborted head is already gone and the
    // folded send has taken index 0. Position is a proxy for identity here, and identity is
    // available: taking the position instead skipped the folded send and stranded it working
    // forever -- the very leak this reconciliation exists to close.
    const aborting = this.inFlight[0]?.uuid;
    // A second interrupt issued before the first abort's result lands sees the turn the SDK
    // has since DEQUEUED and is now running, which the receipt does not list (it names what
    // is queued or imminent, never what is executing). Reconciling then would report a
    // running turn as folded: terminal, empty, and silent. Skip while one is outstanding.
    const outstanding = this.abortInFlight();
    // Only sends already accepted can be in scope. The receipt is a snapshot taken with abort
    // processing, so it can never name one that arrives during the round trip -- and over ssh
    // that is a whole network round trip, not a millisecond. "Press stop, then immediately
    // type what you actually wanted" would otherwise be reported answered before it ran, with
    // the session reading idle and evictable while it worked. Gives up one case in exchange:
    // a send that both arrives in the window AND is folded before the abort lands is left in
    // flight, which the next result sweeps — a recoverable strand rather than an
    // unrecoverable false terminal for a turn that is still running.
    const candidates = new Set(this.inFlight.map((turn) => turn.uuid));
    if (aborting !== undefined) this.abortingUuid = aborting;
    const receipt = await this.query.interrupt();
    if (!outstanding) this.settleFoldedAcrossInterrupt(receipt, aborting, candidates);
  }

  // True while the turn a previous interrupt aborted is still in flight. Self-clearing: it
  // reads the queue rather than a flag, so there is no state to leak.
  private abortInFlight(): boolean {
    return this.abortingUuid !== undefined && this.inFlight.some((turn) => turn.uuid === this.abortingUuid);
  }

  // An interrupt is not a fold: the SDK keeps queued commands across one and they still run,
  // so the abort's own result settles the head and nothing else. But a send already folded
  // into the aborted turn never runs and never produces a result, and in `inFlight` the two
  // are indistinguishable — which stranded one on every ordinary "send a follow-up, then hit
  // stop", the same permanent `working` this whole change exists to end.
  //
  // The interrupt receipt is the discriminator, and it is evidence rather than inference: the
  // SDK reports exactly which sends survive. Anything in flight it does NOT name was folded.
  // An older CLI sends no receipt at all, and that is unknown, not empty — settle nothing.
  private settleFoldedAcrossInterrupt(receipt: unknown, aborting: string | undefined, candidates: ReadonlySet<string>): void {
    const queued = (receipt as { still_queued?: unknown } | undefined)?.still_queued;
    if (!Array.isArray(queued)) return;
    const survives = new Set(queued.filter((uuid): uuid is string => typeof uuid === "string"));
    // By identity, not position: the aborted turn is settled by its own result, whenever that
    // lands relative to this receipt.
    const folded = this.inFlight.filter((turn) =>
      candidates.has(turn.uuid) && turn.uuid !== aborting && !survives.has(turn.uuid));
    if (folded.length === 0) return;
    const settled = new Set(folded.map((turn) => turn.uuid));
    for (let index = this.inFlight.length - 1; index >= 0; index -= 1) {
      if (settled.has(this.inFlight[index]!.uuid)) this.inFlight.splice(index, 1);
    }
    for (const turn of folded) {
      this.emit({
        type: "turn/completed",
        sessionId: this.sessionId,
        origin: "human",
        status: "completed",
        folded: true,
        uuid: turn.uuid,
        at: this.now(),
      });
    }
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
    if (subtype === "compact_boundary") {
      const metadata = (message.compact_metadata ?? {}) as Record<string, unknown>;
      this.emit({
        type: "session/compacted",
        sessionId: this.sessionId,
        trigger: typeof metadata.trigger === "string" ? metadata.trigger : "manual",
        at: this.now(),
      });
      return;
    }
    if (subtype === "init") {
      this.emit({ type: "session/init", sessionId: this.sessionId, message, at: this.now() });
    }
  }

  // A top-level end-of-turn belonging to no accepted send. Delivered — that is how a
  // background task's report reaches chat — but it settles nothing.
  private emitUncorrelated(message: Record<string, unknown>, failed: boolean): void {
    this.emit({
      type: "turn/completed",
      sessionId: this.sessionId,
      origin: "task-notification",
      status: failed ? "failed" : "completed",
      result: message,
      at: this.now(),
    });
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
    // Sends that were FOLDED into the turn this result ends, and so are ended by it. A send
    // that arrives while a turn is running is not started as a turn of its own: Claude pulls
    // it out of the queue and folds it into the turn already in flight, which then answers
    // both prompts under that turn's uuid. No result ever carries the folded send's uuid —
    // the SDK states it outright ("it never runs as its own turn").
    //
    // Read directly off a stuck session's transcript, where a normal send is enqueued and
    // dequeued in the same millisecond while every ghost was enqueued and then REMOVED, and
    // survives only as an attachment:
    //   07:17:18 enqueue "this doc is still too long…"   07:17:18 dequeue   -> its own turn
    //   07:19:35 enqueue "also let a subagent review…"   07:19:36 remove    -> folded
    //            + {"type":"attachment","attachment":{"type":"queued_command",
    //               "source_uuid":"to:web:af757927-…"}}, and no turn record anywhere
    //
    // Settling on the exact uuid alone therefore stranded every folded send here forever.
    // `activity()` reads `working` off a non-empty array, so the session reported working
    // while idle and was never evictable — and worst, reconciliation asks the host which
    // turns are still in flight, so this leak made the host authoritatively CONFIRM its own
    // ghost: two sessions sat "working" overnight through a sweep running every 60 seconds.
    //
    // Everything still in flight when a result lands was queued while that turn was running,
    // and was therefore folded into it. Settle the lot; leaving any behind is what made a
    // session stick, and a trailing folded send has nothing later to settle it.
    //
    // One send can be misread as folded: one accepted in the window between the SDK emitting
    // this result and the host consuming it, which really does start a turn. Accepted as the
    // better trade. It reads idle for that turn's duration, but its answer is NOT lost — its
    // own result arrives naming a turn no longer in flight, and is delivered as uncorrelated,
    // which republishes the previous turn's terminal carrying the text it produced. The
    // alternative, holding turns on the chance one is still live, is the permanent `working`
    // this exists to end.
    let folded: AcceptedTurn[] = [];
    let preceding: AcceptedTurn[] = [];
    if (uuid) {
      const index = this.inFlight.findIndex((turn) => turn.uuid === uuid);
      // A uuid naming nothing in flight settles NOTHING. It is a late or duplicate result for
      // a turn already gone, and falling through from here would emit a human terminal with
      // no uuid — which the runtime attributes to `state.running[0]`, killing an unrelated
      // turn that is still running.
      if (index < 0) {
        this.emitUncorrelated(message, failed);
        return;
      }
      // Only what came AFTER the named turn was queued while it ran. Anything before it is
      // settled on the SDK's in-order execution, as a turn of its own — folding those would
      // publish them as answerless and drop answers they really produced, and silent loss is
      // not the failure to pick.
      //
      // Not provably empty, though it is under everything measured here. The SDK also
      // coalesces a dequeued batch into ONE turn owned by a "batch-representative" uuid, and
      // which member of a batch owns the result is undocumented: if it is ever not the
      // oldest, these are members with no row of their own, and they take the wrong branch.
      // Weigh what that costs before changing it. The runtime keys live items on the head, so
      // it will have been attributing the NAMED turn's streamed text to preceding[0] the
      // whole time it ran — the failure there is the absorbing turn's answer delivered twice,
      // once under the wrong turn id, not merely a turn nobody can find. Left as the safer of
      // two wrong answers rather than defended against blind.
      preceding = this.inFlight.splice(0, index);
      settled = this.inFlight.shift();
      folded = this.inFlight.splice(0);
    } else if (claimsHumanTurn(origin) && RESULT_ERROR_SUBTYPES.has(String(message.subtype ?? "")) && this.inFlight.length > 0) {
      // Measured: an INTERRUPTED turn's result carries no user_message_uuid, so it can only
      // be attributed by position — the oldest in flight is the one the SDK was executing.
      //
      // Nothing else may claim a turn that way. Claude emits other uncorrelated results of
      // its own — a task notification whose origin was not stamped, an auto-continuation —
      // and treating those as terminal settled the running human turn before it had
      // answered. The relay then read a turn with no final answer yet and reported it
      // "interrupted without a final response" while the worker was still writing one.
      // Only the head. An interrupt is NOT a fold: the SDK states that queued commands
      // survive it and will still run (they come back on the interrupt receipt's
      // `still_queued`), and settling them here would report turns as ended that are about
      // to produce answers. One that was mid-fold when the abort landed is stranded, and is
      // swept by the next turn's result below rather than guessed at here.
      settled = this.inFlight.shift();
    } else if (!uuid) {
      // A top-level end-of-turn that belongs to no accepted send. It is still delivered —
      // that is how a background task's report reaches chat — but it settles nothing.
      this.emitUncorrelated(message, failed);
      return;
    }

    // Oldest first, so each removal hands the queue's head to the next one, and WITHOUT the
    // result — it belongs to the turn that was named, not to these. `folded` marks them as
    // ended by that turn rather than in their own right, so the consumer neither hunts the
    // transcript for a turn row a folded send never had nor announces one as unanswered:
    // its answer was delivered, inside the turn that absorbed it.
    for (const turn of preceding) {
      this.emit({
        type: "turn/completed",
        sessionId: this.sessionId,
        origin: "human",
        status: "completed",
        uuid: turn.uuid,
        at: this.now(),
      });
    }
    for (const turn of folded) {
      this.emit({
        type: "turn/completed",
        sessionId: this.sessionId,
        origin: "human",
        status: "completed",
        folded: true,
        uuid: turn.uuid,
        at: this.now(),
      });
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
