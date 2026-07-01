import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { assertCoordinatorAuthenticated, prepareCoordinatorProfile, startAuthenticatedCoordinatorEndpoint } from "../../src/coordinator/profile.ts";

async function fixture(): Promise<{ root: string; dataRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-bot-profile-"));
  const dataRoot = join(root, "data");
  await mkdir(dataRoot, { mode: 0o700 });
  return { root, dataRoot };
}

test("prepares private coordinator profile directories and a durable activation marker", async (t) => {
  const { root, dataRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = await prepareCoordinatorProfile(dataRoot);
  assert.equal(profile.root, join(dataRoot, "coordinator-profile"));
  assert.equal(profile.home, join(profile.root, "home"));
  assert.equal(profile.codexHome, join(profile.root, "codex"));
  assert.equal(profile.markerPath, join(profile.root, "profile.json"));
  assert.equal(profile.activationRequired, true);
  assert.equal(profile.pendingThreadId, null);
  assert.match(profile.creationNonce, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  for (const path of [profile.root, profile.home, profile.codexHome]) assert.equal((await stat(path)).mode & 0o777, 0o700);

  await profile.markActivated();
  assert.equal(profile.activationRequired, false);
  assert.equal(profile.pendingThreadId, null);
  assert.equal((await stat(profile.markerPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(profile.markerPath, "utf8")), {
    version: 1, creation_nonce: profile.creationNonce, pending_thread_id: null,
  });

  await profile.recordPendingThread("thread-a");
  assert.equal(profile.pendingThreadId, "thread-a");
  await profile.recordPendingThread("thread-a");
  await assert.rejects(profile.recordPendingThread("thread-b"), /different pending thread/);

  const reopened = await prepareCoordinatorProfile(dataRoot);
  assert.equal(reopened.activationRequired, false);
  assert.equal(reopened.creationNonce, profile.creationNonce);
  assert.equal(reopened.pendingThreadId, "thread-a");
  await assert.rejects(reopened.clearPendingThread("thread-b"), /does not match/);
  await reopened.clearPendingThread("thread-a");
  assert.equal(reopened.pendingThreadId, null);
});

test("repairs private directory modes without replacing directories", async (t) => {
  const { root, dataRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(dataRoot, "coordinator-profile/home"), { recursive: true, mode: 0o755 });
  await mkdir(join(dataRoot, "coordinator-profile/codex"), { mode: 0o755 });
  const profile = await prepareCoordinatorProfile(dataRoot);
  for (const path of [profile.root, profile.home, profile.codexHome]) assert.equal((await stat(path)).mode & 0o777, 0o700);
});

test("detects replacement of a pinned coordinator profile directory", async (t) => {
  const { root, dataRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = await prepareCoordinatorProfile(dataRoot);
  const replacement = join(root, "replacement-codex-home");
  await mkdir(replacement);
  await rm(profile.codexHome, { recursive: true });
  await symlink(replacement, profile.codexHome);
  await assert.rejects(profile.assertIntact(), /changed unexpectedly/);
});

test("detects permission changes on a pinned coordinator profile directory", async (t) => {
  const { root, dataRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = await prepareCoordinatorProfile(dataRoot);
  await chmod(profile.codexHome, 0o755);
  await assert.rejects(profile.assertIntact(), /changed unexpectedly/);
});

test("rejects symlinks and non-directories anywhere in the managed profile path", async (t) => {
  for (const component of ["coordinator-profile", "coordinator-profile/home", "coordinator-profile/codex"]) {
    await t.test(component, async (st) => {
      const { root, dataRoot } = await fixture();
      st.after(() => rm(root, { recursive: true, force: true }));
      const target = join(root, "target");
      await mkdir(target);
      const path = join(dataRoot, component);
      await mkdir(join(path, ".."), { recursive: true });
      await symlink(target, path);
      await assert.rejects(prepareCoordinatorProfile(dataRoot), (error: unknown) => error instanceof AppError && error.code === "CONFIGURATION_ERROR");
    });
  }

  const { root, dataRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(dataRoot, "coordinator-profile"), "not a directory");
  await assert.rejects(prepareCoordinatorProfile(dataRoot), /must be a real directory/);
});

test("rejects malformed, noncanonical, unsupported, and symlink activation markers", async (t) => {
  const invalid = [
    "not-json",
    JSON.stringify({ version: 2, creation_nonce: crypto.randomUUID(), pending_thread_id: null }),
    JSON.stringify({ version: 1, creation_nonce: "not-a-uuid", pending_thread_id: null }),
    JSON.stringify({ version: 1, creation_nonce: crypto.randomUUID(), pending_thread_id: "" }),
    JSON.stringify({ version: 1, creation_nonce: crypto.randomUUID(), pending_thread_id: null, extra: true }),
  ];
  for (const contents of invalid) {
    const { root, dataRoot } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const profileRoot = join(dataRoot, "coordinator-profile");
    await mkdir(profileRoot);
    await writeFile(join(profileRoot, "profile.json"), contents);
    await assert.rejects(prepareCoordinatorProfile(dataRoot), /activation marker is invalid/);
  }

  const { root, dataRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const profileRoot = join(dataRoot, "coordinator-profile");
  await mkdir(profileRoot);
  const target = join(root, "marker-target");
  await writeFile(target, JSON.stringify({ version: 1, creation_nonce: crypto.randomUUID(), pending_thread_id: null }));
  await symlink(target, join(profileRoot, "profile.json"));
  await assert.rejects(prepareCoordinatorProfile(dataRoot), /activation marker must be a regular file/);
});

test("coordinator authentication preflight accepts authenticated and external-provider profiles", async () => {
  const profile = { root: "/private/profile", home: "/private/profile/home", codexHome: "/private/profile/codex" };
  const requests: Array<{ method: string; params: unknown }> = [];
  const endpoint = (result: unknown) => ({
    request: async <T>(method: string, params: unknown) => { requests.push({ method, params }); return result as T; },
  });
  await assertCoordinatorAuthenticated(endpoint({ account: { type: "chatgpt" }, requiresOpenaiAuth: true }), profile);
  await assertCoordinatorAuthenticated(endpoint({ account: null, requiresOpenaiAuth: false }), profile);
  assert.deepEqual(requests, [
    { method: "account/read", params: { refreshToken: false } },
    { method: "account/read", params: { refreshToken: false } },
  ]);
});

test("coordinator authentication failure is actionable and stops a newly started endpoint", async () => {
  const profile = { root: "/private/profile", home: "/private/profile/home", codexHome: "/private/profile/codex" };
  const endpoint = {
    starts: 0,
    stops: 0,
    async start() { this.starts += 1; },
    async stop() { this.stops += 1; },
    async request<T>() { return { account: null, requiresOpenaiAuth: true } as T; },
  };
  await assert.rejects(
    startAuthenticatedCoordinatorEndpoint(endpoint, profile),
    (error: unknown) => error instanceof AppError
      && error.code === "CONFIGURATION_ERROR"
      && error.message.includes(profile.home)
      && error.message.includes(profile.codexHome)
      && error.message.includes("codex-bot coordinator-login"),
  );
  assert.equal(endpoint.starts, 1);
  assert.equal(endpoint.stops, 1);
});
