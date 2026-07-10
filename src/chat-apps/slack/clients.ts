import { Readable } from "node:stream";
import { WebClient } from "@slack/web-api";
import type { SlackConfig } from "../../config.ts";
import { AppError } from "../../core/errors.ts";

type SlackResponse = Record<string, unknown>;
type SlackArguments = Record<string, unknown>;

export interface SlackWebClientShape {
  auth: { test(args?: SlackArguments): Promise<SlackResponse> };
  conversations: {
    open(args: SlackArguments): Promise<SlackResponse>;
    history(args: SlackArguments): Promise<SlackResponse>;
    replies(args: SlackArguments): Promise<SlackResponse>;
    info(args: SlackArguments): Promise<SlackResponse>;
  };
  chat: { postMessage(args: SlackArguments): Promise<SlackResponse> };
  filesUploadV2(args: SlackArguments): Promise<SlackResponse>;
  users: { info(args: SlackArguments): Promise<SlackResponse> };
  apiCall(method: string, args?: SlackArguments): Promise<SlackResponse>;
}

export interface SlackBotClient {
  authTest(): Promise<SlackResponse>;
  openOwnerDm(ownerUserId: string): Promise<SlackResponse>;
  conversationHistory(args: SlackArguments): Promise<SlackResponse>;
  conversationReplies(args: SlackArguments): Promise<SlackResponse>;
  channelInfo(args: SlackArguments): Promise<SlackResponse>;
  userInfo(args: SlackArguments): Promise<SlackResponse>;
  postMessage(args: SlackArguments): Promise<SlackResponse>;
  uploadFileV2(args: SlackArguments): Promise<SlackResponse>;
  downloadFile(url: string): Promise<{ stream: Readable; size?: number }>;
}

export interface SlackSearchClient {
  authTest(): Promise<SlackResponse>;
  searchInfo(): Promise<SlackResponse>;
  searchContext(args: SlackArguments): Promise<SlackResponse>;
}

export interface SlackClients {
  bot: SlackBotClient;
  search: SlackSearchClient;
}

export type SlackSearchCategory = "public_channels" | "private_channels" | "im" | "mpim" | "files" | "users";

export interface SlackSearchCoverage {
  requested: readonly SlackSearchCategory[];
  authorization: "slack_enforced";
  searchAvailable: boolean;
  omitted: readonly SlackSearchCategory[];
  errors: readonly string[];
  limitedTo?: {
    channelTypes: readonly ("public_channel" | "private_channel" | "mpim" | "im")[];
    contentTypes: readonly ("messages" | "files" | "channels" | "users")[];
  };
}

export interface SlackStartupIdentity {
  botUserId: string;
  ownerUserId: string;
  teamId: string;
  ownerDmChannelId: string;
  coverage: SlackSearchCoverage;
}

export type SlackFailureCategory = "rate_limited" | "authorization" | "invalid_request" | "service" | "unknown";

export class SlackApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryAfterMs: number | undefined,
    readonly deterministic: boolean,
    readonly safeToRetry: boolean,
    readonly category: SlackFailureCategory = "unknown",
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

const READ_RETRY = Object.freeze({ retries: 2, minTimeout: 250, maxTimeout: 2_000, randomize: true });
const WRITE_RETRY = Object.freeze({ retries: 0 });
const SEARCH_CATEGORIES = Object.freeze([
  "public_channels",
  "private_channels",
  "im",
  "mpim",
  "files",
  "users",
] as const);
const RATE_LIMIT_ERRORS = new Set(["rate_limited", "ratelimited"]);
const AUTHORIZATION_ERRORS = new Set([
  "access_denied", "accesslimited", "account_inactive", "ekm_access_denied", "enterprise_is_restricted",
  "invalid_auth", "missing_scope", "no_permission", "not_allowed_token_type", "not_authed", "org_login_required",
  "team_access_not_granted", "token_expired", "token_revoked", "two_factor_setup_required",
]);
const SERVICE_ERRORS = new Set([
  "assistant_search_context_disabled", "fatal_error", "internal_error", "request_timeout", "service_unavailable", "team_added_to_org",
]);
const INVALID_REQUEST_ERRORS = new Set([
  "channel_not_found", "context_channel_not_found", "deprecated_endpoint", "feature_not_enabled", "invalid_action_token",
  "invalid_arg_name", "invalid_arguments", "invalid_array_arg", "invalid_blocks", "invalid_charset", "invalid_cursor",
  "invalid_form_data", "invalid_post_type", "method_deprecated", "missing_post_type", "missing_query", "msg_too_long",
  "no_text", "query_too_long",
]);

