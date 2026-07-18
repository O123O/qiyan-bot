import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { Agent, type ClientRequest, type ClientRequestArgs } from "node:http";
import { Duplex, type Readable, type Writable } from "node:stream";
import WebSocket from "ws";
import type { RpcWire } from "./rpc-client.ts";

// App Server RPC is message-framed JSON. A single bounded turn can legitimately exceed 1 MiB
// (agent text plus command/tool items), so rejecting at 1 MiB tears down an otherwise healthy shared
// endpoint. Keep a finite transport ceiling; consumers must still page and project native history.
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export interface WebSocketByteStream {
  readonly input: Writable;
  readonly output: Readable;
  onClose(listener: (error?: Error) => void): () => void;
  close(): Promise<void>;
}

class SocketCompatibleDuplex extends Duplex {
  private readonly removeStreamClose: () => void;
  private closePromise?: Promise<void>;

  constructor(private readonly stream: WebSocketByteStream) {
    super();
    const data = (chunk: Buffer) => { if (!this.push(chunk)) stream.output.pause(); };
    const end = () => this.push(null);
    const failed = () => this.destroy(new Error("App Server byte stream failed"));
    stream.output.on("data", data);
    stream.output.once("end", end);
    stream.output.once("error", failed);
    this.once("close", () => {
      stream.output.off("data", data);
      stream.output.off("end", end);
      stream.output.off("error", failed);
    });
    this.removeStreamClose = stream.onClose((error) => this.destroy(error ?? new Error("App Server byte stream closed")));
  }

  override _read(): void { this.stream.output.resume(); }

  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.stream.input.write(chunk, encoding, callback);
  }

  override _final(callback: (error?: Error | null) => void): void { this.stream.input.end(callback); }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.removeStreamClose();
    const closing = this.closePromise ?? this.stream.close();
    this.closePromise = closing;
    void closing.then(() => callback(error), () => callback(error ?? new Error("App Server byte stream cleanup failed")));
  }

  setTimeout(_milliseconds: number, _callback?: () => void): this { return this; }
  setNoDelay(_enabled = true): this { return this; }
  setKeepAlive(_enabled = false, _initialDelay = 0): this { return this; }
}

export function createSocketCompatibleDuplex(stream: WebSocketByteStream): Duplex {
  return new SocketCompatibleDuplex(stream);
}

export class OneShotStreamAgent extends Agent {
  private admitted = false;

  constructor(private readonly streamSocket: Duplex) {
    super({ keepAlive: false, maxSockets: 1 });
  }

  addRequest(request: ClientRequest, options: ClientRequestArgs): void {
    if (this.admitted) {
      throw new Error("one-shot App Server stream already admitted a request");
    }
    this.admitted = true;
    const addRequest = (Agent.prototype as unknown as {
      addRequest(request: ClientRequest, options: ClientRequestArgs): void;
    }).addRequest;
    addRequest.call(this, request, options);
  }

  override createConnection(): Duplex { return this.streamSocket; }
}

export class WebSocketWire implements RpcWire {
  private readonly messages = new Set<(message: string) => void>();
  private readonly closes = new Set<(error?: Error) => void>();
  private closed = false;

  private disposed = false;

