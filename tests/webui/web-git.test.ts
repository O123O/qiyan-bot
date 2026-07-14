import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { discoverRepos, gitCommit, gitDiff, gitStage, gitStatus, gitUnstage } from "../../src/webui/web-git.ts";

const run = promisify(execFile);

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-git-"));
  await run("git", ["-C", dir, "init", "-q", "-b", "main"]);
  await run("git", ["-C", dir, "config", "user.email", "t@t"]);
  await run("git", ["-C", dir, "config", "user.name", "t"]);
  return dir;
}

test("status/diff/stage/unstage/commit lifecycle", async () => {
  const dir = await repo();
  await writeFile(join(dir, "a.txt"), "hello\n");

  let s = await gitStatus(dir);
  assert.ok(!("error" in s) && s.branch === "main" && s.untracked.includes("a.txt"));

  const d = await gitDiff(dir, "a.txt", false); // untracked → whole-file (no-index)
  assert.ok("diff" in d && d.diff.includes("hello"));

  assert.deepEqual(await gitStage(dir, "a.txt"), { ok: true });
  s = await gitStatus(dir);
  assert.ok(!("error" in s) && s.staged.includes("a.txt") && !s.untracked.includes("a.txt"));

  assert.deepEqual(await gitUnstage(dir, "a.txt"), { ok: true });
  assert.ok(!("error" in (await gitStatus(dir))) && (await gitStatus(dir) as { untracked: string[] }).untracked.includes("a.txt"));

  await gitStage(dir, "a.txt");
  const c = await gitCommit(dir, "init");
  assert.ok("ok" in c);
  s = await gitStatus(dir);
  assert.ok(!("error" in s) && !s.staged.length && !s.changes.length && !s.untracked.length); // clean
});

test("gitDiff refuses paths outside the repo (no --no-index leak)", async () => {
  const dir = await repo();
  assert.ok("error" in (await gitDiff(dir, "/etc/hostname", false)));      // absolute
  assert.ok("error" in (await gitDiff(dir, "../../etc/hostname", false))); // traversal
});

test("discoverRepos finds repos at the root and in subdirs", async () => {
  const base = await mkdtemp(join(tmpdir(), "qiyan-discover-"));
  await run("git", ["-C", base, "init", "-q"]);                 // root repo → ""
  await mkdir(join(base, "sub"));
  await run("git", ["-C", join(base, "sub"), "init", "-q"]);    // subdir repo → "sub"
  await mkdir(join(base, "plain"));                             // not a repo
  const repos = await discoverRepos(base);
  assert.ok(repos.includes(""), "root repo");
  assert.ok(repos.includes("sub"), "subdir repo");
  assert.ok(!repos.includes("plain"));

  const noRepo = await discoverRepos(await mkdtemp(join(tmpdir(), "qiyan-norepo-")));
  assert.deepEqual(noRepo, []);
});

test("reports non-repos and empty commit messages", async () => {
  assert.ok("error" in (await gitStatus(await mkdtemp(join(tmpdir(), "qiyan-nogit-")))));
  assert.ok("error" in (await gitCommit(await repo(), "   ")));
});
