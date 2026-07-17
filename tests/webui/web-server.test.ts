import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { WebBus } from "../../src/webui/web-bus.ts";
import { createWebServer } from "../../src/webui/web-server.ts";
import { assistantTranscript, workerDeliveryNickname, type WebReadsDeps } from "../../src/webui/web-reads.ts";
import type { WebGoalControlInput } from "../../src/webui/web-goal-control.ts";

const TOKEN = "test-token-abc";

const reads: WebReadsDeps = {
  nativeSession: () => ({ availability: "ready", status: "idle", activeTurnId: null, endpointGeneration: 1, lifecycleRevision: 1, receiveSequence: 1, observedAt: 1 }),
  registrySnapshot: () => ({ version: 3, assistant: { endpoint: "assistant-local", thread_id: "a", project_dir: "/a", mapping_id: "m", lifecycle_state: "managed" }, sessions: {
    payments: { endpoint: "local", thread_id: "t1", project_dir: "/p", mapping_id: "m1", lifecycle_state: "managed" },
  } } as never),
  dashboardSnapshot: () => ({ version: 3, sessions: {
    payments: { identity: { thread_id: "t1", endpoint: "local", project_dir: "/p" }, auto_session_info: { last_sent: null, last_worker_event: null, model: { current: "gpt-5", pending: null }, reasoning_effort: { current: "high", pending: null }, token_usage: null, goal: { objective: "ship it", status: "active", token_budget: null }, observed_at: null }, manager_notes: {} },
  } } as never),
  assistantSession: () => ({
    nickname: "assistant", mappingId: "assistant-mapping", endpoint: "assistant-local", provider: "codex",
    projectDir: "/a", lifecycleState: "managed", nativeStatus: "active", activeTurnId: "assistant-turn",
    model: "gpt-5.4", effort: "xhigh", host: "test-host", goal: null,
  }),
  readWorkerTurns: async () => ({ turns: [
    { id: "turn-0", status: "completed", startedAt: 0.999, completedAt: 1, items: [
      { type: "userMessage", id: "u0", clientId: "client-u0", content: [{ type: "text", text: "do the thing" }] },
      { type: "agentMessage", id: "a0", text: "final 0", phase: "final_answer" },
    ] },
    { id: "turn-1", status: "completed", startedAt: 1.0005, completedAt: 1.001, items: [
      { type: "agentMessage", id: "a1", text: "final 1", phase: "final_answer" },
    ] },
  ] }),
  listOwnerConversation: (before, limit) => {
    const convo = [{ id: "s1", role: "you" as const, body: "hi there", at: 500 }, { id: "f0", role: "assistant" as const, body: "final 0", at: 1000 }, { id: "f1", role: "assistant" as const, body: "final 1", at: 1001 }];
    const older = convo.filter((m) => before === undefined || m.at <= before); // inclusive cursor
    return older.slice(Math.max(0, older.length - limit));
  },
  provider: () => "codex",
  host: () => "test-host",
};

interface ServerCalls {
  inputs: Array<{ text: string; target?: string; clientInputId?: string }>;
  goals: WebGoalControlInput[];
}