interface SlackClientDependencies {
  createWebClient?: (token: string, options: Record<string, unknown>) => SlackWebClientShape;
  fetch?: typeof globalThis.fetch;
}

export function createSlackClients(config: SlackConfig, dependencies: SlackClientDependencies = {}): SlackClients {
  const createWebClient = dependencies.createWebClient ?? ((token, options) =>
    new WebClient(token, options) as unknown as SlackWebClientShape);
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const botRead = createWebClient(config.botToken, {
    retryConfig: READ_RETRY,
    attachOriginalToWebAPIRequestError: false,
  });
  const botWrite = createWebClient(config.botToken, {
    retryConfig: WRITE_RETRY,
    rejectRateLimitedCalls: true,
    attachOriginalToWebAPIRequestError: false,
  });
  const userSearch = createWebClient(config.userToken, {
    retryConfig: READ_RETRY,
    attachOriginalToWebAPIRequestError: false,
  });

  const bot: SlackBotClient = Object.freeze({
    authTest: () => invoke("auth.test", false, () => botRead.auth.test()),
    openOwnerDm: (ownerUserId: string) => invoke("conversations.open", false, () => botRead.conversations.open({ users: ownerUserId })),
    conversationHistory: (args: SlackArguments) => invoke("conversations.history", false, () => botRead.conversations.history(args)),
    conversationReplies: (args: SlackArguments) => invoke("conversations.replies", false, () => botRead.conversations.replies(args)),
    channelInfo: (args: SlackArguments) => invoke("conversations.info", false, () => botRead.conversations.info(args)),
    userInfo: (args: SlackArguments) => invoke("users.info", false, () => botRead.users.info(args)),
    postMessage: (args: SlackArguments) => invoke("chat.postMessage", true, () => botWrite.chat.postMessage(args)),
    uploadFileV2: (args: SlackArguments) => invoke("filesUploadV2", false, () => botWrite.filesUploadV2(args)),
    downloadFile: (url: string) => downloadSlackFile(url, config.botToken, fetchImpl),
  });
  const search: SlackSearchClient = Object.freeze({
    authTest: () => invoke("auth.test", false, () => userSearch.auth.test()),
    searchInfo: () => invoke("assistant.search.info", false, () => userSearch.apiCall("assistant.search.info")),
    searchContext: (args: SlackArguments) => invoke("assistant.search.context", false, () => userSearch.apiCall("assistant.search.context", args)),
  });
  return Object.freeze({ bot, search });
}

export async function validateSlackStartup(config: SlackConfig, clients: SlackClients): Promise<SlackStartupIdentity> {
  let botAuth: SlackResponse;
  let ownerAuth: SlackResponse;
  let opened: SlackResponse;
  try {
    botAuth = await clients.bot.authTest();
    ownerAuth = await clients.search.authTest();
    await clients.search.searchInfo();
    opened = await clients.bot.openOwnerDm(config.ownerUserId);
  } catch {
    throw configuration("Slack startup identity validation failed");
  }

  const botTeamId = stringField(botAuth, "team_id");
  const botUserId = stringField(botAuth, "user_id");
  if (!botTeamId) throw configuration("Slack bot workspace identity could not be resolved");
  if (!botUserId) throw configuration("Slack bot identity could not be resolved");

  const ownerTeamId = stringField(ownerAuth, "team_id");
  const ownerUserId = stringField(ownerAuth, "user_id");
  if (!ownerTeamId) throw configuration("Slack user token workspace identity could not be resolved");
  if (ownerTeamId !== botTeamId) throw configuration("Slack bot and user token belong to different workspaces");
  if (ownerUserId !== config.ownerUserId) throw configuration("Slack user token does not belong to the configured owner");
  if (botUserId === ownerUserId) throw configuration("Slack owner and bot identity collision");
  const channel = recordField(opened, "channel");
  const ownerDmChannelId = channel ? stringField(channel, "id") : undefined;
  if (!ownerDmChannelId) throw configuration("Slack owner direct message could not be resolved");

  return {
    botUserId,
    ownerUserId,
    teamId: botTeamId,
    ownerDmChannelId,
    coverage: {
      requested: [...SEARCH_CATEGORIES],
      authorization: "slack_enforced",
      searchAvailable: true,
      omitted: [],
      errors: [],
    },
  };
}

