import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalEndpoint } from "../../src/app-server/local-endpoint.ts";
import { AppServerPool } from "../../src/app-server/pool.ts";
import { DISCOVERY_SOURCE_KINDS } from "../../src/sessions/discovery.ts";

const enabled = process.env.RUN_CODEX_INTEGRATION === "1";

function captureNextTurn(endpoint: LocalEndpoint, threadId: string, timeoutMs = 120_000): { completed: Promise<any>; cancel(): void } {
  let unsubscribe: () => void = () => undefined;
  let timeout: ReturnType<typeof setTimeout>;
  const completed = new Promise((resolve, reject) => {
    timeout = setTimeout(() => { unsubscribe(); reject(new Error(`timed out waiting for a terminal turn on ${threadId}`)); }, timeoutMs);
    unsubscribe = endpoint.onNotification((method, params: any) => {
      if (method === "turn/completed" && params.threadId === threadId) {
        clearTimeout(timeout); unsubscribe(); resolve(params.turn);
      }
    });
  });
  return { completed, cancel: () => { clearTimeout(timeout); unsubscribe(); } };
}

test("pinned app-server supports multiple threads, discovery, goals, turns, and restart", { skip: !enabled, timeout: 180_000 }, async (t) => {
  const firstDir = await mkdtemp(join(tmpdir(), "codex-bot-real-one-"));
  const secondDir = await mkdtemp(join(tmpdir(), "codex-bot-real-two-"));
  const endpoint = new LocalEndpoint({ codexBinary: "codex", requestTimeoutMs: 30_000 });
  t.after(() => endpoint.stop());
  await endpoint.start();
  const first = await endpoint.request<any>("thread/start", { cwd: firstDir, approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: false });
  const second = await endpoint.request<any>("thread/start", { cwd: secondDir, approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: false });
  assert.notEqual(first.thread.id, second.thread.id);
  assert.equal(first.cwd, firstDir);

  await endpoint.request("thread/goal/set", { threadId: first.thread.id, objective: "integration objective", status: "active" });
  assert.equal((await endpoint.request<any>("thread/goal/get", { threadId: first.thread.id })).goal.objective, "integration objective");
  await endpoint.request("thread/goal/clear", { threadId: first.thread.id });

  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  const terminal = captureNextTurn(endpoint, first.thread.id);
  const started = await pool.startTurn<any>(endpoint.id, {
    threadId: first.thread.id,
    clientUserMessageId: "codex-bot-integration-1",
    input: [{ type: "text", text: "Reply with exactly: INTEGRATION_OK", text_elements: [] }],
  });
  const completed = await terminal.completed;
  assert.equal(completed.id, started.turn.id);
  pool.markTurnTerminal(endpoint.id, first.thread.id, started.turn.id);
  assert.equal(completed.status, "completed");
  const read = await endpoint.request<any>("thread/read", { threadId: first.thread.id, includeTurns: true });
  const completedFromHistory = read.thread.turns.find((turn: any) => turn.id === started.turn.id);
  assert.ok(completedFromHistory.items.some((item: any) => item.type === "agentMessage" && item.text.includes("INTEGRATION_OK")));
  const user = read.thread.turns.flatMap((turn: any) => turn.items).find((item: any) => item.type === "userMessage" && item.clientId === "codex-bot-integration-1");
  assert.ok(user, "clientUserMessageId is persisted and can reconcile a lost turn/start response");

  const listed = await endpoint.request<any>("thread/list", { sourceKinds: [...DISCOVERY_SOURCE_KINDS], archived: false, useStateDbOnly: false, limit: 100 });
  assert.ok(listed.data.some((thread: any) => thread.id === first.thread.id));

  await endpoint.request("thread/archive", { threadId: first.thread.id });
  const archived = await endpoint.request<any>("thread/list", { sourceKinds: [...DISCOVERY_SOURCE_KINDS], archived: true, useStateDbOnly: false, limit: 100 });
  assert.ok(archived.data.some((thread: any) => thread.id === first.thread.id));
  await endpoint.request("thread/unarchive", { threadId: first.thread.id });
  await endpoint.stop();
  await endpoint.start();
  const resumed = await endpoint.request<any>("thread/resume", { threadId: first.thread.id, cwd: firstDir, approvalPolicy: "never", sandbox: "danger-full-access" });
  assert.equal(resumed.thread.id, first.thread.id);
});
