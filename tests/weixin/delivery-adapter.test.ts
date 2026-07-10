import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AttachmentStore } from "../../src/attachments/store.ts";
import { AppError } from "../../src/core/errors.ts";
import { ChatAdapterRegistry } from "../../src/chat-apps/shared/adapter-registry.ts";
import { DeliveryWorker } from "../../src/chat-apps/shared/delivery-worker.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { WeixinAccountStore, type WeixinAuthorizationIncidentSink } from "../../src/chat-apps/weixin/account-store.ts";
import {
  WeixinApiError,
  type WeixinSendMessageRequest,
  type WeixinUploadRequest,
  type WeixinUploadTarget,
} from "../../src/chat-apps/weixin/api-client.ts";
import { WeixinDeliveryAdapter } from "../../src/chat-apps/weixin/delivery-adapter.ts";
import { WeixinOutboundStore } from "../../src/chat-apps/weixin/outbound-store.ts";
import { decryptWeixinMedia } from "../../src/chat-apps/weixin/media.ts";

function setup(input: { body?: string; mandatory?: boolean; send?: (request: WeixinSendMessageRequest) => Promise<{ messageId?: string }> } = {}) {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const accounts = new WeixinAccountStore(db, deliveries);
  accounts.activate({
    accountGenerationId: "generation", credentialRevisionId: "revision", botId: "bot", ownerUserId: "owner",
    apiBaseUrl: "https://ilinkai.weixin.qq.com",
  });
  db.prepare(`INSERT INTO weixin_route_tokens(id, generation_id, token, is_current, created_at)
    VALUES ('route', 'generation', 'secret-context', 1, 1)`).run();
  const binding = {
    adapterId: "weixin",
    conversationKey: "weixin:generation:owner",
    destination: { generationId: "generation", botId: "bot", ownerUserId: "owner", routeTokenId: "route" },
  } as const;
  const delivery = deliveries.prepare({
    id: "delivery", kind: "text", binding, body: input.body ?? "hello", mandatory: input.mandatory ?? true,
  });
  const requests: WeixinSendMessageRequest[] = [];
  const incidents: Array<{ generationId: string; state: string; category: string }> = [];
  const incidentSink: WeixinAuthorizationIncidentSink = {
    async transition(event) { incidents.push(event); },
  };
  const api = {
    async sendMessage(request: WeixinSendMessageRequest) {
      requests.push(request);
      return input.send ? input.send(request) : { messageId: `message-${requests.length}` };
    },
  };
  const outbound = new WeixinOutboundStore(db);
  const adapter = new WeixinDeliveryAdapter({ api, outbound, deliveries, accounts, incidentSink });
  const worker = new DeliveryWorker(deliveries, new ChatAdapterRegistry([{ delivery: adapter }]));
  return { db, deliveries, delivery, requests, incidents, outbound, adapter, worker, accounts };
}

test("sends an immutable text plan with canonical bodies and confirms every chunk", async () => {
  const fixture = setup({ body: "🙂".repeat(1_001) });
  await fixture.worker.processOne(fixture.delivery.id);

  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(fixture.requests[0], { msg: {
    from_user_id: "",
    to_user_id: "owner",
    client_id: fixture.outbound.list(fixture.delivery.id)[0]!.clientId,
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: "🙂".repeat(1_000) } }],
    context_token: "secret-context",
  } });
  assert.equal(fixture.outbound.list(fixture.delivery.id).every((step) => step.state === "succeeded"), true);
  assert.deepEqual(fixture.deliveries.get(fixture.delivery.id)?.receipt, { kind: "weixin", stepCount: 2 });
  fixture.db.close();
});

test("resumes after a fully checkpointed prefix without repeating it", async () => {
  const fixture = setup({ body: "x".repeat(4_001) });
  const steps = fixture.outbound.prepareText(fixture.delivery, fixture.delivery.binding.destination as never);
  fixture.outbound.begin(steps[0]!.id);
  fixture.outbound.succeed(steps[0]!.id, { messageId: "already-sent" });

  await fixture.worker.processOne(fixture.delivery.id);

  assert.equal(fixture.requests.length, 1);
  assert.equal((fixture.requests[0]?.msg.item_list as Array<{ text_item: { text: string } }>)[0]?.text_item.text, "x");
  fixture.db.close();
});

test("never redispatches an unresolved WeChat effect for mandatory or optional delivery", async () => {
  for (const mandatory of [true, false]) {
    let calls = 0;
    const fixture = setup({ mandatory, send: async () => {
      calls += 1;
      throw new WeixinApiError("service", "ambiguous", { uncertain: true });
    } });
    await assert.rejects(fixture.worker.processOne(fixture.delivery.id));
    assert.equal(fixture.deliveries.get(fixture.delivery.id)?.state, "uncertain");
    await assert.rejects(fixture.worker.processOne(fixture.delivery.id), /may already have been sent/u);
    assert.equal(calls, 1);
    assert.equal(fixture.outbound.list(fixture.delivery.id)[0]?.state, "uncertain");
    assert.equal(fixture.deliveries.get(`delivery-warning:${fixture.delivery.id}`), undefined);
    fixture.db.close();
  }
});

