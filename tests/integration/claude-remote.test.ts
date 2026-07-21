import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppServerPool } from "../../src/app-server/pool.ts";
import { ClaudeCodeRuntime } from "../../src/endpoints/claude-runtime.ts";
import { SshClaudeCommandRunner } from "../../src/endpoints/ssh-claude-command-runner.ts";
import { parseSshConfig, planSshConnection } from "../../src/endpoints/ssh-config.ts";
import { runBoundedProcess } from "../../src/endpoints/ssh-process.ts";

// Real end-to-end against `claude -p` on a REMOTE host over ssh (ControlMaster).
// RUN_CLAUDE_REMOTE_INTEGRATION=1 CLAUDE_REMOTE_HOST=dfw-vscode
const host = process.env.CLAUDE_REMOTE_HOST;
const enabled = process.env.RUN_CLAUDE_REMOTE_INTEGRATION === "1" && !!host;

test("a remote Claude session drives through the pool over ssh", { skip: !enabled, timeout: 180_000 }, async (t) => {
  const effective = parseSshConfig((await runBoundedProcess("ssh", ["-G", host!], { timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 })).stdout.toString("utf8"));
  const plan = planSshConnection(host!, effective, await mkdtemp(join(tmpdir(), "qiyan-claude-remote-")));
  const endpoint = new ClaudeCodeRuntime({ id: "claude-remote", runner: new SshClaudeCommandRunner({ plan }), launchFlags: {} });
  t.after(() => endpoint.closeConnection());
  await endpoint.start();

  const { thread } = await endpoint.request<any>("thread/start", { cwd: "/tmp", threadSource: "worker-thread" });
  assert.equal(thread.status.type, "idle");

  const pool = new AppServerPool([endpoint], {});
  const completed = new Promise<any>((resolve) => {
    const off = endpoint.onNotification((m, p: any) => { if (m === "turn/completed" && p.threadId === thread.id) { off(); resolve(p.turn); } });
  });
  const started = await pool.startTurn<any>(endpoint.id, { threadId: thread.id, clientUserMessageId: "rmt-1", input: [{ type: "text", text: "Reply with exactly the word REMOTEOK.", text_elements: [] }] });
  const turn = await completed;
  assert.equal(turn.id, started.turn.id);
  pool.markTurnTerminal(endpoint.id, thread.id, started.turn.id);

  const read = await endpoint.request<any>("thread/read", { threadId: thread.id, includeTurns: true });
  const final = read.thread.turns.at(-1).items.find((i: any) => i.type === "agentMessage" && i.phase === "final_answer");
  assert.match(final.text, /REMOTEOK/u);

  // resume retains context over ssh
  const c2 = new Promise<any>((resolve) => { const off = endpoint.onNotification((m, p: any) => { if (m === "turn/completed" && p.turn.id === "rmt-2") { off(); resolve(p.turn); } }); });
  await pool.startTurn<any>(endpoint.id, { threadId: thread.id, clientUserMessageId: "rmt-2", input: [{ type: "text", text: "What word did you just say? Reply only that word.", text_elements: [] }] });
  await c2;
  const read2 = await endpoint.request<any>("thread/read", { threadId: thread.id, includeTurns: true });
  const final2 = read2.thread.turns.at(-1).items.find((i: any) => i.type === "agentMessage" && i.phase === "final_answer");
  assert.match(final2.text, /REMOTEOK/u);

});

// A worker `monitor` check must evaluate on the REMOTE host (over ssh), not the QiYan host.
// runShellCheck resolves true only when the remote command exits 0, so a create/observe/remove
// round-trip on the remote filesystem proves it both runs remotely and maps the exit code.
test("a remote monitor check runs on the remote host over ssh", { skip: !enabled, timeout: 60_000 }, async () => {
  const effective = parseSshConfig((await runBoundedProcess("ssh", ["-G", host!], { timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 })).stdout.toString("utf8"));
  const plan = planSshConnection(host!, effective, await mkdtemp(join(tmpdir(), "qiyan-claude-check-")));
  const runner = new SshClaudeCommandRunner({ plan });
  // Exit code → boolean mapping.
  assert.equal(await runner.runShellCheck("true"), true);
  assert.equal(await runner.runShellCheck("false"), false);
  assert.equal(await runner.runShellCheck("exit 3"), false);
  // Real remote filesystem state: the check sees a marker only after it is created ON the
  // remote host, and stops seeing it once removed there.
  const marker = `/tmp/qiyan-check-${process.pid}-${Date.now()}`;
  assert.equal(await runner.runShellCheck(`test ! -e ${marker}`), true);
  assert.equal(await runner.runShellCheck(`touch -- ${marker} && test -f ${marker}`), true);
  assert.equal(await runner.runShellCheck(`test -f ${marker}`), true);
  assert.equal(await runner.runShellCheck(`rm -f -- ${marker} && test ! -e ${marker}`), true);
  assert.equal(await runner.runShellCheck(`test -f ${marker}`), false);
});