async function invoke<T>(operation: string, rateLimitProvesNoWrite: boolean, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw normalizeSlackError(error, operation, rateLimitProvesNoWrite);
  }
}

function normalizeSlackError(error: unknown, operation: string, rateLimitProvesNoWrite: boolean): SlackApiError {
  const source = asRecord(error);
  const code = typeof source?.code === "string" ? source.code : undefined;
  if (code === "slack_webapi_rate_limited_error") {
    const retryAfter = finiteNumber(source?.retryAfter);
    return new SlackApiError(
      `Slack ${operation} was rate limited`,
      429,
      retryAfter === undefined ? undefined : retryAfter * 1_000,
      false,
      rateLimitProvesNoWrite,
      "rate_limited",
    );
  }
  if (code === "slack_webapi_platform_error") {
    const platformCode = stringField(asRecord(source?.data) ?? {}, "error");
    const category = platformErrorCategory(platformCode);
    const deterministic = category === "authorization" || category === "invalid_request";
    return new SlackApiError(
      `Slack ${operation} was rejected`, undefined, undefined, deterministic,
      category === "rate_limited" && rateLimitProvesNoWrite, category,
    );
  }
  if (code === "slack_webapi_file_upload_invalid_args_error") {
    return new SlackApiError(`Slack ${operation} was rejected`, undefined, undefined, true, false, "invalid_request");
  }
  if (code === "slack_webapi_http_error") {
    const status = finiteNumber(source?.statusCode);
    const category = httpFailureCategory(status);
    const deterministic = category === "authorization" || category === "invalid_request";
    return new SlackApiError(`Slack ${operation} failed over HTTP`, status, undefined, deterministic, false, category);
  }
  return new SlackApiError(`Slack ${operation} transport failed`, undefined, undefined, false, false);
}

async function downloadSlackFile(urlValue: string, botToken: string, fetchImpl: typeof globalThis.fetch): Promise<{ stream: Readable; size?: number }> {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new SlackApiError("Slack file URL is invalid", undefined, undefined, true, false, "invalid_request");
  }
  if (url.protocol !== "https:" || (url.hostname !== "files.slack.com" && url.hostname !== "files.slack-edge.com")) {
    throw new SlackApiError("Slack file URL uses an untrusted host", undefined, undefined, true, false, "invalid_request");
  }
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { authorization: `Bearer ${botToken}` }, redirect: "error" });
  } catch {
    throw new SlackApiError("Slack file download transport failed", undefined, undefined, false, false);
  }
  if (!response.ok || !response.body) {
    const category = httpFailureCategory(response.status);
    const deterministic = category === "authorization" || category === "invalid_request";
    const retryAfterMs = response.status === 429 ? retryAfterHeader(response.headers) : undefined;
    throw new SlackApiError("Slack file download failed", response.status, retryAfterMs, deterministic, response.status === 429, category);
  }
  const size = contentLength(response.headers);
  return {
    stream: Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
    ...(size === undefined ? {} : { size }),
  };
}

function stringField(value: SlackResponse, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function recordField(value: SlackResponse, key: string): SlackResponse | undefined {
  return asRecord(value[key]);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function contentLength(headers: Headers): number | undefined {
  const raw = headers.get("content-length");
  if (raw === null || !/^\d+$/u.test(raw)) return undefined;
  const size = Number(raw);
  return Number.isSafeInteger(size) ? size : undefined;
}

function retryAfterHeader(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function platformErrorCategory(code: string | undefined): SlackFailureCategory {
  if (!code) return "unknown";
  if (RATE_LIMIT_ERRORS.has(code)) return "rate_limited";
  if (AUTHORIZATION_ERRORS.has(code)) return "authorization";
  if (SERVICE_ERRORS.has(code)) return "service";
  if (INVALID_REQUEST_ERRORS.has(code)) return "invalid_request";
  return "unknown";
}

function httpFailureCategory(status: number | undefined): SlackFailureCategory {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "authorization";
  if (status !== undefined && status >= 400 && status < 500) return "invalid_request";
  if (status !== undefined && status >= 500) return "service";
  return "unknown";
}

function configuration(message: string): AppError {
  return new AppError("CONFIGURATION_ERROR", message);
}
