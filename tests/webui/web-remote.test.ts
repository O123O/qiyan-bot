import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { remoteBrowse, remoteDiscover, remoteGitDiff, remoteGitStage, remoteGitStatus, remoteReadStream, type RemoteDeps } from "../../src/webui/web-remote.ts";

const run = promisify(execFile);

// A fake `ssh` that runs the generated REMOTE command locally, so the actual confinement/quoting
// scripts execute on localhost — this exercises the security-critical logic end-to-end without a host.
async function deps(): Promise<RemoteDeps> {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-fakessh-"));
  const ssh = join(dir, "ssh");
  await writeFile(ssh, `#!/bin/bash
if [ "$1" = "-G" ]; then printf 'hostname localhost\\nuser u\\nport 22\\ncontrolmaster no\\n'; exit 0; fi
cmd="\${@: -1}"        # last arg is the remote command string (exec bash -c '<script>')
exec bash -c "$cmd"
`, { mode: 0o755 });
  return { sshBinary: ssh, sshRuntimeRoot: await mkdtemp(join(tmpdir(), "qiyan-sshrt-")) };
}

async function collect(child: { stdout: NodeJS.ReadableStream; on: (e: string, cb: (c?: unknown) => void) => void }): Promise<{ text: string; code: number | null }> {
  return new Promise((resolve) => {
    let text = "";
    child.stdout.on("data", (b: unknown) => { text += String(b); });
    (child as { on: (e: string, cb: (c: number | null) => void) => void }).on("close", (code) => resolve({ text, code }));
  });
}

test("remoteBrowse lists a confined dir and rejects escapes", async () => {
  const d = await deps();
  const root = await mkdtemp(join(tmpdir(), "qiyan-rroot-"));
  await mkdir(join(root, "sub")); await writeFile(join(root, "a.txt"), "x");
  const r = await remoteBrowse(d, "testhost", root, "");
  assert.ok("kind" in r && r.kind === "dir");
  assert.deepEqual(r.entries.map((e) => `${e.type}:${e.name}`).sort(), ["dir:sub", "file:a.txt"]);
  assert.ok("error" in (await remoteBrowse(d, "testhost", root, "../..")));       // traversal
  assert.ok("error" in (await remoteBrowse(d, "testhost", root, "/etc")));        // absolute-ish (root//etc)
});

test("remoteReadStream streams any readable file (unconfined preview) and keeps paths literal vs injection", async () => {
  const d = await deps();
  const root = await mkdtemp(join(tmpdir(), "qiyan-rread-"));
  await writeFile(join(root, "report.md"), "# hi\nbody\n");
  const ok = await collect(await remoteReadStream(d, "testhost", root, "report.md"));
  assert.equal(ok.text, "# hi\nbody\n");

  // Owner-only preview is NOT confined to the root: an absolute path OUTSIDE it streams as-is (the
  // remote OS's read permission is the boundary, unlike browse/git which stay confined).
  const outside = await mkdtemp(join(tmpdir(), "qiyan-rout-"));
  await writeFile(join(outside, "notes.txt"), "outside\n");
  const out = await collect(await remoteReadStream(d, "testhost", root, join(outside, "notes.txt")));
  assert.equal(out.text, "outside\n");

  // INJECTION: a path full of shell metacharacters — INCLUDING a single quote, the char q() escapes as
  // '\'' — must be a literal filename (no command runs).
  const marker = join(root, "PWNED");
  const evil = await collect(await remoteReadStream(d, "testhost", root, "x'\"; touch " + marker + " ; echo `touch " + marker + "` $(touch " + marker + ") #"));
  assert.notEqual(evil.code, 0);                       // nonexistent literal file → error
  await assert.rejects(stat(marker));                  // nothing executed
});

test("remote git status/diff/stage lifecycle + diff escape refused", async () => {
  const d = await deps();
  const root = await mkdtemp(join(tmpdir(), "qiyan-rgit-"));
  await run("git", ["-C", root, "init", "-q", "-b", "main"]);
  await run("git", ["-C", root, "config", "user.email", "t@t"]);
  await run("git", ["-C", root, "config", "user.name", "t"]);
  await writeFile(join(root, "f.txt"), "hello\n");

  const st = await remoteGitStatus(d, "testhost", root, "");
  assert.ok(!("error" in st) && st.branch === "main" && st.untracked.includes("f.txt"));
  const diff = await remoteGitDiff(d, "testhost", root, "", "f.txt", false);
  assert.ok("diff" in diff && diff.diff.includes("hello"));
  assert.deepEqual(await remoteGitStage(d, "testhost", root, "", "f.txt"), { ok: true });
  const st2 = await remoteGitStatus(d, "testhost", root, "");
  assert.ok(!("error" in st2) && st2.staged.includes("f.txt"));
  assert.ok("error" in (await remoteGitDiff(d, "testhost", root, "", "/etc/hostname", false))); // --no-index leak refused
});

test("remoteDiscover finds subdir repos when the root isn't a repo", async () => {
  const d = await deps();
  const base = await mkdtemp(join(tmpdir(), "qiyan-rdisc-"));
  await mkdir(join(base, "a")); await run("git", ["-C", join(base, "a"), "init", "-q"]);
  await mkdir(join(base, "b")); await run("git", ["-C", join(base, "b"), "init", "-q"]);
  await mkdir(join(base, "plain"));
  const repos = await remoteDiscover(d, "testhost", base);
  assert.deepEqual([...repos].sort(), ["a", "b"]);
});

void chmod; // (kept for potential symlink-perm tests)