async function withServer(
  run: (base: string, calls: ServerCalls, bus: WebBus, uploadsDir: string) => Promise<void>,
  readsOverride: WebReadsDeps = reads,
): Promise<void> {
  const bus = new WebBus();
  const calls: ServerCalls = { inputs: [], goals: [] };
  const staticDir = await mkdtemp(join(tmpdir(), "qiyan-webui-"));
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>ok</title>");
  const uploadsDir = await mkdtemp(join(tmpdir(), "qiyan-webui-up-"));
  const server = createWebServer({
    host: "127.0.0.1", port: 0, token: TOKEN, staticDir, bus, reads: readsOverride,
    files: { projectDir: () => undefined, fileTarget: () => undefined, maxFileBytes: 1024 },
    uploads: { dir: uploadsDir, maxBytes: 1024, ttlMs: 1e9 },
    submitInput: async (text, target, clientInputId) => { calls.inputs.push({ text, ...(target ? { target } : {}), ...(clientInputId ? { clientInputId } : {}) }); return { ok: true, ...(clientInputId ? { clientUserMessageId: `to:web:${clientInputId}` } : {}) }; },
    controlGoal: async (input) => { calls.goals.push(input); return { ok: true }; },
    openGoalAdmission: () => {}, closeGoalAdmission: () => {}, waitForGoalControls: async () => {},
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
    host: "127.0.0.1", port: 0, token: TOKEN, staticDir, bus, reads,
    files: { projectDir: () => undefined, fileTarget: () => undefined, maxFileBytes: 1024 },
    submitInput: async () => ({ ok: true }), controlGoal: async () => ({ ok: true }),
    openGoalAdmission: () => {}, closeGoalAdmission: () => {}, waitForGoalControls: async () => {}, report: () => {},
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

test("server shutdown closes goal admission and drains an admitted goal request", async () => {
  const bus = new WebBus();
  const staticDir = await mkdtemp(join(tmpdir(), "qiyan-webui-"));
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>ok</title>");
  let release!: () => void;
  let active!: Promise<void>;
  let activeDone!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const events: string[] = [];
  const server = createWebServer({
    host: "127.0.0.1", port: 0, token: TOKEN, staticDir, bus, reads,
    files: { projectDir: () => undefined, fileTarget: () => undefined, maxFileBytes: 1024 },
    submitInput: async () => ({ ok: true }),
    controlGoal: async () => {
      events.push("goal:start");
      active = new Promise<void>((resolve) => { activeDone = resolve; });
      await held;
      events.push("goal:done");
      activeDone();
      return { ok: true };
    },
    openGoalAdmission: () => { events.push("admission:open"); },
    closeGoalAdmission: () => { events.push("admission:close"); },
    waitForGoalControls: async () => { events.push("goal:wait"); await active; events.push("goal:drained"); },
    report: () => {},
  });
  const { url } = await server.start();
  const base = url.slice(0, url.indexOf("/?"));
  const request = fetch(`${base}/api/sessions/payments/goal?token=${TOKEN}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: crypto.randomUUID(), action: "pause" }),
  }).catch(() => undefined);
  while (!events.includes("goal:start")) await new Promise<void>((resolve) => setImmediate(resolve));
  let stopped = false;
  const stopping = server.stop().then(() => { stopped = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.deepEqual(events.slice(0, 4), ["admission:open", "goal:start", "admission:close", "goal:wait"]);
  release();
  await stopping;
  await request;
  assert.deepEqual(events.slice(-2), ["goal:done", "goal:drained"]);
});

test("requires the token on every route", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/sessions`)).status, 401);
    assert.equal((await fetch(`${base}/api/sessions?token=wrong`)).status, 401);
    assert.equal((await fetch(`${base}/api/sessions?token=${TOKEN}`)).status, 200);
  });
});

