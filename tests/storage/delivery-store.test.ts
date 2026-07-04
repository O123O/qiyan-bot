import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "../../src/storage/database.ts";
import { openDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { inTransaction } from "../../src/storage/database.ts";
import { migrations } from "../../src/storage/migrations.ts";

const binding = { adapterId: "telegram", conversationKey: "telegram:42", destination: { chatId: "42" } } as const;

test("dispatched deliveries become uncertain during startup recovery", () => {
  const store = new DeliveryStore(createTestDatabase());
  const delivery = store.prepare({ kind: "worker_final", binding, body: "done", mandatory: true });
  store.markDispatched(delivery.id);
  store.recoverAfterCrash();
  assert.equal(store.get(delivery.id)?.state, "uncertain");
});

test("confirmed deliveries are never recovered as uncertain", () => {
  const store = new DeliveryStore(createTestDatabase());
  const delivery = store.prepare({ kind: "worker_final", binding, body: "done", mandatory: true });
  store.markDispatched(delivery.id);
  store.confirm(delivery.id, { messageId: 9 });
  store.recoverAfterCrash();
  assert.equal(store.get(delivery.id)?.state, "confirmed");
});

test("failInTransaction applies terminal failure and releases an attachment exactly once", () => {
  const db = createTestDatabase();
  db.prepare(`INSERT INTO attachments
    (id, scope_id, display_name, media_type, local_path, size, sha256, ref_count, expires_at, created_at)
    VALUES ('attachment', 'scope', 'file', 'text/plain', '/tmp/file', 1, 'hash', 0, 999, 1)`).run();
  const store = new DeliveryStore(db);
  const first = store.prepareAttachment({
    id: "first", kind: "file", binding, body: "", mandatory: false,
    attachmentId: "attachment", attachmentScopeId: "scope",
  });
  store.prepareAttachment({
    id: "second", kind: "file", binding, body: "", mandatory: true,
    attachmentId: "attachment", attachmentScopeId: "scope",
  });
  assert.equal(db.prepare("SELECT ref_count FROM attachments WHERE id = 'attachment'").get()!.ref_count, 2);
  store.markUncertain(first.id);
  assert.equal(db.prepare("SELECT ref_count FROM attachments WHERE id = 'attachment'").get()!.ref_count, 2);
  assert.equal(inTransaction(db, () => store.failInTransaction(first.id)), true);
  assert.equal(db.prepare("SELECT ref_count FROM attachments WHERE id = 'attachment'").get()!.ref_count, 1);
  assert.equal(inTransaction(db, () => store.failInTransaction("second")), true);
  assert.equal(inTransaction(db, () => store.failInTransaction("second")), false);
  assert.equal(db.prepare("SELECT ref_count FROM attachments WHERE id = 'attachment'").get()!.ref_count, 0);
  db.close();
});

test("only an uncertain delivery can return to prepared for adapter reconciliation", () => {
  const store = new DeliveryStore(createTestDatabase());
  const delivery = store.prepare({ id: "resume", kind: "text", binding, body: "", mandatory: true });
  assert.equal(store.resumeUncertain(delivery.id), false);
  store.markDispatched(delivery.id);
  store.recoverAfterCrash();
  assert.equal(store.resumeUncertain(delivery.id), true);
  assert.equal(store.get(delivery.id)?.state, "prepared");
  assert.equal(store.resumeUncertain(delivery.id), false);
});

test("release-ledger migration backfills historical optional uncertainty without double releasing shared refs", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-delivery-release-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "bot.sqlite3");
  const db = openDatabase(path);
  db.prepare(`INSERT INTO attachments
    (id, scope_id, display_name, media_type, local_path, size, sha256, ref_count, expires_at, created_at)
    VALUES ('attachment', 'scope', 'file', 'x', '/tmp/file', 1, 'hash', 0, 999, 1)`).run();
  const store = new DeliveryStore(db);
  const historical = store.prepareAttachment({ id: "historical", kind: "file", binding, body: "", mandatory: false, attachmentId: "attachment", attachmentScopeId: "scope" });
  store.prepareAttachment({ id: "still-held", kind: "file", binding, body: "", mandatory: true, attachmentId: "attachment", attachmentScopeId: "scope" });
  db.prepare("UPDATE deliveries SET state = 'uncertain' WHERE id = ?").run(historical.id);
  db.prepare("UPDATE attachments SET ref_count = 1 WHERE id = 'attachment'").run();
  db.exec(`DROP TABLE delivery_attachment_releases; DELETE FROM schema_migrations WHERE version = ${migrations.length}`);
  db.close();

  const migrated = openDatabase(path);
  assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM delivery_attachment_releases WHERE delivery_id = 'historical'").get()!.count, 1);
  new DeliveryStore(migrated).abandonUncertain("historical");
  assert.equal(migrated.prepare("SELECT ref_count FROM attachments WHERE id = 'attachment'").get()!.ref_count, 1);
  migrated.close();
});
