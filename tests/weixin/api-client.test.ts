import assert from "node:assert/strict";
import test from "node:test";
import { APP_VERSION } from "../../src/version.ts";
import { WeixinApiClient, WeixinApiError, type WeixinHttpTransport } from "../../src/chat-apps/weixin/api-client.ts";
import type { WeixinCredential, WeixinCredentialHandle } from "../../src/chat-apps/weixin/credential-store.ts";

const credential: Readonly<WeixinCredential> = Object.freeze({
  accountGenerationId: crypto.randomUUID(),
  credentialRevisionId: crypto.randomUUID(),
  botId: "bot-id",
  ownerUserId: "owner-id",
  botToken: "private-bearer-token",
  apiBaseUrl: "https://ilinkai.weixin.qq.com",
  authenticatedAt: 1,
});

function harness(responses: Array<Response | Error>) {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  let verifications = 0;
  const transport: WeixinHttpTransport = {
    async fetch(url, init) {
      requests.push({ url, init });
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      if (response instanceof Error) throw response;
      return response;
    },
  };
  const handle: WeixinCredentialHandle = {
    public: {
      accountGenerationId: credential.accountGenerationId,
      credentialRevisionId: credential.credentialRevisionId,
      botId: credential.botId,
      ownerUserId: credential.ownerUserId,
      apiBaseUrl: credential.apiBaseUrl,
    },
    async withVerifiedCredential(operation) { verifications += 1; return operation(credential); },
  };
  return { requests, transport, handle, verifications: () => verifications };
}

test("sends exact authenticated getupdates headers and base info", async () => {
  const fake = harness([Response.json({ ret: 0, get_updates_buf: "QUE=", msgs: [] })]);
  const client = new WeixinApiClient(fake.handle, fake.transport, { nextUin: () => 42 });
  const result = await client.getUpdates("", new AbortController().signal);
  assert.equal(result.cursor, "QUE=");
  assert.equal(fake.verifications(), 1);
  const request = fake.requests[0]!;
  assert.equal(request.url.href, "https://ilinkai.weixin.qq.com/ilink/bot/getupdates");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(JSON.parse(String(request.init.body)), {
    get_updates_buf: "",
    base_info: { channel_version: APP_VERSION, bot_agent: `QiYan/${APP_VERSION}` },
  });
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get("Authorization"), "Bearer private-bearer-token");
  assert.equal(headers.get("AuthorizationType"), "ilink_bot_token");
  assert.equal(headers.get("X-WECHAT-UIN"), Buffer.from("42").toString("base64"));
  const [major = 0, minor = 0, patch = 0] = APP_VERSION.split(".").map((value) => Number.parseInt(value, 10));
  assert.equal(headers.get("iLink-App-ClientVersion"), String(((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)));
});

test("bounds the next long poll by Tencent's parsed server timeout plus response overhead", async () => {
  const fake = harness([]);
  const transport: WeixinHttpTransport = {
    async fetch(_url, init) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 10);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
      return Response.json({ ret: 0, msgs: [] });
    },
  };
  const client = new WeixinApiClient(fake.handle, transport, { longPollTimeoutMs: 1 });
  assert.equal((await client.getUpdates("", new AbortController().signal, 50)).ret, 0);
  assert.throws(() => client.getUpdates("", new AbortController().signal, 600_001), /timeout is invalid/u);
});

test("revalidates credentials and generates a fresh UIN before every authenticated dispatch", async () => {
  const fake = harness([Response.json({ ret: 0 }), Response.json({ ret: 0 }), Response.json({ ret: 0 })]);
  let uin = 0;
  const client = new WeixinApiClient(fake.handle, fake.transport, { nextUin: () => ++uin });
  await client.getConfig();
  await client.sendTyping("start");
  await client.notifyLifecycle("stop");
  assert.equal(fake.verifications(), 3);
  assert.deepEqual(fake.requests.map(({ init }) => new Headers(init.headers).get("X-WECHAT-UIN")), [
    Buffer.from("1").toString("base64"),
    Buffer.from("2").toString("base64"),
    Buffer.from("3").toString("base64"),
  ]);
});

