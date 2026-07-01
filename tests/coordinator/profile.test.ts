import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { prepareCoordinatorProfile } from "../../src/coordinator/profile.ts";

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
  assert.deepEqual(profile.creationBaseline, []);
  assert.match(profile.creationNonce, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  for (const path of [profile.root, profile.home, profile.codexHome]) assert.equal((await stat(path)).mode & 0o777, 0o700);

  await profile.markActivated(["thread-z", "thread-a", "thread-z"]);
  assert.equal(profile.activationRequired, false);
  assert.deepEqual(profile.creationBaseline, ["thread-a", "thread-z"]);
  assert.equal((await stat(profile.markerPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(profile.markerPath, "utf8")), {
    version: 1, creation_nonce: profile.creationNonce, creation_baseline: ["thread-a", "thread-z"],
  });

  const reopened = await prepareCoordinatorProfile(dataRoot);
  assert.equal(reopened.activationRequired, false);
  assert.equal(reopened.creationNonce, profile.creationNonce);
  assert.deepEqual(reopened.creationBaseline, ["thread-a", "thread-z"]);
  await reopened.markActivated(["thread-z", "thread-a"]);
  await assert.rejects(reopened.markActivated(["different"]), /activation marker already records a different baseline/);
});

test("repairs private directory modes without replacing directories", async (t) => {
  const { root, dataRoot } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(dataRoot, "coordinator-profile/home"), { recursive: true, mode: 0o755 });
  await mkdir(join(dataRoot, "coordinator-profile/codex"), { mode: 0o755 });
  const profile = await prepareCoordinatorProfile(dataRoot);
  for (const path of [profile.root, profile.home, profile.codexHome]) assert.equal((await stat(path)).mode & 0o777, 0o700);
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
    JSON.stringify({ version: 2, creation_nonce: crypto.randomUUID(), creation_baseline: [] }),
    JSON.stringify({ version: 1, creation_nonce: "not-a-uuid", creation_baseline: [] }),
    JSON.stringify({ version: 1, creation_nonce: crypto.randomUUID(), creation_baseline: ["z", "a"] }),
    JSON.stringify({ version: 1, creation_nonce: crypto.randomUUID(), creation_baseline: ["a", "a"] }),
    JSON.stringify({ version: 1, creation_nonce: crypto.randomUUID(), creation_baseline: [], extra: true }),
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
  await writeFile(target, JSON.stringify({ version: 1, creation_nonce: crypto.randomUUID(), creation_baseline: [] }));
  await symlink(target, join(profileRoot, "profile.json"));
  await assert.rejects(prepareCoordinatorProfile(dataRoot), /activation marker must be a regular file/);
});
