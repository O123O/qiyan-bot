import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { AttachmentStore } from "../../src/attachments/store.ts";
import { AppError } from "../../src/core/errors.ts";
import { createTestDatabase } from "../../src/storage/database.ts";

async function fixture(overrides: { maxFileBytes?: number; maxStoreBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "codex-bot-files-"));
  let now = 1_000;
  const db = createTestDatabase();
  const store = new AttachmentStore(db, root, {
    maxFileBytes: overrides.maxFileBytes ?? 8,
    maxStoreBytes: overrides.maxStoreBytes ?? 20,
    ttlMs: 100,
    clock: { now: () => now },
  });
  await store.initialize();
  return { root, db, store, advance: (ms: number) => { now += ms; } };
}

test("streams bytes into randomized mode-0600 files and ignores false size metadata", async () => {
  const { store } = await fixture();
  const saved = await store.ingest("ctx", Readable.from([Buffer.from("abc"), Buffer.from("def")]), {
    displayName: "../bad\u0000name.txt", mediaType: "text/plain", declaredSize: 1,
  });
  assert.match(saved.id, /^file_[a-f0-9-]+$/);
  assert.equal(saved.displayName, "badname.txt");
  assert.equal(saved.size, 6);
  assert.equal(saved.sha256, "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721");
  assert.equal((await lstat(store.pathForTesting(saved.id))).mode & 0o777, 0o600);

  await assert.rejects(
    store.ingest("ctx", Readable.from([Buffer.alloc(9)]), { displayName: "large", mediaType: "application/octet-stream" }),
    (error: unknown) => error instanceof AppError && error.code === "ATTACHMENT_INVALID",
  );
});

test("enforces per-message and total quotas before retaining partial files", async () => {
  const { store } = await fixture({ maxFileBytes: 10, maxStoreBytes: 7 });
  await store.ingest("one", Readable.from([Buffer.alloc(5)]), { displayName: "one", mediaType: "x" });
  await assert.rejects(store.ingest("two", Readable.from([Buffer.alloc(3)]), { displayName: "two", mediaType: "x" }));
  await assert.rejects(store.ingestMany("three", [
    { stream: Readable.from([Buffer.alloc(6)]), displayName: "a", mediaType: "x" },
    { stream: Readable.from([Buffer.alloc(6)]), displayName: "b", mediaType: "x" },
  ], 10));
  assert.equal(store.totalBytes(), 5);
});

test("opaque handles are scope-bound and materialize as app-server inputs", async () => {
  const { store } = await fixture();
  const image = await store.ingest("ctx", Readable.from(["img"]), { displayName: "x.png", mediaType: "image/png" });
  assert.deepEqual(store.toUserInput("ctx", image.id), { type: "localImage", path: store.pathForTesting(image.id) });
  assert.throws(() => store.toUserInput("other", image.id), (error: unknown) => error instanceof AppError && error.code === "ATTACHMENT_INVALID");
  store.retain("ctx", image.id);
  store.release("ctx", image.id);
});

test("expiry removes only unreferenced attachments", async () => {
  const { store, advance } = await fixture();
  const kept = await store.ingest("ctx", Readable.from(["a"]), { displayName: "a", mediaType: "x" });
  const removed = await store.ingest("ctx", Readable.from(["b"]), { displayName: "b", mediaType: "x" });
  store.retain("ctx", kept.id);
  advance(101);
  assert.equal(await store.cleanupExpired(), 1);
  assert.equal(await readFile(store.pathForTesting(kept.id), "utf8"), "a");
  await assert.rejects(readFile(store.pathForTesting(removed.id)));
});

test("project-relative outbound preparation rejects traversal and symlinks, then snapshots bytes", async () => {
  const { root, store } = await fixture();
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "report.txt"), "report");
  await symlink(join(project, "report.txt"), join(project, "link.txt"));
  await assert.rejects(store.prepareOutbound("ctx", project, "../escape"));
  await assert.rejects(store.prepareOutbound("ctx", project, "link.txt"));
  const handle = await store.prepareOutbound("ctx", project, "report.txt", "report.txt", "text/plain");
  await writeFile(join(project, "report.txt"), "changed");
  assert.equal(await readFile(store.pathForTesting(handle.id), "utf8"), "report");
  await chmod(store.pathForTesting(handle.id), 0o600);
});

test("openForUpload holds a descriptor to the private regular file and enforces scope", async () => {
  const { store } = await fixture();
  const saved = await store.ingest("ctx", Readable.from(["abc"]), { displayName: "a.txt", mediaType: "text/plain" });
  const upload = await store.openForUpload("ctx", saved.id);
  const chunks: Buffer[] = [];
  for await (const chunk of upload.stream) chunks.push(Buffer.from(chunk));
  await upload.close();
  assert.equal(Buffer.concat(chunks).toString(), "abc");
  await assert.rejects(store.openForUpload("other", saved.id));
});

test("turn references retain attachments exactly once until terminal release", async () => {
  const { db, store } = await fixture();
  const saved = await store.ingest("ctx", Readable.from(["abc"]), { displayName: "a.txt", mediaType: "text/plain" });
  store.retainForTurn("local", "thread", "turn", "ctx", [saved.id]);
  store.retainForTurn("local", "thread", "turn", "ctx", [saved.id]);
  assert.equal((db.prepare("SELECT ref_count FROM attachments WHERE id = ?").get(saved.id) as any).ref_count, 1);
  store.releaseTurn("local", "thread", "turn");
  store.releaseTurn("local", "thread", "turn");
  assert.equal((db.prepare("SELECT ref_count FROM attachments WHERE id = ?").get(saved.id) as any).ref_count, 0);
});
