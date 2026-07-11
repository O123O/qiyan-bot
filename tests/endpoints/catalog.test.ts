import assert from "node:assert/strict";
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EndpointCatalog } from "../../src/endpoints/catalog.ts";

async function privateTemp(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qiyan-endpoints-"));
  await import("node:fs/promises").then(({ chmod }) => chmod(root, 0o700));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("bootstraps a private empty endpoint catalog", async (t) => {
  const root = await privateTemp(t);
  const path = join(root, "endpoints.json");
  const catalog = await EndpointCatalog.open(path);
  assert.deepEqual(catalog.snapshot(), { version: 1, endpoints: {} });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, endpoints: {} });
});

test("uses endpoint keys as SSH aliases and defaults the projects root", async (t) => {
  const root = await privateTemp(t);
  const path = join(root, "endpoints.json");
  await writeFile(path, JSON.stringify({ version: 1, endpoints: { devbox: { type: "ssh" } } }), { mode: 0o600 });
  const catalog = await EndpointCatalog.open(path);
  assert.deepEqual(catalog.require("devbox"), { id: "devbox", type: "ssh", projectsRoot: "~/qiyan-projects" });
  assert.throws(() => catalog.require("local"), /built-in endpoint/u);
});

test("recognizes a claude-code endpoint and preserves its type through require", async (t) => {
  const root = await privateTemp(t);
  const path = join(root, "endpoints.json");
  await writeFile(path, JSON.stringify({ version: 1, endpoints: { dfw: { type: "claude-code", projects_root: "/work" } } }), { mode: 0o600 });
  const catalog = await EndpointCatalog.open(path);
  assert.deepEqual(catalog.require("dfw"), { id: "dfw", type: "claude-code", projectsRoot: "/work" });
});

test("rejects unknown fields, unsafe roots, reserved aliases, broad modes, and symlinks", async (t) => {
  const root = await privateTemp(t);
  const path = join(root, "endpoints.json");
  const invalid = async (value: unknown, pattern: RegExp) => {
    await rm(path, { force: true });
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    await assert.rejects(EndpointCatalog.open(path), pattern);
  };
  await invalid({ version: 1, endpoints: { devbox: { type: "ssh", extra: true } } }, /extra/u);
  await invalid({ version: 1, endpoints: { devbox: { type: "docker" } } }, /devbox/u);
  await invalid({ version: 1, endpoints: { devbox: { type: "claude-code", extra: true } } }, /extra/u);
  await invalid({ version: 1, endpoints: { devbox: { type: "ssh", projects_root: "relative" } } }, /projects_root/u);
  await invalid({ version: 1, endpoints: { local: { type: "ssh" } } }, /local/u);
  await rm(path, { force: true });
  await writeFile(path, JSON.stringify({ version: 1, endpoints: {} }), { mode: 0o644 });
  await assert.rejects(EndpointCatalog.open(path), /mode 0600/u);
  await rm(path, { force: true });
  const target = join(root, "target.json");
  await writeFile(target, JSON.stringify({ version: 1, endpoints: {} }), { mode: 0o600 });
  await symlink(target, path);
  await assert.rejects(EndpointCatalog.open(path), /regular owner file/u);
});

test("reload validates changed bytes and preserves the prior snapshot on failure", async (t) => {
  const root = await privateTemp(t);
  const path = join(root, "endpoints.json");
  await writeFile(path, JSON.stringify({ version: 1, endpoints: { one: { type: "ssh", projects_root: "/work" } } }), { mode: 0o600 });
  const catalog = await EndpointCatalog.open(path);
  await writeFile(path, "{", { mode: 0o600 });
  await assert.rejects(catalog.reload(), /invalid endpoint catalog/u);
  assert.equal(catalog.require("one").projectsRoot, "/work");
});

test("rejects oversized, hard-linked, executable, and FIFO catalogs", async (t) => {
  const root = await privateTemp(t);
  const path = join(root, "endpoints.json");
  await writeFile(path, Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(EndpointCatalog.open(path), /exceeds 1 MiB/u);

  await rm(path);
  const target = join(root, "hardlink-target.json");
  await writeFile(target, JSON.stringify({ version: 1, endpoints: {} }), { mode: 0o600 });
  await link(target, path);
  await assert.rejects(EndpointCatalog.open(path), /regular owner file/u);

  await rm(path);
  await writeFile(path, JSON.stringify({ version: 1, endpoints: {} }), { mode: 0o700 });
  await chmod(path, 0o700);
  await assert.rejects(EndpointCatalog.open(path), /mode 0600/u);

  await rm(path);
  await promisify(execFile)("mkfifo", [path]);
  await assert.rejects(EndpointCatalog.open(path), /regular owner file/u);
});
