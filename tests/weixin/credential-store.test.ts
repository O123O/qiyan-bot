import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { WeixinCredentialStore } from "../../src/chat-apps/weixin/credential-store.ts";

async function fixture(t: TestContext): Promise<{ root: string; qiyanHome: string; credentialPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "qiyan-weixin-credentials-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const qiyanHome = join(root, "qiyan-home");
  await mkdir(qiyanHome, { mode: 0o700 });
  return { root, qiyanHome, credentialPath: join(qiyanHome, "credentials", "weixin.json") };
}

const confirmed = {
  botId: "bot-1",
  ownerUserId: "owner-1",
  botToken: "private-bot-token",
  apiBaseUrl: "https://ilinkai.weixin.qq.com",
  authenticatedAt: 1_750_000_000_000,
};

test("creates only the private credential directory when no credential exists", async (t) => {
  const value = await fixture(t);
  const store = new WeixinCredentialStore(value.qiyanHome);
  assert.equal(await store.loadPinned(), undefined);
  assert.equal((await stat(join(value.qiyanHome, "credentials"))).mode & 0o777, 0o700);
});

test("atomically stores and loads one opaque credential handle", async (t) => {
  const value = await fixture(t);
  const steps: string[] = [];
  const store = new WeixinCredentialStore(value.qiyanHome, { observeWriteStep: (step) => steps.push(step) });
  const saved = await store.commitConfirmed(confirmed);

  assert.match(saved.accountGenerationId, /^[0-9a-f-]{36}$/u);
  assert.match(saved.credentialRevisionId, /^[0-9a-f-]{36}$/u);
  assert.equal(saved.botId, confirmed.botId);
  assert.equal(saved.ownerUserId, confirmed.ownerUserId);
  assert.equal(saved.apiBaseUrl, "https://ilinkai.weixin.qq.com");
  assert.equal((await stat(value.credentialPath)).mode & 0o777, 0o600);
  assert.deepEqual(steps, ["credentials-directory-synced", "temporary-opened", "temporary-synced", "renamed", "directory-synced"]);

  const handle = await store.loadPinned();
  assert.deepEqual(handle?.public, saved);
  assert.equal(await handle?.withVerifiedCredential(async (credential) => credential.botToken), confirmed.botToken);
  const onDisk = JSON.parse(await readFile(value.credentialPath, "utf8")) as Record<string, unknown>;
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.bot_token, confirmed.botToken);
});

test("preserves account generation only for the same bot and owner", async (t) => {
  const value = await fixture(t);
  const store = new WeixinCredentialStore(value.qiyanHome);
  const first = await store.commitConfirmed(confirmed);
  const refreshed = await store.commitConfirmed({ ...confirmed, botToken: "refreshed", authenticatedAt: confirmed.authenticatedAt + 1 });
  assert.equal(refreshed.accountGenerationId, first.accountGenerationId);
  assert.notEqual(refreshed.credentialRevisionId, first.credentialRevisionId);

  const replacement = await store.commitConfirmed({ ...confirmed, botId: "bot-2", botToken: "replacement", authenticatedAt: confirmed.authenticatedAt + 2 });
  assert.notEqual(replacement.accountGenerationId, first.accountGenerationId);
  assert.notEqual(replacement.credentialRevisionId, refreshed.credentialRevisionId);
});

test("failed replacement leaves the prior credential intact and no plaintext temporary file", async (t) => {
  const value = await fixture(t);
  const initial = new WeixinCredentialStore(value.qiyanHome);
  const first = await initial.commitConfirmed(confirmed);
  const originalBytes = await readFile(value.credentialPath);
  const failing = new WeixinCredentialStore(value.qiyanHome, { beforeRename: async () => { throw new Error("injected failure"); } });

  await assert.rejects(failing.commitConfirmed({ ...confirmed, botToken: "must-not-commit" }), /cannot store WeChat credentials/u);
  assert.deepEqual(await readFile(value.credentialPath), originalBytes);
  assert.deepEqual((await initial.loadPinned())?.public, first);
  assert.deepEqual((await readdir(join(value.qiyanHome, "credentials"))).sort(), [".weixin.lock", "weixin.json"]);
});

