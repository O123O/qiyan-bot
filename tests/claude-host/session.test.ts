import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ClaudeHostSession, type SessionInput, type SessionQuery } from "../../src/claude-host/session.ts";
import type { HostEvent } from "../../src/claude-host/protocol.ts";

// A fake SDK Query driven message-by-message from the test, so every rule the session
// actor encodes can be exercised against the exact event shapes the real SDK emits
// (captured by scripts/claude-sdk-spike.ts).
class FakeQuery implements SessionQuery {
  readonly received: SessionInput[] = [];
  readonly stopped: string[] = [];
  readonly flagSettings: Array<{ effortLevel?: string | null }> = [];
  interrupts = 0;
  closed = false;
  private readonly pending: unknown[] = [];
  private readonly waiters: Array<(value: IteratorResult<unknown>) => void> = [];
  private ended = false;

  constructor(input: AsyncIterable<SessionInput>) {
    void (async () => { for await (const message of input) this.received.push(message); })();
  }

  push(message: Record<string, unknown>): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.pending.push(message);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  // What the SDK's interrupt receipt reports back. `undefined` stands for a CLI too old to
  // send one at all, which is not the same as reporting an empty queue.
  receipt: unknown = { still_queued: [] };
  // The SDK documents that a turn crashing during interrupt handling emits its abort result
  // on a direct-write path that can PRECEDE the receipt.
  abortResultBeforeReceipt = false;
  // Runs mid-round-trip, so a test can land a send in the window the receipt predates.
  onInterrupt?: () => void;
  async interrupt(): Promise<unknown> {
    this.interrupts += 1;
    this.onInterrupt?.();
    if (this.abortResultBeforeReceipt) {
      this.push({ type: "result", subtype: "error_during_execution", is_error: true, origin: { kind: "human" } });
      await delay(5);
    }
    return this.receipt;
  }
  async setModel(): Promise<void> { /* recorded via spies where needed */ }
  async setPermissionMode(): Promise<void> { /* not asserted here */ }
  async applyFlagSettings(settings: { effortLevel?: string | null }): Promise<void> { this.flagSettings.push(settings); }
  async stopTask(taskId: string): Promise<void> { this.stopped.push(taskId); }
  async supportedModels(): Promise<unknown[]> { return [{ value: "opus" }]; }
  async initializationResult(): Promise<unknown> { return { model: "opus" }; }
  close(): void { this.closed = true; this.end(); }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async (): Promise<IteratorResult<unknown>> => {
        const ready = this.pending.shift();
        if (ready !== undefined) return { value: ready, done: false };
        if (this.ended) return { value: undefined, done: true };
        return await new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function makeSession(): { session: ClaudeHostSession; query: FakeQuery; events: HostEvent[] } {
  let query!: FakeQuery;
  const session = new ClaudeHostSession("session-1", (input) => (query = new FakeQuery(input)));
  const events: HostEvent[] = [];
  session.subscribe((event) => events.push(event));
  return { session, query, events };
}

function successResult(uuid?: string): Record<string, unknown> {
  return {
    type: "result", subtype: "success", is_error: false, result: "ok", origin: { kind: "human" },
    ...(uuid === undefined ? {} : { user_message_uuid: uuid }),
  };
}

test("a send reaches the query and the turn settles on its matching result", async () => {
  const { session, query, events } = makeSession();
  assert.equal(session.send("uuid-a", "hello"), true);
  await delay(5);
  assert.equal(query.received.length, 1);
  assert.equal(query.received[0]!.uuid, "uuid-a");
  assert.equal(query.received[0]!.origin.kind, "human");
  assert.equal(session.status().activity, "working");

  query.push(successResult("uuid-a"));
  await delay(5);
  const completed = events.filter((event) => event.type === "turn/completed");
  assert.equal(completed.length, 1);
  assert.equal((completed[0] as any).uuid, "uuid-a");
  assert.equal((completed[0] as any).status, "completed");
  assert.equal(session.status().activity, "idle");
  session.close();
});

test("re-sending an accepted uuid does not enqueue a second turn", async () => {
  const { session, query } = makeSession();
  assert.equal(session.send("uuid-a", "hello"), true);
  assert.equal(session.send("uuid-a", "hello"), false);
  await delay(5);
  assert.equal(query.received.length, 1);
  assert.deepEqual(session.status().inFlightTurns, ["uuid-a"]);
  session.close();
});

// Measured: an interrupted turn emits error_during_execution with NO user_message_uuid.
// Keying settlement on the uuid alone would leave the turn in flight forever.
test("an interrupted turn settles on an uncorrelated terminal result", async () => {
  const { session, query, events } = makeSession();
  session.send("uuid-a", "count to 500");
  await delay(5);
  query.push({ type: "result", subtype: "error_during_execution", is_error: true, origin: { kind: "human" } });
  await delay(5);

  const completed = events.filter((event) => event.type === "turn/completed");
  assert.equal(completed.length, 1);
  assert.equal((completed[0] as any).uuid, "uuid-a", "attributed to the oldest in-flight turn");
  assert.equal((completed[0] as any).status, "interrupted");
  assert.equal(session.status().activity, "idle");
  session.close();
});

test("queued turns settle in submission order when results carry no uuid", async () => {
  const { session, query, events } = makeSession();
  session.send("uuid-a", "first");
  session.send("uuid-b", "second");
  await delay(5);
  assert.deepEqual(session.status().inFlightTurns, ["uuid-a", "uuid-b"]);

  query.push({ type: "result", subtype: "error_during_execution", is_error: true, origin: { kind: "human" } });
  await delay(5);
  query.push(successResult("uuid-b"));
  await delay(5);

  const completed = events.filter((event) => event.type === "turn/completed");
  assert.deepEqual(completed.map((event) => (event as any).uuid), ["uuid-a", "uuid-b"]);
  assert.equal(session.status().activity, "idle");
  session.close();
});

// Measured: a background task outlives its parent turn and settles through a
// task-notification result. It is delivered, but it must not settle a human turn and
// must keep the session out of idle while it runs.
test("a background task keeps the session non-idle and never settles a human turn", async () => {
  const { session, query, events } = makeSession();
  session.send("uuid-a", "start a background job");
  await delay(5);
  query.push({ type: "system", subtype: "task_started", task_id: "task-1" });
  query.push(successResult("uuid-a"));
  await delay(5);

  assert.equal(session.status().activity, "background", "parent turn done, task still running");
  assert.equal(session.isEvictable(), false);
  assert.deepEqual(session.status().backgroundTasks.map((task) => task.taskId), ["task-1"]);

  query.push({
    type: "result", subtype: "success", is_error: false, result: "bg done",
    origin: { kind: "task-notification" },
  });
  await delay(5);
  const taskCompletions = events.filter((event) => event.type === "turn/completed" && (event as any).origin === "task-notification");
  assert.equal(taskCompletions.length, 1, "the task result is still a deliverable end-of-turn");
  assert.equal((taskCompletions[0] as any).uuid, undefined, "but it settles no accepted send");

  query.push({ type: "system", subtype: "task_notification", task_id: "task-1", status: "completed" });
  await delay(5);
  assert.equal(session.status().activity, "idle");
  assert.equal(session.isEvictable(), true);
  session.close();
});

test("background_tasks_changed reconciles the authoritative task set", async () => {
  const { session, query } = makeSession();
  query.push({ type: "system", subtype: "task_started", task_id: "task-1" });
  await delay(5);
  query.push({
    type: "system", subtype: "background_tasks_changed",
    tasks: [{ task_id: "task-2", task_type: "bash" }],
  });
  await delay(5);
  assert.deepEqual(session.status().backgroundTasks.map((task) => task.taskId), ["task-2"],
    "a task absent from the authoritative set is dropped");
  session.close();
});

// Measured: subagent content carries parent_tool_use_id and one human turn with a
// subagent produced exactly one result. Nested content must not read as top-level.
test("subagent content is nested and does not become a top-level bubble", async () => {
  const { session, query, events } = makeSession();
  session.send("uuid-a", "use a subagent");
  await delay(5);
  query.push({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "top" }] } });
  query.push({ type: "assistant", parent_tool_use_id: "tool-1", subagent_type: "Explore", message: { content: [] } });
  query.push({ type: "user", parent_tool_use_id: "tool-1", message: { role: "user", content: "tool result" } });
  await delay(5);

