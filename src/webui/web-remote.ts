import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { buildSshStreamArgs, parseSshConfig, planSshConnection, type SshConnectionPlan } from "../endpoints/ssh-config.ts";
import { runBoundedProcess } from "../endpoints/ssh-process.ts";
import type { WebFilesResult } from "./web-files.ts";
import { parseGitStatus, type GitStatus } from "./web-git.ts";

// Remote file/git access for the web UI over ssh. REUSES the core's ssh-config machinery: the plan
// forces `-o ControlMaster=no` (ride the master the core established, never create one), and untrusted
// paths are POSIX-single-quoted into a `bash -c` command so the remote login shell can't reparse them.
// No edits to the core endpoint layer — web-UI-only.

export interface RemoteDeps { sshBinary: string; sshRuntimeRoot: string }

// POSIX single-quote: makes any bytes a literal in the remote shell (only `'` needs escaping).
const q = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

const PLAN_TTL_MS = 60_000;
const planCache = new Map<string, { plan: SshConnectionPlan; at: number }>();
async function planFor(deps: RemoteDeps, host: string): Promise<SshConnectionPlan> {
  const cached = planCache.get(host);
  if (cached && Date.now() - cached.at < PLAN_TTL_MS) return cached.plan;
  const probed = await runBoundedProcess(deps.sshBinary, ["-G", host], { timeoutMs: 15_000, maxOutputBytes: 1 << 20 });
  const plan = planSshConnection(host, parseSshConfig(probed.stdout.toString("utf8")), deps.sshRuntimeRoot);
  planCache.set(host, { plan, at: Date.now() });
  return plan;
}

// Confinement preamble on the remote: realpath the root (H3 — symlinked NFS homes) and the target
// (absolute path as-is, else root-relative), then prove containment. `"$root"` is quoted so glob chars
// in it are literal; only the trailing `/*` is a wildcard. Sets `$root` and `$t`.
function guard(root: string, path: string, absolute: boolean): string {
  return [
    `root=$(realpath -m -- ${q(root)}) || exit 3`,
    absolute ? `t=$(realpath -m -- ${q(path)}) || exit 3` : `t=$(realpath -m -- "$root/"${q(path)}) || exit 3`,
    `[ -n "$t" ] || exit 3`,
    `case "$t/" in "$root"/*) : ;; *) exit 4 ;; esac`,
  ].join("\n");
}

// The login shell only ever runs `exec bash -c '<script>'` — one argv element, sh- or csh-safe.
const sshArgs = (plan: SshConnectionPlan, script: string): string[] => buildSshStreamArgs(plan, `exec bash -c ${q(script)}`);

interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
async function run(deps: RemoteDeps, host: string, script: string, opts: { maxBytes: number; timeoutMs: number }): Promise<RunResult> {
  const plan = await planFor(deps, host);
  const child = spawn(deps.sshBinary, sshArgs(plan, script), { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve) => {
    let stdout = "", stderr = "", size = 0, timedOut = false, done = false;
    const cap = (buf: Buffer, add: (s: string) => void): void => { if (size >= opts.maxBytes) return; const c = buf.subarray(0, opts.maxBytes - size); size += c.length; add(c.toString("utf8")); };
    child.stdout.on("data", (b: Buffer) => cap(b, (s) => { stdout += s; }));
    child.stderr.on("data", (b: Buffer) => cap(b, (s) => { stderr += s; }));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs);
    const finish = (code: number | null): void => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); };
    child.on("close", (code) => finish(code));
    child.on("error", () => finish(null));
  });
}

const remoteError = (r: RunResult, fallback: string): string =>
  r.timedOut ? "remote timed out" : r.code === 255 ? "remote host not connected (ssh master down?)" : (r.stderr.trim() || fallback);

