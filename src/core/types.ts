export type SessionKey = `${string}:${string}`;
export type ManagementState =
  | "managed"
  | "detaching"
  | "detached"
  | "attaching"
  | "archived"
  | "unavailable";
export type OperationState = "prepared" | "dispatched" | "succeeded" | "failed" | "uncertain";
export type DeliveryState = "prepared" | "dispatched" | "confirmed" | "failed" | "uncertain";

export interface SourceContext {
  id: string;
  kind: "telegram" | "event_batch" | "recovery";
  sourceId: string;
  rawText: string;
  attachmentIds: readonly string[];
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
