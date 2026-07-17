import assert from "node:assert/strict";
import test from "node:test";
import { AssistantRuntime, classifyAttemptEffects } from "../../src/assistant/runtime.ts";
import { createAssistantTools } from "../../src/assistant/tools.ts";
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";

const binding = { adapterId: "telegram", conversationKey: "telegram:42", destination: { chatId: "42" } } as const;

function submittedAttempt(
  db: ReturnType<typeof createTestDatabase>,
  deliveries: DeliveryStore,
  contextId: string,
  kind: "chat" | "internal",
  turnId: string,
) {
  const conversations = new ConversationStore(db, deliveries);
  const attempt = conversations.createAttempt({ kind, contextId });
  conversations.reserveStart(attempt.attemptId, contextId);
  conversations.confirmStart(attempt.attemptId, contextId, turnId);
  return attempt;
}

test("user assistant finals are durable deliveries while internal finals are suppressed", () => {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "1", rawText: "question", attachmentIds: [], binding });
  operations.createSourceContext({ id: "batch", kind: "event_batch", sourceId: "b1", rawText: "", attachmentIds: [] });
  db.prepare("INSERT INTO events(id, endpoint_id, thread_id, kind, payload_json, state, created_at) VALUES ('batch-event', 'local', 'worker', 'terminal', '{}', 'pending', 1)").run();
  db.prepare("INSERT INTO event_batches(id, event_ids_json, state, created_at) VALUES ('batch', '[\"batch-event\"]', 'pending', 1)").run();
  const runtime = new AssistantRuntime(db, operations, deliveries, { binding });
  submittedAttempt(db, deliveries, "ctx", "chat", "turn-user");
  runtime.handleTerminal("turn-user", "answer");
  assert.equal((db.prepare("SELECT state FROM source_contexts WHERE id = 'ctx'").get() as any).state, "completed");
  submittedAttempt(db, deliveries, "batch", "internal", "turn-internal");
  const restarted = new AssistantRuntime(db, operations, deliveries, { binding });
  restarted.handleTerminal("turn-internal", "do not send");
  assert.deepEqual(deliveries.listReady().map((item) => item.body), ["answer"]);
  assert.equal((db.prepare("SELECT state FROM events WHERE id = 'batch-event'").get() as any).state, "processed");
});

test("post-dispatch assistant failure creates one recovery context with receipts", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "1", rawText: "go", attachmentIds: [], binding });
  const deliveries = new DeliveryStore(db);
  const attempt = submittedAttempt(db, deliveries, "ctx", "chat", "turn");
  const operation = operations.prepare({ contextId: "ctx", attemptId: attempt.attemptId, callId: "c", kind: "send", args: { x: 1 } });
  operations.markDispatched(operation.id);
  db.prepare("INSERT INTO events(id, endpoint_id, thread_id, kind, payload_json, state, created_at) VALUES ('event-1', 'local', 'worker', 'terminal', '{}', 'pending', 1)").run();
  db.prepare("INSERT INTO event_batches(id, event_ids_json, state, created_at) VALUES ('ctx', '[\"event-1\"]', 'active', 1)").run();
  const runtime = new AssistantRuntime(db, operations, deliveries, { binding });
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
  operations.createSourceContext({ id: "ctx-atomic", kind: "telegram", sourceId: "atomic", rawText: "question", attachmentIds: [], binding });
  const failingDeliveries = { prepare() { throw new Error("outbox failed"); } } as unknown as DeliveryStore;
  const runtime = new AssistantRuntime(db, operations, failingDeliveries, { binding });
  const attempt = submittedAttempt(db, failingDeliveries, "ctx-atomic", "chat", "turn-atomic");
  assert.throws(() => runtime.handleTerminal("turn-atomic", "answer"), /outbox failed/);
  assert.equal((db.prepare("SELECT state FROM assistant_attempts WHERE id = ?").get(attempt.attemptId) as any).state, "active");
  assert.equal((db.prepare("SELECT state FROM source_contexts WHERE id = 'ctx-atomic'").get() as any).state, "active");
});

