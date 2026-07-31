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
    const session = this.sessions.get(sessionId);
    return {
      sessionId,
      activity: (session?.inFlight.length ?? 0) > 0 ? "working" : "idle",
      inFlightTurns: [...(session?.inFlight ?? [])],
      backgroundTasks: [],
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

  async models(): Promise<unknown[]> { return []; }
  async stopTask(): Promise<void> {}

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

  private settle(sessionId: string, uuid: string, status: "completed" | "failed" | "interrupted"): void {
    this.emit({ type: "turn/completed", sessionId, origin: "human", uuid, status, at: this.clock += 1 });
  }

  private emit(event: HostEvent): void { for (const listener of this.listeners) listener(event); }

  private require(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`claude session is not loaded: ${sessionId}`);
    return session;
  }
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
        return threadId === "remote-live" ? { turnId: "ctx:live" } : undefined;
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
  await assert.rejects(
    rt.request("turn/start", {
      threadId: "remote-live",
      clientUserMessageId: "ctx:duplicate",
      input: [{ type: "text", text: "duplicate" }],
    }),
    /already running/u,
  );
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

  assert.equal(claude.opens.length, 1, "the second turn must not open a second session");
  assert.equal(firstOutcome.status, "fulfilled");
  assert.equal(secondOutcome.status, "rejected");
  assert.match(String(secondOutcome.status === "rejected" ? secondOutcome.reason : ""), /already running/u);
  assert.deepEqual(claude.sends.map((send) => send.uuid), ["ctx:first"]);
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
        item: { type: "agentMessage", id: `${agentUuid}:0`, text: "reply to hello" },
      },
    },
    { method: "turn/completed", params: { threadId, turn: { id: "ctx:call-1" } } },
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
        item: { type: "agentMessage", id: `${backgroundUuid}:0`, text: "the background job finished: 42 files" },
      },
    },
    { method: "turn/completed", params: { threadId, turn: { id: "ctx:1" } } },
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
  const delivered: Array<{ threadId: string; message: string }> = [];
  const claude = new FakeClaude();
  const rt = new ClaudeCodeRuntime({
    id: "claude-local", host: claude, runner: claude, launchFlags: {},
    steer: async (threadId, message) => { delivered.push({ threadId, message }); },
  });
  await rt.start();

  // Reading stays graceful so a provider-neutral get_session_status still works: native
  // goal state is not exposed to the SDK stream, so there is nothing to report.
  assert.deepEqual(await rt.request("thread/goal/get", { threadId: "t" }), { goal: null });

  const set = await rt.request<{ goal: any }>("thread/goal/set", { threadId: "t", objective: "finish phase 2" });
  assert.equal(set.goal.objective, "finish phase 2");
  assert.deepEqual(delivered.at(-1), { threadId: "t", message: "/goal finish phase 2" });

  assert.deepEqual(await rt.request("thread/goal/clear", { threadId: "t" }), { goal: null });
  assert.deepEqual(delivered.at(-1), { threadId: "t", message: "/goal clear" });
});

// Claude compacts through its own /compact command; QiYan drives no compaction of its own.
test("compact_session drives Claude's native /compact", async () => {
  const delivered: string[] = [];
  const claude = new FakeClaude();
  const rt = new ClaudeCodeRuntime({
    id: "claude-local", host: claude, runner: claude, launchFlags: {},
    steer: async (_threadId, message) => { delivered.push(message); },
  });
  await rt.start();
  await rt.request("thread/compact/start", { threadId: "t" });
  assert.deepEqual(delivered, ["/compact"]);
});

// Native /goal has no pause/resume, and QiYan stores no objective to reinstate.
test("a status-only goal change is refused rather than silently dropped", async () => {
  const claude = new FakeClaude();
  const rt = new ClaudeCodeRuntime({
    id: "claude-local", host: claude, runner: claude, launchFlags: {}, steer: async () => {},
  });
  await rt.start();
  await assert.rejects(rt.request("thread/goal/set", { threadId: "t", status: "paused" }), /pause\/resume/u);
});

test("turn/steer durably enqueues the message (never aborts the running turn)", async () => {
  const steered: Array<{ threadId: string; message: string }> = [];
  const claude = new FakeClaude();
  const rt = new ClaudeCodeRuntime({
    id: "claude-local", host: claude, runner: claude, launchFlags: {},
    steer: async (threadId, message) => { steered.push({ threadId, message }); },
  });
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  // a turn is running
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:c1", input: [{ type: "text", text: "long task" }] });
  const res = await rt.request<{ turnId: string }>("turn/steer", { threadId: thread.id, clientUserMessageId: "ctx:steer1", input: [{ type: "text", text: "also do X" }], expectedTurnId: "ctx:c1" });
  assert.equal(res.turnId, "ctx:steer1");
  assert.deepEqual(steered, [{ threadId: thread.id, message: "also do X" }]);
  assert.deepEqual(claude.interrupts, [], "steer must never abort the running response");
  assert.deepEqual(claude.inFlight(thread.id), ["ctx:c1"]);
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
