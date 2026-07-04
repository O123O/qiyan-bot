import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createTestDatabase, openDatabase } from "../../src/storage/database.ts";
import { migrations } from "../../src/storage/migrations.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

test("installs constrained WeChat lifecycle, inbox, route, media, and outbound tables", () => {
  const db = createTestDatabase();
  const expected = [
    "weixin_account_generations",
    "weixin_auth_incidents",
    "weixin_sync_state",
    "weixin_inbox",
    "weixin_inbox_sequence",
    "weixin_route_tokens",
    "weixin_inbox_media",
    "weixin_inbox_attachment_refs",
    "weixin_outbound_steps",
  ];
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(({ name }) => name));
  for (const name of expected) assert.equal(tables.has(name), true, `missing ${name}`);
  assert.throws(() => db.prepare(`INSERT INTO weixin_account_generations
    (generation_id, credential_revision_id, bot_id, owner_user_id, api_base_url, authorization_state, active, activated_at)
    VALUES ('g', 'r', 'b', 'o', 'https://ilinkai.weixin.qq.com', 'invalid', 1, 1)`).run(), /CHECK/u);
  assert.throws(() => db.prepare(`INSERT INTO weixin_inbox_sequence(singleton, next_value) VALUES (2, 1)`).run(), /CHECK/u);
  assert.throws(() => db.prepare(`INSERT INTO weixin_outbound_steps
    (id, delivery_id, generation_id, ordinal, kind, state, request_hash, request_json, created_at, updated_at)
    VALUES ('s', 'missing', 'missing', 0, 'text', 'prepared', 'h', '{}', 1, 1)`).run(), /FOREIGN KEY/u);

  for (const generation of ["one", "two"]) {
    db.prepare(`INSERT INTO weixin_account_generations
      (generation_id, credential_revision_id, bot_id, owner_user_id, api_base_url, authorization_state, active, activated_at)
      VALUES (?, 'revision', ?, ?, 'https://ilinkai.weixin.qq.com', 'active', ?, 1)`)
      .run(generation, `bot-${generation}`, `owner-${generation}`, generation === "one" ? 1 : 0);
    db.prepare("INSERT INTO weixin_sync_state(generation_id, cursor) VALUES (?, '')").run(generation);
  }
  db.prepare(`INSERT INTO weixin_route_tokens(id, generation_id, token, is_current, created_at)
    VALUES ('route-one', 'one', 'secret', 1, 1)`).run();
  assert.throws(() => db.prepare(`INSERT INTO weixin_inbox
    (generation_id, identity_kind, identity_value, arrival_sequence, state, normalized_json, route_token_id, created_at, updated_at)
    VALUES ('two', 'message', 'cross-route', 1, 'pending', '{}', 'route-one', 1, 1)`).run(), /FOREIGN KEY/u);

  db.prepare(`INSERT INTO weixin_inbox
    (generation_id, identity_kind, identity_value, arrival_sequence, state, normalized_json, created_at, updated_at)
    VALUES ('one', 'message', 'head-one', 2, 'processing', '{}', 1, 1)`).run();
  assert.throws(() => db.prepare(`INSERT INTO weixin_inbox
    (generation_id, identity_kind, identity_value, arrival_sequence, state, normalized_json, created_at, updated_at)
    VALUES ('one', 'message', 'head-two', 3, 'processing', '{}', 1, 1)`).run(), /UNIQUE/u);

  const delivery = new DeliveryStore(db).prepare({
    id: "delivery", kind: "text",
    binding: { adapterId: "weixin", conversationKey: "weixin:two", destination: {} },
    body: "", mandatory: true,
  });
  assert.throws(() => db.prepare(`INSERT INTO weixin_outbound_steps
    (id, delivery_id, generation_id, ordinal, kind, state, request_hash, request_json, route_token_id, created_at, updated_at)
    VALUES ('cross-step', ?, 'two', 0, 'text', 'prepared', 'hash', '{}', 'route-one', 1, 1)`).run(delivery.id), /FOREIGN KEY/u);
  db.close();
});

test("appends the WeChat migration to completed state-version 2 and 3 databases", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-weixin-migration-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const stateVersion of [2, 3]) {
    const path = join(root, `v${stateVersion}.sqlite3`);
    openDatabase(path).close();
    const old = new DatabaseSync(path);
    old.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE delivery_attachment_releases;
      DROP TABLE weixin_outbound_steps;
      DROP TABLE weixin_inbox_attachment_refs;
      DROP TABLE weixin_inbox_media;
      DROP TABLE weixin_inbox;
      DROP TABLE weixin_route_tokens;
      DROP TABLE weixin_inbox_sequence;
      DROP TABLE weixin_sync_state;
      DROP TABLE weixin_auth_incidents;
      DROP TABLE weixin_account_generations;
      DELETE FROM schema_migrations WHERE version >= ${migrations.length - 1};
      UPDATE qiyan_state SET state_version = ${stateVersion};
      UPDATE conversation_cutover SET phase = 'complete' WHERE singleton = 1;
    `);
    old.close();

    const migrated = openDatabase(path);
    assert.equal(migrated.prepare("SELECT state_version FROM qiyan_state").get()!.state_version, stateVersion);
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM weixin_account_generations").get()!.count, 0);
    assert.equal(migrated.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()!.version, migrations.length);
    migrated.close();
  }
});
