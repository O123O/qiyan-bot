import { execFile } from "node:child_process";

// Run `git` in `dir` with argument vectors (no shell — paths/messages are args, so no injection).
function git(dir: string, args: string[], timeoutMs = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    execFile("git", ["-C", dir, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolveResult({ code, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  changes: string[];   // unstaged worktree changes
  untracked: string[];
}

export async function gitStatus(dir: string): Promise<GitStatus | { error: string }> {
  const inside = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.stdout.trim() !== "true") return { error: "not a git repository" };
  const r = await git(dir, ["status", "--porcelain=v1", "--branch"]);
  if (r.code !== 0 && !r.stdout) return { error: r.stderr.trim() || "git status failed" };
  let branch = "", ahead = 0, behind = 0;
  const staged: string[] = [], changes: string[] = [], untracked: string[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      const head = line.slice(3);
      const noCommits = /^No commits yet on (.+)$/.exec(head); // fresh repo header
      branch = noCommits ? noCommits[1]!.trim() : head.split("...")[0]!.split(" ")[0]!;
      ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0);
      behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0);
      continue;
    }
    const xy = line.slice(0, 2);
    const path = line.slice(3).replace(/^.* -> /, ""); // rename → new path
    if (xy === "??") { untracked.push(path); continue; }
    if (xy[0] !== " " && xy[0] !== "?") staged.push(path);
    if (xy[1] !== " " && xy[1] !== "?") changes.push(path);
  }
  return { branch, ahead, behind, staged, changes, untracked };
}

// Unified diff for a path. `staged` → index diff; otherwise the worktree diff, falling back to a
// whole-file diff for an untracked file.
export async function gitDiff(dir: string, path: string, staged: boolean): Promise<{ diff: string } | { error: string }> {
  const inside = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.stdout.trim() !== "true") return { error: "not a git repository" };
  const primary = await git(dir, staged ? ["diff", "--cached", "--", path] : ["diff", "--", path]);
  if (primary.stdout.trim()) return { diff: primary.stdout };
  if (!staged) { const untracked = await git(dir, ["diff", "--no-index", "--", "/dev/null", path]); if (untracked.stdout.trim()) return { diff: untracked.stdout }; }
  return { diff: primary.stdout || "(no changes)" };
}

export async function gitStage(dir: string, path: string): Promise<{ ok: true } | { error: string }> {
  const r = await git(dir, ["add", "--", path]);
  return r.code === 0 ? { ok: true } : { error: r.stderr.trim() || "stage failed" };
}

export async function gitUnstage(dir: string, path: string): Promise<{ ok: true } | { error: string }> {
  const r = await git(dir, ["reset", "-q", "HEAD", "--", path]);
  return r.code === 0 ? { ok: true } : { error: r.stderr.trim() || "unstage failed" };
}

export async function gitCommit(dir: string, message: string): Promise<{ ok: true; output: string } | { error: string }> {
  if (!message.trim()) return { error: "commit message required" };
  const r = await git(dir, ["commit", "-m", message]);
  return r.code === 0 ? { ok: true, output: r.stdout.trim() } : { error: (r.stderr || r.stdout).trim() || "commit failed" };
}
