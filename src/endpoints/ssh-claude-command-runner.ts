// Remote Claude backend. One endpoint-level tmux runtime and one persistent pane per
// thread survive SSH/QiYan reconnects; each turn still invokes one ordinary `claude -p`
// process through the same ClaudeCommandRunner seam used by local Claude.
import { spawn, type ChildProcess } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import { Readable } from "node:stream";
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
import type { ClaudePersistentRuntime } from "./claude-runtime.ts";
import { buildSshStreamArgs, type SshConnectionPlan } from "./ssh-config.ts";
import type { ReadyProcessStream } from "./ssh-process.ts";
import {
  attestUserControlMaster,
  REMOTE_CLAUDE_RUNTIME_WATCH_READY,
  REMOTE_CLAUDE_TURN_WATCH_READY,
  type RemoteHost,
  type RemoteTransferClient,
} from "./ssh-runtime.ts";
import { parseRuntimeIdentity, type EndpointLossKind, type EndpointLossReason, type RuntimeIdentity } from "./types.ts";

// POSIX single-quote so an arbitrary string is one literal token to the remote shell.
function shq(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }

interface RemoteTurn {
  status: "running";
  paneId: string;
  turnId: string;
  dispatchToken: string;
  identity: Extract<RuntimeIdentity, { kind: "ssh" }>;
}

interface TurnObserver {
  stopped: boolean;
  stream?: ReadyProcessStream;
}

const TURN_OBSERVER_FAILURE_LIMIT = 3;
const TURN_OBSERVER_BACKOFF_MS = 250;

export class SshClaudeCommandRunner implements ClaudeCommandRunner, ClaudePersistentRuntime {
  private readonly pathCache = new Map<string, string>();
  private readonly unavailableListeners = new Set<(kind: EndpointLossKind, reason?: EndpointLossReason) => void>();
  private readonly turnObservers = new Set<TurnObserver>();
  private runtimeWatch?: ReadyProcessStream;
  private expectedRuntime?: RuntimeIdentity;
  private claudeCommand?: string;
  private closing = false;
  private lossReported = false;

  constructor(private readonly options: {
    plan: SshConnectionPlan;
    host: RemoteHost & { shell: string; remote: RemoteHost["remote"] & RemoteTransferClient };
    sshBinary?: string;
  }) {}

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

  async start(): Promise<void> {
    this.closing = false;
    this.lossReported = false;
    const token = randomBytes(16).toString("hex");
    const result = await this.options.host.remote.invoke<{ identity: unknown; claudePath: unknown }>(
      "start-claude-runtime",
      [JSON.stringify({ ...this.runtimeRequest(), shell: this.options.host.shell, token })],
      this.options.host.remoteHelperPath,
    );
    const identity = parseRuntimeIdentity(result.identity);
    if (identity.kind !== "ssh" || typeof result.claudePath !== "string" || !/^\/[A-Za-z0-9_./+-]+$/u.test(result.claudePath)) {
      throw new AppError("ENDPOINT_UNAVAILABLE", "remote Claude runtime returned invalid launch metadata");
    }
    this.expectedRuntime = identity;
    this.claudeCommand = result.claudePath;
    await this.openRuntimeWatch(identity);
  }

  async closeConnection(): Promise<void> {
    this.closing = true;
    await this.detachStreams();
    await this.options.host.remote.closeControlMaster?.();
  }

  async shutdownRuntime(expectedIdentity: RuntimeIdentity): Promise<void> {
    if (expectedIdentity.kind !== "ssh") throw new AppError("OPERATION_CONFLICT", "exact SSH runtime identity is required for shutdown");
    this.closing = true;
    await this.detachStreams();
    try {
      await this.options.host.remote.invoke("stop-claude-runtime", [JSON.stringify({
        ...this.runtimeRequest(),
        expected: expectedIdentity,
      })], this.options.host.remoteHelperPath);
    } finally {
      await this.options.host.remote.closeControlMaster?.();
    }
  }

  async runtimeIdentity(): Promise<RuntimeIdentity | undefined> {
    const state = await this.inspectRuntime();
    if (state.status === "absent") return undefined;
    if (!state.identity) throw new AppError("OPERATION_UNCERTAIN", "remote Claude runtime identity is unavailable");
    return state.identity;
  }

