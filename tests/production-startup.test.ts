import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { BotConfig } from "../src/config.ts";
import { assistantAccessWarning, buildProductionApp } from "../src/production-app.ts";
import { TOOL_NAMES } from "../src/assistant/tools.ts";
import type { ChatAdapter } from "../src/chat-apps/shared/contracts.ts";
import { StartupPhaseError } from "../src/app.ts";
import { createTestDatabase, openDatabase, type Database } from "../src/storage/database.ts";
import { acquireDatabaseLease, type DatabaseLease } from "../src/storage/database-lease.ts";
import { DashboardMetadataRecoveryRequiredError } from "../src/storage/session-dashboard-store.ts";

test("only full-access assistant mode emits the structural startup warning", () => {
  assert.match(assistantAccessWarning("danger-full-access") ?? "", /non-interactively with full filesystem access/);
  assert.equal(assistantAccessWarning("workspace-write"), undefined);
  assert.equal(assistantAccessWarning("read-only"), undefined);
});

test("production storage contention blocks adapters and the same app retries after release", async (t) => {
  const { config, root } = await productionFixture(t);
  await mkdir(config.dataDir, { mode: 0o700 });
  const held = await acquireDatabaseLease(join(config.dataDir, "bot.sqlite3"));
  let initialized = 0;
  const adapter = fakeTelegramAdapter(() => { initialized += 1; });
  const app = await buildProductionApp(config, { chdir: () => undefined, chatAdapters: [adapter] });

  let firstFailure: unknown;
  try { await app.start(); } catch (error) { firstFailure = error; }
  assert.equal(firstFailure instanceof StartupPhaseError && firstFailure.phase === "storage", true);
  assert.equal(initialized, 0);

  await held.release();
  let secondFailure: unknown;
  try { await app.start(); } catch (error) { secondFailure = error; }
  assert.equal(secondFailure instanceof StartupPhaseError && secondFailure.phase === "endpoint", true);
  assert.equal(initialized, 1);

  const probe = await acquireDatabaseLease(join(root, "data", "bot.sqlite3"));
  await probe.release();
});

test("production repairs dashboard metadata inside one startup lease before adapters", async (t) => {
  const { config } = await productionFixture(t);
  const invalid = createTestDatabase();
  invalid.prepare("DELETE FROM session_dashboard_meta").run();
  const repaired = createTestDatabase();
  const databases = [invalid, repaired];
  const events: string[] = [];
  let leaseAcquisitions = 0;
  let recoveries = 0;
  const app = await buildProductionApp(config, {
    chdir: () => undefined,
    chatAdapters: [fakeTelegramAdapter(() => { events.push("adapter-initialize"); })],
    onOperationalEvent: (event) => { if (event.code === "database_metadata_recovered") events.push(event.code); },
    storage: {
      acquireDatabaseLease: async (path) => {
        leaseAcquisitions += 1;
        return acquireDatabaseLease(path);
      },
      openDatabase: () => {
        events.push("database-open");
        return databases.shift()!;
      },
      closeDatabase: (database) => {
        database.close();
        events.push("database-close");
      },
      recoverDatabase: async () => {
        recoveries += 1;
        assert.throws(() => invalid.prepare("SELECT 1"));
        events.push("database-recover");
      },
    },
  });

  await assert.rejects(app.start(), (error: unknown) => error instanceof StartupPhaseError && error.phase === "endpoint");
  assert.equal(leaseAcquisitions, 1);
  assert.equal(recoveries, 1);
  assert.deepEqual(events.slice(0, 6), [
    "database-open",
    "database-close",
    "database-recover",
    "database-open",
    "database_metadata_recovered",
    "adapter-initialize",
  ]);
  const probe = await acquireDatabaseLease(join(config.dataDir, "bot.sqlite3"));
  await probe.release();
});

test("production requests one restart for runtime metadata loss even when fixed-code reporting throws", async (t) => {
  const { config } = await productionFixture(t);
  const invalid = createTestDatabase();
  invalid.prepare("DELETE FROM session_dashboard_meta").run();
  const repaired = createTestDatabase();
  const databases = [invalid, repaired];
  const events: string[] = [];
  let restarts = 0;
  const app = await buildProductionApp(config, {
    chdir: () => undefined,
    requestRestart: () => { restarts += 1; },
    onOperationalEvent: (event) => {
      events.push(event.code);
      if (event.code === "database_metadata_recovered") {
        repaired.prepare("DELETE FROM session_dashboard_meta").run();
      } else if (event.code === "database_metadata_recovery_required") {
        throw new Error("private operational sink failure");
      }
    },
    storage: {
      openDatabase: () => databases.shift()!,
      recoverDatabase: async () => undefined,
    },
  });

  await assert.rejects(app.start(), (error: unknown) => {
    assert.equal(error instanceof StartupPhaseError && error.phase === "dashboard", true);
    assert.equal(
      error instanceof StartupPhaseError && error.cause instanceof DashboardMetadataRecoveryRequiredError,
      true,
    );
    return true;
  });
  assert.equal(restarts, 1);
  assert.deepEqual(events, ["database_metadata_recovered", "database_metadata_recovery_required"]);
});

