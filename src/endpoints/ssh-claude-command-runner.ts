// Remote Claude command runner (Phase 1.x remote) — `claude -p` on another host over
// ssh, reusing the endpoint's ControlMaster (the user emphasized remote Claude is "just
// another -p over ssh", far simpler than remote Codex: no daemon, no forwarding). It
// implements the same ClaudeCommandRunner seam as the local runner, so the runtime is
// unchanged.
import { spawn, type ChildProcess } from "node:child_process";
import { buildClaudeArgs, claudePreviewFromRecords, type ClaudeCommandRunner, type ClaudeThreadMeta, type ClaudeTurnHandle, type ClaudeTurnRequest } from "./claude-command-runner.ts";
import { buildSshStreamArgs, type SshConnectionPlan } from "./ssh-config.ts";
import { attestUserControlMaster } from "./ssh-runtime.ts";

// POSIX single-quote so an arbitrary string is one literal token to the remote shell.
function shq(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }

export class SshClaudeCommandRunner implements ClaudeCommandRunner {
  private readonly pathCache = new Map<string, string>();
  constructor(private readonly options: { plan: SshConnectionPlan; sshBinary?: string; command?: string }) {}

  // Re-attest a user-owned ControlMaster before every ssh operation: the socket could
  // have been swapped between turns, so we prove its identity again (mirrors
  // SshRemoteClient.executePrepared, which attests before each helper invoke). A
  // QiYan-owned master needs no attestation (we created it on a private filesystem).
  private async attest(): Promise<void> {
    if (!this.options.plan.ownsControlMaster) await attestUserControlMaster(this.options.plan);
  }

  private spawnSsh(remoteCommand: string): ChildProcess {
    const args = buildSshStreamArgs(this.options.plan, remoteCommand);
    return spawn(this.options.sshBinary ?? "ssh", args, { stdio: ["pipe", "pipe", "ignore"] });
  }

  startTurn(request: ClaudeTurnRequest): ClaudeTurnHandle {
    // Prompt over stdin (no quoting / ARG_MAX); flags quoted for the remote shell.
    const flagArgs = buildClaudeArgs(request).map(shq).join(" ");
    const remote = `cd ${shq(request.cwd)} && exec ${this.options.command ?? "claude"} ${flagArgs}`;
    let child: ChildProcess | undefined;
    let interrupted = false;
    const done = (async (): Promise<"completed" | "failed"> => {
      try { await this.attest(); }
      catch { return "failed"; }               // hijacked/unsafe master → the turn cannot run
      if (interrupted) return "failed";
      const proc = this.spawnSsh(remote);
      child = proc;
      let isError = false;
      let buffer = "";
      const consume = (line: string): void => {
        const t = line.trim();
        if (!t) return;
        try { const e = JSON.parse(t) as Record<string, unknown>; if (e.type === "result" && e.is_error === true) isError = true; } catch { /* ignore */ }
      };
      proc.stdout!.setEncoding("utf8");
      proc.stdout!.on("data", (chunk: string) => { buffer += chunk; let i: number; while ((i = buffer.indexOf("\n")) >= 0) { consume(buffer.slice(0, i)); buffer = buffer.slice(i + 1); } });
      proc.stdin!.on("error", () => { /* remote gone */ });
      proc.stdin!.end(request.message);
      return await new Promise<"completed" | "failed">((resolve) => {
        proc.once("error", () => resolve("failed"));
        proc.once("close", (code) => { consume(buffer); resolve(code === 0 && !isError ? "completed" : "failed"); });
      });
    })();
    return { done, interrupt: () => { interrupted = true; try { child?.kill("SIGKILL"); } catch { /* gone */ } } };
  }

  async readTranscript(threadId: string, cwd: string): Promise<unknown[]> {
    const path = await this.transcriptPath(threadId, cwd);
    if (!path) return [];
    const text = await this.runCapture(`cat ${shq(path)}`);
    const records: unknown[] = [];
    for (const line of text.split("\n")) { const t = line.trim(); if (!t) continue; try { records.push(JSON.parse(t)); } catch { /* partial */ } }
    return records;
  }

