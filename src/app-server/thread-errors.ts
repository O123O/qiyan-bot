import { JsonRpcResponseError } from "./rpc-client.ts";

export function isExactThreadNotLoaded(error: unknown, threadId: string): boolean {
  return isRpcError(error, `thread not loaded: ${threadId}`);
}

export function isExactThreadNotMaterialized(error: unknown, threadId: string): boolean {
  return isRpcError(error, `thread ${threadId} is not materialized yet; includeTurns is unavailable before first user message`);
}

export function isExactThreadNoRollout(error: unknown, threadId: string): boolean {
  return isRpcError(error, `no rollout found for thread id ${threadId}`);
}

function isRpcError(error: unknown, message: string): error is Error & { code: number; rpcMessage: string } {
  return error instanceof JsonRpcResponseError
    && error.code === -32600
    && error.rpcMessage === message;
}
