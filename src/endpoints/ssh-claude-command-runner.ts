// Remote Claude command runner (Phase 1.x remote) — `claude -p` on another host over
// ssh, reusing an existing ControlMaster (the user emphasized remote Claude is "just
// another -p over ssh", far simpler than remote Codex: no daemon, no forwarding). It
// implements the same ClaudeCommandRunner seam as the local runner, so the runtime is
// unchanged.
import { spawn } from "node:child_process";
import { buildClaudeArgs, type ClaudeCommandRunner, type ClaudeTurnHandle, type ClaudeTurnRequest } from "./claude-command-runner.ts";

// POSIX single-quote so an arbitrary string is one literal token to the remote shell.
function shq(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }

export class SshClaudeCommandRunner implements ClaudeCommandRunner {
  private readonly pathCache = new Map<string, string>();
  constructor(private readonly options: { host: string; sshBinary?: string; sshArgs?: readonly string[]; command?: string }) {}

  private ssh(remoteCommand: string, stdio: "pipe" | "ignore-out") {
    const args = [...(this.options.sshArgs ?? []), this.options.host, remoteCommand];
    return spawn(this.options.sshBinary ?? "ssh", args, { stdio: ["pipe", stdio === "pipe" ? "pipe" : "pipe", "ignore"] });
  }

  startTurn(request: ClaudeTurnRequest): ClaudeTurnHandle {
    // Prompt over stdin (no quoting / ARG_MAX); flags quoted for the remote shell.
    const flagArgs = buildClaudeArgs(request).map(shq).join(" ");
    const remote = `cd ${shq(request.cwd)} && exec ${this.options.command ?? "claude"} ${flagArgs}`;
    const child = this.ssh(remote, "pipe");
    let isError = false;
    let buffer = "";
    const consume = (line: string): void => {
      const t = line.trim();
      if (!t) return;
      try { const e = JSON.parse(t) as Record<string, unknown>; if (e.type === "result" && e.is_error === true) isError = true; } catch { /* ignore */ }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { buffer += chunk; let i: number; while ((i = buffer.indexOf("\n")) >= 0) { consume(buffer.slice(0, i)); buffer = buffer.slice(i + 1); } });
    child.stdin.on("error", () => { /* remote gone */ });
    child.stdin.end(request.message);
    const done = new Promise<"completed" | "failed">((resolve) => {
      child.once("error", () => resolve("failed"));
      child.once("close", (code) => { consume(buffer); resolve(code === 0 && !isError ? "completed" : "failed"); });
    });
    return { done, interrupt: () => { try { child.kill("SIGKILL"); } catch { /* gone */ } } };
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

  private runCapture(remoteCommand: string): Promise<string> {
    return new Promise((resolve) => {
      const child = this.ssh(remoteCommand, "pipe");
      let out = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (c: string) => { out += c; });
      child.stdin.end();
      child.once("error", () => resolve(""));
      child.once("close", () => resolve(out));
    });
  }
}
