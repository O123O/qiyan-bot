import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ClaudeCodeRuntime } from "../../src/endpoints/claude-runtime.ts";
import {
  buildClaudeArgs,
  type ClaudeCommandRunner,
  type ClaudeTurnRequest,
  type ClaudeTurnStatus,
} from "../../src/endpoints/claude-command-runner.ts";
import { JsonRpcResponseError } from "../../src/app-server/rpc-client.ts";
import { ClaudeGoalStore } from "../../src/sessions/claude-goals.ts";
import { createTestDatabase } from "../../src/storage/database.ts";

// A fake runner that simulates the transcript `claude -p` writes. Realistic: the
// turn-start user row is written when the turn begins, but the terminal assistant
// (end_turn) row appears only on genuine completion — an interrupted turn has none.
class FakeRunner implements ClaudeCommandRunner {
  readonly requests: ClaudeTurnRequest[] = [];
  private readonly transcripts = new Map<string, unknown[]>();
  private readonly pending: Array<{ threadId: string; marker: string; settle: (s: ClaudeTurnStatus) => void; settled: boolean }> = [];

  startTurn(request: ClaudeTurnRequest) {
    this.requests.push(request);
    const marker = /<!-- qiyan-cid:([^\s]+) -->/u.exec(request.message)?.[1] ?? "none";
    const recs = this.transcripts.get(request.threadId) ?? [];
    recs.push({ type: "user", promptSource: "sdk", promptId: `prompt-${recs.length}`, uuid: `u-${recs.length}`, message: { role: "user", content: request.message } });
    this.transcripts.set(request.threadId, recs);
    let settle!: (s: ClaudeTurnStatus) => void;
    const done = new Promise<ClaudeTurnStatus>((r) => { settle = r; });
    const entry = { threadId: request.threadId, marker, settle, settled: false };
    this.pending.push(entry);
    return { done, interrupt: () => { if (!entry.settled) { entry.settled = true; entry.settle("failed"); } } };
  }
  complete(status: ClaudeTurnStatus = "completed") {
    const entry = this.pending.find((p) => !p.settled);
    if (!entry) return;
    entry.settled = true;
    if (status === "completed") {
      const recs = this.transcripts.get(entry.threadId)!;
      recs.push({ type: "assistant", uuid: `a-${recs.length}`, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: `reply to ${entry.marker}` }] } });
    }
    entry.settle(status);
  }
  async readTranscript(threadId: string) { return this.transcripts.get(threadId) ?? []; }
  async transcriptPath(threadId: string) { return this.transcripts.has(threadId) ? `/fake/${threadId}.jsonl` : undefined; }
  async listThreads(cwd?: string) {
    return [...this.transcripts.keys()].map((id) => ({ id, cwd: cwd ?? "/fake", updatedAt: 0, preview: "" }));
  }
}

function makeRuntime(runner: ClaudeCommandRunner) {
  return new ClaudeCodeRuntime({ id: "claude-local", runner, launchFlags: { model: "claude-opus-4-8" } });
}

test("thread/start reserves an idle empty thread without spawning", async () => {
  const runner = new FakeRunner();
  const rt = makeRuntime(runner);
  await rt.start();
  assert.equal(rt.state, "ready");
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w", threadSource: "worker-thread" });
  assert.equal(typeof thread.id, "string");
  assert.equal(thread.cwd, "/w");
  assert.equal(thread.threadSource, "worker-thread");
  assert.deepEqual(thread.status, { type: "idle" });
  assert.deepEqual(thread.turns, []);
  assert.equal(runner.requests.length, 0); // no subprocess yet
});

test("first turn uses --session-id, resumes after; turn/completed fires; thread/read is authoritative", async () => {
  const runner = new FakeRunner();
  const rt = makeRuntime(runner);
  await rt.start();
  const notifications: Array<{ method: string; params: any }> = [];
  rt.onNotification((method, params) => notifications.push({ method, params: params as any }));

  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w", threadSource: "worker-thread" });
  const threadId = thread.id;

  const started = await rt.request<{ turn: any }>("turn/start", { threadId, clientUserMessageId: "ctx:call-1", input: [{ type: "text", text: "hello" }] });
  assert.deepEqual(started.turn, { id: "ctx:call-1", status: "inProgress" });
  assert.equal(runner.requests[0]?.resume, false); // --session-id on the first turn

  runner.complete("completed");
  await delay(5);
  assert.deepEqual(notifications, [{ method: "turn/completed", params: { threadId, turn: { id: "ctx:call-1" } } }]);

  const read = await rt.request<{ thread: any }>("thread/read", { threadId, includeTurns: true });
  assert.equal(read.thread.turns.length, 1);
  const turn = read.thread.turns[0];
  assert.equal(turn.id, "ctx:call-1"); // turn id == clientUserMessageId, so the relay finds it
  assert.equal(turn.status, "completed");
  assert.equal(turn.itemsView, "full");
  assert.equal(turn.items[0].type, "userMessage");
  assert.equal(turn.items[0].clientId, "ctx:call-1");
  const final = turn.items.find((i: any) => i.type === "agentMessage" && i.phase === "final_answer");
  assert.equal(final.text, "reply to ctx:call-1");

  // second turn resumes
  await rt.request("turn/start", { threadId, clientUserMessageId: "ctx:call-2", input: [{ type: "text", text: "again" }] });
  assert.equal(runner.requests[1]?.resume, true); // --resume after materialization
});

