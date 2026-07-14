import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
}

// One-shot commands only — reject interactive/pager programs that would hang without a TTY.
const BLOCKED = /^\s*(sudo\s+)?(vi|vim|nvim|nano|emacs|less|more|man|top|htop|watch|ssh|telnet|ftp|sftp|python|python3|node|irb|ipython|psql|mysql|sqlite3|ncdu|fzf)\b/;

// Run `command` via `bash -lc` in `cwd`, non-interactively, with an output-byte cap and a timeout that
// escalates SIGTERM → SIGKILL. Output is not persisted by the caller; this is an ephemeral `!`-command.
export function runCommand(cwd: string, command: string, opts: { maxBytes: number; timeoutMs: number }): Promise<ExecResult> {
  if (BLOCKED.test(command)) return Promise.resolve({ stdout: "", stderr: "interactive commands aren't supported here", exitCode: null, timedOut: false, truncated: false, error: "blocked" });
  return new Promise((resolveResult) => {
    // `detached` makes bash a process-group leader so we can kill the WHOLE group — a backgrounded
    // grandchild (`sleep 300 &`) would otherwise orphan, hold the stdout pipe, and hang the response.
    const child = spawn("bash", ["-lc", command], { cwd, detached: true, env: { ...process.env, TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" } });
    let stdout = "", stderr = "", size = 0, truncated = false, timedOut = false, settled = false;
    let exitCode: number | null = null, errorMsg: string | undefined;
    const killGroup = (sig: NodeJS.Signals): void => { try { if (child.pid) process.kill(-child.pid, sig); } catch { /* already gone */ } };
    const append = (buf: Buffer, add: (s: string) => void): void => {
      if (size >= opts.maxBytes) return;
      const chunk = buf.subarray(0, opts.maxBytes - size);
      size += chunk.length; add(chunk.toString("utf-8"));
      if (size >= opts.maxBytes) { truncated = true; killGroup("SIGKILL"); }
    };
    child.stdout.on("data", (b: Buffer) => append(b, (s) => { stdout += s; }));
    child.stderr.on("data", (b: Buffer) => append(b, (s) => { stderr += s; }));
    const timer = setTimeout(() => { timedOut = true; killGroup("SIGTERM"); setTimeout(() => killGroup("SIGKILL"), 2000).unref?.(); }, opts.timeoutMs);
    // Backstop: resolve even if `close` never fires (a detached grandchild holding the pipe).
    const hard = setTimeout(() => { killGroup("SIGKILL"); finish(); }, opts.timeoutMs + 5000); hard.unref?.();
    const finish = (): void => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(hard); resolveResult({ stdout, stderr, exitCode, timedOut, truncated, ...(errorMsg ? { error: errorMsg } : {}) }); };
    child.on("close", (code) => { exitCode = code; finish(); });
    child.on("error", (e) => { errorMsg = e.message; finish(); });
    child.stdin.end();
  });
}
