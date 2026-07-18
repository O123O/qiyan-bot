import { isDeepStrictEqual } from "node:util";
import { JsonRpcResponseError, RpcRequestTimeoutError } from "../app-server/rpc-client.ts";
import { AppError } from "../core/errors.ts";
import type { RuntimeIdentity } from "../endpoints/types.ts";
import { waitForCompactionEvidence } from "../sessions/compaction.ts";
import { PostTurnActionRetry, type AssistantPostTurnAction } from "./post-turn-actions.ts";

interface CompactionPort {
  identity(): { endpointId: string; threadId: string };
  readThread(): Promise<{ status?: string | { type?: string }; turns?: any[] }>;
  compactionItemIdsAfter(baselineTurnId: string | null): Promise<string[]>;
  compact(): Promise<void>;
}

interface RestartPort {
  endpointId: string;
  runtimeIdentity(): Promise<RuntimeIdentity | undefined>;
  shutdownRuntime(identity: RuntimeIdentity): Promise<void>;
  startAndResume(): Promise<void>;
}

type Checkpoint = (payload: Record<string, unknown>) => void;

export async function startAssistantTurnWithPendingSettings<
  Params extends object,
  Result,
>(
  params: Params,
  pending: PendingSettings,
  start: (params: Params & PendingSettings) => Promise<Result>,
  onApplied: (settings: PendingSettings) => void,
): Promise<Result> {
  const result = await start({ ...params, ...pending });
  onApplied(pending);
  return result;
}

type PendingSettings = { model?: string; effort?: string };

export async function runAssistantCompaction(
  action: AssistantPostTurnAction,
  port: CompactionPort,
  checkpoint: Checkpoint,
): Promise<void> {
  const payload = action.payload as {
    endpointId?: string;
    threadId?: string;
    baselineTurnId?: string | null;
    phase?: string;
  };
  const identity = port.identity();
  if (payload.endpointId !== identity.endpointId || payload.threadId !== identity.threadId) {
    throw new AppError("OPERATION_CONFLICT", "assistant compaction target identity changed");
  }
  const before = await retryPortFailure("assistant compaction history is temporarily unavailable", () => port.readThread(), true);
  const status = typeof before.status === "string" ? before.status : before.status?.type;
  if (status === "active" || (before.turns ?? []).some((turn) => !isTerminalStatus(turn.status))) {
    throw new PostTurnActionRetry("assistant thread is still active");
  }
  const hasBaseline = Object.hasOwn(payload, "baselineTurnId");
  if (hasBaseline) {
    const baselineTurnId = payload.baselineTurnId ?? null;
    const current = await retryPortFailure(
      "assistant compaction completion history is temporarily unavailable",
      () => port.compactionItemIdsAfter(baselineTurnId), true,
    );
    if (current.length > 0) return;
    if (payload.phase === "dispatching" || payload.phase === "dispatched") {
      throw new PostTurnActionRetry("assistant compaction completion is not yet visible");
    }
  } else if (payload.phase === "dispatching" || payload.phase === "dispatched") {
    throw new PostTurnActionRetry("assistant compaction has a legacy checkpoint without a bounded history anchor");
  }
  const baselineTurnId = (before.turns ?? []).at(-1)?.id ?? null;
  const dispatching = { ...action.payload, endpointId: identity.endpointId, threadId: identity.threadId, baselineTurnId, phase: "dispatching" };
  checkpoint(dispatching);
  await retryPortFailure("assistant compaction dispatch outcome is awaiting native evidence", () => port.compact(), true);
  checkpoint({ ...dispatching, phase: "dispatched" });
  const completed = await waitForCompactionEvidence(async () => (
    await retryPortFailure(
      "assistant compaction completion history is temporarily unavailable",
      () => port.compactionItemIdsAfter(baselineTurnId), true,
    )
  )[0]);
  if (!completed) {
    throw new PostTurnActionRetry("assistant compaction completion is not yet visible");
  }
}

export async function runAssistantRestart(
  action: AssistantPostTurnAction,
  port: RestartPort,
  checkpoint: Checkpoint,
): Promise<void> {
  const payload = action.payload as { endpointId?: string; runtimeIdentity?: RuntimeIdentity; phase?: string };
  if (payload.endpointId !== port.endpointId || !payload.runtimeIdentity) {
    throw new AppError("OPERATION_CONFLICT", "assistant restart has an invalid scheduled runtime identity");
  }
  const scheduled = payload.runtimeIdentity;
  const current = await retryPortFailure("assistant runtime identity is temporarily unavailable", () => port.runtimeIdentity());
  if (current && !isDeepStrictEqual(current, scheduled)) {
    if (payload.phase === "starting") {
      await retryPortFailure("assistant replacement runtime is not ready", () => port.startAndResume());
      const resumed = await retryPortFailure("assistant replacement runtime identity is temporarily unavailable",
        () => port.runtimeIdentity());
      if (!resumed || isDeepStrictEqual(resumed, scheduled)) {
        throw new PostTurnActionRetry("assistant replacement runtime is not yet confirmed");
      }
    }
    return;
  }
  if (current) {
    checkpoint({ ...payload, phase: "shutting_down" });
    await retryPortFailure("assistant runtime shutdown outcome is awaiting exact identity evidence",
      () => port.shutdownRuntime(scheduled), true);
  }
  checkpoint({ ...payload, phase: "starting" });
  await retryPortFailure("assistant replacement runtime is not ready", () => port.startAndResume());
  const replacement = await retryPortFailure("assistant replacement runtime identity is temporarily unavailable",
    () => port.runtimeIdentity());
  if (!replacement || isDeepStrictEqual(replacement, scheduled)) {
    throw new PostTurnActionRetry("assistant replacement runtime is not yet confirmed");
  }
}

function isTerminalStatus(status: unknown): boolean {
  const value = typeof status === "string" ? status : String((status as { type?: unknown } | undefined)?.type ?? "");
  return new Set(["completed", "failed", "interrupted"]).has(value);
}

async function retryPortFailure<T>(message: string, run: () => Promise<T>, retryUnknown = false): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof PostTurnActionRetry) throw error;
    const ambiguous = error instanceof RpcRequestTimeoutError
      || (error instanceof AppError && new Set([
        "ENDPOINT_UNAVAILABLE", "ENDPOINT_IDENTITY_CHANGED", "OPERATION_CONFLICT", "OPERATION_UNCERTAIN",
      ]).has(error.code));
    const unknownTransportFailure = retryUnknown
      && !(error instanceof AppError) && !(error instanceof JsonRpcResponseError);
    if (ambiguous || unknownTransportFailure) throw new PostTurnActionRetry(message);
    throw error;
  }
}
