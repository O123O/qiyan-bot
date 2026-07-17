// Remote Claude command runner (Phase 1.x remote) — `claude -p` on another host over
// ssh, reusing the endpoint's ControlMaster (the user emphasized remote Claude is "just
// another -p over ssh", far simpler than remote Codex: no daemon, no forwarding). It
// implements the same ClaudeCommandRunner seam as the local runner, so the runtime is
// unchanged.
import { spawn, type ChildProcess } from "node:child_process";
import { Buffer } from "node:buffer";
import { AppError } from "../core/errors.ts";
import {
  buildClaudeArgs,
  claudePreviewFromRecords,
  type ClaudeCommandRunner,
  type ClaudeThreadMeta,
  type ClaudeTranscriptChunk,
  type ClaudeTranscriptChunkRequest,
  type ClaudeTranscriptSnapshot,
  type ClaudeTurnHandle,
  type ClaudeTurnRequest,
} from "./claude-command-runner.ts";
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

  async readTranscriptChunk(
    threadId: string,
    cwd: string,
    request: ClaudeTranscriptChunkRequest,
  ): Promise<ClaudeTranscriptChunk | undefined> {
    const path = await this.transcriptPath(threadId, cwd);
    if (!path) return undefined;
    if (!Number.isSafeInteger(request.length) || request.length <= 0) {
      throw new AppError("CONFIGURATION_ERROR", "invalid Claude transcript chunk length");
    }
    const script = [
      "const fs=require('fs')",
      "const p=process.argv[1]",
      "const requested=process.argv[2]",
      "const length=Number(process.argv[3])",
      "const expected=process.argv[4]?JSON.parse(Buffer.from(process.argv[4],'base64url').toString('utf8')):null",
      "const fd=fs.openSync(p,'r')",
      "try{",
      "const s=fs.fstatSync(fd)",
      "const snap={device:String(s.dev),inode:String(s.ino),size:s.size}",
      "if(expected&&(snap.device!==expected.device||snap.inode!==expected.inode||snap.size!==expected.size))process.exit(3)",
      "const offset=requested==='tail'?Math.max(0,s.size-length):Number(requested)",
      "if(!Number.isSafeInteger(offset)||offset<0||offset>s.size)process.exit(4)",
      "const b=Buffer.alloc(Math.min(length,s.size-offset))",
      "const n=fs.readSync(fd,b,0,b.length,offset)",
      "const a=fs.fstatSync(fd)",
      "if(String(a.dev)!==snap.device||String(a.ino)!==snap.inode||a.size!==snap.size)process.exit(5)",
      "process.stdout.write(JSON.stringify({snapshot:snap,offset,data:b.subarray(0,n).toString('base64')}))",
      "}finally{fs.closeSync(fd)}",
    ].join(";");
    const expected = request.expected === undefined
      ? ""
      : Buffer.from(JSON.stringify(request.expected), "utf8").toString("base64url");
    const output = await this.runCapture(
      `node -e ${shq(script)} ${shq(path)} ${shq(String(request.offset))} ${shq(String(request.length))} ${shq(expected)}`,
      Math.ceil(request.length * 4 / 3) + 4_096,
    );
    let parsed: unknown;
    try { parsed = JSON.parse(output); }
    catch { throw new AppError("OPERATION_UNCERTAIN", "remote Claude transcript chunk was invalid"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AppError("OPERATION_UNCERTAIN", "remote Claude transcript chunk was invalid");
    }
    const value = parsed as { snapshot?: unknown; offset?: unknown; data?: unknown };
    const snapshot = parseSnapshot(value.snapshot);
    if (!Number.isSafeInteger(value.offset) || typeof value.data !== "string") {
      throw new AppError("OPERATION_UNCERTAIN", "remote Claude transcript chunk was invalid");
    }
    const bytes = Buffer.from(value.data, "base64");
    if (bytes.length > request.length) {
      throw new AppError("OPERATION_UNCERTAIN", "remote Claude transcript exceeded its requested bound");
    }
    return { snapshot, offset: Number(value.offset), bytes };
  }

  async transcriptPath(threadId: string, _cwd?: string): Promise<string | undefined> {
    const cached = this.pathCache.get(threadId);
    if (cached) return cached;
    const found = (await this.runCapture(`find ~/.claude/projects -name ${shq(`${threadId}.jsonl`)} -print 2>/dev/null | head -1`, 128 * 1024)).trim();
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
    const text = await this.runCapture(script, 4 * 1024 * 1024);
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

  private async runCapture(remoteCommand: string, maxBytes: number): Promise<string> {
    try { await this.attest(); }
    catch (error) { throw new AppError("ENDPOINT_UNAVAILABLE", `Claude SSH attestation failed: ${error instanceof Error ? error.message : String(error)}`); }
    return new Promise((resolve, reject) => {
      const child = this.spawnSsh(remoteCommand);
      let settled = false;
      let bytes = 0;
      let out = "";
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        reject(error);
      };
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk, "utf8");
        if (bytes > maxBytes) {
          fail(new AppError("OPERATION_UNCERTAIN", "remote Claude command exceeded its output bound"));
          return;
        }
        out += chunk;
      });
      child.stdin!.end();
      child.once("error", (error) => fail(error));
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        if (code === 0) resolve(out);
        else reject(new AppError("OPERATION_UNCERTAIN", `remote Claude command exited with status ${String(code)}`));
      });
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

function parseSnapshot(value: unknown): ClaudeTranscriptSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("OPERATION_UNCERTAIN", "remote Claude transcript snapshot was invalid");
  }
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.device !== "string" || typeof snapshot.inode !== "string"
    || !Number.isSafeInteger(snapshot.size) || Number(snapshot.size) < 0) {
    throw new AppError("OPERATION_UNCERTAIN", "remote Claude transcript snapshot was invalid");
  }
  return { device: snapshot.device, inode: snapshot.inode, size: Number(snapshot.size) };
}