test("keeps each authenticated dispatch inside its credential verification lease", async () => {
  let verifying = false;
  const fake = harness([]);
  fake.handle.withVerifiedCredential = async (operation) => {
    verifying = true;
    try { return await operation(credential); }
    finally { verifying = false; }
  };
  const transport: WeixinHttpTransport = {
    async fetch() {
      assert.equal(verifying, true);
      return Response.json({ ret: 0 });
    },
  };

  await new WeixinApiClient(fake.handle, transport).getConfig();
  assert.equal(verifying, false);
});

test("validates upload targets, prefers a full URL, and excludes bearer headers from CDN", async () => {
  const fake = harness([
    Response.json({ ret: 0, upload_full_url: "https://novac2c.cdn.weixin.qq.com/c2c/upload?full=1", upload_param: "fallback" }),
    new Response(null, { status: 200, headers: { "x-encrypted-param": "download-parameter" } }),
  ]);
  const client = new WeixinApiClient(fake.handle, fake.transport, { nextUin: () => 1 });
  const target = await client.getUploadUrl({
    fileKey: "a".repeat(32), mediaType: 1, plaintextSize: 3, plaintextMd5: "b".repeat(32), ciphertextSize: 16,
    aesKeyHex: "c".repeat(32), ownerUserId: "owner-id",
  });
  assert.deepEqual(JSON.parse(String(fake.requests[0]?.init.body)), {
    filekey: "a".repeat(32),
    media_type: 1,
    to_user_id: "owner-id",
    rawsize: 3,
    rawfilemd5: "b".repeat(32),
    filesize: 16,
    no_need_thumb: true,
    aeskey: "c".repeat(32),
    base_info: { channel_version: APP_VERSION, bot_agent: `QiYan/${APP_VERSION}` },
  });
  assert.equal(target.url.href, "https://novac2c.cdn.weixin.qq.com/c2c/upload?full=1");
  const receipt = await client.upload(target, (async function* () { yield Buffer.from("ciphertext"); })());
  assert.deepEqual(receipt, { encryptedQueryParameter: "download-parameter" });
  const uploadHeaders = new Headers(fake.requests[1]?.init.headers);
  assert.equal(uploadHeaders.get("Authorization"), null);
  assert.equal(uploadHeaders.get("AuthorizationType"), null);
  assert.equal(uploadHeaders.get("Content-Type"), "application/octet-stream");
  assert.equal(fake.verifications(), 2);
});

test("builds the upload fallback only when at least one target form exists", async () => {
  const request = {
    fileKey: "a".repeat(32), mediaType: 3 as const, plaintextSize: 3, plaintextMd5: "b".repeat(32), ciphertextSize: 16,
    aesKeyHex: "c".repeat(32), ownerUserId: "owner-id",
  };
  const fallback = harness([Response.json({ ret: 0, upload_param: "signed" })]);
  assert.equal((await new WeixinApiClient(fallback.handle, fallback.transport).getUploadUrl(request)).url.pathname, "/c2c/upload");
  const missing = harness([Response.json({ ret: 0 })]);
  await assert.rejects(new WeixinApiClient(missing.handle, missing.transport).getUploadUrl(request), /upload target is invalid/u);
});

test("uses canonical send bodies and returns only bounded receipts", async () => {
  const fake = harness([Response.json({ ret: 0, message_id: "server-id" })]);
  const client = new WeixinApiClient(fake.handle, fake.transport, { nextUin: () => 9 });
  const receipt = await client.sendMessage({
    msg: {
      from_user_id: "", to_user_id: "owner-id", client_id: "client-id", message_type: 2, message_state: 2,
      item_list: [{ type: 1, text_item: { text: "hello" } }], context_token: "context",
    },
  });
  assert.deepEqual(receipt, { messageId: "server-id" });
  assert.deepEqual(JSON.parse(String(fake.requests[0]?.init.body)), {
    msg: {
      from_user_id: "", to_user_id: "owner-id", client_id: "client-id", message_type: 2, message_state: 2,
      item_list: [{ type: 1, text_item: { text: "hello" } }], context_token: "context",
    },
    base_info: { channel_version: APP_VERSION, bot_agent: `QiYan/${APP_VERSION}` },
  });
});

