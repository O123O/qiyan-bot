import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { RpcNotification, RpcRequest, RpcResponse } from "./protocol.ts";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>();
  private serverRequestHandler: ((request: RpcRequest) => Promise<unknown>) | undefined;
  private closed = false;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly options: { requestTimeoutMs: number },
  ) {
    const lines = createInterface({ input });
    lines.on("line", (line) => this.receive(line));
    lines.on("error", (error) => this.close(error));
    input.on("error", (error) => this.close(error));
    input.on("end", () => this.close(new Error("app-server stream ended")));
    input.on("close", () => this.close(new Error("app-server stream closed")));
  }

  request<T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error("app-server client is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server request timed out: ${method}`));
      }, this.options.requestTimeoutMs);
      const abort = () => {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("request aborted"));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => { signal?.removeEventListener("abort", abort); resolve(value as T); },
        reject: (error) => { signal?.removeEventListener("abort", abort); reject(error); },
        timeout,
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: (request: RpcRequest) => Promise<unknown>): () => void {
    this.serverRequestHandler = listener;
    return () => { if (this.serverRequestHandler === listener) this.serverRequestHandler = undefined; };
  }

  close(error = new Error("app-server client closed")): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private receive(line: string): void {
    let message: RpcResponse | RpcRequest | RpcNotification;
    try { message = JSON.parse(line) as RpcResponse | RpcRequest | RpcNotification; } catch { return; }
    if ("id" in message && !("method" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    if ("id" in message && "method" in message) {
      void this.handleServerRequest(message);
      return;
    }
    if ("method" in message) for (const listener of this.notificationListeners) listener(message.method, message.params);
  }

  private async handleServerRequest(request: RpcRequest): Promise<void> {
    try {
      if (!this.serverRequestHandler) throw new Error(`Unhandled server request: ${request.method}`);
      this.write({ id: request.id, result: await this.serverRequestHandler(request) });
    } catch (error) {
      this.write({ id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private write(message: unknown): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }
}
