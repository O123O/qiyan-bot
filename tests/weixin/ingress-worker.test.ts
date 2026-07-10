import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AttachmentStore } from "../../src/attachments/store.ts";
import type { CanonicalChatSource } from "../../src/core/types.ts";
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { WeixinAccountStore } from "../../src/chat-apps/weixin/account-store.ts";
import { WeixinApiError } from "../../src/chat-apps/weixin/api-client.ts";
import { WeixinInboxStore } from "../../src/chat-apps/weixin/inbox-store.ts";
import { WeixinIngressWorker } from "../../src/chat-apps/weixin/ingress-worker.ts";
import { parseUpdates } from "../../src/chat-apps/weixin/protocol.ts";

async function fixture(context: test.TestContext, download: (url: URL) => Promise<AsyncIterable<Uint8Array>>) {
  const root = await mkdtemp(join(tmpdir(), "qiyan-weixin-ingress-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  new WeixinAccountStore(db, deliveries).activate({
    accountGenerationId: "generation", credentialRevisionId: "revision", botId: "bot", ownerUserId: "owner",
    apiBaseUrl: "https://ilinkai.weixin.qq.com",
  });
  const attachments = new AttachmentStore(db, root, { maxFileBytes: 1_000, maxStoreBytes: 10_000 });
  await attachments.initialize();
  const inbox = new WeixinInboxStore(db, { botId: "bot", ownerUserId: "owner" }, { attachments });
  const conversations = new ConversationStore(db, deliveries, attachments);
  const accepted: CanonicalChatSource[] = [];
  const worker = new WeixinIngressWorker(inbox, attachments, conversations, {
    generationId: "generation", botId: "bot", ownerUserId: "owner", download,
    isTransient: (error) => error instanceof Error && error.message === "transient",
    onMessage: async (source, effects) => { accepted.push(source); conversations.acceptChatSource(source, effects); },
    maxMediaBytes: 1_000,
  });
  return { db, inbox, attachments, conversations, accepted, worker };
}

test("ingests mixed owner text, voice, keyless image, encrypted file, and explicit failures in order", async (context) => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const file = Buffer.from("document");
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const cipher = createCipheriv("aes-128-ecb", key, null);
  const encrypted = Buffer.concat([cipher.update(file), cipher.final()]);
  let downloads = 0;
  const value = await fixture(context, async (url) => {
    downloads += 1;
    return (async function* () { yield url.searchParams.get("kind") === "image" ? png : encrypted; })();
  });
  value.inbox.commitPoll("generation", "", parseUpdates(JSON.stringify({ ret: 0, msgs: [{
    message_id: 1, from_user_id: "owner", to_user_id: "bot", context_token: "route", item_list: [
      { type: 1, text_item: { text: "typed" } },
      { type: 3, voice_item: { text: "spoken" } },
      { type: 2, image_item: { url: "https://weixin.qq.com/c2c/download?kind=image" } },
      { type: 4, file_item: { file_name: "notes.txt", len: String(file.length), md5: createHash("md5").update(file).digest("hex"), media: {
        full_url: "https://weixin.qq.com/c2c/download?kind=file", aes_key: key.toString("base64"),
      } } },
      { type: 3, voice_item: {} },
      { type: 5, video_item: {} },
    ],
  }] })));

  assert.equal(await value.worker.processOne(), true);
  assert.equal(downloads, 2);
  assert.equal(value.inbox.list("generation")[0]?.state, "processed");
  const source = value.accepted[0]!;
  assert.equal(source.rawText, "typed\nspoken");
  assert.equal(source.attachmentIds.length, 2);
  assert.deepEqual(source.failedAttachments?.map(({ reasonCode }) => reasonCode), ["voice_without_transcription", "video_unsupported"]);
  assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM source_contexts WHERE adapter_id = 'weixin'").get()!.count, 1);
  assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM weixin_inbox_attachment_refs").get()!.count, 0);
  assert.deepEqual(value.db.prepare("SELECT ref_count FROM attachments ORDER BY id").all().map((row) => row.ref_count), [1, 1]);

  value.inbox.recoverProcessing("generation");
  assert.equal(await value.worker.processOne(), false);
  assert.equal(downloads, 2);
});