  onUnavailable(listener: (kind: EndpointLossKind, reason?: EndpointLossReason) => void): () => void {
    this.unavailableListeners.add(listener);
    return () => this.unavailableListeners.delete(listener);
  }

  async startTurn(request: ClaudeTurnRequest): Promise<ClaudeTurnHandle> {
    if (!this.expectedRuntime || !this.claudeCommand) {
      throw new AppError("ENDPOINT_UNAVAILABLE", "remote Claude runtime is not connected");
    }
    const turnId = /<!--\s*qiyan-cid:([A-Za-z0-9:_.-]{1,256})\s*-->/u.exec(request.message)?.[1];
    if (!turnId) throw new AppError("CONFIGURATION_ERROR", "remote Claude turn is missing its client marker");
    const config = Buffer.from(JSON.stringify({
      version: 1,
      threadId: request.threadId,
      cwd: request.cwd,
      home: this.options.host.remoteHome,
      command: this.claudeCommand,
      args: buildClaudeArgs(request),
    }), "utf8");
    const configSha256 = createHash("sha256").update(config).digest("hex");
    const configured = await this.options.host.remote.invokeTransfer?.<{ path: string }>(
      "configure-claude-thread",
      [JSON.stringify({
        ...this.runtimeRequest(),
        threadId: request.threadId,
        size: config.byteLength,
        sha256: configSha256,
      })],
      { input: Readable.from([config]), maxOutputBytes: 64 * 1024, timeoutMs: 30_000 },
      this.options.host.remoteHelperPath,
    );
    if (!configured) throw new AppError("CONFIGURATION_ERROR", "remote Claude transfer support is unavailable");
    const prompt = Buffer.from(request.message, "utf8");
    const dispatchToken = randomBytes(16).toString("hex");
    const dispatched = await this.options.host.remote.invokeTransfer?.<RemoteTurn | {
      status: "settled";
      paneId: string;
      turnId: string;
      dispatchToken: string;
    }>(
      "dispatch-claude-turn",
      [JSON.stringify({
        ...this.runtimeRequest(),
        threadId: request.threadId,
        turnId,
        dispatchToken,
        configPath: configured.path,
        shell: this.options.host.shell,
        home: this.options.host.remoteHome,
        size: prompt.byteLength,
        sha256: createHash("sha256").update(prompt).digest("hex"),
      })],
      { input: Readable.from([prompt]), maxOutputBytes: 64 * 1024, timeoutMs: 45_000 },
      this.options.host.remoteHelperPath,
    );
    if (!dispatched || dispatched.turnId !== turnId || dispatched.dispatchToken !== dispatchToken) {
      throw new AppError("OPERATION_UNCERTAIN", "remote Claude dispatch returned invalid acknowledgement");
    }
    if (dispatched.status === "settled") {
      return { done: Promise.resolve("completed"), interrupt: () => undefined };
    }
    const identity = parseRuntimeIdentity(dispatched.identity);
    if (identity.kind !== "ssh") throw new AppError("OPERATION_UNCERTAIN", "remote Claude turn returned invalid identity");
    return this.turnHandle(request.threadId, { ...dispatched, identity });
  }

  async recoverTurn(threadId: string, _cwd: string): Promise<{ turnId: string; handle: ClaudeTurnHandle } | undefined> {
    const inspected = await this.inspectTurn(threadId);
    if (inspected.status !== "running") return undefined;
    return { turnId: inspected.turnId, handle: this.turnHandle(threadId, inspected) };
  }

  async releaseThread(threadId: string): Promise<void> {
    await this.options.host.remote.invoke("release-claude-thread", [JSON.stringify({
      ...this.runtimeRequest(),
      threadId,
    })], this.options.host.remoteHelperPath);
    this.pathCache.delete(threadId);
  }

  private runtimeRequest(): {
    runtimeDir: string;
    session: string;
    tmuxMode: "explicit";
  } {
    return {
      runtimeDir: this.options.host.remoteRuntimeDir,
      session: `qiyan-${posix.basename(this.options.host.remoteRuntimeDir)}`,
      tmuxMode: "explicit",
    };
  }

