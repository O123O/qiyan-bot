import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppServerPool, type AppServerEndpoint, type TurnCapacityClaim } from "../../src/app-server/pool.ts";
import type {
  AssistantTurnPort,
  ThreadSnapshot,
  TurnSnapshot,
  TurnStartParams,
  TurnSteerParams,
} from "../../src/assistant/conversation-dispatcher.ts";
import { ConversationDispatcher } from "../../src/assistant/conversation-dispatcher.ts";
import { AssistantRuntime } from "../../src/assistant/runtime.ts";
import { createAssistantTools } from "../../src/assistant/tools.ts";
import { AttachmentStore } from "../../src/attachments/store.ts";
import type { ConversationBinding, JsonValue } from "../../src/chat/binding.ts";
import { ChatAdapterRegistry } from "../../src/chat/adapter-registry.ts";
import type { ChatDeliveryAdapter } from "../../src/chat/contracts.ts";
import { DeliveryWorker } from "../../src/chat/delivery-worker.ts";
import { createChatOutputActions } from "../../src/chat/output-actions.ts";
import { AppError } from "../../src/core/errors.ts";
import { classifySlackEvent } from "../../src/slack/event-classifier.ts";
import { SlackInboxStore } from "../../src/slack/inbox-store.ts";
import { SlackIngressWorker } from "../../src/slack/ingress-worker.ts";
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { createTestDatabase, type Database } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";
import { classifyUpdate, toTelegramCanonicalSource } from "../../src/telegram/adapter.ts";
import { WeixinAccountStore } from "../../src/weixin/account-store.ts";
import type { WeixinSendMessageRequest, WeixinUploadRequest, WeixinUploadTarget } from "../../src/weixin/api-client.ts";
import { WeixinDeliveryAdapter } from "../../src/weixin/delivery-adapter.ts";
import { WeixinInboxStore } from "../../src/weixin/inbox-store.ts";
import { WeixinIngressWorker } from "../../src/weixin/ingress-worker.ts";
import { WeixinOutboundStore } from "../../src/weixin/outbound-store.ts";
import { parseUpdates } from "../../src/weixin/protocol.ts";

class ImmediateRunner implements AssistantTurnPort {
  readonly starts: TurnStartParams[] = [];
  readonly steers: TurnSteerParams[] = [];
  private currentTurnId: string | undefined;

  async start(params: TurnStartParams, _claim: TurnCapacityClaim): Promise<{ turn: TurnSnapshot }> {
    this.starts.push(params);
    this.currentTurnId = `turn-${this.starts.length}`;
    return { turn: { id: this.currentTurnId, status: "inProgress", itemsView: "full", items: [] } };
  }

  async steer(params: TurnSteerParams): Promise<{ turnId: string }> {
    this.steers.push(params);
    return { turnId: params.expectedTurnId };
  }

  async readThread(): Promise<ThreadSnapshot> {
    return {
      status: this.currentTurnId ? "active" : "idle",
      turns: this.currentTurnId
        ? [{ id: this.currentTurnId, status: "inProgress", itemsView: "full", items: [] }]
        : [],
    };
  }
}

function captureAdapter(id: string, messages: Array<{ body: string; destination: JsonValue }>): ChatDeliveryAdapter {
  return {
    id,
    async sendMessage(destination, body) {
      messages.push({ destination, body });
      return { id: `${id}-${messages.length}` };
    },
  };
}

function attemptBinding(db: Database, attemptId: string): ConversationBinding {
  const row = db.prepare(`SELECT adapter_id, conversation_key, destination_json, native_reply_json
    FROM assistant_attempts WHERE id = ?`).get(attemptId) as Record<string, unknown> | undefined;
  if (!row?.adapter_id || !row.conversation_key || !row.destination_json) throw new Error("attempt binding is unavailable");
  return {
    adapterId: String(row.adapter_id),
    conversationKey: String(row.conversation_key),
    destination: JSON.parse(String(row.destination_json)) as JsonValue,
    ...(row.native_reply_json ? { reply: JSON.parse(String(row.native_reply_json)) as JsonValue } : {}),
  };
}

