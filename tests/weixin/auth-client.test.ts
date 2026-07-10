import assert from "node:assert/strict";
import test from "node:test";
import { WeixinAuthClient, type WeixinQrChallenge } from "../../src/chat-apps/weixin/auth-client.ts";

interface ObservedRequest { url: URL; init: RequestInit }

function transport(responses: Response[]) {
  const requests: ObservedRequest[] = [];
  return {
    requests,
    value: {
      async fetch(url: URL, init: RequestInit) {
        requests.push({ url, init });
        const response = responses.shift();
        if (!response) throw new Error("unexpected request");
        return response;
      },
    },
  };
}

test("creates a QR challenge with exact unauthenticated headers and one prior token", async () => {
  const fake = transport([Response.json({ qrcode: "opaque-qr-token", qrcode_img_content: "https://weixin.qq.com/qr/opaque" })]);
  const client = new WeixinAuthClient(fake.value, { nextUin: () => 7 });
  const challenge = await client.createQr("prior-private-token");

  assert.deepEqual(challenge, {
    token: "opaque-qr-token",
    payload: "https://weixin.qq.com/qr/opaque",
    baseUrl: "https://ilinkai.weixin.qq.com",
  });
  const request = fake.requests[0]!;
  assert.equal(request.url.href, "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(JSON.parse(String(request.init.body)), { local_token_list: ["prior-private-token"] });
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get("iLink-App-Id"), "bot");
  assert.equal(headers.get("AuthorizationType"), "ilink_bot_token");
  assert.equal(headers.get("X-WECHAT-UIN"), Buffer.from("7").toString("base64"));
  assert.equal(headers.get("Authorization"), null);
});

test("polls every exact QR state with only common GET headers", async () => {
  const states = ["wait", "scaned", "scaned_but_redirect", "need_verifycode", "verify_code_blocked", "binded_redirect", "expired", "confirmed"] as const;
  const fake = transport(states.map((status) => Response.json({
    status,
    ...(status === "scaned_but_redirect" ? { redirect_host: "region.weixin.qq.com" } : {}),
    ...(status === "confirmed" ? {
      bot_token: "new-token",
      ilink_bot_id: "bot-id",
      ilink_user_id: "owner-id",
      baseurl: "https://region.weixin.qq.com",
    } : {}),
  })));
  const client = new WeixinAuthClient(fake.value);
  let challenge: WeixinQrChallenge = { token: "opaque", payload: "payload", baseUrl: "https://ilinkai.weixin.qq.com" };
  for (const expected of states) {
    const result = await client.pollQr(challenge, expected === "need_verifycode" ? "123456" : undefined);
    assert.equal(result.status, expected);
    if (result.status === "scaned_but_redirect") {
      assert.equal(result.redirectBaseUrl, "https://region.weixin.qq.com");
      challenge = { ...challenge, baseUrl: result.redirectBaseUrl };
    }
  }
  for (const request of fake.requests) {
    const headers = new Headers(request.init.headers);
    assert.equal(request.init.method, "GET");
    assert.equal(headers.get("iLink-App-Id"), "bot");
    assert.equal(headers.get("Authorization"), null);
    assert.equal(headers.get("AuthorizationType"), null);
    assert.equal(headers.get("X-WECHAT-UIN"), null);
  }
  assert.equal(fake.requests[3]?.url.searchParams.get("verify_code"), "123456");
});

test("rejects unknown states, unsafe redirects, oversized auth JSON, and invalid verification codes", async () => {
  const challenge: WeixinQrChallenge = { token: "opaque", payload: "payload", baseUrl: "https://ilinkai.weixin.qq.com" };
  await assert.rejects(new WeixinAuthClient(transport([Response.json({ status: "new-state" })]).value).pollQr(challenge), /QR response is invalid/u);
  await assert.rejects(new WeixinAuthClient(transport([Response.json({ status: "scaned_but_redirect", redirect_host: "evil.test" })]).value).pollQr(challenge), /endpoint is not trusted/u);
  await assert.rejects(new WeixinAuthClient(transport([new Response("x".repeat(256 * 1024 + 1))]).value).pollQr(challenge), /response size limit/u);
  await assert.rejects(new WeixinAuthClient(transport([]).value).pollQr(challenge, "not-numeric"), /verification code is invalid/u);
});

test("follows only operation-preserving manual redirects", async () => {
  const fake = transport([
    new Response(null, { status: 307, headers: { location: "https://region.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3" } }),
    Response.json({ qrcode: "opaque", qrcode_img_content: "payload" }),
  ]);
  const result = await new WeixinAuthClient(fake.value).createQr();
  assert.equal(result.token, "opaque");
  assert.equal(fake.requests.length, 2);

  const crossed = transport([new Response(null, { status: 307, headers: { location: "/ilink/bot/get_qrcode_status?qrcode=x" } })]);
  await assert.rejects(new WeixinAuthClient(crossed.value).createQr(), /endpoint path is invalid/u);
});