test("failed pre-recovery database close retains the lease and never starts recovery", async (t) => {
  const { config } = await productionFixture(t);
  const invalid = createTestDatabase();
  invalid.prepare("DELETE FROM session_dashboard_meta").run();
  let capturedLease: DatabaseLease | undefined;
  let recoveries = 0;
  const app = await buildProductionApp(config, {
    chdir: () => undefined,
    chatAdapters: [fakeTelegramAdapter()],
    storage: {
      acquireDatabaseLease: async (path) => {
        capturedLease = await acquireDatabaseLease(path);
        return capturedLease;
      },
      openDatabase: () => invalid,
      closeDatabase: () => { throw new Error("private close failure"); },
      recoverDatabase: async () => { recoveries += 1; },
    },
  });

  await assert.rejects(app.start(), (error: unknown) => {
    assert.equal(error instanceof StartupPhaseError && error.phase === "storage", true);
    assert.doesNotMatch(error instanceof StartupPhaseError && error.cause instanceof Error ? error.cause.message : "", /private close failure/u);
    return true;
  });
  assert.equal(recoveries, 0);
  await assert.rejects(acquireDatabaseLease(join(config.dataDir, "bot.sqlite3")), /already in use/u);

  invalid.close();
  await capturedLease!.release();
});

test("storage failure closes its database before releasing its attempt-local lease", async (t) => {
  const { config } = await productionFixture(t);
  await mkdir(config.endpointCatalogPath, { mode: 0o700 });
  const events: string[] = [];
  const app = await buildProductionApp(config, {
    chdir: () => undefined,
    storage: {
      closeDatabase: (database) => { database.close(); events.push("database-close"); },
      acquireDatabaseLease: async (path) => {
        const lease = await acquireDatabaseLease(path);
        return {
          release: async () => { await lease.release(); events.push("lease-release"); },
        };
      },
    },
  });

  let failure: unknown;
  try { await app.start(); } catch (error) { failure = error; }
  assert.equal(failure instanceof StartupPhaseError && failure.phase === "storage", true);
  assert.deepEqual(events, ["database-close", "lease-release"]);
  assert.equal((await stat(join(config.dataDir, ".bot.sqlite3.lock"))).isFile(), true);
  const probe = await acquireDatabaseLease(join(config.dataDir, "bot.sqlite3"));
  await probe.release();
});

test("a later missing-Codex failure stops storage in close-before-release order", async (t) => {
  const { config } = await productionFixture(t);
  const events: string[] = [];
  const app = await buildProductionApp(config, {
    chdir: () => undefined,
    chatAdapters: [fakeTelegramAdapter()],
    storage: {
      closeDatabase: (database) => { database.close(); events.push("database-close"); },
      acquireDatabaseLease: async (path) => {
        const lease = await acquireDatabaseLease(path);
        return {
          release: async () => { await lease.release(); events.push("lease-release"); },
        };
      },
    },
  });

  let failure: unknown;
  try { await app.start(); } catch (error) { failure = error; }
  assert.equal(failure instanceof StartupPhaseError && failure.phase === "endpoint", true);
  assert.deepEqual(events, ["database-close", "lease-release"]);
  const probe = await acquireDatabaseLease(join(config.dataDir, "bot.sqlite3"));
  await probe.release();
});

