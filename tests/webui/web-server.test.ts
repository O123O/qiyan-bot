import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { WebBus } from "../../src/webui/web-bus.ts";
import { createWebServer } from "../../src/webui/web-server.ts";
import type { WebReadsDeps } from "../../src/webui/web-reads.ts";

const TOKEN = "test-token-abc";

const reads: WebReadsDeps = {
  registrySnapshot: () => ({ version: 3, assistant: { endpoint: "assistant-local", thread_id: "a", project_dir: "/a", mapping_id: "m", lifecycle_state: "managed" }, sessions: {
    payments: { endpoint: "local", thread_id: "t1", project_dir: "/p", mapping_id: "m1", lifecycle_state: "managed" },
  } } as never),
  dashboardSnapshot: () => ({ version: 2, sessions: {
    payments: { identity: { thread_id: "t1", endpoint: "local", project_dir: "/p" }, auto_session_info: { management_state: "managed", native_status: "idle", active_turn_id: null, last_sent: null, last_worker_event: null, model: { current: "gpt-5", pending: null }, reasoning_effort: { current: null, pending: null }, token_usage: null, goal: { objective: "ship it", status: "active", token_budget: null }, observed_at: null }, manager_notes: {} },
  } } as never),
  listFinals: (_e, _t, count) => Array.from({ length: Math.min(count, 2) }, (_, i) => ({ id: `f${i}`, endpointId: "local", threadId: "t1", turnId: `turn-${i}`, itemId: `it${i}`, completedAt: 1000 + i, itemOrder: 0, body: `final ${i}`, terminalStatus: "completed" })),
  provider: () => "codex",
};

async function withServer(run: (base: string, calls: { inputs: Array<{ text: string; target?: string }> }, bus: WebBus) => Promise<void>): Promise<void> {
  const bus = new WebBus();
  const calls = { inputs: [] as Array<{ text: string; target?: string }> };
  const staticDir = await mkdtemp(join(tmpdir(), "qiyan-webui-"));
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>ok</title>");
  const server = createWebServer({
    host: "127.0.0.1", port: 0, allowLan: false, token: TOKEN, staticDir, bus, reads,
    files: { projectDir: () => undefined, maxFileBytes: 1024 },
    submitInput: async (text, target) => { calls.inputs.push({ text, ...(target ? { target } : {}) }); return { ok: true }; },
    report: () => {},
  });
  const { url } = await server.start();
  const base = url.slice(0, url.indexOf("/?"));
  try { await run(base, calls, bus); } finally { await server.stop(); }
}

test("requires the token on every route", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/sessions`)).status, 401);
    assert.equal((await fetch(`${base}/api/sessions?token=wrong`)).status, 401);
    assert.equal((await fetch(`${base}/api/sessions?token=${TOKEN}`)).status, 200);
  });
});

test("serves the session list and a worker transcript", async () => {
  await withServer(async (base) => {
    const list = await (await fetch(`${base}/api/sessions?token=${TOKEN}`)).json();
    assert.deepEqual(list.sessions.map((s: { nickname: string }) => s.nickname), ["payments"]);
    assert.equal(list.sessions[0].provider, "codex");
    assert.deepEqual(list.sessions[0].goal, { objective: "ship it", status: "active" });

    const t = await (await fetch(`${base}/api/sessions/payments/messages?count=5&token=${TOKEN}`)).json();
    assert.equal(t.messages.length, 2);
    assert.equal(t.messages[0].body, "final 0");
    assert.equal((await fetch(`${base}/api/sessions/nope/messages?token=${TOKEN}`)).status, 404);
  });
});

test("serves the assistant's persisted history", async () => {
  await withServer(async (base) => {
    const h = await (await fetch(`${base}/api/assistant/messages?count=5&token=${TOKEN}`)).json();
    assert.equal(h.messages.length, 2);
    assert.equal(h.messages[0].body, "final 0");
  });
});

test("POST /api/input forwards text and target to submitInput", async () => {
  await withServer(async (base, calls) => {
    await fetch(`${base}/api/input?token=${TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello", target: "payments" }) });
    await fetch(`${base}/api/input?token=${TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi assistant" }) });
    assert.deepEqual(calls.inputs, [{ text: "hello", target: "payments" }, { text: "hi assistant" }]);
    assert.equal((await fetch(`${base}/api/input?token=${TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
  });
});

test("WS upgrade requires the token and receives broadcasts", async () => {
  await withServer(async (base, _calls, bus) => {
    const wsUrl = base.replace("http", "ws");
    await assert.rejects(new Promise((resolve, reject) => { const s = new WebSocket(`${wsUrl}/ws`); s.on("open", resolve); s.on("error", reject); }));
    const got = await new Promise<string>((resolve, reject) => {
      const s = new WebSocket(`${wsUrl}/ws?token=${TOKEN}`);
      s.on("open", () => setTimeout(() => bus.broadcast({ type: "message", body: "live!", at: 1 }), 20));
      s.on("message", (data) => { resolve(String(data)); s.close(); });
      s.on("error", reject);
    });
    assert.deepEqual(JSON.parse(got), { type: "message", body: "live!", at: 1 });
  });
});