test("a completed chat without final text is restored instead of silently dropped", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const deliveries = new DeliveryStore(db);
  operations.createSourceContext({ id: "ctx-empty", kind: "telegram", sourceId: "empty", rawText: "question", attachmentIds: [], binding });
  const runtime = new AssistantRuntime(db, operations, deliveries, { binding });
  const attempt = submittedAttempt(db, deliveries, "ctx-empty", "chat", "turn-empty");

  runtime.handleTerminal("turn-empty", "completed");

  assert.equal((db.prepare("SELECT state FROM assistant_attempts WHERE id = ?").get(attempt.attemptId) as any).state, "failed");
  assert.equal((db.prepare("SELECT state FROM source_contexts WHERE id = 'ctx-empty'").get() as any).state, "pending");
  assert.deepEqual(deliveries.listReady(), []);
});

test("effect-free assistant failures stop at a durable per-source attempt limit", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const deliveries = new DeliveryStore(db);
  operations.createSourceContext({ id: "ctx-limited", kind: "telegram", sourceId: "limited", rawText: "question", attachmentIds: [], binding });

  const preDispatch = new ConversationStore(db, deliveries);
  const unstarted = preDispatch.createAttempt({ kind: "chat", contextId: "ctx-limited" });
  preDispatch.reserveStart(unstarted.attemptId, "ctx-limited");
  preDispatch.restorePending(unstarted.attemptId, "ctx-limited");
  preDispatch.failUnstartedAttempt(unstarted.attemptId);

  const first = new AssistantRuntime(db, operations, deliveries, { binding, maxEffectFreeAttempts: 2 });
  submittedAttempt(db, deliveries, "ctx-limited", "chat", "turn-limited-1");
  first.failAttempt("turn-limited-1", new Error("failed"));
  assert.equal(operations.getSourceContext("ctx-limited")?.state, "pending");
  assert.equal(deliveries.get("assistant-attempts-exhausted:ctx-limited"), undefined);

  submittedAttempt(db, deliveries, "ctx-limited", "chat", "turn-limited-2");
  const restarted = new AssistantRuntime(db, operations, deliveries, { binding, maxEffectFreeAttempts: 2 });
  restarted.failAttempt("turn-limited-2", new Error("failed again"));

  assert.equal(operations.getSourceContext("ctx-limited")?.state, "completed");
  assert.equal(deliveries.get("assistant-attempts-exhausted:ctx-limited")?.kind, "system_warning");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM assistant_attempts WHERE context_id = 'ctx-limited' AND state = 'failed' AND turn_id IS NOT NULL").get()!.count, 2);
});

test("an exhausted internal source is terminalized and reported to the owner", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const deliveries = new DeliveryStore(db);
  operations.createSourceContext({ id: "batch-limited", kind: "event_batch", sourceId: "batch-limited", rawText: "", attachmentIds: [] });
  db.prepare("INSERT INTO events(id, endpoint_id, thread_id, kind, payload_json, state, created_at) VALUES ('limited-event', 'local', 'worker', 'terminal', '{}', 'pending', 1)").run();
  db.prepare("INSERT INTO event_batches(id, event_ids_json, state, created_at) VALUES ('batch-limited', '[\"limited-event\"]', 'active', 1)").run();
  const runtime = new AssistantRuntime(db, operations, deliveries, { binding, maxEffectFreeAttempts: 1 });
  submittedAttempt(db, deliveries, "batch-limited", "internal", "turn-batch-limited");

  runtime.failAttempt("turn-batch-limited", new Error("failed"));

  assert.equal(operations.getSourceContext("batch-limited")?.state, "completed");
  assert.equal(db.prepare("SELECT state FROM events WHERE id = 'limited-event'").get()!.state, "processed");
  assert.equal(deliveries.get("assistant-attempts-exhausted:batch-limited")?.kind, "system_warning");
});