  private async inspectRuntime(): Promise<
    { status: "absent" }
    | { status: "unhealthy"; identity?: RuntimeIdentity }
    | { status: "healthy"; identity: RuntimeIdentity }
  > {
    const raw = await this.options.host.remote.invoke<any>(
      "inspect-claude-runtime",
      [JSON.stringify(this.runtimeRequest())],
      this.options.host.remoteHelperPath,
    );
    if (raw?.status === "absent") return { status: "absent" };
    if (raw?.status === "unhealthy") {
      return {
        status: "unhealthy",
        ...(raw.identity === undefined ? {} : { identity: parseRuntimeIdentity(raw.identity) }),
      };
    }
    if (raw?.status !== "healthy") throw new AppError("ENDPOINT_UNAVAILABLE", "invalid remote Claude runtime inspection");
    return { status: "healthy", identity: parseRuntimeIdentity(raw.identity) };
  }

  private async inspectTurn(threadId: string): Promise<
    RemoteTurn | { status: "idle"; paneId?: string } | { status: "runtime-unavailable" }
  > {
    const raw = await this.options.host.remote.invoke<any>(
      "inspect-claude-turn",
      [JSON.stringify({ ...this.runtimeRequest(), threadId })],
      this.options.host.remoteHelperPath,
    );
    if (raw?.status === "runtime-unavailable") return { status: "runtime-unavailable" };
    if (raw?.status === "idle") {
      return { status: "idle", ...(typeof raw.paneId === "string" ? { paneId: raw.paneId } : {}) };
    }
    if (raw?.status !== "running" || typeof raw.paneId !== "string"
      || typeof raw.turnId !== "string" || typeof raw.dispatchToken !== "string") {
      throw new AppError("ENDPOINT_UNAVAILABLE", "invalid remote Claude turn inspection");
    }
    const identity = parseRuntimeIdentity(raw.identity);
    if (identity.kind !== "ssh") throw new AppError("ENDPOINT_UNAVAILABLE", "invalid remote Claude turn identity");
    return { ...raw, identity } as RemoteTurn;
  }

  private turnHandle(threadId: string, turn: RemoteTurn): ClaudeTurnHandle {
    const observer: TurnObserver = { stopped: false };
    this.turnObservers.add(observer);
    const done = this.observeTurn(threadId, turn, observer).finally(() => {
      this.turnObservers.delete(observer);
    });
    return {
      done,
      interrupt: async () => {
        await this.options.host.remote.invoke("interrupt-claude-turn", [JSON.stringify({
          ...this.runtimeRequest(),
          threadId,
          paneId: turn.paneId,
          expected: {
            runtimeToken: turn.identity.token,
            turnId: turn.turnId,
            dispatchToken: turn.dispatchToken,
            pid: turn.identity.pid,
            linuxStartTime: turn.identity.linuxStartTime,
            processGroupId: turn.identity.processGroupId,
          },
        })], this.options.host.remoteHelperPath);
      },
    };
  }

  private async observeTurn(
    threadId: string,
    turn: RemoteTurn,
    observer: TurnObserver,
  ): Promise<"completed"> {
    let failures = 0;
    while (!observer.stopped) {
      let inspected: Awaited<ReturnType<SshClaudeCommandRunner["inspectTurn"]>>;
      try { inspected = await this.inspectTurn(threadId); }
      catch {
        if (this.closing || observer.stopped) return await new Promise<never>(() => undefined);
        failures += 1;
        if (await this.handleObserverFailure(failures)) return await new Promise<never>(() => undefined);
        continue;
      }
      if (inspected.status === "runtime-unavailable") {
        failures += 1;
        if (await this.handleObserverFailure(failures)) return await new Promise<never>(() => undefined);
        continue;
      }
      if (inspected.status !== "running"
        || inspected.turnId !== turn.turnId
        || inspected.dispatchToken !== turn.dispatchToken
        || !sameIdentity(inspected.identity, turn.identity)) return "completed";
      const open = this.options.host.remote.openHelperStream;
      if (!open) throw new AppError("CONFIGURATION_ERROR", "remote Claude watch support is unavailable");
      try {
        const stream = await open.call(
          this.options.host.remote,
          "watch-claude-turn",
          {
            ...this.runtimeRequest(),
            threadId,
            paneId: turn.paneId,
            expected: {
              runtimeToken: turn.identity.token,
              turnId: turn.turnId,
              dispatchToken: turn.dispatchToken,
              pid: turn.identity.pid,
              linuxStartTime: turn.identity.linuxStartTime,
              processGroupId: turn.identity.processGroupId,
            },
          },
          REMOTE_CLAUDE_TURN_WATCH_READY,
          this.options.host.remoteHelperPath,
        );
        observer.stream = stream;
        await streamClosed(stream);
        if (this.closing || observer.stopped) return await new Promise<never>(() => undefined);
        failures += 1;
        if (await this.handleObserverFailure(failures)) return await new Promise<never>(() => undefined);
      } catch {
        if (this.closing || observer.stopped) return await new Promise<never>(() => undefined);
        failures += 1;
        if (await this.handleObserverFailure(failures)) return await new Promise<never>(() => undefined);
      } finally {
        delete observer.stream;
      }
    }
    return await new Promise<never>(() => undefined);
  }

