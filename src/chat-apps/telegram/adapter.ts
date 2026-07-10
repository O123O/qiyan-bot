import type { CanonicalChatSource } from "../../core/types.ts";
import type { ClassifiedTelegramMessage, TelegramFileRef, TelegramMessage, TelegramUpdate } from "./types.ts";

export type ClassifiedUpdate =
  | { kind: "accepted"; message: ClassifiedTelegramMessage; pendingFiles: readonly TelegramFileRef[] }
  | { kind: "ignored"; updateId: number; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function normalizeUpdate(value: unknown): TelegramUpdate | undefined {
  if (!isRecord(value) || typeof value.update_id !== "number") return undefined;
  return value as unknown as TelegramUpdate;
}

function supportedFiles(message: TelegramMessage): TelegramFileRef[] {
  const files: TelegramFileRef[] = [];
  if (message.photo && message.photo.length > 0) {
    const photo = [...message.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).at(-1);
    if (photo) files.push({ fileId: photo.file_id, fileName: "photo.jpg", mediaType: "image/jpeg", ...(photo.file_size === undefined ? {} : { declaredSize: photo.file_size }) });
  }
  if (message.document) {
    files.push({
      fileId: message.document.file_id,
      fileName: message.document.file_name ?? "document",
      mediaType: message.document.mime_type ?? "application/octet-stream",
      ...(message.document.file_size === undefined ? {} : { declaredSize: message.document.file_size }),
    });
  }
  return files;
}

function isServiceMessage(message: TelegramMessage): boolean {
  return message.new_chat_members !== undefined || message.left_chat_member !== undefined;
}

export function classifyUpdate(value: unknown, ownerId: number): ClassifiedUpdate {
  const update = normalizeUpdate(value);
  if (!update) return { kind: "ignored", updateId: -1, reason: "invalid_update" };
  const message = update.message;
  if (!message || !isRecord(message)) return { kind: "ignored", updateId: update.update_id, reason: "unsupported_update" };
  if (message.from?.id !== ownerId) return { kind: "ignored", updateId: update.update_id, reason: "unauthorized_sender" };
  if (isServiceMessage(message)) return { kind: "ignored", updateId: update.update_id, reason: "service_message" };
  const pendingFiles = supportedFiles(message);
  const rawText = message.text ?? message.caption ?? "";
  if (rawText.length === 0 && pendingFiles.length === 0) return { kind: "ignored", updateId: update.update_id, reason: "unsupported_media" };
  return {
    kind: "accepted",
    message: {
      id: `telegram:${message.chat.id}:${message.message_id}`,
      nativeMessageId: message.message_id,
      updateId: update.update_id,
      userId: ownerId,
      chatId: message.chat.id,
      rawText,
      attachments: [],
      receivedAt: message.date * 1000,
    },
    pendingFiles,
  };
}

export function toTelegramCanonicalSource(message: ClassifiedTelegramMessage, attachmentIds: readonly string[]): CanonicalChatSource {
  return {
    id: message.id,
    nativeSourceId: String(message.updateId),
    binding: {
      adapterId: "telegram",
      conversationKey: `telegram:${message.chatId}`,
      destination: { chatId: String(message.chatId) },
      reply: { messageId: message.nativeMessageId },
    },
    rawText: message.rawText,
    attachmentIds: [...attachmentIds],
    receivedAt: message.receivedAt,
  };
}
