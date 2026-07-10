import { lstat, unlink } from "node:fs/promises";
import { connect } from "node:net";
import type {
  AppServerConnection,
  AppServerConnectionIdentity,
  AppServerInitializeResult,
  AppServerRuntimeService,
} from "../app-server/managed-endpoint.ts";
import type { RpcWire } from "../app-server/rpc-client.ts";
import { AppError } from "../core/errors.ts";
import { localSshForwardSocketPath } from "./local-runtime.ts";
import {
  buildSshStreamForwardArgs,
  buildSshStreamForwardCancelArgs,
  type SshConnectionPlan,
} from "./ssh-config.ts";
import { runBoundedProcess } from "./ssh-process.ts";
import { attestUserControlMaster, type SshRuntimeController } from "./ssh-runtime.ts";
import type { EndpointLossKind, RuntimeIdentity } from "./types.ts";

interface SocketIdentity { device: string; inode: string }
interface PendingForwardCleanup { socketPath: string; socketIdentity?: SocketIdentity }

export class SshAppServerRuntime implements AppServerRuntimeService {
  private active?: SshForwardConnection;
  private opening?: { token: symbol; done: Promise<void>; finish(): void };
  private pendingCleanup?: PendingForwardCleanup;
  private transportClose?: Promise<void>;
  private transportClosing = false;

  constructor(private readonly options: {
    runtime: SshRuntimeController;
    plan: SshConnectionPlan;
    socketRoot: string;
    connectWire(socketPath: string): Promise<RpcWire>;
    sshBinary?: string;
    run?: typeof runBoundedProcess;
    attestControlMaster?: typeof attestUserControlMaster;
    connectionTimeoutMs?: number;
    listenerProbeTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
  }) {}

  async open(): Promise<AppServerConnection> {
    if (this.opening || this.transportClosing) throw new AppError("OPERATION_CONFLICT", "SSH App Server connection is already open");
    const opening = Symbol("ssh-forward-opening");
    let finishOpening!: () => void;
    const openingDone = new Promise<void>((resolve) => { finishOpening = resolve; });
    const openingState = { token: opening, done: openingDone, finish: finishOpening };
    this.opening = openingState;
    let socketPath: string | undefined;
    let socketIdentity: SocketIdentity | undefined;
    let wire: RpcWire | undefined;
    let connection: SshForwardConnection | undefined;
    let forwardRequested = false;
    try {
      await attestSocketRoot(this.options.socketRoot);
      if (this.active) {
        if (!this.active.cleanupPending) throw new AppError("OPERATION_CONFLICT", "SSH App Server connection is already open");
        await this.active.close();
      }
      await this.settlePendingCleanup();
      if (!this.options.plan.ownsControlMaster) {
        await (this.options.attestControlMaster ?? attestUserControlMaster)(this.options.plan);
      }
      const expected = await this.options.runtime.ensureStarted();
      if (expected.kind !== "ssh") throw new AppError("ENDPOINT_UNAVAILABLE", "remote runtime returned a non-SSH identity");
      socketPath = localSshForwardSocketPath(this.options.socketRoot, "00000000");
      await this.reclaimStaleForward(socketPath);
      forwardRequested = true;
      await this.runControl(buildSshStreamForwardArgs(
        this.options.plan, socketPath, this.options.runtime.remoteSocketPath,
      ));
      socketIdentity = await waitForSocket(socketPath, this.options.connectionTimeoutMs ?? 10_000, this.options.sleep);
      wire = await this.options.connectWire(socketPath);
      connection = new SshForwardConnection(this, wire, socketPath, socketIdentity, expected);
      this.active = connection;
      if (connection.lost) throw new AppError("ENDPOINT_UNAVAILABLE", "SSH App Server wire closed during connection");
      return connection;
    } catch (error) {
      let cleanupError: unknown;
      if (connection) {
        try { await connection.close(); } catch (failure) { cleanupError = failure; }
      }
      else {
        try { wire?.close(); } catch { /* Preserve the opening failure. */ }
        if (socketPath && !socketIdentity) socketIdentity = await ownedSocketIdentity(socketPath).catch(() => undefined);
        if (forwardRequested && socketPath) {
          this.pendingCleanup = { socketPath, ...(socketIdentity ? { socketIdentity } : {}) };
          try { await this.settlePendingCleanup(); } catch (failure) { cleanupError = failure; }
        }
      }
      if (cleanupError !== undefined) throw cleanupError;
      throw error;
    } finally {
      openingState.finish();
      if (this.opening?.token === opening) delete this.opening;
    }
  }

  runtimeIdentity(): Promise<RuntimeIdentity | undefined> { return this.options.runtime.runtimeIdentity(); }

  async classifyLoss(): Promise<EndpointLossKind> {
    if (this.options.runtime.classifyLoss) return this.options.runtime.classifyLoss();
    return await this.options.runtime.runtimeIdentity() === undefined ? "runtime-lost" : "connection-lost";
  }

