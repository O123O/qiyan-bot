import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { remoteBrowse, remoteCreateEntry, remoteDiscover, remoteGitDiff, remoteGitStage, remoteGitStatus, remoteReadStream, remoteRunCommand, remoteUploadFile, type RemoteDeps } from "../../src/webui/web-remote.ts";

const run = promisify(execFile);

// A fake `ssh` that runs the generated REMOTE command locally, so the actual confinement/quoting
// scripts execute on localhost — this exercises the security-critical logic end-to-end without a host.
async function deps(): Promise<RemoteDeps> {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-fakessh-"));
  const ssh = join(dir, "ssh");
  await writeFile(ssh, `#!/bin/bash
if [ "$1" = "-G" ]; then printf 'hostname localhost\\nuser u\\nport 22\\ncontrolmaster no\\n'; exit 0; fi
case " $* " in *" -T "*) : ;; *) exit 98 ;; esac
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

async function assertProcessStopped(pid: number, startTime: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    let statLine: string;
    try { statLine = await readFile(`/proc/${pid}/stat`, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const fields = statLine.slice(statLine.lastIndexOf(") ") + 2).split(" ");
    if (fields[19] !== startTime || fields[0] === "Z") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`process ${pid} remained live after remote command cleanup`);
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

test("remoteUploadFile writes a confined new file and never overwrites", async () => {
  const d = await deps();
  const root = await mkdtemp(join(tmpdir(), "qiyan-rupload-"));
  await mkdir(join(root, "sub"));
  assert.deepEqual(await remoteUploadFile(d, "testhost", root, "sub/new file.txt", Buffer.from("remote upload\n")), {
    ok: true, path: "sub/new file.txt",
  });
  assert.equal(await readFile(join(root, "sub/new file.txt"), "utf8"), "remote upload\n");
  assert.ok("error" in await remoteUploadFile(d, "testhost", root, "sub/new file.txt", Buffer.from("replace")));
  assert.equal((await readdir(join(root, "sub"))).some((name) => name.startsWith(".qiyan-upload-")), false);
  assert.ok("error" in await remoteUploadFile(d, "testhost", root, "../escape.txt", Buffer.from("escape")));
});

test("remoteCreateEntry creates confined empty files and directories without overwriting", async () => {
  const d = await deps();
  const root = await mkdtemp(join(tmpdir(), "qiyan-rcreate-"));
  await mkdir(join(root, "sub"));
  assert.deepEqual(await remoteCreateEntry(d, "testhost", root, "sub/new.txt", "file"), {
    ok: true, path: "sub/new.txt",
  });
  assert.equal(await readFile(join(root, "sub/new.txt"), "utf8"), "");
  assert.deepEqual(await remoteCreateEntry(d, "testhost", root, "sub/new-dir", "dir"), {
    ok: true, path: "sub/new-dir",
  });
  assert.equal((await stat(join(root, "sub/new-dir"))).isDirectory(), true);
  assert.ok("error" in await remoteCreateEntry(d, "testhost", root, "sub/new.txt", "file"));
  assert.ok("error" in await remoteCreateEntry(d, "testhost", root, "../escape", "dir"));
});

test("remoteRunCommand runs a bounded one-shot command in the remote project", async () => {
  const d = await deps();
  const root = await mkdtemp(join(tmpdir(), "qiyan-rexec-"));
  const ok = await remoteRunCommand(d, "testhost", root, "printf 'remote ok\\n'; pwd", {
    maxBytes: 4096, timeoutMs: 5_000,
  });
  assert.equal(ok.exitCode, 0);
  assert.match(ok.stdout, /remote ok/);
  assert.match(ok.stdout, new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  const nonzero = await remoteRunCommand(d, "testhost", root, "printf 'bad\\n' >&2; exit 7", {
    maxBytes: 4096, timeoutMs: 5_000,
  });
  assert.equal(nonzero.exitCode, 7);
  assert.match(nonzero.stderr, /bad/);
  const reservedLookingExit = await remoteRunCommand(d, "testhost", root, "exit 6", {
    maxBytes: 4096, timeoutMs: 5_000,
  });
  assert.equal(reservedLookingExit.exitCode, 6);
  assert.equal(reservedLookingExit.error, undefined);
  const sshReservedExit = await remoteRunCommand(d, "testhost", root, "exit 255", {
    maxBytes: 4096, timeoutMs: 5_000,
  });
  assert.equal(sshReservedExit.exitCode, 255);
  assert.equal(sshReservedExit.error, undefined);
  assert.equal((await remoteRunCommand(d, "testhost", root, "vim x", {
    maxBytes: 4096, timeoutMs: 5_000,
  })).error, "blocked");
  const noninteractive = await remoteRunCommand(
    d,
    "testhost",
    root,
    "printf '%s' \"$PAGER,$SYSTEMD_PAGER,$MANPAGER,$GIT_TERMINAL_PROMPT,$GCM_INTERACTIVE,$SSH_ASKPASS_REQUIRE\"",
    { maxBytes: 4096, timeoutMs: 5_000 },
  );
  assert.equal(noninteractive.stdout, "cat,cat,cat,0,Never,force");
  const timedOut = await remoteRunCommand(d, "testhost", root, "trap '' TERM; sleep 30 & pid=$!; awk '{print $1, $22}' /proc/$pid/stat; wait", {
    maxBytes: 4096, timeoutMs: 1_000,
  });
  assert.equal(timedOut.timedOut, true);
  const [timedOutPidRaw, timedOutStart] = timedOut.stdout.trim().split(/\s+/u);
  const timedOutPid = Number(timedOutPidRaw);
  assert.ok(Number.isSafeInteger(timedOutPid) && timedOutPid > 1);
  assert.ok(timedOutStart);
  await assertProcessStopped(timedOutPid, timedOutStart!);
  const truncated = await remoteRunCommand(d, "testhost", root, "yes abcdefgh | head -c 100000", {
    maxBytes: 1024, timeoutMs: 5_000,
  });
  assert.equal(truncated.truncated, true);
  assert.ok(Buffer.byteLength(truncated.stdout) <= 1024);
  const backgrounded = await remoteRunCommand(d, "testhost", root, "sleep 30 & pid=$!; awk '{print $1, $22}' /proc/$pid/stat", {
    maxBytes: 4096, timeoutMs: 5_000,
  });
  assert.equal(backgrounded.exitCode, 0);
  const [backgroundPidRaw, backgroundStart] = backgrounded.stdout.trim().split(/\s+/u);
  const backgroundPid = Number(backgroundPidRaw);
  assert.ok(Number.isSafeInteger(backgroundPid) && backgroundPid > 1);
  assert.ok(backgroundStart);
  await assertProcessStopped(backgroundPid, backgroundStart!);
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
