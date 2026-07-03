import type { ConversationBinding, JsonValue } from "../chat/binding.ts";
import type { ChatHistoryProvider, ChatHistoryRequest } from "../chat/contracts.ts";
import type { SlackBotClient } from "./clients.ts";

interface SlackDestination {
  workspaceId: string;
  channelId: string;
  threadTs?: string;
}

interface NormalizedHistoryMessage {
  channelId: string;
  messageTs: string;
  text: string;
  authorId?: string;
  threadTs?: string;
}

export class SlackContextService implements ChatHistoryProvider {
  constructor(private readonly client: SlackBotClient, private readonly teamId: string) {}

  async getHistory(binding: ConversationBinding, request: ChatHistoryRequest): Promise<JsonValue> {
    if (!Number.isInteger(request.count) || request.count < 1 || request.count > 100) throw new TypeError("Slack history count is invalid");
    if (request.before !== undefined && !isTimestamp(request.before)) throw new TypeError("Slack history boundary is invalid");
    const destination = this.destination(binding);
    return request.scope === "conversation" && destination.threadTs
      ? this.threadHistory({ ...destination, threadTs: destination.threadTs }, request)
      : this.channelHistory(destination, request);
  }

  private async channelHistory(destination: SlackDestination, request: ChatHistoryRequest): Promise<JsonValue> {
    const newest: NormalizedHistoryMessage[] = [];
    let cursor: string | undefined;
    do {
      const remaining = request.count - newest.length;
      const response = await this.client.conversationHistory({
        channel: destination.channelId,
        limit: Math.min(100, remaining),
        ...(request.before ? { latest: request.before, inclusive: false } : {}),
        ...(cursor ? { cursor } : {}),
      });
      for (const candidate of messages(response)) {
        const normalized = normalizeMessage(candidate, destination.channelId);
        if (!normalized || (request.before && compareTimestamp(normalized.messageTs, request.before) >= 0)) continue;
        newest.push(normalized);
        if (newest.length === request.count) break;
      }
      cursor = newest.length < request.count ? nextCursor(response) : undefined;
    } while (cursor);
    const ordered = newest.reverse();
    return {
      order: "oldest_first",
      messages: ordered as unknown as JsonValue,
      ...(ordered[0] ? { nextBefore: ordered[0].messageTs } : {}),
    };
  }

  private async threadHistory(destination: SlackDestination & { threadTs: string }, request: ChatHistoryRequest): Promise<JsonValue> {
    const ring: NormalizedHistoryMessage[] = [];
    let cursor: string | undefined;
    let rootSeen = false;
    do {
      const response = await this.client.conversationReplies({
        channel: destination.channelId,
        ts: destination.threadTs,
        limit: 100,
        ...(request.before ? { latest: request.before, inclusive: false } : {}),
        ...(cursor ? { cursor } : {}),
      });
      for (const candidate of messages(response)) {
        const normalized = normalizeMessage(candidate, destination.channelId);
        if (!normalized || (request.before && compareTimestamp(normalized.messageTs, request.before) >= 0)) continue;
        if (normalized.messageTs === destination.threadTs) {
          if (rootSeen) continue;
          rootSeen = true;
        }
        if (ring.some((item) => item.messageTs === normalized.messageTs)) continue;
        ring.push(normalized);
        if (ring.length > request.count) ring.shift();
      }
      cursor = nextCursor(response);
    } while (cursor);
    return {
      order: "oldest_first",
      messages: ring as unknown as JsonValue,
      ...(ring[0] ? { nextBefore: ring[0].messageTs } : {}),
    };
  }

  private destination(binding: ConversationBinding): SlackDestination {
    const candidate = record(binding.destination);
    const workspaceId = candidate && string(candidate.workspaceId);
    const channelId = candidate && string(candidate.channelId);
    const threadTs = candidate && candidate.threadTs === undefined ? undefined : candidate && string(candidate.threadTs);
    if (binding.adapterId !== "slack" || workspaceId !== this.teamId || !channelId || (candidate?.threadTs !== undefined && (!threadTs || !isTimestamp(threadTs)))) {
      throw new TypeError("Slack binding is invalid or belongs to another workspace");
    }
    return { workspaceId, channelId, ...(threadTs ? { threadTs } : {}) };
  }
}

function messages(response: Record<string, unknown>): unknown[] {
  return Array.isArray(response.messages) ? response.messages : [];
}

function nextCursor(response: Record<string, unknown>): string | undefined {
  const metadata = record(response.response_metadata);
  return metadata ? string(metadata.next_cursor) : undefined;
}

function normalizeMessage(value: unknown, channelId: string): NormalizedHistoryMessage | undefined {
  const item = record(value);
  const messageTs = item && string(item.ts);
  if (!item || !messageTs || !isTimestamp(messageTs)) return undefined;
  const authorId = string(item.user) ?? string(item.bot_id);
  const threadTs = string(item.thread_ts);
  return {
    channelId,
    messageTs,
    text: typeof item.text === "string" ? item.text : "",
    ...(authorId ? { authorId } : {}),
    ...(threadTs ? { threadTs } : {}),
  };
}

function compareTimestamp(left: string, right: string): number {
  const [leftSeconds = "", leftFraction = ""] = left.split(".");
  const [rightSeconds = "", rightFraction = ""] = right.split(".");
  const seconds = BigInt(leftSeconds || "0") - BigInt(rightSeconds || "0");
  if (seconds !== 0n) return seconds < 0n ? -1 : 1;
  return leftFraction.padEnd(6, "0").localeCompare(rightFraction.padEnd(6, "0"));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isTimestamp(value: string): boolean { return /^\d+\.\d+$/u.test(value); }
