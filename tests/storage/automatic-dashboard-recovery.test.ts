import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { installConversationRoutingGuards } from "../../src/storage/conversation-cutover.ts";
import { openStateDatabaseWithAutomaticRecovery } from "../../src/storage/automatic-dashboard-recovery.ts";
import { createTestDatabase, isDatabaseIntegrityFailure, openDatabase } from "../../src/storage/database.ts";
import { acquireDatabaseLease } from "../../src/storage/database-lease.ts";
import { prepareDashboardMetadataRecovery } from "../../src/storage/dashboard-metadata-recovery.ts";
import { isDashboardMetadataRecoveryRequired, SessionDashboardStore } from "../../src/storage/session-dashboard-store.ts";

test("startup automatically rebuilds invalid dashboard metadata under the caller's lease", async (t) => {
  const root = await temporaryDirectory(t);
  const databasePath = join(root, "bot.sqlite3");
  const source = openDatabase(databasePath);
  source.prepare("UPDATE qiyan_state SET state_version = 3 WHERE product = 'qiyan-bot'").run();
  source.prepare("UPDATE conversation_cutover SET phase = 'complete' WHERE singleton = 1").run();
  source.prepare("INSERT INTO session_dashboard_facts(endpoint_id, thread_id) VALUES ('local', 'preserved-thread')").run();
  source.prepare("DELETE FROM session_dashboard_meta").run();
  installConversationRoutingGuards(source);
  source.close();

  const lease = await acquireDatabaseLease(databasePath);
  try {
    let recoveryRequests = 0;
    const opened = await openStateDatabaseWithAutomaticRecovery(databasePath, {
      dashboardStoreOptions: {
        onMetadataRecoveryRequired: () => { recoveryRequests += 1; },
      },
    });
    assert.equal(opened.recovered, true);
    assert.equal(recoveryRequests, 0, "startup validation and automatic repair do not request a runtime restart");
    opened.dashboardStore.assertMetadataHealthy();
    assert.equal(opened.database.prepare("SELECT COUNT(*) AS count FROM session_dashboard_facts WHERE thread_id = 'preserved-thread'").get()!.count, 1);
    opened.database.prepare("DELETE FROM session_dashboard_meta").run();
    assert.throws(() => opened.dashboardStore.renderState(), (error: unknown) => isDashboardMetadataRecoveryRequired(error));
    assert.throws(() => opened.dashboardStore.markDirty(), (error: unknown) => isDashboardMetadataRecoveryRequired(error));
    assert.equal(recoveryRequests, 1, "the returned runtime store requests recovery once after later corruption");
    opened.database.close();
  } finally {
    await lease.release();
  }
});

test("startup never recreates a missing canonical database after interrupted recovery", async (t) => {
  const root = await temporaryDirectory(t);
  const databasePath = join(root, "bot.sqlite3");
  const source = openDatabase(databasePath);
  source.prepare("UPDATE qiyan_state SET state_version = 3 WHERE product = 'qiyan-bot'").run();
  source.prepare("UPDATE conversation_cutover SET phase = 'complete' WHERE singleton = 1").run();
  installConversationRoutingGuards(source);
  source.close();

  const prepared = await prepareDashboardMetadataRecovery(databasePath);
  const manifestPath = join(prepared.quarantinePath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, state: "installing" })}\n`, { mode: 0o600 });
  const displaced = join(prepared.quarantinePath, "displaced");
  await mkdir(displaced, { mode: 0o700 });
  await rename(databasePath, join(displaced, "bot.sqlite3"));

  await assert.rejects(openStateDatabaseWithAutomaticRecovery(databasePath), /incomplete automatic recovery/u);
  await assert.rejects(access(databasePath));
});

test("terminal recovery history rejects empty and symlinked canonical artifacts", async (t) => {
  for (const kind of ["empty", "symlink"] as const) {
    const value = await completedRecoveryFixture(t);
    if (kind === "empty") await writeFile(value.databasePath, "");
    else {
      await rm(value.databasePath);
      await symlink(join(value.root, "missing-target.sqlite3"), value.databasePath);
    }

    await assert.rejects(openStateDatabaseWithAutomaticRecovery(value.databasePath), /incomplete automatic recovery/u);
    if (kind === "empty") assert.equal((await stat(value.databasePath)).size, 0);
    else await assert.rejects(access(join(value.root, "missing-target.sqlite3")));
  }
});

test("terminal recovery history rejects a structurally incomplete manifest", async (t) => {
  const value = await completedRecoveryFixture(t);
  const manifestPath = join(value.quarantinePath, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify({
    version: 1,
    canonical_basename: "bot.sqlite3",
    state: "installed",
  })}\n`, { mode: 0o600 });

  await assert.rejects(openStateDatabaseWithAutomaticRecovery(value.databasePath), /incomplete automatic recovery/u);
});

