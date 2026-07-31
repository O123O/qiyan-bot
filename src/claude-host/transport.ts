// Remote transport for a ClaudeHost: an owner-only Unix socket carrying newline-framed
// JSON, plus a client that satisfies the same ClaudeHost interface.
//
// Dispatch is mechanical — one wire request per interface method — so the protocol cannot
// drift from the interface. All session behaviour lives in ClaudeHostSession on the
// server side; the client adds only transport concerns: request correlation, event
// fan-out, reconnect, and cursor-based replay of the events missed while disconnected.
import { createServer, connect, type Server, type Socket } from "node:net";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { AppError } from "../core/errors.ts";
import type { ClaudeHost, OpenSessionRequest } from "./host.ts";
import {
  CLAUDE_HOST_PROTOCOL_VERSION,
  decodeFrames,
  encodeFrame,
  type HostEvent,
  type HostFrame,
  type HostRequest,
  type HostStatus,
  type SessionStatus,
} from "./protocol.ts";

export interface HostIdentity {
  hostBuild: string;
  sdkVersion: string;
  claudeVersion: string;
  runtimeGeneration: string;
}

export class ClaudeHostServer {
  private server: Server | undefined;
  private readonly clients = new Set<Socket>();
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly host: ClaudeHost,
    private readonly identity: HostIdentity,
  ) {}

  async listen(socketPath: string): Promise<void> {
    // A stale socket from a dead generation would make bind fail; the supervisor has
    // already proven that generation gone before we get here.
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    await rm(socketPath, { force: true });
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.off("error", reject); resolve(); });
    });
    // Owner-only: the socket is the full control surface for this host's sessions.
    await chmod(socketPath, 0o600);
    this.unsubscribe = this.host.subscribe((event) => this.broadcast(event));
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    for (const socket of this.clients) socket.destroy();
    this.clients.clear();
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private broadcast(event: HostEvent): void {
    const frame = encodeFrame({ id: 0, event });
    for (const socket of this.clients) socket.write(frame);
  }

  private accept(socket: Socket): void {
    this.clients.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const { frames, rest } = decodeFrames(buffer);
      buffer = rest;
      for (const frame of frames) void this.handle(socket, frame);
    });
    const drop = (): void => { this.clients.delete(socket); };
    socket.on("close", drop);
    socket.on("error", drop);
  }

  private async handle(socket: Socket, frame: HostFrame): Promise<void> {
    if (!frame.request) return;
    try {
      const result = await this.invoke(frame.request);
      socket.write(encodeFrame({ id: frame.id, result }));
    } catch (error) {
      const code = error instanceof AppError ? error.code : "OPERATION_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      socket.write(encodeFrame({ id: frame.id, error: { code, message } }));
    }
  }

  private async invoke(request: HostRequest): Promise<unknown> {
    switch (request.method) {
      case "host/status": return await this.status();
      case "open": return await this.host.open(request.params[0] as OpenSessionRequest);
      case "close": return await this.host.close(request.params[0]);
      case "send": return await this.host.send(request.params[0], request.params[1], request.params[2]);
      case "interrupt": return await this.host.interrupt(request.params[0]);
      case "status": return await this.host.status(request.params[0]);
      case "setModel": return await this.host.setModel(request.params[0], request.params[1]);
      case "setEffort": return await this.host.setEffort(request.params[0], request.params[1]);
      case "models": return await this.host.models(request.params[0]);
      case "stopTask": return await this.host.stopTask(request.params[0], request.params[1]);
      case "evictIdle": return await this.host.evictIdle(request.params[0]);
      case "shutdown": return await this.host.shutdown();
      default: {
        const unknown = request as { method: string };
        throw new AppError("UNSUPPORTED_CAPABILITY", `claude host does not implement ${unknown.method}`);
      }
    }
  }

  private async status(): Promise<HostStatus> {
    return {
      protocolVersion: CLAUDE_HOST_PROTOCOL_VERSION,
      ...this.identity,
      capabilities: ["sessions", "events", "eviction"],
      sessions: [],
    };
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

// The client's view of a connection. A local host is a Unix socket; a remote host is the
// same socket reached over SSH, whose stdio the endpoint layer hands over as a pair of
// streams. Both are just a duplex byte channel, so the client has one implementation.
export interface HostChannel {
  input: Writable;
  output: Readable;
  close(): void;
}

export function unixSocketChannel(socketPath: string): () => Promise<HostChannel> {
  return async () => {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = connect(socketPath);
      candidate.once("connect", () => { candidate.off("error", reject); resolve(candidate); });
      candidate.once("error", (error) => {
        // Destroy the failed socket explicitly: a half-open handle would keep the
        // process alive long after the caller has given up.
        candidate.destroy();
        reject(new AppError("ENDPOINT_UNAVAILABLE", `cannot reach the claude host: ${error.message}`));
      });
    });
    return { input: socket, output: socket, close: () => socket.destroy() };
  };
}