test("routes authorization and credential-pin failures once and makes them terminal", async () => {
  for (const failure of [
    {
      error: new WeixinApiError("authorization", "stale", { protocolCode: -14 }),
      state: "relogin_required",
      category: "authorization",
    },
    {
      error: new AppError("CONFIGURATION_ERROR", "WeChat credential file changed unexpectedly"),
      state: "credential_changed",
      category: "credential_changed",
    },
  ] as const) {
    const fixture = setup({ send: async () => { throw failure.error; } });
    await assert.rejects(fixture.worker.processOne(fixture.delivery.id));
    assert.equal(fixture.deliveries.get(fixture.delivery.id)?.state, "failed");
    assert.deepEqual(fixture.incidents, [{ generationId: "generation", state: failure.state, category: failure.category }]);
    fixture.db.close();
  }
});

test("treats a syntactically valid nonzero rejection as terminal without an incident", async () => {
  const fixture = setup({ send: async () => {
    throw new WeixinApiError("invalid_request", "rejected", { protocolCode: 7 });
  } });
  await assert.rejects(fixture.worker.processOne(fixture.delivery.id));
  assert.equal(fixture.deliveries.get(fixture.delivery.id)?.state, "failed");
  assert.deepEqual(fixture.incidents, []);
  fixture.db.close();
});

test("atomically fails a known terminal rejection before control returns to the delivery worker", async () => {
  const fixture = setup({ send: async () => {
    throw new WeixinApiError("invalid_request", "rejected", { protocolCode: 7 });
  } });
  fixture.deliveries.markDispatched(fixture.delivery.id);

  await assert.rejects(fixture.adapter.sendMessage(
    fixture.delivery.binding.destination,
    fixture.delivery.body,
    undefined,
    { deliveryId: fixture.delivery.id },
  ));

  assert.equal(fixture.deliveries.get(fixture.delivery.id)?.state, "failed");
  fixture.deliveries.recoverAfterCrash();
  assert.equal(fixture.deliveries.get(fixture.delivery.id)?.state, "failed");
  fixture.db.close();
});

test("an inactive authorization latch fails before dispatch without becoming uncertain", async () => {
  const fixture = setup();
  fixture.accounts.latchInactive("generation", "relogin_required", "incident");

  await assert.rejects(fixture.worker.processOne(fixture.delivery.id));

  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.deliveries.get(fixture.delivery.id)?.state, "failed");
  fixture.db.close();
});