test("failed-attempt terminalization rolls back if recovery creation fails", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx-fail-atomic", kind: "telegram", sourceId: "fail-atomic", rawText: "", attachmentIds: [], binding });
  const deliveries = new DeliveryStore(db);
  const runtime = new AssistantRuntime(db, operations, deliveries, { binding });
  const attempt = submittedAttempt(db, deliveries, "ctx-fail-atomic", "chat", "turn-fail-atomic");
  const operation = operations.prepare({ contextId: "ctx-fail-atomic", attemptId: attempt.attemptId, callId: "call", kind: "send", args: {} });
  operations.markDispatched(operation.id);
  db.exec(`CREATE TRIGGER fail_recovery_insert BEFORE INSERT ON source_contexts WHEN NEW.kind = 'recovery'
    BEGIN SELECT RAISE(ABORT, 'recovery insert failed'); END;`);
  assert.throws(() => runtime.failAttempt("turn-fail-atomic", "failed"), /recovery insert failed/);
  assert.equal((db.prepare("SELECT state FROM assistant_attempts WHERE id = ?").get(attempt.attemptId) as any).state, "active");
  assert.equal((db.prepare("SELECT state FROM source_contexts WHERE id = 'ctx-fail-atomic'").get() as any).state, "active");
});

test("source attachment retention is released exactly once at terminalization", () => {
  const db = createTestDatabase();
  db.prepare(`INSERT INTO attachments(id, scope_id, display_name, media_type, local_path, size, sha256, ref_count, expires_at, created_at)
    VALUES ('file-one', 'ctx-file', 'a', 'text/plain', '/tmp/a', 1, 'x', 1, 999, 1)`).run();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx-file", kind: "telegram", sourceId: "file", rawText: "", attachmentIds: ["file-one"], binding });
  const deliveries = new DeliveryStore(db);
  const runtime = new AssistantRuntime(db, operations, deliveries, { binding });
  submittedAttempt(db, deliveries, "ctx-file", "chat", "turn-file");
  runtime.handleTerminal("turn-file", "answer");
  runtime.handleTerminal("turn-file", "answer");
  assert.equal((db.prepare("SELECT ref_count FROM attachments WHERE id = 'file-one'").get() as any).ref_count, 0);
});

test("assistant context exists before turn/start dispatch and later binds the real turn id", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const conversations = new ConversationStore(db, new DeliveryStore(db));
  conversations.acceptChatSource({ id: "ctx", nativeSourceId: "4", binding, rawText: "go", attachmentIds: [], receivedAt: 1 });
  const lease = conversations.createAttempt({ kind: "chat", contextId: "ctx" });
  conversations.reserveStart(lease.attemptId, "ctx");
  const runtime = new AssistantRuntime(db, operations, new DeliveryStore(db), { binding });
  assert.deepEqual(runtime.activateAttempt(lease.attemptId), {
    attemptId: lease.attemptId, contextId: "ctx", triggerKind: "chat", binding, toolFence: 0,
  });
  const startingFence = runtime.registerTool(lease.attemptId);
  runtime.finishTool(lease.attemptId);
  assert.equal(startingFence, 0);
  assert.deepEqual(operations.listPendingSourceContexts(["telegram"]), []);
  conversations.confirmStart(lease.attemptId, "ctx", "real-turn");
  runtime.activateAttempt(lease.attemptId);
  assert.equal(runtime.current()?.turnId, "real-turn");
  runtime.abandonActive("real-turn");
  assert.equal(runtime.current(), undefined);
  assert.equal(runtime.activeAttempts()[0]?.turnId, "real-turn", "transport loss keeps the durable attempt active for reconciliation");
});

