import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { preparedProjectWorkspaceFromCheckpoint, ProjectWorkspacePolicy } from "../../src/sessions/project-workspace.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "qiyan-project-policy-"));
  const userHome = join(root, "home");
  const qiyanHome = join(userHome, ".qiyan-bot");
  const assistantWorkdir = join(qiyanHome, "qiyan-workdir");
  const dataDir = join(qiyanHome, "data");
  const registryPath = join(dataDir, "sessions.json");
  await Promise.all([mkdir(assistantWorkdir, { recursive: true }), mkdir(dataDir, { recursive: true })]);
  return {
    root,
    userHome: await realpath(userHome),
    qiyanHome: await realpath(qiyanHome),
    assistantWorkdir: await realpath(assistantWorkdir),
    dataDir: await realpath(dataDir),
    registryPath,
    policy: new ProjectWorkspacePolicy({ userHome, qiyanHome, assistantWorkdir, dataDir, registryPath }),
  };
}

test("prepares explicit and exclusive fallback project directories", async () => {
  const value = await fixture();
  const explicit = await value.policy.prepareCreate("notes", "~/Documents/QiYan notes");
  assert.equal(explicit.path, join(value.userHome, "Documents", "QiYan notes"));
  assert.equal(explicit.created, true);
  assert.equal(explicit.fallback, false);
  assert.equal((await stat(explicit.path)).mode & 0o777, 0o700);
  assert.match(explicit.identity.device, /^[0-9]+$/u);
  assert.match(explicit.identity.inode, /^[0-9]+$/u);
  assert.equal((await value.policy.prepareExisting(explicit.path)).created, false);
  await assert.rejects(value.policy.prepareCreate("relative", "relative/path"), /absolute or begin with ~\//);

  const fallback = await value.policy.prepareCreate("payments");
  assert.equal(fallback.path, join(value.userHome, "qiyan-projects", "payments"));
  assert.equal(fallback.created, true);
  assert.equal(fallback.fallback, true);
  assert.equal((await stat(fallback.path)).mode & 0o777, 0o700);
  await assert.rejects(value.policy.prepareCreate("payments"), (error: unknown) =>
    error instanceof AppError && error.code === "OPERATION_CONFLICT");
  await assert.rejects(value.policy.prepareCreate("Bad Nickname"), /nickname/);
});

test("rejects broad roots, QiYan state overlap, traversal, and symlink aliases", async () => {
  const value = await fixture();
  const registryDir = dirname(value.registryPath);
  const rejected = [
    "/",
    value.userHome,
    dirname(value.userHome),
    value.qiyanHome,
    join(value.qiyanHome, "unrelated-sibling"),
    dirname(value.qiyanHome),
    value.assistantWorkdir,
    join(value.assistantWorkdir, "child"),
    dirname(value.assistantWorkdir),
    value.dataDir,
    join(value.dataDir, "child"),
    registryDir,
  ];
  for (const path of rejected) await assert.rejects(value.policy.prepareCreate("blocked", path), /protected|broad/);
  await assert.rejects(value.policy.prepareCreate("traversal", `${value.userHome}/Documents/../../`), /protected|broad/);
  await assert.rejects(value.policy.prepareCreate("missing", join(value.qiyanHome, "missing", "child")), /protected/);

  const alias = join(value.root, "data-alias");
  await symlink(value.dataDir, alias, "dir");
  await assert.rejects(value.policy.prepareExisting(alias), /protected/);

  const homeAlias = join(value.root, "qiyan-home-alias");
  await symlink(value.qiyanHome, homeAlias, "dir");
  await assert.rejects(value.policy.prepareExisting(homeAlias), /protected/);
});

test("dispatch revalidation rejects directory replacement and symlink insertion", async () => {
  const value = await fixture();
  const prepared = await value.policy.prepareCreate("safe", "~/Documents/safe");
  await value.policy.assertDispatchable(prepared);

  const moved = `${prepared.path}-moved`;
  await rename(prepared.path, moved);
  await mkdir(prepared.path, { mode: 0o700 });
  await assert.rejects(value.policy.assertDispatchable(prepared), /changed unexpectedly/);

  const second = await value.policy.prepareCreate("second", "~/Documents/second");
  await rename(second.path, `${second.path}-moved`);
  await symlink(value.dataDir, second.path, "dir");
  await assert.rejects(value.policy.assertDispatchable(second), /real directory|protected|changed unexpectedly/);
});

test("dispatch revalidation detects replacement after its canonical safety check", async () => {
  const value = await fixture();
  const prepared = await value.policy.prepareCreate("raced", "~/Documents/raced");
  const policy = value.policy as any;
  const originalAssertSafe = policy.assertSafe.bind(policy);
  let swapped = false;
  policy.assertSafe = async (candidate: string) => {
    await originalAssertSafe(candidate);
    if (swapped || candidate !== prepared.path) return;
    swapped = true;
    await rename(prepared.path, `${prepared.path}-original`);
    await mkdir(prepared.path, { mode: 0o700 });
  };

  await assert.rejects(value.policy.assertDispatchable(prepared), /changed unexpectedly/);
});

test("prepared directories are retained when later work fails", async () => {
  const value = await fixture();
  const prepared = await value.policy.prepareCreate("retained", "~/Documents/retained");
  await chmod(prepared.path, 0o700);
  assert.equal((await lstat(prepared.path)).isDirectory(), true);
});

test("checkpoint identities are JSON-safe unsigned 64-bit decimals", () => {
  assert.deepEqual(preparedProjectWorkspaceFromCheckpoint({
    projectDir: "/projects/example",
    projectDirCreated: true,
    projectDirFallback: false,
    projectDirDevice: "18446744073709551615",
    projectDirInode: "0",
  }), {
    path: "/projects/example",
    created: true,
    fallback: false,
    identity: { device: "18446744073709551615", inode: "0" },
  });
  for (const invalid of ["-1", "1.5", "01x", "18446744073709551616"]) {
    assert.throws(() => preparedProjectWorkspaceFromCheckpoint({
      projectDir: "/projects/example",
      projectDirCreated: true,
      projectDirFallback: false,
      projectDirDevice: invalid,
      projectDirInode: "1",
    }), /checkpoint is invalid/);
  }
});