async function setupAttachment(input: { kind: "image" | "file"; caption?: string }) {
  const root = await mkdtemp(join(tmpdir(), "qiyan-weixin-outbound-"));
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const accounts = new WeixinAccountStore(db, deliveries);
  accounts.activate({
    accountGenerationId: "generation", credentialRevisionId: "revision", botId: "bot", ownerUserId: "owner",
    apiBaseUrl: "https://ilinkai.weixin.qq.com",
  });
  db.prepare(`INSERT INTO weixin_route_tokens(id, generation_id, token, is_current, created_at)
    VALUES ('route', 'generation', 'secret-context', 1, 1)`).run();
  const attachments = new AttachmentStore(db, root, { maxFileBytes: 1024, maxStoreBytes: 4096 });
  await attachments.initialize();
  const bytes = input.kind === "image"
    ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    : Buffer.from("document bytes");
  const project = join(root, "project");
  const displayName = input.kind === "image" ? "picture.png" : "notes.txt";
  await mkdir(project);
  await writeFile(join(project, displayName), bytes);
  const stored = await attachments.prepareOutbound("scope", project, displayName);
  const binding = {
    adapterId: "weixin", conversationKey: "weixin:generation:owner",
    destination: { generationId: "generation", botId: "bot", ownerUserId: "owner", routeTokenId: "route" },
  } as const;
  const delivery = deliveries.prepareAttachment({
    id: `delivery-${input.kind}`, kind: "file", binding, body: input.caption ?? "", mandatory: true,
    attachmentId: stored.id, attachmentScopeId: "scope",
  });
  const uploadRequests: WeixinUploadRequest[] = [];
  const uploaded: Buffer[] = [];
  const messages: WeixinSendMessageRequest[] = [];
  const api = {
    async getUploadUrl(request: WeixinUploadRequest): Promise<WeixinUploadTarget> {
      uploadRequests.push(request);
      return { url: new URL("https://novac2c.cdn.weixin.qq.com/c2c/upload?signed=one") };
    },
    async upload(_target: WeixinUploadTarget, body: AsyncIterable<Uint8Array | string>) {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      uploaded.push(Buffer.concat(chunks));
      return { encryptedQueryParameter: "encrypted-receipt" };
    },
    async sendMessage(request: WeixinSendMessageRequest) {
      messages.push(request);
      return { messageId: `message-${messages.length}` };
    },
  };
  const outbound = new WeixinOutboundStore(db);
  const adapter = new WeixinDeliveryAdapter({
    api, outbound, deliveries, accounts, incidentSink: { transition: async () => undefined },
  });
  const worker = new DeliveryWorker(deliveries, new ChatAdapterRegistry([{ delivery: adapter }]), attachments);
  return {
    root, db, deliveries, delivery, attachments, bytes, uploadRequests, uploaded, messages, outbound, adapter, worker, api,
    close: async () => { db.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test("encrypts and delivers canonical WeChat image and file plans from retained snapshots", async () => {
  for (const kind of ["image", "file"] as const) {
    const fixture = await setupAttachment({ kind, caption: "caption" });
    await fixture.worker.processOne(fixture.delivery.id);
    const plan = fixture.outbound.attachmentPlan(fixture.delivery.id);
    assert.deepEqual(fixture.uploadRequests, [{
      fileKey: plan.fileKey,
      mediaType: kind === "image" ? 1 : 3,
      ownerUserId: "owner",
      plaintextSize: fixture.bytes.length,
      plaintextMd5: createHash("md5").update(fixture.bytes).digest("hex"),
      ciphertextSize: plan.ciphertextSize,
      aesKeyHex: plan.aesKeyHex,
    }]);
    const decrypted: Buffer[] = [];
    for await (const chunk of decryptWeixinMedia(
      (async function* () { yield fixture.uploaded[0]!; })(),
      Buffer.from(plan.aesKeyHex, "hex"),
      { maxCiphertextBytes: plan.ciphertextSize, maxPlaintextBytes: fixture.bytes.length },
    )) decrypted.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(decrypted), fixture.bytes);
    assert.equal(fixture.messages.length, 2);
    assert.equal((fixture.messages[0]!.msg.item_list as Array<{ text_item: { text: string } }>)[0]!.text_item.text, "caption");
    const media = fixture.messages[1]!.msg;
    assert.deepEqual(media, {
      from_user_id: "",
      to_user_id: "owner",
      client_id: plan.steps.at(-1)!.clientId,
      message_type: 2,
      message_state: 2,
      item_list: [kind === "image" ? {
        type: 2,
        image_item: { media: {
          encrypt_query_param: "encrypted-receipt",
          aes_key: Buffer.from(plan.aesKeyHex, "ascii").toString("base64"),
          encrypt_type: 1,
        }, mid_size: plan.ciphertextSize },
      } : {
        type: 4,
        file_item: { media: {
          encrypt_query_param: "encrypted-receipt",
          aes_key: Buffer.from(plan.aesKeyHex, "ascii").toString("base64"),
          encrypt_type: 1,
        }, file_name: "notes.txt", len: String(fixture.bytes.length) },
      }],
      context_token: "secret-context",
    });
    assert.equal(fixture.deliveries.get(fixture.delivery.id)?.state, "confirmed");
    await fixture.close();
  }
});

test("resumes an attachment only after every prior effect has a durable receipt", async () => {
  const fixture = await setupAttachment({ kind: "file" });
  let uploadCalls = 0;
  fixture.api.upload = async () => {
    uploadCalls += 1;
    throw new WeixinApiError("service", "ambiguous upload", { uncertain: true });
  };
  await assert.rejects(fixture.worker.processOne(fixture.delivery.id));
  assert.deepEqual(fixture.outbound.attachmentPlan(fixture.delivery.id).steps.map((step) => step.state), [
    "succeeded", "uncertain", "prepared",
  ]);
  await assert.rejects(fixture.worker.processOne(fixture.delivery.id), /may already have been sent/u);
  assert.equal(uploadCalls, 1);
  assert.equal(fixture.db.prepare("SELECT ref_count FROM attachments WHERE id = ?")
    .get(fixture.delivery.attachmentId!)!.ref_count, 1);
  await fixture.close();
});

test("rejects outbound audio and video snapshots before any WeChat API effect", async () => {
  const fixture = await setupAttachment({ kind: "file" });
  const upload = await fixture.attachments.openForUpload("scope", fixture.delivery.attachmentId as never);
  await assert.rejects(fixture.adapter.sendDocument!(fixture.delivery.binding.destination, {
    ...upload,
    displayName: "recording.MP3",
    mediaType: "application/octet-stream",
    deliveryId: fixture.delivery.id,
  }), /audio|video|unsupported/u);
  await upload.close();
  assert.deepEqual(fixture.uploadRequests, []);
  assert.deepEqual(fixture.messages, []);
  await fixture.close();
});
