import type { ConversationBinding, JsonValue } from "../chat/binding.ts";
import type { ChatHistoryProvider, ChatHistoryRequest } from "../chat/contracts.ts";
import { AppError } from "../core/errors.ts";
import { SlackApiError, type SlackBotClient, type SlackSearchClient, type SlackSearchCoverage } from "./clients.ts";
import { TransientResultLimiter, type TransientResults } from "./result-limiter.ts";

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

type SearchMatch = Record<string, unknown> & { kind: "message" | "file" | "channel" | "user" };
interface IndexedSearchMatch {
  result: SearchMatch;
  sortTimestamp: string;
  sortChannelId: string;
  sortKey: string;
}

const CHANNEL_TYPES = ["public_channel", "private_channel", "mpim", "im"] as const;
const CONTENT_TYPES = ["messages", "files", "channels", "users"] as const;

interface SlackContextOptions {
  search: SlackSearchClient;
  ownerUserId: string;
  coverage: SlackSearchCoverage;
  now(): number;
}

export class SlackContextService implements ChatHistoryProvider {
  constructor(private readonly client: SlackBotClient, private readonly teamId: string, private readonly options?: SlackContextOptions) {}

  async getHistory(binding: ConversationBinding, request: ChatHistoryRequest): Promise<JsonValue> {
    if (!Number.isInteger(request.count) || request.count < 1 || request.count > 100) throw new TypeError("Slack history count is invalid");
    if (request.before !== undefined && !isTimestamp(request.before)) throw new TypeError("Slack history boundary is invalid");
    const destination = this.destination(binding);
    return request.scope === "conversation" && destination.threadTs
      ? this.threadHistory({ ...destination, threadTs: destination.threadTs }, request)
      : this.channelHistory(destination, request);
  }

  search(query: string, dateFrom?: string, dateTo?: string): Promise<TransientResults<SearchMatch>> {
    if (!query.trim()) throw new TypeError("Slack search query is required");
    return this.searchPages({
      query,
      ...(dateFrom === undefined ? {} : { dateFrom }),
      ...(dateTo === undefined ? {} : { dateTo }),
      contentTypes: CONTENT_TYPES,
      exactMention: false,
    });
  }

  mentions(dateFrom: string): Promise<TransientResults<SearchMatch>> {
    const ownerUserId = this.requireSearch().ownerUserId;
    return this.searchPages({ query: `<@${ownerUserId}>`, dateFrom, contentTypes: ["messages"], exactMention: true });
  }

  private async searchPages(input: {
    query: string;
    dateFrom?: string;
    dateTo?: string;
    contentTypes: readonly ("messages" | "files" | "channels" | "users")[];
    exactMention: boolean;
  }): Promise<TransientResults<SearchMatch>> {
    const options = this.requireSearch();
    const fromMs = input.dateFrom === undefined ? undefined : parseUtcDate(input.dateFrom, "date_from");
    const toMs = input.dateTo === undefined ? options.now() : parseUtcDate(input.dateTo, "date_to");
    if (fromMs !== undefined && fromMs >= toMs) throw new TypeError("Slack search date_from must precede date_to");
    const coverage: SlackSearchCoverage = {
      ...options.coverage,
      requested: [...options.coverage.requested],
      omitted: [...options.coverage.omitted],
      errors: [...options.coverage.errors],
      limitedTo: { channelTypes: [...CHANNEL_TYPES], contentTypes: [...input.contentTypes] },
    };
    const limiter = new TransientResultLimiter<IndexedSearchMatch>({
      identity: (item) => ({ channelId: item.sortChannelId, timestamp: item.sortTimestamp, key: item.sortKey }),
      render: renderSearchMatch,
    });
    let cursor: string | undefined;
    let page = 0;
    let complete = true;
    let warning: string | undefined;
    const seenCursors = new Set<string>();
    do {
      let response: Record<string, unknown>;
      try {
        response = await options.search.searchContext({
          query: input.query,
          channel_types: [...CHANNEL_TYPES],
          content_types: [...input.contentTypes],
          include_context_messages: true,
          include_message_blocks: true,
          include_bots: true,
          sort: "timestamp",
          sort_dir: "desc",
          limit: 20,
          ...(fromMs === undefined ? {} : { after: Math.floor(fromMs / 1_000) - 1 }),
          before: Math.ceil(toMs / 1_000),
          ...(cursor ? { cursor } : {}),
        });
      } catch (error) {
        if (page === 0) throw new AppError("ENDPOINT_UNAVAILABLE", "Slack search is unavailable; verify the read-only user token and search scopes");
        complete = false;
        const failure = continuationFailure(error);
        warning = failure.warning;
        coverage.errors = [...coverage.errors, failure.marker];
        break;
      }
      const results = record(response.results);
      if (!results) {
        if (page === 0) throw new AppError("ENDPOINT_UNAVAILABLE", "Slack search is unavailable; Slack returned no result page");
        complete = false;
        warning = "Slack search continuation returned an invalid page; returned results are partial.";
        coverage.errors = [...coverage.errors, "invalid_page"];
        break;
      }
      const normalized = normalizeSearchPage(results, this.teamId);
      const bounded = normalized.filter((item) => withinDateBounds(item, fromMs, toMs));
      limiter.addPage(input.exactMention ? bounded.filter((item) => isExactOwnerMention(item, options.ownerUserId)) : bounded);
      page += 1;
      const next = nextCursor(results) ?? nextCursor(response);
      if (next && seenCursors.has(next)) {
        complete = false;
        warning = "Slack search continuation repeated a cursor; returned results are partial.";
        coverage.errors = [...coverage.errors, "repeated_cursor"];
        break;
      }
      if (next) seenCursors.add(next);
      cursor = next;
    } while (cursor);
    const limited = limiter.finish({ complete, coverage, ...(warning ? { warning } : {}) });
    return { ...limited, results: limited.results.map(({ result }) => result) };
  }

