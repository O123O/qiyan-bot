import assert from "node:assert/strict";
import test from "node:test";
import { AssistantRuntime, classifyAttemptEffects } from "../../src/assistant/runtime.ts";
import { createAssistantTools } from "../../src/assistant/tools.ts";
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";

const binding = { adapterId: "telegram", conversationKey: "telegram:42", destination: { chatId: "42" } } as const;

test("user assistant finals are durable deliveries while internal finals are suppressed", () => {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "1", rawText: "question", attachmentIds: [] });
  operations.createSourceContext({ id: "batch", kind: "event_batch", sourceId: "b1", rawText: "", attachmentIds: [] });
  db.prepare("INSERT INTO events(id, endpoint_id, thread_id, kind, payload_json, state, created_at) VALUES ('batch-event', 'local', 'worker', 'terminal', '{}', 'pending', 1)").run();
  db.prepare("INSERT INTO event_batches(id, event_ids_json, state, created_at) VALUES ('batch', '[\"batch-event\"]', 'pending', 1)").run();
  const runtime = new AssistantRuntime(db, operations, deliveries, { binding });
  runtime.beginUserAttempt("ctx", "attempt", "turn-user");
  runtime.handleTerminal("turn-user", "answer");
  assert.equal((db.prepare("SELECT state FROM source_contexts WHERE id = 'ctx'").get() as any).state, "completed");
  runtime.beginInternalAttempt("batch", "attempt-2", "turn-internal");
  const restarted = new AssistantRuntime(db, operations, deliveries, { binding });
  restarted.handleTerminal("turn-internal", "do not send");
  assert.deepEqual(deliveries.listReady().map((item) => item.body), ["answer"]);
  assert.equal((db.prepare("SELECT state FROM events WHERE id = 'batch-event'").get() as any).state, "processed");
});

test("post-dispatch assistant failure creates one recovery context with receipts", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "1", rawText: "go", attachmentIds: [] });
  const operation = operations.prepare({ contextId: "ctx", attemptId: "a", callId: "c", kind: "send", args: { x: 1 } });
  operations.markDispatched(operation.id);
  db.prepare("INSERT INTO events(id, endpoint_id, thread_id, kind, payload_json, state, created_at) VALUES ('event-1', 'local', 'worker', 'terminal', '{}', 'pending', 1)").run();
  db.prepare("INSERT INTO event_batches(id, event_ids_json, state, created_at) VALUES ('ctx', '[\"event-1\"]', 'active', 1)").run();
  const runtime = new AssistantRuntime(db, operations, new DeliveryStore(db), { binding });
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
  const runtime = new AssistantRuntime(db, operations, failingDeliveries, { binding });
  runtime.beginUserAttempt("ctx-atomic", "attempt-atomic", "turn-atomic");
  assert.throws(() => runtime.handleTerminal("turn-atomic", "answer"), /outbox failed/);
  assert.equal((db.prepare("SELECT state FROM assistant_attempts WHERE id = 'attempt-atomic'").get() as any).state, "active");
  assert.equal((db.prepare("SELECT state FROM source_contexts WHERE id = 'ctx-atomic'").get() as any).state, "active");
});

test("failed-attempt terminalization rolls back if recovery creation fails", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx-fail-atomic", kind: "telegram", sourceId: "fail-atomic", rawText: "", attachmentIds: [] });
  const runtime = new AssistantRuntime(db, operations, new DeliveryStore(db), { binding });
  runtime.beginUserAttempt("ctx-fail-atomic", "attempt-fail-atomic", "turn-fail-atomic");
  const operation = operations.prepare({ contextId: "ctx-fail-atomic", attemptId: "attempt-fail-atomic", callId: "call", kind: "send", args: {} });
  operations.markDispatched(operation.id);
  db.exec(`CREATE TRIGGER fail_recovery_insert BEFORE INSERT ON source_contexts WHEN NEW.kind = 'recovery'
    BEGIN SELECT RAISE(ABORT, 'recovery insert failed'); END;`);
  assert.throws(() => runtime.failAttempt("turn-fail-atomic", "failed"), /recovery insert failed/);
  assert.equal((db.prepare("SELECT state FROM assistant_attempts WHERE id = 'attempt-fail-atomic'").get() as any).state, "active");
  assert.equal((db.prepare("SELECT state FROM source_contexts WHERE id = 'ctx-fail-atomic'").get() as any).state, "active");
});

