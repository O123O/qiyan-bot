import type {
  AppServerConnection,
  AppServerConnectionIdentity,
  AppServerInitializeResult,
  AppServerRuntimeService,
} from "../app-server/managed-endpoint.ts";
import type { RpcWire } from "../app-server/rpc-client.ts";
import { AppError } from "../core/errors.ts";
import type { ReadyProcessStream } from "./ssh-process.ts";
import type { SshRuntimeController } from "./ssh-runtime.ts";
import type { EndpointLossKind, RuntimeIdentity } from "./types.ts";

export class SshAppServerRuntime implements AppServerRuntimeService {
  private active?: SshProxyConnection;
  private opening?: { token: symbol; done: Promise<void>; finish(): void };
  private pendingCleanup?: ReadyProcessStream;
  private transportClose?: Promise<void>;
  private transportClosing = false;

  constructor(private readonly options: {
    runtime: SshRuntimeController;
    connectWire(stream: ReadyProcessStream, token?: string): Promise<RpcWire>;
  }) {}

  async open(): Promise<AppServerConnection> {
    if (this.opening || this.transportClosing) throw new AppError("OPERATION_CONFLICT", "SSH App Server connection is already open");
    const opening = Symbol("ssh-proxy-opening");
    let finishOpening!: () => void;
    const openingDone = new Promise<void>((resolve) => { finishOpening = resolve; });
    const openingState = { token: opening, done: openingDone, finish: finishOpening };
    this.opening = openingState;
    let stream: ReadyProcessStream | undefined;
    let wire: RpcWire | undefined;
    let connection: SshProxyConnection | undefined;
    try {
      if (this.active) {
        if (!this.active.cleanupPending) throw new AppError("OPERATION_CONFLICT", "SSH App Server connection is already open");
        await this.active.close();
      }
      await this.settlePendingCleanup();
      const expected = await this.options.runtime.ensureStarted();
      if (expected.kind !== "ssh") throw new AppError("ENDPOINT_UNAVAILABLE", "remote runtime returned a non-SSH identity");
      stream = await this.options.runtime.openAppServerStream(expected);
      wire = await this.options.connectWire(stream, this.options.runtime.appServerToken?.());
      connection = new SshProxyConnection(this, wire, stream, expected);
      stream = undefined;
      this.active = connection;
      if (connection.lost) throw new AppError("ENDPOINT_UNAVAILABLE", "SSH App Server wire closed during connection");
      return connection;
    } catch (error) {
      let cleanupError: unknown;
      if (connection) {
        try { await connection.close(); } catch (failure) { cleanupError = failure; }
      } else {
        try { wire?.close(); } catch { /* Preserve the opening failure. */ }
        if (stream) {
          this.pendingCleanup = stream;
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

  async confirm(connection: SshProxyConnection, expected: RuntimeIdentity): Promise<AppServerConnectionIdentity> {
    if (this.active !== connection || connection.lost) throw new AppError("ENDPOINT_UNAVAILABLE", "SSH App Server connection changed during initialization");
    const actual = await this.options.runtime.runtimeIdentity();
    if (this.active !== connection || connection.lost || !sameSshIdentity(expected, actual)) {
      throw new AppError("ENDPOINT_UNAVAILABLE", "SSH runtime identity changed during connection");
    }
    return { runtime: expected };
  }

  release(connection: SshProxyConnection): void {
    if (this.active === connection) delete this.active;
  }

  async cleanupStream(stream: ReadyProcessStream): Promise<void> { await stream.close(); }

  private async settlePendingCleanup(): Promise<void> {
    const pending = this.pendingCleanup;
    if (!pending) return;
    await pending.close();
    if (this.pendingCleanup === pending) delete this.pendingCleanup;
  }
}

class SshProxyConnection implements AppServerConnection {
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
    private readonly stream: ReadyProcessStream,
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
      await this.runtime.cleanupStream(this.stream);
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

function sameSshIdentity(expected: RuntimeIdentity, actual: RuntimeIdentity | undefined): boolean {
  return expected.kind === "ssh" && actual?.kind === "ssh"
    && expected.token === actual.token && expected.pid === actual.pid
    && expected.linuxStartTime === actual.linuxStartTime && expected.processGroupId === actual.processGroupId;
}