// --- File tree ---
export async function remoteBrowse(deps: RemoteDeps, host: string, root: string, rel: string): Promise<WebFilesResult> {
  const script = `${guard(root, rel === "" ? "." : rel, false)}\n[ -d "$t" ] || exit 6\nfind "$t" -maxdepth 1 -mindepth 1 -printf '%y\\t%P\\0'`;
  const r = await run(deps, host, script, { maxBytes: 4 << 20, timeoutMs: 15_000 });
  if (r.code === 4) return { error: "path not allowed" };
  if (r.code === 6) return { error: "not a directory" };
  if (r.code !== 0) return { error: remoteError(r, "browse failed") };
  const entries = r.stdout.split("\0").filter(Boolean).map((rec) => {
    const tab = rec.indexOf("\t");
    const kind = rec.slice(0, tab), name = rec.slice(tab + 1);
    return { name, type: kind === "d" ? "dir" as const : kind === "f" ? "file" as const : "other" as const };
  }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { kind: "dir", path: rel, entries };
}

// --- Streaming read (for /api/raw) ---
// The owner-only preview streams ANY file the remote user can read (a worker references files outside
// its project dir) — so, unlike browse/git, this is NOT confined to the project root. The remote OS's
// own read permission is the boundary: an absent/unreadable path exits non-zero → the caller returns
// 404. An absolute path is used as-is; a relative one is joined under the project root. `[ -f "$t" ]`
// guarantees a REGULAR file (not a dir/FIFO/device), so `cat` always makes progress and never blocks
// idle — it streams then exits, and on a client disconnect the caller kills this ssh child, which
// SIGPIPEs the remote `cat` on its next write. `q()` single-quotes the (untrusted) path so the remote
// shell can't reparse it; `cat --` blocks option injection. Caller pipes `.stdout`, kills on close, caps.
export async function remoteReadStream(deps: RemoteDeps, host: string, root: string, path: string): Promise<ChildProcessWithoutNullStreams> {
  const plan = await planFor(deps, host);
  const target = isAbsolute(path) ? path : `${root}/${path}`;
  const script = `t=${q(target)}\n[ -f "$t" ] || exit 5\nexec cat -- "$t"`;
  return spawn(deps.sshBinary, sshArgs(plan, script), { stdio: ["pipe", "pipe", "pipe"] });
}

// --- Git (mirrors web-git.ts over ssh) ---
// Run git in the confined repo dir (root/repo). git args are fixed flags + single-quoted paths, all
// `--`-separated by the callers, so a filename can't act as a git option.
async function gitRun(deps: RemoteDeps, host: string, root: string, repo: string, args: string[], timeoutMs = 20_000): Promise<RunResult> {
  const gitCmd = ["git", "-C", '"$t"', "-c", "core.quotePath=false", ...args].join(" ");
  const script = `${guard(root, repo === "" ? "." : repo, false)}\n[ -d "$t" ] || exit 6\n${gitCmd}`;
  return run(deps, host, script, { maxBytes: 8 << 20, timeoutMs });
}

export async function remoteGitStatus(deps: RemoteDeps, host: string, root: string, repo: string): Promise<GitStatus | { error: string }> {
  const inside = await gitRun(deps, host, root, repo, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code === 4) return { error: "path not allowed" };
  if (inside.stdout.trim() !== "true") return { error: inside.code === 255 ? remoteError(inside, "") : "not a git repository" };
  const r = await gitRun(deps, host, root, repo, ["status", "--porcelain=v1", "--branch"]);
  if (r.code !== 0 && !r.stdout) return { error: remoteError(r, "git status failed") };
  return parseGitStatus(r.stdout);
}

export async function remoteGitDiff(deps: RemoteDeps, host: string, root: string, repo: string, path: string, staged: boolean): Promise<{ diff: string } | { error: string }> {
  if (isAbsolute(path) || path.split(/[\\/]+/u).includes("..")) return { error: "path not allowed" };
  const primary = await gitRun(deps, host, root, repo, staged ? ["diff", "--cached", "--", q(path)] : ["diff", "--", q(path)]);
  if (primary.code === 4 || primary.code === 6) return { error: "repo not found" };
  if (primary.code === 255 || primary.timedOut) return { error: remoteError(primary, "diff failed") }; // ssh down ≠ "(no changes)"
  if (primary.stdout.trim()) return { diff: primary.stdout };
  if (!staged) {
    // Untracked whole-file diff: confine the FILE to the repo on the remote (realpath catches symlinks),
    // mirroring the local --no-index guard.
    const script = `${guard(root, repo === "" ? "." : repo, false)}\n[ -d "$t" ] || exit 6\nf=$(realpath -m -- "$t/"${q(path)}) || exit 4\ncase "$f/" in "$t"/*) : ;; *) exit 4 ;; esac\ngit -C "$t" diff --no-index -- /dev/null "$f"`;
    const untracked = await run(deps, host, script, { maxBytes: 8 << 20, timeoutMs: 20_000 });
    if (untracked.stdout.trim()) return { diff: untracked.stdout };
  }
  return { diff: primary.stdout || "(no changes)" };
}

export async function remoteGitStage(deps: RemoteDeps, host: string, root: string, repo: string, path: string): Promise<{ ok: true } | { error: string }> {
  const r = await gitRun(deps, host, root, repo, ["add", "--", q(path)]);
  return r.code === 0 ? { ok: true } : { error: remoteError(r, "stage failed") };
}
export async function remoteGitUnstage(deps: RemoteDeps, host: string, root: string, repo: string, path: string): Promise<{ ok: true } | { error: string }> {
  const r = await gitRun(deps, host, root, repo, ["reset", "-q", "HEAD", "--", q(path)]);
  return r.code === 0 ? { ok: true } : { error: remoteError(r, "unstage failed") };
}
export async function remoteGitCommit(deps: RemoteDeps, host: string, root: string, repo: string, message: string): Promise<{ ok: true; output: string } | { error: string }> {
  if (!message.trim()) return { error: "commit message required" };
  const r = await gitRun(deps, host, root, repo, ["commit", "-m", q(message)]);
  return r.code === 0 ? { ok: true, output: r.stdout.trim() } : { error: remoteError(r, "commit failed") };
}

// Bounded remote repo discovery: dirs containing `.git` under root, relative to root ("" = root repo).
export async function remoteDiscover(deps: RemoteDeps, host: string, root: string): Promise<string[]> {
  const script = `${guard(root, ".", false)}\ncd "$root" || exit 3\nfind . -maxdepth 5 \\( -name node_modules -o -name .venv -o -name dist -o -name build \\) -prune -o -name .git -printf '%h\\0' 2>/dev/null`;
  const r = await run(deps, host, script, { maxBytes: 256 << 10, timeoutMs: 20_000 });
  if (r.code !== 0 && !r.stdout) return [];
  const seen = new Set<string>();
  for (const parent of r.stdout.split("\0").filter(Boolean)) seen.add(parent === "." ? "" : parent.replace(/^\.\//, ""));
  return [...seen].slice(0, 50);
}
