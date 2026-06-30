import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "../../src/storage/database.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";

test("an identical operation replay returns its stored receipt", () => {
  const db = createTestDatabase();
  const store = new OperationStore(db);
  const first = store.prepare({ contextId: "ctx", attemptId: "a1", callId: "c1", kind: "send", args: { text: "x" } });
  store.markDispatched(first.id);
  store.succeed(first.id, { turnId: "turn-1" });

  const replay = store.prepare({ contextId: "ctx", attemptId: "a1", callId: "c1", kind: "send", args: { text: "x" } });
  assert.equal(replay.state, "succeeded");
  assert.deepEqual(replay.receipt, { turnId: "turn-1" });
});

test("changing arguments for an existing operation is rejected", () => {
  const db = createTestDatabase();
  const store = new OperationStore(db);
  store.prepare({ contextId: "ctx", attemptId: "a1", callId: "c1", kind: "send", args: { text: "x" } });

  assert.throws(
    () => store.prepare({ contextId: "ctx", attemptId: "a1", callId: "c1", kind: "send", args: { text: "y" } }),
    (error: unknown) => error instanceof Error && error.message.includes("OPERATION_CONFLICT"),
  );
});

test("a context with dispatched effects is atomically superseded once", () => {
  const db = createTestDatabase();
  const store = new OperationStore(db);
  store.createSourceContext({ id: "ctx", kind: "event_batch", sourceId: "batch", rawText: "", attachmentIds: [] });
  const operation = store.prepare({ contextId: "ctx", attemptId: "a1", callId: "c1", kind: "send", args: {} });
  store.markDispatched(operation.id);

  const recovery = store.supersedeWithRecovery("ctx", [{ operationId: operation.id, state: "uncertain" }]);
  const replay = store.supersedeWithRecovery("ctx", [{ operationId: operation.id, state: "uncertain" }]);
  assert.equal(recovery.id, replay.id);
  assert.equal(store.getSourceContext("ctx")?.supersededBy, recovery.id);
});

test("pending Telegram and recovery contexts survive process-local queue loss", () => {
  const store = new OperationStore(createTestDatabase());
  store.createSourceContext({ id: "telegram-1", kind: "telegram", sourceId: "1", rawText: "hello", attachmentIds: [] });
  store.createSourceContext({ id: "recovery-1", kind: "recovery", sourceId: "telegram-1", rawText: "[]", attachmentIds: [] });
  store.createSourceContext({ id: "event-1", kind: "event_batch", sourceId: "batch", rawText: "[]", attachmentIds: [] });
  store.setSourceState("telegram-1", "completed");

  assert.deepEqual(store.listPendingSourceContexts(["telegram", "recovery"]).map((context) => context.id), ["recovery-1"]);
});

test("recoverable operations retain their canonical arguments and stable call identity", () => {
  const store = new OperationStore(createTestDatabase());
  const operation = store.prepare({ contextId: "ctx", attemptId: "attempt", callId: "call", kind: "send_chat_message", args: { content: "hello" } });
  store.markDispatched(operation.id);
  assert.deepEqual(store.listRecoverable().map(({ contextId, attemptId, callId, kind, args, state }) => ({ contextId, attemptId, callId, kind, args, state })), [{
    contextId: "ctx", attemptId: "attempt", callId: "call", kind: "send_chat_message", args: { content: "hello" }, state: "dispatched",
  }]);
});

test("failing an operation and releasing its directive are one transaction", () => {
  const db = createTestDatabase();
  const store = new OperationStore(db);
  store.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "1", rawText: "/pass exact", attachmentIds: [] });
  const operation = store.prepare({ contextId: "ctx", attemptId: "attempt", callId: "call", kind: "send_to_session", args: { content: "exact" } });
  store.markDispatched(operation.id);
  store.bindDirective("ctx", "pass", { content: "exact" }, operation.id);
  db.exec(`CREATE TRIGGER fail_directive_release BEFORE DELETE ON directive_consumptions
    BEGIN SELECT RAISE(ABORT, 'release failed'); END;`);
  assert.throws(() => store.failAndUnbind(operation.id, { message: "no effect" }), /release failed/);
  assert.equal(store.get(operation.id)?.state, "dispatched");
  assert.ok(store.replayDirective("ctx", "pass", { content: "exact" }));
  db.exec("DROP TRIGGER fail_directive_release");
  store.failAndUnbind(operation.id, { message: "no effect" });
  assert.equal(store.get(operation.id)?.state, "failed");
  assert.equal(store.replayDirective("ctx", "pass", { content: "exact" }), undefined);
});
