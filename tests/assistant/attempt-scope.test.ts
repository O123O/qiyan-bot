import assert from "node:assert/strict";
import test from "node:test";
import { AttemptScope } from "../../src/assistant/attempt-scope.ts";
import { AppError } from "../../src/core/errors.ts";
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";

const binding = { adapterId: "telegram", conversationKey: "telegram:chat", destination: { chatId: "chat" } } as const;

function fixture() {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const conversations = new ConversationStore(db, new DeliveryStore(db));
  const accept = (id: string, rawText: string, attachmentIds: readonly string[] = []) => conversations.acceptChatSource({
    id,
    nativeSourceId: `native:${id}`,
    binding,
    rawText,
    attachmentIds,
    receivedAt: 1,
  });
  accept("primary", "ordinary");
  accept("pass-one", "/pass first", ["file-one"]);
  accept("pass-two", "/pass second");
  accept("collect-one", "/collect 2");
  accept("collect-two", "/collect 3");
  const lease = conversations.createAttempt({ kind: "chat", contextId: "primary" });
  conversations.reserveStart(lease.attemptId, "primary");
  conversations.markSubmitted(lease.attemptId, "primary", "turn");
  const scope = new AttemptScope(db, operations, { maxCollectCount: 20 });
  return { db, operations, conversations, lease, scope };
}

function admitNext(value: ReturnType<typeof fixture>, submit = true) {
  const reserved = value.conversations.reserveNextSteer(value.lease.attemptId)!;
  if (submit) {
    value.conversations.markSubmitted(value.lease.attemptId, reserved.contextId, "turn");
    value.scope.notifyMembership(reserved.contextId);
  }
  return reserved;
}

test("a safeguard waits for native admission and then binds exact source scope", async () => {
  const value = fixture();
  admitNext(value); // pass-one
  const pending = admitNext(value, false); // pass-two
  let settled = false;
  const resolving = value.scope.resolveSafeguard({
    attemptId: value.lease.attemptId,
    callId: "call-two",
    tool: "send_to_session",
    args: { nickname: "worker", content: "first", attachment_ids: ["file-one"], mode: "start" },
  }).then((result) => { settled = true; return result; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, true, "the first already-submitted safeguard remains FIFO head");
  const first = await resolving;
  assert.equal(first.effectiveSourceContextId, "pass-one");

  const waiting = value.scope.resolveSafeguard({
    attemptId: value.lease.attemptId,
    callId: "call-next",
    tool: "send_to_session",
    args: { nickname: "worker", content: "second", attachment_ids: [], mode: "steer" },
  });
  settled = false;
  void waiting.then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  value.conversations.markSubmitted(value.lease.attemptId, pending.contextId, "turn");
  value.scope.notifyMembership(pending.contextId);
  assert.equal((await waiting).effectiveSourceContextId, "pass-two");
});

test("safeguards consume FIFO, replay by call ID, and reject mismatch or exhaustion", async () => {
  const value = fixture();
  admitNext(value);
  admitNext(value);
  const args = { nickname: "worker", content: "first", attachment_ids: ["file-one"], mode: "start" };
  const first = await value.scope.resolveSafeguard({ attemptId: value.lease.attemptId, callId: "one", tool: "send_to_session", args });
  const replay = await value.scope.resolveSafeguard({ attemptId: value.lease.attemptId, callId: "one", tool: "send_to_session", args });
  assert.equal(replay.operation.id, first.operation.id);
  assert.equal(replay.replay, true);
  await assert.rejects(
    value.scope.resolveSafeguard({ attemptId: value.lease.attemptId, callId: "two", tool: "send_to_session", args: { ...args, content: "translated" } }),
    (error: unknown) => error instanceof AppError && error.code === "DIRECTIVE_MISMATCH",
  );
  const second = await value.scope.resolveSafeguard({ attemptId: value.lease.attemptId, callId: "two", tool: "send_to_session", args: { ...args, content: "second", attachment_ids: [], mode: "steer" } });
  assert.equal(second.effectiveSourceContextId, "pass-two");
  await assert.rejects(
    value.scope.resolveSafeguard({ attemptId: value.lease.attemptId, callId: "three", tool: "send_to_session", args }),
    (error: unknown) => error instanceof AppError && error.code === "DIRECTIVE_ALREADY_CONSUMED",
  );
});

test("pass rejects a failed attachment on its matched directive source", async () => {
  const value = fixture();
  value.db.prepare("UPDATE source_contexts SET failed_attachments_json = ? WHERE id = 'pass-one'")
    .run(JSON.stringify([{ nativeId: "F1", displayName: "missing.txt", reasonCode: "not_accessible" }]));
  admitNext(value);
  await assert.rejects(
    value.scope.resolveSafeguard({
      attemptId: value.lease.attemptId,
      callId: "failed-pass",
      tool: "send_to_session",
      args: { nickname: "worker", content: "first", attachment_ids: ["file-one"], mode: "start" },
    }),
    (error: unknown) => error instanceof AppError && error.code === "ATTACHMENT_INVALID",
  );
  assert.equal(value.operations.listForAttempt(value.lease.attemptId).length, 0);
});

test("an unrelated failed attachment does not invalidate another source's pass", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const conversations = new ConversationStore(db, new DeliveryStore(db));
  for (const source of [
    { id: "primary", rawText: "ordinary", failedAttachments: [] },
    { id: "failed-ordinary", rawText: "also ordinary", failedAttachments: [{ nativeId: "F1", displayName: "missing.txt", reasonCode: "not_accessible" }] },
    { id: "valid-pass", rawText: "/pass exact", failedAttachments: [] },
  ]) conversations.acceptChatSource({ ...source, nativeSourceId: `native:${source.id}`, binding, attachmentIds: [], receivedAt: 1 });
  const lease = conversations.createAttempt({ kind: "chat", contextId: "primary" });
  conversations.reserveStart(lease.attemptId, "primary");
  conversations.markSubmitted(lease.attemptId, "primary", "turn");
  const failed = conversations.reserveNextSteer(lease.attemptId)!;
  conversations.markSubmitted(lease.attemptId, failed.contextId, "turn");
  const valid = conversations.reserveNextSteer(lease.attemptId)!;
  conversations.markSubmitted(lease.attemptId, valid.contextId, "turn");
  const scope = new AttemptScope(db, operations, { maxCollectCount: 20 });
  const resolved = await scope.resolveSafeguard({
    attemptId: lease.attemptId,
    callId: "valid-pass",
    tool: "send_to_session",
    args: { nickname: "worker", content: "exact", attachment_ids: [], mode: "steer" },
  });
  assert.equal(resolved.effectiveSourceContextId, "valid-pass");
});