test("a transient media failure retries the head without allowing a later row to overtake", async (context) => {
  let calls = 0;
  const value = await fixture(context, async () => {
    calls += 1;
    if (calls === 1) throw new Error("transient");
    return (async function* () { yield Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); })();
  });
  value.inbox.commitPoll("generation", "", parseUpdates(JSON.stringify({ ret: 0, msgs: [1, 2].map((message_id) => ({
    message_id, from_user_id: "owner", to_user_id: "bot", item_list: [{ type: 2, image_item: { url: "https://weixin.qq.com/c2c/download?kind=image" } }],
  })) })));
  assert.equal(await value.worker.processOne(), false);
  assert.deepEqual(value.inbox.list("generation").map(({ state }) => state), ["retry", "pending"]);
  assert.equal(await value.worker.processOne(), true);
  assert.equal(value.inbox.list("generation")[0]?.state, "processed");
  assert.equal(value.inbox.list("generation")[1]?.state, "pending");
});

test("an authorization-blocked media download stays retryable without a permanent failure checkpoint", async (context) => {
  const value = await fixture(context, async () => { throw new WeixinApiError("authorization", "inactive"); });
  value.inbox.commitPoll("generation", "", parseUpdates(JSON.stringify({ ret: 0, msgs: [{
    message_id: 1,
    from_user_id: "owner",
    to_user_id: "bot",
    item_list: [{ type: 2, image_item: { url: "https://weixin.qq.com/c2c/download?kind=image" } }],
  }] })));
  const worker = new WeixinIngressWorker(value.inbox, value.attachments, value.conversations, {
    generationId: "generation", botId: "bot", ownerUserId: "owner", maxMediaBytes: 100,
    download: async () => { throw new WeixinApiError("authorization", "inactive"); },
    isTransient: (error) => error instanceof WeixinApiError && error.category === "authorization",
    onMessage: async (source, effects) => { value.conversations.acceptChatSource(source, effects); },
  });

  assert.equal(await worker.processOne(), false);
  assert.equal(value.inbox.list("generation")[0]?.state, "retry");
  assert.equal(value.inbox.mediaCheckpoint("generation", { kind: "message", value: "1" }, 0), undefined);
  assert.deepEqual(value.accepted, []);
});

test("rejects base64 image-item hex keys and reconciles an exception after committed acceptance", async (context) => {
  let downloads = 0;
  const value = await fixture(context, async () => {
    downloads += 1;
    return (async function* () { yield Buffer.from("unused"); })();
  });
  value.inbox.commitPoll("generation", "", parseUpdates(JSON.stringify({ ret: 0, msgs: [{
    message_id: 1, from_user_id: "owner", to_user_id: "bot", item_list: [{ type: 2, image_item: {
      url: "https://weixin.qq.com/c2c/download?kind=image", aeskey: Buffer.alloc(16).toString("base64"),
    } }],
  }] })));
  assert.equal(await value.worker.processOne(), true);
  assert.equal(downloads, 0);
  assert.deepEqual(value.accepted[0]?.failedAttachments?.map(({ reasonCode }) => reasonCode), ["media_invalid"]);

  value.inbox.commitPoll("generation", "", parseUpdates(JSON.stringify({ ret: 0, msgs: [{
    message_id: 2, from_user_id: "owner", to_user_id: "bot", item_list: [{ type: 1, text_item: { text: "accepted" } }],
  }] })));
  const throwing = new WeixinIngressWorker(value.inbox, value.attachments, value.conversations, {
    generationId: "generation", botId: "bot", ownerUserId: "owner", maxMediaBytes: 100,
    download: async () => (async function* () {})(), isTransient: () => false,
    onMessage: async (source, effects) => {
      value.conversations.acceptChatSource(source, effects);
      throw new Error("downstream pump failed after commit");
    },
  });
  assert.equal(await throwing.processOne(), true);
  assert.equal(value.inbox.list("generation")[1]?.state, "processed");
});