test("serializes concurrent credential commits across store instances", async (t) => {
  const value = await fixture(t);
  const initial = new WeixinCredentialStore(value.qiyanHome);
  await initial.commitConfirmed(confirmed);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => { entered = resolve; });
  const first = new WeixinCredentialStore(value.qiyanHome, {
    beforeRename: async () => { entered(); await held; },
  });
  const firstCommit = first.commitConfirmed({ ...confirmed, botToken: "first" });
  await entering;

  await assert.rejects(
    new WeixinCredentialStore(value.qiyanHome).commitConfirmed({ ...confirmed, botToken: "second" }),
    /credential update is already in progress|cannot store WeChat credentials/u,
  );
  release();
  await firstCommit;
  const handle = await initial.loadPinned();
  assert.equal(await handle?.withVerifiedCredential(async (credential) => credential.botToken), "first");
});

test("pre-rename mutation never overwrites a changed target", async (t) => {
  const value = await fixture(t);
  const initial = new WeixinCredentialStore(value.qiyanHome);
  await initial.commitConfirmed(confirmed);
  const original = await readFile(value.credentialPath);
  const racing = new WeixinCredentialStore(value.qiyanHome, {
    beforeRename: async () => { await writeFile(value.credentialPath, original, { mode: 0o600 }); },
  });
  await assert.rejects(racing.commitConfirmed({ ...confirmed, botToken: "must-not-win" }), /changed unexpectedly|cannot store/u);
  assert.deepEqual(await readFile(value.credentialPath), original);
});

test("directory mutation during commit is detected and descriptor-relative cleanup removes the temporary", async (t) => {
  const value = await fixture(t);
  const initial = new WeixinCredentialStore(value.qiyanHome);
  await initial.commitConfirmed(confirmed);
  const credentials = join(value.qiyanHome, "credentials");
  const moved = join(value.qiyanHome, "credentials-moved");
  const racing = new WeixinCredentialStore(value.qiyanHome, {
    beforeRename: async () => {
      await rename(credentials, moved);
      await mkdir(credentials, { mode: 0o700 });
    },
  });
  await assert.rejects(racing.commitConfirmed({ ...confirmed, botToken: "must-not-win" }), /directory changed|cannot store/u);
  assert.equal((await readdir(moved)).some((name) => name.endsWith(".tmp")), false);
  assert.equal((await readdir(credentials)).some((name) => name.endsWith(".tmp")), false);
});

test("an empty or partial lock file left by a crash never blocks a later commit", async (t) => {
  const value = await fixture(t);
  const credentials = join(value.qiyanHome, "credentials");
  await mkdir(credentials, { mode: 0o700 });
  await writeFile(join(credentials, ".weixin.lock"), "partial metadata from a dead process", { mode: 0o600 });

  const saved = await new WeixinCredentialStore(value.qiyanHome).commitConfirmed(confirmed);
  assert.equal(saved.botId, confirmed.botId);
  assert.equal((await stat(join(credentials, ".weixin.lock"))).isFile(), true);
});

test("lock-path replacement is detected without unlinking the replacement", async (t) => {
  const value = await fixture(t);
  const initial = new WeixinCredentialStore(value.qiyanHome);
  await initial.commitConfirmed(confirmed);
  const lockPath = join(value.qiyanHome, "credentials", ".weixin.lock");
  const racing = new WeixinCredentialStore(value.qiyanHome, {
    beforeRename: async () => {
      await rm(lockPath);
      await writeFile(lockPath, "new-live-lock", { mode: 0o600 });
    },
  });

  await assert.rejects(racing.commitConfirmed({ ...confirmed, botToken: "must-not-win" }), /lock changed|cannot store/u);
  assert.equal(await readFile(lockPath, "utf8"), "new-live-lock");
});