test("proven no-effect release allows the same safeguard to be consumed by a new call", async () => {
  const value = fixture();
  admitNext(value);
  const input = { attemptId: value.lease.attemptId, callId: "first", tool: "send_to_session" as const, args: { nickname: "worker", content: "first", attachment_ids: ["file-one"], mode: "start" } };
  const first = await value.scope.resolveSafeguard(input);
  first.releaseConsumptionOnNoEffect();
  const second = await value.scope.resolveSafeguard({ ...input, callId: "second" });
  assert.equal(second.effectiveSourceContextId, "pass-one");
});

test("collect safeguards are ordinary admitted messages with distinct operation identities", async () => {
  const value = fixture();
  for (let index = 0; index < 4; index += 1) admitNext(value);
  // Consume pass messages first; safeguard order is the admitted message order.
  await value.scope.resolveSafeguard({ attemptId: value.lease.attemptId, callId: "p1", tool: "send_to_session", args: { nickname: "w", content: "first", attachment_ids: ["file-one"], mode: "start" } });
  await value.scope.resolveSafeguard({ attemptId: value.lease.attemptId, callId: "p2", tool: "send_to_session", args: { nickname: "w", content: "second", attachment_ids: [], mode: "steer" } });
  const one = await value.scope.resolveSafeguard({ attemptId: value.lease.attemptId, callId: "c1", tool: "collect_messages", args: { nickname: "w", count: 2 } });
  const two = await value.scope.resolveSafeguard({ attemptId: value.lease.attemptId, callId: "c2", tool: "collect_messages", args: { nickname: "w", count: 3 } });
  assert.notEqual(one.operation.id, two.operation.id);
  assert.equal(one.effectiveSourceContextId, "collect-one");
  assert.equal(two.effectiveSourceContextId, "collect-two");
});

test("malformed admitted safeguard blocks fallback and restored pending rejects waiters", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const conversations = new ConversationStore(db, new DeliveryStore(db));
  for (const [id, rawText] of [["primary", "ordinary"], ["bad", "/pass\tchanged"]] as const) conversations.acceptChatSource({ id, nativeSourceId: id, binding, rawText, attachmentIds: [], receivedAt: 1 });
  const lease = conversations.createAttempt({ kind: "chat", contextId: "primary" });
  conversations.reserveStart(lease.attemptId, "primary");
  conversations.markSubmitted(lease.attemptId, "primary", "turn");
  const reserved = conversations.reserveNextSteer(lease.attemptId)!;
  const scope = new AttemptScope(db, operations, { maxCollectCount: 20 });
  await assert.rejects(scope.resolveSafeguard({ attemptId: lease.attemptId, callId: "bad", tool: "send_to_session", args: { nickname: "w", content: "changed", attachment_ids: [], mode: "steer" } }), (error: unknown) => error instanceof AppError && error.code === "DIRECTIVE_MISMATCH");
  conversations.restorePending(lease.attemptId, reserved.contextId);
  scope.notifyMembership(reserved.contextId);
  await assert.rejects(scope.waitUntilSubmitted(lease.attemptId, reserved.contextId), /not admitted|restored/u);
});

