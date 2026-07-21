import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppServerPool } from "../../src/app-server/pool.ts";
import { ClaudeCodeRuntime } from "../../src/endpoints/claude-runtime.ts";
import { LocalClaudeCommandRunner } from "../../src/endpoints/claude-command-runner.ts";

// Real end-to-end against `claude -p`. Gated like the Codex integration test.
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
  const endpoint = new ClaudeCodeRuntime({ id: "claude-local", runner: new LocalClaudeCommandRunner(), launchFlags: {} });
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
  const [turnA, turnB] = await Promise.all([termA, termB]);
  assert.equal(turnA.id, startedA.turn.id);
  assert.equal(turnB.id, startedB.turn.id);
  pool.markTurnTerminal(endpoint.id, a.thread.id, startedA.turn.id);
  pool.markTurnTerminal(endpoint.id, b.thread.id, startedB.turn.id);

  // thread/read reconstructs the delivered answers
  const readA = await endpoint.request<any>("thread/read", { threadId: a.thread.id, includeTurns: true });
  const finalA = readA.thread.turns.at(-1).items.find((i: any) => i.type === "agentMessage" && i.phase === "final_answer");
  assert.match(finalA.text, /ALPHA/u);
  assert.equal(readA.thread.turns.at(-1).itemsView, "full");

  // resume retains context
  const term2 = captureTurn(endpoint, a.thread.id);
  const started2 = await pool.startTurn<any>(endpoint.id, { threadId: a.thread.id, clientUserMessageId: "cid-a-2", input: [{ type: "text", text: "What word did you just say? Reply only that word.", text_elements: [] }] });
  await term2;
  pool.markTurnTerminal(endpoint.id, a.thread.id, started2.turn.id);
  const readA2 = await endpoint.request<any>("thread/read", { threadId: a.thread.id, includeTurns: true });
  const final2 = readA2.thread.turns.at(-1).items.find((i: any) => i.type === "agentMessage" && i.phase === "final_answer");
  assert.match(final2.text, /ALPHA/u);
});
