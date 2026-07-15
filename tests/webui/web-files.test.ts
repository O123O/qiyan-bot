import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browse, createEntry, resolvePath, type WebFilesDeps } from "../../src/webui/web-files.ts";
import { stat } from "node:fs/promises";

async function fixture(): Promise<{ deps: WebFilesDeps; root: string; outside: string }> {
  const base = await mkdtemp(join(tmpdir(), "qiyan-webfiles-"));
  const root = join(base, "project");
  const outside = join(base, "secret");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "README.md"), "# hello\n");
  await writeFile(join(root, "src", "app.ts"), "export const x = 1;\n");
  await writeFile(join(root, "logo.bin"), Buffer.from([1, 2, 0, 3, 255]));
  await writeFile(outside, "TOP SECRET\n");
  await symlink(outside, join(root, "escape")); // symlink pointing OUTSIDE the project
  return { deps: { projectDir: (n) => (n === "proj" ? root : undefined), fileTarget: (n) => (n === "proj" ? { transport: "local", projectDir: root } : undefined), maxFileBytes: 1024 }, root, outside };
}

test("lists a directory (dirs first) and reads a text file confined to the project", async () => {
  const { deps } = await fixture();
  const dir = await browse(deps, "proj", "");
  assert.ok("kind" in dir && dir.kind === "dir");
  // `escape` is a symlink → reported as "other", never a traversable dir.
  assert.deepEqual(dir.entries, [
    { name: "src", type: "dir" }, { name: "README.md", type: "file" }, { name: "escape", type: "other" }, { name: "logo.bin", type: "file" },
  ]);
  assert.deepEqual(await browse(deps, "proj", "src/app.ts"), { kind: "file", path: "src/app.ts", content: "export const x = 1;\n", truncated: false, encoding: "utf-8" });
});

test("serves a binary file as base64", async () => {
  const { deps } = await fixture();
  const file = await browse(deps, "proj", "logo.bin");
  assert.ok("kind" in file && file.kind === "file");
  assert.equal(file.encoding, "base64");
  assert.equal(Buffer.from(file.content, "base64").length, 5);
});

test("REJECTS every escape from the project root", async () => {
  const { deps, outside } = await fixture();
  // Non-existent and escaping paths both resolve to a safe refusal (confine requires the real path
  // to exist AND stay inside the project root).
  assert.deepEqual(await browse(deps, "proj", "../secret"), { error: "path not allowed" });     // traversal
  assert.deepEqual(await browse(deps, "proj", "src/../../secret"), { error: "path not allowed" });
  assert.deepEqual(await browse(deps, "proj", outside), { error: "path not allowed" });          // absolute
  assert.deepEqual(await browse(deps, "proj", "/etc/passwd"), { error: "path not allowed" });
  assert.deepEqual(await browse(deps, "proj", "escape"), { error: "path not allowed" });          // symlink → outside
  assert.deepEqual(await browse(deps, "proj", "nope"), { error: "path not allowed" });            // non-existent
  assert.deepEqual(await browse(deps, "other", ""), { error: "unknown session" });                // unknown root
});

test("reads a file whose name starts with .. (not treated as an escape)", async () => {
  const { deps, root } = await fixture();
  await writeFile(join(root, "..env"), "SECRET=1\n");
  assert.deepEqual(await browse(deps, "proj", "..env"), { kind: "file", path: "..env", content: "SECRET=1\n", truncated: false, encoding: "utf-8" });
  assert.equal(resolvePath(undefined, join(root, "..env")), join(root, "..env")); // absolute returned as-is
  assert.ok("error" in (await browse(deps, "proj", "../secret"))); // a real traversal is still rejected by BROWSE
});

test("createEntry creates confined files/dirs and rejects escapes / duplicates", async () => {
  const { deps, root } = await fixture();
  assert.deepEqual(await createEntry(deps, "proj", "src/new.ts", "file"), { ok: true, path: "src/new.ts" });
  assert.ok(await stat(join(root, "src/new.ts")).then(() => true));
  assert.deepEqual(await createEntry(deps, "proj", "newdir", "dir"), { ok: true, path: "newdir" });
  assert.ok("error" in (await createEntry(deps, "proj", "../evil.ts", "file"))); // traversal parent
  assert.ok("error" in (await createEntry(deps, "proj", "src/app.ts", "file"))); // already exists
  assert.ok("error" in (await createEntry(deps, "proj", "..", "dir")));          // bad name
});

test("resolvePath returns absolute paths as-is (owner-only preview) and relative paths under the session root", async () => {
  const { root, outside } = await fixture();
  // An absolute path is returned as-is, even OUTSIDE any project root — the OS's read permission,
  // enforced when the file is streamed, is the boundary (not a path allowlist). This is the preview
  // policy; browse/git stay confined (see the browse tests above).
  assert.equal(resolvePath(undefined, join(root, "src/app.ts")), join(root, "src/app.ts"));
  assert.equal(resolvePath(undefined, outside), outside);
  assert.equal(resolvePath(undefined, "/etc/passwd"), "/etc/passwd");
  // relative paths join under the session root
  assert.equal(resolvePath(root, "src/app.ts"), join(root, "src/app.ts"));
  assert.equal(resolvePath(undefined, "src/app.ts"), undefined); // relative with no session → unresolved
});