test("storage cleanup failures preserve the startup error and retain exclusion", async (t) => {
  for (const cleanupFailure of ["close", "release"] as const) {
    const { config } = await productionFixture(t);
    await mkdir(config.endpointCatalogPath, { mode: 0o700 });
    let capturedDatabase: Database | undefined;
    let capturedLease: DatabaseLease | undefined;
    const app = await buildProductionApp(config, {
      chdir: () => undefined,
      storage: {
        openDatabase: (path) => {
          capturedDatabase = openDatabase(path);
          return capturedDatabase;
        },
        closeDatabase: (database) => {
          if (cleanupFailure === "close") throw new Error("secret close failure");
          database.close();
        },
        acquireDatabaseLease: async (path) => {
          const lease = await acquireDatabaseLease(path);
          capturedLease = lease;
          return cleanupFailure === "release"
            ? { release: async () => { throw new Error("secret release failure"); } }
            : lease;
        },
      },
    });

    let failure: unknown;
    try { await app.start(); } catch (error) { failure = error; }
    assert.equal(failure instanceof StartupPhaseError && failure.phase === "storage", true);
    assert.doesNotMatch(String(failure instanceof StartupPhaseError ? failure.cause : failure), /secret (?:close|release) failure/u);
    await assert.rejects(acquireDatabaseLease(join(config.dataDir, "bot.sqlite3")), /already in use/u);

    if (cleanupFailure === "close") capturedDatabase!.close();
    await capturedLease!.release();
  }
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
    endpointCatalogPath: join(root, "qiyan-home", "endpoints.json"),
    codexBinary: join(root, "missing-codex"),
    maxCollectCount: 20,
    mcpHost: "127.0.0.1",
    mcpPort: 0,
    attachmentMaxBytes: 1024,
    attachmentStoreMaxBytes: 4096,
    assistantSandboxMode: "danger-full-access",
    webUi: { host: "127.0.0.1", port: 0 },
  };
  await mkdir(config.qiyanHome, { mode: 0o700 });
  const app = await buildProductionApp(config, { chdir: (path) => { changedDirectories.push(path); } });
  await assert.rejects(app.start());
  await app.stop();

  assert.equal(await readFile(join(workdir, "AGENTS.md"), "utf8"), await readFile(policyAsset, "utf8"));
  assert.match(await readFile(join(workdir, ".qiyan-bot-agents.sha256"), "utf8"), /^[a-f0-9]{64}\n$/u);
  assert.deepEqual(JSON.parse(await readFile(join(workdir, "session-status.json"), "utf8")), { version: 3, sessions: {} });
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
      endpointCatalogPath: join(root, "qiyan-home", "endpoints.json"),
      codexBinary: join(root, "missing-codex"),
      maxCollectCount: 20,
      mcpHost: "127.0.0.1",
      mcpPort: 0,
      attachmentMaxBytes: 1024,
      attachmentStoreMaxBytes: 4096,
      assistantSandboxMode: "read-only",
      webUi: { host: "127.0.0.1", port: 0 },
    };
    await mkdir(config.qiyanHome, { mode: 0o700 });
    const app = await buildProductionApp(config, { chdir: () => undefined, chatAdapters: adapters });
    await assert.rejects(app.start());
    assert.deepEqual(initialized.sort(), adapters.map((adapter) => adapter.delivery.id).sort());
    assert.deepEqual(closed.sort(), adapters.map((adapter) => adapter.delivery.id).sort());
  }
});

test("the acceptance hook receives the exact production manager tool map before scheduler startup", async (t) => {
  const { config } = await productionFixture(t);
  let captured: string[] | undefined;
  const app = await buildProductionApp(config, {
    chdir: () => undefined,
    chatAdapters: [fakeTelegramAdapter()],
    testing: {
      onManagerToolsBuilt: (tools) => { captured = Object.keys(tools).sort(); },
    },
  });

  await assert.rejects(app.start(), (error: unknown) => error instanceof StartupPhaseError && error.phase === "endpoint");
  assert.deepEqual(captured, [...TOOL_NAMES].sort());
});

async function productionFixture(t: TestContext): Promise<{ root: string; config: BotConfig }> {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-production-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config: BotConfig = {
    qiyanHome: join(root, "qiyan-home"),
    chat: {
      primary: "telegram",
      telegram: { token: "test-token", ownerId: 42, destinationChatId: 42 },
    },
    userHome: root,
    assistantWorkdir: join(root, "workdir"),
    dataDir: join(root, "data"),
    sessionRegistryPath: join(root, "data", "sessions.json"),
    endpointCatalogPath: join(root, "qiyan-home", "endpoints.json"),
    codexBinary: join(root, "missing-codex"),
    maxCollectCount: 20,
    mcpHost: "127.0.0.1",
    mcpPort: 0,
    attachmentMaxBytes: 1024,
    attachmentStoreMaxBytes: 4096,
    assistantSandboxMode: "read-only",
    webUi: { host: "127.0.0.1", port: 0 },
  };
  await mkdir(config.qiyanHome, { mode: 0o700 });
  return { root, config };
}

function fakeTelegramAdapter(onInitialize: () => void = () => undefined): ChatAdapter {
  return {
    delivery: { id: "telegram", sendMessage: async () => ({ ok: true }) },
    initialize: async () => { onInitialize(); },
    start: async () => undefined,
    stop: async () => undefined,
    close: async () => undefined,
  } as ChatAdapter;
}
