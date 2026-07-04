import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { WeixinAccountStore } from "../../src/weixin/account-store.ts";
import { WeixinInboxStore, weixinNativeSourceId } from "../../src/weixin/inbox-store.ts";
import { parseUpdates } from "../../src/weixin/protocol.ts";

function setup(options: { beforeCursorUpdate?: () => void } = {}) {
  const db = createTestDatabase();
  const accounts = new WeixinAccountStore(db, new DeliveryStore(db));
  accounts.activate({
    accountGenerationId: "generation", credentialRevisionId: "revision", botId: "bot", ownerUserId: "owner",
    apiBaseUrl: "https://ilinkai.weixin.qq.com",
  });
  const inbox = new WeixinInboxStore(db, { botId: "bot", ownerUserId: "owner" }, options);
  return { db, accounts, inbox };
}

test("commits authorized messages in server order, separates identity kinds, deduplicates, and advances an opaque cursor", () => {
  const { db, inbox } = setup();
  const batch = parseUpdates(JSON.stringify({
    ret: 0,
    get_updates_buf: "bmV4dA==",
    msgs: [
      { message_id: 7, from_user_id: "owner", to_user_id: "bot", context_token: "route-a", item_list: [{ type: 1, text_item: { text: "first" } }] },
      { client_id: "7", from_user_id: "owner", to_user_id: "bot", context_token: "route-b", item_list: [{ type: 3, voice_item: { text: "second" } }] },
      { message_id: 8, from_user_id: "stranger", to_user_id: "bot", item_list: [{ type: 1, text_item: { text: "private unauthorized" } }] },
      { from_user_id: "owner", to_user_id: "bot", item_list: [{ type: 1, text_item: { text: "private malformed" } }] },
      { message_id: 9, from_user_id: "owner", to_user_id: "bot", group_id: "group", item_list: [{ type: 1, text_item: { text: "private group" } }] },
    ],
  }));

  assert.deepEqual(inbox.commitPoll("generation", "", batch), { inserted: 2, discarded: 3, cursor: "bmV4dA==" });
  assert.deepEqual(inbox.list("generation").map((row) => ({ identity: row.identity, sequence: row.arrivalSequence })), [
    { identity: { kind: "message", value: "7" }, sequence: 1 },
    { identity: { kind: "client", value: "7" }, sequence: 2 },
  ]);
  assert.doesNotMatch(JSON.stringify(inbox.list("generation")), /private unauthorized|private malformed|private group/u);
  assert.equal(inbox.cursor("generation"), "bmV4dA==");
  assert.deepEqual(inbox.commitPoll("generation", "bmV4dA==", batch), { inserted: 0, discarded: 5, cursor: "bmV4dA==" });
  const noSuccessor = parseUpdates('{"ret":0,"get_updates_buf":"","msgs":[]}');
  assert.equal(inbox.commitPoll("generation", "bmV4dA==", noSuccessor).cursor, "bmV4dA==");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM weixin_route_tokens").get()!.count, 2);
  db.close();
});

test("cursor comparison, inbox inserts, route tokens, and sequence allocation roll back together", () => {
  const injected = setup({ beforeCursorUpdate: () => { throw new Error("injected cursor failure"); } });
  const batch = parseUpdates(JSON.stringify({
    ret: 0, get_updates_buf: "bmV4dA==", msgs: [
      { message_id: 1, from_user_id: "owner", to_user_id: "bot", context_token: "secret", item_list: [] },
    ],
  }));
  assert.throws(() => injected.inbox.commitPoll("generation", "", batch), /injected/u);
  assert.equal(injected.inbox.cursor("generation"), "");
  assert.deepEqual(injected.inbox.list("generation"), []);
  assert.equal(injected.db.prepare("SELECT next_value FROM weixin_inbox_sequence").get()!.next_value, 1);
  assert.equal(injected.db.prepare("SELECT COUNT(*) AS count FROM weixin_route_tokens").get()!.count, 0);
  assert.throws(() => injected.inbox.commitPoll("generation", "wrong", { ret: 0, messages: [] }), /cursor changed/u);
  injected.db.close();
});

test("claims one ordered processing head, recovers it, and refuses retired generations", () => {
  const { db, accounts, inbox } = setup();
  const batch = parseUpdates(JSON.stringify({ ret: 0, msgs: [1, 2].map((message_id) => ({
    message_id, from_user_id: "owner", to_user_id: "bot", item_list: [],
  })) }));
  inbox.commitPoll("generation", "", batch);
  assert.equal(inbox.claimHead("generation")?.identity.value, "1");
  assert.equal(inbox.claimHead("generation"), undefined);
  inbox.recoverProcessing("generation");
  assert.equal(inbox.claimHead("generation")?.identity.value, "1");

  accounts.activate({
    accountGenerationId: "new", credentialRevisionId: "new-revision", botId: "new-bot", ownerUserId: "new-owner",
    apiBaseUrl: "https://ilinkai.weixin.qq.com",
  });
  assert.throws(() => inbox.commitPoll("generation", "", { ret: 0, messages: [] }), /inactive/u);
  assert.equal(inbox.claimHead("generation"), undefined);
  db.close();
});

test("resolves immutable and current route tokens and collects only unreferenced old versions", () => {
  const { db, inbox } = setup();
  const batch = parseUpdates(JSON.stringify({ ret: 0, msgs: [
    { message_id: 1, from_user_id: "owner", to_user_id: "bot", context_token: "route-old", item_list: [] },
    { message_id: 2, from_user_id: "owner", to_user_id: "bot", context_token: "route-new", item_list: [] },
  ] }));
  inbox.commitPoll("generation", "", batch);
  const rows = inbox.list("generation");
  assert.equal(inbox.resolveRouteToken("generation", rows[0]?.routeTokenId), "route-old");
  assert.equal(inbox.resolveRouteToken("generation"), "route-new");
  assert.equal(inbox.collectUnreferencedRouteTokens("generation"), 0);
  db.prepare("UPDATE weixin_inbox SET route_token_id = NULL WHERE identity_value = '1'").run();
  assert.equal(inbox.collectUnreferencedRouteTokens("generation"), 1);
  assert.equal(inbox.resolveRouteToken("generation"), "route-new");
  db.close();
});

test("derives generation- and identity-kind-separated canonical source IDs", () => {
  assert.equal(weixinNativeSourceId("g1", { kind: "message", value: "7" }), "weixin:g1:message:7");
  assert.notEqual(
    weixinNativeSourceId("g1", { kind: "message", value: "7" }),
    weixinNativeSourceId("g1", { kind: "client", value: "7" }),
  );
  assert.notEqual(
    weixinNativeSourceId("g1", { kind: "message", value: "7" }),
    weixinNativeSourceId("g2", { kind: "message", value: "7" }),
  );
});