  assert.equal(events.filter((event) => event.type === "content/assistant").length, 1);
  assert.equal(events.filter((event) => event.type === "content/nested").length, 1);
  assert.equal(events.filter((event) => event.type === "turn/completed").length, 0,
    "a subagent emits no terminal result of its own");
  session.close();
});

test("a query that ends with turns in flight settles them as interrupted", async () => {
  const { session, query, events } = makeSession();
  session.send("uuid-a", "hello");
  await delay(5);
  query.end();
  await session.drained;

  const completed = events.filter((event) => event.type === "turn/completed");
  assert.equal(completed.length, 1);
  assert.equal((completed[0] as any).status, "interrupted");
  assert.equal(session.status().activity, "idle");
});

test("sending to a closed session fails rather than silently dropping", async () => {
  const { session } = makeSession();
  session.close();
  assert.throws(() => session.send("uuid-a", "hello"), /closed/);
});

// Claude's own background work is NOT conversation: when it finishes the agent reports and
// that report is an ordinary end-of-turn. The set is tracked only to drive a live
// "2 background tasks, 1 subagent running" indicator beside the composer.
test("subagents and background tasks are counted separately for the activity indicator", async () => {
  const { session, query, events } = makeSession();
  query.push({ type: "system", subtype: "task_started", task_id: "bash-1", description: "npm test" });
  query.push({ type: "system", subtype: "task_started", task_id: "agent-1", subagent_type: "Explore", description: "survey" });
  await delay(5);

  const latest = () => events.filter((event) => event.type === "task/set").at(-1) as any;
  assert.equal(latest().background, 1, "a backgrounded Bash counts as a background task");
  assert.equal(latest().subagents, 1, "a Task-tool subagent is counted separately");
  assert.deepEqual(latest().descriptions.sort(), ["npm test", "survey"]);

  query.push({ type: "system", subtype: "task_notification", task_id: "agent-1", status: "completed" });
  await delay(5);
  assert.equal(latest().subagents, 0, "a settled subagent leaves the indicator");
  assert.equal(latest().background, 1);
  session.close();
});

