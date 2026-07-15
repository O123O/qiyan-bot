import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readWebUiEnabled, webUiStatePath, writeWebUiEnabled } from "../../src/webui/webui-state.ts";

test("state file: absent ⇒ true; atomic write round-trips; corrupt/wrong-shape ⇒ throw", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-webui-state-"));
  const path = webUiStatePath(dir);
  assert.equal(path, join(dir, "webui.json"));

  assert.equal(readWebUiEnabled(path), true, "absent ⇒ default enabled (preserves WEB_UI=1 behavior)");

  writeWebUiEnabled(path, false);
  assert.equal(readWebUiEnabled(path), false);
  const raw = await readFile(path, "utf8");
  assert.equal(JSON.parse(raw).enabled, false);

  writeWebUiEnabled(path, true);
  assert.equal(readWebUiEnabled(path), true);

  await writeFile(path, "not json at all");
  assert.throws(() => readWebUiEnabled(path), "garbage ⇒ throw (caller keeps current state, never fail-open)");

  await writeFile(path, JSON.stringify({ enabled: "yes" }));
  assert.throws(() => readWebUiEnabled(path), "non-boolean enabled ⇒ throw");

  await writeFile(path, JSON.stringify({ other: 1 }));
  assert.throws(() => readWebUiEnabled(path), "missing enabled ⇒ throw");
});

test("write leaves no temp file behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-webui-state-"));
  writeWebUiEnabled(webUiStatePath(dir), true);
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir);
  assert.deepEqual(entries, ["webui.json"], "atomic rename removed the temp file");
});