test("turn/interrupt kills the running turn and marks it interrupted (terminal)", async () => {
  const runner = new FakeRunner();
  const rt = makeRuntime(runner);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:c1", input: [{ type: "text", text: "go" }] });
  const res = await rt.request("turn/interrupt", { threadId: thread.id, turnId: "ctx:c1" });
  assert.deepEqual(res, {});
  await delay(5);
  const read = await rt.request<{ thread: any }>("thread/read", { threadId: thread.id, includeTurns: true });
  assert.equal(read.thread.turns[0].status, "interrupted");
});

test("reading an unknown thread with no transcript reproduces the exact Codex no-rollout error", async () => {
  const rt = makeRuntime(new FakeRunner());
  await rt.start();
  await assert.rejects(
    rt.request("thread/read", { threadId: "nope", includeTurns: true }),
    (error: unknown) => error instanceof JsonRpcResponseError && error.code === -32600 && error.rpcMessage === "no rollout found for thread id nope",
  );
});

test("a cold-started session (on disk, not in memory) is rehydrated from the transcript, not reported gone", async () => {
  // runtime A runs a turn, materializing a transcript in the shared runner.
  const runner = new FakeRunner();
  const a = makeRuntime(runner);
  await a.start();
  const { thread } = await a.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await a.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:c1", input: [{ type: "text", text: "hi" }] });
  runner.complete("completed");
  await delay(5);

  // runtime B (fresh in-memory state, e.g. after a QiYan restart) reads the same id.
  const b = makeRuntime(runner);
  await b.start();
  const read = await b.request<{ thread: any }>("thread/read", { threadId: thread.id, includeTurns: true });
  assert.equal(read.thread.turns.length, 1);
  assert.equal(read.thread.turns[0].id, "ctx:c1");
  assert.equal(read.thread.turns[0].status, "completed");
});

test("thread/goal get/set/status/clear are emulated via the goal store", async () => {
  const goals = new ClaudeGoalStore(createTestDatabase());
  const rt = new ClaudeCodeRuntime({ id: "claude-local", runner: new FakeRunner(), launchFlags: {}, goals, now: () => 1 });
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });

  assert.deepEqual(await rt.request("thread/goal/get", { threadId: thread.id }), { goal: null });
  const set = await rt.request<{ goal: any }>("thread/goal/set", { threadId: thread.id, objective: "finish phase 2", status: "active" });
  assert.equal(set.goal.objective, "finish phase 2");
  assert.equal(set.goal.status, "active");

  const paused = await rt.request<{ goal: any }>("thread/goal/set", { threadId: thread.id, status: "paused" });
  assert.equal(paused.goal.status, "paused");

  assert.deepEqual(await rt.request("thread/goal/clear", { threadId: thread.id }), { goal: null });
});

test("with no goal store, goal read is empty but goal writes fail loud, not silently", async () => {
  const rt = makeRuntime(new FakeRunner()); // no goals configured (e.g. a remote Claude endpoint)
  await rt.start();
  // Reading is graceful — no store means no goal — so get_session_status doesn't blow up.
  assert.deepEqual(await rt.request("thread/goal/get", { threadId: "t" }), { goal: null });
  // Writing a goal you can't persist must still fail loudly.
  await assert.rejects(rt.request("thread/goal/set", { threadId: "t", objective: "x" }), /goal store/u);
  await assert.rejects(rt.request("thread/goal/clear", { threadId: "t" }), /goal store/u);
});

test("turn/steer durably enqueues the message (never aborts the running turn)", async () => {
  const steered: Array<{ threadId: string; message: string }> = [];
  const rt = new ClaudeCodeRuntime({ id: "claude-local", runner: new FakeRunner(), launchFlags: {}, steer: async (threadId, message) => { steered.push({ threadId, message }); } });
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  // a turn is running
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:c1", input: [{ type: "text", text: "long task" }] });
  const res = await rt.request<{ turnId: string }>("turn/steer", { threadId: thread.id, clientUserMessageId: "ctx:steer1", input: [{ type: "text", text: "also do X" }], expectedTurnId: "ctx:c1" });
  assert.equal(res.turnId, "ctx:steer1");
  assert.deepEqual(steered, [{ threadId: thread.id, message: "also do X" }]);
});