// The SDK documents background_tasks_changed as REPLACE semantics, so it is authoritative
// over the deltas — otherwise a missed notification pins a task on screen forever.
test("the authoritative task set replaces tracked tasks rather than merging them", async () => {
  const { session, query, events } = makeSession();
  query.push({ type: "system", subtype: "task_started", task_id: "stale", description: "gone" });
  await delay(5);
  query.push({
    type: "system", subtype: "background_tasks_changed",
    tasks: [{ task_id: "live", task_type: "bash", description: "still going" }],
  });
  await delay(5);

  const latest = events.filter((event) => event.type === "task/set").at(-1) as any;
  assert.equal(latest.background, 1);
  assert.deepEqual(latest.descriptions, ["still going"], "the vanished task is dropped");
  assert.deepEqual(session.status().backgroundTasks.map((task) => task.taskId), ["live"]);
  session.close();
});

// Claude emits top-level results of its own — a task notification whose origin was not
// stamped, an auto-continuation. Treating any uncorrelated result as terminal settled the
// RUNNING human turn before it had answered, and the relay then read a turn with no final
// answer yet and reported it "interrupted without a final response" while the worker was
// still writing one. Only an interrupt may claim a turn by position.
test("an uncorrelated success does not settle the running human turn", async () => {
  const { session, query, events } = makeSession();
  session.send("uuid-a", "long task");
  await delay(5);

  // Claude finishes an internal turn of its own: success, no user_message_uuid, no origin.
  query.push({ type: "result", subtype: "success", is_error: false, result: "internal" });
  await delay(5);

  assert.deepEqual(session.status().inFlightTurns, ["uuid-a"], "the human turn is still running");
  const claimed = events.filter((event) => event.type === "turn/completed" && (event as any).uuid === "uuid-a");
  assert.equal(claimed.length, 0, "nothing settled it");
  // It is still delivered, because a background task's report reaches chat this way.
  const unattributed = events.filter((event) => event.type === "turn/completed" && (event as any).origin === "task-notification");
  assert.equal(unattributed.length, 1);

  query.push(successResult("uuid-a"));
  await delay(5);
  const settled = events.filter((event) => event.type === "turn/completed" && (event as any).uuid === "uuid-a");
  assert.equal(settled.length, 1, "its own result settles it");
  assert.equal((settled[0] as any).status, "completed");
  session.close();
});

