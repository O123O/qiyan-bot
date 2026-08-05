import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ClaudeCodeRuntime, type ClaudePersistentRuntime } from "../../src/endpoints/claude-runtime.ts";
import { CLAUDE_PAGE_WINDOW_BYTES, ClaudeTranscriptHistory } from "../../src/endpoints/claude-history.ts";
import type { ClaudeCommandRunner, ClaudeTranscriptChunkRequest } from "../../src/endpoints/claude-command-runner.ts";
import type { ClaudeHost, OpenSessionRequest } from "../../src/claude-host/host.ts";
import type { HostEvent, SessionStatus } from "../../src/claude-host/protocol.ts";
import { ClaudeArchiveStore } from "../../src/sessions/claude-archives.ts";
import { AppError } from "../../src/core/errors.ts";
import { JsonRpcResponseError } from "../../src/app-server/rpc-client.ts";
import { createHistoryScanBudget, ThreadHistoryReader } from "../../src/app-server/thread-history.ts";
import { createTestDatabase } from "../../src/storage/database.ts";

// One fake standing in for both halves of a Claude endpoint: the host that runs turns
// (one long-lived session per thread) and the native transcript Claude writes while they
// run. They are one object because the invariant under test spans both — a QiYan turn id
// IS the uuid handed to the host, and Claude preserves that uuid as the transcript user
// row's own uuid, so live events and reconstructed history agree on identity.
class FakeClaude implements ClaudeHost, ClaudeCommandRunner {
  readonly opens: OpenSessionRequest[] = [];
  readonly sends: Array<{ sessionId: string; uuid: string; text: string }> = [];
  readonly setModels: Array<{ sessionId: string; model?: string }> = [];
  readonly setEfforts: Array<{ sessionId: string; effort?: string }> = [];
  readonly interrupts: string[] = [];
  readonly closes: string[] = [];
  shutdowns = 0;
  transcriptReadCount = 0;
  readonly transcriptChunkLengths: number[] = [];
  // Held open by a test that needs to act while a turn is still starting.
  openGate?: Promise<void>;
  sendGate?: Promise<void> | undefined;
  private readonly listeners = new Set<(event: HostEvent) => void>();
  private readonly sessions = new Map<string, { cwd: string; inFlight: string[]; accepted: Set<string> }>();
  private readonly transcripts = new Map<string, unknown[]>();
  private clock = 0;
  private replies = 0;

  async open(request: OpenSessionRequest): Promise<SessionStatus> {
    this.opens.push(request);
    if (this.openGate) await this.openGate;
    if (!this.sessions.has(request.sessionId)) {
      this.sessions.set(request.sessionId, { cwd: request.cwd, inFlight: [], accepted: new Set() });
    }
    return await this.status(request.sessionId);
  }

  async close(sessionId: string): Promise<void> {
    this.closes.push(sessionId);
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    // Ending a session's query settles whatever it was still running, which is the only
    // terminal event a caller waiting on that turn will ever get.
    for (const uuid of session?.inFlight.splice(0) ?? []) this.settle(sessionId, uuid, "interrupted");
  }

  async send(sessionId: string, uuid: string, text: string): Promise<boolean> {
    if (this.sendGate) await this.sendGate;
    const session = this.require(sessionId);
    this.sends.push({ sessionId, uuid, text });
    if (session.accepted.has(uuid)) return false;
    session.accepted.add(uuid);
    session.inFlight.push(uuid);
    // Claude writes the user row as the turn begins, carrying the uuid it was handed.
    this.append(sessionId, {
      type: "user", cwd: session.cwd, promptSource: "sdk", uuid,
      message: { role: "user", content: text },
    });
    return true;
  }

  async interrupt(sessionId: string): Promise<void> {
    this.interrupts.push(sessionId);
    // interrupt() ends only the active response; the session stays loaded and usable.
    const session = this.require(sessionId);
    for (const uuid of session.inFlight.splice(0)) this.settle(sessionId, uuid, "interrupted");
  }

  async status(sessionId: string): Promise<SessionStatus> {
    // Faithful to the real host, which raises UNKNOWN_SESSION rather than reporting an idle
    // status for a session it does not hold. Tolerating it here hid the branch that reacts.
    const session = this.require(sessionId);
    return {
      sessionId,
      activity: (session?.inFlight.length ?? 0) > 0 ? "working" : "idle",
      inFlightTurns: [...(session?.inFlight ?? [])],
      backgroundTasks: (this.tasks.get(sessionId) ?? []).map((taskId) => ({ taskId, kind: "background" as const, startedAt: 0 })),
    };
  }

  async setModel(sessionId: string, model?: string): Promise<void> {
    this.require(sessionId);
    this.setModels.push({ sessionId, ...(model === undefined ? {} : { model }) });
  }

  async setEffort(sessionId: string, effort?: string): Promise<void> {
    this.require(sessionId);
    this.setEfforts.push({ sessionId, ...(effort === undefined ? {} : { effort }) });
  }

  private modelRows: unknown[] = [];
  reportModels(rows: unknown[]): void { this.modelRows = rows; }
  async models(): Promise<unknown[]> { return this.modelRows; }

  subscribe(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // Mirrors LocalClaudeHost: unload idle sessions down to the budget, sparing anything that
  // can still produce output, and announce each unload so the endpoint drops its load state.
  async evictIdle(keep: number): Promise<string[]> {
    const excess = this.sessions.size - keep;
    if (excess <= 0) return [];
    const evictable = [...this.sessions.entries()]
      .filter(([, session]) => session.inFlight.length === 0)
      .map(([sessionId]) => sessionId);
    const evicted = evictable.slice(0, excess);
    for (const sessionId of evicted) {
      this.sessions.delete(sessionId);
      this.emit({ type: "session/closed", sessionId, at: this.clock += 1 });
    }
    return evicted;
  }

  async shutdown(): Promise<void> {
    this.shutdowns += 1;
    for (const sessionId of [...this.sessions.keys()]) await this.close(sessionId);
  }

  isLoaded(sessionId: string): boolean { return this.sessions.has(sessionId); }
  inFlight(sessionId: string): string[] { return [...(this.sessions.get(sessionId)?.inFlight ?? [])]; }
  // The turn finishes on the host but its completion never reaches QiYan — a stream that ended
  // without one, or a host that answered while QiYan was restarting.
  loseCompletion(sessionId: string, uuid: string): void {
    const session = this.require(sessionId);
    session.inFlight = session.inFlight.filter((id) => id !== uuid);
  }

  // A turn the host is holding without QiYan having dispatched it in this process — what a
  // reattach finds. The real host derives a recovered turn id FROM its in-flight list
  // (ssh-claude-host.ts: `status.inFlightTurns[0]`), so a fixture that reports one without
  // holding it describes a host that cannot exist.
  holdTurn(sessionId: string, uuid: string): void {
    this.require(sessionId).inFlight.push(uuid);
  }

  // Claude answers. The SDK streams the assistant message and Claude writes the matching
  // transcript row under the SAME uuid — that identity is what keeps the live item id and
  // the reconstructed one equal, so the Web UI merges them instead of rendering both.
  reply(sessionId: string, text: string): string {
    const session = this.require(sessionId);
    const uuid = `agent-${this.replies++}`;
    const message = { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] };
    this.append(sessionId, { type: "assistant", cwd: session.cwd, uuid, message });
    this.emit({ type: "content/assistant", sessionId, message: { uuid, message }, at: this.clock += 1 });
    return uuid;
  }

  // Production behaviour: `claude` reports a turn finished over its stream before it has
  // appended that turn's last row. Dropping the newest row reproduces a transcript that the
  // terminal has outrun.
  withholdTranscriptTail(sessionId: string): void {
    this.transcripts.get(sessionId)?.pop();
  }

  // Measured in production: the stream carries the assistant message before its stop reason is
  // settled, and the transcript row is written with it later. The live item therefore looks
  // like commentary while its reconstructed twin is the final answer.
  replyWithSettledStopReasonOnlyOnDisk(sessionId: string, text: string): string {
    const session = this.require(sessionId);
    const uuid = `agent-${this.replies++}`;
    const content = [{ type: "text", text }];
    this.append(sessionId, { type: "assistant", cwd: session.cwd, uuid, message: { role: "assistant", stop_reason: "end_turn", content } });
    this.emit({
      type: "content/assistant",
      sessionId,
      message: { uuid, message: { role: "assistant", stop_reason: null, content } },
      at: this.clock += 1,
    });
    return uuid;
  }

  // The turn's terminal result, settling the oldest accepted send (SDK ordering).
  complete(sessionId: string, status: "completed" | "failed" = "completed"): void {
    const uuid = this.require(sessionId).inFlight.shift();
    if (uuid !== undefined) this.settle(sessionId, uuid, status);
  }

  // A native background task reports in after its parent turn: Claude answers a
  // <task-notification> row and the run ends in a task-notification result. Reconstruction
  // starts no turn on that row, so both rows fold into the turn they follow.
  backgroundReply(sessionId: string, text: string): string {
    const session = this.require(sessionId);
    this.append(sessionId, {
      type: "user", cwd: session.cwd, promptSource: "sdk", uuid: `task-user-${this.replies}`,
      message: { role: "user", content: "<task-notification><task-id>task-1</task-id></task-notification>" },
    });
    const uuid = this.reply(sessionId, text);
    this.emit({
      type: "turn/completed", sessionId, origin: "task-notification", status: "completed",
      result: { uuid: `result-${uuid}` }, at: this.clock += 1,
    });
    return uuid;
  }

  // The `claude` child dies under a loaded session: the host settles whatever was running
  // and retires the session, exactly as ClaudeHostSession.drain does.
  killSession(sessionId: string): void {
    const session = this.require(sessionId);
    this.sessions.delete(sessionId);
    for (const uuid of session.inFlight.splice(0)) this.settle(sessionId, uuid, "interrupted");
    this.emit({ type: "session/closed", sessionId, at: this.clock += 1 });
  }

  // A whole answered turn, the way a real session delivers one.
  answer(sessionId: string, text: string): string {
    const uuid = this.reply(sessionId, text);
    this.complete(sessionId);
    return uuid;
  }

  async readTranscriptChunk(threadId: string, _cwd: string, request: ClaudeTranscriptChunkRequest) {
    this.transcriptReadCount += 1;
    this.transcriptChunkLengths.push(request.length);
    const records = this.transcripts.get(threadId);
    if (!records) return undefined;
    const all = Buffer.from(records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
    const snapshot = { device: "fake", inode: threadId, size: all.length };
    if (request.expected) assert.deepEqual(request.expected, snapshot);
    const offset = request.offset === "tail" ? Math.max(0, all.length - request.length) : request.offset;
    return { snapshot, offset, bytes: all.subarray(offset, Math.min(all.length, offset + request.length)) };
  }

  seed(threadId: string, records: unknown[]): void { this.transcripts.set(threadId, records); }
  async transcriptPath(threadId: string) { return this.transcripts.has(threadId) ? `/fake/${threadId}.jsonl` : undefined; }
  async listThreads(cwd?: string) {
    return [...this.transcripts.keys()].map((id) => ({ id, cwd: cwd ?? "/fake", updatedAt: 0, preview: "" }));
  }

  private append(threadId: string, record: unknown): void {
    const records = this.transcripts.get(threadId) ?? [];
    records.push(record);
    this.transcripts.set(threadId, records);
  }

  settleTurn(sessionId: string, uuid: string, status: "completed" | "failed" | "interrupted"): void {
    this.settle(sessionId, uuid, status);
  }

  private settle(sessionId: string, uuid: string, status: "completed" | "failed" | "interrupted"): void {
    this.emit({ type: "turn/completed", sessionId, origin: "human", uuid, status, at: this.clock += 1 });
  }

  emit(event: HostEvent): void { for (const listener of this.listeners) listener(event); }

  readonly stoppedTasks: string[] = [];
  // Tasks that accept the stop call and keep running — what a real stopTask does until the
  // SDK emits the task_notification that actually retires the task.
  readonly ignoreStopFor = new Set<string>();
  private readonly tasks = new Map<string, string[]>();
  setBackgroundTasks(sessionId: string, taskIds: string[]): void { this.tasks.set(sessionId, taskIds); }
  async stopTask(sessionId: string, taskId: string): Promise<void> {
    this.stoppedTasks.push(taskId);
    if (this.ignoreStopFor.has(taskId)) return;
    this.tasks.set(sessionId, (this.tasks.get(sessionId) ?? []).filter((id) => id !== taskId));
  }

  private require(sessionId: string) {
    const session = this.sessions.get(sessionId);
    // Same error the real host raises, so callers that discriminate on it are exercised.
    if (!session) throw new AppError("UNKNOWN_SESSION", `claude session is not loaded: ${sessionId}`);
    return session;
  }

  // The host was replaced underneath us: its sessions are gone, with no loss report.
  dropSessions(): void { this.sessions.clear(); }
}

function makeRuntime(claude: FakeClaude, launchFlags: { model?: string; effort?: string } = { model: "claude-opus-4-8" }) {
  return new ClaudeCodeRuntime({ id: "claude-local", host: claude, runner: claude, launchFlags });
}

// A remote endpoint: the host outlives QiYan, so lifecycle runs through the persistent
// runtime rather than the in-process host.
function persistentRuntime(overrides: Partial<ClaudePersistentRuntime> = {}): ClaudePersistentRuntime {
  return {
    async start() {},
    async closeConnection() {},
    async shutdownRuntime() {},
    async runtimeIdentity() { return undefined; },
    onUnavailable() { return () => undefined; },
    async recoverTurn() { return undefined; },
    async releaseThread() {},
    ...overrides,
  };
}

test("a persistent Claude backend owns endpoint lifecycle without killing an in-flight turn on detach", async () => {
  const claude = new FakeClaude();
  const identity = {
    kind: "ssh" as const,
    token: "0123456789abcdef0123456789abcdef",
    pid: 123,
    linuxStartTime: "456",
    processGroupId: 123,
  };
  const stops: unknown[] = [];
  let starts = 0;
  let closes = 0;
  const persistent = persistentRuntime({
    async start() { starts += 1; },
    async closeConnection() { closes += 1; },
    async shutdownRuntime(expected) { stops.push(expected); },
    async runtimeIdentity() { return identity; },
  });
  const rt = new ClaudeCodeRuntime({
    id: "claude-remote",
    host: claude,
    runner: claude,
    launchFlags: {},
    persistentRuntime: persistent,
  });

  assert.equal(rt.daemonless, false);
  await rt.start();
  assert.equal(starts, 1);
  const { thread } = await rt.request<{ thread: { id: string } }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", {
    threadId: thread.id,
    clientUserMessageId: "ctx:persist",
    input: [{ type: "text", text: "keep running" }],
  });

