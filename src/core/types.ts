import type { ConversationBinding } from "../chat-apps/shared/binding.ts";

export type SessionKey = `${string}:${string}`;
export type ManagementState =
  | "adopting"
  | "managed"
  | "unadopting"
  | "archiving"
  | "unavailable";
export type OperationState = "prepared" | "dispatched" | "succeeded" | "failed" | "uncertain";
export type DeliveryState = "prepared" | "dispatched" | "confirmed" | "failed" | "uncertain";

export interface SourceContext {
  id: string;
  kind: "telegram" | "slack" | "event_batch" | "recovery";
  sourceId: string;
  rawText: string;
  attachmentIds: readonly string[];
  failedAttachments?: readonly FailedAttachmentDescriptor[];
  binding?: ConversationBinding;
  arrivalSequence?: number;
  queueNoticeRequired?: boolean;
}

export interface CanonicalChatSource {
  id: string;
  nativeSourceId: string;
  binding: ConversationBinding;
  rawText: string;
  attachmentIds: readonly string[];
  failedAttachments?: readonly FailedAttachmentDescriptor[];
  receivedAt: number;
}

export interface FailedAttachmentDescriptor {
  nativeId: string;
  displayName: string;
  reasonCode: string;
}

export interface CanonicalAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
}

export interface CanonicalMessage {
  id: string;
  updateId: number;
  userId: number;
  chatId: number;
  rawText: string;
  attachments: readonly CanonicalAttachment[];
  receivedAt: number;
}
