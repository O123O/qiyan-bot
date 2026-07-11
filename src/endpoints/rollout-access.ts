import { z } from "zod";
import { AppError } from "../core/errors.ts";
import {
  ROLLOUT_APPENDED_WHILE_SCANNING,
  scanLocalRollout,
  type RolloutAccess,
  type RolloutCursor,
  type RolloutMaterialization,
  type RolloutScanResult,
} from "../sessions/rollout-ownership.ts";
import { scanLocalClaudeTranscript } from "../sessions/claude-transcript.ts";
import type { RemoteRuntimeClient } from "./ssh-runtime.ts";
import type { EndpointWorkLease } from "./types.ts";

// The scanner signature shared by the Codex (`scanLocalRollout`) and Claude
// (`scanLocalClaudeTranscript`) providers — both read a jsonl by byte offset and
// return provider-neutral `RolloutScanResult` ownership metadata.
type LocalScanner = (request: { path: string; threadId: string; cursor?: RolloutCursor; collectFromStart?: true }) => Promise<RolloutScanResult>;
export type SessionProvider = "codex" | "claude";

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
    // Provider dispatch (Phase 1.1). Defaults to Codex so existing endpoints are
    // unchanged; a Claude endpoint resolves to the transcript scanner.
    provider?(endpointId: string): SessionProvider;
    scanLocalClaude?: typeof scanLocalClaudeTranscript;
    // Local detection (Phase 1.1). A local Claude endpoint has an id other than the
    // Codex `"local"`, so local-vs-remote can't be keyed on that literal alone. When
    // omitted this defaults to the exact `"local"` id (unchanged behavior); 1.4
    // supplies a callback that also recognizes the local Claude endpoint id.
    local?(endpointId: string): boolean;
  }) {}

  private provider(endpointId: string): SessionProvider {
    return this.options.provider?.(endpointId) ?? "codex";
  }

  private isLocal(endpointId: string): boolean {
    return this.options.local?.(endpointId) ?? endpointId === "local";
  }

  private localScanner(endpointId: string): LocalScanner {
    return this.provider(endpointId) === "claude"
      ? (this.options.scanLocalClaude ?? scanLocalClaudeTranscript)
      : (this.options.scanLocal ?? scanLocalRollout);
  }

  // The remote helper ships both a Codex (`rollout-scan`) and a Claude
  // (`claude-rollout-scan`) parser; dispatch the op by the endpoint's provider so a
  // remote Claude transcript is read by the Claude-aware parser, not mis-parsed as Codex.
  private remoteScanOperation(endpointId: string): "rollout-scan" | "claude-rollout-scan" {
    return this.provider(endpointId) === "claude" ? "claude-rollout-scan" : "rollout-scan";
  }

  async scan(endpointId: string, requests: readonly RolloutScanRequest[], lease?: EndpointWorkLease): Promise<RolloutScanResult[]> {
    if (requests.length === 0) return [];
    if (requests.length > 128) throw new AppError("CONFIGURATION_ERROR", "too many rollout scan requests");
    if (this.isLocal(endpointId)) {
      const scan = this.localScanner(endpointId);
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
    const response = await context.remote.invoke(this.remoteScanOperation(endpointId), [JSON.stringify({ requests })], context.helperPath);
    this.requireLease(endpointId, lease);
    const parsed = responseSchema.safeParse(response);
    if (!parsed.success || parsed.data.results.length !== requests.length) {
      throw new AppError("ENDPOINT_UNAVAILABLE", `SSH rollout helper returned invalid data: ${endpointId}`);
    }
    return parsed.data.results.map(publicResult);
  }

  async scanUnmaterialized(endpointId: string, request: RolloutScanRequest, lease?: EndpointWorkLease): Promise<RolloutMaterialization> {
    if (request.cursor) throw new AppError("CONFIGURATION_ERROR", "unmaterialized rollout scan cannot use a cursor");
    if (this.isLocal(endpointId)) {
      try {
        const scan = this.localScanner(endpointId);
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
    const response = await context.remote.invoke(this.remoteScanOperation(endpointId), [JSON.stringify({
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
      if (attempt >= 3 || !(error instanceof Error) || error.message !== ROLLOUT_APPENDED_WHILE_SCANNING) throw error;
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
