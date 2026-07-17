import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SessionDashboard } from "../src/assistant/session-dashboard.ts";
import { SessionDashboardStore } from "../src/storage/session-dashboard-store.ts";
import { SessionControlStore } from "../src/storage/session-control-store.ts";
import { createTestDatabase } from "../src/storage/database.ts";

test("fresh QiYan runtime has no incompatible-state migration surface", async () => {
  await assert.rejects(access(resolve("src/assistant/profile-migration.ts")));
  const sources = await Promise.all([
    "src/assistant/identity.ts",
    "src/assistant/session-dashboard.ts",
    "src/assistant/dashboard-schema.ts",
    "src/storage/session-dashboard-store.ts",
  ].map((path) => readFile(resolve(path), "utf8")));
  for (const source of sources) {
    assert.doesNotMatch(source, /LegacyNotebook|legacyEndpointId|legacyMigrationComplete|importLegacy/u);
  }
  const columns = createTestDatabase().prepare("PRAGMA table_info(session_dashboard_meta)").all().map((row) => row.name);
  assert.equal(columns.includes("legacy_migration_complete"), false);
});

test("a version-1 dashboard is rejected without changing its bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-fresh-dashboard-"));
  const path = join(root, "session-status.json");
  const source = '{"version":1,"sessions":{}}\n';
  await writeFile(path, source);
  const db = createTestDatabase();
  const dashboard = new SessionDashboard(
    new SessionDashboardStore(db),
    { managedSnapshot: () => ({
      version: 3 as const,
      assistant: { endpoint: "assistant-local", thread_id: "pending", project_dir: root },
      sessions: {},
    }) },
    new SessionControlStore(db),
    { root, path },
  );
  await assert.rejects(dashboard.initializeAndRender(), /invalid assistant dashboard/);
  assert.equal(await readFile(path, "utf8"), source);
});
