// Remote Claude runtime: the tmux-supervised `qiyan-claude-host` on the worker's machine,
// and the attested ssh channel QiYan talks to it over.
//
// This is the Codex app-server pattern with a different server. One long-lived process per
// endpoint generation owns an owner-only unix socket in the shared runtime directory; the
// helper proxies raw bytes to it over ssh; the process is identified by the runtime token it
// carries in its own /proc environ. Nothing about a Claude session lives here — the sessions
// are ClaudeHostSession actors inside that process, which is exactly why a remote turn now
// survives a QiYan restart and an ssh drop.
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { AppError } from "../core/errors.ts";
import { CLAUDE_HOST_PROTOCOL_VERSION } from "../claude-host/protocol.ts";
import { RemoteClaudeHost, type HostChannel } from "../claude-host/transport.ts";
import type { ClaudePersistentRuntime, ClaudeReattachment } from "./claude-runtime.ts";
import type { ReadyProcessStream } from "./ssh-process.ts";
import type { RemoteHost } from "./ssh-runtime.ts";
import { parseRuntimeIdentity, type EndpointLossKind, type RuntimeIdentity } from "./types.ts";

// What the channel opener needs from the runtime. Separate from the class so the adapter is
// testable on its own and the direction of the dependency stays one-way.
export interface ClaudeHostRuntimeController {
  attestStarted(): Promise<RuntimeIdentity>;
  openClaudeHostStream(expected: RuntimeIdentity): Promise<ReadyProcessStream>;
  onChannelLost(): void;
}

// Adapts a proxied ssh process to the duplex channel RemoteClaudeHost dials.
export function sshClaudeHostChannel(runtime: ClaudeHostRuntimeController): () => Promise<HostChannel> {
  return async () => {
    // Attest on EVERY dial, not once at start: the client reconnects lazily, so a channel
    // opened after the host was replaced would otherwise be trusted as the host we started —
    // and its sessions died with it.
    const expected = await runtime.attestStarted();
    const stream = await runtime.openClaudeHostStream(expected);
    stream.onClose(() => runtime.onChannelLost());
    return {
      input: stream.input,
      output: stream.output,
      // The client closes synchronously; the ssh child's teardown is asynchronous and
      // self-reaping, so nothing waits on it here.
      close: () => { void stream.close(); },
    };
  };
}

export class SshClaudeHostRuntime implements ClaudePersistentRuntime, ClaudeHostRuntimeController {
  // The ClaudeHost the endpoint runs turns through. Owned here because the channel it dials
  // is this runtime's attested one; the endpoint only ever sees the ClaudeHost interface.
  readonly host: RemoteClaudeHost;
  private readonly unavailableListeners = new Set<(kind: EndpointLossKind) => void>();
  private pinned?: RuntimeIdentity;
  private closing = false;
  private lossReported = false;

  constructor(private readonly options: {
    endpointId: string;
    host: RemoteHost & { shell: string };
  }) {
    this.host = new RemoteClaudeHost(sshClaudeHostChannel(this));
  }

  async start(): Promise<void> {
    this.closing = false;
    this.lossReported = false;
    // A stopped endpoint is started again in place, and closeConnection/shutdownRuntime shut
    // this client down. Release that latch first or every call below — including the dial in
    // hostStatus — refuses against a host that is perfectly healthy.
    this.host.reopen();
    // Pin before the first dial: attestStarted compares against this, and hostStatus below
    // is what performs that dial.
    this.pinned = await this.ensureStarted();
    // Prove the socket is served by a host this build can speak to, rather than trusting a
    // live process and a bound socket. A protocol mismatch must fail activation loudly, not
    // surface later as an unexplained turn failure.
    const status = await this.host.hostStatus();
    if (status.protocolVersion !== CLAUDE_HOST_PROTOCOL_VERSION) {
      throw new AppError("UNSUPPORTED_CAPABILITY",
        `remote Claude host '${this.options.endpointId}' speaks protocol ${status.protocolVersion}, `
        + `this build speaks ${CLAUDE_HOST_PROTOCOL_VERSION}; upgrade both ends`);
    }
  }