  await rt.closeConnection();
  assert.equal(closes, 1);
  assert.equal(claude.shutdowns, 0, "detaching must not shut down the remote host");
  assert.deepEqual(claude.inFlight(thread.id), ["ctx:persist"], "the remote turn keeps running");
  assert.deepEqual(await rt.runtimeIdentity(), identity);
  await rt.shutdownRuntime(identity);
  assert.deepEqual(stops, [identity]);
});

test("cold resume adopts the turn the persistent host reports still running", async () => {
  const claude = new FakeClaude();
  claude.seed("remote-live", [{
    type: "user",
    cwd: "/remote/work",
    promptSource: "sdk",
    uuid: "ctx:live",
    message: { role: "user", content: "work" },
  }]);
  const rt = new ClaudeCodeRuntime({
    id: "claude-remote",
    host: claude,
    runner: claude,
    launchFlags: {},
    persistentRuntime: persistentRuntime({
      async recoverTurn(threadId: string) {
        if (threadId !== "remote-live") return undefined;
        // A recovered turn means the host still holds that session, so model it: the
        // runtime adopts it as loaded and sends to it without reopening.
        await claude.open({ sessionId: threadId, mode: "resume", cwd: "/remote/work" });
        claude.holdTurn(threadId, "ctx:live");
        return { turnId: "ctx:live" };
      },
    }),
  });
  await rt.start();

  const resumed = await rt.request<{ thread: { status: unknown } }>("thread/resume", {
    threadId: "remote-live",
    cwd: "/remote/work",
    excludeTurns: true,
  });
  assert.deepEqual(resumed.thread.status, { type: "active" });
  // The adopted turn is still in progress, not silently reported interrupted like a
  // trailing row left behind by a dead process.
  const read = await rt.request<{ thread: { turns: Array<{ id: string; status: string }> } }>(
    "thread/read", { threadId: "remote-live", includeTurns: true },
  );
  assert.deepEqual(read.thread.turns.map((turn) => [turn.id, turn.status]), [["ctx:live", "inProgress"]]);
  // The adopted turn is not refused-on-top any more: the SDK queues a new send behind it,
  // exactly as the Claude Code CLI queues what you type while it is working.
  await rt.request("turn/start", {
    threadId: "remote-live",
    clientUserMessageId: "ctx:queued",
    input: [{ type: "text", text: "next" }],
  });
  const after = await rt.request<{ thread: { turns: Array<{ id: string; status: string }> } }>(
    "thread/read", { threadId: "remote-live", includeTurns: true },
  );
  assert.ok(after.thread.turns.some((turn) => turn.id === "ctx:live" && turn.status === "inProgress"),
    "the adopted turn keeps running");
});

test("concurrent cold resumes share one state load and one persistent turn recovery", async () => {
  const claude = new FakeClaude();
  claude.seed("remote-shared", [{
    type: "user",
    cwd: "/remote/work",
    promptSource: "sdk",
    uuid: "ctx:shared",
    message: { role: "user", content: "work" },
  }]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let recoveries = 0;
  const rt = new ClaudeCodeRuntime({
    id: "claude-remote",
    host: claude,
    runner: claude,
    launchFlags: {},
    persistentRuntime: persistentRuntime({
      async recoverTurn() {
        recoveries += 1;
        await gate;
        return { turnId: "ctx:shared" };
      },
    }),
  });
  await rt.start();

  const first = rt.request("thread/resume", {
    threadId: "remote-shared",
    cwd: "/remote/work",
    excludeTurns: true,
  });
  const second = rt.request("thread/resume", {
    threadId: "remote-shared",
    cwd: "/remote/work",
    excludeTurns: true,
  });
  await delay(0);
  assert.equal(recoveries, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(recoveries, 1);
});

test("cold archive and unsubscribe always release persistent remote materialization", async () => {
  const released: string[] = [];
  const rt = new ClaudeCodeRuntime({
    id: "claude-remote",
    host: new FakeClaude(),
    runner: new FakeClaude(),
    launchFlags: {},
    persistentRuntime: persistentRuntime({
      async releaseThread(threadId: string) { released.push(threadId); },
    }),
  });
  await rt.start();

  await rt.request("thread/archive", { threadId: "cold-archive" });
  await rt.request("thread/unsubscribe", { threadId: "cold-unsubscribe" });
  assert.deepEqual(released, ["cold-archive", "cold-unsubscribe"]);
});

test("a Claude thread reserves its start before the session finishes opening", async () => {
  const claude = new FakeClaude();
  let release!: () => void;
  claude.openGate = new Promise<void>((resolve) => { release = resolve; });
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: { id: string } }>("thread/start", { cwd: "/w" });
  const first = rt.request("turn/start", {
    threadId: thread.id,
    clientUserMessageId: "ctx:first",
    input: [{ type: "text", text: "first" }],
  });
  await delay(0);
  const second = rt.request("turn/start", {
    threadId: thread.id,
    clientUserMessageId: "ctx:second",
    input: [{ type: "text", text: "second" }],
  }).then(
    () => ({ status: "fulfilled" as const }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
  await delay(0);
  release();
  const [firstOutcome, secondOutcome] = await Promise.all([Promise.allSettled([first]).then((items) => items[0]!), second]);

  // Sends arriving while the session is still opening share that one open — opening twice
  // would race two SDK queries onto the same native session id — and both are then queued.
  assert.equal(claude.opens.length, 1, "the second turn must not open a second session");
  assert.equal(firstOutcome.status, "fulfilled");
  assert.equal(secondOutcome.status, "fulfilled", "a concurrent send queues rather than being refused");
  assert.deepEqual(claude.sends.map((send) => send.uuid), ["ctx:first", "ctx:second"],
    "both reached the session, in submission order");
});

test("a close racing a session open fences the turn and unloads the session it opened", async () => {
  const claude = new FakeClaude();
  let release!: () => void;
  claude.openGate = new Promise<void>((resolve) => { release = resolve; });
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: { id: string } }>("thread/start", { cwd: "/w" });
  const pending = rt.request("turn/start", {
    threadId: thread.id,
    clientUserMessageId: "ctx:late",
    input: [{ type: "text", text: "late" }],
  });
  await delay(0);
  await rt.closeConnection();
  release();

  await assert.rejects(pending, /endpoint changed while its turn was starting/u);
  // The session that finished opening after the shutdown swept the host must not be left
  // loaded: nothing would ever observe or interrupt a turn running inside it.
  assert.deepEqual(claude.sends, []);
  assert.equal(claude.isLoaded(thread.id), false);
  assert.equal(rt.state, "stopped");
});

// The local Claude endpoint is a builtin: the manager hands the SAME object back across a
// restart, so this thread map outlives the sessions the host just swept. A thread still
// marked loaded would skip host.open and send into a session that no longer exists.
test("a restarted local endpoint reopens the sessions its host dropped", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: { id: string } }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", {
    threadId: thread.id, clientUserMessageId: "ctx:before", input: [{ type: "text", text: "hi" }],
  });
  claude.answer(thread.id, "answered");
  await delay(5);

  await rt.closeConnection();
  assert.equal(claude.isLoaded(thread.id), false, "the in-process host closed every session");
  await rt.start();

  await rt.request("turn/start", {
    threadId: thread.id, clientUserMessageId: "ctx:after", input: [{ type: "text", text: "again" }],
  });
  assert.equal(claude.isLoaded(thread.id), true, "the next turn reopens the session it needs");
  assert.deepEqual(claude.opens.map((request) => request.mode), ["create", "resume"],
    "the reopened session resumes the native transcript rather than forking a new one");
  assert.deepEqual(claude.sends.map((send) => send.uuid), ["ctx:before", "ctx:after"]);
});

// A query can end without QiYan asking: the `claude` child is killed, the CLI is replaced.
// The host retires the session; the endpoint must believe it, or the thread is wedged.
test("a session that dies under the endpoint is settled and reopened by the next turn", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const notifications: Array<{ method: string; params: any }> = [];
  rt.onNotification((method, params) => notifications.push({ method, params: params as any }));
  const { thread } = await rt.request<{ thread: { id: string } }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", {
    threadId: thread.id, clientUserMessageId: "ctx:dying", input: [{ type: "text", text: "work" }],
  });

  claude.killSession(thread.id);
  await delay(5);
  assert.deepEqual(
    notifications.filter((entry) => entry.method === "turn/completed").map((entry) => entry.params.turn),
    [{ id: "ctx:dying", status: "interrupted" }], "the turn that died with the query is settled");
  const read = await rt.request<{ thread: { status: unknown } }>("thread/read", { threadId: thread.id });
  assert.deepEqual(read.thread.status, { type: "idle" });

  await rt.request("turn/start", {
    threadId: thread.id, clientUserMessageId: "ctx:next", input: [{ type: "text", text: "next" }],
  });
  assert.equal(claude.isLoaded(thread.id), true, "the next turn opens a live session");
  assert.equal(claude.opens.length, 2);
  assert.deepEqual(claude.sends.map((send) => send.uuid), ["ctx:dying", "ctx:next"]);
});

// Stopping the remote host replaces the process that owned the sessions, so the same
// staleness applies there — plus a turn it was running can never be settled by an event.
test("stopping the remote runtime forgets the sessions and the turn that died with it", async () => {
  const claude = new FakeClaude();
  const identity = {
    kind: "ssh" as const,
    token: "0123456789abcdef0123456789abcdef",
    pid: 321,
    linuxStartTime: "654",
    processGroupId: 321,
  };
  const rt = new ClaudeCodeRuntime({
    id: "claude-remote", host: claude, runner: claude, launchFlags: {},
    persistentRuntime: persistentRuntime({ async runtimeIdentity() { return identity; } }),
  });
  await rt.start();
  const { thread } = await rt.request<{ thread: { id: string } }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", {
    threadId: thread.id, clientUserMessageId: "ctx:remote", input: [{ type: "text", text: "work" }],
  });

  await rt.shutdownRuntime(identity);
  await rt.start();
  const restarted = await rt.request<{ turn: { id: string } }>("turn/start", {
    threadId: thread.id, clientUserMessageId: "ctx:next", input: [{ type: "text", text: "next" }],
  });
  assert.equal(restarted.turn.id, "ctx:next", "the thread is not wedged on the turn that died with the host");
  assert.deepEqual(claude.opens.map((request) => request.sessionId), [thread.id, thread.id]);
});

test("a close racing persistent startup cannot republish the endpoint as ready", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let closes = 0;
  const claude = new FakeClaude();
  const rt = new ClaudeCodeRuntime({
    id: "claude-remote",
    host: claude,
    runner: claude,
    launchFlags: {},
    persistentRuntime: persistentRuntime({
      async start() { await gate; },
      async closeConnection() { closes += 1; },
    }),
  });
  const starting = rt.start();
  await delay(0);
  await rt.closeConnection();
  release();
  await starting;

  assert.equal(rt.state, "stopped");
  assert.ok(closes >= 1);
});