  private requireSearch(): SlackContextOptions {
    if (!this.options) throw new AppError("UNSUPPORTED_CAPABILITY", "Slack search is not configured");
    return this.options;
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

function normalizeSearchPage(results: Record<string, unknown>, expectedTeamId: string): IndexedSearchMatch[] {
  return [
    ...array(results.messages).flatMap((value) => normalizeSearchMessage(value, expectedTeamId)),
    ...array(results.files).flatMap((value) => normalizeSearchFile(value, expectedTeamId)),
    ...array(results.channels).flatMap((value) => normalizeSearchChannel(value, expectedTeamId)),
    ...array(results.users).flatMap((value) => normalizeSearchUser(value, expectedTeamId)),
  ];
}

function normalizeSearchMessage(value: unknown, expectedTeamId: string): IndexedSearchMatch[] {
  const item = record(value);
  const channelId = item && string(item.channel_id);
  const messageTs = item && string(item.message_ts);
  if (!item || !channelId || !messageTs || !isTimestamp(messageTs) || wrongTeam(item, expectedTeamId)) return [];
  const context = record(item.context_messages);
  const result: SearchMatch = {
    kind: "message",
    channelId,
    messageTs,
    text: typeof item.content === "string" ? item.content : "",
    ...(string(item.channel_name) ? { channelName: string(item.channel_name)! } : {}),
    ...(string(item.author_user_id) ? { authorUserId: string(item.author_user_id)! } : {}),
    ...(string(item.author_name) ? { authorName: string(item.author_name)! } : {}),
    ...(typeof item.is_author_bot === "boolean" ? { isAuthorBot: item.is_author_bot } : {}),
    ...(string(item.thread_ts) ? { threadTs: string(item.thread_ts)! } : {}),
    ...(string(item.permalink) ? { permalink: string(item.permalink)! } : {}),
    ...(item.blocks === undefined ? {} : { blocks: cloneJson(item.blocks) }),
    ...(context ? { contextMessages: {
      before: normalizeContextMessages(context.before),
      after: normalizeContextMessages(context.after),
    } } : {}),
  };
  return [{ result, sortTimestamp: messageTs, sortChannelId: channelId, sortKey: `message:${channelId}:${messageTs}` }];
}

function normalizeSearchFile(value: unknown, expectedTeamId: string): IndexedSearchMatch[] {
  const item = record(value);
  const fileId = item && string(item.file_id);
  if (!item || !fileId || wrongTeam(item, expectedTeamId)) return [];
  const epoch = epochSeconds(item.date_updated) ?? epochSeconds(item.date_created) ?? 0;
  const result: SearchMatch = {
    kind: "file",
    fileId,
    title: string(item.title) ?? "",
    content: typeof item.content === "string" ? item.content : "",
    ...(string(item.file_type) ? { fileType: string(item.file_type)! } : {}),
    ...(string(item.author_user_id) ? { authorUserId: string(item.author_user_id)! } : {}),
    ...(string(item.author_name) ? { authorName: string(item.author_name)! } : {}),
    ...(string(item.permalink) ? { permalink: string(item.permalink)! } : {}),
    ...(epoch ? { dateUpdated: epoch } : {}),
  };
  return [{ result, sortTimestamp: `${epoch}.000000`, sortChannelId: "", sortKey: `file:${fileId}` }];
}

function normalizeSearchChannel(value: unknown, expectedTeamId: string): IndexedSearchMatch[] {
  const item = record(value);
  if (!item || wrongTeam(item, expectedTeamId)) return [];
  const channelId = string(item.channel_id) ?? "";
  const name = string(item.name);
  if (!channelId && !name) return [];
  const epoch = epochSeconds(item.date_updated) ?? epochSeconds(item.date_created) ?? 0;
  const result: SearchMatch = {
    kind: "channel",
    ...(channelId ? { channelId } : {}),
    ...(name ? { name } : {}),
    ...(string(item.topic) ? { topic: string(item.topic)! } : {}),
    ...(string(item.purpose) ? { purpose: string(item.purpose)! } : {}),
    ...(string(item.creator_user_id) ? { creatorUserId: string(item.creator_user_id)! } : {}),
    ...(string(item.creator_name) ? { creatorName: string(item.creator_name)! } : {}),
    ...(string(item.permalink) ? { permalink: string(item.permalink)! } : {}),
  };
  return [{ result, sortTimestamp: `${epoch}.000000`, sortChannelId: channelId, sortKey: `channel:${channelId || name}` }];
}

function normalizeSearchUser(value: unknown, expectedTeamId: string): IndexedSearchMatch[] {
  const item = record(value);
  const userId = item && (string(item.user_id) ?? string(item.id));
  if (!item || !userId || wrongTeam(item, expectedTeamId)) return [];
  const epoch = epochSeconds(item.date_updated) ?? 0;
  const result: SearchMatch = {
    kind: "user",
    userId,
    ...(string(item.name) ? { name: string(item.name)! } : {}),
    ...(string(item.display_name) ? { displayName: string(item.display_name)! } : {}),
    ...(string(item.real_name) ? { realName: string(item.real_name)! } : {}),
  };
  return [{ result, sortTimestamp: `${epoch}.000000`, sortChannelId: "", sortKey: `user:${userId}` }];
}

function normalizeContextMessages(value: unknown): Array<Record<string, string>> {
  return array(value).flatMap((candidate) => {
    const item = record(candidate);
    const messageTs = item && string(item.ts);
    if (!item || !messageTs) return [];
    return [{
      text: typeof item.text === "string" ? item.text : "",
      ...(string(item.user_id) ? { userId: string(item.user_id)! } : {}),
      messageTs,
    }];
  });
}

function isExactOwnerMention(item: IndexedSearchMatch, ownerUserId: string): boolean {
  if (item.result.kind !== "message") return false;
  const text = typeof item.result.text === "string" ? item.result.text : "";
  return text.includes(`<@${ownerUserId}>`) || containsUserElement(item.result.blocks, ownerUserId);
}

function containsUserElement(value: unknown, ownerUserId: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsUserElement(item, ownerUserId));
  const item = record(value);
  if (!item) return false;
  if (item.type === "user" && item.user_id === ownerUserId) return true;
  return Object.values(item).some((child) => containsUserElement(child, ownerUserId));
}

function renderSearchMatch(item: IndexedSearchMatch): string {
  const rendered: string[] = [];
  collectRenderedValues(item.result, rendered);
  return rendered.join(" ");
}

function collectRenderedValues(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    output.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRenderedValues(item, output);
    return;
  }
  const item = record(value);
  if (item) for (const child of Object.values(item)) collectRenderedValues(child, output);
}

