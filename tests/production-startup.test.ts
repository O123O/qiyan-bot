import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { BotConfig } from "../src/config.ts";
import { assistantAccessWarning, buildProductionApp } from "../src/production-app.ts";
import type { ChatAdapter } from "../src/chat/contracts.ts";

test("only full-access assistant mode emits the structural startup warning", () => {
  assert.match(assistantAccessWarning("danger-full-access") ?? "", /non-interactively with full filesystem access/);
  assert.equal(assistantAccessWarning("workspace-write"), undefined);
  assert.equal(assistantAccessWarning("read-only"), undefined);
});

test("production prepares the configured assistant workdir before endpoint startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-production-workdir-"));
  const workdir = join(root, "external-assistant");
  const dataDir = join(root, "backend-data");
  const registryPath = join(root, "backend-registry", "sessions.json");
  const policyAsset = fileURLToPath(new URL("../assets/assistant/AGENTS.md", import.meta.url));
  const changedDirectories: string[] = [];
  const config: BotConfig = {
    qiyanHome: join(root, "qiyan-home"),
    chat: {
      primary: "telegram",
      telegram: { token: "test-token", ownerId: 42, destinationChatId: 42 },
    },
    userHome: root,
    assistantWorkdir: workdir,
    dataDir,
    sessionRegistryPath: registryPath,
    codexBinary: join(root, "missing-codex"),
    maxConcurrentTurns: 1,
    maxCollectCount: 20,
    mcpHost: "127.0.0.1",
    mcpPort: 0,
    attachmentMaxBytes: 1024,
    attachmentStoreMaxBytes: 4096,
    assistantSandboxMode: "danger-full-access",
  };
  await mkdir(config.qiyanHome, { mode: 0o700 });
  const app = await buildProductionApp(config, { chdir: (path) => { changedDirectories.push(path); } });
  await assert.rejects(app.start());
  await app.stop();

  assert.equal(await readFile(join(workdir, "AGENTS.md"), "utf8"), await readFile(policyAsset, "utf8"));
  assert.match(await readFile(join(workdir, ".qiyan-bot-agents.sha256"), "utf8"), /^[a-f0-9]{64}\n$/u);
  assert.deepEqual(JSON.parse(await readFile(join(workdir, "session-status.json"), "utf8")), { version: 2, sessions: {} });
  assert.deepEqual(JSON.parse(await readFile(join(workdir, "assistant-context.json"), "utf8")), {
    version: 2,
    user_home: await realpath(root),
    qiyan_home: await realpath(config.qiyanHome),
    default_projects_root: join(await realpath(root), "qiyan-projects"),
  });
  assert.deepEqual(changedDirectories, [await realpath(workdir)]);
  assert.equal((await stat(join(workdir, "assistant-context.json"))).mode & 0o777, 0o400);
  assert.equal(JSON.parse(await readFile(registryPath, "utf8")).assistant.project_dir, await realpath(workdir));
  for (const path of [
    join(dataDir, "assistant-profile"),
    join(dataDir, "assistant-profile/home"),
    join(dataDir, "assistant-profile/codex"),
  ]) assert.equal((await stat(path)).mode & 0o777, 0o700);
  const db = new DatabaseSync(join(dataDir, "bot.sqlite3"), { readOnly: true });
  const warnings = db.prepare("SELECT body FROM deliveries WHERE id = 'assistant-full-access-warning'").all();
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]!.body), /non-interactively with full filesystem access/);
  db.close();
});

test("production initializes exactly the configured Telegram, Slack, and WeChat adapters and cleans all on later failure", async () => {
  for (const mode of ["telegram", "slack", "dual", "weixin", "triple"] as const) {
    const root = await mkdtemp(join(tmpdir(), `qiyan-bot-production-${mode}-`));
    const initialized: string[] = [];
    const closed: string[] = [];
    const fake = (id: "telegram" | "slack" | "weixin"): ChatAdapter => ({
      delivery: { id, sendMessage: async () => ({ ok: true }) },
      ...(id === "slack" ? {
        primaryBinding: { adapterId: "slack", conversationKey: "slack:T1:dm:D1", destination: { workspaceId: "T1", channelId: "D1" } },
      } : id === "weixin" ? {
        primaryBinding: { adapterId: "weixin", conversationKey: "weixin:g:owner", destination: { generationId: "g", botId: "bot", ownerUserId: "owner" } },
      } : {}),
      initialize: async () => { initialized.push(id); },
      start: async () => undefined,
      stop: async () => undefined,
      close: async () => { closed.push(id); },
    } as ChatAdapter);
    const adapters = mode === "telegram" ? [fake("telegram")]
      : mode === "slack" ? [fake("slack")]
        : mode === "weixin" ? [fake("weixin")]
          : mode === "dual" ? [fake("telegram"), fake("slack")]
            : [fake("telegram"), fake("slack"), fake("weixin")];
    const telegram = mode === "telegram" || mode === "dual" || mode === "triple"
      ? { token: "test-token", ownerId: 42, destinationChatId: 42 } : undefined;
    const slack = mode === "slack" || mode === "dual" || mode === "triple"
      ? { appToken: "xapp-test", botToken: "xoxb-test", userToken: "xoxp-test", ownerUserId: "U1" } : undefined;
    const weixin = mode === "weixin" || mode === "triple" ? { configured: true as const } : undefined;
    const config: BotConfig = {
      qiyanHome: join(root, "qiyan-home"),
      chat: {
        primary: mode === "telegram" || mode === "dual" || mode === "triple" ? "telegram" : mode,
        ...(telegram ? { telegram } : {}), ...(slack ? { slack } : {}), ...(weixin ? { weixin } : {}),
      },
      userHome: root,
      assistantWorkdir: join(root, "workdir"),
      dataDir: join(root, "data"),
      sessionRegistryPath: join(root, "data", "sessions.json"),
      codexBinary: join(root, "missing-codex"),
      maxConcurrentTurns: 1,
      maxCollectCount: 20,
      mcpHost: "127.0.0.1",
      mcpPort: 0,
      attachmentMaxBytes: 1024,
      attachmentStoreMaxBytes: 4096,
      assistantSandboxMode: "read-only",
    };
    await mkdir(config.qiyanHome, { mode: 0o700 });
    const app = await buildProductionApp(config, { chdir: () => undefined, chatAdapters: adapters });
    await assert.rejects(app.start());
    assert.deepEqual(initialized.sort(), adapters.map((adapter) => adapter.delivery.id).sort());
    assert.deepEqual(closed.sort(), adapters.map((adapter) => adapter.delivery.id).sort());
  }
});
