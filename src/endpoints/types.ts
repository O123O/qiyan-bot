import { z } from "zod";
import type { AppServerEndpoint } from "../app-server/pool.ts";
import type { PermissionBlockedEvent } from "../app-server/managed-endpoint.ts";

export type RuntimeIdentity =
  | { kind: "local"; pid: number; startTime: string }
  | { kind: "ssh"; token: string; pid: number; linuxStartTime: string; processGroupId: number };

export type EndpointLossKind = "connection-lost" | "runtime-lost";
export type EndpointLossReason = "frame_too_large" | "invalid_frame" | "transport_error" | "transport_closed";

export interface EndpointWorkLease {
  readonly endpointId: string;
  readonly lifecycleGeneration: number;
  readonly endpointGeneration: number;
  readonly leaseId: string;
}

export interface ManagedAppServerEndpoint extends AppServerEndpoint {
  // True when the endpoint has no persistent daemon to restart/shut down (a Claude
  // endpoint drives ephemeral `claude -p` subprocesses), so it never has a runtime
  // identity to prove. The manager skips the identity-based drain/shutdown dance for it.
  readonly daemonless?: boolean;
  start(): Promise<void>;
  closeConnection(): Promise<void>;
  shutdownRuntime(expectedIdentity: RuntimeIdentity): Promise<void>;
  runtimeIdentity(): Promise<RuntimeIdentity | undefined>;
  onNotification(listener: (method: string, params: unknown) => void): () => void;
  onReady(listener: () => void): () => void;
  onUnavailable(listener: (kind: EndpointLossKind, reason?: EndpointLossReason) => void): () => void;
  onPermissionBlocked(listener: (event: PermissionBlockedEvent) => void): () => void;
}

const identitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), pid: z.number().int().positive(), startTime: z.string().regex(/^\d+$/u) }).strict(),
  z.object({
    kind: z.literal("ssh"), token: z.string().regex(/^[a-f0-9]{32}$/u), pid: z.number().int().positive(),
    linuxStartTime: z.string().regex(/^\d+$/u), processGroupId: z.number().int().positive(),
  }).strict(),
]);

export function parseRuntimeIdentity(value: unknown): RuntimeIdentity { return identitySchema.parse(value); }