test("classifies HTTP, protocol, and transport failures without response bodies", async () => {
  for (const [response, category] of [
    [new Response("private-401-body", { status: 401 }), "authorization"],
    [new Response("private-429-body", { status: 429 }), "rate_limit"],
    [new Response("private-400-body", { status: 400 }), "invalid_request"],
    [new Response("private-500-body", { status: 500 }), "service"],
    [Response.json({ ret: 0, errcode: -14, errmsg: "private-protocol-body" }), "authorization"],
  ] as const) {
    const fake = harness([response]);
    await assert.rejects(new WeixinApiClient(fake.handle, fake.transport).getConfig(), (error: unknown) => {
      assert.equal(error instanceof WeixinApiError && error.category === category, true);
      assert.doesNotMatch(String(error), /private-/u);
      return true;
    });
  }
  const fake = harness([new TypeError("private-network-detail")]);
  await assert.rejects(new WeixinApiClient(fake.handle, fake.transport).getConfig(), (error: unknown) => {
    assert.equal(error instanceof WeixinApiError && error.category === "unknown", true);
    assert.doesNotMatch(String(error), /private-network-detail/u);
    return true;
  });
});

test("rejects cross-operation redirects and aborts an in-flight request", async () => {
  const crossed = harness([new Response(null, { status: 307, headers: { location: "/ilink/bot/sendmessage" } })]);
  await assert.rejects(new WeixinApiClient(crossed.handle, crossed.transport).getConfig(), /endpoint path is invalid/u);

  const controller = new AbortController();
  const transport: WeixinHttpTransport = {
    async fetch(_url, init) {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    },
  };
  const fake = harness([]);
  const pending = new WeixinApiClient(fake.handle, transport).getUpdates("", controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
});

test("never replays sendmessage or CDN upload after a redirect", async () => {
  const send = harness([new Response(null, { status: 307, headers: { location: "https://region.weixin.qq.com/ilink/bot/sendmessage" } })]);
  await assert.rejects(
    new WeixinApiClient(send.handle, send.transport).sendMessage({ msg: { client_id: "client" } }),
    (error: unknown) => error instanceof WeixinApiError && error.uncertain === true,
  );
  assert.equal(send.requests.length, 1);

  let consumed = "";
  const upload = harness([]);
  const transport: WeixinHttpTransport = {
    async fetch(url, init) {
      upload.requests.push({ url, init });
      for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>) consumed += Buffer.from(chunk).toString("utf8");
      return new Response(null, { status: 307, headers: { location: "https://region.weixin.qq.com/c2c/upload?next=1" } });
    },
  };
  const client = new WeixinApiClient(upload.handle, transport);
  await assert.rejects(
    client.upload({ url: new URL("https://novac2c.cdn.weixin.qq.com/c2c/upload?first=1") }, (async function* () { yield Buffer.from("ciphertext"); })()),
    (error: unknown) => error instanceof WeixinApiError && error.uncertain === true,
  );
  assert.equal(consumed, "ciphertext");
  assert.equal(upload.requests.length, 1);
});

test("revalidates the credential pin before every redirect hop", async () => {
  const redirected = harness([
    new Response(null, { status: 307, headers: { location: "https://region.weixin.qq.com/ilink/bot/getconfig" } }),
    Response.json({ ret: 0 }),
  ]);
  await new WeixinApiClient(redirected.handle, redirected.transport).getConfig();
  assert.equal(redirected.verifications(), 2);

  let checks = 0;
  const replacing = harness([
    new Response(null, { status: 307, headers: { location: "https://region.weixin.qq.com/ilink/bot/getconfig" } }),
  ]);
  replacing.handle.withVerifiedCredential = async (operation) => {
    checks += 1;
    if (checks === 2) throw new Error("credential changed unexpectedly");
    return operation(credential);
  };
  await assert.rejects(new WeixinApiClient(replacing.handle, replacing.transport).getConfig(), /credential changed/u);
  assert.equal(replacing.requests.length, 1);

  const cdn = harness([
    new Response(null, { status: 307, headers: { location: "https://region.weixin.qq.com/c2c/download?next=1" } }),
    new Response("media"),
  ]);
  const downloaded = await new WeixinApiClient(cdn.handle, cdn.transport)
    .download(new URL("https://novac2c.cdn.weixin.qq.com/c2c/download?first=1"));
  assert.equal(await new Response(downloaded).text(), "media");
  assert.equal(cdn.verifications(), 2);
  assert.equal(cdn.requests.every(({ init }) => new Headers(init.headers).get("Authorization") === null), true);

  let cdnChecks = 0;
  const changedCdn = harness([
    new Response(null, { status: 307, headers: { location: "https://region.weixin.qq.com/c2c/download?next=1" } }),
  ]);
  changedCdn.handle.withVerifiedCredential = async (operation) => {
    cdnChecks += 1;
    if (cdnChecks === 2) throw new Error("credential changed unexpectedly");
    return operation(credential);
  };
  await assert.rejects(
    new WeixinApiClient(changedCdn.handle, changedCdn.transport)
      .download(new URL("https://novac2c.cdn.weixin.qq.com/c2c/download?first=1")),
    /credential changed/u,
  );
  assert.equal(changedCdn.requests.length, 1);
});