  async shutdownRuntime(expected: RuntimeIdentity): Promise<void> {
    if (this.transportClosing) throw new AppError("OPERATION_CONFLICT", "SSH transport teardown is already active");
    this.transportClosing = true;
    try {
      await this.opening?.done;
      let cleanupError: unknown;
      try { await this.active?.close(); } catch (error) { cleanupError = error; }
      try { await this.settlePendingCleanup(); } catch (error) { cleanupError ??= error; }
      let stopError: unknown;
      try { await this.options.runtime.stop(expected); } catch (error) { stopError = error; }
      if (this.active?.cleanupPending) {
        try { await this.active.close(); } catch (error) { cleanupError ??= error; }
      }
      try { await this.settlePendingCleanup(); } catch (error) { cleanupError ??= error; }
      if (cleanupError !== undefined) throw cleanupError;
      if (stopError !== undefined) throw stopError;
    } finally {
      this.transportClosing = false;
    }
  }

  closeTransport(): Promise<void> {
    if (this.transportClose) return this.transportClose;
    this.transportClosing = true;
    const closing = this.finishTransportClose().finally(() => {
      if (this.transportClose === closing) delete this.transportClose;
      this.transportClosing = false;
    });
    this.transportClose = closing;
    return closing;
  }

  private async finishTransportClose(): Promise<void> {
    await this.opening?.done;
    let firstError: unknown;
    try { await this.active?.close(); } catch (error) { firstError = error; }
    try { await this.settlePendingCleanup(); } catch (error) { firstError ??= error; }
    try { await this.options.runtime.closeTransport?.(); } catch (error) { firstError ??= error; }
    if (this.active?.cleanupPending) {
      try { await this.active.close(); } catch (error) { firstError ??= error; }
    }
    try { await this.settlePendingCleanup(); } catch (error) { firstError ??= error; }
    if (firstError !== undefined) throw firstError;
  }

  async confirm(connection: SshForwardConnection, expected: RuntimeIdentity): Promise<AppServerConnectionIdentity> {
    if (this.active !== connection || connection.lost) throw new AppError("ENDPOINT_UNAVAILABLE", "SSH App Server connection changed during initialization");
    const actual = await this.options.runtime.runtimeIdentity();
    if (this.active !== connection || connection.lost || !sameSshIdentity(expected, actual)) {
      throw new AppError("ENDPOINT_UNAVAILABLE", "SSH runtime identity changed during connection");
    }
    return { runtime: expected };
  }

  release(connection: SshForwardConnection): void {
    if (this.active === connection) delete this.active;
  }

  async cleanupForward(socketPath: string, socketIdentity?: SocketIdentity): Promise<void> {
    await this.runControl(buildSshStreamForwardCancelArgs(
      this.options.plan, socketPath, this.options.runtime.remoteSocketPath,
    )).catch(() => undefined);
    if (await forwardListenerAccepting(
      socketPath, socketIdentity, this.options.listenerProbeTimeoutMs ?? 1_000,
    )) throw new AppError("ENDPOINT_UNAVAILABLE", "SSH forward cleanup could not be confirmed");
    await removeExactSocket(socketPath, socketIdentity);
  }

  private async runControl(args: readonly string[]): Promise<void> {
    const run = this.options.run ?? runBoundedProcess;
    await run(this.options.sshBinary ?? "ssh", args, {
      timeoutMs: this.options.connectionTimeoutMs ?? 10_000,
      maxOutputBytes: 64 * 1024,
    });
  }

  private async reclaimStaleForward(socketPath: string): Promise<void> {
    let identity: SocketIdentity | undefined;
    try { identity = await ownedSocketIdentity(socketPath); }
    catch (error) { if (isErrno(error, "ENOENT")) return; throw error; }
    if (!identity) throw new AppError("CONFIGURATION_ERROR", "invalid stale SSH forward socket");
    this.pendingCleanup = { socketPath, socketIdentity: identity };
    await this.settlePendingCleanup();
  }

  private async settlePendingCleanup(): Promise<void> {
    const pending = this.pendingCleanup;
    if (!pending) return;
    await this.cleanupForward(pending.socketPath, pending.socketIdentity);
    if (this.pendingCleanup === pending) delete this.pendingCleanup;
  }

}

class SshForwardConnection implements AppServerConnection {
  private readonly closes = new Set<(error?: Error) => void>();
  private readonly removeWireClose: () => void;
  private intentional = false;
  private wireDisposed = false;
  private closed = false;
  private closing?: Promise<void>;
  private wireCloseError?: unknown;
  private lossError?: Error;
  cleanupPending = false;
  lost = false;

  constructor(
    private readonly runtime: SshAppServerRuntime,
    readonly wire: RpcWire,
    private readonly socketPath: string,
    private readonly socketIdentity: SocketIdentity,
    private readonly expected: RuntimeIdentity,
  ) {
    this.removeWireClose = wire.onClose((error) => this.fail(error ?? new Error("SSH App Server wire closed")));
  }