test("thread/start reserves an idle empty thread without loading a session", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  assert.equal(rt.state, "ready");
  const started = await rt.request<{ thread: any; model?: string }>(
    "thread/start",
    { cwd: "/w", threadSource: "worker-thread" },
  );
  const { thread } = started;
  assert.equal(typeof thread.id, "string");
  assert.equal(thread.cwd, "/w");
  assert.equal(thread.threadSource, "worker-thread");
  assert.deepEqual(thread.status, { type: "idle" });
  assert.deepEqual(thread.turns, []);
  assert.equal(started.model, "claude-opus-4-8");
  assert.deepEqual(claude.opens, [], "no session is loaded until a turn runs");
});

test("an unpinned Claude endpoint reports its catalog model and effort defaults", async () => {
  const rt = makeRuntime(new FakeClaude(), {});
  await rt.start();

  const started = await rt.request<{ model?: string; reasoningEffort?: string }>(
    "thread/start",
    { cwd: "/w" },
  );

  assert.deepEqual(
    { model: started.model, effort: started.reasoningEffort },
    { model: "default", effort: "high" },
  );
});

test("managed cold resume recreates an unmaterialized thread and accepts its first turn", async () => {
  const claude = new FakeClaude();
  const original = makeRuntime(claude);
  await original.start();
  const { thread } = await original.request<{ thread: { id: string } }>("thread/start", { cwd: "/w" });

  const recovered = makeRuntime(claude);
  await recovered.start();
  const resumed = await recovered.request<{ thread: any; model?: string }>("thread/resume", {
    threadId: thread.id,
    cwd: "/w",
    excludeTurns: true,
  });
  assert.equal(resumed.thread.id, thread.id);
  assert.equal(resumed.thread.cwd, "/w");
  assert.equal(resumed.model, "claude-opus-4-8");

  await recovered.request("turn/start", {
    threadId: thread.id,
    clientUserMessageId: "ctx:recovered",
    input: [{ type: "text", text: "continue" }],
  });
  // Nothing was ever written for this id, so the session is still created (reserving the
  // caller's uuid as the native session id), not resumed.
  assert.deepEqual(claude.opens.at(-1), { sessionId: thread.id, mode: "create", cwd: "/w", model: "claude-opus-4-8" });
});

test("the first turn creates the native session and the next resumes it; the caller's id is the turn id", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const notifications: Array<{ method: string; params: any }> = [];
  rt.onNotification((method, params) => notifications.push({ method, params: params as any }));

  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w", threadSource: "worker-thread" });
  const threadId = thread.id;

  const started = await rt.request<{ turn: any }>("turn/start", { threadId, clientUserMessageId: "ctx:call-1", input: [{ type: "text", text: "hello" }] });
  assert.deepEqual(started.turn, { id: "ctx:call-1", status: "inProgress" });
  assert.deepEqual(claude.opens, [{ sessionId: threadId, mode: "create", cwd: "/w", model: "claude-opus-4-8" }]);
  assert.deepEqual(claude.sends, [{ sessionId: threadId, uuid: "ctx:call-1", text: "hello" }],
    "QiYan must not append correlation metadata to Claude input");

  const agentUuid = claude.answer(threadId, "reply to hello");
  await delay(5);
  assert.deepEqual(notifications, [
    { method: "turn/started", params: { threadId, turn: { id: "ctx:call-1", status: "inProgress" } } },
    {
      method: "item/started",
      params: {
        threadId,
        turnId: "ctx:call-1",
        item: {
          type: "userMessage",
          id: "ctx:call-1",
          clientId: "ctx:call-1",
          content: [{ type: "text", text: "hello", text_elements: [] }],
        },
      },
    },
    {
      method: "item/completed",
      params: {
        threadId,
        turnId: "ctx:call-1",
        // phase comes from the shared rule, so this live item and its reconstructed twin
        // describe themselves identically once the Web UI merges them by id.
        item: { type: "agentMessage", id: `${agentUuid}:0`, text: "reply to hello", phase: "final_answer" },
      },
    },
    {
      method: "turn/completed",
      params: {
        threadId,
        // The terminal carries the answer it just streamed. `claude` reports a turn finished
        // before it has written that turn's last transcript row, so a terminal that sends the
        // relay to the transcript races the write — and losing reads as an interrupted turn
        // with no final response, which is delivered as a warning instead of the answer.
        turn: {
          id: "ctx:call-1",
          status: "completed",
          itemsView: "full",
          items: [{ type: "agentMessage", id: `${agentUuid}:0`, text: "reply to hello", phase: "final_answer" }],
        },
      },
    },
  ]);

  const read = await rt.request<{ thread: any }>("thread/read", { threadId, includeTurns: true });
  assert.equal(read.thread.turns.length, 1);
  const turn = read.thread.turns[0];
  assert.equal(turn.id, "ctx:call-1", "the reconstructed turn id is the id the live stream reported");
  assert.equal(turn.status, "completed");
  assert.equal(turn.itemsView, "full");
  assert.equal(turn.items[0].type, "userMessage");
  const final = turn.items.find((i: any) => i.type === "agentMessage" && i.phase === "final_answer");
  assert.equal(final.text, "reply to hello");

  // The second turn resumes the native session rather than recreating it.
  await rt.request("turn/start", { threadId, clientUserMessageId: "ctx:call-2", input: [{ type: "text", text: "again" }] });
  assert.equal(claude.opens.length, 1, "a loaded session is reused without reopening");
  assert.deepEqual(claude.sends.at(-1), { sessionId: threadId, uuid: "ctx:call-2", text: "again" });
});

// Every loaded session pins a live SDK query and the `claude` child behind it. Nothing else
// ever unloads one, so without a budget applied at turn completion a long-running QiYan
// holds one resident process per thread it has ever driven.
test("a settled turn unloads idle sessions above the budget, and a later turn reloads them", async () => {
  const claude = new FakeClaude();
  const rt = new ClaudeCodeRuntime({
    id: "claude-local", host: claude, runner: claude, launchFlags: {}, loadedSessionBudget: 1,
  });
  await rt.start();
  const first = (await rt.request<{ thread: { id: string } }>("thread/start", { cwd: "/w" })).thread.id;
  const second = (await rt.request<{ thread: { id: string } }>("thread/start", { cwd: "/w" })).thread.id;

  await rt.request("turn/start", { threadId: first, clientUserMessageId: "a:1", input: [{ type: "text", text: "one" }] });
  claude.answer(first, "done one");
  await delay(5);
  await rt.request("turn/start", { threadId: second, clientUserMessageId: "b:1", input: [{ type: "text", text: "two" }] });
  claude.answer(second, "done two");
  await delay(5);

  assert.equal(claude.isLoaded(first), false, "the idle session above the budget is unloaded");
  assert.equal(claude.isLoaded(second), true, "the session just used stays loaded");

  await rt.request("turn/start", { threadId: first, clientUserMessageId: "a:2", input: [{ type: "text", text: "again" }] });
  assert.equal(claude.isLoaded(first), true, "an unloaded thread reopens on its next turn");
  assert.deepEqual(claude.opens.map((request) => [request.sessionId, request.mode]),
    [[first, "create"], [second, "create"], [first, "resume"]]);
});

// A session is idle on the host between being opened and taking its message, so a sweep
// triggered by another thread's turn completing could unload it out from under the send.
test("eviction never unloads a session whose turn is still being started", async () => {
  const claude = new FakeClaude();
  let release!: () => void;
  claude.sendGate = new Promise<void>((resolve) => { release = resolve; });
  const rt = new ClaudeCodeRuntime({
    id: "claude-local", host: claude, runner: claude, launchFlags: {}, loadedSessionBudget: 1,
  });
  await rt.start();
  const starting = (await rt.request<{ thread: { id: string } }>("thread/start", { cwd: "/w" })).thread.id;
  const other = (await rt.request<{ thread: { id: string } }>("thread/start", { cwd: "/w" })).thread.id;

  // Opened first, so it is the sweep's first eviction candidate, and still gated in send.
  const pending = rt.request("turn/start", {
    threadId: starting, clientUserMessageId: "s:1", input: [{ type: "text", text: "slow" }],
  });
  await delay(0);
  claude.sendGate = undefined;
  await rt.request("turn/start", { threadId: other, clientUserMessageId: "o:1", input: [{ type: "text", text: "quick" }] });
  claude.answer(other, "quick answer");
  await delay(5);

  release();
  const started = await pending as { turn: { id: string; status: string } };
  assert.deepEqual(started.turn, { id: "s:1", status: "inProgress" });
  assert.deepEqual(claude.sends.map((send) => send.uuid), ["o:1", "s:1"]);
});

// Native background tasks are the design: Claude owns them, and one settles after its
// parent turn. Its report must reach the live panel AND chat, and every turn id published
// for it has to be one the relay can find in the native history — a synthesized id makes
// the relay retry to exhaustion and degrade the endpoint with a recovery warning.
test("a background task's report is published on the turn history folds it into", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: { id: string } }>("thread/start", { cwd: "/w" });
  const threadId = thread.id;
  await rt.request("turn/start", {
    threadId, clientUserMessageId: "ctx:1", input: [{ type: "text", text: "count the files in the background" }],
  });
  claude.answer(threadId, "started it");
  await delay(5);

  const notifications: Array<{ method: string; params: any }> = [];
  rt.onNotification((method, params) => notifications.push({ method, params: params as any }));
  const backgroundUuid = claude.backgroundReply(threadId, "the background job finished: 42 files");
  await delay(5);

  assert.deepEqual(notifications, [
    {
      method: "item/completed",
      params: {
        threadId,
        turnId: "ctx:1",
        item: { type: "agentMessage", id: `${backgroundUuid}:0`, text: "the background job finished: 42 files", phase: "final_answer" },
      },
    },
    {
      method: "turn/completed",
      params: {
        threadId,
        // The terminal carries the text rather than sending the relay to the transcript,
        // which `claude` has not necessarily written yet. Re-publishing the parent turn's
        // own answer alongside the report is harmless: both are keyed by item id, and the
        // one already delivered dedups.
        turn: {
          id: "ctx:1",
          status: "completed",
          itemsView: "full",
          items: [
            { type: "agentMessage", id: "agent-0:0", text: "started it", phase: "final_answer" },
            { type: "agentMessage", id: `${backgroundUuid}:0`, text: "the background job finished: 42 files", phase: "final_answer" },
          ],
        },
      },
    },
  ]);

  // The relay resolves a published turn through thread/turns/list. Every id above has to be
  // findable there, and the folded report has to be part of the turn it resolves to.
  const history = new ThreadHistoryReader((method, params) => rt.request(method, params));
  const found = await history.findTurn(threadId, "ctx:1", createHistoryScanBudget());
  assert.equal(found?.id, "ctx:1");
  const exact = await history.exactTurnItems(threadId, "ctx:1", { budget: createHistoryScanBudget() });
  assert.deepEqual(
    exact.turn.items.filter((item: any) => item.type === "agentMessage").map((item: any) => [item.id, item.text]),
    [["agent-0:0", "started it"], [`${backgroundUuid}:0`, "the background job finished: 42 files"]],
    "the live item id is the id history reports for the same block");
});

// While a turn is running, its own completion carries whatever the background task added,
// so a second terminal for the same content would be noise.
test("a background task settling inside a running turn publishes no extra terminal", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: { id: string } }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", {
    threadId: thread.id, clientUserMessageId: "ctx:1", input: [{ type: "text", text: "go" }],
  });
  claude.answer(thread.id, "first answer");
  await delay(5);
  await rt.request("turn/start", {
    threadId: thread.id, clientUserMessageId: "ctx:2", input: [{ type: "text", text: "more" }],
  });

  const notifications: Array<{ method: string; params: any }> = [];
  rt.onNotification((method, params) => notifications.push({ method, params: params as any }));
  claude.backgroundReply(thread.id, "background note");
  await delay(5);

  assert.deepEqual(notifications.map((entry) => entry.method), ["item/completed"]);
  assert.equal(notifications[0]!.params.turnId, "ctx:2", "the running turn owns the rows it precedes");
});