test("rejects malformed, unknown, symlinked, and hard-linked credentials", async (t) => {
  for (const document of [
    "not-json",
    JSON.stringify({ version: 2 }),
    JSON.stringify({ version: 1, account_generation_id: "bad" }),
  ]) {
    const value = await fixture(t);
    await mkdir(join(value.qiyanHome, "credentials"), { mode: 0o700 });
    await writeFile(value.credentialPath, document, { mode: 0o600 });
    await assert.rejects(new WeixinCredentialStore(value.qiyanHome).loadPinned(), /credential file is invalid/u);
  }

  const linked = await fixture(t);
  await mkdir(join(linked.qiyanHome, "credentials"), { mode: 0o700 });
  const target = join(linked.root, "target.json");
  await writeFile(target, "{}", { mode: 0o600 });
  await symlink(target, linked.credentialPath);
  await assert.rejects(new WeixinCredentialStore(linked.qiyanHome).loadPinned(), /regular file|symlink/u);

  const hardLinked = await fixture(t);
  const hardStore = new WeixinCredentialStore(hardLinked.qiyanHome);
  await hardStore.commitConfirmed(confirmed);
  await link(hardLinked.credentialPath, join(hardLinked.root, "second-link.json"));
  await assert.rejects(hardStore.loadPinned(), /hard link/u);
});

test("repairs modes only after validating ordinary owned paths", async (t) => {
  const value = await fixture(t);
  const store = new WeixinCredentialStore(value.qiyanHome);
  await store.commitConfirmed(confirmed);
  await chmod(join(value.qiyanHome, "credentials"), 0o755);
  await chmod(value.credentialPath, 0o644);
  const reopened = await new WeixinCredentialStore(value.qiyanHome).loadPinned();
  assert.ok(reopened);
  assert.equal((await stat(join(value.qiyanHome, "credentials"))).mode & 0o777, 0o700);
  assert.equal((await stat(value.credentialPath)).mode & 0o777, 0o600);

  await assert.rejects(
    new WeixinCredentialStore(value.qiyanHome, { expectedUid: (process.geteuid?.() ?? 0) + 1 }).loadPinned(),
    /owned by the current user/u,
  );
});

test("per-use verification rejects content, inode, deletion, symlink, parent, and mode changes", async (t) => {
  for (const { name, mutate } of [
    { name: "content replacement", mutate: async (value: Awaited<ReturnType<typeof fixture>>) => writeFile(value.credentialPath, "{}", { mode: 0o600 }) },
    { name: "same-content rewrite", mutate: async (value: Awaited<ReturnType<typeof fixture>>) => {
      await writeFile(value.credentialPath, await readFile(value.credentialPath), { mode: 0o600 });
      await utimes(value.credentialPath, new Date(0), new Date(0));
    } },
    { name: "inode replacement", mutate: async (value: Awaited<ReturnType<typeof fixture>>) => { await rm(value.credentialPath); await writeFile(value.credentialPath, "{}", { mode: 0o600 }); } },
    { name: "symlink replacement", mutate: async (value: Awaited<ReturnType<typeof fixture>>) => { await rm(value.credentialPath); const target = join(value.root, "replacement.json"); await writeFile(target, "{}", { mode: 0o600 }); await symlink(target, value.credentialPath); } },
    { name: "mode change", mutate: async (value: Awaited<ReturnType<typeof fixture>>) => chmod(value.credentialPath, 0o644) },
    { name: "parent replacement", mutate: async (value: Awaited<ReturnType<typeof fixture>>) => {
      const original = join(value.qiyanHome, "credentials-original");
      await rename(join(value.qiyanHome, "credentials"), original);
      await mkdir(join(value.qiyanHome, "credentials"), { mode: 0o700 });
      await writeFile(value.credentialPath, await readFile(join(original, "weixin.json")), { mode: 0o600 });
    } },
  ]) {
    const value = await fixture(t);
    const store = new WeixinCredentialStore(value.qiyanHome);
    await store.commitConfirmed(confirmed);
    const handle = await store.loadPinned();
    assert.ok(handle);
    await mutate(value);
    await assert.rejects(
      handle.withVerifiedCredential(async () => undefined),
      /credential.*changed|directory.*changed/u,
      name,
    );
  }
});

test("configuration failures never expose credential values", async (t) => {
  const value = await fixture(t);
  await mkdir(join(value.qiyanHome, "credentials"), { mode: 0o700 });
  await writeFile(value.credentialPath, JSON.stringify({ version: 1, bot_token: "do-not-expose-this-token" }), { mode: 0o600 });
  await assert.rejects(new WeixinCredentialStore(value.qiyanHome).loadPinned(), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "CONFIGURATION_ERROR", true);
    assert.doesNotMatch(String(error), /do-not-expose-this-token/u);
    return true;
  });
});
