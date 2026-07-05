import { z } from "zod";
import type { AppServerPool } from "../app-server/pool.ts";
import type { SessionRegistry } from "../registry/session-registry.ts";
import type { RecoverableOperation } from "../storage/operation-store.ts";
import type { RuntimeStore } from "../storage/runtime-store.ts";

const capacityHintSchema = z.object({
  phase: z.literal("provisional-start"),
  endpoint: z.string().min(1),
  threadId: z.string().min(1),
  mappingId: z.string().min(1),
  clientUserMessageId: z.string().min(1),
}).strict();

export type CapacityHint = z.infer<typeof capacityHintSchema>;

export function parseCapacityHint(value: unknown): CapacityHint | undefined {
  const result = capacityHintSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function recoverableCapacityHint(operation: Pick<RecoverableOperation, "kind" | "receipt">): CapacityHint | undefined {
  if (operation.kind !== "send_to_session" || !operation.receipt || typeof operation.receipt !== "object") return undefined;
  return parseCapacityHint((operation.receipt as { capacityHint?: unknown }).capacityHint);
}

export class EndpointCapacityRecovery {
  constructor(private readonly options: {
    runtime: Pick<RuntimeStore, "listSessions">;
    registry: Pick<SessionRegistry, "getByIdentity">;
    operations: { listRecoverable(): RecoverableOperation[] };
    pool: Pick<AppServerPool, "restoreObservedActiveTurn" | "restoreProvisionalTurnCapacity">;
    quarantine(operation: RecoverableOperation, reason: string): void;
  }) {}

  restoreBeforeIngress(): string[] {
    const endpointIds = new Set<string>();
    for (const state of this.options.runtime.listSessions()) {
      if (!state.activeTurnId) continue;
      const mapping = this.options.registry.getByIdentity(state.endpointId, state.threadId);
      if (!mapping || mapping.session.mapping_id !== state.mappingId || mapping.session.lifecycle_state !== "managed") continue;
      this.options.pool.restoreObservedActiveTurn(state.endpointId, state.threadId, state.activeTurnId);
      endpointIds.add(state.endpointId);
    }
    for (const operation of this.options.operations.listRecoverable()) {
      if (operation.kind !== "send_to_session" || !operation.receipt || typeof operation.receipt !== "object"
        || !("capacityHint" in operation.receipt)) continue;
      const hint = recoverableCapacityHint(operation);
      if (!hint) {
        this.options.quarantine(operation, "invalid provisional-start capacity checkpoint");
        continue;
      }
      this.options.pool.restoreProvisionalTurnCapacity(hint.endpoint, hint.threadId, `recovered:${operation.id}`, hint.clientUserMessageId);
      endpointIds.add(hint.endpoint);
    }
    return [...endpointIds];
  }
}
