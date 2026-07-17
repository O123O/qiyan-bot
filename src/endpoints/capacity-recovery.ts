import { z } from "zod";
import type { SessionRegistry } from "../registry/session-registry.ts";
import type { RecoverableOperation } from "../storage/operation-store.ts";

const capacityHintSchema = z.object({
  phase: z.literal("provisional-start"),
  endpoint: z.string().min(1),
  threadId: z.string().min(1),
  mappingId: z.string().min(1),
  clientUserMessageId: z.string().min(1),
  baselineTurnId: z.string().min(1).nullable().optional(),
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
    registry: Pick<SessionRegistry, "snapshot">;
    operations: { listRecoverable(): RecoverableOperation[] };
    quarantine(operation: RecoverableOperation, reason: string): void;
  }) {}

  restoreBeforeIngress(): string[] {
    const endpointIds = new Set(Object.values(this.options.registry.snapshot().sessions).map((session) => session.endpoint));
    for (const operation of this.options.operations.listRecoverable()) {
      if (operation.kind !== "send_to_session" || !operation.receipt || typeof operation.receipt !== "object"
        || !("capacityHint" in operation.receipt)) continue;
      const hint = recoverableCapacityHint(operation);
      if (!hint) {
        this.options.quarantine(operation, "invalid provisional-start capacity checkpoint");
        continue;
      }
      // A durable provisional record identifies an endpoint that needs bounded dispatch
      // reconciliation. It never reserves live capacity; current native state does that after
      // the endpoint generation is restored.
      endpointIds.add(hint.endpoint);
    }
    return [...endpointIds];
  }
}