test("serves the session list but never reads worker history without an active subscription", async () => {
  await withServer(async (base) => {
    const list = await (await fetch(`${base}/api/sessions?token=${TOKEN}`)).json();
    assert.deepEqual(list.sessions.map((s: { nickname: string }) => s.nickname), ["payments"]);
    assert.deepEqual(list.assistant, {
      nickname: "assistant", mappingId: "assistant-mapping", endpoint: "assistant-local", provider: "codex",
      projectDir: "/a", lifecycleState: "managed", nativeStatus: "active", activeTurnId: "assistant-turn",
      model: "gpt-5.4", effort: "xhigh", host: "test-host", goal: null,
    });
    assert.equal(list.sessions[0].mappingId, "m1");
    assert.equal(list.sessions[0].provider, "codex");
    assert.equal(list.sessions[0].model, "gpt-5");
    assert.equal(list.sessions[0].effort, "high");
    assert.equal(list.sessions[0].host, "test-host");
    assert.deepEqual(list.sessions[0].goal, { objective: "ship it", status: "active" });

    assert.equal((await fetch(`${base}/api/sessions/payments/messages?count=5&token=${TOKEN}`)).status, 409);
    assert.equal((await fetch(`${base}/api/sessions/nope/messages?token=${TOKEN}`)).status, 409);
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

test("derives persisted worker presentation only from trusted delivery kinds and keeps routing separate", () => {
  assert.equal(workerDeliveryNickname("worker_final", "[payments] shipped"), "payments");
  assert.equal(workerDeliveryNickname("collection", "[retired · failed] old result"), "retired");
  assert.equal(workerDeliveryNickname("assistant_final", "[payments] text QiYan wrote"), undefined);
  assert.equal(workerDeliveryNickname("worker_warning", "[payments] warning"), undefined);

  const page = assistantTranscript({
    ...reads,
    listOwnerConversation: () => [
      { id: "current", role: "assistant", body: "[payments] shipped", at: 1, deliveryKind: "worker_final" },
      { id: "old", role: "assistant", body: "[retired] archived", at: 2, deliveryKind: "collection" },
      { id: "qiyan", role: "assistant", body: "[payments] this is QiYan", at: 3, deliveryKind: "assistant_final" },
    ],
  }, 10);
  assert.deepEqual(page.messages, [
    { id: "current", role: "assistant", body: "[payments] shipped", at: 1, worker: "payments", origin: "payments" },
    { id: "old", role: "assistant", body: "[retired] archived", at: 2, worker: "retired" },
    { id: "qiyan", role: "assistant", body: "[payments] this is QiYan", at: 3 },
  ]);
});

test("legacy queue acknowledgements are absent from the Web transcript", () => {
  const page = assistantTranscript({
    ...reads,
    listOwnerConversation: () => [
      { id: "you", role: "you", body: "status?", at: 1 },
      { id: "queued:web:1", role: "assistant", body: "[system] queued", at: 2, deliveryKind: "queue_notice" },
      { id: "reply", role: "assistant", body: "working", at: 3, deliveryKind: "assistant_final" },
    ],
  }, 10);

  assert.deepEqual(page.messages.map((message) => message.id), ["you", "reply"]);
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
    const clientInputId = crypto.randomUUID();
    const sent = await (await fetch(`${base}/api/input?token=${TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello", target: "payments", clientInputId }) })).json();
    await fetch(`${base}/api/input?token=${TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi assistant" }) });
    assert.deepEqual(sent, { ok: true, clientUserMessageId: `to:web:${clientInputId}` });
    assert.deepEqual(calls.inputs, [{ text: "hello", target: "payments", clientInputId }, { text: "hi assistant" }]);
    assert.equal((await fetch(`${base}/api/input?token=${TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "missing id", target: "payments" }) })).status, 400);
    assert.equal((await fetch(`${base}/api/input?token=${TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "bad id", target: "payments", clientInputId: "not-a-uuid" }) })).status, 400);
    assert.equal((await fetch(`${base}/api/input?token=${TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
  });
});

test("POST /api/sessions/:nickname/goal strictly validates and dispatches path-authoritative goal controls", async () => {
  await withServer(async (base, calls) => {
    const setId = crypto.randomUUID();
    const set = await fetch(`${base}/api/sessions/payments/goal?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: setId, action: "set", objective: "  ship the release  " }),
    });
    assert.equal(set.status, 200);
    const pauseId = crypto.randomUUID();
    assert.equal((await fetch(`${base}/api/sessions/payments/goal?token=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: pauseId, action: "pause" }),
    })).status, 200);
    assert.deepEqual(calls.goals, [
      { requestId: setId, nickname: "payments", action: "set", objective: "ship the release" },
      { requestId: pauseId, nickname: "payments", action: "pause" },
    ]);

    const invalid = [
      { requestId: "not-a-uuid", action: "pause" },
      { requestId: crypto.randomUUID(), action: "set", objective: "" },
      { requestId: crypto.randomUUID(), action: "set", objective: "x".repeat(16_001) },
      { requestId: crypto.randomUUID(), action: "pause", objective: "not allowed" },
      { requestId: crypto.randomUUID(), action: "unknown" },
      { requestId: crypto.randomUUID(), action: "cancel", nickname: "other-authority" },
      { requestId: crypto.randomUUID(), action: "cancel", extra: true },
    ];
    for (const body of invalid) {
      const response = await fetch(`${base}/api/sessions/payments/goal?token=${TOKEN}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.equal(calls.goals.length, 2, "invalid commands never reach goal control");
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
    host: "127.0.0.1", port: 0, token: TOKEN, staticDir, bus, reads,
    files: { projectDir: () => undefined, maxFileBytes: 4096, fileTarget: (n) => (n === "rworker" ? { transport: "remote", projectDir: remoteRoot, host: "testhost" } : undefined) },
    remote: () => ({ sshBinary: ssh, sshRuntimeRoot: sshRt }),
    submitInput: async () => ({ ok: true }), controlGoal: async () => ({ ok: true }),
    openGoalAdmission: () => {}, closeGoalAdmission: () => {}, waitForGoalControls: async () => {}, report: () => {},
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
      s.on("message", (data) => {
        const raw = String(data);
        if (JSON.parse(raw).type === "message") { resolve(raw); s.close(); }
      });
      s.on("error", reject);
    });
    assert.deepEqual(JSON.parse(got), { type: "message", body: "live!", at: 1 });
  });
});

test("session snapshots are event-driven and do no work without a WebSocket client", async () => {
  let snapshotReads = 0;
  let notify = () => {};
  const countedReads: WebReadsDeps = {
    ...reads,
    assistantSession: () => { snapshotReads += 1; return reads.assistantSession(); },
    onSessionsChanged: (listener) => { notify = listener; return () => { notify = () => {}; }; },
  };
  await withServer(async (base, _calls, bus) => {
    notify();
    assert.equal(snapshotReads, 0, "an inactive Web UI must not project session state");

    const ws = new WebSocket(`${base.replace("http", "ws")}/ws?token=${TOKEN}`);
    const sessions = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sessions snapshot timed out")), 1_500);
      ws.on("message", (raw) => {
        const event = JSON.parse(String(raw));
        if (event.type === "sessions") { clearTimeout(timer); resolve(); }
      });
      ws.on("error", reject);
    });
    await sessions;
    assert.ok(snapshotReads > 0);

    const second = new WebSocket(`${base.replace("http", "ws")}/ws?token=${TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("second client sessions snapshot timed out")), 1_500);
      second.on("message", (raw) => {
        const event = JSON.parse(String(raw));
        if (event.type === "sessions") { clearTimeout(timer); resolve(); }
      });
      second.on("error", reject);
    });
    ws.close();
    await new Promise<void>((resolve) => ws.once("close", resolve));
    assert.equal(bus.size, 1);
    const readsWithOneClient = snapshotReads;
    notify();
    assert.equal(snapshotReads, readsWithOneClient + 1, "one native event projects one snapshot regardless of client count");

    second.close();
    await new Promise<void>((resolve) => second.once("close", resolve));
    assert.equal(bus.size, 0);
    const readsAfterClose = snapshotReads;
    notify();
    assert.equal(snapshotReads, readsAfterClose, "the last disconnect must stop session projection");
  }, countedReads);
});

test("worker history requires the exact active WS subscription and tab switching invalidates it", async () => {
  await withServer(async (base) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws?token=${TOKEN}`);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const requestId = crypto.randomUUID();
    const ack = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("subscription acknowledgement timed out")), 1_000);
      ws.on("message", (raw) => { const event = JSON.parse(String(raw)); if (event.type === "worker/subscribed") { clearTimeout(timer); resolve(event); } });
    });
    ws.send(JSON.stringify({ type: "worker/subscribe", nickname: "payments", requestId }));
    const subscribed = await ack;
    assert.equal(subscribed.requestId, requestId);
    assert.match(subscribed.subscriptionId, /^[0-9a-f-]{36}$/u);
    assert.equal(subscribed.mappingId, "m1");

    assert.equal((await fetch(`${base}/api/sessions/payments/messages?token=${TOKEN}`)).status, 409);
    const page = await (await fetch(`${base}/api/sessions/payments/messages?subscriptionId=${subscribed.subscriptionId}&token=${TOKEN}`)).json();
    assert.deepEqual(page.messages.map((message: { body: string }) => message.body), ["do the thing", "final 0", "final 1"]);
    assert.deepEqual(page.openTurnIds, []);
    assert.deepEqual(page.terminalTurnIds, ["turn-0", "turn-1"]);

    const newest = await (await fetch(`${base}/api/sessions/payments/messages?limit=2&subscriptionId=${subscribed.subscriptionId}&token=${TOKEN}`)).json();
    assert.deepEqual(newest.messages.map((message: { body: string }) => message.body), ["final 0", "final 1"]);
    assert.equal(newest.hasOlder, true);
    const older = await (await fetch(`${base}/api/sessions/payments/messages?limit=2&before=${encodeURIComponent(newest.nextCursor)}&subscriptionId=${subscribed.subscriptionId}&token=${TOKEN}`)).json();
    assert.deepEqual(older.messages.map((message: { body: string }) => message.body), ["do the thing"]);
    assert.equal(older.hasOlder, false);

    ws.send(JSON.stringify({ type: "worker/unsubscribe", requestId: crypto.randomUUID() }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await fetch(`${base}/api/sessions/payments/messages?subscriptionId=${subscribed.subscriptionId}&token=${TOKEN}`)).status, 409);
    ws.close();
  });
});

test("the QiYan foreground can subscribe to native assistant history", async () => {
  await withServer(async (base) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws?token=${TOKEN}`);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const requestId = crypto.randomUUID();
    const acknowledged = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("assistant subscription timed out")), 1_000);
      ws.on("message", (raw) => {
        const event = JSON.parse(String(raw));
        if (event.type === "worker/subscribed" && event.requestId === requestId) { clearTimeout(timer); resolve(event); }
      });
    });
    ws.send(JSON.stringify({ type: "worker/subscribe", nickname: "assistant", requestId }));
    const subscription = await acknowledged;
    assert.equal(subscription.mappingId, "assistant-mapping");

    const response = await fetch(`${base}/api/sessions/assistant/messages?limit=20&subscriptionId=${subscription.subscriptionId}&token=${TOKEN}`);
    assert.equal(response.status, 200);
    const page = await response.json() as any;
    assert.deepEqual(page.messages.map((message: any) => message.body), ["do the thing", "final 0", "final 1"]);
    ws.close();
  });
});