// A loaded session never forgets a uuid it accepted, so a refused send says nothing about
// whether that turn is still running. A scheduled fire re-armed from the outbox after a
// crash reuses its single-fire key: adopting a reservation for a turn the host already
// finished would wedge the thread as SESSION_BUSY and drop the message with no trace.
test("retrying a send whose turn already finished reports it terminal instead of wedging the thread", async () => {
  const claude = new FakeClaude();
  const before = makeRuntime(claude);
  await before.start();
  const { thread } = await before.request<{ thread: { id: string } }>("thread/start", { cwd: "/w" });
  const threadId = thread.id;
  await before.request("turn/start", {
    threadId, clientUserMessageId: "fire:1", input: [{ type: "text", text: "scheduled work" }],
  });
  claude.answer(threadId, "did the work");
  await delay(5);

  // QiYan restarts; the host and its session survive, so it still remembers the uuid.
  const after = makeRuntime(claude);
  await after.start();
  await after.request("thread/resume", { threadId, cwd: "/w", excludeTurns: true });
  const notifications: Array<{ method: string; params: any }> = [];
  after.onNotification((method, params) => notifications.push({ method, params: params as any }));
  const retried = await after.request<{ turn: { id: string; status: string } }>("turn/start", {
    threadId, clientUserMessageId: "fire:1", input: [{ type: "text", text: "scheduled work" }],
  });

  assert.deepEqual(retried.turn, { id: "fire:1", status: "completed" });
  assert.deepEqual(notifications, [{ method: "turn/completed", params: { threadId, turn: { id: "fire:1" } } }],
    "the terminal is republished so the response QiYan missed is still delivered");
  const read = await after.request<{ thread: { status: unknown } }>("thread/read", { threadId });
  assert.deepEqual(read.thread.status, { type: "idle" }, "no phantom turn is left running");
  const next = await after.request<{ turn: { id: string } }>("turn/start", {
    threadId, clientUserMessageId: "fire:2", input: [{ type: "text", text: "next" }],
  });
  assert.equal(next.turn.id, "fire:2", "the thread still accepts new turns");
});

// The same refusal while the turn genuinely IS still running must keep the reservation:
// the host will settle it, and dropping it here would orphan a running response.
test("retrying a send whose turn is still running keeps the turn in progress", async () => {
  const claude = new FakeClaude();
  const before = makeRuntime(claude);
  await before.start();
  const { thread } = await before.request<{ thread: { id: string } }>("thread/start", { cwd: "/w" });
  await before.request("turn/start", {
    threadId: thread.id, clientUserMessageId: "fire:1", input: [{ type: "text", text: "long job" }],
  });

  const after = makeRuntime(claude);
  await after.start();
  await after.request("thread/resume", { threadId: thread.id, cwd: "/w", excludeTurns: true });
  const retried = await after.request<{ turn: { id: string; status: string } }>("turn/start", {
    threadId: thread.id, clientUserMessageId: "fire:1", input: [{ type: "text", text: "long job" }],
  });
  assert.deepEqual(retried.turn, { id: "fire:1", status: "inProgress" });
  const read = await after.request<{ thread: { status: unknown } }>("thread/read", { threadId: thread.id });
  assert.deepEqual(read.thread.status, { type: "active" });
});

test("a live agentMessage carries the same item id thread/read later reports for that block", async () => {
  // The Web UI keys rows by (turnId, itemId). If the live id and the reconstructed id
  // diverge, every answer renders twice after a reload.
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const live: Array<{ id: string; text: string }> = [];
  rt.onNotification((method, params) => {
    const item = (params as { item?: { type?: string; id: string; text: string } }).item;
    if (method === "item/completed" && item?.type === "agentMessage") live.push({ id: item.id, text: item.text });
  });
  const { thread } = await rt.request<{ thread: { id: string } }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:ids", input: "hi" });
  claude.answer(thread.id, "the answer");
  await delay(5);

  const read = await rt.request<{ thread: any }>("thread/read", { threadId: thread.id, includeTurns: true });
  const historical = read.thread.turns[0].items
    .filter((item: any) => item.type === "agentMessage")
    .map((item: any) => ({ id: item.id, text: item.text }));
  assert.deepEqual(live, historical);
});

test("a session that resumes an on-disk transcript opens in resume mode", async () => {
  const claude = new FakeClaude();
  claude.seed("prior", [
    { type: "user", cwd: "/w", promptSource: "sdk", uuid: "ctx:prior", message: { role: "user", content: "earlier" } },
    { type: "assistant", cwd: "/w", uuid: "prior-agent", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } },
  ]);
  const rt = makeRuntime(claude);
  await rt.start();
  await rt.request("thread/resume", { threadId: "prior", cwd: "/w", excludeTurns: true });
  await rt.request("turn/start", { threadId: "prior", clientUserMessageId: "ctx:next", input: "more" });
  assert.deepEqual(claude.opens, [{ sessionId: "prior", mode: "resume", cwd: "/w", model: "claude-opus-4-8" }]);
});

test("Claude paging uses bounded native transcript windows without backend retention", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  for (const clientId of ["ctx:one", "ctx:two"]) {
    await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: clientId, input: [{ type: "text", text: clientId }] });
    claude.answer(thread.id, `reply to ${clientId}`);
    await delay(5);
  }

  const history = new ThreadHistoryReader((method, params) => rt.request(method, params));
  const latest = await history.turnsPage(thread.id, {
    threadId: thread.id, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
  } as any);
  assert.deepEqual(latest.data.map((turn: any) => ({ id: turn.id, itemsView: turn.itemsView, items: turn.items })), [
    { id: "ctx:two", itemsView: "notLoaded", items: [] },
  ]);
  assert.equal(typeof latest.nextCursor, "string");

  const older = await history.turnsPage(thread.id, {
    cursor: latest.nextCursor!, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
  });
  assert.deepEqual(older.data.map((turn: any) => turn.id), ["ctx:one"]);
  assert.equal(older.nextCursor, null);

  const exact = await history.exactTurnItems(thread.id, "ctx:two", {
    budget: createHistoryScanBudget(),
  });
  assert.equal(exact.items[0]?.type, "userMessage");
  assert.equal(exact.turn.itemsView, "full");
  assert.equal(claude.transcriptReadCount, 4);
  assert.ok(claude.transcriptChunkLengths.every((length) => length <= 4 * 1024 * 1024));

  const metadata = await rt.request<any>("thread/read", { threadId: thread.id, includeTurns: false });
  assert.deepEqual(metadata.thread.turns, []);
  assert.deepEqual((await rt.request<any>("thread/read", { threadId: thread.id })).thread.turns, []);
  assert.equal(metadata.thread.status.type, "idle");
  assert.equal(claude.transcriptReadCount, 4);
  const resumed = await rt.request<any>("thread/resume", { threadId: thread.id, excludeTurns: true });
  assert.deepEqual(resumed.thread.turns, []);
  assert.equal(claude.transcriptReadCount, 4);
  const afterResume = new ThreadHistoryReader((method, params) => rt.request(method, params));
  const stillPersisted = await afterResume.turnsPage(thread.id, { limit: 10, sortDirection: "asc", itemsView: "notLoaded" });
  assert.deepEqual(stillPersisted.data.map((turn: any) => turn.id), ["ctx:one", "ctx:two"]);
  const persisted = await afterResume.exactTurnItems(thread.id, "ctx:two", {
    budget: createHistoryScanBudget(),
  });
  assert.equal(persisted.items[0]?.type, "userMessage");
  assert.equal(claude.transcriptReadCount, 7);
});

test("descending Claude paging preserves a turn exactly aligned with the prior window boundary", async () => {
  const claude = new FakeClaude();
  const threadId = "aligned-history";
  const cwd = "/w";
  const prefix = { type: "system", cwd, value: "prefix" };
  const older = { type: "user", cwd, promptSource: "sdk", uuid: "older", message: { role: "user", content: "older" } };
  const olderEndBase = { type: "assistant", cwd, uuid: "older-agent", padding: "", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "older reply" }] } };
  const lineBytes = (record: unknown): number => Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8");
  const paddingBytes = CLAUDE_PAGE_WINDOW_BYTES - lineBytes(older) - lineBytes(olderEndBase);
  assert.ok(paddingBytes > 0);
  const olderEnd = { ...olderEndBase, padding: "x".repeat(paddingBytes) };
  const newer = { type: "user", cwd, promptSource: "sdk", uuid: "newer", message: { role: "user", content: "newer" } };
  const newerEnd = { type: "assistant", cwd, uuid: "newer-agent", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "newer reply" }] } };
  const records = [prefix, older, olderEnd, newer, newerEnd];
  assert.equal(lineBytes(older) + lineBytes(olderEnd), CLAUDE_PAGE_WINDOW_BYTES);
  claude.seed(threadId, records);

  const history = new ClaudeTranscriptHistory(claude);
  const latest = await history.turnsPage(threadId, cwd, { limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
  assert.deepEqual(latest.data.map((turn) => turn.id), ["newer"]);
  assert.equal(typeof latest.nextCursor, "string");
  const prior = await history.turnsPage(threadId, cwd, {
    cursor: latest.nextCursor!, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
  });
  assert.deepEqual(prior.data.map((turn) => turn.id), ["older"]);
});

test("descending Claude paging finds a latest turn boundary beyond one transcript window", async () => {
  const claude = new FakeClaude();
  const threadId = "large-latest-turn";
  const cwd = "/w";
  claude.seed(threadId, [
    { type: "user", cwd, promptSource: "sdk", uuid: "older", message: { role: "user", content: "older" } },
    { type: "assistant", cwd, uuid: "older-agent", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "older reply" }] } },
    { type: "user", cwd, promptSource: "sdk", uuid: "latest", message: { role: "user", content: "latest" } },
    ...Array.from({ length: 4 }, (_, index) => ({ type: "progress", uuid: `progress-${index}`, padding: "x".repeat(80 * 1024) })),
    { type: "assistant", cwd, uuid: "latest-agent", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "latest reply" }] } },
  ]);

  const history = new ClaudeTranscriptHistory(claude);
  const latest = await history.turnsPage(threadId, cwd, {
    limit: 1,
    sortDirection: "desc",
    itemsView: "summary",
  });

  assert.deepEqual(latest.data.map((turn) => ({
    id: turn.id,
    items: turn.items.map((item) => item.type),
  })), [{ id: "latest", items: ["userMessage", "agentMessage"] }]);
  assert.equal(typeof latest.nextCursor, "string");
  const older = await history.turnsPage(threadId, cwd, {
    cursor: latest.nextCursor!,
    limit: 1,
    sortDirection: "desc",
    itemsView: "summary",
  });
  assert.deepEqual(older.data.map((turn) => turn.id), ["older"]);
  assert.equal(older.nextCursor, null);
  assert.equal(claude.transcriptReadCount, 3);
});

test("bounded exact-turn reconstruction keeps agent item IDs stable when the tail window shifts", async () => {
  const claude = new FakeClaude();
  const threadId = "stable-item-ids";
  const cwd = "/w";
  const turn = (id: string, paddingBytes: number) => [
    { type: "user", cwd, promptSource: "sdk", uuid: id, message: { role: "user", content: id } },
    { type: "assistant", cwd, uuid: `${id}-agent`, padding: "x".repeat(paddingBytes), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: `${id} reply` }] } },
  ];
  const before = Array.from({ length: 10 }, (_, index) => turn(`before-${index}`, 200 * 1024)).flat();
  const target = turn("target", 0);
  claude.seed(threadId, [...before, ...target]);
  const history = new ClaudeTranscriptHistory(claude);
  const first = await history.itemsPage(threadId, cwd, { turnId: "target", limit: 10, sortDirection: "asc" });
  const firstAgentIds = first.data.filter((item) => item.type === "agentMessage").map((item) => item.id);

  const after = Array.from({ length: 15 }, (_, index) => turn(`after-${index}`, 200 * 1024)).flat();
  claude.seed(threadId, [...before, ...target, ...after]);
  const shifted = await history.itemsPage(threadId, cwd, { turnId: "target", limit: 10, sortDirection: "asc" });
  assert.deepEqual(
    shifted.data.filter((item) => item.type === "agentMessage").map((item) => item.id),
    firstAgentIds,
  );
  assert.deepEqual(firstAgentIds, ["target-agent:0"]);
});

test("turn/interrupt ends the running response, marks the turn terminal, and leaves the session usable", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:c1", input: [{ type: "text", text: "go" }] });
  const res = await rt.request("turn/interrupt", { threadId: thread.id, turnId: "ctx:c1" });
  assert.deepEqual(res, {});
  await delay(5);
  assert.deepEqual(claude.interrupts, [thread.id]);
  const read = await rt.request<{ thread: any }>("thread/read", { threadId: thread.id, includeTurns: true });
  assert.equal(read.thread.turns[0].status, "interrupted");
  // Interrupting ends the response, never the session: the next turn reuses it.
  assert.equal(claude.isLoaded(thread.id), true);
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:c2", input: [{ type: "text", text: "again" }] });
  assert.equal(claude.opens.length, 1);
  assert.deepEqual(claude.sends.at(-1)?.uuid, "ctx:c2");
});

test("reading an unknown thread with no transcript reproduces the exact Codex no-rollout error", async () => {
  const rt = makeRuntime(new FakeClaude());
  await rt.start();
  await assert.rejects(
    rt.request("thread/read", { threadId: "nope", includeTurns: true }),
    (error: unknown) => error instanceof JsonRpcResponseError && error.code === -32600 && error.rpcMessage === "no rollout found for thread id nope",
  );
});

