import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationBinding } from "../../src/chat-apps/shared/binding.ts";
import { OwnerRouteStore } from "../../src/chat-apps/shared/owner-route-store.ts";
import { SlackInboxStore } from "../../src/chat-apps/slack/inbox-store.ts";
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

const slackThread = (channelId: string, root: string): ConversationBinding => ({
  adapterId: "slack",
  conversationKey: `slack:T1:thread:${channelId}:${root}`,
  destination: { workspaceId: "T1", channelId, threadTs: root },
});
const telegram: ConversationBinding = { adapterId: "telegram", conversationKey: "telegram:42", destination: { chatId: "42" } };

function source(id: string, binding: ConversationBinding, receivedAt: number) {
  return { id, nativeSourceId: id, binding, rawText: id, attachmentIds: [], receivedAt };
}

test("Slack and Telegram share one durable conversation owner and arrival queue", () => {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const conversations = new ConversationStore(db, deliveries);
  const firstThread = slackThread("C1", "1.0");
  const otherThread = slackThread("C2", "2.0");
  const routes = new OwnerRouteStore(db, telegram);

  assert.equal(conversations.acceptChatSource(source("slack-start", firstThread, 1)).disposition, "pending");
  const lease = conversations.acquireLease({ kind: "chat", contextId: "slack-start" }, "claim");
  const start = conversations.reserveStart("slack-start");
  conversations.markSubmitted(lease.attemptId, start.contextId, "turn-1");
  assert.deepEqual(conversations.lease()?.binding, firstThread, "causal route stays frozen on the active Slack thread");

  assert.equal(conversations.acceptChatSource(source("slack-follow-up", firstThread, 2)).disposition, "owner");
  assert.equal(conversations.acceptChatSource(source("telegram-queued", telegram, 3)).disposition, "queued");
  assert.equal(conversations.acceptChatSource(source("other-slack-queued", otherThread, 4)).disposition, "queued");
  assert.deepEqual(deliveries.listReady().map((item) => [item.body, item.binding.adapterId, item.binding.conversationKey]), [
    ["[system] queued", "telegram", telegram.conversationKey],
    ["[system] queued", "slack", otherThread.conversationKey],
  ]);
  const steer = conversations.reserveNextSteer(lease.attemptId)!;
  assert.equal(steer.contextId, "slack-follow-up");
  conversations.markSubmitted(lease.attemptId, steer.contextId, "turn-1");

  conversations.clearLease(lease.attemptId);
  assert.deepEqual(conversations.nextPendingCandidate(), { kind: "chat", contextId: "telegram-queued" });
  assert.deepEqual(routes.current(), otherThread, "unsolicited output follows the most recently accepted owner route");
  assert.deepEqual(new OwnerRouteStore(db, telegram).current(), otherThread, "latest owner route survives restart");
});

test("another adapter with the same literal conversation key still waits", () => {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const conversations = new ConversationStore(db, deliveries);
  const slack = { adapterId: "slack", conversationKey: "shared", destination: { channelId: "C1" } } as const;
  const telegramSameKey = { adapterId: "telegram", conversationKey: "shared", destination: { chatId: "42" } } as const;
  conversations.acceptChatSource(source("owner", slack, 1));
  conversations.acquireLease({ kind: "chat", contextId: "owner" }, "claim");

  assert.equal(conversations.acceptChatSource(source("outsider", telegramSameKey, 2)).disposition, "queued");
  assert.equal(deliveries.get("queued:outsider")?.binding.adapterId, "telegram");
});

test("Slack thread activation survives store reconstruction", () => {
  const db = createTestDatabase();
  const inbox = new SlackInboxStore(db);
  inbox.accept({
    eventId: "E1", eventType: "app_mention", teamId: "T1", channelId: "C1", messageTs: "1.0", userId: "U1", rawText: "start", files: [],
    nativeSourceId: "T1:C1:1.0", sourceId: "slack:T1:C1:1.0", binding: slackThread("C1", "1.0"), activate: true, receivedAt: 1,
  });
  assert.equal(new SlackInboxStore(db).isActivated("slack:T1:thread:C1:1.0"), true);
});
