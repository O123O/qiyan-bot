import { createHash } from "node:crypto";
import type { ToolActionContext } from "../../assistant/tools.ts";
import type { AttachmentStore, FileHandleId, StoredAttachment } from "../../attachments/store.ts";
import type { DeliveryStore } from "../../storage/delivery-store.ts";
import type { ConversationBinding } from "./binding.ts";

interface ChatOutputOptions {
  deliveries: DeliveryStore;
  attachments: AttachmentStore;
  prepareAttachment(owner: string, relativePath: string, scopeId: string, requestedId: FileHandleId): Promise<StoredAttachment>;
  binding(attemptId: string): ConversationBinding;
}

export function createChatOutputActions(options: ChatOutputOptions) {
  return {
    send_chat_message: async (args: { content: string }, context: ToolActionContext) => ({
      deliveryId: options.deliveries.prepare({
        id: chatMessageDeliveryId(context.effectiveSourceContextId, context.attemptId, context.callId),
        kind: "chat",
        binding: options.binding(context.attemptId),
        body: args.content,
        mandatory: false,
      }).id,
    }),
    prepare_chat_attachment: async (args: { owner: string; relative_path: string }, context: ToolActionContext) => {
      const prepared = await options.prepareAttachment(
        args.owner, args.relative_path, context.effectiveSourceContextId,
        chatAttachmentFileHandle(context.effectiveSourceContextId, context.attemptId, context.callId),
      );
      return {
        file_handle: prepared.id,
        display_name: prepared.displayName,
        media_type: prepared.mediaType,
        size: prepared.size,
        sha256: prepared.sha256,
      };
    },
    send_chat_attachment: async (args: { file_handle: string; caption?: string }, context: ToolActionContext) => {
      options.attachments.toUserInput(context.effectiveSourceContextId, args.file_handle as FileHandleId);
      const delivery = options.deliveries.prepareAttachment({
        id: chatAttachmentDeliveryId(context.effectiveSourceContextId, context.attemptId, context.callId),
        kind: "attachment",
        binding: options.binding(context.attemptId),
        body: args.caption ?? "",
        mandatory: false,
        attachmentId: args.file_handle,
        attachmentScopeId: context.effectiveSourceContextId,
      });
      return { deliveryId: delivery.id };
    },
  };
}

export function chatMessageDeliveryId(contextId: string, attemptId: string, callId: string): string {
  return `chat:${contextId}:${attemptId}:${callId}`;
}

export function chatAttachmentDeliveryId(contextId: string, attemptId: string, callId: string): string {
  return `chat-attachment:${contextId}:${attemptId}:${callId}`;
}

export function chatAttachmentFileHandle(contextId: string, attemptId: string, callId: string): FileHandleId {
  return `file_${createHash("sha256").update(`${contextId}\0${attemptId}\0${callId}`).digest("hex")}`;
}
