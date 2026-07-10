import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { AttachmentStore } from "../../src/attachments/store.ts";
import type { ConversationBinding } from "../../src/chat/binding.ts";
import { AppError } from "../../src/core/errors.ts";
import type { CanonicalChatSource } from "../../src/core/types.ts";
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";

function binding(adapterId: string, conversationKey: string): ConversationBinding {
  return { adapterId, conversationKey, destination: { id: conversationKey } };
}

function message(id: string, route: ConversationBinding, attachmentIds: readonly string[] = []): CanonicalChatSource {
  return { id, nativeSourceId: `native:${id}`, binding: route, rawText: id, attachmentIds, receivedAt: 100 };
}

function fixture() {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  return { db, deliveries, store: new ConversationStore(db, deliveries) };
}

test("chat acceptance persists only and dispatcher arbitration owns lease creation", () => {
  const { store } = fixture();
  const first = store.acceptChatSource(message("one", binding("telegram", "chat-1")));
  const second = store.acceptChatSource(message("two", binding("slack", "dm-1")));
  assert.equal(first.disposition, "pending");
  assert.equal(second.disposition, "pending");
  assert.equal(store.lease(), undefined);

  const lease = store.acquireLease({ kind: "chat", contextId: "one" }, "claim-one");
  assert.equal(lease.primaryContextId, "one");
  assert.equal(lease.capacityClaimId, "claim-one");
  assert.equal(store.acceptChatSource(message("three", binding("telegram", "chat-1"))).disposition, "owner");
});

test("cross-conversation input queues with one exact durable notice while same-owner input does not", () => {
  const { deliveries, store } = fixture();
  store.acceptChatSource(message("one", binding("telegram", "chat-1")));
  store.acquireLease({ kind: "chat", contextId: "one" }, "claim-one");

  const queued = store.acceptChatSource(message("two", binding("slack", "dm-1")));
  const owner = store.acceptChatSource(message("three", binding("telegram", "chat-1")));
  assert.equal(queued.disposition, "queued");
  assert.equal(owner.disposition, "owner");
  assert.equal(deliveries.get("queued:two")?.body, "[system] queued");
  assert.equal(deliveries.get("queued:three"), undefined);
  assert.equal(store.lease()?.primaryContextId, "one");
});

test("native duplicates keep their first identity, sequence, and notice and repair a missing notice", () => {
  const { db, deliveries, store } = fixture();
  store.acceptChatSource(message("owner", binding("telegram", "chat-1")));
  store.acquireLease({ kind: "chat", contextId: "owner" }, "claim");
  const original = store.acceptChatSource(message("queued", binding("slack", "dm-1")));
  const duplicate = store.acceptChatSource({ ...message("replacement", binding("slack", "dm-1")), nativeSourceId: "native:queued" });
  assert.equal(duplicate.contextId, original.contextId);
  assert.equal(duplicate.disposition, "queued");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_contexts WHERE adapter_id = 'slack'").get()!.n, 1);

  db.prepare("DELETE FROM deliveries WHERE id = 'queued:queued'").run();
  store.acceptChatSource(message("queued", binding("slack", "dm-1")));
  assert.equal(deliveries.get("queued:queued")?.body, "[system] queued");
  db.prepare("DELETE FROM deliveries WHERE id = 'queued:queued'").run();
  assert.equal(store.repairQueueNotices(), 1);
  assert.equal(store.repairQueueNotices(), 0);
});

test("lease acquisition notices every already-pending losing chat, including all chats for internal work", () => {
  const { deliveries, store } = fixture();
  store.acceptChatSource(message("one", binding("telegram", "chat-1")));
  store.acceptChatSource(message("same", binding("telegram", "chat-1")));
  store.acceptChatSource(message("other", binding("slack", "dm-1")));
  store.acquireLease({ kind: "chat", contextId: "one" }, "claim");
  assert.equal(deliveries.get("queued:same"), undefined);
  assert.equal(deliveries.get("queued:other")?.body, "[system] queued");

  const next = fixture();
  next.store.acceptChatSource(message("chat", binding("telegram", "chat-1")));
  next.store.createInternalSource({ id: "internal", kind: "event_batch", sourceId: "batch", rawText: "events", attachmentIds: [], receivedAt: 90 });
  next.store.acquireLease({ kind: "internal", contextId: "internal" }, "internal-claim");
  assert.equal(next.deliveries.get("queued:chat")?.body, "[system] queued");
});