test("a cold-started session (on disk, not in memory) is rehydrated from the transcript, not reported gone", async () => {
  // runtime A runs a turn, materializing a transcript in the shared transcript store.
  const claude = new FakeClaude();
  const a = makeRuntime(claude);
  await a.start();
  const { thread } = await a.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await a.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:c1", input: [{ type: "text", text: "hi" }] });
  claude.answer(thread.id, "hello back");
  await delay(5);

  // runtime B (fresh in-memory state, e.g. after a QiYan restart) reads the same id.
  const b = makeRuntime(claude);
  await b.start();
  const read = await b.request<{ thread: any }>("thread/read", { threadId: thread.id, includeTurns: true });
  assert.equal(read.thread.turns.length, 1);
  assert.equal(read.thread.turns[0].id, "ctx:c1");
  assert.equal(read.thread.turns[0].status, "completed");
});

test("cold recovery reads cwd from bounded head metadata when the final transcript row exceeds a turn page", async () => {
  const claude = new FakeClaude();
  const threadId = "large-final-row";
  claude.seed(threadId, [
    { type: "user", cwd: "/expected", promptSource: "sdk", uuid: "ctx:cold", message: { role: "user", content: "hello" } },
    { type: "assistant", cwd: "/expected", uuid: "agent", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "x".repeat(300 * 1024) }] } },
    { type: "mode", mode: "default" },
  ]);
  const runtime = makeRuntime(claude);
  await runtime.start();

  const read = await runtime.request<{ thread: any }>("thread/read", { threadId, includeTurns: false });
  assert.equal(read.thread.cwd, "/expected");
  assert.equal(read.thread.status.type, "idle");
  assert.deepEqual(read.thread.turns, []);
  assert.equal(Math.max(...claude.transcriptChunkLengths), 256 * 1024);
});

test("a cold incomplete transcript is terminal on a daemonless endpoint, which lost its sessions", async () => {
  const claude = new FakeClaude();
  const a = makeRuntime(claude);
  await a.start();
  const { thread } = await a.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await a.request("turn/start", {
    threadId: thread.id,
    clientUserMessageId: "ctx:orphaned",
    input: [{ type: "text", text: "work" }],
  });

  // A local host lives in the QiYan process, so a restart really did end that turn.
  const b = makeRuntime(claude);
  assert.equal(b.daemonless, true);
  await b.start();
  const read = await b.request<{ thread: any }>("thread/read", { threadId: thread.id, includeTurns: true });
  assert.equal(read.thread.status.type, "idle");
  assert.equal(read.thread.turns[0].status, "interrupted");
});

// Goals are Claude's own `/goal`: the manager's goal tools install and clear the NATIVE
// goal, and QiYan stores no goal row of its own.
test("the manager's goal tools install and clear Claude's native goal", async () => {
  const claude = new FakeClaude();
  const rt = new ClaudeCodeRuntime({ id: "claude-local", host: claude, runner: claude, launchFlags: {} });
  await rt.start();
  const delivered = (): string[] => claude.sends.map((send) => send.text);
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  const t = thread.id;

  // Reading stays graceful so a provider-neutral get_session_status still works: native
  // goal state is not exposed to the SDK stream, so there is nothing to report.
  assert.deepEqual(await rt.request("thread/goal/get", { threadId: t }), { goal: null, known: true });

  const set = await rt.request<{ goal: any }>("thread/goal/set", { threadId: t, objective: "finish phase 2" });
  assert.equal(set.goal.objective, "finish phase 2");
  assert.equal(delivered().at(-1), "/goal finish phase 2");

  assert.deepEqual(await rt.request("thread/goal/clear", { threadId: t }), { goal: null });
  assert.equal(delivered().at(-1), "/goal clear");
});

// Claude compacts through its own /compact command; QiYan drives no compaction of its own.
test("compact_session drives Claude's native /compact", async () => {
  const claude = new FakeClaude();
  const rt = new ClaudeCodeRuntime({ id: "claude-local", host: claude, runner: claude, launchFlags: {} });
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("thread/compact/start", { threadId: thread.id });
  assert.deepEqual(claude.sends.map((send) => send.text), ["/compact"]);
});

// Native /goal has no pause/resume, and QiYan stores no objective to reinstate.
test("a status-only goal change is refused rather than silently dropped", async () => {
  const claude = new FakeClaude();
  const rt = new ClaudeCodeRuntime({
    id: "claude-local", host: claude, runner: claude, launchFlags: {},
  });
  await rt.start();
  await assert.rejects(rt.request("thread/goal/set", { threadId: "t", status: "paused" }), /pause\/resume/u);
});

// Steer rides the SDK's own queue — the same one the Claude Code CLI uses when you type
// while it is working. QiYan no longer holds the message in a durable schedule row and
// redelivers it later; that existed only because a one-shot `claude -p` had nowhere to put it.
test("turn/steer hands the message to the native queue without aborting the running turn", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:c1", input: [{ type: "text", text: "long task" }] });

  const res = await rt.request<{ turnId: string }>("turn/steer", {
    threadId: thread.id, clientUserMessageId: "ctx:steer1",
    input: [{ type: "text", text: "also do X" }], expectedTurnId: "ctx:c1",
  });

  assert.equal(res.turnId, "ctx:steer1");
  assert.deepEqual(claude.sends.map((send) => send.text), ["long task", "also do X"],
    "the steer reached the session itself, in order behind the running turn");
  assert.deepEqual(claude.interrupts, [], "steering never aborts the running response");
  assert.deepEqual(claude.inFlight(thread.id), ["ctx:c1", "ctx:steer1"],
    "both turns are outstanding — the SDK runs the queued one next");
});

// A one-shot `claude -p` could only run one turn, so a concurrent send was refused with
// SESSION_BUSY. The SDK accepts input mid-turn, so refusing would now discard usable work.
test("a second turn/start is queued rather than refused", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:a", input: [{ type: "text", text: "first" }] });
  const second = await rt.request<{ turn: any }>("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:b", input: [{ type: "text", text: "second" }] });

  assert.equal(second.turn.id, "ctx:b");
  assert.deepEqual(claude.inFlight(thread.id), ["ctx:a", "ctx:b"], "queued in submission order");
});

test("model/list returns the curated catalog in Codex {data,nextCursor} shape with efforts", async () => {
  const rt = makeRuntime(new FakeClaude());
  await rt.start();
  const result = await rt.request<{ data: any[]; nextCursor: null }>("model/list", {});
  assert.equal(result.nextCursor, null);
  assert.ok(result.data.length > 0, "catalog is non-empty (unblocks set_session_model)");
  assert.ok(result.data.some((m) => m.id === "claude-opus-4-8" && m.isDefault), "configured model present + default");
  assert.ok(result.data.every((m) => m.supportedReasoningEfforts.some((e: any) => e.reasoningEffort === "high" && m.supportedReasoningEfforts.some((x: any) => x.reasoningEffort === "xhigh"))));
});

test("turn/start applies per-session model + effort over the endpoint defaults", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude, { model: "claude-opus-4-8", effort: "medium" });
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "c1", input: "hi", model: "haiku", effort: "high" });

  // The launch carries them, and so does the live session — a second turn changes both
  // without relaunching, which is the whole point of a long-lived query.
  assert.deepEqual(claude.opens, [{ sessionId: thread.id, mode: "create", cwd: "/w", model: "haiku", effort: "high" }]);
  assert.deepEqual(claude.setModels, [{ sessionId: thread.id, model: "haiku" }]);
  assert.deepEqual(claude.setEfforts, [{ sessionId: thread.id, effort: "high" }]);
  claude.complete(thread.id);
  await delay(5);

  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "c2", input: "hi", model: "sonnet", effort: "low" });
  assert.equal(claude.opens.length, 1);
  assert.deepEqual(claude.setModels.at(-1), { sessionId: thread.id, model: "sonnet" });
  assert.deepEqual(claude.setEfforts.at(-1), { sessionId: thread.id, effort: "low" });
});

test("an endpoint with no per-turn override launches its session with the endpoint defaults", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude, { model: "claude-opus-4-8", effort: "xhigh" });
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "c1", input: "hi" });
  assert.deepEqual(claude.opens, [{ sessionId: thread.id, mode: "create", cwd: "/w", model: "claude-opus-4-8", effort: "xhigh" }]);
  assert.deepEqual(claude.setModels, []);
  assert.deepEqual(claude.setEfforts, []);
});

test("thread/read reports active while a turn runs, idle after", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "c1", input: "hi" });
  const running = await rt.request<{ thread: any }>("thread/read", { threadId: thread.id });
  assert.equal(running.thread.status.type, "active");
  claude.complete(thread.id);
  await new Promise((resolve) => setImmediate(resolve)); // let the completion handler clear state.running
  const idle = await rt.request<{ thread: any }>("thread/read", { threadId: thread.id });
  assert.equal(idle.thread.status.type, "idle");
});

test("thread/list splits archived tombstones and hides them from the default page", async () => {
  const claude = new FakeClaude();
  // Two discoverable threads via the runner's listThreads.
  claude.seed("t-keep", [{ cwd: "/w" }]);
  claude.seed("t-gone", [{ cwd: "/w" }]);
  const archives = new ClaudeArchiveStore(createTestDatabase());
  const rt = new ClaudeCodeRuntime({ id: "claude-local", host: claude, runner: claude, launchFlags: {}, archives });
  await rt.start();
  archives.add("claude-local", "t-gone");
  const live = await rt.request<{ data: any[] }>("thread/list", { cwd: "/w", archived: false });
  assert.deepEqual(live.data.map((t) => t.id).sort(), ["t-keep"], "archived thread hidden from default listing");
  const archived = await rt.request<{ data: any[] }>("thread/list", { cwd: "/w", archived: true });
  assert.deepEqual(archived.data.map((t) => t.id), ["t-gone"]);
  // A re-adopt (thread/resume) revives it.
  await rt.request("thread/resume", { threadId: "t-gone" }).catch(() => undefined);
  assert.equal(archives.has("claude-local", "t-gone"), false, "resume cleared the tombstone");
});

test("turn input renders file attachments as readable paths for Claude", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  // The worker file bridge stages each attachment as a localImage/mention item whose path is
  // valid on the worker's host; the Claude adapter must forward that path (not drop it) so
  // Claude can read the file.
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:att", input: [
    { type: "text", text: "look at these" },
    { type: "localImage", path: "/runtime/files/abc.png" },
    { type: "mention", name: "report.pdf", path: "/runtime/files/def" },
  ] });
  const message = claude.sends[0]!.text;
  assert.match(message, /look at these/u);
  assert.match(message, /\/runtime\/files\/abc\.png/u, "image attachment path forwarded");
  assert.match(message, /report\.pdf/u, "mention display name forwarded");
  assert.match(message, /\/runtime\/files\/def/u, "mention attachment path forwarded");
});

// Intermediate assistant text streams into the panel live, so history must keep it too —
// a summary that returned only the final answer made those messages vanish on reload.
// Claude turns carry no tool payloads (reconstruction drops thinking and tool_use), which
// is the only thing the summary projection exists to withhold.
test("the summary view keeps every assistant message, not just the last", async () => {
  const claude = new FakeClaude();
  claude.seed("thread-sum", [
    { type: "user", cwd: "/w", promptSource: "sdk", uuid: "u1", message: { role: "user", content: "go" } },
    { type: "assistant", uuid: "a1", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "checking the files" }] } },
    { type: "assistant", uuid: "a2", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "now running tests" }] } },
    { type: "assistant", uuid: "a3", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "all green" }] } },
  ]);
  const rt = makeRuntime(claude);
  await rt.start();
  await rt.request("thread/resume", { threadId: "thread-sum", cwd: "/w", excludeTurns: true });

  const page = await rt.request<{ data: Array<{ items: Array<{ type: string; text?: string }> }> }>(
    "thread/turns/list", { threadId: "thread-sum", limit: 10, sortDirection: "asc", itemsView: "summary" });
  const texts = page.data[0]!.items.filter((item) => item.type === "agentMessage").map((item) => item.text);
  assert.deepEqual(texts, ["checking the files", "now running tests", "all green"],
    "the two intermediate blocks survive the summary projection");
});

// A native goal IS observable: /goal records it in the session's own transcript, which
// QiYan already reads for history. Reporting "no goal" was a gap, not a constraint — only
// a running goal's progress (iterations, tokens) is genuinely unavailable.
test("get_goal reads the objective Claude's native /goal recorded", async () => {
  const claude = new FakeClaude();
  claude.seed("thread-goal", [
    { type: "user", cwd: "/w", promptSource: "sdk", uuid: "u1", message: { role: "user", content: "go" } },
    { type: "user", cwd: "/w", promptSource: "sdk", uuid: "u2",
      message: { role: "user", content: "<local-command-stdout>Goal set: all tests pass</local-command-stdout>" } },
  ]);
  const rt = makeRuntime(claude);
  await rt.start();
  await rt.request("thread/resume", { threadId: "thread-goal", cwd: "/w", excludeTurns: true });

  const read = await rt.request<{ goal: any }>("thread/goal/get", { threadId: "thread-goal" });
  assert.equal(read.goal?.objective, "all tests pass");
  assert.equal(read.goal?.status, "active");
});

