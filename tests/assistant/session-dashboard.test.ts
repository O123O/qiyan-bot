import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RegistryDocument } from "../../src/registry/session-registry.ts";
import { SessionDashboard, writeDashboardAtomic } from "../../src/assistant/session-dashboard.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { RuntimeStore } from "../../src/storage/runtime-store.ts";
import { SessionDashboardStore } from "../../src/storage/session-dashboard-store.ts";

async function fixture(options: { existing?: string; assistantRoot?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-dashboard-"));
  const path = join(root, "session-status.json");
  if (options.existing !== undefined) await writeFile(path, options.existing);
  const db = createTestDatabase();
  const store = new SessionDashboardStore(db);
  const runtime = new RuntimeStore(db);
  runtime.setSession("local", "thread-1", "managed", "idle");
  let document: RegistryDocument = {
    version: 2,
    assistant: { endpoint: "assistant-local", thread_id: "manager", project_dir: options.assistantRoot ?? root },
    sessions: { payments: { endpoint: "local", thread_id: "thread-1", project_dir: "/projects/payments" } },
  };
  const registry = { snapshot: () => structuredClone(document) };
  const dashboard = new SessionDashboard(store, registry, runtime, { root, path });
  return { root, path, db, store, runtime, registry, dashboard, rename: (nickname: string) => {
    const session = document.sessions.payments!;
    document = { ...document, sessions: { [nickname]: session } };
  } };
}

test("creates and atomically renders a missing version-2 dashboard as mode 0400", async () => {
  const value = await fixture();
  await value.dashboard.initializeAndRender();
  const document = JSON.parse(await readFile(value.path, "utf8"));
  assert.equal(document.version, 2);
  assert.equal(document.sessions.payments.identity.thread_id, "thread-1");
  assert.equal(document.sessions.payments.auto_session_info.last_sent, null);
  assert.equal(document.sessions.payments.auto_session_info.token_usage, null);
  assert.equal(document.sessions.payments.manager_notes.updated_at, null);
  assert.equal((await stat(value.path)).mode & 0o777, 0o400);
});

test("rejects invalid existing dashboards without replacing their bytes", async () => {
  const invalid = await fixture({ existing: "not json" });
  await assert.rejects(invalid.dashboard.initializeAndRender(), /invalid assistant dashboard/);
  assert.equal(await readFile(invalid.path, "utf8"), "not json");
});

test("validates and claims the canonical assistant root before inspecting migration input", async () => {
  const value = await fixture({ existing: "not json", assistantRoot: "/wrong" });
  await assert.rejects(value.dashboard.initializeAndRender(), /assistant.*workdir/);
  assert.equal(await readFile(value.path, "utf8"), "not json");
  assert.equal((value.db.prepare("SELECT assistant_root FROM session_dashboard_meta WHERE singleton = 1").get() as any).assistant_root, null);

  const claimed = await fixture();
  claimed.store.claimAssistantRoot(claimed.root);
  (claimed.registry as any).snapshot = () => ({
    version: 2,
    assistant: { endpoint: "assistant-local", thread_id: "manager", project_dir: "/different" },
    sessions: {},
  });
  await assert.rejects(claimed.dashboard.initializeAndRender(), /assistant.*workdir/);
});

test("rename changes only the rendered key while stable notes remain", async () => {
  const value = await fixture();
  value.store.updateNotes({ endpointId: "local", threadId: "thread-1" }, "op", { project_summary: "Payments" }, 100);
  await value.dashboard.initializeAndRender();
  value.rename("billing");
  value.store.markDirty();
  await value.dashboard.renderIfDirty();
  const sessions = JSON.parse(await readFile(value.path, "utf8")).sessions;
  assert.equal(sessions.payments, undefined);
  assert.equal(sessions.billing.manager_notes.project_summary, "Payments");
});

test("render failures remain dirty, warn once per episode, and retry", async () => {
  const value = await fixture();
  let fail = true;
  const dashboard = new SessionDashboard(value.store, value.registry, value.runtime, {
    root: value.root,
    path: value.path,
    writer: async (path, bytes) => {
      if (fail) throw new Error("private filesystem detail");
      await writeDashboardAtomic(path, bytes);
    },
  });
  await assert.rejects(dashboard.initializeAndRender(), /dashboard render failed/);
  assert.equal(value.store.renderState().dirty, true);
  assert.equal(value.store.renderState().failureGeneration, 1);
  value.store.markRenderFailed("dashboard render failed");
  assert.equal(value.store.renderState().failureGeneration, 1);
  fail = false;
  await dashboard.renderIfDirty();
  assert.equal(value.store.renderState().dirty, false);
  assert.equal(value.store.renderState().lastError, null);
});

test("a mutation during filesystem IO remains dirty for a second serialized render", async () => {
  const value = await fixture();
  let release!: () => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const dashboard = new SessionDashboard(value.store, value.registry, value.runtime, {
    root: value.root,
    path: value.path,
    writer: async (path, bytes) => {
      calls += 1;
      if (calls === 1) { started(); await blocked; }
      await writeDashboardAtomic(path, bytes);
    },
  });
  const first = dashboard.initializeAndRender();
  await began;
  value.store.updateNotes({ endpointId: "local", threadId: "thread-1" }, "op", { project_summary: "new" }, 2_000);
  release();
  await first;
  assert.equal(value.store.renderState().dirty, true);
  await Promise.all([dashboard.renderIfDirty(), dashboard.renderIfDirty()]);
  assert.equal(value.store.renderState().dirty, false);
  assert.equal(JSON.parse(await readFile(value.path, "utf8")).sessions.payments.manager_notes.project_summary, "new");
});

test("rejects a special-file dashboard path", async () => {
  const value = await fixture();
  await symlink("target", value.path);
  await assert.rejects(value.dashboard.initializeAndRender(), /regular file/);
  assert.equal((await lstat(value.path)).isSymbolicLink(), true);
  await chmod(value.root, 0o700);
});