// The production leak, replayed from a stuck session's transcript: a send that arrives while
// a turn is running is folded into that turn, which answers both prompts under ITS uuid. No
// result ever names the folded send, so settling by exact uuid alone stranded it forever —
// the session reported "working" while idle and was never evictable. Nothing later settles a
// trailing folded send, which is why two sessions stuck overnight.
test("a folded send is settled by the turn that absorbed it", async () => {
  const { session, query, events } = makeSession();
  session.send("to:web:running", "this doc is still too long");
  await delay(5);
  // Sent while the first turn is still running: Claude folds it in rather than starting a turn.
  session.send("to:web:folded", "also let a subagent review our overall design");
  await delay(5);
  assert.deepEqual(session.status().inFlightTurns, ["to:web:running", "to:web:folded"]);

  // The running turn answers both prompts and settles under its own uuid. Nothing is sent
  // afterwards -- the case that stuck in production.
  query.push(successResult("to:web:running"));
  await delay(5);

  assert.deepEqual(session.status().inFlightTurns, []);
  assert.equal(session.status().activity, "idle");
  assert.equal(session.isEvictable(), true);

  const settled = events.filter((event) => event.type === "turn/completed") as any[];
  assert.deepEqual(settled.map((event) => event.uuid), ["to:web:folded", "to:web:running"]);
  // Terminal, answered inside the absorbing turn, and carrying neither that turn's result nor
  // a claim to a transcript row of its own.
  assert.equal(settled[0].folded, true);
  assert.equal(settled[0].result, undefined);
  assert.equal(settled[1].folded, undefined);
  assert.equal(settled[1].status, "completed");
  session.close();
});

// A late or duplicate result for a turn already settled must not settle a DIFFERENT one: the
// runtime attributes a uuid-less human terminal to the running head, so falling through here
// would kill an unrelated turn that is still working.
test("a result naming a turn no longer in flight settles nothing", async () => {
  const { session, query, events } = makeSession();
  session.send("uuid-a", "first");
  await delay(5);
  query.push(successResult("uuid-a"));
  await delay(5);
  session.send("uuid-b", "second");
  await delay(5);
  query.push(successResult("uuid-a"));
  await delay(5);

  assert.deepEqual(session.status().inFlightTurns, ["uuid-b"]);
  assert.equal(session.status().activity, "working");
  const settled = events.filter((event) => event.type === "turn/completed") as any[];
  assert.equal(settled.length, 2);
  assert.equal(settled[1].origin, "task-notification");
  assert.equal(settled[1].uuid, undefined);
  session.close();
});

// An interrupt keeps queued sends -- they still run -- but one already folded into the
// aborted turn never runs and never produces a result. The interrupt receipt says which is
// which, so the folded one is settled on evidence instead of stranded forever.
test("the interrupt receipt settles a folded send while queued sends survive", async () => {
  const { session, query, events } = makeSession();
  session.send("uuid-a", "count to 500");
  await delay(5);
  session.send("uuid-folded", "actually make it 5");
  session.send("uuid-queued", "then say hello");
  await delay(5);
  query.receipt = { still_queued: ["uuid-queued"] };

  await session.interrupt();
  assert.deepEqual(session.status().inFlightTurns, ["uuid-a", "uuid-queued"]);
  const folded = events.filter((event) => event.type === "turn/completed") as any[];
  assert.deepEqual(folded.map((event) => event.uuid), ["uuid-folded"]);
  assert.equal(folded[0].folded, true);

  query.push({ type: "result", subtype: "error_during_execution", is_error: true, origin: { kind: "human" } });
  await delay(5);
  // The survivor is still running and must not have been settled by any of it.
  assert.deepEqual(session.status().inFlightTurns, ["uuid-queued"]);
  assert.equal(session.status().activity, "working");
  session.close();
});

// A CLI too old to send a receipt reports nothing, and nothing is not "none": settling on it
// would report a live turn as ended.
test("an interrupt with no receipt settles nothing", async () => {
  const { session, query, events } = makeSession();
  session.send("uuid-a", "work");
  await delay(5);
  session.send("uuid-b", "more");
  await delay(5);
  query.receipt = undefined;

  await session.interrupt();
  assert.deepEqual(session.status().inFlightTurns, ["uuid-a", "uuid-b"]);
  assert.equal(events.filter((event) => event.type === "turn/completed").length, 0);
  session.close();
});

