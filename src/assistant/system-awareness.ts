import type { ConversationBinding } from "../chat-apps/shared/binding.ts";
import type { ConversationStore } from "../storage/conversation-store.ts";
import type { DeliveryStore } from "../storage/delivery-store.ts";

export function recordCompletedSystemAction(
  conversations: Pick<ConversationStore, "createInternalSource">,
  deliveries: Pick<DeliveryStore, "prepare">,
  operationId: string,
  awarenessBody: string,
  notice?: { binding: ConversationBinding; body: string },
): void {
  if (notice) {
    deliveries.prepare({
      id: `tool-system:${operationId}`,
      kind: "system_notice",
      binding: notice.binding,
      body: notice.body,
      mandatory: true,
    });
  }
  recordAssistantSystemAwareness(conversations, operationId, awarenessBody);
}

export function recordAssistantSystemAwareness(
  conversations: Pick<ConversationStore, "createInternalSource">,
  operationId: string,
  body: string,
  receivedAt = Date.now(),
): string {
  return conversations.createInternalSource({
    id: `assistant-system:${operationId}`,
    kind: "system_notice",
    sourceId: operationId,
    rawText: `[system] ${body}`,
    attachmentIds: [],
    receivedAt,
  });
}
