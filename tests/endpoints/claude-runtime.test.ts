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

test("reading an unknown thread reproduces the exact Codex no-rollout error", async () => {
  const rt = makeRuntime(new FakeRunner());
  await rt.start();
  await assert.rejects(
    rt.request("thread/read", { threadId: "nope", includeTurns: true }),
    (error: unknown) => error instanceof JsonRpcResponseError && error.code === -32600 && error.rpcMessage === "no rollout found for thread id nope",
  );
});

test("buildClaudeArgs emits stable, byte-identical flags", () => {
  const base: ClaudeTurnRequest = {
    threadId: "sid-1", cwd: "/w", message: "hi", resume: false,
    flags: { appendSystemPrompt: "SP", disallowedTools: ["Monitor", "ScheduleWakeup"], mcpConfig: ["/tmp/m.json"], model: "claude-opus-4-8" },
  };
  assert.deepEqual(buildClaudeArgs(base), [
    "-p", "hi", "--output-format", "stream-json", "--verbose",
    "--session-id", "sid-1",
    "--append-system-prompt", "SP",
    "--disallowedTools", "Monitor ScheduleWakeup",
    "--mcp-config", "/tmp/m.json", "--strict-mcp-config",
    "--model", "claude-opus-4-8",
  ]);
  assert.equal(buildClaudeArgs({ ...base, resume: true }).includes("--resume"), true);
});