test("a directive steer proven absent no longer governs fresh tool calls in the old turn", async () => {
  const value = fixture();
  const absent = admitNext(value, false);
  value.conversations.restorePending(value.lease.attemptId, absent.contextId);
  value.scope.notifyMembership(absent.contextId);

  const resolved = await value.scope.resolveSafeguard({
    attemptId: value.lease.attemptId,
    callId: "ordinary-after-absence",
    tool: "send_to_session",
    args: { nickname: "worker", content: "new work", attachment_ids: [], mode: "steer" },
  });
  assert.equal(resolved.effectiveSourceContextId, "primary");
  assert.equal(resolved.directiveKind, undefined);
  assert.equal(resolved.operation.contextId, "primary");
});

test("concurrent retries of one call ID consume one safeguard and replay one operation", async () => {
  const value = fixture();
  admitNext(value);
  admitNext(value);
  const input = {
    attemptId: value.lease.attemptId,
    callId: "same-call",
    tool: "send_to_session" as const,
    args: { nickname: "worker", content: "first", attachment_ids: ["file-one"], mode: "start" },
  };
  const [left, right] = await Promise.all([value.scope.resolveSafeguard(input), value.scope.resolveSafeguard(input)]);
  assert.equal(left.operation.id, right.operation.id);
  assert.equal(value.operations.listForAttempt(value.lease.attemptId).filter((operation) => operation.callId === "same-call").length, 1);
  assert.equal(value.db.prepare("SELECT COUNT(*) AS n FROM directive_consumptions").get()!.n, 1);
});

test("an attachment-bearing steer waits for positive native admission before dispatch", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const conversations = new ConversationStore(db, new DeliveryStore(db));
  conversations.acceptChatSource({ id: "owner", nativeSourceId: "owner", binding, rawText: "owner", attachmentIds: [], receivedAt: 1 });
  conversations.acceptChatSource({ id: "with-file", nativeSourceId: "with-file", binding, rawText: "ordinary follow-up", attachmentIds: ["file"], receivedAt: 2 });
  const lease = conversations.createAttempt({ kind: "chat", contextId: "owner" });
  conversations.reserveStart(lease.attemptId, "owner");
  conversations.markSubmitted(lease.attemptId, "owner", "turn");
  const pending = conversations.reserveNextSteer(lease.attemptId)!;
  const scope = new AttemptScope(db, operations, { maxCollectCount: 20 });
  let settled = false;
  const resolving = scope.resolveSafeguard({
    attemptId: lease.attemptId,
    callId: "send-file",
    tool: "send_to_session",
    args: { nickname: "worker", content: "work", attachment_ids: ["file"], mode: "steer" },
  }).then((value) => { settled = true; return value; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  conversations.markSubmitted(lease.attemptId, pending.contextId, "turn");
  scope.notifyMembership(pending.contextId);
  await resolving;
  assert.deepEqual(scope.resolveAttachment(lease.attemptId, "file"), { contextId: "with-file", attachmentId: "file" });
});

test("an attachment-bearing steer proven absent rejects before preparing an operation", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const conversations = new ConversationStore(db, new DeliveryStore(db));
  conversations.acceptChatSource({ id: "owner", nativeSourceId: "owner", binding, rawText: "owner", attachmentIds: [], receivedAt: 1 });
  conversations.acceptChatSource({ id: "with-file", nativeSourceId: "with-file", binding, rawText: "ordinary follow-up", attachmentIds: ["file"], receivedAt: 2 });
  const lease = conversations.createAttempt({ kind: "chat", contextId: "owner" });
  conversations.reserveStart(lease.attemptId, "owner");
  conversations.markSubmitted(lease.attemptId, "owner", "turn");
  const pending = conversations.reserveNextSteer(lease.attemptId)!;
  const scope = new AttemptScope(db, operations, { maxCollectCount: 20 });
  const resolving = scope.resolveSafeguard({
    attemptId: lease.attemptId,
    callId: "send-file",
    tool: "send_to_session",
    args: { nickname: "worker", content: "work", attachment_ids: ["file"], mode: "steer" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  conversations.restorePending(lease.attemptId, pending.contextId);
  scope.notifyMembership(pending.contextId);
  await assert.rejects(resolving, /not admitted|restored/u);
  assert.equal(operations.listForAttempt(lease.attemptId).length, 0);
  assert.throws(() => scope.resolveAttachment(lease.attemptId, "file"), (error: unknown) => error instanceof AppError && error.code === "ATTACHMENT_INVALID");
});
