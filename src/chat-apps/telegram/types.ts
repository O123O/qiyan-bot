import type { CanonicalMessage } from "../../core/types.ts";

export interface ClassifiedTelegramMessage extends CanonicalMessage {
  nativeMessageId: number;
}

export interface TelegramFileRef {
  fileId: string;
  fileName: string;
  mediaType: string;
  declaredSize?: number;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  from?: { id: number };
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_size?: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  new_chat_members?: unknown[];
  left_chat_member?: unknown;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: unknown;
  callback_query?: unknown;
  channel_post?: unknown;
  [key: string]: unknown;
}