test("source attachment retention is released exactly once at terminalization", () => {
  const db = createTestDatabase();
  db.prepare(`INSERT INTO attachments(id, scope_id, display_name, media_type, local_path, size, sha256, ref_count, expires_at, created_at)
    VALUES ('file-one', 'ctx-file', 'a', 'text/plain', '/tmp/a', 1, 'x', 1, 999, 1)`).run();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx-file", kind: "telegram", sourceId: "file", rawText: "", attachmentIds: ["file-one"] });
  const runtime = new AssistantRuntime(db, operations, new DeliveryStore(db), { binding });
  runtime.beginUserAttempt("ctx-file", "attempt-file", "turn-file");
  runtime.handleTerminal("turn-file");
  runtime.handleTerminal("turn-file");
  assert.equal((db.prepare("SELECT ref_count FROM attachments WHERE id = 'file-one'").get() as any).ref_count, 0);
});

test("assistant context exists before turn/start dispatch and later binds the real turn id", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "4", rawText: "go", attachmentIds: [] });
  const runtime = new AssistantRuntime(db, operations, new DeliveryStore(db), { binding });
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
  const runtime = new AssistantRuntime(db, operations, new DeliveryStore(db), { binding });
  runtime.beginUserAttempt("ctx-read", "a-read", "t-read");
  const operation = operations.prepare({ contextId: "ctx-read", attemptId: "a-read", callId: "c", kind: "get_session_status", args: {} });
  operations.succeed(operation.id, { status: "idle" });
  assert.equal(runtime.failAttempt("t-read", "model failed"), undefined);
});

function multiSourceAttempt() {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const deliveries = new DeliveryStore(db);
  const conversations = new ConversationStore(db, deliveries);
  for (const id of ["one", "two"]) {
    conversations.acceptChatSource({
      id,
      nativeSourceId: `native:${id}`,
      binding,
      rawText: id,
      attachmentIds: [],
      receivedAt: 1,
    });
  }
  const lease = conversations.acquireLease({ kind: "chat", contextId: "one" }, "claim");
  conversations.reserveStart("one");
  conversations.markSubmitted(lease.attemptId, "one", "turn");
  conversations.reserveNextSteer(lease.attemptId);
  conversations.markSubmitted(lease.attemptId, "two", "turn");
  const runtime = new AssistantRuntime(db, operations, deliveries, { binding });
  runtime.hydrateActive();
  return { db, operations, deliveries, conversations, lease, runtime };
}

test("multi-source completion terminalizes and releases every admitted source", () => {
  const { db, runtime } = multiSourceAttempt();
  for (const id of ["one", "two"]) {
    db.prepare(`INSERT INTO attachments(id, scope_id, display_name, media_type, local_path, size, sha256, ref_count, expires_at, created_at)
      VALUES (?, ?, 'x', 'text/plain', '/tmp/x', 1, 'x', 1, 999, 1)`).run(`file-${id}`, id);
    db.prepare("UPDATE source_contexts SET attachment_ids_json = ? WHERE id = ?").run(JSON.stringify([`file-${id}`]), id);
  }
  runtime.handleTerminal("turn", "completed", "done");
  assert.deepEqual((db.prepare("SELECT id, state FROM source_contexts ORDER BY id").all() as any[]).map((row) => [row.id, row.state]), [["one", "completed"], ["two", "completed"]]);
  assert.deepEqual((db.prepare("SELECT context_id, state FROM assistant_attempt_sources ORDER BY source_ordinal").all() as any[]).map((row) => [row.context_id, row.state]), [["one", "completed"], ["two", "completed"]]);
  assert.deepEqual((db.prepare("SELECT ref_count FROM attachments ORDER BY id").all() as any[]).map((row) => row.ref_count), [0, 0]);
});