test("all adapters share the real dispatcher while WeChat tools keep the initiating context token", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-weixin-integration-"));
  const project = join(root, "project");
  await mkdir(project);
  context.after(() => rm(root, { recursive: true, force: true }));

  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const attachments = new AttachmentStore(db, join(root, "attachments"), { maxFileBytes: 4_096, maxStoreBytes: 32_768 });
  await attachments.initialize();
  const conversations = new ConversationStore(db, deliveries, attachments);
  const operations = new OperationStore(db);
  const accounts = new WeixinAccountStore(db, deliveries);
  accounts.activate({
    accountGenerationId: "generation", credentialRevisionId: "revision", botId: "bot", ownerUserId: "owner",
    apiBaseUrl: "https://ilinkai.weixin.qq.com",
  });

  const telegramMessages: Array<{ body: string; destination: JsonValue }> = [];
  const slackMessages: Array<{ body: string; destination: JsonValue }> = [];
  const weixinRequests: WeixinSendMessageRequest[] = [];
  const uploads: Buffer[] = [];
  const weixinApi = {
    async sendMessage(request: WeixinSendMessageRequest) {
      weixinRequests.push(request);
      return { messageId: `weixin-${weixinRequests.length}` };
    },
    async getUploadUrl(_request: WeixinUploadRequest): Promise<WeixinUploadTarget> {
      return { url: new URL("https://novac2c.cdn.weixin.qq.com/c2c/upload?signed=one") };
    },
    async upload(_target: WeixinUploadTarget, body: AsyncIterable<Uint8Array | string>) {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      uploads.push(Buffer.concat(chunks));
      return { encryptedQueryParameter: `receipt-${uploads.length}` };
    },
  };
  const outbound = new WeixinOutboundStore(db);
  const weixinDelivery = new WeixinDeliveryAdapter({
    api: weixinApi, outbound, deliveries, accounts, incidentSink: { transition: async () => undefined },
  });
  const registry = new ChatAdapterRegistry([
    { delivery: captureAdapter("telegram", telegramMessages) },
    { delivery: captureAdapter("slack", slackMessages) },
    { delivery: weixinDelivery },
  ]);
  const deliveryWorker = new DeliveryWorker(deliveries, registry, attachments);

  const endpoint: AppServerEndpoint = {
    id: "assistant-local", state: "ready", request: async () => { throw new Error("unused"); },
  };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  const runner = new ImmediateRunner();
  const runtime = new AssistantRuntime(db, operations, deliveries, {
    binding: { adapterId: "weixin", conversationKey: "weixin:generation:owner", destination: { generationId: "generation" } },
  });
  const dispatcher = new ConversationDispatcher(conversations, pool, runner, {
    endpointId: endpoint.id, threadId: "assistant", attachments, runtimeObserver: runtime,
  });
  context.after(async () => { await dispatcher.stop(); db.close(); });

  const weixinInbox = new WeixinInboxStore(db, { botId: "bot", ownerUserId: "owner" }, { attachments });
  const weixinIngress = new WeixinIngressWorker(weixinInbox, attachments, conversations, {
    generationId: "generation", botId: "bot", ownerUserId: "owner", maxMediaBytes: 4_096,
    download: async () => (async function* () {})(), isTransient: () => false,
    onMessage: (source, effects) => dispatcher.accept(source, effects),
  });
  const slackInbox = new SlackInboxStore(db);
  const slackIngress = new SlackIngressWorker(slackInbox, attachments, conversations, deliveries, {
    downloadFile: async () => { throw new Error("unused"); }, isTransient: () => false,
    onMessage: (source, effects) => dispatcher.accept(source, effects),
  });

  const originalToken = "old-context-sentinel-91f2";
  const rotatedToken = "new-context-sentinel-2ac4";
  weixinInbox.commitPoll("generation", "", parseUpdates(JSON.stringify({ ret: 0, msgs: [{
    message_id: 1, from_user_id: "owner", to_user_id: "bot", context_token: originalToken,
    item_list: [{ type: 1, text_item: { text: "continue the novel" } }],
  }] })));
  assert.equal(await weixinIngress.processOne(), true);
  await dispatcher.idle();
  assert.equal(runner.starts.length, 1);
  assert.deepEqual(runner.starts[0]?.input, [
    { type: "text", text: "[weixin]", text_elements: [] },
    { type: "text", text: "continue the novel", text_elements: [] },
  ]);

  const rotatedBatch = { ret: 0, get_updates_buf: "bmV4dA==", msgs: [{
    message_id: 2, from_user_id: "owner", to_user_id: "bot", context_token: rotatedToken,
    item_list: [{ type: 1, text_item: { text: "make chapter two shorter" } }],
  }] };
  weixinInbox.commitPoll("generation", "", parseUpdates(JSON.stringify(rotatedBatch)));
  assert.equal(await weixinIngress.processOne(), true);
  await dispatcher.idle();
  assert.equal(runner.steers.length, 1, "the active WeChat conversation steers its current turn");

  const restartedInbox = new WeixinInboxStore(db, { botId: "bot", ownerUserId: "owner" }, { attachments });
  assert.equal(restartedInbox.cursor("generation"), "bmV4dA==");
  assert.deepEqual(
    restartedInbox.commitPoll("generation", "bmV4dA==", parseUpdates(JSON.stringify({ ...rotatedBatch, get_updates_buf: "bmV4dDI=" }))),
    { inserted: 0, discarded: 1, cursor: "bmV4dDI=" },
  );
  const restartedIngress = new WeixinIngressWorker(restartedInbox, attachments, conversations, {
    generationId: "generation", botId: "bot", ownerUserId: "owner", maxMediaBytes: 4_096,
    download: async () => (async function* () {})(), isTransient: () => false,
    onMessage: (source, effects) => dispatcher.accept(source, effects),
  });
  await restartedIngress.recoverAndDrain();
  assert.equal(runner.steers.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM source_contexts WHERE adapter_id = 'weixin'").get()!.count, 2);

  const lease = conversations.lease()!;
  const binding = attemptBinding(db, lease.attemptId);
  const routeTokenId = (binding.destination as { routeTokenId?: string }).routeTokenId;
  assert.equal(typeof routeTokenId, "string");
  assert.equal(weixinInbox.resolveRouteToken("generation", routeTokenId) === originalToken, true);
  assert.equal(weixinInbox.resolveRouteToken("generation") === rotatedToken, true);

  const genericState = JSON.stringify({
    sources: db.prepare("SELECT adapter_id, conversation_key, destination_json FROM source_contexts ORDER BY id").all(),
    attempts: db.prepare("SELECT adapter_id, conversation_key, destination_json FROM assistant_attempts ORDER BY id").all(),
    deliveries: db.prepare("SELECT adapter_id, conversation_key, destination_json FROM deliveries ORDER BY id").all(),
  });
  assert.equal(genericState.includes(originalToken), false);
  assert.equal(genericState.includes(rotatedToken), false);

  const tools = createAssistantTools(operations, createChatOutputActions({
    deliveries,
    attachments,
    assistantDir: project,
    managedProjectRoot: () => { throw new Error("unexpected managed owner"); },
    binding: (attemptId) => attemptBinding(db, attemptId),
  }), { maxCollectCount: 20 });
  const toolContext = { sourceContextId: "weixin:generation:message:1", attemptId: lease.attemptId, turnId: "turn-1" };
  const textReceipt = await tools.send_chat_message({ ...toolContext, callId: "text" }, { content: "chapter updated" }) as { deliveryId: string };
  await writeFile(join(project, "cover.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
  await writeFile(join(project, "notes.txt"), "notes");
  const image = await tools.prepare_chat_attachment({ ...toolContext, callId: "prepare-image" }, { owner: "assistant", relative_path: "cover.png" }) as { file_handle: string };
  const imageReceipt = await tools.send_chat_attachment({ ...toolContext, callId: "image" }, { file_handle: image.file_handle, caption: "cover" }) as { deliveryId: string };
  const file = await tools.prepare_chat_attachment({ ...toolContext, callId: "prepare-file" }, { owner: "assistant", relative_path: "notes.txt" }) as { file_handle: string };
  const fileReceipt = await tools.send_chat_attachment({ ...toolContext, callId: "file" }, { file_handle: file.file_handle }) as { deliveryId: string };
  for (const id of [textReceipt.deliveryId, imageReceipt.deliveryId, fileReceipt.deliveryId]) await deliveryWorker.processOne(id);
  assert.equal(uploads.length, 2);
  assert.deepEqual(weixinRequests.flatMap((request) => (request.msg.item_list as Array<{ type?: unknown }>).map(({ type }) => type)), [1, 1, 2, 4]);
  assert.equal(weixinRequests.every((request) => request.msg.context_token === originalToken), true);
  assert.equal(weixinRequests.some((request) => request.msg.context_token === rotatedToken), false);

  const telegram = classifyUpdate({
    update_id: 10,
    message: { message_id: 10, from: { id: 42 }, chat: { id: 42, type: "private" }, date: 3, text: "what is its status?" },
  }, 42);
  assert.equal(telegram.kind, "accepted");
  if (telegram.kind !== "accepted") throw new Error("Telegram fixture was rejected");
  await dispatcher.accept(toTelegramCanonicalSource(telegram.message, []));
  await dispatcher.idle();

  const slack = classifySlackEvent({
    type: "event_callback", team_id: "T1", event_id: "E1", event_time: 4,
    event: { type: "app_mention", channel: "C1", user: "U1", ts: "4.0", text: "<@B1> status in Slack" },
  }, { teamId: "T1", ownerUserId: "U1", botUserId: "B1", now: () => 4_000, isActivated: (key) => slackInbox.isActivated(key) });
  assert.equal(slack.kind, "accept");
  if (slack.kind !== "accept") throw new Error("Slack fixture was rejected");
  slackInbox.accept(slack.event);
  assert.equal(await slackIngress.processOne(), true);
  await dispatcher.idle();
  await deliveryWorker.processOne("queued:telegram:42:10");
  await deliveryWorker.processOne("queued:slack:T1:C1:4.0");
  assert.deepEqual(telegramMessages.map(({ body }) => body), ["[system] queued"]);
  assert.deepEqual(slackMessages.map(({ body }) => body), ["[system] queued"]);

  await assert.rejects(
    registry.getHistory(binding, { scope: "conversation", count: 10 }),
    (error: unknown) => error instanceof AppError && error.code === "UNSUPPORTED_CAPABILITY",
  );

  await dispatcher.terminal({ id: "turn-1", status: "completed", itemsView: "full", items: [] });
  await dispatcher.idle();
  runtime.handleTerminal("turn-1", "completed");
  await dispatcher.enqueueInternal("terminal");
  await dispatcher.idle();
  assert.deepEqual(runner.starts[1]?.input, [
    { type: "text", text: "[telegram]", text_elements: [] },
    { type: "text", text: "what is its status?", text_elements: [] },
  ]);

  await dispatcher.terminal({ id: "turn-2", status: "completed", itemsView: "full", items: [] });
  await dispatcher.idle();
  runtime.handleTerminal("turn-2", "completed");
  await dispatcher.enqueueInternal("terminal");
  await dispatcher.idle();
  assert.deepEqual(runner.starts[2]?.input, [
    { type: "text", text: "[slack C1 thread]", text_elements: [] },
    { type: "text", text: "status in Slack", text_elements: [] },
  ]);

  const requestCount = weixinRequests.length;
  accounts.activate({
    accountGenerationId: "replacement", credentialRevisionId: "replacement-revision", botId: "new-bot", ownerUserId: "new-owner",
    apiBaseUrl: "https://ilinkai.weixin.qq.com",
  });
  const stale = deliveries.prepare({
    id: "stale-old-generation", kind: "chat", binding, body: "must not dispatch", mandatory: true,
  });
  await assert.rejects(deliveryWorker.processOne(stale.id), /inactive|invalid/iu);
  assert.equal(deliveries.get(stale.id)?.state, "failed");
  assert.equal(weixinRequests.length, requestCount);
});
