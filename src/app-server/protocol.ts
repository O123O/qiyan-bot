import type { ServerRequest as GeneratedServerRequest } from "./generated/ServerRequest.ts";
import type { ServerNotification as GeneratedServerNotification } from "./generated/ServerNotification.ts";

export const GENERATED_CODEX_PROTOCOL_VERSION = "0.142.5";
export const MINIMUM_SUPPORTED_CODEX_VERSION = GENERATED_CODEX_PROTOCOL_VERSION;

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
