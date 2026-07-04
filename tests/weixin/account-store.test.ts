import assert from "node:assert/strict";
import test from "node:test";
import type { WeixinCredentialPublic } from "../../src/weixin/credential-store.ts";
import { WeixinAccountStore } from "../../src/weixin/account-store.ts";
import { createTestDatabase, inTransaction } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

const binding = { adapterId: "weixin", conversationKey: "weixin:owner", destination: { generationId: "old" } } as const;

function identity(generationId: string, revisionId: string, botId = "bot", ownerUserId = "owner"): WeixinCredentialPublic {
  return { accountGenerationId: generationId, credentialRevisionId: revisionId, botId, ownerUserId, apiBaseUrl: "https://ilinkai.weixin.qq.com" };
}

test("preserves same-generation state, changes revisions, and durably deduplicates latch incidents", () => {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const store = new WeixinAccountStore(db, deliveries);
  assert.equal(store.activate(identity("generation", "revision-1")).kind, "new-generation");
  db.prepare("UPDATE weixin_sync_state SET cursor = 'opaque' WHERE generation_id = 'generation'").run();
  db.prepare(`INSERT INTO weixin_route_tokens(id, generation_id, token, is_current, created_at)
    VALUES ('route', 'generation', 'secret-context', 1, 1)`).run();
  assert.equal(store.activate(identity("generation", "revision-1")).kind, "unchanged");
  assert.equal(store.latchInactive("generation", "relogin_required", "incident-1"), true);
  assert.equal(store.latchInactive("generation", "relogin_required", "incident-2"), false);
  assert.equal(store.authorization("generation"), "relogin_required");
  assert.deepEqual(store.listUnwarnedIncidents().map(({ incidentId, noRoute }) => ({ incidentId, noRoute })), [
    { incidentId: "incident-1", noRoute: true },
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM weixin_auth_incidents").get()!.count, 1);

  deliveries.prepare({ id: "stale-warning", kind: "warning", binding, body: "warning", mandatory: true });
  inTransaction(db, () => store.markIncidentRouteInTransaction("incident-1", { warningDeliveryId: "stale-warning" }));

  assert.equal(store.activate(identity("generation", "revision-2")).kind, "new-revision");
  assert.equal(store.authorization("generation"), "active");
  assert.equal(deliveries.get("stale-warning")?.state, "failed");
  assert.deepEqual(store.listUnwarnedIncidents(), []);
  assert.equal(db.prepare("SELECT cursor FROM weixin_sync_state WHERE generation_id = 'generation'").get()!.cursor, "opaque");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM weixin_route_tokens WHERE generation_id = 'generation'").get()!.count, 1);
  db.close();
});

test("a new identity fences old inbox work, fails old plans, releases attachments, and clears only a WeChat latest route", () => {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const store = new WeixinAccountStore(db, deliveries);
  store.activate(identity("old", "old-revision", "old-bot", "old-owner"));
  db.prepare(`INSERT INTO weixin_inbox
    (generation_id, identity_kind, identity_value, arrival_sequence, state, normalized_json, created_at, updated_at)
    VALUES ('old', 'message', '1', 1, 'pending', '{}', 1, 1)`).run();
  db.prepare(`INSERT INTO attachments
    (id, scope_id, display_name, media_type, local_path, size, sha256, ref_count, expires_at, created_at)
    VALUES ('attachment', 'scope', 'file', 'text/plain', '/tmp/file', 1, 'hash', 0, 999, 1)`).run();
  const delivery = deliveries.prepareAttachment({
    id: "old-delivery", kind: "file", binding, body: "body", mandatory: true,
    attachmentId: "attachment", attachmentScopeId: "scope",
  });
  db.prepare(`INSERT INTO weixin_outbound_steps
    (id, delivery_id, generation_id, ordinal, kind, state, request_hash, request_json, created_at, updated_at)
    VALUES ('step', ?, 'old', 0, 'file', 'prepared', 'hash', '{}', 1, 1)`).run(delivery.id);
  db.prepare(`INSERT INTO source_contexts
    (id, kind, source_id, raw_text, attachment_ids_json, state, created_at, adapter_id, conversation_key,
      destination_json, arrival_sequence, source_class)
    VALUES ('owner-source', 'weixin', 'source', '', '[]', 'completed', 1, 'weixin', 'weixin:owner', '{}', 1, 'chat')`).run();
  db.prepare(`INSERT INTO latest_owner_route
    (singleton, adapter_id, conversation_key, destination_json, reply_json, source_context_id, accepted_at)
    VALUES (1, 'weixin', 'weixin:owner', '{}', NULL, 'owner-source', 1)`).run();

  assert.equal(store.activate(identity("new", "new-revision", "new-bot", "new-owner")).kind, "new-generation");
  assert.equal(db.prepare("SELECT active FROM weixin_account_generations WHERE generation_id = 'old'").get()!.active, 0);
  assert.equal(db.prepare("SELECT state FROM weixin_inbox WHERE generation_id = 'old'").get()!.state, "fenced");
  assert.equal(deliveries.get("old-delivery")?.state, "failed");
  assert.equal(db.prepare("SELECT ref_count FROM attachments WHERE id = 'attachment'").get()!.ref_count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM weixin_outbound_steps WHERE generation_id = 'old'").get()!.count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM latest_owner_route").get()!.count, 0);

  db.prepare(`INSERT INTO latest_owner_route
    (singleton, adapter_id, conversation_key, destination_json, reply_json, source_context_id, accepted_at)
    VALUES (1, 'telegram', 'telegram:1', '{}', NULL, 'owner-source', 1)`).run();
  store.activate(identity("newer", "revision", "newer-bot", "newer-owner"));
  assert.equal(db.prepare("SELECT adapter_id FROM latest_owner_route").get()!.adapter_id, "telegram");
  db.close();
});

test("generation replacement rolls back every delivery and account mutation after an injected failure", () => {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  new WeixinAccountStore(db, deliveries).activate(identity("old", "revision", "old-bot", "old-owner"));
  for (const id of ["one", "two"]) {
    const delivery = deliveries.prepare({ id, kind: "text", binding, body: id, mandatory: true });
    db.prepare(`INSERT INTO weixin_outbound_steps
      (id, delivery_id, generation_id, ordinal, kind, state, request_hash, request_json, created_at, updated_at)
      VALUES (?, ?, 'old', 0, 'text', 'prepared', 'hash', '{}', 1, 1)`).run(`step-${id}`, delivery.id);
  }
  let failures = 0;
  const store = new WeixinAccountStore(db, deliveries, {
    afterOldDeliveryFailed: () => { failures += 1; if (failures === 1) throw new Error("injected activation failure"); },
  });
  assert.throws(() => store.activate(identity("new", "revision", "new-bot", "new-owner")), /injected/u);
  assert.equal(db.prepare("SELECT active FROM weixin_account_generations WHERE generation_id = 'old'").get()!.active, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM weixin_account_generations WHERE generation_id = 'new'").get()!.count, 0);
  assert.deepEqual([deliveries.get("one")?.state, deliveries.get("two")?.state], ["prepared", "prepared"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM weixin_outbound_steps WHERE generation_id = 'old'").get()!.count, 2);
  db.close();
});

test("in-transaction incidents remain routable until their route result is recorded", () => {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const store = new WeixinAccountStore(db, deliveries);
  store.activate(identity("generation", "revision"));
  const transition = inTransaction(db, () => store.latchInactiveInTransaction(
    "generation", "credential_changed", "incident-routed",
  ));
  assert.equal(transition.changed, true);
  assert.deepEqual(store.listUnwarnedIncidents().map(({ incidentId }) => incidentId), ["incident-routed"]);
  deliveries.prepare({ id: "warning-id", kind: "warning", binding, body: "warning", mandatory: true });
  inTransaction(db, () => store.markIncidentRouteInTransaction("incident-routed", { warningDeliveryId: "warning-id" }));
  assert.deepEqual(store.listUnwarnedIncidents(), []);
  db.close();
});

test("an authenticated activation of the unchanged revision clears an inactive latch", () => {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const store = new WeixinAccountStore(db, deliveries);
  store.activate(identity("generation", "revision"));
  assert.equal(store.latchInactive("generation", "relogin_required", "incident"), true);

  store.prepareAuthenticatedProbe(identity("generation", "revision"));
  assert.equal(store.authorization("generation"), "relogin_required");

  assert.equal(store.activate(identity("generation", "revision")).kind, "unchanged");

  assert.equal(store.authorization("generation"), "active");
  assert.deepEqual(store.listUnwarnedIncidents(), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM weixin_auth_incidents").get()!.count, 0);
  db.close();
});