  async transcriptPath(threadId: string, _cwd?: string): Promise<string | undefined> {
    const cached = this.pathCache.get(threadId);
    if (cached) return cached;
    const found = (await this.runCapture(`find ~/.claude/projects -name ${shq(`${threadId}.jsonl`)} -print 2>/dev/null | head -1`)).trim();
    if (!found) return undefined;
    this.pathCache.set(threadId, found);
    return found;
  }

  async listThreads(cwd?: string): Promise<ClaudeThreadMeta[]> {
    // One round-trip: per transcript emit a header (mtime + path) then ONLY the first USER
    // record — which carries both the cwd and the first user message the preview needs. This
    // keeps assistant/tool output (secrets) ON the host: only id/cwd/updatedAt/preview ever
    // cross the wire, and never any session's model output — not even for the human's own
    // unrelated cli/vscode sessions the scan also sees. Paths in the Claude store contain no
    // spaces (cwd-hash dir + <session-id>.jsonl), so the header is space-split.
    const script = "find ~/.claude/projects -maxdepth 2 -name '*.jsonl' 2>/dev/null | "
      + "while IFS= read -r f; do echo \"__QIYAN_H__ $(stat -c %Y \"$f\" 2>/dev/null) $f\"; "
      // `-E '"type": ?"user"'` tolerates compact OR pretty-printed serialization, so a future
      // format change can't SILENTLY drop every remote session from discover.
      + "grep -m1 -E '\"type\": ?\"user\"' \"$f\" 2>/dev/null; echo __QIYAN_EOT__; done";
    const text = await this.runCapture(script);
    const out: ClaudeThreadMeta[] = [];
    for (const block of text.split("__QIYAN_EOT__\n")) {
      const headerAt = block.indexOf("__QIYAN_H__ ");
      if (headerAt < 0) continue;
      const afterHeader = block.slice(headerAt + "__QIYAN_H__ ".length);
      const newline = afterHeader.indexOf("\n");
      if (newline < 0) continue;
      const header = afterHeader.slice(0, newline).split(" ");
      const mtime = Number(header[0]);
      const path = header.slice(1).join(" ");
      const id = path.split("/").pop()?.replace(/\.jsonl$/u, "") ?? "";
      if (!id) continue;
      const records: unknown[] = [];
      let recordCwd: string | undefined;
      for (const line of afterHeader.slice(newline + 1).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let record: unknown;
        try { record = JSON.parse(trimmed); } catch { continue; }
        records.push(record);
        if (recordCwd === undefined && record && typeof record === "object") {
          const value = (record as Record<string, unknown>).cwd;
          if (typeof value === "string" && value.length > 0) recordCwd = value;
        }
      }
      if (recordCwd === undefined || (cwd !== undefined && recordCwd !== cwd)) continue;
      out.push({ id, cwd: recordCwd, updatedAt: (Number.isFinite(mtime) ? mtime : 0) * 1000, preview: claudePreviewFromRecords(records) });
    }
    return out;
  }

  private async runCapture(remoteCommand: string): Promise<string> {
    try { await this.attest(); }
    catch { return ""; }
    return new Promise((resolve) => {
      const child = this.spawnSsh(remoteCommand);
      let out = ""; child.stdout!.setEncoding("utf8"); child.stdout!.on("data", (c: string) => { out += c; });
      child.stdin!.end();
      child.once("error", () => resolve(""));
      child.once("close", () => resolve(out));
    });
  }

  // Run a `monitor` check on the REMOTE worker's host. Resolves true only when the
  // command exits 0 (condition met); an attest/ssh failure resolves false so a dead
  // ControlMaster never fires a monitor. Mirrors the local runMonitorCheck semantics.
  // On timeout the local ssh client is killed but the remote command is not signalled
  // (no PTY), so a monitor check must be a fast predicate, not a long-running command.
  async runShellCheck(command: string, timeoutMs = 20_000): Promise<boolean> {
    try { await this.attest(); }
    catch { return false; }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok); };
      const timer = setTimeout(() => { try { child?.kill("SIGKILL"); } catch { /* already gone */ } finish(false); }, timeoutMs);
      timer.unref?.();
      let child: ReturnType<typeof this.spawnSsh> | undefined;
      try { child = this.spawnSsh(`bash -c ${shq(command)}`); }
      catch { finish(false); return; }
      child.stdout?.resume(); // drain; only the exit code matters
      child.stdin!.end();
      child.once("error", () => finish(false));
      child.once("close", (code) => finish(code === 0));
    });
  }
}