test("durable attempt state cannot admit a tool without process-local activation", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const conversations = new ConversationStore(db, new DeliveryStore(db));
  conversations.createInternalSource({ id: "owned", kind: "event_batch", sourceId: "owned", rawText: "", attachmentIds: [], receivedAt: 1 });
  const attempt = conversations.createAttempt({ kind: "internal", contextId: "owned" });
  conversations.reserveStart(attempt.attemptId, "owned");
  conversations.confirmStart(attempt.attemptId, "owned", "turn-a");

  const restarted = new AssistantRuntime(db, operations, new DeliveryStore(db), { binding });
  assert.equal(restarted.current(), undefined);
  assert.throws(() => restarted.registerTool(attempt.attemptId), /not active in this process/iu);

  restarted.activateAttempt(attempt.attemptId);
  assert.equal(restarted.registerTool(attempt.attemptId), 0);
  restarted.finishTool(attempt.attemptId);
});

test("orphan and identity-inconsistent attempts cannot become MCP context", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "orphan", kind: "event_batch", sourceId: "orphan", rawText: "", attachmentIds: [] });
  const runtime = new AssistantRuntime(db, operations, new DeliveryStore(db), { binding });
  db.prepare(`INSERT INTO assistant_attempts(id, context_id, trigger_kind, state, created_at)
    VALUES ('orphan-attempt', 'orphan', 'internal', 'active', 1)`).run();
  assert.equal(runtime.activateAttempt("orphan-attempt"), undefined);
  assert.equal(runtime.current(), undefined);
  assert.throws(() => runtime.registerTool("orphan-attempt"), /not accepting tools/iu);

  const conversations = new ConversationStore(db, new DeliveryStore(db));
  conversations.createInternalSource({ id: "owned", kind: "event_batch", sourceId: "owned", rawText: "", attachmentIds: [], receivedAt: 2 });
  const attempt = conversations.createAttempt({ kind: "internal", contextId: "owned" });
  conversations.reserveStart(attempt.attemptId, "owned");
  conversations.confirmStart(attempt.attemptId, "owned", "turn-a");
  db.prepare("UPDATE assistant_attempts SET turn_id = 'turn-b' WHERE id = ?").run(attempt.attemptId);
  assert.equal(runtime.activateAttempt(attempt.attemptId), undefined);
  assert.throws(() => runtime.registerTool(attempt.attemptId), /not accepting tools/iu);
});

test("terminalizing an attempt immediately closes cached MCP context", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const conversations = new ConversationStore(db, new DeliveryStore(db));
  conversations.createInternalSource({ id: "owned", kind: "event_batch", sourceId: "owned", rawText: "", attachmentIds: [], receivedAt: 1 });
  const attempt = conversations.createAttempt({ kind: "internal", contextId: "owned" });
  conversations.reserveStart(attempt.attemptId, "owned");
  conversations.confirmStart(attempt.attemptId, "owned", "turn-a");
  const runtime = new AssistantRuntime(db, operations, new DeliveryStore(db), { binding });
  assert.equal(runtime.activateAttempt(attempt.attemptId)?.turnId, "turn-a");

  conversations.beginTerminalizing(attempt.attemptId, "turn-a");
  assert.equal(runtime.current(), undefined);
  assert.throws(() => runtime.registerTool(attempt.attemptId), /not accepting tools/iu);
  assert.equal(runtime.contextForTurn("turn-a")?.attemptId, attempt.attemptId);
});

test("terminal handling prefers the active attempt when historical attempts share a turn id", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const deliveries = new DeliveryStore(db);
  const conversations = new ConversationStore(db, deliveries);
  conversations.createInternalSource({ id: "historical", kind: "event_batch", sourceId: "historical", rawText: "", attachmentIds: [], receivedAt: 1 });
  conversations.createInternalSource({ id: "current", kind: "event_batch", sourceId: "current", rawText: "", attachmentIds: [], receivedAt: 2 });
  db.prepare(`INSERT INTO assistant_attempts(id, context_id, turn_id, trigger_kind, state, created_at)
    VALUES ('historical-attempt', 'historical', 'shared-turn', 'internal', 'failed', 1)`).run();
  const lease = conversations.createAttempt({ kind: "internal", contextId: "current" });
  conversations.reserveStart(lease.attemptId, "current");
  conversations.markSubmitted(lease.attemptId, "current", "shared-turn");
  const runtime = new AssistantRuntime(db, operations, deliveries, { binding });

  assert.equal(runtime.contextForTurn("shared-turn")?.attemptId, lease.attemptId);
  runtime.handleTerminal("shared-turn", "interrupted", undefined, new Error("interrupted"));

  assert.equal(db.prepare("SELECT state FROM assistant_attempts WHERE id = ?").get(lease.attemptId)!.state, "failed");
  assert.equal(conversations.attempt(lease.attemptId), undefined);
  assert.equal(db.prepare("SELECT state FROM source_contexts WHERE id = 'current'").get()!.state, "pending");
});

