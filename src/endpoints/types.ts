import { z } from "zod";
import type { AppServerEndpoint } from "../app-server/pool.ts";
import type { PermissionBlockedEvent } from "../app-server/managed-endpoint.ts";

export type RuntimeIdentity =
  | { kind: "local"; pid: number; startTime: string }
  | { kind: "ssh"; token: string; pid: number; linuxStartTime: string; processGroupId: number };

export type EndpointLossKind = "connection-lost" | "runtime-lost";
export type EndpointLossReason =
  | "frame_too_large"
  | "invalid_frame"
  | "ssh_diagnostic_limit"
  | "ssh_input_closed"
  | "ssh_process_failed"
  | "transport_reset"
  | "transport_error"
  | "runtime_exited"
  | "transport_closed";

const LOSS_REASON = Symbol.for("qiyan.endpointLossReason");

// A transport that closes with no error of its own still has to hand the endpoint SOMETHING, and
// every layer that synthesizes that something used to do it with a bare message. The classifier
// matched those messages by text, so a reworded message silently downgraded a known cause to
// `transport_error` -- which is what happened to the byte-stream branch, left matching a string no
// code produced. The reason now travels ON the error.
export function tagEndpointLoss<E extends Error>(error: E, reason: EndpointLossReason): E {
  return Object.assign(error, { [LOSS_REASON]: reason });
}

export function endpointLossError(reason: EndpointLossReason, message: string): Error {
  return tagEndpointLoss(new Error(message), reason);
}

export function taggedLossReason(error: Error): EndpointLossReason | undefined {
  return (error as Error & { [LOSS_REASON]?: EndpointLossReason })[LOSS_REASON];
}

export interface EndpointWorkLease {
  readonly endpointId: string;
  readonly lifecycleGeneration: number;
  readonly endpointGeneration: number;
  readonly leaseId: string;
}

export interface ManagedAppServerEndpoint extends AppServerEndpoint {
  // True when the endpoint has no persistent runtime to restart/shut down (currently
  // local Claude). Remote Claude owns a detached tmux runtime and therefore participates
  // in the same identity-based drain/shutdown lifecycle as remote Codex.
  readonly daemonless?: boolean;
  start(): Promise<void>;
  closeConnection(): Promise<void>;
  // `force` destroys the runtime by location instead of proving its identity first. See
  // docs/development/forced-restart-design.md. Returns what the destroy left behind, when the
  // runtime is one that can report it.
  // The identity may be absent only under force, which destroys by location and needs none.
  shutdownRuntime(expectedIdentity: RuntimeIdentity | undefined, force?: boolean): Promise<RuntimeDestroyReport | undefined>;
  runtimeIdentity(): Promise<RuntimeIdentity | undefined>;
  onNotification(listener: (method: string, params: unknown) => void): () => void;
  onReady(listener: () => void): () => void;
  onUnavailable(listener: (kind: EndpointLossKind, reason?: EndpointLossReason) => void): () => void;
  onPermissionBlocked(listener: (event: PermissionBlockedEvent) => void): () => void;
}

// What a destroy left behind. Force's whole justification is that the operator spends something
// deliberately, so he is owed an account of what was spent rather than a bare success.
export interface RuntimeDestroyReport {
  // The identity read immediately before the destroy, or null when there was none. A force that
  // killed something must be able to say what.
  readonly destroyedIdentity: RuntimeIdentity | null;
  // Token-carrying members that outlived SIGKILL. With no identity there was nothing to signal
  // FROM, so this is the string reason rather than 0: a zero there reads as "clean" when it means
  // "did not look", and a detached app-server outside the pane's process group survives
  // kill-session unaccounted for in exactly that case.
  readonly survivors?: number | string;
  // The recorded server process itself is still alive and token-carrying. Unforced this raises;
  // under force it is reported, because the socket is unlinked and the replacement gets a new pid,
  // process group, token and port -- but it is loud enough to deserve its own field.
  readonly serverSurvived?: boolean;
}

export const runtimeDestroyReportSchema = z.object({
  destroyedIdentity: z.unknown().optional(),
  survivors: z.union([z.number(), z.string()]).optional(),
  serverSurvived: z.boolean().optional(),
}).passthrough();

const identitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), pid: z.number().int().positive(), startTime: z.string().regex(/^\d+$/u) }).strict(),
  z.object({
    kind: z.literal("ssh"), token: z.string().regex(/^[a-f0-9]{32}$/u), pid: z.number().int().positive(),
    linuxStartTime: z.string().regex(/^\d+$/u), processGroupId: z.number().int().positive(),
  }).strict(),
]);

export function parseRuntimeIdentity(value: unknown): RuntimeIdentity { return identitySchema.parse(value); }

// A destroy that happened is not undone by a report we cannot read, so an unparseable identity
// degrades to null rather than throwing: the kill is already done, and refusing here would turn a
// completed destroy into a failed operation and leave the row fencing the endpoint.
export function parseRuntimeDestroyReport(value: unknown): RuntimeDestroyReport {
  const parsed = runtimeDestroyReportSchema.safeParse(value);
  if (!parsed.success) return { destroyedIdentity: null };
  let destroyedIdentity: RuntimeIdentity | null = null;
  try { destroyedIdentity = identitySchema.parse(parsed.data.destroyedIdentity); } catch { destroyedIdentity = null; }
  return {
    destroyedIdentity,
    ...(parsed.data.survivors === undefined ? {} : { survivors: parsed.data.survivors }),
    ...(parsed.data.serverSurvived === undefined ? {} : { serverSurvived: parsed.data.serverSurvived }),
  };
}