  onClose(listener: (error?: Error) => void): () => void {
    if (this.lossError) {
      const error = this.lossError;
      queueMicrotask(() => listener(error));
      return () => undefined;
    }
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }

  confirmInitialized(_result: AppServerInitializeResult): Promise<AppServerConnectionIdentity> {
    return this.runtime.confirm(this, this.expected);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closing) return this.closing;
    this.intentional = true;
    if (!this.wireDisposed) {
      this.wireDisposed = true;
      this.removeWireClose();
      try { this.wire.close(); } catch (error) { this.wireCloseError = error; }
    }
    this.cleanupPending = true;
    const closing = (async () => {
      await this.runtime.cleanupForward(this.socketPath, this.socketIdentity);
      this.cleanupPending = false;
      this.closed = true;
      this.runtime.release(this);
      if (this.wireCloseError !== undefined) throw this.wireCloseError;
    })();
    this.closing = closing;
    try { await closing; }
    finally { if (this.closing === closing) delete this.closing; }
  }

  private fail(error: Error): void {
    if (this.intentional || this.lost) return;
    this.lost = true;
    this.lossError = error;
    for (const listener of this.closes) listener(error);
  }
}

async function attestSocketRoot(path: string): Promise<void> {
  let state;
  try { state = await lstat(path); }
  catch { throw new AppError("CONFIGURATION_ERROR", "invalid private SSH socket root"); }
  const uid = process.getuid?.();
  if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077) !== 0 || (uid !== undefined && state.uid !== uid)) {
    throw new AppError("CONFIGURATION_ERROR", "invalid private SSH socket root");
  }
}

async function waitForSocket(
  path: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<SocketIdentity> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const identity = await ownedSocketIdentity(path);
      if (identity) return identity;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    await sleep(20);
  }
  throw new AppError("ENDPOINT_UNAVAILABLE", "SSH stream-local forward did not become ready");
}

async function ownedSocketIdentity(path: string): Promise<SocketIdentity | undefined> {
  const state = await lstat(path, { bigint: true });
  const uid = process.getuid?.();
  if (!state.isSocket() || state.isSymbolicLink() || (state.mode & 0o077n) !== 0n
    || (uid !== undefined && state.uid !== BigInt(uid))) return undefined;
  return { device: state.dev.toString(10), inode: state.ino.toString(10) };
}

async function removeExactSocket(path: string, expected?: SocketIdentity): Promise<void> {
  if (!expected) return;
  let state;
  try { state = await lstat(path, { bigint: true }); }
  catch (error) { if (isErrno(error, "ENOENT")) return; throw error; }
  if (!state.isSocket() || state.dev.toString(10) !== expected.device || state.ino.toString(10) !== expected.inode) return;
  await unlink(path);
}

async function forwardListenerAccepting(path: string, expected: SocketIdentity | undefined, timeoutMs: number): Promise<boolean> {
  const before = await exactSocketState(path, expected);
  if (before === "absent") return false;
  if (before !== "exact") throw new AppError("ENDPOINT_UNAVAILABLE", "SSH forward socket identity changed during cleanup");
  return new Promise<boolean>((resolve, reject) => {
    const socket = connect(path);
    let settled = false;
    const finish = (result: boolean | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const verifyClosed = (): void => {
      void exactSocketState(path, expected).then(
        (state) => state === "exact" || state === "absent"
          ? finish(false)
          : finish(new AppError("ENDPOINT_UNAVAILABLE", "SSH forward socket identity changed during cleanup")),
        () => finish(new AppError("ENDPOINT_UNAVAILABLE", "SSH forward cleanup could not be confirmed")),
      );
    };
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") verifyClosed();
      else finish(new AppError("ENDPOINT_UNAVAILABLE", "SSH forward cleanup could not be confirmed"));
    });
    const timer = setTimeout(
      () => finish(new AppError("ENDPOINT_UNAVAILABLE", "SSH forward cleanup could not be confirmed")),
      timeoutMs,
    );
  });
}

async function exactSocketState(path: string, expected: SocketIdentity | undefined): Promise<"absent" | "exact" | "changed"> {
  let state;
  try { state = await lstat(path, { bigint: true }); }
  catch (error) { if (isErrno(error, "ENOENT")) return "absent"; throw error; }
  if (!expected || !state.isSocket() || state.dev.toString(10) !== expected.device || state.ino.toString(10) !== expected.inode) {
    return "changed";
  }
  return "exact";
}

function sameSshIdentity(expected: RuntimeIdentity, actual: RuntimeIdentity | undefined): boolean {
  return expected.kind === "ssh" && actual?.kind === "ssh"
    && expected.token === actual.token && expected.pid === actual.pid
    && expected.linuxStartTime === actual.linuxStartTime && expected.processGroupId === actual.processGroupId;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
