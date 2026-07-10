import type { JsonValue } from "./binding.ts";
import type { ConversationBinding } from "./binding.ts";

export interface ChatHistoryRequest {
  scope: "conversation" | "channel";
  count: number;
  before?: string;
}

export interface ChatHistoryProvider {
  getHistory(binding: ConversationBinding, request: ChatHistoryRequest): Promise<JsonValue>;
}

export type UncertainDeliveryResolution =
  | { outcome: "confirmed"; receipt: JsonValue }
  | { outcome: "resume_safe" }
  | { outcome: "unresolved" };

export interface UncertainDeliveryContext {
  id: string;
  binding: ConversationBinding;
  mandatory: boolean;
  hasAttachment: boolean;
}

export interface ChatDeliveryAdapter {
  readonly id: string;
  reconcileUncertain?(delivery: UncertainDeliveryContext): Promise<UncertainDeliveryResolution>;
  sendMessage(destination: JsonValue, body: string, reply?: JsonValue, options?: { deliveryId: string }): Promise<JsonValue>;
  sendDocument?(destination: JsonValue, file: {
    stream: AsyncIterable<Uint8Array | string>;
    size: number;
    displayName: string;
    mediaType: string;
    deliveryId: string;
    caption?: string;
    reply?: JsonValue;
  }): Promise<JsonValue>;
  isSafeToRetry?(error: unknown): boolean;
}

export interface ChatAdapterCapabilities {
  readonly delivery: ChatDeliveryAdapter;
  readonly history?: ChatHistoryProvider;
}

export interface ChatAdapter extends ChatAdapterCapabilities {
  initialize(): Promise<void>;
  start(): void | Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}
