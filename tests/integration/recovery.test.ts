import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantRuntime } from "../../src/assistant/runtime.ts";
import { ChatAdapterRegistry } from "../../src/chat-apps/shared/adapter-registry.ts";
import { DeliveryWorker } from "../../src/chat-apps/shared/delivery-worker.ts";
import { openDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { OwnerRouteStore } from "../../src/chat-apps/shared/owner-route-store.ts";

const binding = { adapterId: "telegram", conversationKey: "telegram:1", destination: { chatId: "1" } } as const;

test("process restart recovers Telegram ambiguity and assistant effects without replaying originals", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "qiyan-bot-recovery-")), "state.sqlite3");
  let db = openDatabase(path);
  let deliveries = new DeliveryStore(db);
  deliveries.prepare({ id: "d_crash", kind: "text", binding, body: "[worker] result", mandatory: true });
  deliveries.markDispatched("d_crash");
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "1", rawText: "go", attachmentIds: [] });
  const operation = operations.prepare({ contextId: "ctx", attemptId: "a", callId: "c", kind: "send", args: { text: "go" } });
  operations.markDispatched(operation.id);
  db.close();

  db = openDatabase(path);
  deliveries = new DeliveryStore(db);
  deliveries.recoverAfterCrash();
  const sent: string[] = [];
  await new DeliveryWorker(deliveries, new ChatAdapterRegistry([{ delivery: { id: "telegram", sendMessage: async (_chat, body) => { sent.push(body); return { messageId: 9 }; } } }])).drain();
  assert.deepEqual(sent, ["[worker · recovery retry d_crash] result"]);
  const runtime = new AssistantRuntime(db, new OperationStore(db), deliveries, { binding });
  runtime.beginUserAttempt("ctx", "a", "turn");
  const recovery = runtime.failAttempt("turn", new Error("crashed after dispatch"));
  assert.equal(recovery?.kind, "recovery");
  assert.equal(runtime.failAttempt("turn", new Error("again"))?.id, recovery?.id);
  db.close();
});

test("restart preserves latest route and never repeats an optional uncertain Slack effect", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "qiyan-slack-recovery-")), "state.sqlite3");
  const slack = { adapterId: "slack", conversationKey: "slack:T1:thread:C1:1.0", destination: { workspaceId: "T1", channelId: "C1", threadTs: "1.0" } } as const;
  let db = openDatabase(path);
  let deliveries = new DeliveryStore(db);
  const conversations = new ConversationStore(db, deliveries);
  conversations.acceptChatSource({ id: "owner", nativeSourceId: "T1:C1:1.1", binding: slack, rawText: "send", attachmentIds: [], receivedAt: 1 });
  deliveries.prepare({ id: "slack-optional", kind: "chat", binding: slack, body: "may already exist", mandatory: false });
  deliveries.markDispatched("slack-optional");
  db.close();

  db = openDatabase(path);
  deliveries = new DeliveryStore(db);
  deliveries.recoverAfterCrash();
  let sends = 0;
  const bodies: string[] = [];
  const worker = new DeliveryWorker(deliveries, new ChatAdapterRegistry([{ delivery: {
    id: "slack",
    sendMessage: async (_destination, body) => { sends += 1; bodies.push(body); return { channelId: "C1", messageTs: "2.0" }; },
  } }]));
  await worker.drain();
  assert.equal(deliveries.get("slack-optional")?.state, "uncertain");
  assert.equal(sends, 1, "only the mandatory uncertainty warning is delivered");
  assert.deepEqual(bodies, ["[system] delivery slack-optional could not be confirmed and was not automatically retried"]);
  assert.deepEqual(new OwnerRouteStore(db, binding).current(), slack);
  db.close();
});
