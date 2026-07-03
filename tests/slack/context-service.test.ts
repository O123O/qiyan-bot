import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { ConversationBinding } from "../../src/chat/binding.ts";
import { SlackApiError, type SlackBotClient, type SlackSearchClient, type SlackSearchCoverage } from "../../src/slack/clients.ts";
import { SlackContextService } from "../../src/slack/context-service.ts";

type ResponseFactory = (args: Record<string, unknown>) => Record<string, unknown>;

function bot(options: { history?: ResponseFactory; replies?: ResponseFactory }) {
  const historyCalls: Record<string, unknown>[] = [];
  const replyCalls: Record<string, unknown>[] = [];
  const client: SlackBotClient = {
    authTest: async () => ({ ok: true }),
    openOwnerDm: async () => ({ ok: true }),
    channelInfo: async () => ({ ok: true }),
    userInfo: async () => ({ ok: true }),
    postMessage: async () => ({ ok: true }),
    uploadFileV2: async () => ({ ok: true }),
    downloadFile: async () => ({ stream: Readable.from([]) }),
    conversationHistory: async (args) => { historyCalls.push(args); return options.history?.(args) ?? { ok: true, messages: [] }; },
    conversationReplies: async (args) => { replyCalls.push(args); return options.replies?.(args) ?? { ok: true, messages: [] }; },
  };
  return { client, historyCalls, replyCalls };
}

const dm: ConversationBinding = {
  adapterId: "slack",
  conversationKey: "slack:T123:dm:D123",
  destination: { workspaceId: "T123", channelId: "D123" },
};
const thread: ConversationBinding = {
  adapterId: "slack",
  conversationKey: "slack:T123:thread:C123:1.000",
  destination: { workspaceId: "T123", channelId: "C123", threadTs: "1.000" },
};
const message = (ts: string) => ({ ts, text: `m${ts}`, user: `U${ts.replace(".", "")}`, thread_ts: "1.000" });

test("DM and channel history consume newest-first pages only until the requested window is full", async () => {
  const fake = bot({ history: (args) => {
    if (args.latest === "6.000") return { ok: true, messages: [message("5.000"), message("4.000"), message("3.000")], response_metadata: { next_cursor: "older" } };
    if (args.cursor === "next") return { ok: true, messages: [message("6.000"), message("5.000")], response_metadata: { next_cursor: "unused" } };
    return { ok: true, messages: [message("8.000"), message("7.000")], response_metadata: { next_cursor: "next" } };
  } });
  const service = new SlackContextService(fake.client, "T123");
  const first = await service.getHistory(dm, { scope: "conversation", count: 3 });
  assert.deepEqual((first as any).messages.map((item: any) => item.messageTs), ["6.000", "7.000", "8.000"]);
  assert.equal((first as any).nextBefore, "6.000");
  assert.deepEqual(fake.historyCalls, [
    { channel: "D123", limit: 3 },
    { channel: "D123", limit: 1, cursor: "next" },
  ]);

  const second = await service.getHistory(dm, { scope: "conversation", count: 3, before: (first as any).nextBefore });
  assert.deepEqual((second as any).messages.map((item: any) => item.messageTs), ["3.000", "4.000", "5.000"]);
  assert.equal(new Set([...(first as any).messages, ...(second as any).messages].map((item: any) => item.messageTs)).size, 6);

  await service.getHistory(thread, { scope: "channel", count: 1 });
  assert.equal(fake.replyCalls.length, 0);
  assert.equal(fake.historyCalls.at(-1)?.channel, "C123");
});

test("thread history consumes all oldest-first pages into a bounded newest window and deduplicates the root", async () => {
  const fake = bot({ replies: (args) => {
    if (args.cursor === "page-2") return { ok: true, messages: [message("1.000"), message("4.000"), message("5.000")], response_metadata: { next_cursor: "page-3" } };
    if (args.cursor === "page-3") return { ok: true, messages: [message("6.000"), message("7.000"), message("8.000")], response_metadata: { next_cursor: "" } };
    return { ok: true, messages: [message("1.000"), message("2.000"), message("3.000")], response_metadata: { next_cursor: "page-2" } };
  } });
  const result = await new SlackContextService(fake.client, "T123").getHistory(thread, { scope: "conversation", count: 3, before: "9.000" });
  assert.deepEqual((result as any).messages.map((item: any) => item.messageTs), ["6.000", "7.000", "8.000"]);
  assert.equal((result as any).nextBefore, "6.000");
  assert.deepEqual(fake.replyCalls.map((args) => args.cursor), [undefined, "page-2", "page-3"]);
  for (const call of fake.replyCalls) {
    assert.equal(call.channel, "C123");
    assert.equal(call.ts, "1.000");
    assert.equal(call.latest, "9.000");
    assert.equal(call.inclusive, false);
  }
});