test("effect-free multi-source failure restores every source without releasing attachments", () => {
  const { db, runtime } = multiSourceAttempt();
  db.prepare(`INSERT INTO attachments(id, scope_id, display_name, media_type, local_path, size, sha256, ref_count, expires_at, created_at)
    VALUES ('file-one', 'one', 'x', 'text/plain', '/tmp/x', 1, 'x', 1, 999, 1)`).run();
  db.prepare("UPDATE source_contexts SET attachment_ids_json = '[\"file-one\"]' WHERE id = 'one'").run();
  const result = runtime.handleTerminal("turn", "failed", undefined, new Error("model failed"));
  assert.deepEqual(result, {});
  assert.deepEqual((db.prepare("SELECT state FROM source_contexts ORDER BY id").all() as any[]).map((row) => row.state), ["pending", "pending"]);
  assert.equal(db.prepare("SELECT ref_count FROM attachments WHERE id = 'file-one'").get()!.ref_count, 1);
});

test("effectful multi-source failure creates one inherited-route recovery and supersedes the group", () => {
  const { db, operations, lease, runtime } = multiSourceAttempt();
  const operation = operations.prepare({ contextId: "two", attemptId: lease.attemptId, callId: "send", kind: "send_chat_message", args: {}, effectClass: "side_effecting", toolFence: 0 });
  operations.markDispatched(operation.id, 0);
  const result = runtime.handleTerminal("turn", "failed", undefined, new Error("lost"));
  assert.ok(result.recoveryContextId);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_contexts WHERE kind = 'recovery'").get()!.n, 1);
  assert.deepEqual((db.prepare("SELECT state FROM source_contexts WHERE id IN ('one','two') ORDER BY id").all() as any[]).map((row) => row.state), ["superseded", "superseded"]);
  assert.equal(db.prepare("SELECT conversation_key FROM source_contexts WHERE id = ?").get(result.recoveryContextId!)!.conversation_key, binding.conversationKey);
});

test("attempt effect classification is explicit and conservative", () => {
  for (const row of [
    { effectClass: "side_effecting", state: "prepared", effectful: false },
    { effectClass: "side_effecting", state: "failed", effectful: false },
    { effectClass: "read_only", state: "succeeded", effectful: false },
    { effectClass: "side_effecting", state: "dispatched", effectful: true },
    { effectClass: "side_effecting", state: "uncertain", effectful: true },
    { effectClass: "side_effecting", state: "succeeded", effectful: true },
  ] as const) assert.equal(classifyAttemptEffects([row]), row.effectful);
});

test("terminal tool fencing rejects new dispatch and prevents late success from overwriting uncertainty", async () => {
  const { operations, lease, runtime } = multiSourceAttempt();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const tools = createAssistantTools(operations, {
    send_to_session: async () => { await blocked; return { turnId: "worker" }; },
  }, { maxCollectCount: 20 });
  const toolFence = runtime.registerTool(lease.attemptId);
  const call = tools.send_to_session({ sourceContextId: "one", attemptId: lease.attemptId, turnId: "turn", callId: "held", toolFence }, {
    nickname: "worker", content: "work", attachment_ids: [], mode: "start",
  }).finally(() => runtime.finishTool(lease.attemptId));
  await new Promise<void>((resolve) => setImmediate(resolve));
  runtime.beginTerminalizing("turn");
  await runtime.fenceTools(lease.attemptId, 1);
  assert.throws(() => runtime.registerTool(lease.attemptId), /terminal/u);
  release();
  await assert.rejects(call, /uncertain|terminal/u);
  const operation = operations.listForAttempt(lease.attemptId).find((item) => item.callId === "held")!;
  assert.equal(operation.state, "uncertain");
  assert.equal(operation.receipt, undefined);
});
