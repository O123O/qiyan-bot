import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CoordinatorNotebook } from "../../src/coordinator/notebook.ts";

test("bootstraps a missing notebook from the example", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-bot-notebook-"));
  const example = join(dir, "example.json");
  const live = join(dir, "session-status.json");
  await writeFile(example, '{"version":1,"sessions":{}}\n');
  const notebook = await CoordinatorNotebook.bootstrap(live, example);
  assert.deepEqual(notebook.snapshot(), { version: 1, sessions: {} });
  assert.equal(JSON.parse(await readFile(live, "utf8")).version, 1);
});

test("reconciles a nickname by stable thread id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-bot-notebook-"));
  const example = join(dir, "example.json");
  const live = join(dir, "session-status.json");
  await writeFile(example, '{"version":1,"sessions":{}}');
  await writeFile(live, '{"version":1,"sessions":{"old":{"thread_id":"t1","project_status":"working","updated_at":"now"}}}');
  const notebook = await CoordinatorNotebook.bootstrap(live, example);
  await notebook.reconcileNicknames(new Map([["t1", "new"]]));
  assert.equal(notebook.snapshot().sessions.new?.thread_id, "t1");
  assert.equal(notebook.snapshot().sessions.old, undefined);
});

test("invalid live JSON is quarantined and recreated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-bot-notebook-"));
  const example = join(dir, "example.json");
  const live = join(dir, "session-status.json");
  await writeFile(example, '{"version":1,"sessions":{}}');
  await writeFile(live, "invalid");
  const notebook = await CoordinatorNotebook.bootstrap(live, example);
  assert.deepEqual(notebook.snapshot().sessions, {});
});