  async closeConnection(): Promise<void> {
    this.closing = true;
    // The host keeps running on the worker's machine — that is the point. Only this client
    // goes away, so an in-flight turn is still there to adopt on the next activation.
    await this.host.shutdown();
    await this.options.host.remote.closeControlMaster?.();
  }

  async shutdownRuntime(expectedIdentity: RuntimeIdentity): Promise<void> {
    if (expectedIdentity.kind !== "ssh") throw new AppError("OPERATION_CONFLICT", "exact SSH runtime identity is required for shutdown");
    this.closing = true;
    await this.host.shutdown();
    try {
      await this.invoke("stop-claude-host", { ...this.runtimeRequest(), expected: expectedIdentity });
    } finally {
      await this.options.host.remote.closeControlMaster?.();
    }
  }

  async runtimeIdentity(): Promise<RuntimeIdentity | undefined> {
    const state = await this.inspect();
    if (state.status === "absent") return undefined;
    if (!state.identity) throw new AppError("OPERATION_UNCERTAIN", "remote Claude host identity is unavailable");
    return state.identity;
  }

  onUnavailable(listener: (kind: EndpointLossKind) => void): () => void {
    this.unavailableListeners.add(listener);
    return () => this.unavailableListeners.delete(listener);
  }

  // Reconnect-time reattach. The host is authoritative about what is still running, so this
  // is one status call — no PID marker, no transcript materialization scan.
  //
  // A turn is not the only thing worth adopting. A session whose turn ended while a subagent
  // kept running has no in-flight turn and is still busy; reporting nothing for it made every
  // restart re-learn the session as idle, so archive would close it — and close the SDK query
  // the subagent was running in — on the strength of that.
  async recoverTurn(threadId: string): Promise<ClaudeReattachment | undefined> {
    let status;
    try { status = await this.host.status(threadId); }
    catch (error) {
      // The host never loaded this session (it was replaced, or the thread has not run a
      // turn on this generation), so there is nothing to adopt.
      if (error instanceof AppError && error.code === "UNKNOWN_SESSION") return undefined;
      throw error;
    }
    const turnId = status.activity === "working" ? status.inFlightTurns[0] : undefined;
    const activity = {
      backgroundTasks: status.backgroundTasks.filter((task) => task.kind !== "subagent").length,
      subagents: status.backgroundTasks.filter((task) => task.kind === "subagent").length,
    };
    const running = activity.backgroundTasks + activity.subagents > 0;
    if (turnId === undefined && !running) return undefined;
    return {
      ...(turnId === undefined ? {} : { turnId }),
      ...(running ? { activity } : {}),
    };
  }

  // Unloading the session IS the release: Claude's transcript is durable and stays, and the
  // host drops a session it never loaded without complaint.
  async releaseThread(threadId: string): Promise<void> {
    await this.host.close(threadId);
  }

  async attestStarted(): Promise<RuntimeIdentity> {
    const pinned = this.pinned;
    if (!pinned) throw new AppError("ENDPOINT_UNAVAILABLE", `remote Claude host is not started: ${this.options.endpointId}`);
    const current = await this.inspect();
    if (current.status !== "healthy" || !sameSshIdentity(current.identity, pinned)) {
      // Dialling the replacement would hand QiYan a host that has never heard of the threads
      // it believes are loaded, so report the generation lost and let the endpoint rebuild.
      this.reportLoss(current.status === "absent" ? "runtime-lost" : "connection-lost");
      throw new AppError("ENDPOINT_UNAVAILABLE", `remote Claude host was replaced: ${this.options.endpointId}`);
    }
    return pinned;
  }

  async openClaudeHostStream(expected: RuntimeIdentity): Promise<ReadyProcessStream> {
    const open = this.options.host.remote.openClaudeHostStream;
    if (!open) throw new AppError("CONFIGURATION_ERROR", "remote Claude host proxy is unavailable");
    return await open.call(
      this.options.host.remote,
      { ...this.runtimeRequest(), expected },
      this.options.host.remoteHelperPath,
    );
  }

