// Remote Claude command runner (Phase 1.x remote) — `claude -p` on another host over
// ssh, reusing the endpoint's ControlMaster (the user emphasized remote Claude is "just
// another -p over ssh", far simpler than remote Codex: no daemon, no forwarding). It
// implements the same ClaudeCommandRunner seam as the local runner, so the runtime is
// unchanged.
import { spawn, type ChildProcess } from "node:child_process";
import { buildClaudeArgs, type ClaudeCommandRunner, type ClaudeTurnHandle, type ClaudeTurnRequest } from "./claude-command-runner.ts";
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
}
