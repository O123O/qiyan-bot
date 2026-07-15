import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readWebUiState, webUiStatePath, writeWebUiState } from "../../src/webui/webui-state.ts";

test("state: absent ⇒ {enabled:false}; enabled+host+port round-trip; corrupt/wrong-shape ⇒ throw", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-webui-state-"));
  const path = webUiStatePath(dir);
  assert.equal(path, join(dir, "webui.json"));

  assert.deepEqual(readWebUiState(path), { enabled: false }, "absent ⇒ off by default");

  writeWebUiState(path, { enabled: true });
  assert.deepEqual(readWebUiState(path), { enabled: true }, "no host/port persisted when unset");

  writeWebUiState(path, { enabled: true, host: "0.0.0.0", port: 9520 });
  assert.deepEqual(readWebUiState(path), { enabled: true, host: "0.0.0.0", port: 9520 });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { enabled: true, host: "0.0.0.0", port: 9520 });

  writeWebUiState(path, { enabled: false, port: 4180 });
  assert.deepEqual(readWebUiState(path), { enabled: false, port: 4180 }, "host omitted, port kept");

  await writeFile(path, "not json at all");
  assert.throws(() => readWebUiState(path), "garbage ⇒ throw (caller keeps current state, never fail-open)");
  await writeFile(path, JSON.stringify({ enabled: "yes" }));
  assert.throws(() => readWebUiState(path), "non-boolean enabled ⇒ throw");
  await writeFile(path, JSON.stringify({ other: 1 }));
  assert.throws(() => readWebUiState(path), "missing enabled ⇒ throw");
  await writeFile(path, JSON.stringify({ enabled: true, port: "9520" }));
  assert.throws(() => readWebUiState(path), "non-integer port ⇒ throw");
  await writeFile(path, JSON.stringify({ enabled: true, port: 99999 }));
  assert.throws(() => readWebUiState(path), "out-of-range port ⇒ throw");
  await writeFile(path, JSON.stringify({ enabled: true, host: 5 }));
  assert.throws(() => readWebUiState(path), "non-string host ⇒ throw");
});

test("write is atomic and leaves no temp file behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-webui-state-"));
  writeWebUiState(webUiStatePath(dir), { enabled: true, host: "127.0.0.1", port: 9520 });
  assert.deepEqual(await readdir(dir), ["webui.json"], "atomic rename removed the temp file");
});