// A goal read walks the transcript backwards in windows. It used to stop as soon as a window's
// raw text contained "Goal set:" ANYWHERE -- so an assistant that merely discussed the words, or
// a tool result quoting them, hid the real marker behind it and the session reported no goal.
// The panel then wrote that down as authoritative and the goal disappeared.
test("prose quoting the goal marker does not hide the real goal behind it", async () => {
  const claude = new FakeClaude();
  claude.seed("thread-prose", [
    { type: "user", cwd: "/w", promptSource: "sdk", uuid: "u1",
      message: { role: "user", content: "<local-command-stdout>Goal set: ship the fix</local-command-stdout>" } },
    // Push the real marker out of the tail window, so the walk has to step back past the prose.
    { type: "assistant", cwd: "/w", uuid: "pad",
      message: { role: "assistant", content: [{ type: "text", text: "x".repeat(300_000) }] } },
    { type: "assistant", cwd: "/w", uuid: "a1",
      message: { role: "assistant", content: [{ type: "text", text: "I ran `/goal` and it printed Goal set: ship the fix" }] } },
    { type: "user", cwd: "/w", promptSource: "sdk", uuid: "u2", message: { role: "user", content: "carry on" } },
  ]);
  const rt = makeRuntime(claude);
  await rt.start();
  await rt.request("thread/resume", { threadId: "thread-prose", cwd: "/w", excludeTurns: true });

  const read = await rt.request<{ goal: any; known: boolean }>("thread/goal/get", { threadId: "thread-prose" });
  assert.equal(read.goal?.objective, "ship the fix");
  assert.equal(read.known, true);
});

// `state.running` is assembled from events, so a completion that never arrives leaves a turn in
// it forever: the session reads `active` on a turn that finished hours ago, shows "working"
// while doing nothing, and queues every later send behind a ghost. The host knows what it is
// actually running, so a status read asks it rather than trusting the belief.
// Reconciling on a read is not enough: the panel's status comes from the in-memory session
// view that notifications update, so a session NOBODY reads never reaches that path. A worker
// with no goal driving it sat "working" on a turn that had ended 22 minutes earlier, while a
// worker being polled corrected itself — the fix was right and simply never ran.
test("a stale turn is settled without anyone reading the thread", async (t) => {
  const claude = new FakeClaude();
  const rt = new ClaudeCodeRuntime({ id: "claude-local", host: claude, runner: claude, launchFlags: {}, staleTurnSweepMs: 10 });
  await rt.start();
  t.after(() => rt.closeConnection());
  const { thread } = await rt.request<{ thread: { id: string } }>("thread/start", { cwd: "/w" });
  const terminals: string[] = [];
  rt.onNotification((method, params) => {
    if (method === "turn/completed") terminals.push(String((params as any).turn?.id ?? ""));
  });
  await rt.request("turn/start", {
    threadId: thread.id,
    clientUserMessageId: "to:web:unwatched",
    input: [{ type: "text", text: "think" }],
  });
  claude.loseCompletion(thread.id, "to:web:unwatched");

  // No thread/read, no thread/resume — nothing reads this session at all. The sweep runs anyway.
  for (let waited = 0; waited < 100 && !terminals.includes("to:web:unwatched"); waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.ok(terminals.includes("to:web:unwatched"),
    "the sweep settles it and republishes its terminal, so the view stops reading active");
});

test("a turn the host no longer holds is settled instead of running forever", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: { id: string } }>("thread/start", { cwd: "/w" });
  const terminals: string[] = [];
  rt.onNotification((method, params) => {
    if (method === "turn/completed") terminals.push(String((params as any).turn?.id ?? ""));
  });
  await rt.request("turn/start", {
    threadId: thread.id,
    clientUserMessageId: "to:web:ghost",
    input: [{ type: "text", text: "think about it" }],
  });

  const running = await rt.request<{ thread: any }>("thread/read", { threadId: thread.id });
  assert.equal(running.thread.status.type, "active", "a turn the host IS running still reads active");
  assert.equal(running.thread.activeTurnId, "to:web:ghost");

  claude.loseCompletion(thread.id, "to:web:ghost");

  const settled = await rt.request<{ thread: any }>("thread/read", { threadId: thread.id });
  assert.equal(settled.thread.status.type, "idle", "the host no longer holds it, so it is not running");
  assert.equal(settled.thread.activeTurnId, undefined);
  assert.ok(terminals.includes("to:web:ghost"),
    "and its terminal is republished, so the answer it produced is still delivered");
});

test("a cleared native goal reports none, and the last marker wins", async () => {
  const claude = new FakeClaude();
  claude.seed("thread-cleared", [
    { type: "user", cwd: "/w", promptSource: "sdk", uuid: "u1", message: { role: "user", content: "go" } },
    { type: "user", cwd: "/w", promptSource: "sdk", uuid: "u2",
      message: { role: "user", content: "<local-command-stdout>Goal set: first</local-command-stdout>" } },
    { type: "user", cwd: "/w", promptSource: "sdk", uuid: "u3",
      message: { role: "user", content: "<local-command-stdout>Goal cleared</local-command-stdout>" } },
  ]);
  const rt = makeRuntime(claude);
  await rt.start();
  await rt.request("thread/resume", { threadId: "thread-cleared", cwd: "/w", excludeTurns: true });
  assert.deepEqual(await rt.request("thread/goal/get", { threadId: "thread-cleared" }), { goal: null, known: true });
});

// A session whose background task outlives its parent turn will speak again unprompted.
// Reporting it as plain idle invited concluding the work had finished.
test("a session with background work reports active, with what is running", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:a", input: [{ type: "text", text: "go" }] });
  claude.emit({ type: "task/set", sessionId: thread.id, background: 2, subagents: 1, descriptions: ["npm test"], at: 1 });
  // The turn ends and the work does not: this is the state where the activity IS the reason
  // the session is busy, and so the only state where the thread view reports it.
  claude.settleTurn(thread.id, "ctx:a", "completed");

  const read = await rt.request<{ thread: any }>("thread/read", { threadId: thread.id });
  assert.deepEqual(read.thread.status, { type: "active" });
  assert.deepEqual(read.thread.nativeActivity, { backgroundTasks: 2, subagents: 1 });

  claude.emit({ type: "task/set", sessionId: thread.id, background: 0, subagents: 0, descriptions: [], at: 2 });
  const settled = await rt.request<{ thread: any }>("thread/read", { threadId: thread.id });
  assert.equal(settled.thread.nativeActivity, undefined, "none is reported as absent, never as a zero");
});

// Session status is read from NativeSessionState, which tracks thread/status/changed.
// Reporting background work only on thread/read left get_session_status and the archive
// idle-proof still calling the session idle — so a worker with a live subagent read as
// finished, and archiving would have closed the session out from under it.
test("background work is announced as a status change the tool layer observes", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  const seen: Array<{ method: string; params: any }> = [];
  rt.onNotification((method, params) => { if (method === "thread/status/changed") seen.push({ method, params }); });

  claude.emit({ type: "task/set", sessionId: thread.id, background: 1, subagents: 1, descriptions: [], at: 1 });
  assert.deepEqual(seen.at(-1)?.params.status, { type: "active" },
    "a session whose background work outlives its turn is not idle");

  claude.emit({ type: "task/set", sessionId: thread.id, background: 0, subagents: 0, descriptions: [], at: 2 });
  assert.deepEqual(seen.at(-1)?.params.status, { type: "idle" }, "and returns to idle when it settles");
});

// The ordinary ordering: Claude spawns the subagent DURING a turn, so the task/set arrives
// while a turn still owns the session and is not published as a status. If the turn's own
// completion is then the last word, the session reads idle with its subagent still running —
// and every idle proof (archive, unadopt, restart) waves it through.
test("a turn that ends leaving a subagent behind does not report the session idle", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  const seen: any[] = [];
  rt.onNotification((method, params) => { if (method === "thread/status/changed") seen.push(params); });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:a", input: [{ type: "text", text: "go" }] });

  claude.emit({ type: "task/set", sessionId: thread.id, background: 0, subagents: 1, descriptions: [], at: 1 });
  assert.equal(seen.length, 0, "nothing is published while the turn still owns the session");

  claude.settleTurn(thread.id, "ctx:a", "completed");

  assert.deepEqual(seen.at(-1)?.status, { type: "active" }, "the surviving subagent keeps it active");
  assert.deepEqual(seen.at(-1)?.nativeActivity, { backgroundTasks: 0, subagents: 1 },
    "and says what is running, so the consumer knows this is not a turn it failed to identify");
  const read = await rt.request<{ thread: any }>("thread/read", { threadId: thread.id });
  assert.equal(read.thread.status.type, "active");
});

// The SDK's interrupt aborts whatever is EXECUTING. Announcing a queued send as started
// made it the tracked active turn, so an interrupt named the queued uuid, killed the
// running turn instead, and marked the survivor terminal — the corruption this migration
// exists to remove, reintroduced by queueing.
test("only the executing turn is announced started, and the queue advances", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  const started: string[] = [];
  rt.onNotification((method, params) => {
    if (method === "turn/started") started.push((params as any).turn.id);
  });

  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:a", input: [{ type: "text", text: "first" }] });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:b", input: [{ type: "text", text: "second" }] });
  assert.deepEqual(started, ["ctx:a"], "the queued turn is not announced as running");

  claude.settleTurn(thread.id, "ctx:a", "completed");
  assert.deepEqual(started, ["ctx:a", "ctx:b"], "it is announced when it reaches the head");
});

test("interrupting a queued turn is refused rather than killing the running one", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:a", input: [{ type: "text", text: "first" }] });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:b", input: [{ type: "text", text: "second" }] });

  await assert.rejects(
    rt.request("turn/interrupt", { threadId: thread.id, turnId: "ctx:b" }),
    (error: any) => {
      assert.equal(error.code, "OPERATION_CONFLICT");
      assert.match(error.message, /queued behind ctx:a/u);
      return true;
    });
  assert.deepEqual(claude.interrupts, [], "the running turn was not aborted in its place");

  await rt.request("turn/interrupt", { threadId: thread.id, turnId: "ctx:a" });
  assert.deepEqual(claude.interrupts, [thread.id], "interrupting the running turn works");
});

// A steer names the turn it means. If that turn has finished and another is running,
// appending redirects the message onto work the user never saw.
test("a steer whose target turn already finished is refused", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:a", input: [{ type: "text", text: "first" }] });

  await assert.rejects(
    rt.request("turn/steer", {
      threadId: thread.id, clientUserMessageId: "ctx:s",
      input: [{ type: "text", text: "more" }], expectedTurnId: "ctx:gone",
    }),
    (error: any) => {
      assert.equal(error.code, "OPERATION_CONFLICT");
      assert.match(error.message, /no longer running/u);
      return true;
    });
});

// Adoption reads thread.status.type on a discovery row before resuming the thread, so a
// row without it threw a TypeError and adopt_session failed outright — as did the adopt
// leg of crash recovery. A discovery row has no live state, and thread/resume re-reads the
// truth, so idle-with-no-turns is the honest placeholder.
test("discovery rows carry the shape adoption reads", async () => {
  const claude = new FakeClaude();
  claude.seed("discoverable", [
    { type: "user", cwd: "/w", promptSource: "sdk", uuid: "u1", message: { role: "user", content: "hello there" } },
  ]);
  const rt = makeRuntime(claude);
  await rt.start();

  const page = await rt.request<{ data: Array<Record<string, unknown>> }>("thread/list", {});
  const row = page.data.find((entry) => entry.id === "discoverable");
  assert.ok(row, "the seeded session is discoverable");
  assert.deepEqual(row!.status, { type: "idle" });
  assert.deepEqual(row!.turns, []);
  // The identity fields adoption then uses are still carried alongside.
  assert.equal(typeof row!.cwd, "string");
  assert.equal(typeof row!.preview, "string");
});

// A full-transcript scan throws past its ~4 MiB budget, and swallowing that reported
// "no goal" for exactly the long-running sessions most likely to have one. The goal is
// read from a bounded tail instead, which is where the last marker always is.
test("the native goal is found on a transcript too large to scan whole", async () => {
  const claude = new FakeClaude();
  const filler = { type: "assistant", uuid: "pad", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(4_000) }] } };
  claude.seed("huge", [
    { type: "user", cwd: "/w", promptSource: "sdk", uuid: "u1", message: { role: "user", content: "go" } },
    ...Array.from({ length: 1_200 }, () => filler),           // well past the full-scan budget
    { type: "user", cwd: "/w", promptSource: "sdk", uuid: "u2",
      message: { role: "user", content: "<local-command-stdout>Goal set: ship it</local-command-stdout>" } },
  ]);
  const rt = makeRuntime(claude);
  await rt.start();
  await rt.request("thread/resume", { threadId: "huge", cwd: "/w", excludeTurns: true });

  const read = await rt.request<{ goal: any }>("thread/goal/get", { threadId: "huge" });
  assert.equal(read.goal?.objective, "ship it", "a goal on a large transcript is reported, not silently dropped");
});

