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
  readWorkerConversation: async (_e, _t, count, before) => {
    // Two-sided native transcript: a prompt ("you") + the worker's replies ("worker"), merged by time.
    const all = [
      { id: "u:turn-0", turnId: "turn-0", role: "you" as const, body: "do the thing", completedAt: 999, terminalStatus: "" },
      { id: "a:turn-0", turnId: "turn-0", role: "worker" as const, body: "final 0", completedAt: 1000, terminalStatus: "completed" },
      { id: "a:turn-1", turnId: "turn-1", role: "worker" as const, body: "final 1", completedAt: 1001, terminalStatus: "completed" },
    ];
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
    files: { projectDir: () => undefined, fileTarget: () => undefined, maxFileBytes: 1024 },
    uploads: { dir: uploadsDir, maxBytes: 1024, ttlMs: 1e9 },
    submitInput: async (text, target) => { calls.inputs.push({ text, ...(target ? { target } : {}) }); return { ok: true }; },
    report: () => {},
  });
  const { url } = await server.start();
  const base = url.slice(0, url.indexOf("/?"));
  try { await run(base, calls, bus, uploadsDir); } finally { await server.stop(); }
}

test("the server handle is restartable: start → stop → start re-listens and re-serves WS", async () => {
  const bus = new WebBus();
  const staticDir = await mkdtemp(join(tmpdir(), "qiyan-webui-"));
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>ok</title>");
  const server = createWebServer({
    host: "127.0.0.1", port: 0, allowLan: false, token: TOKEN, staticDir, bus, reads,
    files: { projectDir: () => undefined, fileTarget: () => undefined, maxFileBytes: 1024 },
    submitInput: async () => ({ ok: true }), report: () => {},
  });
  const httpBase = (u: string) => u.slice(0, u.indexOf("/?"));

  const first = await server.start();
  assert.equal((await fetch(`${httpBase(first.url)}/api/sessions?token=${TOKEN}`)).status, 200);
  await server.stop();

  const second = await server.start();
  const base2 = httpBase(second.url);
  assert.equal((await fetch(`${base2}/api/sessions?token=${TOKEN}`)).status, 200, "re-listens after a stop");
  // A closed ws.Server can't handleUpgrade — this proves stop()/start() recreated it.
  const ws = new WebSocket(`${base2.replace("http", "ws")}/ws?token=${TOKEN}`);
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  ws.close();
  await server.stop();
});

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
    // Two-sided: the prompt ("you") precedes the worker's replies (no role ⇒ worker output).
    assert.deepEqual(t.messages.map((m: { body: string }) => m.body), ["do the thing", "final 0", "final 1"]);
    assert.equal(t.messages[0].role, "you");
    assert.equal(t.messages[1].role, undefined);
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

