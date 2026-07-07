import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { acquireDatabaseLease } from "../../src/storage/database-lease.ts";

async function fixture(t: TestContext): Promise<{ root: string; databasePath: string; lockPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-database-lease-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    databasePath: join(root, "bot.sqlite3"),
    lockPath: join(root, ".bot.sqlite3.lock"),
  };
}

test("database lease excludes another owner until idempotent release", async (t) => {
  const value = await fixture(t);
  const first = await acquireDatabaseLease(value.databasePath);

  await assert.rejects(acquireDatabaseLease(value.databasePath), (error: unknown) => error instanceof AppError
    && error.code === "CONFIGURATION_ERROR" && error.message === "QiYan Bot state database is already in use");
  const lock = await lstat(value.lockPath);
  assert.equal(lock.isFile(), true);
  assert.equal(lock.mode & 0o777, 0o600);

  await first.release();
  await first.release();
  const second = await acquireDatabaseLease(value.databasePath);
  await second.release();
  assert.equal((await lstat(value.lockPath)).isFile(), true);
});

test("database lease repairs only a safely owned ordinary lock mode", async (t) => {
  const value = await fixture(t);
  await writeFile(value.lockPath, "stable", { mode: 0o640 });

  const lease = await acquireDatabaseLease(value.databasePath);
  assert.equal((await lstat(value.lockPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(value.lockPath, "utf8"), "stable");
  await lease.release();
});

test("database lease rejects symlinks, hard links, and non-files without exposing paths", async (t) => {
  for (const kind of ["symlink", "hardlink", "directory", "fifo"] as const) {
    const value = await fixture(t);
    if (kind === "symlink") {
      const target = join(value.root, "target");
      await writeFile(target, "target", { mode: 0o600 });
      await symlink(target, value.lockPath);
    } else if (kind === "hardlink") {
      await writeFile(value.lockPath, "lock", { mode: 0o600 });
      await link(value.lockPath, join(value.root, "second-link"));
    } else if (kind === "directory") {
      await mkdir(value.lockPath, { mode: 0o700 });
    } else {
      assert.equal(spawnSync("/usr/bin/mkfifo", [value.lockPath], { env: {} }).status, 0);
    }

    let failure: unknown;
    try { await acquireDatabaseLease(value.databasePath); }
    catch (error) { failure = error; }
    assert.equal(failure instanceof AppError && failure.code === "CONFIGURATION_ERROR"
      && failure.message === "QiYan Bot state database lock is unsafe", true);
    assert.doesNotMatch(failure instanceof Error ? failure.message : "", new RegExp(value.root, "u"));
  }
});

test("database lease defaults to the effective uid and rejects a different expected owner", async (t) => {
  const value = await fixture(t);
  const lease = await acquireDatabaseLease(value.databasePath);
  await lease.release();
  const uid = process.geteuid?.() ?? process.getuid?.();
  assert.notEqual(uid, undefined);

  await assert.rejects(acquireDatabaseLease(value.databasePath, { expectedUid: uid! + 1 }), (error: unknown) => error instanceof AppError
    && error.code === "CONFIGURATION_ERROR" && error.message === "QiYan Bot state database lock is unsafe");
});

test("database lease rejects post-lock path replacement and leaves the replacement intact", async (t) => {
  const value = await fixture(t);
  const displaced = join(value.root, "displaced-lock");

  await assert.rejects(acquireDatabaseLease(value.databasePath, {
    afterLock: async () => {
      await rename(value.lockPath, displaced);
      await writeFile(value.lockPath, "replacement", { mode: 0o600 });
    },
  }), (error: unknown) => error instanceof AppError
    && error.code === "CONFIGURATION_ERROR" && error.message === "QiYan Bot state database lock changed unexpectedly");

  assert.equal(await readFile(value.lockPath, "utf8"), "replacement");
  const lease = await acquireDatabaseLease(value.databasePath);
  await lease.release();
});
