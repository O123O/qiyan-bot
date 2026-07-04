import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedSafeInteger,
  canonicalUnsignedInteger,
  parseUpdates,
  readBoundedJson,
  WeixinProtocolError,
} from "../../src/weixin/protocol.ts";

test("preserves message identities above Number.MAX_SAFE_INTEGER", () => {
  const parsed = parseUpdates(JSON.stringify({
    ret: 0,
    get_updates_buf: "QUE=",
    msgs: [{
      message_id: "replace",
      from_user_id: "owner",
      to_user_id: "bot",
      message_type: 1,
      item_list: [{ type: 1, text_item: { text: "hello" } }],
    }],
  }).replace('"replace"', "9007199254740993"));

  assert.deepEqual(parsed.messages[0], {
    status: "valid",
    ordinal: 0,
    identity: { kind: "message", value: "9007199254740993" },
    fromUserId: "owner",
    toUserId: "bot",
    messageType: 1,
    items: [{ kind: "text", text: "hello" }],
  });
});

test("keeps message and client identities separate and marks missing identity locally", () => {
  const parsed = parseUpdates(JSON.stringify({
    ret: 0,
    get_updates_buf: "Qg==",
    msgs: [
      { message_id: 123, item_list: [] },
      { client_id: "123", item_list: [] },
      { from_user_id: "owner", item_list: [] },
    ],
  }));
  assert.deepEqual(parsed.messages.map((message) => message.status === "valid" ? message.identity : message.reason), [
    { kind: "message", value: "123" },
    { kind: "client", value: "123" },
    "missing_identity",
  ]);
});

test("normalizes safe numeric values and rejects unsafe local conversions", () => {
  assert.equal(canonicalUnsignedInteger(0, "id"), "0");
  assert.equal(canonicalUnsignedInteger("00042", "id"), "42");
  assert.equal(boundedSafeInteger(25, "timeout", 10, 30), 25);
  assert.throws(() => canonicalUnsignedInteger("-1", "id"), /id is invalid/u);
  assert.throws(() => boundedSafeInteger(31, "timeout", 10, 30), /timeout is out of range/u);
});

test("treats the polling cursor as opaque and does not expose empty successors", () => {
  assert.equal(parseUpdates('{"ret":0,"get_updates_buf":"QUE=","msgs":[]}').cursor, "QUE=");
  assert.equal(parseUpdates('{"ret":0,"get_updates_buf":"","msgs":[]}').cursor, undefined);
  assert.equal(parseUpdates('{"ret":0,"msgs":[]}').cursor, undefined);
  assert.throws(() => parseUpdates('{"ret":0,"get_updates_buf":"not base64!","msgs":[]}'), /cursor is invalid/u);
});

test("rejects response-wide limits instead of returning a partial cursor", () => {
  const tooManyMessages = Array.from({ length: 101 }, (_, index) => ({ client_id: `c${index}`, item_list: [] }));
  assert.throws(() => parseUpdates(JSON.stringify({ ret: 0, get_updates_buf: "QUE=", msgs: tooManyMessages })), /message count limit/u);
  const tooManyItems = Array.from({ length: 21 }, () => ({ type: 1, text_item: { text: "x" } }));
  assert.throws(() => parseUpdates(JSON.stringify({ ret: 0, get_updates_buf: "QUE=", msgs: [{ client_id: "c", item_list: tooManyItems }] })), /item count limit/u);
  assert.throws(() => parseUpdates(JSON.stringify({ ret: 0, get_updates_buf: "QUE=", msgs: [{ client_id: "c", context_token: "x".repeat(16 * 1024 + 1), item_list: [] }] })), /context token limit/u);
  assert.throws(() => parseUpdates(JSON.stringify({ ret: 0, get_updates_buf: "QUE=", msgs: [{ client_id: "c", item_list: [{ type: 1, text_item: { text: "x".repeat(64 * 1024 + 1) } }] }] })), /text limit/u);
  const aggregateText = Array.from({ length: 2 }, () => ({ type: 1, text_item: { text: "x".repeat(32 * 1024 + 1) } }));
  assert.throws(() => parseUpdates(JSON.stringify({ ret: 0, get_updates_buf: "QUE=", msgs: [{ client_id: "c", item_list: aggregateText }] })), /aggregate text limit/u);
  const oversizedNumericId = "9".repeat(129);
  assert.throws(() => parseUpdates(`{"ret":0,"get_updates_buf":"QUE=","msgs":[{"message_id":${oversizedNumericId},"item_list":[]}]}`), /identity limit/u);
});

test("retains direct-only and image-integrity discriminator fields", () => {
  const parsed = parseUpdates(JSON.stringify({
    ret: 0,
    msgs: [{
      client_id: "c1",
      group_id: "group-1",
      item_list: [{ type: 2, image_item: { media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/download?x=1" }, mid_size: 12, hd_size: 34 } }],
    }],
  }));
  const message = parsed.messages[0];
  assert.equal(message?.status, "valid");
  if (message?.status !== "valid") return;
  assert.equal(message.groupId, "group-1");
  assert.deepEqual(message.items[0], {
    kind: "image",
    image: {
      media: { fullUrl: "https://novac2c.cdn.weixin.qq.com/c2c/download?x=1" },
      mediumSize: 12,
      highDefinitionSize: 34,
    },
  });
});

test("bounds JSON bytes and string-aware nesting before parsing", async () => {
  const response = new Response(new Blob(["{\"text\":\"[not depth]\",\"value\":1}"]));
  assert.equal(await readBoundedJson(response, { maxBytes: 64, maxDepth: 2 }), '{"text":"[not depth]","value":1}');

  await assert.rejects(
    readBoundedJson(new Response(new Blob(["x".repeat(65)])), { maxBytes: 64, maxDepth: 2 }),
    /response size limit/u,
  );
  await assert.rejects(
    readBoundedJson(new Response(new Blob(["[[[0]]]"])), { maxBytes: 64, maxDepth: 2 }),
    /nesting limit/u,
  );
});

test("rejects a non-success or malformed envelope without including response data", () => {
  assert.throws(() => parseUpdates('{"ret":-14,"errmsg":"secret server body"}'), (error: unknown) => {
    assert.equal(error instanceof Error, true);
    assert.doesNotMatch((error as Error).message, /secret server body/u);
    return true;
  });
  assert.throws(() => parseUpdates("[]"), /response envelope is invalid/u);
});

test("treats either ret or errcode as authoritative without exposing response bodies", () => {
  assert.throws(
    () => parseUpdates('{"ret":0,"errcode":-14,"errmsg":"secret","get_updates_buf":"QUE=","msgs":[{"client_id":"c"}]}'),
    (error: unknown) => {
      assert.equal(error instanceof WeixinProtocolError, true);
      assert.equal((error as WeixinProtocolError).code, -14);
      assert.doesNotMatch((error as Error).message, /secret|QUE=|client/u);
      return true;
    },
  );
});