export class RemoteClaudeHost implements ClaudeHost {
  private channel: HostChannel | undefined;
  private connecting: Promise<HostChannel> | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: HostEvent) => void>();
  private readonly reconnectListeners = new Set<(sessionId: string) => void>();
  // Sessions this client opened, so a reconnect can tell each one to reload.
  private readonly openSessions = new Set<string>();
  private closed = false;
  private connectedOnce = false;

  // `openChannel` is the only transport-specific part: unixSocketChannel for a local
  // host, an SSH-bridged stream for a remote one.
  constructor(private readonly openChannel: () => Promise<HostChannel>) {}

  async open(request: OpenSessionRequest): Promise<SessionStatus> {
    const status = await this.call<SessionStatus>({ method: "open", params: [request] });
    this.openSessions.add(request.sessionId);
    return status;
  }

  async close(sessionId: string): Promise<void> {
    this.openSessions.delete(sessionId);
    await this.call<void>({ method: "close", params: [sessionId] });
  }

  async send(sessionId: string, uuid: string, text: string): Promise<boolean> {
    return await this.call<boolean>({ method: "send", params: [sessionId, uuid, text] });
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.call<void>({ method: "interrupt", params: [sessionId] });
  }

  async status(sessionId: string): Promise<SessionStatus> {
    return await this.call<SessionStatus>({ method: "status", params: [sessionId] });
  }

  async setModel(sessionId: string, model?: string): Promise<void> {
    await this.call<void>({ method: "setModel", params: [sessionId, model] });
  }

  async setEffort(sessionId: string, effort?: string): Promise<void> {
    await this.call<void>({ method: "setEffort", params: [sessionId, effort] });
  }

  async models(sessionId: string): Promise<unknown[]> {
    return await this.call<unknown[]>({ method: "models", params: [sessionId] });
  }

  async stopTask(sessionId: string, taskId: string): Promise<void> {
    await this.call<void>({ method: "stopTask", params: [sessionId, taskId] });
  }

  async evictIdle(keep: number): Promise<string[]> {
    return await this.call<string[]>({ method: "evictIdle", params: [keep] });
  }

  async hostStatus(): Promise<HostStatus> {
    return await this.call<HostStatus>({ method: "host/status" });
  }

  subscribe(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // Fires per open session after the connection is re-established. Events are live-only,
  // so anything emitted while disconnected was missed: the consumer reloads the tail of
  // the durable transcript rather than the host replaying a buffer.
  onReconnect(listener: (sessionId: string) => void): () => void {
    this.reconnectListeners.add(listener);
    return () => { this.reconnectListeners.delete(listener); };
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const channel = this.channel;
    this.channel = undefined;
    for (const [, waiter] of this.pending) {
      waiter.reject(new AppError("ENDPOINT_UNAVAILABLE", "claude host client shut down"));
    }
    this.pending.clear();
    channel?.close();
  }

  private async call<T>(request: HostRequest): Promise<T> {
    if (this.closed) throw new AppError("ENDPOINT_UNAVAILABLE", "claude host client is closed");
    const channel = await this.ensureConnected();
    const id = this.nextId++;
    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      channel.input.write(encodeFrame({ id, request }), (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(new AppError("ENDPOINT_UNAVAILABLE", `claude host write failed: ${error.message}`));
      });
    });
  }

  private async ensureConnected(): Promise<HostChannel> {
    if (this.channel && this.channel.input.writable) return this.channel;
    this.connecting ??= this.dial().finally(() => { this.connecting = undefined; });
    return await this.connecting;
  }

  private async dial(): Promise<HostChannel> {
    const channel = await this.openChannel();
    channel.output.setEncoding("utf8");
    let buffer = "";
    channel.output.on("data", (chunk: string) => {
      buffer += chunk;
      const { frames, rest } = decodeFrames(buffer);
      buffer = rest;
      for (const frame of frames) this.receive(frame);
    });
    const fail = (): void => {
      if (this.channel === channel) this.channel = undefined;
      // A dropped connection fails every in-flight request rather than hanging it. The
      // caller retries with the same idempotency uuid, which the host drops as a duplicate.
      for (const [id, waiter] of this.pending) {
        this.pending.delete(id);
        waiter.reject(new AppError("OPERATION_UNCERTAIN", "claude host connection lost in flight"));
      }
    };
    channel.output.on("close", fail);
    channel.output.on("error", fail);
    channel.output.on("end", fail);
    this.channel = channel;
    // A first connection has nothing to reload; only a genuine reconnect does.
    if (this.connectedOnce) {
      for (const sessionId of this.openSessions) {
        for (const listener of this.reconnectListeners) listener(sessionId);
      }
    }
    this.connectedOnce = true;
    return channel;
  }

  private receive(frame: HostFrame): void {
    if (frame.event) {
      for (const listener of this.listeners) listener(frame.event);
      return;
    }
    const waiter = this.pending.get(frame.id);
    if (!waiter) return;
    this.pending.delete(frame.id);
    if (frame.error) waiter.reject(new AppError(frame.error.code as never, frame.error.message));
    else waiter.resolve(frame.result);
  }
}