test("keeps timeout and external abort active while bounded JSON is consumed", async () => {
  const hanging = (capture?: (signal: AbortSignal | null | undefined) => void): WeixinHttpTransport => ({
    async fetch(_url, init) {
      capture?.(init.signal);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
        },
      });
      return new Response(stream, { status: 200 });
    },
  });
  const timeoutHarness = harness([]);
  await assert.rejects(
    new WeixinApiClient(timeoutHarness.handle, hanging(), { configTimeoutMs: 5 }).getConfig(),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  const controller = new AbortController();
  let dispatched!: () => void;
  const started = new Promise<void>((resolve) => { dispatched = resolve; });
  const abortHarness = harness([]);
  const pending = new WeixinApiClient(abortHarness.handle, hanging(() => dispatched())).getConfig(controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");

  const downloadController = new AbortController();
  const downloadHarness = harness([]);
  const downloadStream = await new WeixinApiClient(downloadHarness.handle, hanging())
    .download(new URL("https://novac2c.cdn.weixin.qq.com/c2c/download?x=1"), downloadController.signal);
  const read = downloadStream.getReader().read();
  downloadController.abort();
  await assert.rejects(read, (error: unknown) => error instanceof Error && error.name === "AbortError");
});

test("requires explicit ret zero for credential probes and message sends", async () => {
  const probe = harness([Response.json({ typing_ticket: "ticket" })]);
  await assert.rejects(new WeixinApiClient(probe.handle, probe.transport).getConfig(), (error: unknown) => {
    return error instanceof WeixinApiError && error.uncertain === false;
  });

  const send = harness([Response.json({ message_id: "maybe-sent" })]);
  await assert.rejects(new WeixinApiClient(send.handle, send.transport).sendMessage({ msg: { client_id: "client" } }), (error: unknown) => {
    return error instanceof WeixinApiError && error.uncertain === true;
  });

  for (const response of [new Response("not-json"), new TypeError("network detail")]) {
    const malformed = harness([response]);
    await assert.rejects(
      new WeixinApiClient(malformed.handle, malformed.transport).sendMessage({ msg: { client_id: "client" } }),
      (error: unknown) => error instanceof WeixinApiError && error.uncertain === true,
    );
  }

  const unsafeRedirect = harness([new Response(null, { status: 307, headers: { location: "https://evil.test/ilink/bot/sendmessage" } })]);
  await assert.rejects(
    new WeixinApiClient(unsafeRedirect.handle, unsafeRedirect.transport).sendMessage({ msg: { client_id: "client" } }),
    (error: unknown) => error instanceof WeixinApiError && error.uncertain === true,
  );
});

test("distinguishes pre-dispatch credential failure from post-dispatch send ambiguity", async () => {
  const fake = harness([]);
  fake.handle.withVerifiedCredential = async () => {
    throw new Error("credential changed before dispatch");
  };

  await assert.rejects(
    new WeixinApiClient(fake.handle, fake.transport).sendMessage({ msg: { client_id: "client" } }),
    (error: unknown) => error instanceof Error
      && !(error instanceof WeixinApiError)
      && error.message === "credential changed before dispatch",
  );
  assert.equal(fake.requests.length, 0);

  const malformedReceipt = harness([Response.json({ ret: 0, message_id: "x".repeat(16 * 1024 + 1) })]);
  await assert.rejects(
    new WeixinApiClient(malformedReceipt.handle, malformedReceipt.transport)
      .sendMessage({ msg: { client_id: "client" } }),
    (error: unknown) => error instanceof WeixinApiError && error.uncertain === true,
  );
});