  private async handleObserverFailure(failures: number): Promise<boolean> {
    let runtime: Awaited<ReturnType<SshClaudeCommandRunner["inspectRuntime"]>> | undefined;
    try { runtime = await this.inspectRuntime(); } catch { /* transport loss */ }
    const sameRuntime = runtime?.status === "healthy"
      && this.expectedRuntime !== undefined
      && sameIdentity(runtime.identity, this.expectedRuntime);
    if (!sameRuntime || failures >= TURN_OBSERVER_FAILURE_LIMIT) {
      await this.reportRuntimeLoss(runtime?.status === "absent" ? "runtime-lost" : "connection-lost");
      return true;
    }
    await new Promise((resolveWait) => {
      setTimeout(resolveWait, TURN_OBSERVER_BACKOFF_MS * (2 ** (failures - 1)));
    });
    return false;
  }

  private async openRuntimeWatch(expected: RuntimeIdentity): Promise<void> {
    const open = this.options.host.remote.openHelperStream;
    if (!open) throw new AppError("CONFIGURATION_ERROR", "remote Claude watch support is unavailable");
    const stream = await open.call(
      this.options.host.remote,
      "watch-claude-runtime",
      { ...this.runtimeRequest(), expected },
      REMOTE_CLAUDE_RUNTIME_WATCH_READY,
      this.options.host.remoteHelperPath,
    );
    this.runtimeWatch = stream;
    stream.onClose(() => {
      if (this.closing || this.runtimeWatch !== stream) return;
      delete this.runtimeWatch;
      void this.reportRuntimeLoss();
    });
  }

  private async reportRuntimeLoss(classifiedKind?: EndpointLossKind): Promise<void> {
    if (this.lossReported || this.closing) return;
    this.lossReported = true;
    let kind: EndpointLossKind = classifiedKind ?? "connection-lost";
    if (classifiedKind === undefined) {
      try {
        if ((await this.inspectRuntime()).status === "absent") kind = "runtime-lost";
      } catch { /* a failed fresh probe is connection loss */ }
    }
    if (this.closing) return;
    await this.detachStreams();
    for (const listener of this.unavailableListeners) listener(kind);
  }

  private async detachStreams(): Promise<void> {
    const streams: ReadyProcessStream[] = [];
    if (this.runtimeWatch) streams.push(this.runtimeWatch);
    delete this.runtimeWatch;
    for (const observer of this.turnObservers) {
      observer.stopped = true;
      if (observer.stream) streams.push(observer.stream);
      delete observer.stream;
    }
    this.turnObservers.clear();
    await Promise.allSettled(streams.map((stream) => stream.close()));
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

function streamClosed(stream: ReadyProcessStream): Promise<void> {
  return new Promise((resolve) => {
    const off = stream.onClose(() => {
      off();
      resolve();
    });
  });
}

function sameIdentity(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return left.kind === right.kind && (left.kind === "local"
    ? right.kind === "local" && left.pid === right.pid && left.startTime === right.startTime
    : right.kind === "ssh" && left.token === right.token && left.pid === right.pid
      && left.linuxStartTime === right.linuxStartTime && left.processGroupId === right.processGroupId);
}
