import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationBinding } from "../../src/chat/binding.ts";
import { OwnerRouteCatalog } from "../../src/chat/owner-route-store.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { WeixinAccountStore } from "../../src/weixin/account-store.ts";
import { WeixinIncidentRouter } from "../../src/weixin/incident-router.ts";

const telegram = { adapterId: "telegram", conversationKey: "telegram:1", destination: { chatId: "1" } } as const;
const slack = { adapterId: "slack", conversationKey: "slack:T:D", destination: { workspaceId: "T", channelId: "D" } } as const;
const weixin = {
  adapterId: "weixin", conversationKey: "weixin:g:owner",
  destination: { generationId: "generation", botId: "bot", ownerUserId: "owner" },
} as const;

function setup(options: { route?: () => ConversationBinding | undefined; afterWarningPrepared?: () => void } = {}) {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const accounts = new WeixinAccountStore(db, deliveries);
  accounts.activate({
    accountGenerationId: "generation", credentialRevisionId: "revision", botId: "bot", ownerUserId: "owner",
    apiBaseUrl: "https://ilinkai.weixin.qq.com",
  });
  const router = new WeixinIncidentRouter(db, accounts, deliveries, {
    warningRoute: options.route ?? (() => undefined),
    ...(options.afterWarningPrepared ? { afterWarningPrepared: options.afterWarningPrepared } : {}),
  });
  return { db, deliveries, accounts, router };
}

test("atomically latches authorization and prepares one warning on the alternate current route", async () => {
  const catalog = new OwnerRouteCatalog([telegram, slack, weixin], "telegram");
  const fixture = setup({ route: () => catalog.warningRoute({ failedAdapterId: "weixin", current: slack }) });

  await fixture.router.transition({ generationId: "generation", state: "relogin_required", category: "authorization" });
  await fixture.router.transition({ generationId: "generation", state: "relogin_required", category: "authorization" });

  assert.equal(fixture.accounts.authorization("generation"), "relogin_required");
  const warnings = fixture.db.prepare("SELECT id FROM deliveries WHERE kind = 'weixin_authorization_warning'").all() as Array<{ id: string }>;
  assert.equal(warnings.length, 1);
  assert.deepEqual(fixture.deliveries.get(warnings[0]!.id)?.binding, slack);
  assert.deepEqual(fixture.accounts.listUnwarnedIncidents(), []);
  fixture.db.close();
});

test("commits no-route incidents and reconciles them after an alternate adapter appears", async () => {
  let route: typeof telegram | undefined;
  const fixture = setup({ route: () => route });
  await fixture.router.transition({ generationId: "generation", state: "credential_changed", category: "credential_changed" });
  assert.deepEqual(fixture.accounts.listUnwarnedIncidents().map(({ noRoute }) => noRoute), [true]);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE kind = 'weixin_authorization_warning'").get()!.count, 0);

  route = telegram;
  await fixture.router.reconcileUnwarned();
  assert.deepEqual(fixture.accounts.listUnwarnedIncidents(), []);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE kind = 'weixin_authorization_warning'").get()!.count, 1);
  fixture.db.close();
});

test("rolls back latch, incident, and warning together when warning preparation cannot commit", async () => {
  const fixture = setup({
    route: () => telegram,
    afterWarningPrepared: () => { throw new Error("injected warning failure"); },
  });
  await assert.rejects(
    fixture.router.transition({ generationId: "generation", state: "relogin_required", category: "authorization" }),
    /injected/u,
  );
  assert.equal(fixture.accounts.authorization("generation"), "active");
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM weixin_auth_incidents").get()!.count, 0);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE kind = 'weixin_authorization_warning'").get()!.count, 0);
  fixture.db.close();
});

test("a later authorization episode gets a fresh sendable warning identity", async () => {
  const fixture = setup({ route: () => telegram });
  await fixture.router.transition({ generationId: "generation", state: "relogin_required", category: "authorization" });
  const first = fixture.db.prepare("SELECT id FROM deliveries WHERE kind = 'weixin_authorization_warning'").get()!.id as string;

  fixture.accounts.activate({
    accountGenerationId: "generation", credentialRevisionId: "revision", botId: "bot", ownerUserId: "owner",
    apiBaseUrl: "https://ilinkai.weixin.qq.com",
  });
  assert.equal(fixture.deliveries.get(first)?.state, "failed");
  await fixture.router.transition({ generationId: "generation", state: "relogin_required", category: "authorization" });

  const warnings = fixture.db.prepare("SELECT id, state FROM deliveries WHERE kind = 'weixin_authorization_warning' ORDER BY created_at, id")
    .all() as Array<{ id: string; state: string }>;
  assert.equal(warnings.length, 2);
  assert.notEqual(warnings[0]!.id, warnings[1]!.id);
  assert.equal(warnings.some(({ id, state }) => id !== first && state === "prepared"), true);
  fixture.db.close();
});
