import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalAppServerRuntime } from "../../src/app-server/local-runtime.ts";
import { ManagedAppServerEndpoint } from "../../src/app-server/managed-endpoint.ts";
import { AppServerPool } from "../../src/app-server/pool.ts";
import { DISCOVERY_SOURCE_KINDS } from "../../src/sessions/discovery.ts";

const enabled = process.env.RUN_CODEX_INTEGRATION === "1";
const steerEnabled = process.env.RUN_CODEX_STEER_INTEGRATION === "1";

function localEndpoint(): ManagedAppServerEndpoint {
  return new ManagedAppServerEndpoint({
    id: "local",
    runtime: new LocalAppServerRuntime({ codexBinary: "codex" }),
    requestTimeoutMs: 30_000,
  });
}

function captureNextTurn(endpoint: ManagedAppServerEndpoint, threadId: string, timeoutMs = 120_000): { completed: Promise<any>; cancel(): void } {
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
  const firstDir = await mkdtemp(join(tmpdir(), "qiyan-bot-real-one-"));
  const secondDir = await mkdtemp(join(tmpdir(), "qiyan-bot-real-two-"));
  const endpoint = localEndpoint();
  t.after(() => endpoint.closeConnection());
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
    clientUserMessageId: "qiyan-bot-integration-1",
    input: [{ type: "text", text: "Reply with exactly: INTEGRATION_OK", text_elements: [] }],
  });
  const completed = await terminal.completed;
  assert.equal(completed.id, started.turn.id);
  pool.markTurnTerminal(endpoint.id, first.thread.id, started.turn.id);
  assert.equal(completed.status, "completed");
  const read = await endpoint.request<any>("thread/read", { threadId: first.thread.id, includeTurns: true });
  const completedFromHistory = read.thread.turns.find((turn: any) => turn.id === started.turn.id);
  assert.ok(completedFromHistory.items.some((item: any) => item.type === "agentMessage" && item.text.includes("INTEGRATION_OK")));
  const user = read.thread.turns.flatMap((turn: any) => turn.items).find((item: any) => item.type === "userMessage" && item.clientId === "qiyan-bot-integration-1");
  assert.ok(user, "clientUserMessageId is persisted and can reconcile a lost turn/start response");

  const listed = await endpoint.request<any>("thread/list", { sourceKinds: [...DISCOVERY_SOURCE_KINDS], archived: false, useStateDbOnly: false, limit: 100 });
  assert.ok(listed.data.some((thread: any) => thread.id === first.thread.id));

  await endpoint.request("thread/archive", { threadId: first.thread.id });
  const archived = await endpoint.request<any>("thread/list", { sourceKinds: [...DISCOVERY_SOURCE_KINDS], archived: true, useStateDbOnly: false, limit: 100 });
  assert.ok(archived.data.some((thread: any) => thread.id === first.thread.id));
  await endpoint.request("thread/unarchive", { threadId: first.thread.id });
  await endpoint.closeConnection();
  await endpoint.start();
  const resumed = await endpoint.request<any>("thread/resume", { threadId: first.thread.id });
  assert.equal(resumed.thread.id, first.thread.id);
  assert.equal(resumed.thread.cwd, firstDir);
});

test("active turn steering persists its client correlation ID", { skip: !steerEnabled, timeout: 240_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "qiyan-bot-steer-probe-"));
  const endpoint = localEndpoint();
  t.after(() => endpoint.closeConnection());
  await endpoint.start();
  const startedThread = await endpoint.request<any>("thread/start", { cwd, approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: false });
  const threadId = startedThread.thread.id as string;
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });

  let diagnostic = "the model completed before steering";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const terminal = captureNextTurn(endpoint, threadId);
    const startId = `steer-probe-start-${attempt}`;
    const steerId = `steer-probe-message-${attempt}`;
    const turn = await pool.startTurn<any>(endpoint.id, {
      threadId,
      clientUserMessageId: startId,
      input: [{ type: "text", text: "Use the shell tool to run `sleep 5`, then reply with DONE.", text_elements: [] }],
    });
    try {
      await endpoint.request("turn/steer", {
        threadId,
        expectedTurnId: turn.turn.id,
        clientUserMessageId: steerId,
        input: [{ type: "text", text: "After the command, also include STEERED.", text_elements: [] }],
      });
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
      const completed = await terminal.completed;
      pool.markTurnTerminal(endpoint.id, threadId, completed.id);
      continue;
    }

    const repeat = await endpoint.request("turn/steer", {
      threadId,
      expectedTurnId: turn.turn.id,
      clientUserMessageId: steerId,
      input: [{ type: "text", text: "Duplicate correlation probe.", text_elements: [] }],
    }).then(() => "accepted", () => "rejected");
    assert.ok(repeat === "accepted" || repeat === "rejected");
    const completed = await terminal.completed;
    pool.markTurnTerminal(endpoint.id, threadId, completed.id);
    const history = await pool.readFullThread(endpoint.id, threadId);
    const user = history.turns.flatMap((candidate) => candidate.items)
      .find((item) => item.type === "userMessage" && item.clientId === steerId);
    assert.ok(user, "turn/steer clientUserMessageId is persisted in full history");
    return;
  }
  assert.fail(`no probe turn remained active long enough to steer: ${diagnostic}`);
});
