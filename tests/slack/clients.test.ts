import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { SlackConfig } from "../../src/config.ts";
import { AppError } from "../../src/core/errors.ts";
import {
  createSlackClients,
  SlackApiError,
  validateSlackStartup,
  type SlackWebClientShape,
} from "../../src/slack/clients.ts";

const config: SlackConfig = {
  appToken: "xapp-secret",
  botToken: "xoxb-secret",
  userToken: "xoxp-secret",
  ownerUserId: "U123",
};

interface ClientCalls {
  token: string;
  options: Record<string, unknown>;
  calls: Array<{ method: string; args?: Record<string, unknown> }>;
}

function harness(overrides: {
  botAuth?: Record<string, unknown>;
  userAuth?: Record<string, unknown>;
  searchInfo?: Record<string, unknown>;
  searchFailure?: unknown;
  open?: Record<string, unknown>;
  postFailure?: unknown;
  fetch?: typeof fetch;
} = {}) {
  const created: ClientCalls[] = [];
  const createWebClient = (token: string, options: Record<string, unknown>): SlackWebClientShape => {
    const record: ClientCalls = { token, options, calls: [] };
    created.push(record);
    const call = async (method: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      record.calls.push({ method, ...(args === undefined ? {} : { args }) });
      if (method === "auth.test") return token.startsWith("xoxb-")
        ? (overrides.botAuth ?? { ok: true, team_id: "T123", user_id: "B123" })
        : (overrides.userAuth ?? { ok: true, team_id: "T123", user_id: "U123" });
      if (method === "conversations.open") return overrides.open ?? { ok: true, channel: { id: "D123" } };
      if (method === "assistant.search.info" && overrides.searchFailure) throw overrides.searchFailure;
      if (method === "assistant.search.info") return overrides.searchInfo ?? { ok: true, is_ai_search_enabled: true };
      if (method === "chat.postMessage" && overrides.postFailure) throw overrides.postFailure;
      return { ok: true, method, args };
    };
    return {
      auth: { test: (args = {}) => call("auth.test", args) },
      conversations: {
        open: (args) => call("conversations.open", args),
        history: (args) => call("conversations.history", args),
        replies: (args) => call("conversations.replies", args),
        info: (args) => call("conversations.info", args),
      },
      chat: { postMessage: (args) => call("chat.postMessage", args) },
      filesUploadV2: (args) => call("filesUploadV2", args),
      users: { info: (args) => call("users.info", args) },
      apiCall: (method, args = {}) => call(method, args),
    };
  };
  return {
    created,
    clients: createSlackClients(config, { createWebClient, ...(overrides.fetch ? { fetch: overrides.fetch } : {}) }),
  };
}

test("official clients are split into narrow bot-read, bot-write, and user-search capabilities", async () => {
  const { clients, created } = harness();
  assert.equal(created.length, 3);
  assert.deepEqual(created.map(({ token }) => token), [config.botToken, config.botToken, config.userToken]);
  assert.deepEqual(created[1]!.options.retryConfig, { retries: 0 });
  assert.equal(created[1]!.options.rejectRateLimitedCalls, true);
  assert.equal((created[0]!.options.retryConfig as { retries: number }).retries, 2);
  assert.equal((created[2]!.options.retryConfig as { retries: number }).retries, 2);

  assert.equal("apiCall" in clients.bot, false);
  assert.equal("apiCall" in clients.search, false);
  assert.deepEqual(Object.keys(clients.bot).sort(), [
    "authTest", "channelInfo", "conversationHistory", "conversationReplies", "downloadFile", "openOwnerDm", "postMessage", "uploadFileV2", "userInfo",
  ]);
  assert.deepEqual(Object.keys(clients.search).sort(), ["authTest", "searchContext", "searchInfo"]);

  await clients.bot.conversationHistory({ channel: "C123" });
  await clients.bot.conversationReplies({ channel: "C123", ts: "1.0" });
  await clients.bot.channelInfo({ channel: "C123" });
  await clients.bot.userInfo({ user: "U123" });
  await clients.bot.postMessage({ channel: "D123", text: "hello" });
  await clients.bot.uploadFileV2({ channel_id: "D123", file: Readable.from(["hello"]) });
  await clients.search.searchContext({ query: "launch", sort: "timestamp" });
  assert.deepEqual(created.flatMap(({ calls }) => calls.map(({ method }) => method)), [
    "conversations.history",
    "conversations.replies",
    "conversations.info",
    "users.info",
    "chat.postMessage",
    "filesUploadV2",
    "assistant.search.context",
  ]);
});

test("startup proves bot, owner, workspace, Real-time Search, and primary DM identities", async () => {
  const { clients } = harness();
  assert.deepEqual(await validateSlackStartup(config, clients), {
    botUserId: "B123",
    ownerUserId: "U123",
    teamId: "T123",
    ownerDmChannelId: "D123",
    coverage: {
      requested: ["public_channels", "private_channels", "im", "mpim", "files", "users"],
      authorization: "slack_enforced",
      searchAvailable: true,
      omitted: [],
      errors: [],
    },
  });
});

