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

test("resolves a codex/ssh endpoint (host explicit), defaults the projects root, rejects built-ins", async (t) => {
  const root = await privateTemp(t);
  const path = join(root, "endpoints.json");
  await writeFile(path, JSON.stringify({ version: 1, endpoints: { devbox: { provider: "codex", transport: "ssh", host: "devbox-alias" } } }), { mode: 0o600 });
  const catalog = await EndpointCatalog.open(path);
  assert.deepEqual(catalog.require("devbox"), { id: "devbox", provider: "codex", transport: "ssh", host: "devbox-alias", projectsRoot: "~/qiyan-projects" });
  assert.throws(() => catalog.require("local"), /built-in endpoint/u);
});

test("resolves claude endpoints — local (no host) and ssh (host + model/effort); definitions() lists all", async (t) => {
  const root = await privateTemp(t);
  const path = join(root, "endpoints.json");
  await writeFile(path, JSON.stringify({ version: 1, endpoints: {
    "claude-local": { provider: "claude", transport: "local", model: "opus" },
    "dfw": { provider: "claude", transport: "ssh", host: "dfw-alias", projects_root: "/work", model: "sonnet", effort: "high" },
  } }), { mode: 0o600 });
  const catalog = await EndpointCatalog.open(path);
  assert.deepEqual(catalog.require("claude-local"), { id: "claude-local", provider: "claude", transport: "local", projectsRoot: "~/qiyan-projects", model: "opus" });
  assert.deepEqual(catalog.require("dfw"), { id: "dfw", provider: "claude", transport: "ssh", host: "dfw-alias", projectsRoot: "/work", model: "sonnet", effort: "high" });
  assert.deepEqual(catalog.definitions().map((d) => `${d.id}:${d.provider}:${d.transport}`).sort(), ["claude-local:claude:local", "dfw:claude:ssh"]);
});

test("rejects unknown fields, bad provider/transport combos, unsafe roots, reserved ids, broad modes, and symlinks", async (t) => {
  const root = await privateTemp(t);
  const path = join(root, "endpoints.json");
  const invalid = async (value: unknown, pattern: RegExp) => {
    await rm(path, { force: true });
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    await assert.rejects(EndpointCatalog.open(path), pattern);
  };
  await invalid({ version: 1, endpoints: { devbox: { provider: "codex", transport: "ssh", host: "h", extra: true } } }, /extra/u);
  await invalid({ version: 1, endpoints: { devbox: { provider: "docker", transport: "ssh", host: "h" } } }, /devbox/u);
  await invalid({ version: 1, endpoints: { devbox: { provider: "codex", transport: "local" } } }, /devbox/u); // codex is ssh-only
  await invalid({ version: 1, endpoints: { devbox: { provider: "codex", transport: "ssh" } } }, /devbox/u); // codex requires host
  await invalid({ version: 1, endpoints: { devbox: { provider: "codex", transport: "ssh", host: "h", model: "opus" } } }, /model/u); // model is claude-only
  await invalid({ version: 1, endpoints: { devbox: { provider: "claude", transport: "ssh" } } }, /host/u); // ssh requires host
  await invalid({ version: 1, endpoints: { devbox: { provider: "claude", transport: "local", host: "h" } } }, /host/u); // local forbids host
  await invalid({ version: 1, endpoints: { devbox: { provider: "claude", transport: "local", projects_root: "/w" } } }, /projects_root/u); // local forbids projects_root
  await invalid({ version: 1, endpoints: { devbox: { provider: "codex", transport: "ssh", host: "h", projects_root: "relative" } } }, /projects_root/u);
  await invalid({ version: 1, endpoints: { local: { provider: "claude", transport: "local" } } }, /local/u); // reserved id
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
  await writeFile(path, JSON.stringify({ version: 1, endpoints: { one: { provider: "codex", transport: "ssh", host: "one", projects_root: "/work" } } }), { mode: 0o600 });
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