  onChannelLost(): void {
    if (this.closing) return;
    void this.classifyChannelLoss();
  }

  // A dropped channel is not proof the host died: classify against a fresh inspection so a
  // transient ssh failure reconnects instead of tearing down the remote generation.
  private async classifyChannelLoss(): Promise<void> {
    let kind: EndpointLossKind = "connection-lost";
    try { if ((await this.inspect()).status === "absent") kind = "runtime-lost"; }
    catch { /* a failed fresh probe is itself connection loss */ }
    this.reportLoss(kind);
  }

  private reportLoss(kind: EndpointLossKind): void {
    if (this.lossReported || this.closing) return;
    this.lossReported = true;
    for (const listener of this.unavailableListeners) listener(kind);
  }

  private async ensureStarted(): Promise<RuntimeIdentity> {
    const current = await this.inspect();
    if (current.status === "healthy") return current.identity;
    if (current.status === "unhealthy") {
      // Same reclaim as the Codex runtime, for the same dead end: a host whose supervisor is
      // gone is dead, and what keeps it reading unhealthy is its own leftovers — a socket, an
      // identity file, or something it spawned that outlived it still holding its process group.
      // Nothing else ever clears those, so the endpoint could not come back without a human on
      // the worker's machine. `stop` proves the recorded identity first and signals only
      // processes carrying its token; a host that is still SUPERVISED is left alone.
      if (current.supervised !== false || !current.identity) {
        throw new AppError("ENDPOINT_UNAVAILABLE", `existing remote Claude host is unhealthy: ${this.options.endpointId}`);
      }
      await this.invoke("stop-claude-host", { ...this.runtimeRequest(), expected: current.identity });
    }
    const result = await this.invoke<{ identity: unknown }>("start-claude-host", {
      ...this.runtimeRequest(),
      shell: this.options.host.shell,
      token: randomBytes(16).toString("hex"),
    });
    return parseRuntimeIdentity(result.identity);
  }

  private async inspect(): Promise<
    { status: "absent" }
    | { status: "unhealthy"; identity?: RuntimeIdentity; supervised?: boolean }
    | { status: "healthy"; identity: RuntimeIdentity }
  > {
    const raw = await this.invoke<{ status?: unknown; identity?: unknown; supervised?: unknown }>("inspect-claude-host", this.runtimeRequest());
    if (raw?.status === "absent") return { status: "absent" };
    if (raw?.status === "unhealthy") {
      return {
        status: "unhealthy",
        ...(typeof raw.supervised === "boolean" ? { supervised: raw.supervised } : {}),
        ...(raw.identity === undefined ? {} : { identity: parseRuntimeIdentity(raw.identity) }),
      };
    }
    if (raw?.status !== "healthy") throw new AppError("ENDPOINT_UNAVAILABLE", "invalid remote Claude host inspection");
    return { status: "healthy", identity: parseRuntimeIdentity(raw.identity) };
  }

  private async invoke<T>(operation: string, request: unknown): Promise<T> {
    return await this.options.host.remote.invoke<T>(
      operation,
      [JSON.stringify(request)],
      this.options.host.remoteHelperPath,
    );
  }

  // The runtime directory is keyed by endpoint id, and the Codex app-server supervises its
  // generation as `qiyan-<hash>` in the same directory. A Claude host must NOT answer to
  // that name: an endpoint switched from codex to claude would find the app-server's live
  // tmux session, read it as an unhealthy Claude host and refuse to activate for good.
  private runtimeRequest(): { runtimeDir: string; session: string; tmuxMode: "explicit" } {
    return {
      runtimeDir: this.options.host.remoteRuntimeDir,
      session: `qiyan-claude-${posix.basename(this.options.host.remoteRuntimeDir)}`,
      tmuxMode: "explicit",
    };
  }
}

function sameSshIdentity(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return left.kind === "ssh" && right.kind === "ssh"
    && left.token === right.token && left.pid === right.pid
    && left.linuxStartTime === right.linuxStartTime && left.processGroupId === right.processGroupId;
}