test("streams any readable raw file with a browser Content-Type; 404s a nonexistent path; token-gated", async () => {
  await withServer(async (base, _calls, _bus, uploadsDir) => {
    await writeFile(join(uploadsDir, "page.html"), "<h1>hi</h1>");
    const abs = encodeURIComponent(join(uploadsDir, "page.html")); // any readable absolute path (owner-only preview)
    const r = await fetch(`${base}/api/raw?path=${abs}&token=${TOKEN}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(r.headers.get("content-security-policy"), "sandbox"); // scripts neutered
    assert.equal(await r.text(), "<h1>hi</h1>");
    // existence + regular-file are still enforced: a nonexistent path → 404
    assert.equal((await fetch(`${base}/api/raw?path=${encodeURIComponent(join(uploadsDir, "nope.txt"))}&token=${TOKEN}`)).status, 404);
    // de-confinement: a readable file OUTSIDE every project/upload root streams 200 (owner-only preview)
    const outsideDir = await mkdtemp(join(tmpdir(), "qiyan-outside-"));
    await writeFile(join(outsideDir, "notes.txt"), "outside-local\n");
    const o = await fetch(`${base}/api/raw?path=${encodeURIComponent(join(outsideDir, "notes.txt"))}&token=${TOKEN}`);
    assert.equal(o.status, 200);
    assert.equal(await o.text(), "outside-local\n");
    // a CRLF-in-filename download must NOT crash locally (header injection guarded, like remote)
    await writeFile(join(outsideDir, "e\r\nvil.txt"), "x");
    const crlf = await fetch(`${base}/api/raw?path=${encodeURIComponent(join(outsideDir, "e\r\nvil.txt"))}&download=1&token=${TOKEN}`);
    assert.equal(crlf.status, 200);
    assert.doesNotMatch(crlf.headers.get("content-disposition") ?? "", /[\r\n]/);
    assert.equal((await fetch(`${base}/api/raw?path=${abs}`)).status, 401); // still token-gated
  });
});

test("dispatches a remote session's files over ssh (browse + raw stream)", async () => {
  const { mkdtemp, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "qiyan-rsrv-"));
  const ssh = join(dir, "ssh");
  await writeFile(ssh, `#!/bin/bash\nif [ "$1" = "-G" ]; then printf 'hostname localhost\\nuser u\\nport 22\\ncontrolmaster no\\n'; exit 0; fi\ncmd="\${@: -1}"\nexec bash -c "$cmd"\n`);
  await chmod(ssh, 0o755);
  const remoteRoot = await mkdtemp(join(tmpdir(), "qiyan-rroot-"));
  await writeFile(join(remoteRoot, "r.txt"), "remote-bytes\n");
  const sshRt = await mkdtemp(join(tmpdir(), "qiyan-rrt-"));

  const bus = new WebBus();
  const staticDir = await mkdtemp(join(tmpdir(), "qiyan-rstatic-"));
  await writeFile(join(staticDir, "index.html"), "ok");
  const server = createWebServer({
    host: "127.0.0.1", port: 0, allowLan: false, token: TOKEN, staticDir, bus, reads,
    files: { projectDir: () => undefined, maxFileBytes: 4096, fileTarget: (n) => (n === "rworker" ? { transport: "remote", projectDir: remoteRoot, host: "testhost" } : undefined) },
    remote: () => ({ sshBinary: ssh, sshRuntimeRoot: sshRt }),
    submitInput: async () => ({ ok: true }), report: () => {},
  });
  const { url } = await server.start();
  const base = url.slice(0, url.indexOf("/?"));
  try {
    const listing = await (await fetch(`${base}/api/files/rworker?token=${TOKEN}`)).json();
    assert.deepEqual(listing.entries?.map((e: { name: string }) => e.name), ["r.txt"]);
    assert.equal(await (await fetch(`${base}/api/raw?session=rworker&path=r.txt&token=${TOKEN}`)).text(), "remote-bytes\n");
    // Owner-only preview streams ANY readable file over ssh (NOT confined to the project root): an
    // absolute path outside the root is served as-is.
    const outside = join(dir, "outside.txt"); await writeFile(outside, "outside-bytes\n");
    assert.equal(await (await fetch(`${base}/api/raw?session=rworker&path=${encodeURIComponent(outside)}&token=${TOKEN}`)).text(), "outside-bytes\n");
    // a nonexistent path still 404s (regular-file guard)
    assert.equal((await fetch(`${base}/api/raw?session=rworker&path=${encodeURIComponent(join(remoteRoot, "nope.txt"))}&token=${TOKEN}`)).status, 404);
    // a filename with CRLF + download=1 must NOT crash the server (header injection guarded)
    await writeFile(join(remoteRoot, "e\r\nvil.txt"), "x");
    const crlf = await fetch(`${base}/api/raw?session=rworker&path=${encodeURIComponent("e\r\nvil.txt")}&download=1&token=${TOKEN}`);
    assert.equal(crlf.status, 200);
    assert.doesNotMatch(crlf.headers.get("content-disposition") ?? "", /[\r\n]/);
  } finally { await server.stop(); }
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