// compact_session waits for a contextCompaction item and times out without one, which left
// the manager's turn blocked on a reconciliation that never terminated. Claude reports its
// own boundary; that IS the item the tool correlates against.
test("a native compaction publishes the item compact_session waits for", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:a", input: [{ type: "text", text: "/compact" }] });
  const items: any[] = [];
  rt.onNotification((method, params) => { if (method === "item/completed") items.push((params as any).item); });

  claude.emit({ type: "session/compacted", sessionId: thread.id, trigger: "manual", at: 7 });

  const compaction = items.find((item) => item.type === "contextCompaction");
  assert.ok(compaction, "the boundary reaches the tool as a contextCompaction item");
  assert.match(String(compaction.id), /ctx:a:compaction/u, "keyed to the turn that ran /compact");
});

// After a QiYan restart the runtime knows no threads, while a remote host has outlived the
// restart and is still running the work. task/set events report only CHANGES, so work that
// merely continued across the restart is announced by nothing — the session would read idle to
// every archive and restart check, and archiving it closes the query the subagent runs in.
test("background work that outlived a restart is adopted, not re-learned as idle", async () => {
  const claude = new FakeClaude();
  claude.seed("remote-busy", [{
    type: "user", uuid: "ctx:old", sessionId: "remote-busy", cwd: "/remote/work", timestamp: "2026-01-01T00:00:00Z",
    message: { role: "user", content: "work" },
  }]);
  const rt = new ClaudeCodeRuntime({
    id: "claude-remote",
    host: claude,
    runner: claude,
    launchFlags: {},
    persistentRuntime: persistentRuntime({
      async recoverTurn(threadId: string) {
        if (threadId !== "remote-busy") return undefined;
        await claude.open({ sessionId: threadId, mode: "resume", cwd: "/remote/work" });
        // No turn is in flight — only a subagent the previous turn left behind.
        return { activity: { backgroundTasks: 0, subagents: 1 } };
      },
    }),
  });
  await rt.start();

  const resumed = await rt.request<{ thread: { status: unknown; nativeActivity?: unknown } }>("thread/resume", {
    threadId: "remote-busy",
    cwd: "/remote/work",
    excludeTurns: true,
  });

  assert.deepEqual(resumed.thread.status, { type: "active" }, "the reattached session is busy, not idle");
  // Carried on the thread view, because a reconnect settles state through the view rather than
  // through notifications — and a consumer that cannot see WHY it is active treats an active
  // session naming no turn as one whose identity it failed to establish.
  assert.deepEqual(resumed.thread.nativeActivity, { backgroundTasks: 0, subagents: 1 });
});

// A reconnect settles state from this view, and it is requested with the turns stripped. So
// activity reported BESIDE a running turn is indistinguishable from activity reported INSTEAD
// of one — and a consumer that reads it as "busy with no turn" stops looking for the turn's
// identity, leaving a runaway turn that interrupt can no longer name.
test("a thread view does not report background activity while a turn owns the session", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:a", input: [{ type: "text", text: "go" }] });
  claude.emit({ type: "task/set", sessionId: thread.id, background: 0, subagents: 1, descriptions: [], at: 1 });

  const during = await rt.request<{ thread: any }>("thread/read", { threadId: thread.id });
  assert.equal(during.thread.status.type, "active", "the running turn makes it active either way");
  assert.equal(during.thread.nativeActivity, undefined,
    "and the turn, not the subagent, is what the reconnect must go looking for");

  // Once the turn settles, the subagent is the only thing left holding the session — and now
  // saying so is exactly what a reconnect needs.
  claude.settleTurn(thread.id, "ctx:a", "completed");
  const after = await rt.request<{ thread: any }>("thread/read", { threadId: thread.id });
  assert.equal(after.thread.status.type, "active");
  assert.deepEqual(after.thread.nativeActivity, { backgroundTasks: 0, subagents: 1 });
});

// Finding out what is running is real I/O — a transcript read and a reattach RPC over ssh —
// and a hung remote host is the likeliest way it fails. Reading that failure as "nothing is
// running" would retract a true active and hand the next archive the go-ahead to close a
// session whose work is still going: the same hole, re-entered through the error path.
test("a stop that cannot find out what is running does not retract a live session", async () => {
  const claude = new FakeClaude();
  claude.seed("cold-busy", [{
    type: "user", uuid: "ctx:old", sessionId: "cold-busy", cwd: "/remote/work", timestamp: "2026-01-01T00:00:00Z",
    message: { role: "user", content: "work" },
  }]);
  let failReattach!: (error: Error) => void;
  const reattach = new Promise<never>((_resolve, reject) => { failReattach = reject; });
  const rt = new ClaudeCodeRuntime({
    id: "claude-remote",
    host: claude,
    runner: claude,
    launchFlags: {},
    persistentRuntime: persistentRuntime({ async recoverTurn() { return await reattach; } }),
  });
  await rt.start();
  const statuses: any[] = [];
  rt.onNotification((method, params) => { if (method === "thread/status/changed") statuses.push(params); });

  // A stop arrives for a thread this endpoint has not loaded yet, so it must go and find out.
  const stopping = rt.request("thread/tasks/stop", { threadId: "cold-busy" });
  await delay(10);
  // While it is still finding out, the host reports live work on that session.
  claude.emit({ type: "task/set", sessionId: "cold-busy", background: 1, subagents: 0, descriptions: [], at: 1 });
  failReattach(new Error("ssh channel is gone"));

  await assert.rejects(stopping, "the stop reports that it could not find out, rather than a clean zero");
  assert.equal(statuses.some((params) => params.status?.type === "idle"), false,
    "and nothing published idle over work that was never shown to have stopped");
});

// "The host does not hold this session" is a whole answer, and the load belief is half of it.
// Nothing else retracts that belief — session/closed cannot arrive for a session the host does
// not have — so a thread left marked loaded sends every later turn into nothing.
test("learning the host lost a session also drops the belief that it is loaded", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:a", input: [{ type: "text", text: "go" }] });
  claude.settleTurn(thread.id, "ctx:a", "completed");
  claude.emit({ type: "task/set", sessionId: thread.id, background: 1, subagents: 0, descriptions: [], at: 1 });
  // The host was replaced while QiYan was not looking, and reported no loss.
  claude.dropSessions();

  const result = await rt.request<{ stopped: number; remaining: number }>("thread/tasks/stop", { threadId: thread.id });
  assert.deepEqual({ ...result }, { stopped: 0, remaining: 0 });

  // The next turn re-opens the session instead of sending into one the host does not have.
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:b", input: [{ type: "text", text: "again" }] });
  assert.equal(claude.sends.at(-1)?.text, "again", "the turn reached a session the host actually holds");
});

// Measured in production: `claude` reports a turn finished over its stream BEFORE appending
// that turn's last row to the transcript. A terminal that sends the relay to the transcript
// therefore races the write, and losing is silent and total — with the final row missing, the
// turn has no terminal record, so reconstruction reads it `interrupted` and phases every
// message `commentary`. The relay finds no final answer, delivers nothing, and warns that the
// turn was interrupted without a final response while the answer sits complete on screen.
test("a terminal carries the answer even when the transcript has not caught up", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  const terminals: any[] = [];
  rt.onNotification((method, params) => { if (method === "turn/completed") terminals.push(params); });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:a", input: [{ type: "text", text: "go" }] });

  // The answer streams, and the turn settles, with the transcript still a row behind.
  claude.reply(thread.id, "the complete answer");
  claude.withholdTranscriptTail(thread.id);
  claude.complete(thread.id);
  await delay(5);

  const turn = terminals.at(-1)?.turn;
  assert.equal(turn.status, "completed", "not interrupted: the endpoint saw the turn finish");
  assert.equal(turn.itemsView, "full");
  const finals = (turn.items ?? []).filter((i: any) => i.type === "agentMessage" && i.phase === "final_answer");
  assert.deepEqual(finals.map((i: any) => i.text), ["the complete answer"],
    "and the answer travels with it rather than being read back off disk");
});

// A turn too large to hold is not truncated into a partial answer — the terminal falls back to
// the id alone, and the relay hydrates from the transcript as it always did.
test("an oversized turn falls back to the transcript instead of delivering part of it", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  const terminals: any[] = [];
  rt.onNotification((method, params) => { if (method === "turn/completed") terminals.push(params); });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:a", input: [{ type: "text", text: "go" }] });

  claude.reply(thread.id, "x".repeat(600 * 1024));
  claude.complete(thread.id);
  await delay(5);

  assert.deepEqual(terminals.at(-1)?.turn, { id: "ctx:a" }, "no items, so the relay reads the turn itself");
});

// A turn executes before `claude` flushes its user row, and a reconnect asks for this view
// with its turns stripped — so neither the view's turns nor the transcript can name the turn
// that is running. Left unnamed, the consumer records the identity as unresolved and probes
// history for it; the probe finds only the previous, COMPLETED turn and stores the session
// state as unknown, after which every operation on that worker fails as if its endpoint were
// gone. That is what the manager reports as the session being down while its process is fine.
test("the thread view names the running turn the transcript has not flushed", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:a", input: [{ type: "text", text: "one" }] });
  claude.answer(thread.id, "first answer");
  await delay(5);

  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:b", input: [{ type: "text", text: "two" }] });
  claude.withholdTranscriptTail(thread.id);

  const resumed = await rt.request<{ thread: any }>("thread/resume", { threadId: thread.id, excludeTurns: true });
  assert.deepEqual(resumed.thread.status, { type: "active" });
  assert.equal(resumed.thread.activeTurnId, "ctx:b", "the running turn is named, so nothing has to go looking for it");

  // And the paged history stays exactly as it was: hydrating the PREVIOUS turn, whose answer
  // the relay still has to deliver, must keep working while a turn is running.
  const reader = new ThreadHistoryReader((method, params) => rt.request(method, params));
  const exact = await reader.exactTurnItems(thread.id, "ctx:a", { budget: createHistoryScanBudget() });
  assert.deepEqual(
    exact.items.filter((item: any) => item.type === "agentMessage").map((item: any) => item.text),
    ["first answer"],
    "the completed turn is still hydratable",
  );
  const suffix = await reader.descendingSuffix(thread.id, undefined, createHistoryScanBudget());
  assert.deepEqual(suffix.turns.map((turn: any) => turn.id), ["ctx:a"], "and the scan is undisturbed");
});

// The static catalog asserts the same effort levels for every model, so set_session_model would
// accept an effort a model does not offer. Claude reports the real per-model set — but only as
// an OVERLAY. The catalog is what guarantees a `default` row, and `set_reasoning_effort` looks
// the session's CURRENT model up in this list: a Claude endpoint with no pinned model reports
// that as the literal "default", so replacing the catalog would break setting effort on the
// default configuration of every Claude endpoint.
test("model/list overlays Claude's real efforts without dropping what the catalog guarantees", async () => {
  const claude = new FakeClaude();
  claude.reportModels([
    { value: "claude-opus-4-8", displayName: "Opus 4.8", supportedEffortLevels: ["low", "high"] },
  ]);
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:a", input: [{ type: "text", text: "go" }] });

  const listed = await rt.request<{ data: any[] }>("model/list", {});
  const byId = new Map(listed.data.map((model: any) => [model.id, model]));

  assert.ok(byId.has("default"), "the documented way to clear a model override stays settable");
  assert.deepEqual(
    byId.get("claude-opus-4-8").supportedReasoningEfforts.map((e: any) => e.reasoningEffort),
    ["low", "high"],
    "and the model Claude described carries the efforts it actually offers",
  );
  assert.equal(listed.data.filter((model: any) => model.isDefault).length, 1, "exactly one default");

  // Endpoint-scoped, so it must not vary with whichever session happens to be open.
  claude.reportModels([]);
  const again = await rt.request<{ data: any[] }>("model/list", {});
  assert.deepEqual(again.data.map((m: any) => m.id), listed.data.map((m: any) => m.id));
});

// The reported order is the provider's, not ours. Taking the first element assumes ascending,
// and a descending list would silently default a model to its MOST expensive level — the exact
// outcome choosing a cheapest default exists to prevent.
test("a model that offers no configured default takes its cheapest level, whatever the order", async () => {
  const claude = new FakeClaude();
  claude.reportModels([
    { value: "claude-sonnet-5", displayName: "Sonnet 5", supportedEffortLevels: ["max", "xhigh", "low"] },
  ]);
  const rt = makeRuntime(claude, {});
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:a", input: [{ type: "text", text: "go" }] });

  const listed = await rt.request<{ data: any[] }>("model/list", {});
  const sonnet = listed.data.find((model: any) => model.id === "claude-sonnet-5");

  assert.deepEqual(sonnet.supportedReasoningEfforts.map((e: any) => e.reasoningEffort), ["max", "xhigh", "low"]);
  assert.equal(sonnet.defaultReasoningEffort, "low", "the cheapest it offers, not the first it listed");
});

