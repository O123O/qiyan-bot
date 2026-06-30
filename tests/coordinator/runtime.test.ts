import assert from "node:assert/strict";
import test from "node:test";
import { CoordinatorRuntime } from "../../src/coordinator/runtime.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";

test("user coordinator finals are durable deliveries while internal finals are suppressed", () => {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "1", rawText: "question", attachmentIds: [] });
  operations.createSourceContext({ id: "batch", kind: "event_batch", sourceId: "b1", rawText: "", attachmentIds: [] });
  db.prepare("INSERT INTO events(id, endpoint_id, thread_id, kind, payload_json, state, created_at) VALUES ('batch-event', 'local', 'worker', 'terminal', '{}', 'pending', 1)").run();
  db.prepare("INSERT INTO event_batches(id, event_ids_json, state, created_at) VALUES ('batch', '[\"batch-event\"]', 'pending', 1)").run();
  const runtime = new CoordinatorRuntime(db, operations, deliveries, { destination: "42" });
  runtime.beginUserAttempt("ctx", "attempt", "turn-user");
  runtime.handleTerminal("turn-user", "answer");
  assert.equal((db.prepare("SELECT state FROM source_contexts WHERE id = 'ctx'").get() as any).state, "completed");
  runtime.beginInternalAttempt("batch", "attempt-2", "turn-internal");
  const restarted = new CoordinatorRuntime(db, operations, deliveries, { destination: "42" });
  restarted.handleTerminal("turn-internal", "do not send");
  assert.deepEqual(deliveries.listReady().map((item) => item.body), ["[coordinator] answer"]);
  assert.equal((db.prepare("SELECT state FROM events WHERE id = 'batch-event'").get() as any).state, "processed");
});

test("post-dispatch coordinator failure creates one recovery context with receipts", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "1", rawText: "go", attachmentIds: [] });
  const operation = operations.prepare({ contextId: "ctx", attemptId: "a", callId: "c", kind: "send", args: { x: 1 } });
  operations.markDispatched(operation.id);
  db.prepare("INSERT INTO events(id, endpoint_id, thread_id, kind, payload_json, state, created_at) VALUES ('event-1', 'local', 'worker', 'terminal', '{}', 'pending', 1)").run();
  db.prepare("INSERT INTO event_batches(id, event_ids_json, state, created_at) VALUES ('ctx', '[\"event-1\"]', 'active', 1)").run();
  const runtime = new CoordinatorRuntime(db, operations, new DeliveryStore(db), { destination: "42" });
  runtime.beginUserAttempt("ctx", "a", "turn");
  const first = runtime.failAttempt("turn", new Error("lost"));
  const replay = runtime.failAttempt("turn", new Error("lost"));
  assert.equal(first?.id, replay?.id);
  assert.equal(first?.kind, "recovery");
  assert.match(first?.rawText ?? "", /uncertain/);
  assert.equal((db.prepare("SELECT state FROM events WHERE id = 'event-1'").get() as any).state, "superseded");
  assert.equal((db.prepare("SELECT state FROM event_batches WHERE id = 'ctx'").get() as any).state, "superseded");
});

test("terminalization rolls back attempt and source state if final delivery preparation fails", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx-atomic", kind: "telegram", sourceId: "atomic", rawText: "question", attachmentIds: [] });
  const failingDeliveries = { prepare() { throw new Error("outbox failed"); } } as unknown as DeliveryStore;
  const runtime = new CoordinatorRuntime(db, operations, failingDeliveries, { destination: "42" });
  runtime.beginUserAttempt("ctx-atomic", "attempt-atomic", "turn-atomic");
  assert.throws(() => runtime.handleTerminal("turn-atomic", "answer"), /outbox failed/);
  assert.equal((db.prepare("SELECT state FROM coordinator_attempts WHERE id = 'attempt-atomic'").get() as any).state, "active");
  assert.equal((db.prepare("SELECT state FROM source_contexts WHERE id = 'ctx-atomic'").get() as any).state, "active");
});

test("failed-attempt terminalization rolls back if recovery creation fails", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx-fail-atomic", kind: "telegram", sourceId: "fail-atomic", rawText: "", attachmentIds: [] });
  const runtime = new CoordinatorRuntime(db, operations, new DeliveryStore(db), { destination: "42" });
  runtime.beginUserAttempt("ctx-fail-atomic", "attempt-fail-atomic", "turn-fail-atomic");
  const operation = operations.prepare({ contextId: "ctx-fail-atomic", attemptId: "attempt-fail-atomic", callId: "call", kind: "send", args: {} });
  operations.markDispatched(operation.id);
  (operations as any).supersedeWithRecoveryInTransaction = () => { throw new Error("recovery insert failed"); };
  assert.throws(() => runtime.failAttempt("turn-fail-atomic", "failed"), /recovery insert failed/);
  assert.equal((db.prepare("SELECT state FROM coordinator_attempts WHERE id = 'attempt-fail-atomic'").get() as any).state, "active");
  assert.equal((db.prepare("SELECT state FROM source_contexts WHERE id = 'ctx-fail-atomic'").get() as any).state, "active");
});

test("source attachment retention is released exactly once at terminalization", () => {
  const db = createTestDatabase();
  db.prepare(`INSERT INTO attachments(id, scope_id, display_name, media_type, local_path, size, sha256, ref_count, expires_at, created_at)
    VALUES ('file-one', 'ctx-file', 'a', 'text/plain', '/tmp/a', 1, 'x', 1, 999, 1)`).run();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx-file", kind: "telegram", sourceId: "file", rawText: "", attachmentIds: ["file-one"] });
  const runtime = new CoordinatorRuntime(db, operations, new DeliveryStore(db), { destination: "42" });
  runtime.beginUserAttempt("ctx-file", "attempt-file", "turn-file");
  runtime.handleTerminal("turn-file");
  runtime.handleTerminal("turn-file");
  assert.equal((db.prepare("SELECT ref_count FROM attachments WHERE id = 'file-one'").get() as any).ref_count, 0);
});

test("coordinator context exists before turn/start dispatch and later binds the real turn id", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "4", rawText: "go", attachmentIds: [] });
  const runtime = new CoordinatorRuntime(db, operations, new DeliveryStore(db), { destination: "1" });
  runtime.prepareAttempt("ctx", "attempt", "user");
  assert.equal(runtime.current()?.turnId, "pending:attempt");
  assert.deepEqual(operations.listPendingSourceContexts(["telegram"]), []);
  runtime.bindTurn("attempt", "real-turn");
  assert.equal(runtime.current()?.turnId, "real-turn");
  runtime.abandonActive("real-turn");
  assert.equal(runtime.current(), undefined);
  assert.equal(runtime.activeAttempts()[0]?.turnId, "real-turn", "transport loss keeps the durable attempt active for reconciliation");
});

test("successful read-only tools do not force a recovery context after a failed attempt", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx-read", kind: "telegram", sourceId: "3", rawText: "status", attachmentIds: [] });
  const runtime = new CoordinatorRuntime(db, operations, new DeliveryStore(db), { destination: "chat" });
  runtime.beginUserAttempt("ctx-read", "a-read", "t-read");
  const operation = operations.prepare({ contextId: "ctx-read", attemptId: "a-read", callId: "c", kind: "get_session_status", args: {} });
  operations.succeed(operation.id, { status: "idle" });
  assert.equal(runtime.failAttempt("t-read", "model failed"), undefined);
});
