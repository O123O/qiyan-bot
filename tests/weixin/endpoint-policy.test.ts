import assert from "node:assert/strict";
import test from "node:test";
import { resolveTencentRedirect, validateTencentUrl } from "../../src/chat-apps/weixin/endpoint-policy.ts";

test("accepts only trusted Tencent HTTPS endpoint labels and paths", () => {
  assert.equal(
    validateTencentUrl("https://ilinkai.weixin.qq.com/ilink/bot/getupdates", "get-updates").hostname,
    "ilinkai.weixin.qq.com",
  );
  assert.equal(
    validateTencentUrl("https://novac2c.cdn.weixin.qq.com/c2c/download?id=opaque", "cdn-download").hostname,
    "novac2c.cdn.weixin.qq.com",
  );
  assert.throws(() => validateTencentUrl("http://ilinkai.weixin.qq.com/ilink/bot/getupdates", "get-updates"), /endpoint is not trusted/u);
  assert.throws(() => validateTencentUrl("https://weixin.qq.com.evil.test/ilink/bot/getupdates", "get-updates"), /endpoint is not trusted/u);
  assert.throws(() => validateTencentUrl("https://user@ilinkai.weixin.qq.com/ilink/bot/getupdates", "get-updates"), /endpoint is not trusted/u);
  assert.throws(() => validateTencentUrl("https://ilinkai.weixin.qq.com:444/ilink/bot/getupdates", "get-updates"), /endpoint is not trusted/u);
  assert.throws(() => validateTencentUrl("https://ilinkai.weixin.qq.com/not-ilink/getupdates", "get-updates"), /endpoint path is invalid/u);
  assert.throws(() => validateTencentUrl("https://novac2c.cdn.weixin.qq.com/", "cdn-upload"), /endpoint path is invalid/u);
  assert.throws(() => validateTencentUrl("https://ilinkai.weixin.qq.com/ilink/bot/getupdates#secret", "get-updates"), /endpoint is not trusted/u);
});

test("resolves only bounded redirects that retain endpoint trust", () => {
  const current = new URL("https://ilinkai.weixin.qq.com/ilink/bot/getupdates");
  assert.equal(
    resolveTencentRedirect(current, "https://region.weixin.qq.com/ilink/bot/getupdates", "get-updates", 1).hostname,
    "region.weixin.qq.com",
  );
  assert.equal(
    resolveTencentRedirect(current, "/ilink/bot/getupdates", "get-updates", 3).pathname,
    "/ilink/bot/getupdates",
  );
  assert.throws(() => resolveTencentRedirect(current, "https://evil.test/ilink/bot/getupdates", "get-updates", 1), /endpoint is not trusted/u);
  assert.throws(() => resolveTencentRedirect(current, "https://region.weixin.qq.com/ilink/bot/getupdates", "get-updates", 4), /redirect limit/u);
  assert.throws(() => resolveTencentRedirect(current, "http://region.weixin.qq.com/ilink/bot/getupdates", "get-updates", 1), /endpoint is not trusted/u);
});

test("binds every redirect to one exact operation", () => {
  assert.equal(validateTencentUrl("https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3", "qr-create").pathname, "/ilink/bot/get_bot_qrcode");
  assert.equal(validateTencentUrl("https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=opaque&verify_code=123456", "qr-status").pathname, "/ilink/bot/get_qrcode_status");
  assert.equal(validateTencentUrl("https://ilinkai.weixin.qq.com/ilink/bot/msg/notifystop", "notify-stop").pathname, "/ilink/bot/msg/notifystop");
  assert.equal(validateTencentUrl("https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=x&filekey=y", "cdn-upload").pathname, "/c2c/upload");

  const current = new URL("https://ilinkai.weixin.qq.com/ilink/bot/getupdates");
  assert.throws(() => resolveTencentRedirect(current, "/ilink/bot/sendmessage", "get-updates", 1), /endpoint path is invalid/u);
  assert.throws(() => validateTencentUrl("https://ilinkai.weixin.qq.com/ilink/bot/getupdates?unexpected=1", "get-updates"), /endpoint query is invalid/u);
  assert.throws(() => validateTencentUrl("https://ilinkai.weixin.qq.com/ilink/bot%2fgetupdates", "get-updates"), /endpoint path is invalid/u);
  assert.throws(() => validateTencentUrl("https://novac2c.cdn.weixin.qq.com/c2c%2fupload?x=1", "cdn-upload"), /endpoint path is invalid/u);
  assert.throws(() => validateTencentUrl("https://novac2c.cdn.weixin.qq.com/c2c/download?x=1", "cdn-upload"), /endpoint path is invalid/u);
});