test("successful read-only tools do not force a recovery context after a failed attempt", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx-read", kind: "telegram", sourceId: "3", rawText: "status", attachmentIds: [], binding });
  const deliveries = new DeliveryStore(db);
  const runtime = new AssistantRuntime(db, operations, deliveries, { binding });
  const attempt = submittedAttempt(db, deliveries, "ctx-read", "chat", "t-read");
  const operation = operations.prepare({ contextId: "ctx-read", attemptId: attempt.attemptId, callId: "c", kind: "get_session_status", args: {} });
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
  const lease = conversations.createAttempt({ kind: "chat", contextId: "one" });
  conversations.reserveStart(lease.attemptId, "one");
  conversations.markSubmitted(lease.attemptId, "one", "turn");
  conversations.reserveNextSteer(lease.attemptId);
  conversations.markSubmitted(lease.attemptId, "two", "turn");
  const runtime = new AssistantRuntime(db, operations, deliveries, { binding });
  runtime.activateAttempt(lease.attemptId);
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

test("a completed multi-source chat without final text restores every source", () => {
  const { db, conversations, lease, runtime } = multiSourceAttempt();
  runtime.handleTerminal("turn", "completed");
  assert.deepEqual((db.prepare("SELECT state FROM source_contexts ORDER BY id").all() as any[]).map((row) => row.state), ["pending", "pending"]);
  assert.deepEqual((db.prepare("SELECT state FROM assistant_attempt_sources ORDER BY source_ordinal").all() as any[]).map((row) => row.state), ["failed", "failed"]);
  assert.equal(conversations.attempt(lease.attemptId), undefined);
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

test("a completed chat without final text preserves effect receipts in one recovery context", () => {
  const { db, operations, lease, runtime } = multiSourceAttempt();
  const operation = operations.prepare({ contextId: "two", attemptId: lease.attemptId, callId: "send-empty", kind: "send_chat_message", args: {}, effectClass: "side_effecting", toolFence: 0 });
  operations.succeed(operation.id, { messageId: "delivered" });
  const result = runtime.handleTerminal("turn", "completed");
  assert.ok(result.recoveryContextId);
  assert.deepEqual((db.prepare("SELECT state FROM source_contexts WHERE id IN ('one','two') ORDER BY id").all() as any[]).map((row) => row.state), ["superseded", "superseded"]);
  const recovery = db.prepare("SELECT raw_text FROM source_contexts WHERE id = ?").get(result.recoveryContextId!) as { raw_text: string };
  assert.deepEqual(JSON.parse(recovery.raw_text), [{ operationId: operation.id, state: "succeeded", receipt: { messageId: "delivered" }, error: "assistant turn completed without a final response" }]);
});

test("a completed internal attempt does not require final text", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const deliveries = new DeliveryStore(db);
  const conversations = new ConversationStore(db, deliveries);
  conversations.createInternalSource({ id: "internal-empty", kind: "event_batch", sourceId: "internal-empty", rawText: "", attachmentIds: [], receivedAt: 1 });
  const lease = conversations.createAttempt({ kind: "internal", contextId: "internal-empty" });
  conversations.reserveStart(lease.attemptId, "internal-empty");
  conversations.markSubmitted(lease.attemptId, "internal-empty", "internal-empty-turn");
  const runtime = new AssistantRuntime(db, operations, deliveries, { binding });
  runtime.handleTerminal("internal-empty-turn", "completed");
  assert.equal(db.prepare("SELECT state FROM source_contexts WHERE id = 'internal-empty'").get()!.state, "completed");
  assert.deepEqual(deliveries.listReady(), []);
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
  assert.equal(await runtime.fenceTools(lease.attemptId, 1), "timed_out");
  assert.throws(() => runtime.registerTool(lease.attemptId), /terminal/u);
  release();
  await assert.rejects(call, /uncertain|terminal/u);
  const operation = operations.listForAttempt(lease.attemptId).find((item) => item.callId === "held")!;
  assert.equal(operation.state, "uncertain");
  assert.equal(operation.receipt, undefined);
});

test("tool settlement is observable and the global drain waits for every attempt", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const conversations = new ConversationStore(db, new DeliveryStore(db));
  const runtime = new AssistantRuntime(db, operations, new DeliveryStore(db), { binding });
  conversations.createInternalSource({ id: "ctx-one", kind: "event_batch", sourceId: "ctx-one", rawText: "", attachmentIds: [], receivedAt: 1 });
  const first = conversations.createAttempt({ kind: "internal", contextId: "ctx-one" });
  conversations.reserveStart(first.attemptId, "ctx-one");
  conversations.confirmStart(first.attemptId, "ctx-one", "turn-one");
  runtime.activateAttempt(first.attemptId);
  runtime.registerTool(first.attemptId);

  conversations.createInternalSource({ id: "ctx-two", kind: "event_batch", sourceId: "ctx-two", rawText: "", attachmentIds: [], receivedAt: 2 });
  const second = conversations.createAttempt({ kind: "internal", contextId: "ctx-two" });
  conversations.reserveStart(second.attemptId, "ctx-two");
  conversations.confirmStart(second.attemptId, "ctx-two", "turn-two");
  runtime.activateAttempt(second.attemptId);
  runtime.registerTool(second.attemptId);

  assert.equal(runtime.hasActiveTools(first.attemptId), true);
  let drained = false;
  const draining = runtime.waitForTools().then(() => { drained = true; });
  runtime.finishTool(first.attemptId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runtime.hasActiveTools(first.attemptId), false);
  assert.equal(drained, false);

  const settled = runtime.fenceTools(second.attemptId, 100);
  runtime.finishTool(second.attemptId);
  assert.equal(await settled, "settled");
  await draining;
  assert.equal(drained, true);

  runtime.fenceToolAdmission();
  assert.throws(() => runtime.registerTool(first.attemptId), /terminal/u);
  assert.throws(() => runtime.registerTool(second.attemptId), /terminal/u);
});

test("causal finals retain the attempt binding while destinationless internal recovery stays unbound", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const deliveries = new DeliveryStore(db);
  const conversations = new ConversationStore(db, deliveries);
  const causal = { adapterId: "slack", conversationKey: "slack:D1", destination: { channel: "D1" } } as const;
  conversations.acceptChatSource({ id: "chat", nativeSourceId: "chat", binding: causal, rawText: "hello", attachmentIds: [], receivedAt: 1 });
  const chatLease = conversations.createAttempt({ kind: "chat", contextId: "chat" });
  conversations.reserveStart(chatLease.attemptId, "chat");
  conversations.markSubmitted(chatLease.attemptId, "chat", "chat-turn");
  const outsider = { adapterId: "telegram", conversationKey: "telegram:outsider", destination: { chatId: "outsider" } } as const;
  assert.equal(conversations.acceptChatSource(
    { id: "outsider", nativeSourceId: "outsider", binding: outsider, rawText: "later", attachmentIds: [], receivedAt: 2 },
    {},
    chatLease,
  ).disposition, "queued");
  const runtime = new AssistantRuntime(db, operations, deliveries, { binding });
  runtime.activateAttempt(chatLease.attemptId);
  runtime.handleTerminal("chat-turn", "completed", "answer");
  assert.deepEqual(deliveries.get("assistant:chat-turn")?.binding, causal);

  conversations.createInternalSource({ id: "internal", kind: "event_batch", sourceId: "batch", rawText: "event", attachmentIds: [], receivedAt: 2 });
  const internal = conversations.createAttempt({ kind: "internal", contextId: "internal" });
  conversations.reserveStart(internal.attemptId, "internal");
  conversations.markSubmitted(internal.attemptId, "internal", "internal-turn");
  const operation = operations.prepare({ contextId: "internal", attemptId: internal.attemptId, callId: "effect", kind: "create_session", args: {}, effectClass: "side_effecting", toolFence: 0 });
  operations.markDispatched(operation.id, 0);
  runtime.activateAttempt(internal.attemptId);
  const recovery = runtime.handleTerminal("internal-turn", "failed", undefined, new Error("lost"));
  const row = db.prepare("SELECT adapter_id, conversation_key FROM source_contexts WHERE id = ?").get(recovery.recoveryContextId!) as any;
  assert.equal(row.adapter_id, null);
  assert.equal(row.conversation_key, null);
  assert.equal(deliveries.listReady().filter((delivery) => delivery.id.includes("internal-turn")).length, 0);
});

