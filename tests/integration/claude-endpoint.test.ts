import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppServerPool } from "../../src/app-server/pool.ts";
import { ClaudeCodeRuntime } from "../../src/endpoints/claude-runtime.ts";
import { LocalClaudeCommandRunner } from "../../src/endpoints/claude-command-runner.ts";
import { LocalClaudeHost } from "../../src/claude-host/host.ts";
import { loadAgentSdk } from "../../src/claude-host/requirements.ts";
import { sdkSessionPreparer, type QueryFn } from "../../src/claude-host/sdk-query.ts";

// Real end-to-end against a live Claude Agent SDK host. Gated like the Codex integration
// test, and additionally on the SDK + Claude CLI being installed on this machine — both
// are deployment prerequisites rather than bundled dependencies.
const enabled = process.env.RUN_CLAUDE_INTEGRATION === "1";

function captureTurn(endpoint: ClaudeCodeRuntime, threadId: string, timeoutMs = 120_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`timed out on ${threadId}`)); }, timeoutMs);
    const off = endpoint.onNotification((method, params: any) => {
      if (method === "turn/completed" && params.threadId === threadId) { clearTimeout(timer); off(); resolve(params.turn); }
    });
  });
}

test("a Claude endpoint drives two multiplexed sessions through the pool", { skip: !enabled, timeout: 180_000 }, async (t) => {
  const sdk = await loadAgentSdk();
  const prepare = sdkSessionPreparer(sdk.query as QueryFn, { claudeExecutable: "claude" });
  // Count launches: the whole point of the host is that a session's query outlives its
  // turns, so N turns on one thread must still be exactly one launch.
  let launches = 0;
  const host = new LocalClaudeHost(async (request) => { launches += 1; return await prepare(request); });
  const endpoint = new ClaudeCodeRuntime({
    id: "claude-local", host, runner: new LocalClaudeCommandRunner(), launchFlags: {},
  });
  t.after(() => endpoint.closeConnection());
  await endpoint.start();
  const dirA = await mkdtemp(join(tmpdir(), "qiyan-claude-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "qiyan-claude-b-"));

  const a = await endpoint.request<any>("thread/start", { cwd: dirA, threadSource: "worker-thread" });
  const b = await endpoint.request<any>("thread/start", { cwd: dirB, threadSource: "worker-thread" });
  assert.notEqual(a.thread.id, b.thread.id);
  assert.equal(a.thread.status.type, "idle");

  const pool = new AppServerPool([endpoint], {});

  // two sessions multiplex on one endpoint concurrently
  const termA = captureTurn(endpoint, a.thread.id);
  const termB = captureTurn(endpoint, b.thread.id);
  const [startedA, startedB] = await Promise.all([
    pool.startTurn<any>(endpoint.id, { threadId: a.thread.id, clientUserMessageId: "cid-a-1", input: [{ type: "text", text: "Reply with exactly: ALPHA", text_elements: [] }] }),
    pool.startTurn<any>(endpoint.id, { threadId: b.thread.id, clientUserMessageId: "cid-b-1", input: [{ type: "text", text: "Reply with exactly: BETA", text_elements: [] }] }),
  ]);
  // The caller's message id IS the turn id, live and in history — no correlation marker.
  assert.equal(startedA.turn.id, "cid-a-1");
  const [turnA, turnB] = await Promise.all([termA, termB]);
  assert.equal(turnA.id, startedA.turn.id);
  assert.equal(turnB.id, startedB.turn.id);
  pool.markTurnTerminal(endpoint.id, a.thread.id, startedA.turn.id);
  pool.markTurnTerminal(endpoint.id, b.thread.id, startedB.turn.id);
  assert.equal(launches, 2, "one session launch per thread, not per turn");

  // thread/read reconstructs the delivered answers under the same turn id
  const readA = await endpoint.request<any>("thread/read", { threadId: a.thread.id, includeTurns: true });
  const turnFromHistory = readA.thread.turns.find((turn: any) => turn.id === "cid-a-1");
  assert.ok(turnFromHistory, "the turn QiYan just ran is findable in history by its own id");
  const finalA = turnFromHistory.items.find((i: any) => i.type === "agentMessage" && i.phase === "final_answer");
  assert.match(finalA.text, /ALPHA/u);
  assert.equal(turnFromHistory.itemsView, "full");

  // the same live session retains context; it is not relaunched
  const term2 = captureTurn(endpoint, a.thread.id);
  const started2 = await pool.startTurn<any>(endpoint.id, { threadId: a.thread.id, clientUserMessageId: "cid-a-2", input: [{ type: "text", text: "What word did you just say? Reply only that word.", text_elements: [] }] });
  await term2;
  pool.markTurnTerminal(endpoint.id, a.thread.id, started2.turn.id);
  assert.equal(launches, 2, "the second turn reused the loaded session");
  const readA2 = await endpoint.request<any>("thread/read", { threadId: a.thread.id, includeTurns: true });
  const final2 = readA2.thread.turns.at(-1).items.find((i: any) => i.type === "agentMessage" && i.phase === "final_answer");
  assert.match(final2.text, /ALPHA/u);
});
