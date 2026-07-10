import type { JsonValue } from "../shared/binding.ts";
import type { ChatDeliveryAdapter } from "../shared/contracts.ts";

interface TelegramDeliveryApi {
  sendMessage(chatId: number | string, text: string, replyTo?: number): Promise<{ message_id: number }>;
  sendDocument(chatId: number | string, file: {
    stream: AsyncIterable<Uint8Array | string>;
    size: number;
    displayName: string;
    mediaType: string;
    caption?: string;
    replyTo?: number;
  }): Promise<{ message_id: number }>;
}

export class TelegramDeliveryAdapter implements ChatDeliveryAdapter {
  readonly id = "telegram";
  constructor(private readonly api: TelegramDeliveryApi) {}

  async sendMessage(destination: JsonValue, body: string, reply?: JsonValue): Promise<JsonValue> {
    const result = await this.api.sendMessage(chatId(destination), body, messageId(reply));
    return { messageId: result.message_id };
  }

  async sendDocument(destination: JsonValue, file: {
    stream: AsyncIterable<Uint8Array | string>;
    size: number;
    displayName: string;
    mediaType: string;
    caption?: string;
    reply?: JsonValue;
  }): Promise<JsonValue> {
    const result = await this.api.sendDocument(chatId(destination), {
      stream: file.stream,
      size: file.size,
      displayName: file.displayName,
      mediaType: file.mediaType,
      ...(file.caption === undefined ? {} : { caption: file.caption }),
      ...(messageId(file.reply) === undefined ? {} : { replyTo: messageId(file.reply)! }),
    });
    return { messageId: result.message_id };
  }
}

function chatId(value: JsonValue): string | number {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("chatId" in value)) throw new TypeError("Telegram destination requires chatId");
  const id = value.chatId;
  if (typeof id !== "string" && typeof id !== "number") throw new TypeError("Telegram chatId must be a string or number");
  return id;
}

function messageId(value: JsonValue | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value) || typeof value.messageId !== "number") throw new TypeError("Telegram reply requires messageId");
  return value.messageId;
}