test("a route-bound recovery turn queues chat input and never reserves it as a steer", () => {
  const { db, deliveries, store } = fixture();
  const route = binding("telegram", "chat-1");
  new OperationStore(db).createSourceContext({
    id: "recovery",
    kind: "recovery",
    sourceId: "failed-chat",
    rawText: "reconcile side effects",
    attachmentIds: [],
    binding: route,
  });
  const lease = store.acquireLease({ kind: "internal", contextId: "recovery" }, "claim");
  store.reserveStart("recovery");
  store.markSubmitted(lease.attemptId, "recovery", "turn");

  const accepted = store.acceptChatSource(message("follow-up", route));
  assert.equal(accepted.disposition, "queued");
  assert.equal(deliveries.get("queued:follow-up")?.body, "[system] queued");
  assert.equal(store.reserveNextSteer(lease.attemptId), undefined);
  assert.equal(db.prepare("SELECT state FROM source_contexts WHERE id = 'follow-up'").get()!.state, "pending");
});

test("reservations pair source and membership state and allow only one unresolved native submission", () => {
  const { db, store } = fixture();
  store.acceptChatSource(message("one", binding("telegram", "chat-1")));
  store.acceptChatSource(message("two", binding("telegram", "chat-1")));
  const lease = store.acquireLease({ kind: "chat", contextId: "one" }, "claim");
  const start = store.reserveStart("one");
  assert.equal(start.submissionKind, "start");
  assert.equal(store.membersForAttempt(lease.attemptId)[0]?.state, "start_submitting");
  assert.equal(db.prepare("SELECT state FROM source_contexts WHERE id = 'one'").get()!.state, "active");
  assert.throws(() => store.reserveNextSteer(lease.attemptId), (error: unknown) => error instanceof AppError && error.code === "OPERATION_CONFLICT");

  store.markSubmitted(lease.attemptId, "one", "turn-1");
  const steer = store.reserveNextSteer(lease.attemptId);
  assert.equal(steer?.contextId, "two");
  assert.equal(steer?.submissionKind, "steer");
  assert.equal(db.prepare("SELECT state FROM source_contexts WHERE id = 'two'").get()!.state, "active");
  assert.throws(() => store.reserveNextSteer(lease.attemptId), (error: unknown) => error instanceof AppError && error.code === "OPERATION_CONFLICT");
});

test("start confirmation binds once and is idempotent across notification and response races", () => {
  const { db, store } = fixture();
  store.acceptChatSource(message("one", binding("telegram", "chat-1")));
  const lease = store.acquireLease({ kind: "chat", contextId: "one" }, "claim");
  store.reserveStart("one");

  assert.equal(store.confirmStart(lease.attemptId, "one", "turn-a"), "bound");
  assert.equal(store.confirmStart(lease.attemptId, "one", "turn-a"), "already_same");
  assert.equal(store.confirmStart(lease.attemptId, "one", "turn-b"), "conflict");
  assert.equal(store.lease()?.turnId, "turn-a");
  assert.equal(db.prepare("SELECT turn_id FROM assistant_attempts WHERE id = ?").get(lease.attemptId)!.turn_id, "turn-a");
  assert.equal(store.markUncertainIfUnresolved(lease.attemptId, "one"), false);
});

test("a late start-confirmation CAS miss rolls back every earlier write", () => {
  const { db, store } = fixture();
  store.acceptChatSource(message("one", binding("telegram", "chat-1")));
  const lease = store.acquireLease({ kind: "chat", contextId: "one" }, "claim");
  store.reserveStart("one");
  db.exec(`CREATE TRIGGER ignore_start_lease_update BEFORE UPDATE OF turn_id ON assistant_turn_lease
    BEGIN SELECT RAISE(IGNORE); END;`);

  assert.throws(() => store.confirmStart(lease.attemptId, "one", "turn-a"), /lease changed/iu);
  assert.equal(db.prepare("SELECT turn_id FROM assistant_attempts WHERE id = ?").get(lease.attemptId)!.turn_id, null);
  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources WHERE context_id = 'one'").get()!.state, "start_submitting");
  assert.deepEqual({ phase: store.lease()?.phase, turnId: store.lease()?.turnId }, { phase: "starting", turnId: undefined });
});

test("a correlated completion binds a starting lease directly into terminalizing", () => {
  const { store } = fixture();
  store.acceptChatSource(message("one", binding("telegram", "chat-1")));
  const lease = store.acquireLease({ kind: "chat", contextId: "one" }, "claim");
  store.reserveStart("one");

  assert.equal(store.confirmStart(lease.attemptId, "one", "turn-a", { terminal: true }), "bound");
  assert.deepEqual({ phase: store.lease()?.phase, turnId: store.lease()?.turnId }, { phase: "terminalizing", turnId: "turn-a" });
  assert.equal(store.confirmStart(lease.attemptId, "one", "turn-a"), "already_terminal_same");
  assert.equal(store.confirmStart(lease.attemptId, "one", "turn-b"), "conflict");
});