test("history validates the persisted Slack binding instead of accepting model-selected destinations", async () => {
  const service = new SlackContextService(bot({}).client, "T123");
  await assert.rejects(service.getHistory({ ...dm, adapterId: "telegram" }, { scope: "conversation", count: 1 }), /Slack binding/i);
  await assert.rejects(service.getHistory({ ...dm, destination: { workspaceId: "T999", channelId: "D123" } }, { scope: "conversation", count: 1 }), /Slack binding/i);
  await assert.rejects(service.getHistory(dm, { scope: "conversation", count: 1, before: "not-a-timestamp" }), /boundary/i);
});

const searchCoverage: SlackSearchCoverage = {
  requested: ["public_channels", "private_channels", "im", "mpim", "files", "users"],
  authorization: "slack_enforced",
  searchAvailable: true,
  omitted: [],
  errors: [],
};

function searchHarness(handler: (args: Record<string, unknown>, call: number) => Promise<Record<string, unknown>> | Record<string, unknown>) {
  const calls: Record<string, unknown>[] = [];
  const search: SlackSearchClient = {
    authTest: async () => ({ ok: true }),
    searchInfo: async () => ({ ok: true, is_ai_search_enabled: true }),
    searchContext: async (args) => { calls.push(args); return handler(args, calls.length); },
  };
  return { search, calls };
}

test("Slack search normalizes UTC bounds, consumes every cursor, and preserves supported result context", async () => {
  const now = Date.parse("2026-07-04T00:00:00Z");
  const resultEpoch = Math.floor(Date.parse("2026-07-02T12:00:00Z") / 1_000);
  const fake = searchHarness((args) => args.cursor === "next-page" ? {
    ok: true,
    results: {
      channels: [{ channel_id: "C2", team_id: "T123", name: "launch", topic: "Ship", purpose: "Coordination", date_updated: resultEpoch - 100, permalink: "https://example.slack.com/archives/C2" }],
      users: [{ user_id: "U2", team_id: "T123", name: "Lin", display_name: "Lin", date_updated: resultEpoch - 200 }],
      response_metadata: { next_cursor: "" },
    },
  } : {
    ok: true,
    results: {
      messages: [{
        team_id: "T123", channel_id: "C1", channel_name: "general", author_user_id: "U1", author_name: "Ada",
        message_ts: `${resultEpoch}.000100`, content: "launch details", thread_ts: `${resultEpoch - 1}.000000`,
        permalink: "https://example.slack.com/archives/C1/p1", blocks: [{ type: "rich_text", elements: [] }],
        context_messages: { before: [{ text: "before", user_id: "U3", ts: "1751999998.0" }], after: [{ text: "after", user_id: "U4", ts: "1752000001.0" }] },
      }, { channel_id: "C1", message_ts: `${Math.floor(Date.parse("2026-07-03T12:00:00Z") / 1_000)}.700000`, content: "outside exclusive date_to" }],
      files: [{ team_id: "T123", file_id: "F1", author_user_id: "U1", author_name: "Ada", date_created: resultEpoch + 100, title: "plan", file_type: "text/plain", content: "file body", permalink: "https://example.slack.com/files/F1" }],
      response_metadata: { next_cursor: "next-page" },
    },
  });
  const service = new SlackContextService(bot({}).client, "T123", { search: fake.search, ownerUserId: "U123", coverage: searchCoverage, now: () => now });
  const result = await service.search("launch", "2026-07-01", "2026-07-03T12:00:00.500Z");
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[0], {
    query: "launch",
    channel_types: ["public_channel", "private_channel", "mpim", "im"],
    content_types: ["messages", "files", "channels", "users"],
    include_context_messages: true,
    include_message_blocks: true,
    include_bots: true,
    sort: "timestamp",
    sort_dir: "desc",
    limit: 20,
    after: Math.floor(Date.parse("2026-07-01T00:00:00Z") / 1_000) - 1,
    before: Math.ceil(Date.parse("2026-07-03T12:00:00.500Z") / 1_000),
  });
  assert.equal(fake.calls[1]?.cursor, "next-page");
  assert.equal(result.complete, true);
  assert.equal(result.count, 4);
  assert.deepEqual(result.results.map((item: any) => item.kind).sort(), ["channel", "file", "message", "user"]);
  const found = result.results.find((item: any) => item.kind === "message") as any;
  assert.equal(found.text, "launch details");
  assert.equal(found.permalink, "https://example.slack.com/archives/C1/p1");
  assert.deepEqual(found.contextMessages.before, [{ text: "before", userId: "U3", messageTs: "1751999998.0" }]);
  assert.deepEqual(found.blocks, [{ type: "rich_text", elements: [] }]);
  assert.equal(JSON.stringify(result).includes("next-page"), false);
});

