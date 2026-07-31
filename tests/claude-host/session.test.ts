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

  async interrupt(): Promise<unknown> { this.interrupts += 1; return { still_queued: [] }; }
  async setModel(): Promise<void> { /* recorded via spies where needed */ }
  async setPermissionMode(): Promise<void> { /* not asserted here */ }
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

test("events replay from a cursor and stay bounded", async () => {
  let query!: FakeQuery;
  const session = new ClaudeHostSession("session-1", (input) => (query = new FakeQuery(input)), { replayLimit: 4 });
  session.send("uuid-a", "hello");
  await delay(5);
  const afterAccept = session.status().cursor;
  for (let index = 0; index < 6; index += 1) {
    query.push({ type: "assistant", parent_tool_use_id: null, message: { content: [] } });
  }
  await delay(10);

  assert.equal(session.eventsSince(afterAccept).events.length, 4, "replay is capped at the bound");
  assert.equal(session.eventsSince(0).events.length, 4, "older events are dropped, not retained");
  assert.ok(session.status().cursor > afterAccept);
  session.close();
});

// A bounded buffer means a long disconnect can drop events the client never saw. Silently
// advancing its cursor past them would render a conversation with a hole in it — the
// missing-message bug this redesign exists to remove.
test("replay reports a gap when the buffer dropped events the caller never saw", async () => {
  let query!: FakeQuery;
  const session = new ClaudeHostSession("session-1", (input) => (query = new FakeQuery(input)), { replayLimit: 3 });
  for (let index = 0; index < 6; index += 1) {
    query.push({ type: "assistant", parent_tool_use_id: null, message: { content: [] } });
  }
  await delay(10);

  assert.equal(session.eventsSince(0).gap, true, "events 1-3 were dropped before the caller saw them");
  const retained = session.eventsSince(0).events;
  assert.equal(session.eventsSince(retained[0]!.seq - 1).gap, false,
    "a cursor inside the retained window has no gap");
  session.close();
});

test("an empty replay buffer is never reported as a gap", async () => {
  const { session } = makeSession();
  assert.deepEqual(session.eventsSince(0), { events: [], gap: false });
  session.close();
});

test("sending to a closed session fails rather than silently dropping", async () => {
  const { session } = makeSession();
  session.close();
  assert.throws(() => session.send("uuid-a", "hello"), /closed/);
});