test("steer confirmation can only join the lease's immutable exact turn", () => {
  const { db, store } = fixture();
  for (const id of ["one", "two"]) store.acceptChatSource(message(id, binding("telegram", "chat-1")));
  const lease = store.acquireLease({ kind: "chat", contextId: "one" }, "claim");
  store.reserveStart("one");
  store.confirmStart(lease.attemptId, "one", "turn-a");
  store.reserveNextSteer(lease.attemptId);

  assert.equal(store.confirmSteer(lease.attemptId, "two", "turn-b"), "conflict");
  assert.equal(store.lease()?.turnId, "turn-a");
  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources WHERE context_id = 'two'").get()!.state, "steer_submitting");
  assert.equal(store.confirmSteer(lease.attemptId, "two", "turn-a"), "bound");
  assert.equal(store.confirmSteer(lease.attemptId, "two", "turn-a"), "already_same");
  assert.equal(db.prepare("SELECT turn_id FROM assistant_attempts WHERE id = ?").get(lease.attemptId)!.turn_id, "turn-a");
});

test("an uncertain exact steer confirmation reopens active steering", () => {
  const { store } = fixture();
  for (const id of ["one", "two", "three"]) store.acceptChatSource(message(id, binding("telegram", "chat-1")));
  const lease = store.acquireLease({ kind: "chat", contextId: "one" }, "claim");
  store.reserveStart("one");
  store.confirmStart(lease.attemptId, "one", "turn-a");
  store.reserveNextSteer(lease.attemptId);
  assert.equal(store.markUncertainIfUnresolved(lease.attemptId, "two"), true);
  assert.equal(store.lease()?.steerPaused, true);

  assert.equal(store.confirmSteer(lease.attemptId, "two", "turn-a"), "bound");
  assert.deepEqual({ paused: store.lease()?.steerPaused, reason: store.lease()?.pauseReason }, { paused: false, reason: undefined });
  assert.equal(store.reserveNextSteer(lease.attemptId)?.contextId, "three");
});

test("a late exact steer confirmation preserves terminal fencing and reports terminal disposition", () => {
  const { store } = fixture();
  for (const id of ["one", "two"]) store.acceptChatSource(message(id, binding("telegram", "chat-1")));
  const lease = store.acquireLease({ kind: "chat", contextId: "one" }, "claim");
  store.reserveStart("one");
  store.confirmStart(lease.attemptId, "one", "turn-a");
  store.reserveNextSteer(lease.attemptId);
  store.beginTerminalizing("turn-a");

  assert.equal(store.markUncertainIfUnresolved(lease.attemptId, "two"), true);
  assert.equal(store.lease()?.pauseReason, "terminalizing");
  assert.equal(store.confirmSteer(lease.attemptId, "two", "turn-a"), "already_terminal_same");
  assert.deepEqual({ phase: store.lease()?.phase, paused: store.lease()?.steerPaused, reason: store.lease()?.pauseReason }, {
    phase: "terminalizing", paused: true, reason: "terminalizing",
  });
});

test("uncertainty cannot mutate an unresolved member after its lease is gone", () => {
  const { db, store } = fixture();
  store.acceptChatSource(message("one", binding("telegram", "chat-1")));
  const lease = store.acquireLease({ kind: "chat", contextId: "one" }, "claim");
  store.reserveStart("one");
  db.prepare("DELETE FROM assistant_turn_lease WHERE singleton = 1").run();

  assert.equal(store.markUncertainIfUnresolved(lease.attemptId, "one"), false);
  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources WHERE context_id = 'one'").get()!.state, "start_submitting");
});

test("arrival order is unique and a source cannot belong to two live attempts", () => {
  const { db, store } = fixture();
  store.acceptChatSource(message("one", binding("telegram", "chat-1")));
  store.acceptChatSource(message("two", binding("telegram", "chat-1")));
  const rows = db.prepare("SELECT arrival_sequence FROM source_contexts ORDER BY arrival_sequence").all() as Array<{ arrival_sequence: number }>;
  assert.equal(new Set(rows.map((row) => row.arrival_sequence)).size, 2);
  const lease = store.acquireLease({ kind: "chat", contextId: "one" }, "claim");
  store.reserveStart("one");
  assert.throws(() => db.prepare(`INSERT INTO assistant_attempt_sources
    (attempt_id, context_id, source_ordinal, client_user_message_id, submission_kind, state, created_at, updated_at)
    VALUES (?, 'one', 2, 'duplicate', 'steer', 'submitted', 1, 1)`).run(lease.attemptId), /UNIQUE/u);
});