test("a steer proven not admitted stays pending when the owning turn completes", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const deliveries = new DeliveryStore(db);
  const conversations = new ConversationStore(db, deliveries);
  for (const id of ["owner", "restored"]) conversations.acceptChatSource({ id, nativeSourceId: id, binding, rawText: id, attachmentIds: [], receivedAt: 1 });
  const lease = conversations.createAttempt({ kind: "chat", contextId: "owner" });
  conversations.reserveStart(lease.attemptId, "owner");
  conversations.markSubmitted(lease.attemptId, "owner", "turn");
  conversations.reserveNextSteer(lease.attemptId);
  conversations.restorePending(lease.attemptId, "restored");
  const runtime = new AssistantRuntime(db, operations, deliveries, { binding });
  runtime.activateAttempt(lease.attemptId);
  runtime.handleTerminal("turn", "completed", "done");
  assert.equal(db.prepare("SELECT state FROM source_contexts WHERE id = 'owner'").get()!.state, "completed");
  assert.equal(db.prepare("SELECT state FROM source_contexts WHERE id = 'restored'").get()!.state, "pending");
  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources WHERE context_id = 'restored'").get()!.state, "failed");
});

test("terminal handling delivers the settled turn while preserving an unresolved native submission", () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const deliveries = new DeliveryStore(db);
  const conversations = new ConversationStore(db, deliveries);
  for (const id of ["owner", "unresolved"]) conversations.acceptChatSource({ id, nativeSourceId: id, binding, rawText: id, attachmentIds: [], receivedAt: 1 });
  const lease = conversations.createAttempt({ kind: "chat", contextId: "owner" });
  conversations.reserveStart(lease.attemptId, "owner");
  conversations.markSubmitted(lease.attemptId, "owner", "turn");
  conversations.reserveNextSteer(lease.attemptId);
  const runtime = new AssistantRuntime(db, operations, deliveries, { binding });
  runtime.activateAttempt(lease.attemptId);

  runtime.handleTerminal("turn", "completed", "final now");

  assert.equal(db.prepare("SELECT state FROM assistant_attempts WHERE id = ?").get(lease.attemptId)!.state, "completed");
  assert.equal(db.prepare("SELECT state FROM source_contexts WHERE id = 'owner'").get()!.state, "completed");
  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources WHERE context_id = 'unresolved'").get()!.state, "steer_submitting");
  assert.equal(db.prepare("SELECT state FROM source_contexts WHERE id = 'unresolved'").get()!.state, "active");
  assert.equal(deliveries.get("assistant:turn")?.body, "final now");
});
