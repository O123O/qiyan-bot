import { z } from "zod";
import { AppError } from "../core/errors.ts";
import {
  scanLocalRollout,
  type RolloutAccess,
  type RolloutCursor,
  type RolloutMaterialization,
  type RolloutScanResult,
} from "../sessions/rollout-ownership.ts";
import type { RemoteRuntimeClient } from "./ssh-runtime.ts";
import type { EndpointWorkLease } from "./types.ts";

const cursorSchema = z.object({
  device: z.string().regex(/^\d+$/u),
  inode: z.string().regex(/^\d+$/u),
  offset: z.number().int().nonnegative().safe(),
}).strict();
const startSchema = z.object({
  turnId: z.string().min(1),
  clientId: z.string().min(1).optional(),
  hasUserMessage: z.literal(true).optional(),
}).strict();
const resultSchema = z.object({
  cursor: cursorSchema,
  starts: z.array(startSchema).max(1024),
  openTurn: startSchema.optional(),
  malformed: z.literal(true).optional(),
}).strict();
const responseSchema = z.object({ results: z.array(resultSchema).max(128) }).strict();
const materializationResponseSchema = z.object({
  results: z.array(z.union([resultSchema, z.object({ missing: z.literal(true) }).strict()])).length(1),
}).strict();

export interface RolloutScanRequest {
  path: string;
  threadId: string;
  cursor?: RolloutCursor;
}

export class RolloutAccessRouter implements RolloutAccess {
  constructor(private readonly options: {
    remote(endpointId: string): { remote: RemoteRuntimeClient; helperPath: string } | undefined;
    validateLease?(endpointId: string, lease: EndpointWorkLease): boolean;
    scanLocal?: typeof scanLocalRollout;
  }) {}

  async scan(endpointId: string, requests: readonly RolloutScanRequest[], lease?: EndpointWorkLease): Promise<RolloutScanResult[]> {
    if (requests.length === 0) return [];
    if (requests.length > 128) throw new AppError("CONFIGURATION_ERROR", "too many rollout scan requests");
    if (endpointId === "local") {
      const scan = this.options.scanLocal ?? scanLocalRollout;
      const results = await retryConcurrentRolloutAppend(() => {
        this.requireLease(endpointId, lease);
        return Promise.all(requests.map((request) => scan(request)));
      });
      this.requireLease(endpointId, lease);
      return results;
    }
    this.requireLease(endpointId, lease);
    const context = this.options.remote(endpointId);
    if (!context) throw new AppError("ENDPOINT_UNAVAILABLE", `SSH rollout helper is unavailable: ${endpointId}`);
    const response = await context.remote.invoke("rollout-scan", [JSON.stringify({ requests })], context.helperPath);
    this.requireLease(endpointId, lease);
    const parsed = responseSchema.safeParse(response);
    if (!parsed.success || parsed.data.results.length !== requests.length) {
      throw new AppError("ENDPOINT_UNAVAILABLE", `SSH rollout helper returned invalid data: ${endpointId}`);
    }
    return parsed.data.results.map(publicResult);
  }

  async scanUnmaterialized(endpointId: string, request: RolloutScanRequest, lease?: EndpointWorkLease): Promise<RolloutMaterialization> {
    if (request.cursor) throw new AppError("CONFIGURATION_ERROR", "unmaterialized rollout scan cannot use a cursor");
    if (endpointId === "local") {
      try {
        const scan = this.options.scanLocal ?? scanLocalRollout;
        const result = await retryConcurrentRolloutAppend(() => {
          this.requireLease(endpointId, lease);
          return scan({ ...request, collectFromStart: true });
        });
        this.requireLease(endpointId, lease);
        return { state: "present", result };
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
        this.requireLease(endpointId, lease);
        return { state: "missing" };
      }
    }
    this.requireLease(endpointId, lease);
    const context = this.options.remote(endpointId);
    if (!context) throw new AppError("ENDPOINT_UNAVAILABLE", `SSH rollout helper is unavailable: ${endpointId}`);
    const response = await context.remote.invoke("rollout-scan", [JSON.stringify({
      requests: [request],
      allowMissing: true,
      collectFromStart: true,
    })], context.helperPath);
    this.requireLease(endpointId, lease);
    const parsed = materializationResponseSchema.safeParse(response);
    if (!parsed.success) throw new AppError("ENDPOINT_UNAVAILABLE", `SSH rollout helper returned invalid data: ${endpointId}`);
    const [result] = parsed.data.results;
    if (!result || "missing" in result) return { state: "missing" };
    return { state: "present", result: publicResult(result) };
  }

  private requireLease(endpointId: string, lease?: EndpointWorkLease): void {
    if (lease && this.options.validateLease && !this.options.validateLease(endpointId, lease)) {
      throw new AppError("ENDPOINT_UNAVAILABLE", `endpoint work lease changed: ${endpointId}`);
    }
  }
}

async function retryConcurrentRolloutAppend<T>(scan: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try { return await scan(); }
    catch (error) {
      if (attempt >= 3 || !(error instanceof Error) || error.message !== "rollout appended while scanning") throw error;
    }
  }
}

function publicResult(result: z.infer<typeof resultSchema>): RolloutScanResult {
  return {
    cursor: result.cursor,
    starts: result.starts.map((turn) => ({
      turnId: turn.turnId,
      ...(turn.clientId === undefined ? {} : { clientId: turn.clientId }),
      ...(turn.hasUserMessage === undefined ? {} : { hasUserMessage: true as const }),
    })),
    ...(result.openTurn === undefined ? {} : {
      openTurn: {
        turnId: result.openTurn.turnId,
        ...(result.openTurn.clientId === undefined ? {} : { clientId: result.openTurn.clientId }),
        ...(result.openTurn.hasUserMessage === undefined ? {} : { hasUserMessage: true as const }),
      },
    }),
    ...(result.malformed === undefined ? {} : { malformed: true }),
  };
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