test("chat acceptance retains attachments exactly once and rolls source/checkpoint/retain back together", async () => {
  const db = createTestDatabase();
  const attachments = new AttachmentStore(db, await mkdtemp(join(tmpdir(), "conversation-ingress-")), { maxFileBytes: 100, maxStoreBytes: 1_000 });
  await attachments.initialize();
  const file = await attachments.ingest("with-file", Readable.from(["payload"]), { displayName: "a.txt", mediaType: "text/plain" });
  const deliveries = new DeliveryStore(db);
  const store = new ConversationStore(db, deliveries, attachments);
  store.acceptChatSource(message("with-file", binding("telegram", "chat-1"), [file.id]));
  store.acceptChatSource(message("with-file", binding("telegram", "chat-1"), [file.id]));
  assert.equal(db.prepare("SELECT ref_count FROM attachments WHERE id = ?").get(file.id)!.ref_count, 1);

  const rolledBack = await attachments.ingest("rollback", Readable.from(["x"]), { displayName: "b.txt", mediaType: "text/plain" });
  assert.throws(() => store.acceptChatSource(message("rollback", binding("telegram", "chat-1"), [rolledBack.id]), { commitNativeCheckpoint: () => { throw new Error("checkpoint failed"); } }), /checkpoint failed/u);
  assert.equal(db.prepare("SELECT id FROM source_contexts WHERE id = 'rollback'").get(), undefined);
  assert.equal(db.prepare("SELECT ref_count FROM attachments WHERE id = ?").get(rolledBack.id)!.ref_count, 0);
});

test("Slack acceptance preserves failed attachment metadata without changing owner text", () => {
  const db = createTestDatabase();
  const store = new ConversationStore(db, new DeliveryStore(db));
  const slack = { adapterId: "slack", conversationKey: "slack:T1:dm:D1", destination: { workspaceId: "T1", channelId: "D1" } } as const;
  const failedAttachments = [{ nativeId: "F1", displayName: "missing.txt", reasonCode: "not_accessible" }] as const;
  store.acceptChatSource({
    id: "slack-source",
    nativeSourceId: "T1:D1:1.0",
    binding: slack,
    rawText: "/pass exact",
    attachmentIds: [],
    failedAttachments,
    receivedAt: 1,
  });
  assert.equal(store.hasChatSource("slack", "T1:D1:1.0"), true);
  assert.equal(store.hasChatSource("slack", "missing"), false);
  const lease = store.acquireLease({ kind: "chat", contextId: "slack-source" }, "claim");
  const submission = store.reserveStart("slack-source");
  assert.equal(submission.rawText, "/pass exact");
  assert.deepEqual(submission.failedAttachments, failedAttachments);
  assert.equal(lease.binding?.adapterId, "slack");
  const row = db.prepare("SELECT kind, raw_text, failed_attachments_json FROM source_contexts WHERE id = 'slack-source'").get()!;
  assert.equal(row.kind, "slack");
  assert.equal(row.raw_text, "/pass exact");
  assert.deepEqual(JSON.parse(String(row.failed_attachments_json)), failedAttachments);
});

test("event materialization and lease acquisition are one CAS transaction", () => {
  const { db, store } = fixture();
  db.prepare("INSERT INTO events(id, endpoint_id, thread_id, kind, payload_json, state, created_at) VALUES ('e1', 'local', 'worker', 'terminal', '{}', 'pending', 1)").run();
  const candidate = { batchId: "batch:e1", eventIds: ["e1"], payload: [{ id: "e1" }], queuedAt: 1 };
  const lease = store.materializeAndAcquireEventBatch(candidate, "event-claim");
  assert.equal(lease.primaryContextId, "batch:e1");
  assert.equal(lease.binding, undefined);
  assert.equal(db.prepare("SELECT state FROM events WHERE id = 'e1'").get()!.state, "batched");
  assert.ok(db.prepare("SELECT id FROM event_batches WHERE id = 'batch:e1'").get());

  const other = fixture();
  other.db.prepare("INSERT INTO events(id, endpoint_id, thread_id, kind, payload_json, state, created_at) VALUES ('e2', 'local', 'worker', 'terminal', '{}', 'processed', 1)").run();
  assert.throws(() => other.store.materializeAndAcquireEventBatch({ batchId: "batch:e2", eventIds: ["e2"], payload: [], queuedAt: 1 }, "claim"), /changed/u);
  assert.equal(other.db.prepare("SELECT id FROM source_contexts WHERE id = 'batch:e2'").get(), undefined);
  assert.equal(other.store.lease(), undefined);
});
