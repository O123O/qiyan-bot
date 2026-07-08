import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionRegistry, type MappingLifecycleState, type RegistrySession } from "../../src/registry/session-registry.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-bot-registry-"));
  const path = join(dir, "sessions.json");
  const registry = await SessionRegistry.open(path, {
    version: 3,
    assistant: { endpoint: "local", thread_id: "assistant", project_dir: dir },
    sessions: {},
  });
  return { dir, path, registry };
}

function worker(dir: string, mappingId: string, threadId = "t1", lifecycleState: MappingLifecycleState = "adopting"): RegistrySession {
  return {
    endpoint: "local",
    thread_id: threadId,
    project_dir: dir,
    mapping_id: mappingId,
    lifecycle_state: lifecycleState,
  };
}

test("reserves, promotes, and renames one immutable mapping generation", async () => {
  const { dir, path, registry } = await fixture();
  const reserved = worker(dir, "mapping-1");
  await registry.reserve("payments", reserved);
  assert.equal(registry.managedSnapshot().sessions.payments, undefined);
  await registry.promote("payments", reserved);
  await registry.rename("payments", "billing", reserved);
  assert.deepEqual(registry.get("billing"), { ...reserved, lifecycle_state: "managed" });
  assert.equal(JSON.parse(await readFile(path, "utf8")).sessions.billing.mapping_id, "mapping-1");
});

test("reserve compares nickname and native thread identity before writing", async () => {
  const { dir, registry } = await fixture();
  await registry.reserve("payments", worker(dir, "mapping-1"));
  await assert.rejects(() => registry.reserve("payments", worker(dir, "mapping-2", "t2")));
  await assert.rejects(() => registry.reserve("other", worker(dir, "mapping-3", "t1")));
});

test("transitions and removals compare the exact mapping generation", async () => {
  const { dir, registry } = await fixture();
  const old = worker(dir, "mapping-old");
  await registry.reserve("payments", old);
  await registry.promote("payments", old);
  await assert.rejects(() => registry.transition("payments", worker(dir, "wrong"), "unadopting"));
  await registry.transition("payments", old, "unadopting");
  assert.equal(registry.get("payments")?.lifecycle_state, "unadopting");
  assert.equal(await registry.removeIfMatch("payments", worker(dir, "wrong")), false);
  assert.equal(await registry.removeIfMatch("payments", old), true);

  const replacement = worker(dir, "mapping-new", "t2");
  await registry.reserve("payments", replacement);
  assert.equal(await registry.removeIfMatch("payments", old), false);
  assert.equal(registry.get("payments")?.mapping_id, "mapping-new");
});

test("invalid startup registry is quarantined and replaced without activating corrupt mappings", async () => {
  const { dir, path } = await fixture();
  await writeFile(path, "{broken", "utf8");
  const registry = await SessionRegistry.open(path, {
    version: 3,
    assistant: { endpoint: "local", thread_id: "assistant", project_dir: dir },
    sessions: {},
  });
  assert.deepEqual(registry.snapshot().sessions, {});
  assert.equal(registry.warnings().length, 1);
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 3);
});

test("invalid startup registry without a last-known-good snapshot refuses unsafe reset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-bot-registry-corrupt-"));
  const path = join(dir, "sessions.json");
  await writeFile(path, "{broken", "utf8");
  await assert.rejects(SessionRegistry.open(path, {
    version: 3,
    assistant: { endpoint: "local", thread_id: "pending", project_dir: dir },
    sessions: {},
  }), /no valid last-known-good/);
});

test("concurrent reservations preserve both unique mappings", async () => {
  const { dir, registry } = await fixture();
  await Promise.all([
    registry.reserve("one", worker(dir, "mapping-1", "t1")),
    registry.reserve("two", worker(dir, "mapping-2", "t2")),
  ]);
  assert.deepEqual(Object.keys(registry.snapshot().sessions).sort(), ["one", "two"]);
});

test("updates the assistant identity atomically after first app-server start", async () => {
  const { dir, path, registry } = await fixture();
  await registry.setAssistant({ endpoint: "local", thread_id: "real-assistant", project_dir: dir });
  assert.equal(registry.snapshot().assistant.thread_id, "real-assistant");
  assert.equal(JSON.parse(await readFile(path, "utf8")).assistant.thread_id, "real-assistant");
});

test("startup preserves optional assistant and session descriptions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-bot-registry-description-"));
  const path = join(dir, "sessions.json");
  await writeFile(path, JSON.stringify({
    version: 3,
    assistant: { endpoint: "local", thread_id: "assistant", project_dir: dir, description: "manager" },
    sessions: {
      payments: { ...worker(dir, "mapping-1", "t1", "managed"), description: "payments worker" },
    },
  }));
  const registry = await SessionRegistry.open(path, {
    version: 3,
    assistant: { endpoint: "local", thread_id: "pending", project_dir: dir },
    sessions: {},
  });
  assert.equal(registry.snapshot().assistant.description, "manager");
  assert.equal(registry.get("payments")?.description, "payments worker");
});

test("registry v3 preserves normalized transitional paths without touching the live filesystem", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-bot-registry-paths-"));
  const missing = join(dir, "missing-project");
  const replacementTarget = join(dir, "replacement-target");
  const alias = join(dir, "project-alias");
  await mkdir(replacementTarget);
  await symlink(replacementTarget, alias, "dir");
  for (const [name, projectDir] of [["missing", missing], ["alias", alias]] as const) {
    const path = join(dir, `${name}.json`);
    await writeFile(path, JSON.stringify({
      version: 3,
      assistant: { endpoint: "local", thread_id: "assistant", project_dir: dir },
      sessions: { work: worker(projectDir, `mapping-${name}`) },
    }));
    const registry = await SessionRegistry.open(path, {
      version: 3,
      assistant: { endpoint: "local", thread_id: "pending", project_dir: dir },
      sessions: {},
    });
    assert.equal(registry.get("work")?.project_dir, projectDir);
    assert.equal(registry.get("work")?.lifecycle_state, "adopting");
  }
});

test("a version-2 registry is rejected without migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-bot-registry-v2-"));
  const path = join(dir, "sessions.json");
  await writeFile(path, JSON.stringify({
    version: 2,
    assistant: { endpoint: "assistant-local", thread_id: "old", project_dir: dir },
    sessions: {},
  }));
  await assert.rejects(SessionRegistry.open(path, {
    version: 3,
    assistant: { endpoint: "assistant-local", thread_id: "pending", project_dir: dir },
    sessions: {},
  }), /no valid last-known-good/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2);
});
