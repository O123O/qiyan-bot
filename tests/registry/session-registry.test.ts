import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionRegistry } from "../../src/registry/session-registry.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-bot-registry-"));
  const path = join(dir, "sessions.json");
  const registry = await SessionRegistry.open(path, {
    version: 2,
    assistant: { endpoint: "local", thread_id: "assistant", project_dir: dir },
    sessions: {},
  });
  return { dir, path, registry };
}

test("registers and renames a session atomically", async () => {
  const { dir, path, registry } = await fixture();
  await registry.register("payments", { endpoint: "local", thread_id: "t1", project_dir: dir });
  await registry.rename("payments", "billing");
  assert.equal(registry.get("billing")?.thread_id, "t1");
  assert.equal(JSON.parse(await readFile(path, "utf8")).sessions.billing.thread_id, "t1");
});

test("rejects nickname and thread collisions", async () => {
  const { dir, registry } = await fixture();
  await registry.register("payments", { endpoint: "local", thread_id: "t1", project_dir: dir });
  await assert.rejects(() => registry.register("payments", { endpoint: "local", thread_id: "t2", project_dir: dir }));
  await assert.rejects(() => registry.register("other", { endpoint: "local", thread_id: "t1", project_dir: dir }));
});

test("invalid external replacement preserves last known-good state", async () => {
  const { path, registry } = await fixture();
  await writeFile(path, "{broken", "utf8");
  assert.equal(await registry.reload(), false);
  assert.equal(registry.snapshot().version, 2);
});

test("invalid startup registry is quarantined and replaced without activating corrupt mappings", async () => {
  const { dir, path } = await fixture();
  await writeFile(path, "{broken", "utf8");
  const registry = await SessionRegistry.open(path, {
    version: 2,
    assistant: { endpoint: "local", thread_id: "assistant", project_dir: dir },
    sessions: {},
  });
  assert.deepEqual(registry.snapshot().sessions, {});
  assert.equal(registry.warnings().length, 1);
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2);
});

test("invalid startup registry without a last-known-good snapshot refuses unsafe reset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-bot-registry-corrupt-"));
  const path = join(dir, "sessions.json");
  await writeFile(path, "{broken", "utf8");
  await assert.rejects(SessionRegistry.open(path, {
    version: 2,
    assistant: { endpoint: "local", thread_id: "assistant", project_dir: dir },
    sessions: {},
  }), /no valid last-known-good/);
});

test("external replacement is activated only after asynchronous mapping validation", async () => {
  const { dir, path, registry } = await fixture();
  await writeFile(path, JSON.stringify({
    version: 2,
    assistant: { endpoint: "local", thread_id: "assistant", project_dir: dir },
    sessions: { payments: { endpoint: "local", thread_id: "t1", project_dir: dir } },
  }));
  assert.equal(await registry.reload(async () => { throw new Error("thread cwd mismatch"); }), false);
  assert.equal(registry.get("payments"), undefined);
  assert.equal(await registry.reload(async () => undefined), true);
  assert.equal(registry.get("payments")?.thread_id, "t1");
});

test("concurrent writes preserve both unique registrations", async () => {
  const { dir, registry } = await fixture();
  await Promise.all([
    registry.register("one", { endpoint: "local", thread_id: "t1", project_dir: dir }),
    registry.register("two", { endpoint: "local", thread_id: "t2", project_dir: dir }),
  ]);
  assert.deepEqual(Object.keys(registry.snapshot().sessions).sort(), ["one", "two"]);
});

test("updates the assistant identity atomically after first app-server start", async () => {
  const { dir, path, registry } = await fixture();
  await registry.setAssistant({ endpoint: "local", thread_id: "real-assistant", project_dir: dir });
  assert.equal(registry.snapshot().assistant.thread_id, "real-assistant");
  assert.equal(JSON.parse(await readFile(path, "utf8")).assistant.thread_id, "real-assistant");
});

test("a version-1 registry is rejected without migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-bot-registry-v1-"));
  const path = join(dir, "sessions.json");
  await writeFile(path, JSON.stringify({
    version: 1,
    assistant: { endpoint: "assistant-local", thread_id: "old", project_dir: dir },
    sessions: {},
  }));
  await assert.rejects(SessionRegistry.open(path, {
    version: 2,
    assistant: { endpoint: "assistant-local", thread_id: "pending", project_dir: dir },
    sessions: {},
  }), /no valid last-known-good/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1);
});
