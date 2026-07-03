import { createHash } from "node:crypto";
import type { JsonValue } from "../chat/binding.ts";
import type { ChatDeliveryAdapter } from "../chat/contracts.ts";
import { SlackApiError, type SlackBotClient } from "./clients.ts";

interface SlackDestination {
  workspaceId: string;
  channelId: string;
  threadTs?: string;
}

export class SlackDeliveryAdapter implements ChatDeliveryAdapter {
  readonly id = "slack";

  constructor(private readonly teamId: string, private readonly client: SlackBotClient) {}

  async sendMessage(
    destination: JsonValue,
    body: string,
    _reply?: JsonValue,
    options?: { deliveryId: string },
  ): Promise<JsonValue> {
    const target = this.destination(destination);
    if (!options?.deliveryId) throw new TypeError("Slack delivery requires a delivery ID");
    const result = await this.client.postMessage({
      channel: target.channelId,
      text: body,
      ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
      client_msg_id: slackClientMessageId(options.deliveryId),
    });
    const messageTs = stringField(result, "ts");
    const channelId = stringField(result, "channel") ?? target.channelId;
    if (!messageTs) throw new SlackApiError("Slack chat.postMessage returned no message identity", undefined, undefined, false, false);
    return { channelId, messageTs };
  }

  async sendDocument(destination: JsonValue, file: {
    stream: AsyncIterable<Uint8Array | string>;
    size: number;
    displayName: string;
    mediaType: string;
    deliveryId: string;
    caption?: string;
    reply?: JsonValue;
  }): Promise<JsonValue> {
    const target = this.destination(destination);
    if (!file.deliveryId) throw new TypeError("Slack delivery requires a delivery ID");
    const result = await this.client.uploadFileV2({
      channel_id: target.channelId,
      ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
      file: file.stream,
      filename: file.displayName,
      title: file.displayName,
      ...(file.caption === undefined ? {} : { initial_comment: file.caption }),
    });
    const fileIds = Array.isArray(result.files)
      ? [...new Set(result.files.flatMap((value) => completionFileIds(value)))]
      : [];
    if (fileIds.length === 0) {
      throw new SlackApiError("Slack filesUploadV2 returned no file identity", undefined, undefined, false, false);
    }
    return { channelId: target.channelId, fileIds };
  }

  isSafeToRetry(error: unknown): boolean {
    return error instanceof SlackApiError && error.safeToRetry === true;
  }

  private destination(value: JsonValue): SlackDestination {
    const candidate = record(value);
    const workspaceId = candidate && stringField(candidate, "workspaceId");
    const channelId = candidate && stringField(candidate, "channelId");
    const threadTs = candidate && candidate.threadTs === undefined ? undefined : candidate && stringField(candidate, "threadTs");
    if (
      workspaceId !== this.teamId
      || !channelId
      || !/^[CDG][A-Z0-9]+$/u.test(channelId)
      || (candidate?.threadTs !== undefined && (!threadTs || !/^\d+\.\d+$/u.test(threadTs)))
    ) throw new TypeError("Slack destination is invalid or belongs to another workspace");
    return { workspaceId, channelId, ...(threadTs ? { threadTs } : {}) };
  }
}

export function slackClientMessageId(deliveryId: string): string {
  const bytes = Buffer.from(createHash("sha256").update(`qiyan-slack-delivery\0${deliveryId}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" && value[key].length > 0 ? value[key] : undefined;
}

function completionFileIds(value: unknown): string[] {
  const completion = record(value);
  if (!completion) return [];
  const direct = stringField(completion, "id");
  const nested = Array.isArray(completion.files)
    ? completion.files.flatMap((file) => {
      const item = record(file);
      const id = item && stringField(item, "id");
      return id ? [id] : [];
    })
    : [];
  return direct ? [direct, ...nested] : nested;
}
