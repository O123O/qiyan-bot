import type { ServerRequest as GeneratedServerRequest } from "./generated/ServerRequest.ts";
import type { ServerNotification as GeneratedServerNotification } from "./generated/ServerNotification.ts";

export type ServerRequest = GeneratedServerRequest;
export type ServerNotification = GeneratedServerNotification;

export interface RpcRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