function continuationFailure(error: unknown): { marker: string; warning: string } {
  if (error instanceof SlackApiError && error.category === "rate_limited") {
    return { marker: "rate_limited", warning: "Slack search continuation hit a rate limit; returned results are partial." };
  }
  if (error instanceof SlackApiError && error.category === "authorization") {
    return {
      marker: "authorization_failed",
      warning: "Slack search continuation failed authorization or scope checks; remaining requested coverage was omitted.",
    };
  }
  return { marker: "pagination_failed", warning: "Slack search continuation failed; returned results are partial." };
}

function withinDateBounds(item: IndexedSearchMatch, fromMs: number | undefined, toMs: number): boolean {
  const timestamp = slackTimestampMs(item.sortTimestamp);
  if (timestamp === undefined || timestamp === 0) return true;
  return (fromMs === undefined || timestamp >= fromMs) && timestamp < toMs;
}

function slackTimestampMs(value: string): number | undefined {
  const match = /^(\d+)\.(\d+)$/u.exec(value);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  const milliseconds = Number(`0.${match[2]}`) * 1_000;
  const result = seconds * 1_000 + milliseconds;
  return Number.isFinite(result) ? result : undefined;
}

function parseUtcDate(value: string, field: string): number {
  const normalized = /^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00:00.000Z` : value;
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(normalized)) throw new TypeError(`${field} must be an ISO date or timestamp with a timezone`);
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${field} is invalid`);
  return timestamp;
}

function wrongTeam(item: Record<string, unknown>, expectedTeamId: string): boolean {
  return item.team_id !== undefined && item.team_id !== expectedTeamId;
}

function epochSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

function cloneJson(value: unknown): unknown {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return null; }
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
