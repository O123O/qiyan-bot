import type { RpcNotification, RpcRequest, RpcResponse } from "./protocol.ts";

export interface RpcWire {
  send(message: string): void;
  close(): void;
  onMessage(listener: (message: string) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export class JsonRpcResponseError extends Error {
  constructor(readonly code: number, readonly rpcMessage: string, readonly data?: unknown) {
    super(`${code}: ${rpcMessage}`);
    this.name = "JsonRpcResponseError";
  }
}

export class RpcRequestTimeoutError extends Error {
  constructor(method: string) {
    super(`app-server request timed out: ${method}`);
    this.name = "RpcRequestTimeoutError";
  }
}

export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>();
  private serverRequestHandler: ((request: RpcRequest) => Promise<unknown>) | undefined;
  private closed = false;
  private readonly removeMessage: () => void;
  private readonly removeClose: () => void;

  constructor(private readonly wire: RpcWire, private readonly options: { requestTimeoutMs: number }) {
    this.removeMessage = wire.onMessage((message) => this.receive(message));
    this.removeClose = wire.onClose((error) => this.close(error ?? new Error("app-server wire closed"), false));
  }

  request<T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error("app-server client is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const finishReject = (error: Error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        reject(error);
      };
      const timeout = setTimeout(() => finishReject(new RpcRequestTimeoutError(method)), this.options.requestTimeoutMs);
      const abort = () => finishReject(signal?.reason instanceof Error ? signal.reason : new Error("request aborted"));
      if (signal?.aborted) { clearTimeout(timeout); reject(signal.reason instanceof Error ? signal.reason : new Error("request aborted")); return; }
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => { signal?.removeEventListener("abort", abort); resolve(value as T); },
        reject: (error) => { signal?.removeEventListener("abort", abort); reject(error); },
        timeout,
      });
      try { this.write({ id, method, params }); } catch (error) { finishReject(error instanceof Error ? error : new Error("app-server write failed")); }
    });
  }

  notify(method: string, params: unknown): void { this.write({ method, params }); }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: (request: RpcRequest) => Promise<unknown>): () => void {
    this.serverRequestHandler = listener;
    return () => { if (this.serverRequestHandler === listener) this.serverRequestHandler = undefined; };
  }

  close(error = new Error("app-server client closed"), closeWire = true): void {
    if (this.closed) return;
    this.closed = true;
    this.removeMessage();
    this.removeClose();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    if (closeWire) this.wire.close();
  }

  private receive(value: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { return; }
    if (!isRecord(parsed)) return;
    const hasId = (typeof parsed.id === "number" || typeof parsed.id === "string");
    const hasMethod = typeof parsed.method === "string";
    if (!hasId && !hasMethod) return;
    const message = parsed as unknown as RpcResponse | RpcRequest | RpcNotification;
    if ("id" in message && !("method" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new JsonRpcResponseError(message.error.code, message.error.message, message.error.data));
      else pending.resolve(message.result);
      return;
    }
    if ("id" in message && "method" in message) { void this.handleServerRequest(message); return; }
    if ("method" in message) for (const listener of this.notificationListeners) listener(message.method, message.params);
  }

  private async handleServerRequest(request: RpcRequest): Promise<void> {
    let response: unknown;
    try {
      if (!this.serverRequestHandler) throw new Error(`Unhandled server request: ${request.method}`);
      response = { id: request.id, result: await this.serverRequestHandler(request) };
    } catch (error) {
      response = { id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } };
    }
    if (!this.closed) this.write(response);
  }

  private write(message: unknown): void {
    if (this.closed) throw new Error("app-server client is closed");
    this.wire.send(JSON.stringify(message));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
