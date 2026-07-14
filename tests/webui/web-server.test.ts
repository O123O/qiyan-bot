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
  listFinals: (_e, _t, count, before) => {
    const all = Array.from({ length: 2 }, (_, i) => ({ id: `f${i}`, endpointId: "local", threadId: "t1", turnId: `turn-${i}`, itemId: `it${i}`, completedAt: 1000 + i, itemOrder: 0, body: `final ${i}`, terminalStatus: "completed" }));
    const older = all.filter((m) => before === undefined || m.completedAt <= before); // inclusive cursor
    return older.slice(Math.max(0, older.length - count));
  },
  listOwnerConversation: (before, limit) => {
    const convo = [{ id: "s1", role: "you" as const, body: "hi there", at: 500 }, { id: "f0", role: "assistant" as const, body: "final 0", at: 1000 }, { id: "f1", role: "assistant" as const, body: "final 1", at: 1001 }];
    const older = convo.filter((m) => before === undefined || m.at <= before); // inclusive cursor
    return older.slice(Math.max(0, older.length - limit));
  },
  provider: () => "codex",
};

async function withServer(run: (base: string, calls: { inputs: Array<{ text: string; target?: string }> }, bus: WebBus, uploadsDir: string) => Promise<void>): Promise<void> {
  const bus = new WebBus();
  const calls = { inputs: [] as Array<{ text: string; target?: string }> };
  const staticDir = await mkdtemp(join(tmpdir(), "qiyan-webui-"));
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>ok</title>");
  const uploadsDir = await mkdtemp(join(tmpdir(), "qiyan-webui-up-"));
  const server = createWebServer({
    host: "127.0.0.1", port: 0, allowLan: false, token: TOKEN, staticDir, bus, reads,
    files: { projectDir: () => undefined, maxFileBytes: 1024 },
    uploads: { dir: uploadsDir, maxBytes: 1024, ttlMs: 1e9 },
    submitInput: async (text, target) => { calls.inputs.push({ text, ...(target ? { target } : {}) }); return { ok: true }; },
    report: () => {},
  });
  const { url } = await server.start();
  const base = url.slice(0, url.indexOf("/?"));
  try { await run(base, calls, bus, uploadsDir); } finally { await server.stop(); }
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

test("serves the assistant's persisted two-sided history, merged by time", async () => {
  await withServer(async (base) => {
    const h = await (await fetch(`${base}/api/assistant/messages?limit=5&token=${TOKEN}`)).json();
    // user prompt @500 sorts before the agent finals @1000/@1001
    assert.deepEqual(h.messages, [
      { id: "s1", role: "you", body: "hi there", at: 500 },
      { id: "f0", role: "assistant", body: "final 0", at: 1000 },
      { id: "f1", role: "assistant", body: "final 1", at: 1001 },
    ]);
    assert.equal(h.hasOlder, false);
  });
});

test("paginates older messages with an inclusive before cursor (no same-ms skip)", async () => {
  await withServer(async (base) => {
    const page1 = await (await fetch(`${base}/api/assistant/messages?limit=2&token=${TOKEN}`)).json();
    assert.deepEqual(page1.messages.map((m: { body: string }) => m.body), ["final 0", "final 1"]);
    assert.equal(page1.hasOlder, true); // a full page came back ⇒ maybe older
    const oldest = page1.messages[0].at; // 1000
    // Inclusive cursor re-returns the boundary row "final 0" (the client dedups it by id) so nothing
    // sharing the boundary millisecond is skipped; the older "hi there" is reachable.
    const page2 = await (await fetch(`${base}/api/assistant/messages?limit=2&before=${oldest}&token=${TOKEN}`)).json();
    assert.deepEqual(page2.messages.map((m: { body: string }) => m.body), ["hi there", "final 0"]);
    assert.deepEqual(page2.messages.map((m: { id: string }) => m.id), ["s1", "f0"]);
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

test("SPA fallback serves routes but 404s file-extension paths", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/some-route?token=${TOKEN}`)).status, 200);   // route → SPA
    assert.equal((await fetch(`${base}/home/x/notes.md?token=${TOKEN}`)).status, 404); // file path → not the SPA
  });
});

test("streams a raw upload with a browser Content-Type and blocks traversal", async () => {
  await withServer(async (base, _calls, _bus, uploadsDir) => {
    await writeFile(join(uploadsDir, "page.html"), "<h1>hi</h1>");
    const r = await fetch(`${base}/api/upload/raw?path=page.html&token=${TOKEN}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(r.headers.get("content-security-policy"), "sandbox"); // scripts neutered
    assert.equal(await r.text(), "<h1>hi</h1>");
    // basename() collapses traversal → not found in the store
    assert.equal((await fetch(`${base}/api/upload/raw?path=../../etc/passwd&token=${TOKEN}`)).status, 404);
    assert.equal((await fetch(`${base}/api/upload/raw?path=page.html`)).status, 401); // still token-gated
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