// The aborted turn is identified by uuid, not by position. When its result arrives before the
// receipt the aborted head is already gone and the folded send sits at index 0, so a
// position-based guard skips it -- stranding it "working" forever, the exact leak this
// reconciliation exists to close.
test("a folded send is settled even when the abort result precedes the receipt", async () => {
  const { session, query, events } = makeSession();
  session.send("uuid-a", "count to 500");
  await delay(5);
  session.send("uuid-folded", "actually stop");
  await delay(5);
  query.abortResultBeforeReceipt = true;

  await session.interrupt();
  await delay(5);
  assert.deepEqual(session.status().inFlightTurns, []);
  assert.equal(session.status().activity, "idle");
  assert.equal(session.isEvictable(), true);
  const settled = events.filter((event) => event.type === "turn/completed") as any[];
  assert.deepEqual(settled.map((event) => event.uuid), ["uuid-a", "uuid-folded"]);
  assert.equal(settled[0].status, "interrupted");
  assert.equal(settled[1].folded, true);
  session.close();
});

// SDKResultError declares no user_message_uuid on ANY of its four subtypes, so position is
// the only attribution there is. Handling only error_during_execution left the rest falling
// through as uncorrelated and stranding the turn "working" forever.
for (const subtype of ["error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"]) {
  test(`a ${subtype} result settles the running turn rather than stranding it`, async () => {
    const { session, query, events } = makeSession();
    session.send("uuid-a", "work");
    await delay(5);
    query.push({ type: "result", subtype, is_error: true, origin: { kind: "human" } });
    await delay(5);

    assert.deepEqual(session.status().inFlightTurns, []);
    assert.equal(session.status().activity, "idle");
    const settled = events.filter((event) => event.type === "turn/completed") as any[];
    assert.deepEqual(settled.map((event) => event.uuid), ["uuid-a"]);
    assert.equal(settled[0].origin, "human");
    assert.equal(settled[0].status, "failed", "a budget or turn-limit stop is a failure, not an interrupt");
    session.close();
  });
}

// The flag guarding re-entrant interrupts must not be able to latch. An interrupt over
// nothing in flight aborts no turn, so no abort result will ever arrive to clear it -- and a
// latch there silently disables this reconciliation for the rest of the session's life.
test("an interrupt that aborts nothing does not disable later reconciliation", async () => {
  const { session, query, events } = makeSession();
  await session.interrupt();

  session.send("uuid-a", "work");
  await delay(5);
  session.send("uuid-folded", "actually");
  await delay(5);
  query.receipt = { still_queued: [] };
  await session.interrupt();

  assert.deepEqual(session.status().inFlightTurns, ["uuid-a"], "the folded send is still settled");
  const settled = events.filter((event) => event.type === "turn/completed") as any[];
  assert.deepEqual(settled.map((event) => event.uuid), ["uuid-folded"]);
  session.close();
});

// The receipt is a snapshot taken with abort processing, so it can never name a send that
// arrived during the round trip -- and over ssh that window is a whole network round trip.
// "Press stop, then immediately type what you actually wanted" must not be reported answered
// before it has run.
test("a send accepted during the interrupt round trip is not folded", async () => {
  const { session, query, events } = makeSession();
  session.send("uuid-a", "count to 500");
  await delay(5);
  query.onInterrupt = () => { session.send("uuid-typed-after-stop", "do this instead"); };

  await session.interrupt();
  await delay(5);
  assert.deepEqual(session.status().inFlightTurns, ["uuid-a", "uuid-typed-after-stop"]);
  assert.equal(session.status().activity, "working");
  assert.deepEqual(events.filter((event) => event.type === "turn/completed"), []);
  session.close();
});

// `origin` has eight kinds and only task-notification was excluded, so the other six could
// claim a turn they never owned. QiYan's goal feature drives sessions through Claude's Stop
// hook -- auto-continuation -- which is the likeliest source of error_max_turns, so a
// goal-driven worker hitting the cap settled the user's still-running turn.
const nonHumanOrigins = ["auto-continuation", "peer", ["coor", "dinator"].join(""), "observer", "channel", "observer-activity"];
for (const kind of nonHumanOrigins) {
  test(`a ${kind} error result does not settle the running human turn`, async () => {
    const { session, query, events } = makeSession();
    session.send("uuid-human", "work on this");
    await delay(5);
    query.push({ type: "result", subtype: "error_max_turns", is_error: true, origin: { kind } });
    await delay(5);

    assert.deepEqual(session.status().inFlightTurns, ["uuid-human"], "still running, still owned");
    assert.equal(session.status().activity, "working");
    const settled = events.filter((event) => event.type === "turn/completed") as any[];
    assert.deepEqual(settled.map((event) => event.origin), ["task-notification"]);
    assert.equal(settled[0].uuid, undefined, "delivered, but it settles nothing");
    session.close();
  });
}
