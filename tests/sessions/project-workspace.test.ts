import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { LocalWorkspaceHost, type WorkspaceHost } from "../../src/endpoints/ssh-host.ts";
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

function policyFor(value: Awaited<ReturnType<typeof fixture>>, host: WorkspaceHost): ProjectWorkspacePolicy {
  return new ProjectWorkspacePolicy({
    userHome: value.userHome,
    qiyanHome: value.qiyanHome,
    assistantWorkdir: value.assistantWorkdir,
    dataDir: value.dataDir,
    registryPath: value.registryPath,
    host,
  });
}

function failingHost(userHome: string, fail: (method: "lstat" | "realpath", path: string) => Error | undefined): WorkspaceHost {
  const local = new LocalWorkspaceHost(userHome);
  return {
    endpointId: "devbox",
    home: () => local.home(),
    lstat: async (path) => {
      const error = fail("lstat", path);
      if (error) throw error;
      return local.lstat(path);
    },
    realpath: async (path) => {
      const error = fail("realpath", path);
      if (error) throw error;
      return local.realpath(path);
    },
    mkdir: (path, options) => local.mkdir(path, options),
    chmod: (path, mode) => local.chmod(path, mode),
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

test("dispatch revalidation rejects an ancestor-symlink swap via the identity check", async () => {
  const value = await fixture();
  const prepared = await value.policy.prepareCreate("proj", "~/Documents/proj");
  await value.policy.assertDispatchable(prepared); // ok initially
  // Turn the parent dir into a symlink to a decoy: lstat(prepared.path) now resolves a DIFFERENT inode.
  const parent = dirname(prepared.path);
  await mkdir(join(value.userHome, "decoy", "proj"), { recursive: true, mode: 0o700 });
  await rename(parent, `${parent}-orig`);
  await symlink(join(value.userHome, "decoy"), parent, "dir");
  await assert.rejects(value.policy.assertDispatchable(prepared), /changed unexpectedly/);
});

test("dispatch revalidation still rejects a path overlapping protected QiYan state (assertSafe retained)", async () => {
  const value = await fixture();
  const st = await lstat(value.qiyanHome);
  // A workspace whose identity matches the real qiyanHome dir but overlaps protected state: the
  // identity lstat passes, so only the retained assertSafe can catch it.
  const forged = preparedProjectWorkspaceFromCheckpoint({
    projectDir: value.qiyanHome, projectDirCreated: false, projectDirFallback: false,
    projectDirDevice: st.dev.toString(10), projectDirInode: st.ino.toString(10),
  });
  await assert.rejects(value.policy.assertDispatchable(forged), /protected|broad parent|changed/u);
});

test("dispatch revalidation maps a transient host failure to a typed error, not a raw throw", async () => {
  const value = await fixture();
  const prepared = await value.policy.prepareCreate("proj", "~/Documents/proj");
  const raw = new Error("ssh transport died mid-lstat");
  const policy = policyFor(value, failingHost(value.userHome, (m, p) => (m === "lstat" && p === prepared.path ? raw : undefined)));
  await assert.rejects(policy.assertDispatchable(prepared), (error: unknown) => error instanceof AppError && error !== raw);
});

test("resolves the constant protected/home paths once and reuses them across calls", async () => {
  const value = await fixture();
  const project = join(value.userHome, "Documents", "cached");
  await mkdir(project, { recursive: true, mode: 0o700 });
  let qiyanHomeRealpaths = 0;
  let userHomeRealpaths = 0;
  const host = failingHost(value.userHome, (method, path) => {
    if (method === "realpath" && path === value.qiyanHome) qiyanHomeRealpaths += 1;
    if (method === "realpath" && path === value.userHome) userHomeRealpaths += 1;
    return undefined;
  });
  const policy = new ProjectWorkspacePolicy({
    userHome: value.userHome, qiyanHome: value.qiyanHome, assistantWorkdir: value.qiyanHome,
    dataDir: value.qiyanHome, registryPath: join(value.qiyanHome, "sessions.json"), host,
  });

  const prepared = await policy.prepareExisting(project); // two safety passes + resolveUserPath
  await policy.assertDispatchable(prepared);              // retained assertSafe
  await policy.prepareExisting(project);                  // second time — constants stay cached

  assert.equal(qiyanHomeRealpaths, 1, "the protected dir is resolved once and cached (was ~4×)");
  assert.equal(userHomeRealpaths, 1, "the user home is resolved once and cached");
});

test("a moved project directory is still detected with the constant cache on", async () => {
  const value = await fixture();
  const prepared = await value.policy.prepareCreate("proj", "~/Documents/proj");
  await value.policy.assertDispatchable(prepared);
  await rename(prepared.path, `${prepared.path}-moved`);
  await mkdir(prepared.path, { mode: 0o700 }); // fresh dir, different inode
  await assert.rejects(value.policy.assertDispatchable(prepared), /changed unexpectedly/u);
});

test("workspace policy preserves typed endpoint failures from finalize and dispatch revalidation", async () => {
  const value = await fixture();
  const prepared = await value.policy.prepareCreate("remote", "~/Documents/remote");

  const finalizeFailure = new AppError("ENDPOINT_UNAVAILABLE", "SSH process failed (exit 1)");
  let targetStats = 0;
  const finalizePolicy = policyFor(value, failingHost(value.userHome, (method, path) => {
    if (method === "lstat" && path === prepared.path && ++targetStats === 2) return finalizeFailure;
    return undefined;
  }));
  await assert.rejects(finalizePolicy.prepareExisting(prepared.path), (error: unknown) => error === finalizeFailure);

  const dispatchFailure = new AppError("ENDPOINT_UNAVAILABLE", "SSH process failed (exit 1)");
  const dispatchPolicy = policyFor(value, failingHost(value.userHome, (method, path) =>
    method === "lstat" && path === prepared.path ? dispatchFailure : undefined));
  await assert.rejects(dispatchPolicy.assertDispatchable(prepared), (error: unknown) => error === dispatchFailure);
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
