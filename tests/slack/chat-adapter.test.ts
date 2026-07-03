import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { AttachmentStore } from "../../src/attachments/store.ts";
import type { SlackConfig } from "../../src/config.ts";
import { SlackChatAdapter, type SlackSocketModeClient } from "../../src/slack/chat-adapter.ts";
import type { SlackBotClient, SlackClients, SlackSearchClient } from "../../src/slack/clients.ts";
import { SlackInboxStore } from "../../src/slack/inbox-store.ts";
import type { NormalizedSlackEvent } from "../../src/slack/types.ts";
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

const config: SlackConfig = { appToken: "xapp-secret", botToken: "xoxb-secret", userToken: "xoxp-secret", teamId: "T1", ownerUserId: "U1" };

class FakeSocket extends EventEmitter implements SlackSocketModeClient {
  starts = 0;
  disconnects = 0;
  onStart?: () => Promise<void> | void;
  async start(): Promise<unknown> { this.starts += 1; await this.onStart?.(); return { ok: true }; }
  async disconnect(): Promise<void> { this.disconnects += 1; }
}

function clients(order: string[]): SlackClients {
  const bot: SlackBotClient = {
    authTest: async () => { order.push("bot-auth"); return { ok: true, team_id: "T1", user_id: "B1" }; },
    openOwnerDm: async () => { order.push("open-dm"); return { ok: true, channel: { id: "D1" } }; },
    conversationHistory: async () => ({ ok: true, messages: [] }),
    conversationReplies: async () => ({ ok: true, messages: [] }),
    channelInfo: async () => ({ ok: true }),
    userInfo: async () => ({ ok: true }),
    postMessage: async (args) => ({ ok: true, channel: args.channel, ts: "2.0" }),
    uploadFileV2: async () => ({ ok: true, files: [] }),
    downloadFile: async () => ({ stream: Readable.from([]) }),
  };
  const search: SlackSearchClient = {
    authTest: async () => { order.push("user-auth"); return { ok: true, team_id: "T1", user_id: "U1" }; },
    searchInfo: async () => { order.push("search-info"); return { ok: true, is_ai_search_enabled: true }; },
    searchContext: async () => ({ ok: true, results: { response_metadata: { next_cursor: "" } } }),
  };
  return { bot, search };
}

function pendingEvent(): NormalizedSlackEvent {
  return {
    eventId: "E-pending", eventType: "message.im", teamId: "T1", channelId: "D1", messageTs: "1.0", userId: "U1", rawText: "pending", files: [],
    nativeSourceId: "T1:D1:1.0", sourceId: "slack:T1:D1:1.0", binding: { adapterId: "slack", conversationKey: "slack:T1:dm:D1", destination: { workspaceId: "T1", channelId: "D1" }, reply: { messageTs: "1.0" } },
    activate: false, receivedAt: 1,
  };
}

test("Slack initializes identities, recovers ingress, subscribes before connect, and acknowledges through the public callback", async (context) => {
  const db = createTestDatabase();
  context.after(() => db.close());
  const attachments = new AttachmentStore(db, await mkdtemp(join(tmpdir(), "qiyan-slack-adapter-")), { maxFileBytes: 100, maxStoreBytes: 1_000 });
  await attachments.initialize();
  const deliveries = new DeliveryStore(db);
  const conversations = new ConversationStore(db, deliveries, attachments);
  const order: string[] = [];
  const socket = new FakeSocket();
  let factoryOptions: { appToken: string } | undefined;
  let accepted = 0;
  const adapter = new SlackChatAdapter(db, attachments, conversations, deliveries, {
    config,
    maxMessageBytes: 100,
    onMessage: async (source, effects) => { conversations.acceptChatSource(source, effects); accepted += 1; },
  }, {
    clients: clients(order),
    createSocketModeClient: (options) => { factoryOptions = options; return socket; },
    now: () => 2,
  });

  new SlackInboxStore(db).accept(pendingEvent());
  await adapter.initialize();
  assert.deepEqual(order, ["bot-auth", "user-auth", "search-info", "open-dm"]);
  assert.deepEqual(factoryOptions, { appToken: "xapp-secret" });
  assert.deepEqual(adapter.primaryBinding, { adapterId: "slack", conversationKey: "slack:T1:dm:D1", destination: { workspaceId: "T1", channelId: "D1" } });
  assert.equal(socket.listenerCount("slack_event"), 0);

  let acked = 0;
  socket.onStart = async () => {
    order.push(`socket-start:pending-${new SlackInboxStore(db).get("E-pending")?.state}`);
    socket.emit("slack_event", {
      type: "events_api",
      body: { type: "event_callback", team_id: "T1", event_id: "E-live", event_time: 2, ignored_secret: "discard", event: { type: "message", channel_type: "im", channel: "D1", user: "U1", ts: "2.0", text: "live", ignored_secret: "discard" } },
      ack: async () => { acked += 1; },
    });
    await new Promise((resolve) => setImmediate(resolve));
  };
  await adapter.start();
  assert.deepEqual(order.at(-1), "socket-start:pending-processed");
  assert.equal(acked, 1);
  assert.ok(new SlackInboxStore(db).get("E-live"));
  assert.equal(JSON.stringify(new SlackInboxStore(db).get("E-live")).includes("ignored_secret"), false);
  assert.equal(accepted, 2);
  assert.equal(socket.listenerCount("slack_event"), 1);

  await adapter.start();
  socket.emit("disconnected", { reason: "network" });
  assert.equal(socket.starts, 1);
  assert.equal(socket.listenerCount("slack_event"), 1);
  await Promise.all([adapter.stop(), adapter.stop(), adapter.close()]);
  assert.equal(socket.disconnects, 1);
  assert.equal(socket.listenerCount("slack_event"), 0);
});

test("Slack start requires successful initialization and never reaches a private send method", async () => {
  const db = createTestDatabase();
  const attachments = new AttachmentStore(db, await mkdtemp(join(tmpdir(), "qiyan-slack-adapter-init-")), { maxFileBytes: 100, maxStoreBytes: 1_000 });
  await attachments.initialize();
  const deliveries = new DeliveryStore(db);
  const conversations = new ConversationStore(db, deliveries, attachments);
  const socket = new FakeSocket() as FakeSocket & { send?: () => never };
  socket.send = () => { throw new Error("private send must not be called"); };
  const adapter = new SlackChatAdapter(db, attachments, conversations, deliveries, {
    config, maxMessageBytes: 100, onMessage: async () => undefined,
  }, { clients: clients([]), createSocketModeClient: () => socket });
  await assert.rejects(adapter.start(), /initialize/i);
  assert.equal(socket.starts, 0);
  db.close();
});
