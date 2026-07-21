import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BotConfig } from "../../src/config.ts";
import type { ChatAdapter } from "../../src/chat-apps/shared/contracts.ts";
import { buildProductionApp } from "../../src/production-app.ts";
import { webUiStatePath, writeWebUiState } from "../../src/webui/webui-state.ts";

// Real end-to-end: builds the full production app (real codex assistant app-server) with the web UI
// enabled via saved state, and drives the web HTTP/WS surface. RUN_WEBUI_INTEGRATION=1 (needs codex
// auth on the host).
const enabled = process.env.RUN_WEBUI_INTEGRATION === "1";

function fakeSlackAdapter(): ChatAdapter {
  return {
    primaryBinding: { adapterId: "slack", conversationKey: "slack:T:dm:D", destination: { workspaceId: "T", channelId: "D" } },
    delivery: { id: "slack", sendMessage: async () => ({ ok: true }) },
    async initialize() {}, start() {}, async stop() {}, async close() {},
  };
}

test("the web UI serves live bot state and enforces the token", { skip: !enabled, timeout: 120_000 }, async (t) => {
  const userHome = process.env.HOME!;
  const root = await mkdtemp(join(tmpdir(), "qiyan-webui-int-"));
  const dataDir = join(root, "data");
  await mkdir(join(dataDir, "assistant-profile", "codex"), { recursive: true, mode: 0o700 });
  const authTarget = join(dataDir, "assistant-profile", "codex", "auth.json");
  await copyFile(join(userHome, ".qiyan-bot", "data", "assistant-profile", "codex", "auth.json"), authTarget);
  await chmod(authTarget, 0o600);
  await mkdir(join(root, "qiyan-home"), { recursive: true, mode: 0o700 });
  writeWebUiState(webUiStatePath(join(root, "qiyan-home")), { enabled: true }); // web UI is off by default; turn it on

  const config: BotConfig = {
    qiyanHome: join(root, "qiyan-home"),
    chat: { primary: "slack", slack: { appToken: "xapp-x", botToken: "xoxb-x", userToken: "xoxp-x", ownerUserId: "U1" } },
    userHome, assistantWorkdir: join(root, "assistant"), dataDir,
    sessionRegistryPath: join(dataDir, "sessions.json"), endpointCatalogPath: join(root, "qiyan-home", "endpoints.json"),
    codexBinary: "codex", maxCollectCount: 20, mcpHost: "127.0.0.1", mcpPort: 0,
    attachmentMaxBytes: 1024 * 1024, attachmentStoreMaxBytes: 8 * 1024 * 1024, assistantSandboxMode: "read-only",
    webUi: { host: "127.0.0.1", port: 0 },
  };

  let webUrl = "";
  const app = await buildProductionApp(config, {
    chdir: () => undefined,
    chatAdapters: [fakeSlackAdapter()],
    onOperationalEvent: () => undefined,
    requestRestart: () => { throw new Error("no restart in test"); },
    testing: { holdAssistantScheduler: true, onWebUiStarted: (url) => { webUrl = url; } },
  });
  await app.start();
  t.after(() => app.stop());

  assert.match(webUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?token=.+/u, "web UI announced its URL with a token");
  const base = webUrl.slice(0, webUrl.indexOf("/?"));
  const token = new URL(webUrl).searchParams.get("token")!;

  assert.equal((await fetch(`${base}/api/sessions`)).status, 401, "token required");
  const sessions = await fetch(`${base}/api/sessions?token=${token}`);
  assert.equal(sessions.status, 200);
  assert.ok(Array.isArray((await sessions.json()).sessions), "serves the (empty) session list from the real registry");
  assert.equal((await fetch(`${base}/?token=${token}`)).status, 200, "serves the client");
});