for (const [name, overrides, match] of [
  ["missing bot workspace identity", { botAuth: { ok: true, user_id: "B123" } }, /workspace/i],
  ["missing user workspace identity", { userAuth: { ok: true, user_id: "U123" } }, /workspace/i],
  ["wrong bot workspace", { botAuth: { ok: true, team_id: "T999", user_id: "B123" } }, /workspace/i],
  ["wrong user workspace", { userAuth: { ok: true, team_id: "T999", user_id: "U123" } }, /workspace/i],
  ["wrong owner identity", { userAuth: { ok: true, team_id: "T123", user_id: "U999" } }, /owner/i],
  ["owner and bot collision", { botAuth: { ok: true, team_id: "T123", user_id: "U123" } }, /collision/i],
  ["unresolvable owner DM", { open: { ok: true, channel: {} } }, /direct message/i],
] as const) {
  test(`startup rejects ${name}`, async () => {
    await assert.rejects(validateSlackStartup(config, harness(overrides).clients), (error: unknown) =>
      error instanceof AppError && error.code === "CONFIGURATION_ERROR" && match.test(error.message));
  });
}

test("startup keeps keyword search available when Slack AI semantic search is disabled", async () => {
  const result = await validateSlackStartup(config, harness({
    searchInfo: { ok: true, is_ai_search_enabled: false },
  }).clients);
  assert.equal(result.teamId, "T123");
  assert.equal(result.coverage.searchAvailable, true);
});

test("startup still rejects a failed Real-time Search capability request without exposing details", async () => {
  const secret = config.userToken;
  await assert.rejects(validateSlackStartup(config, harness({
    searchFailure: new Error(`search failed with ${secret}`),
  }).clients), (error: unknown) =>
    error instanceof AppError
    && error.code === "CONFIGURATION_ERROR"
    && /identity validation failed/iu.test(error.message)
    && !error.message.includes(secret));
});

test("startup coverage does not infer private consent or unavailable categories from search-info", async () => {
  const { clients } = harness({ searchInfo: { ok: true, is_ai_search_enabled: true, private_search_enabled: false, inaccessible: ["im"] } });
  const result = await validateSlackStartup(config, clients);
  assert.deepEqual(result.coverage.omitted, []);
  assert.deepEqual(result.coverage.errors, []);
  assert.equal("privateSearchEnabled" in result.coverage, false);
  assert.equal(JSON.stringify(result.coverage).includes("inaccessible"), false);
});

test("file download restricts hosts and sends the bot token without exposing it", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return new Response("content", { status: 200, headers: { "content-length": "7" } });
  }) as typeof fetch;
  const { clients } = harness({ fetch: fakeFetch });
  const downloaded = await clients.bot.downloadFile("https://files.slack.com/files-pri/T123-F123/file.txt");
  assert.equal(downloaded.size, 7);
  const chunks: Buffer[] = [];
  for await (const chunk of downloaded.stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "content");
  assert.deepEqual(requests, [{ url: "https://files.slack.com/files-pri/T123-F123/file.txt", authorization: `Bearer ${config.botToken}` }]);
  await assert.rejects(clients.bot.downloadFile("https://example.com/steal"), /Slack file URL/i);
  assert.equal(JSON.stringify(clients.bot).includes(config.botToken), false);
});

test("SDK errors become sanitized SlackApiError values with conservative retry metadata", async () => {
  const secret = config.botToken;
  const rateLimit = Object.assign(new Error(`rate limited ${secret}`), {
    code: "slack_webapi_rate_limited_error",
    retryAfter: 3,
    headers: { authorization: `Bearer ${secret}` },
  });
  const { clients } = harness({ postFailure: rateLimit });
  await assert.rejects(clients.bot.postMessage({ channel: "D123", text: "hello" }), (error: unknown) => {
    assert.ok(error instanceof SlackApiError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 3_000);
    assert.equal(error.deterministic, false);
    assert.equal(error.safeToRetry, true);
    assert.equal((error as SlackApiError & { category?: string }).category, "rate_limited");
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.equal("headers" in error, false);
    return true;
  });

  const transport = Object.assign(new Error(`socket failed ${secret}`), { code: "slack_webapi_request_error", original: { url: `https://${secret}@slack.com` } });
  const ambiguous = harness({ postFailure: transport }).clients;
  await assert.rejects(ambiguous.bot.postMessage({ channel: "D123", text: "hello" }), (error: unknown) =>
    error instanceof SlackApiError && error.safeToRetry === false && error.deterministic === false && !error.message.includes(secret));
});

test("platform errors distinguish proven rejections from ambiguous service failures", async () => {
  const platform = (reason: string) => Object.assign(new Error(`Slack rejected with ${reason}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error: reason },
  });
  const unauthorized = harness({ postFailure: platform("invalid_auth") }).clients;
  await assert.rejects(unauthorized.bot.postMessage({ channel: "D123", text: "hello" }), (error: unknown) => {
    assert.ok(error instanceof SlackApiError);
    assert.equal(error.deterministic, true);
    assert.equal((error as SlackApiError & { category?: string }).category, "authorization");
    return true;
  });

  const internal = harness({ postFailure: platform("internal_error") }).clients;
  await assert.rejects(internal.bot.postMessage({ channel: "D123", text: "hello" }), (error: unknown) => {
    assert.ok(error instanceof SlackApiError);
    assert.equal(error.deterministic, false);
    assert.equal((error as SlackApiError & { category?: string }).category, "service");
    return true;
  });
});
