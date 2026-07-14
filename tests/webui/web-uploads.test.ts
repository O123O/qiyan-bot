import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupUploads, storeUpload, type WebUploadsConfig } from "../../src/webui/web-uploads.ts";

async function config(): Promise<WebUploadsConfig> {
  return { dir: await mkdtemp(join(tmpdir(), "qiyan-uploads-")), maxBytes: 1024, ttlMs: 30 * 24 * 60 * 60 * 1000 };
}

test("stores a file under a sanitized unique name inside the store dir", async () => {
  const cfg = await config();
  const stored = await storeUpload(cfg, "../../etc/pass  wd.txt", Buffer.from("hello"), 1_700_000_000_000);
  assert.ok("path" in stored);
  // name is sanitized (no traversal, no spaces) and lives inside the store dir
  assert.ok(stored.path.startsWith(cfg.dir + "/"));
  assert.doesNotMatch(stored.path.slice(cfg.dir.length), /\.\.|\s/);
  assert.equal(await readFile(stored.path, "utf8"), "hello");
});

test("rejects empty and oversized files", async () => {
  const cfg = await config();
  assert.deepEqual(await storeUpload(cfg, "a.txt", Buffer.alloc(0), 1), { error: "empty file" });
  assert.deepEqual(await storeUpload(cfg, "a.txt", Buffer.alloc(2048), 1), { error: "file exceeds the size limit" });
});

test("cleanup deletes only files older than the TTL", async () => {
  const cfg = await config();
  const fresh = await storeUpload(cfg, "fresh.txt", Buffer.from("f"), 1_700_000_000_000);
  const old = await storeUpload(cfg, "old.txt", Buffer.from("o"), 1_700_000_000_000);
  assert.ok("path" in old && "path" in fresh);
  const now = 1_700_000_000_000 + cfg.ttlMs;
  await utimes(old.path, new Date(now - cfg.ttlMs - 1000), new Date(now - cfg.ttlMs - 1000)); // just past TTL
  const removed = await cleanupUploads(cfg, now);
  assert.equal(removed, 1);
  assert.deepEqual((await readdir(cfg.dir)).length, 1); // the fresh one remains
});