  private constructor(private readonly socket: WebSocket, private readonly dispose?: () => void) {
    socket.on("message", (data, isBinary) => {
      const size = Array.isArray(data) ? data.reduce((total, item) => total + item.byteLength, 0) : data.byteLength;
      if (isBinary || size > MAX_FRAME_BYTES) {
        this.fail(new Error("invalid App Server WebSocket frame"));
        socket.terminate();
        return;
      }
      const value = Array.isArray(data) ? Buffer.concat(data).toString() : data.toString();
      for (const listener of this.messages) listener(value);
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail());
  }

  static async connect(socketPath: string, options: { timeoutMs: number; trustedRoot: string }): Promise<WebSocketWire> {
    if (!isAbsolute(socketPath)) throw new Error("App Server requires an absolute Unix socket path");
    await attestPrivateSocket(socketPath, options.trustedRoot);
    const socket = new WebSocket(`ws+unix://${socketPath}:/`, {
      handshakeTimeout: options.timeoutMs,
      maxPayload: MAX_FRAME_BYTES,
      followRedirects: false,
      perMessageDeflate: false,
    });
    await awaitHandshake(socket, options.timeoutMs);
    return new WebSocketWire(socket);
  }

  static async connectStream(stream: WebSocketByteStream, options: { timeoutMs: number }): Promise<WebSocketWire> {
    const adapter = createSocketCompatibleDuplex(stream);
    const agent = new OneShotStreamAgent(adapter);
    const socket = new WebSocket("ws://qiyan-app-server.invalid/", {
      agent,
      handshakeTimeout: options.timeoutMs,
      maxPayload: MAX_FRAME_BYTES,
      followRedirects: false,
      perMessageDeflate: false,
    });
    try { await awaitHandshake(socket, options.timeoutMs); }
    catch (error) {
      socket.once("error", () => undefined);
      try { socket.terminate(); } catch { /* rejection below is authoritative */ }
      agent.destroy();
      adapter.destroy();
      throw error;
    }
    return new WebSocketWire(socket, () => { agent.destroy(); adapter.destroy(); });
  }

  send(message: string): void { this.socket.send(message); }
  close(): void { if (!this.closed) this.socket.close(); }
  onMessage(listener: (message: string) => void): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
  onClose(listener: (error?: Error) => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }

  private fail(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.disposed) { this.disposed = true; this.dispose?.(); }
    for (const listener of this.closes) listener(error);
  }
}

async function awaitHandshake(socket: WebSocket, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.once("error", () => undefined);
      try { socket.terminate(); } catch { /* rejection below is authoritative */ }
      cleanup();
      reject(new Error("App Server WebSocket handshake timed out"));
    }, timeoutMs);
    const cleanup = () => { clearTimeout(timeout); socket.off("open", opened); socket.off("error", failed); socket.off("unexpected-response", unexpected); };
    const opened = () => { cleanup(); if (socket.protocol) { socket.terminate(); reject(new Error("unexpected App Server WebSocket protocol")); } else resolve(); };
    const failed = () => { cleanup(); reject(new Error("App Server WebSocket handshake failed")); };
    const unexpected = (_request: unknown, response: { destroy(): void }) => { cleanup(); response.destroy(); reject(new Error("unexpected App Server WebSocket response")); };
    socket.once("open", opened);
    socket.once("error", failed);
    socket.once("unexpected-response", unexpected);
  });
}

async function attestPrivateSocket(socketPath: string, trustedRoot: string): Promise<void> {
  if (!isAbsolute(trustedRoot)) throw new Error("App Server requires an absolute private Unix socket root");
  let rootState;
  try { rootState = await lstat(trustedRoot); } catch { throw new Error("invalid private Unix socket root"); }
  const uid = process.getuid?.();
  if (!rootState.isDirectory() || rootState.isSymbolicLink() || (rootState.mode & 0o077) !== 0 || (uid !== undefined && rootState.uid !== uid)) {
    throw new Error("invalid private Unix socket root");
  }
  const canonicalRoot = await realpath(trustedRoot);
  const canonicalParent = await realpath(dirname(socketPath)).catch(() => undefined);
  if (!canonicalParent) throw new Error("invalid owner Unix socket");
  const projected = relative(canonicalRoot, join(canonicalParent, basename(socketPath)));
  if (projected === ".." || projected.startsWith(`..${sep}`) || isAbsolute(projected)) {
    throw new Error("App Server Unix socket must be inside the trusted root");
  }
  let socketState;
  try { socketState = await lstat(socketPath); } catch { throw new Error("invalid owner Unix socket"); }
  if (!socketState.isSocket() || socketState.isSymbolicLink() || (socketState.mode & 0o077) !== 0 || (uid !== undefined && socketState.uid !== uid)) {
    throw new Error("invalid owner Unix socket");
  }
}