test("startup never repairs an unrelated open failure", async () => {
  const unrelated = new AppError("CONFIGURATION_ERROR", "unrelated storage failure");
  let recoveries = 0;
  await assert.rejects(openStateDatabaseWithAutomaticRecovery("/not-opened", {
    openDatabase: () => { throw unrelated; },
    recoverDatabase: async () => { recoveries += 1; },
  }), (error: unknown) => error === unrelated);
  assert.equal(recoveries, 0);
});

test("startup never repairs a healthy database when inspection cleanup fails", async (t) => {
  const root = await temporaryDirectory(t);
  const databasePath = join(root, "bot.sqlite3");
  openDatabase(databasePath).close();
  let recoveries = 0;

  await assert.rejects(openStateDatabaseWithAutomaticRecovery(databasePath, {
    openDatabase: (path) => openDatabase(path, {
      closeInspector: () => { throw new Error("private cleanup detail"); },
    }),
    recoverDatabase: async () => { recoveries += 1; },
  }), (error: unknown) => {
    assert.equal(isDatabaseIntegrityFailure(error), false);
    assert.doesNotMatch(error instanceof Error ? error.message : "", /private cleanup detail/u);
    return true;
  });
  assert.equal(recoveries, 0);
});

test("startup attempts automatic metadata recovery only once and closes each rejected database", async () => {
  const databases = [createTestDatabase(), createTestDatabase()];
  for (const database of databases) database.prepare("DELETE FROM session_dashboard_meta").run();
  let opens = 0;
  let recoveries = 0;
  await assert.rejects(openStateDatabaseWithAutomaticRecovery("/test/bot.sqlite3", {
    openDatabase: () => databases[opens++]!,
    recoverDatabase: async () => { recoveries += 1; },
  }), (error: unknown) => isDashboardMetadataRecoveryRequired(error));
  assert.equal(opens, 2);
  assert.equal(recoveries, 1);
  for (const database of databases) assert.throws(() => new SessionDashboardStore(database).assertMetadataHealthy());
});

async function temporaryDirectory(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-automatic-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function completedRecoveryFixture(t: TestContext): Promise<{
  root: string;
  databasePath: string;
  quarantinePath: string;
}> {
  const root = await temporaryDirectory(t);
  const databasePath = join(root, "bot.sqlite3");
  const source = openDatabase(databasePath);
  source.prepare("UPDATE qiyan_state SET state_version = 3 WHERE product = 'qiyan-bot'").run();
  source.prepare("UPDATE conversation_cutover SET phase = 'complete' WHERE singleton = 1").run();
  source.prepare("DELETE FROM session_dashboard_meta").run();
  installConversationRoutingGuards(source);
  source.close();
  const opened = await openStateDatabaseWithAutomaticRecovery(databasePath);
  opened.database.close();
  const quarantinePath = (await readdir(root)).find((name) => name.startsWith(".bot.sqlite3.recovery-"));
  assert.ok(quarantinePath);
  return { root, databasePath, quarantinePath: join(root, quarantinePath) };
}
