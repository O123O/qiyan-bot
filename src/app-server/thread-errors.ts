import { JsonRpcResponseError } from "./rpc-client.ts";

export function isExactThreadNotLoaded(error: unknown, threadId: string): boolean {
  return isRpcError(error, `thread not loaded: ${threadId}`);
}

export function isExactThreadTurnsNotMaterialized(error: unknown, threadId: string): boolean {
  return isRpcError(error, `thread ${threadId} is not materialized yet; thread/turns/list is unavailable before first user message`);
}

export function isExactThreadNoRollout(error: unknown, threadId: string): boolean {
  return isRpcError(error, `no rollout found for thread id ${threadId}`);
}

function isRpcError(error: unknown, message: string, code = -32600): error is Error & { code: number; rpcMessage: string } {
  return error instanceof JsonRpcResponseError
    && error.code === code
    && error.rpcMessage === message;
}