// Returning {} reported a rename that never happened. A caller cannot tell that from success.
test("renaming a Claude session is refused rather than silently dropped", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });

  await assert.rejects(
    rt.request("thread/name/set", { threadId: thread.id, name: "new name" }),
    (error: unknown) => (error as any).code === "UNSUPPORTED_CAPABILITY",
  );
});

// The terminal carries what the endpoint streamed — but the stream delivers an assistant message
// before its stop reason is settled, so every live item can look like commentary while the turn
// has plainly ended. Delivery selects on `final_answer`, so a terminal carrying only commentary
// delivers NOTHING, and reports `completed`, so no warning fires either: the worker answers and
// the answer is silently dropped. Three turns in a row were lost this way in production.
test("a completed turn's answer is delivered even when the stream never settled its stop reason", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  const terminals: any[] = [];
  rt.onNotification((method, params) => { if (method === "turn/completed") terminals.push(params); });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:a", input: [{ type: "text", text: "go" }] });

  claude.replyWithSettledStopReasonOnlyOnDisk(thread.id, "thinking out loud");
  claude.replyWithSettledStopReasonOnlyOnDisk(thread.id, "the actual answer");
  claude.complete(thread.id);
  await delay(5);

  const turn = terminals.at(-1)?.turn;
  const agents = (turn.items ?? []).filter((i: any) => i.type === "agentMessage");
  assert.deepEqual(
    agents.map((i: any) => [i.text, i.phase]),
    [["thinking out loud", "commentary"], ["the actual answer", "final_answer"]],
    "the last thing a completed turn said is its answer, whatever the stream had settled by then",
  );
});

// An interrupted turn never reached an answer, so nothing may be promoted into one.
test("an interrupted turn promotes nothing into a final answer", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  const terminals: any[] = [];
  rt.onNotification((method, params) => { if (method === "turn/completed") terminals.push(params); });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:a", input: [{ type: "text", text: "go" }] });

  claude.replyWithSettledStopReasonOnlyOnDisk(thread.id, "partway through");
  claude.settleTurn(thread.id, "ctx:a", "interrupted");
  await delay(5);

  const turn = terminals.at(-1)?.turn;
  const finals = (turn.items ?? []).filter((i: any) => i.type === "agentMessage" && i.phase === "final_answer");
  assert.deepEqual(finals, [], "an interrupted turn has no final answer to deliver");
});

// A transcript only grows. Reading it from offset 0 and refusing anything past the window meant
// a thread stopped being reconstructible the moment it outgrew one — a deadline every long-lived
// worker eventually passes, after which the read threw instead of returning what it could.
test("a transcript larger than the read window reconstructs its recent turns instead of failing", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  // Older than the window: padded far beyond it, so a head-anchored read could never reach the end.
  const filler = Array.from({ length: 400 }, (_, index) => ({
    type: "assistant",
    uuid: `old-${index}`,
    cwd: "/w",
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "x".repeat(12_000) }] },
  }));
  claude.seed("cold-big", [
    { type: "user", uuid: "ctx:old", sessionId: "cold-big", cwd: "/w", promptSource: "sdk", message: { role: "user", content: "ancient" } },
    ...filler,
    { type: "user", uuid: "ctx:recent", sessionId: "cold-big", cwd: "/w", promptSource: "sdk", message: { role: "user", content: "recent question" } },
    { type: "assistant", uuid: "agent-recent", cwd: "/w", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "recent answer" }] } },
  ]);

  const read = await rt.request<{ thread: any }>("thread/read", { threadId: "cold-big", includeTurns: true });

  const turns = read.thread.turns as Array<{ id: string; items: Array<{ type: string; text?: string }> }>;
  assert.ok(turns.length > 0, "a transcript past the window still reconstructs");
  assert.equal(turns.at(-1)?.id, "ctx:recent", "and the newest turn is the one it reaches");
  assert.ok(
    turns.at(-1)?.items.some((item) => item.type === "agentMessage" && item.text === "recent answer"),
    "with its answer intact",
  );
});

// Measured in production: the goal marker sat 269,759 bytes from the end against a 262,144-byte
// window — a miss of 3% — and the session reported NO goal while Claude was still pursuing one.
// The restart resume asks this before deciding whether to restart a parked worker, so a goal
// that scrolled out of one window is a worker that never gets going again.
test("a goal that scrolled past one window is still found", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const filler = Array.from({ length: 60 }, (_, index) => ({
    type: "assistant", uuid: `chatter-${index}`, cwd: "/w",
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "y".repeat(9_000) }] },
  }));
  claude.seed("goal-buried", [
    { type: "user", uuid: "ctx:goal", sessionId: "goal-buried", cwd: "/w", promptSource: "sdk",
      message: { role: "user", content: "<local-command-stdout>Goal set: finish the proof</local-command-stdout>" } },
    ...filler,
  ]);

  // The runtime only reads a goal for a thread it holds, as it does for a managed session.
  await rt.request("thread/read", { threadId: "goal-buried" });

  const read = await rt.request<{ goal: any }>("thread/goal/get", { threadId: "goal-buried" });

  assert.deepEqual(read.goal, { objective: "finish the proof", status: "active" });
});

// Walking back must not resurrect a goal the user cancelled: the newest marker wins, so a clear
// found on the way back ends the search rather than being skipped over.
test("a cleared goal is not resurrected by walking further back", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const filler = Array.from({ length: 60 }, (_, index) => ({
    type: "assistant", uuid: `chatter-${index}`, cwd: "/w",
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "y".repeat(9_000) }] },
  }));
  // The clear must land in a LATER window than the set, or both are read at once and the guard
  // is never exercised: filler on both sides puts them in different steps of the walk.
  claude.seed("goal-cleared", [
    { type: "user", uuid: "ctx:goal", sessionId: "goal-cleared", cwd: "/w", promptSource: "sdk",
      message: { role: "user", content: "<local-command-stdout>Goal set: finish the proof</local-command-stdout>" } },
    ...filler,
    { type: "user", uuid: "ctx:clear", sessionId: "goal-cleared", cwd: "/w", promptSource: "sdk",
      message: { role: "user", content: "<local-command-stdout>Goal cleared</local-command-stdout>" } },
    ...filler,
  ]);

  // The runtime only reads a goal for a thread it holds, as it does for a managed session.
  await rt.request("thread/read", { threadId: "goal-cleared" });

  const read = await rt.request<{ goal: any }>("thread/goal/get", { threadId: "goal-cleared" });

  assert.equal(read.goal, null);
});

// A background task or subagent belongs to no turn, so turn/interrupt cannot name it.
// Without a way to stop it the session stays active forever — unarchivable and
// unrestartable — with nothing left that could ever end it.
test("background work can be stopped so the session returns to idle", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  const turn = await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:a", input: [{ type: "text", text: "go" }] });
  claude.settleTurn(thread.id, "ctx:a", "completed");
  void turn;
  claude.emit({ type: "task/set", sessionId: thread.id, background: 1, subagents: 1, descriptions: [], at: 1 });
  claude.setBackgroundTasks(thread.id, ["bash-1", "agent-1"]);
  const before = await rt.request<{ thread: any }>("thread/read", { threadId: thread.id });
  assert.equal(before.thread.status.type, "active", "background work holds the session active");

  const result = await rt.request<{ stopped: number; remaining: number }>("thread/tasks/stop", { threadId: thread.id });

  assert.deepEqual({ ...result }, { stopped: 2, remaining: 0 });
  assert.deepEqual(claude.stoppedTasks.sort(), ["agent-1", "bash-1"], "each task was stopped by id");
  const after = await rt.request<{ thread: any }>("thread/read", { threadId: thread.id });
  assert.equal(after.thread.status.type, "idle", "and the session is observably idle afterwards");
});

// The SDK acknowledges stopTask immediately and retires the task later, so counting the
// accepted calls would report a drained session while a subagent is still running — and the
// caller's next move is an archive that would close the session out from under it.
test("a task that refuses to stop is reported as still running, not as stopped", async () => {
  const claude = new FakeClaude();
  const rt = new ClaudeCodeRuntime({
    id: "claude-local", host: claude, runner: claude, launchFlags: {}, taskStopConfirmationMs: 20,
  });
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:a", input: [{ type: "text", text: "go" }] });
  claude.settleTurn(thread.id, "ctx:a", "completed");
  claude.emit({ type: "task/set", sessionId: thread.id, background: 0, subagents: 1, descriptions: [], at: 1 });
  claude.setBackgroundTasks(thread.id, ["agent-1"]);
  claude.ignoreStopFor.add("agent-1");

  const result = await rt.request<{ stopped: number; remaining: number }>("thread/tasks/stop", { threadId: thread.id });

  assert.deepEqual({ ...result }, { stopped: 0, remaining: 1 }, "the stop was attempted but did not take");
  const after = await rt.request<{ thread: any }>("thread/read", { threadId: thread.id });
  assert.equal(after.thread.status.type, "active", "so the session is still reported busy");
});

// The session's query is gone: no task/set will ever arrive to retire its tasks. Keeping the
// counts reported the thread active for good, and a thread that never goes idle can never be
// archived, unadopted, or restarted.
test("a closed session does not stay active on the background work that died with it", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:a", input: [{ type: "text", text: "go" }] });
  claude.settleTurn(thread.id, "ctx:a", "completed");
  claude.emit({ type: "task/set", sessionId: thread.id, background: 2, subagents: 0, descriptions: [], at: 1 });
  assert.equal(
    (await rt.request<{ thread: any }>("thread/read", { threadId: thread.id })).thread.status.type,
    "active",
  );

  claude.emit({ type: "session/closed", sessionId: thread.id, at: 2 });

  const after = await rt.request<{ thread: any }>("thread/read", { threadId: thread.id });
  assert.equal(after.thread.status.type, "idle", "the dead session's tasks do not pin it active");
  assert.equal(after.thread.nativeActivity, undefined, "and nothing is reported still running");
});

// Interrupting a turn stops what that turn set running too — otherwise a subagent outlives
// its interrupted parent and pins the session non-idle.
test("interrupting a turn also stops the work it spawned", async () => {
  const claude = new FakeClaude();
  const rt = makeRuntime(claude);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:a", input: [{ type: "text", text: "go" }] });
  claude.setBackgroundTasks(thread.id, ["agent-1"]);

  await rt.request("turn/interrupt", { threadId: thread.id, turnId: "ctx:a" });
  assert.deepEqual(claude.interrupts, [thread.id], "the response was interrupted");
  assert.deepEqual(claude.stoppedTasks, ["agent-1"], "and its subagent was stopped, not left running");
});

// A send folded into a running turn is answered by that turn and has no turn row of its own.
// Its terminal must settle the session without sending the relay to find that row (bounded
// retries there degrade the whole endpoint) and without stealing the absorbing turn's place
// as the findable one a background task's report republishes.
test("a folded turn settles as terminal-and-empty without displacing the turn that absorbed it", async () => {
  const claude = new FakeClaude();
  const runtime = makeRuntime(claude);
  await runtime.start();
  const { thread } = await runtime.request<{ thread: any }>("thread/start", { cwd: "/w" });
  const notifications: Array<{ method: string; params: any }> = [];
  runtime.onNotification((method, params) => notifications.push({ method, params: params as any }));

  await runtime.request("turn/start", {
    threadId: thread.id,
    clientUserMessageId: "to:web:running",
    input: [{ type: "text", text: "this doc is still too long" }],
  });
  await runtime.request("turn/start", {
    threadId: thread.id,
    clientUserMessageId: "to:web:folded",
    input: [{ type: "text", text: "also let a subagent review" }],
  });

  // The absorbing turn answers both, so the host settles the folded send alongside it.
  claude.emit({
    type: "turn/completed", sessionId: thread.id, origin: "human",
    uuid: "to:web:folded", status: "completed", folded: true, at: 1,
  });
  claude.settleTurn(thread.id, "to:web:running", "completed");

  const terminals = notifications.filter((entry) => entry.method === "turn/completed").map((entry) => entry.params.turn);
  assert.deepEqual(terminals[0], { id: "to:web:folded", status: "completed", itemsView: "full", items: [], folded: true },
    "an explicit empty full view: nothing to deliver, and no transcript row to go looking for");

  // The session is genuinely idle again, and a background report still republishes the turn
  // that actually holds the answer rather than the folded send.
  const read = await runtime.request<{ thread: any }>("thread/read", { threadId: thread.id, includeTurns: false });
  assert.equal(read.thread.status.type, "idle");
  assert.equal(read.thread.activeTurnId, undefined);
  notifications.length = 0;
  claude.emit({
    type: "turn/completed", sessionId: thread.id, origin: "task-notification",
    status: "completed", at: 2,
  });
  assert.deepEqual(notifications.map((entry) => entry.params.turn?.id), ["to:web:running"]);
});