test("owner mention search uses the exact token and post-filters text and rich-text user elements", async () => {
  const base = Math.floor(Date.parse("2026-07-02T12:00:00Z") / 1_000);
  const fake = searchHarness(() => ({ ok: true, results: { messages: [
    { channel_id: "C1", message_ts: `${base}.0`, content: "hello <@U123>", author_user_id: "U1" },
    { channel_id: "C1", message_ts: `${base - 1}.0`, content: "block mention", author_user_id: "U1", blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "user", user_id: "U123" }] }] }] },
    { channel_id: "C1", message_ts: `${base - 2}.0`, content: "&lt;@U123&gt;" },
    { channel_id: "C1", message_ts: `${base - 3}.0`, content: "prefixU123suffix" },
    { channel_id: "C1", message_ts: `${base - 4}.0`, content: "hello <@U999>", blocks: [{ type: "user", user_id: "U999" }] },
  ], response_metadata: { next_cursor: "" } } }));
  const service = new SlackContextService(bot({}).client, "T123", { search: fake.search, ownerUserId: "U123", coverage: searchCoverage, now: () => Date.parse("2026-07-04T00:00:00Z") });
  const result = await service.mentions("2026-07-01");
  assert.equal(fake.calls[0]?.query, "<@U123>");
  assert.deepEqual(fake.calls[0]?.content_types, ["messages"]);
  assert.deepEqual(result.results.map((item: any) => item.messageTs), [`${base}.0`, `${base - 1}.0`]);
  assert.equal(result.count, 2);
  assert.deepEqual((result.coverage as any).limitedTo, { channelTypes: ["public_channel", "private_channel", "mpim", "im"], contentTypes: ["messages"] });
});

test("search enforces the word limit against Unicode whitespace inside result fields", async () => {
  const content = Array.from({ length: 3_001 }, (_, index) => `word${index}`).join("\n");
  const fake = searchHarness(() => ({ ok: true, results: {
    messages: [{ channel_id: "C1", message_ts: "20.0", content }],
    response_metadata: { next_cursor: "" },
  } }));
  const service = new SlackContextService(bot({}).client, "T123", {
    search: fake.search, ownerUserId: "U123", coverage: searchCoverage, now: () => Date.now(),
  });
  const result = await service.search("large result");
  assert.equal(result.count, 1);
  assert.equal(result.returned_count, 0);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.results, []);
});

test("search fails actionably on page one and returns explicit partial coverage after a later page failure", async () => {
  const failure = new SlackApiError("Slack assistant.search.context was rejected", undefined, undefined, true, false);
  const first = searchHarness(() => { throw failure; });
  const firstService = new SlackContextService(bot({}).client, "T123", { search: first.search, ownerUserId: "U123", coverage: searchCoverage, now: () => Date.now() });
  await assert.rejects(firstService.search("launch"), /Slack search is unavailable/i);

  const later = searchHarness((_args, call) => {
    if (call > 1) throw failure;
    return { ok: true, results: { messages: [{ channel_id: "C1", message_ts: "20.0", content: "one" }], response_metadata: { next_cursor: "next" } } };
  });
  const partialService = new SlackContextService(bot({}).client, "T123", { search: later.search, ownerUserId: "U123", coverage: searchCoverage, now: () => Date.now() });
  const result = await partialService.search("launch");
  assert.equal(result.complete, false);
  assert.equal(result.returned_count, 1);
  assert.match(result.warning ?? "", /continuation/i);
  assert.deepEqual(result.coverage.errors, ["pagination_failed"]);
  assert.equal(JSON.stringify(result).includes("next"), false);
});

test("search reports every first-page Slack failure category actionably", async () => {
  for (const [category, message] of [
    ["rate_limited", /rate limit.*retry/i],
    ["authorization", /authorization|scope/i],
    ["invalid_request", /invalid|rejected/i],
    ["service", /service.*unavailable|try again/i],
    ["unknown", /search is unavailable/i],
  ] as const) {
    const failure = new SlackApiError("sanitized Slack failure", undefined, undefined, false, false, category);
    const fake = searchHarness(() => { throw failure; });
    const service = new SlackContextService(bot({}).client, "T123", {
      search: fake.search, ownerUserId: "U123", coverage: searchCoverage, now: () => Date.now(),
    });
    await assert.rejects(service.search("launch"), message);
  }
});

test("search identifies every Slack continuation failure category", async () => {
  for (const [category, marker, warning] of [
    ["rate_limited", "rate_limited", /rate limit/i],
    ["authorization", "authorization_failed", /authorization|scope/i],
    ["invalid_request", "invalid_request", /invalid|rejected/i],
    ["service", "service_unavailable", /service.*unavailable|try again/i],
    ["unknown", "pagination_failed", /continuation failed/i],
  ] as const) {
    const failure = new SlackApiError(
      "sanitized Slack continuation failure", category === "rate_limited" ? 429 : undefined, undefined, false, false, category,
    );
    const fake = searchHarness((_args, call) => {
      if (call > 1) throw failure;
      return { ok: true, results: {
        messages: [{ channel_id: "C1", message_ts: "20.0", content: "one" }],
        response_metadata: { next_cursor: "next" },
      } };
    });
    const service = new SlackContextService(bot({}).client, "T123", {
      search: fake.search, ownerUserId: "U123", coverage: searchCoverage, now: () => Date.now(),
    });
    const result = await service.search("launch");
    assert.equal(result.complete, false);
    assert.deepEqual(result.coverage.errors, [marker]);
    assert.match(result.warning ?? "", warning);
  }
});