test("buildClaudeArgs emits stable, byte-identical flags", () => {
  const base: ClaudeTurnRequest = {
    threadId: "sid-1", cwd: "/w", message: "hi", resume: false,
    flags: { appendSystemPrompt: "SP", disallowedTools: ["Monitor", "ScheduleWakeup"], mcpConfig: ["/tmp/m.json"], model: "claude-opus-4-8", effort: "high" },
  };
  assert.deepEqual(buildClaudeArgs(base), [
    "-p", "--output-format", "stream-json", "--verbose",
    "--session-id", "sid-1",
    "--append-system-prompt", "SP",
    "--disallowedTools", "Monitor ScheduleWakeup",
    "--mcp-config", "/tmp/m.json", "--strict-mcp-config",
    "--model", "claude-opus-4-8",
    "--effort", "high",
  ]);
  assert.equal(buildClaudeArgs({ ...base, resume: true }).includes("--resume"), true);
  assert.equal(buildClaudeArgs(base).includes("hi"), false); // prompt goes over stdin, never argv
});

test("model/list returns the curated catalog in Codex {data,nextCursor} shape with efforts", async () => {
  const rt = makeRuntime(new FakeRunner());
  await rt.start();
  const result = await rt.request<{ data: any[]; nextCursor: null }>("model/list", {});
  assert.equal(result.nextCursor, null);
  assert.ok(result.data.length > 0, "catalog is non-empty (unblocks set_session_model)");
  assert.ok(result.data.some((m) => m.id === "claude-opus-4-8" && m.isDefault), "configured model present + default");
  assert.ok(result.data.every((m) => m.supportedReasoningEfforts.some((e: any) => e.reasoningEffort === "high" && m.supportedReasoningEfforts.some((x: any) => x.reasoningEffort === "xhigh"))));
});

test("turn/start applies per-session model + effort over the endpoint defaults", async () => {
  const runner = new FakeRunner();
  const rt = makeRuntime(runner);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "c1", input: "hi", model: "haiku", effort: "high" });
  const req = runner.requests.at(-1)!;
  assert.equal(req.flags.model, "haiku", "per-session --model overrides launchFlags.model");
  assert.equal(req.flags.effort, "high", "per-session --effort applied");
  runner.complete();
});

test("thread/read reports active while the subprocess runs, idle after", async () => {
  const runner = new FakeRunner();
  const rt = makeRuntime(runner);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "c1", input: "hi" });
  const running = await rt.request<{ thread: any }>("thread/read", { threadId: thread.id });
  assert.equal(running.thread.status.type, "active");
  runner.complete();
  await new Promise((resolve) => setImmediate(resolve)); // let the completion handler clear state.running
  const idle = await rt.request<{ thread: any }>("thread/read", { threadId: thread.id });
  assert.equal(idle.thread.status.type, "idle");
});

test("thread/list splits archived tombstones and hides them from the default page", async () => {
  const { createTestDatabase } = await import("../../src/storage/database.ts");
  const { ClaudeArchiveStore } = await import("../../src/sessions/claude-archives.ts");
  const runner = new FakeRunner();
  // Two discoverable threads via the runner's listThreads.
  await runner.readTranscript("t-keep"); runner["transcripts"].set("t-keep", [{ cwd: "/w" }]);
  runner["transcripts"].set("t-gone", [{ cwd: "/w" }]);
  const archives = new ClaudeArchiveStore(createTestDatabase());
  const rt = new ClaudeCodeRuntime({ id: "claude-local", runner, launchFlags: {}, archives });
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

test("turn input renders file attachments as readable paths for `claude -p`", async () => {
  const runner = new FakeRunner();
  const rt = makeRuntime(runner);
  await rt.start();
  const { thread } = await rt.request<{ thread: any }>("thread/start", { cwd: "/w" });
  // The worker file bridge stages each attachment as a localImage/mention item whose path is
  // valid on the worker's host; the Claude adapter must forward that path (not drop it) so
  // `claude` can read the file.
  await rt.request("turn/start", { threadId: thread.id, clientUserMessageId: "ctx:att", input: [
    { type: "text", text: "look at these" },
    { type: "localImage", path: "/runtime/files/abc.png" },
    { type: "mention", name: "report.pdf", path: "/runtime/files/def" },
  ] });
  const message = runner.requests[0]!.message;
  assert.match(message, /look at these/u);
  assert.match(message, /\/runtime\/files\/abc\.png/u, "image attachment path forwarded");
  assert.match(message, /report\.pdf/u, "mention display name forwarded");
  assert.match(message, /\/runtime\/files\/def/u, "mention attachment path forwarded");
});
