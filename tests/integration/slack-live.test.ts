import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { SlackConfig } from "../../src/config.ts";
import { createSlackClients, validateSlackStartup } from "../../src/slack/clients.ts";
import { SlackContextService } from "../../src/slack/context-service.ts";
import { SlackDeliveryAdapter } from "../../src/slack/delivery-adapter.ts";

const enabled = process.env.RUN_SLACK_INTEGRATION === "1";

test("live Slack owner DM, channel, files, search, and mentions round trip", { skip: !enabled }, async () => {
  const required = (name: string): string => {
    const value = process.env[name];
    assert.ok(value, `${name} is required for the dedicated Slack live test`);
    return value;
  };
  const config: SlackConfig = {
    appToken: required("SLACK_TEST_APP_TOKEN"),
    botToken: required("SLACK_TEST_BOT_TOKEN"),
    userToken: required("SLACK_TEST_USER_TOKEN"),
    teamId: required("SLACK_TEST_TEAM_ID"),
    ownerUserId: required("SLACK_TEST_OWNER_USER_ID"),
  };
  assert.equal(required("SLACK_TEST_ALLOW_WRITES"), `${config.teamId}:${config.ownerUserId}`, "live writes require an exact workspace:user guard");
  const channelId = required("SLACK_TEST_CHANNEL_ID");
  const clients = createSlackClients(config);
  const identity = await validateSlackStartup(config, clients);
  assert.equal(identity.teamId, config.teamId);
  assert.equal(identity.ownerUserId, config.ownerUserId);

  const dmHistory = await clients.bot.conversationHistory({ channel: identity.ownerDmChannelId, limit: 20 });
  const ownerDm = (Array.isArray(dmHistory.messages) ? dmHistory.messages : []).find((value) =>
    typeof value === "object" && value !== null && (value as Record<string, unknown>).user === config.ownerUserId);
  assert.ok(ownerDm, "send a recent owner message in the QiYan App Home DM before running the live test");

  const delivery = new SlackDeliveryAdapter(config.teamId, clients.bot);
  const stamp = new Date().toISOString();
  const dmReceipt = await delivery.sendMessage(
    { workspaceId: config.teamId, channelId: identity.ownerDmChannelId },
    `QiYan live DM test ${stamp}`,
    undefined,
    { deliveryId: `live-dm-${stamp}` },
  );
  assert.equal(typeof (dmReceipt as Record<string, unknown>).messageTs, "string");

  const channelHistory = await clients.bot.conversationHistory({ channel: channelId, limit: 100 });
  const messages = Array.isArray(channelHistory.messages) ? channelHistory.messages : [];
  const mention = messages.find((value) => typeof value === "object" && value !== null
    && (value as Record<string, unknown>).user === config.ownerUserId
    && String((value as Record<string, unknown>).text ?? "").includes(`<@${identity.botUserId}>`)) as Record<string, unknown> | undefined;
  assert.ok(mention?.ts, "mention QiYan recently in SLACK_TEST_CHANNEL_ID before running the live test");
  const threadTs = typeof mention.thread_ts === "string" ? mention.thread_ts : String(mention.ts);
  await delivery.sendMessage(
    { workspaceId: config.teamId, channelId, threadTs },
    `QiYan live thread reply ${stamp}`,
    undefined,
    { deliveryId: `live-thread-${stamp}` },
  );
  const replies = await clients.bot.conversationReplies({ channel: channelId, ts: threadTs, limit: 100 });
  assert.ok((Array.isArray(replies.messages) ? replies.messages : []).some((value) =>
    typeof value === "object" && value !== null && (value as Record<string, unknown>).user === config.ownerUserId),
  "add an owner follow-up in the test thread before running the live test");

  const inbound = [...messages, ...(Array.isArray(replies.messages) ? replies.messages : [])]
    .flatMap((value) => typeof value === "object" && value !== null && Array.isArray((value as Record<string, unknown>).files)
      ? (value as { files: Array<Record<string, unknown>> }).files : [])
    .find((file) => typeof file.url_private_download === "string" || typeof file.url_private === "string");
  assert.ok(inbound, "attach a small file in the DM or test thread before running the live test");
  const download = await clients.bot.downloadFile(String(inbound.url_private_download ?? inbound.url_private));
  let downloaded = 0;
  for await (const chunk of download.stream) downloaded += Buffer.byteLength(chunk);
  assert.ok(downloaded > 0 && downloaded <= 1024 * 1024, "the dedicated inbound test file must be 1 MiB or smaller");

  const upload = await delivery.sendDocument!({ workspaceId: config.teamId, channelId, threadTs }, {
    stream: Readable.from([`QiYan Slack live upload ${stamp}\n`]),
    size: Buffer.byteLength(`QiYan Slack live upload ${stamp}\n`),
    displayName: "qiyan-live.txt",
    mediaType: "text/plain",
    caption: "QiYan live upload",
    deliveryId: `live-file-${stamp}`,
  });
  assert.ok(Array.isArray((upload as Record<string, unknown>).fileIds));

  const context = new SlackContextService(clients.bot, config.teamId, {
    search: clients.search,
    ownerUserId: config.ownerUserId,
    coverage: identity.coverage,
    now: Date.now,
  });
  const dateFrom = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString();
  const search = await context.search(required("SLACK_TEST_SEARCH_QUERY"), dateFrom);
  assert.equal(search.complete, true);
  const mentions = await context.mentions(dateFrom);
  assert.equal(mentions.complete, true);
});
