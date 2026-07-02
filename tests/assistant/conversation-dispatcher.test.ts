import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { AppServerPool, type AppServerEndpoint, type TurnCapacityClaim } from "../../src/app-server/pool.ts";
import { JsonRpcResponseError } from "../../src/app-server/json-rpc-client.ts";
import type {
  AssistantTurnPort,
  ThreadSnapshot,
  TurnSnapshot,
  TurnStartParams,
  TurnSteerParams,
} from "../../src/assistant/conversation-dispatcher.ts";
import { ConversationDispatcher } from "../../src/assistant/conversation-dispatcher.ts";
import { AttachmentStore } from "../../src/attachments/store.ts";
import type { ConversationBinding } from "../../src/chat/binding.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { AssistantScheduler } from "../../src/assistant/scheduler.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}

class FakeRunner implements AssistantTurnPort {
  starts: Array<{ params: TurnStartParams; claim: TurnCapacityClaim; result: ReturnType<typeof deferred<{ turn: TurnSnapshot }>> }> = [];
  steers: Array<{ params: TurnSteerParams; result: ReturnType<typeof deferred<{ turnId: string }>> }> = [];
  history: ThreadSnapshot = { status: "idle", turns: [] };
  historyReads = 0;

  start(params: TurnStartParams, claim: TurnCapacityClaim): Promise<{ turn: TurnSnapshot }> {
    const result = deferred<{ turn: TurnSnapshot }>();
    this.starts.push({ params, claim, result });
    return result.promise;
  }

  steer(params: TurnSteerParams): Promise<{ turnId: string }> {
    const result = deferred<{ turnId: string }>();
    this.steers.push({ params, result });
    return result.promise;
  }

  async readThread(): Promise<ThreadSnapshot> { this.historyReads += 1; return this.history; }
}

const route = (conversationKey: string): ConversationBinding => ({
  adapterId: "telegram",
  conversationKey,
  destination: { chatId: conversationKey },
});

const chat = (id: string, conversationKey = "chat-1", attachmentIds: readonly string[] = []) => ({
  id,
  nativeSourceId: `native:${id}`,
  binding: route(conversationKey),
  rawText: id === "first" ? "hello" : "more",
  attachmentIds,
  receivedAt: 1,
});

function fixture(maxConcurrentTurns = 1, dispatcherOptions: { stopWaitMs?: number; onDeferredTerminal?: (turn: TurnSnapshot) => void } = {}) {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const store = new ConversationStore(db, deliveries);
  const endpoint: AppServerEndpoint = { id: "assistant-local", state: "ready", request: async () => { throw new Error("unused"); } };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns });
  const runner = new FakeRunner();
  const dispatcher = new ConversationDispatcher(store, pool, runner, {
    endpointId: "assistant-local",
    threadId: "assistant",
    retryMs: 10,
    ...dispatcherOptions,
  });
  return { db, deliveries, store, pool, runner, dispatcher };
}

test("stop durably marks an unresolved native submission and returns within its bound", async () => {
  const { db, runner, dispatcher } = fixture(1, { stopWaitMs: 5 });
  await dispatcher.accept(chat("first"));
  await Promise.race([
    dispatcher.stop(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("dispatcher stop hung")), 200)),
  ]);
  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources WHERE context_id = 'first'").get()!.state, "uncertain");
  runner.starts[0]!.result.resolve({ turn: { id: "late", status: "inProgress", itemsView: "full", items: [] } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources WHERE context_id = 'first'").get()!.state, "uncertain");
});

test("starts an idle conversation and naturally steers same-conversation follow-ups", async () => {
  const { runner, dispatcher } = fixture();
  await dispatcher.accept(chat("first"));
  assert.equal(runner.starts.length, 1);
  assert.deepEqual(runner.starts[0]?.params, {
    threadId: "assistant",
    clientUserMessageId: "first",
    input: [{ type: "text", text: "hello", text_elements: [] }],
  });
  runner.starts[0]!.result.resolve({ turn: { id: "turn-1", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();

  await dispatcher.accept(chat("follow-up"));
  assert.deepEqual(runner.steers[0]?.params, {
    threadId: "assistant",
    expectedTurnId: "turn-1",
    clientUserMessageId: "follow-up",
    input: [{ type: "text", text: "more", text_elements: [] }],
  });
  runner.steers[0]!.result.resolve({ turnId: "turn-1" });
  await dispatcher.idle();
  await dispatcher.stop();
});

test("holds one native steer at a time and only queues another conversation", async () => {
  const { deliveries, runner, dispatcher } = fixture();
  await dispatcher.accept(chat("first"));
  runner.starts[0]!.result.resolve({ turn: { id: "turn-1", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  await dispatcher.accept(chat("owner-one"));
  await dispatcher.accept(chat("owner-two"));
  await dispatcher.accept(chat("outsider", "chat-2"));
  assert.equal(runner.steers.length, 1);
  assert.equal(deliveries.get("queued:outsider")?.body, "[system] queued");
  runner.steers[0]!.result.resolve({ turnId: "turn-1" });
  await waitFor(() => runner.steers.length === 2);
  assert.equal(runner.steers.length, 2);
  runner.steers[1]!.result.resolve({ turnId: "turn-1" });
  await dispatcher.idle();
  await dispatcher.stop();
});

test("terminal notification fences the lease while a steer response is pending", async () => {
  const { store, runner, dispatcher } = fixture();
  await dispatcher.accept(chat("first"));
  runner.starts[0]!.result.resolve({ turn: { id: "turn-1", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  await dispatcher.accept(chat("follow-up"));
  await dispatcher.terminal({ id: "turn-1", status: "completed", itemsView: "full", items: [] });
  assert.equal(store.lease()?.phase, "terminalizing");
  runner.steers[0]!.result.resolve({ turnId: "turn-1" });
  await dispatcher.idle();
  assert.equal(store.lease()?.phase, "terminalizing");
  await dispatcher.stop();
});

test("terminal summary keeps an unproven steer durably unresolved with its lease", async () => {
  const { db, store, runner, dispatcher } = fixture();
  await dispatcher.accept(chat("first"));
  runner.starts[0]!.result.resolve({ turn: { id: "turn-1", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  await dispatcher.accept(chat("follow-up"));
  runner.history = {
    status: "idle",
    turns: [{ id: "turn-1", status: "completed", itemsView: "summary", items: [] }],
  };
  await dispatcher.terminal({ id: "turn-1", status: "completed", itemsView: "summary", items: [] });
  runner.steers[0]!.result.reject(new Error("response lost"));
  await dispatcher.idle();

  assert.equal(store.lease()?.phase, "terminalizing");
  assert.equal(db.prepare("SELECT state FROM source_contexts WHERE id = 'follow-up'").get()!.state, "active");
  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources WHERE context_id = 'follow-up'").get()!.state, "uncertain");
  await dispatcher.stop();
});

test("terminal history restores a steer proven absent before forwarding finalization", async () => {
  const deferred: TurnSnapshot[] = [];
  const { db, runner, dispatcher } = fixture(1, { onDeferredTerminal: (turn) => { deferred.push(turn); } });
  await dispatcher.accept(chat("first"));
  runner.starts[0]!.result.resolve({ turn: { id: "turn-1", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  await dispatcher.accept(chat("follow-up"));
  const terminal = { id: "turn-1", status: "completed", itemsView: "full" as const, items: [] };
  runner.history = { status: "idle", turns: [terminal] };
  await dispatcher.terminal(terminal);
  runner.steers[0]!.result.reject(new Error("response lost"));
  await dispatcher.idle();

  assert.equal(db.prepare("SELECT state FROM source_contexts WHERE id = 'follow-up'").get()!.state, "pending");
  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources WHERE context_id = 'follow-up'").get()!.state, "failed");
  assert.deepEqual(deferred.map((turn) => turn.id), ["turn-1"]);
  await dispatcher.stop();
});

test("terminal history admits a positively correlated steer before forwarding finalization", async () => {
  const deferred: TurnSnapshot[] = [];
  const { db, runner, dispatcher } = fixture(1, { onDeferredTerminal: (turn) => { deferred.push(turn); } });
  await dispatcher.accept(chat("first"));
  runner.starts[0]!.result.resolve({ turn: { id: "turn-1", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  await dispatcher.accept(chat("follow-up"));
  const terminal = {
    id: "turn-1",
    status: "completed",
    itemsView: "full" as const,
    items: [{ type: "userMessage", clientId: "follow-up" }],
  };
  runner.history = { status: "idle", turns: [terminal] };
  await dispatcher.terminal(terminal);
  runner.steers[0]!.result.reject(new Error("response lost"));
  await dispatcher.idle();

  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources WHERE context_id = 'follow-up'").get()!.state, "submitted");
  assert.deepEqual(deferred.map((turn) => turn.id), ["turn-1"]);
  await dispatcher.stop();
});

test("native activeTurnNotSteerable restores the source and durably pauses steering", async () => {
  const { db, runner, dispatcher } = fixture();
  await dispatcher.accept(chat("first"));
  runner.starts[0]!.result.resolve({ turn: { id: "turn-1", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  await dispatcher.accept(chat("follow-up"));
  runner.steers[0]!.result.reject(new JsonRpcResponseError(-32000, "active turn cannot be steered", {
    codexErrorInfo: { activeTurnNotSteerable: { turnKind: "compact" } },
  }));
  await dispatcher.idle();

  assert.equal(db.prepare("SELECT state FROM source_contexts WHERE id = 'follow-up'").get()!.state, "pending");
  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources WHERE context_id = 'follow-up'").get()!.state, "failed");
  assert.deepEqual({ ...db.prepare("SELECT steer_paused, pause_reason FROM assistant_turn_lease").get()! }, {
    steer_paused: 1,
    pause_reason: "native_turn_not_steerable",
  });
  assert.equal(runner.historyReads, 0);
  assert.equal(runner.steers.length, 1);
  await dispatcher.stop();
});

test("submission input preserves text, image, and document source order", async (context) => {
  const db = createTestDatabase();
  const root = await mkdtemp(join(tmpdir(), "dispatcher-files-"));
  const attachments = new AttachmentStore(db, root, { maxFileBytes: 100, maxStoreBytes: 1_000 });
  await attachments.initialize();
  const image = await attachments.ingest("first", Readable.from(["image"]), { displayName: "one.png", mediaType: "image/png" });
  const document = await attachments.ingest("first", Readable.from(["doc"]), { displayName: "two.txt", mediaType: "text/plain" });
  const store = new ConversationStore(db, new DeliveryStore(db), attachments);
  const endpoint: AppServerEndpoint = { id: "assistant-local", state: "ready", request: async () => { throw new Error("unused"); } };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  const runner = new FakeRunner();
  const dispatcher = new ConversationDispatcher(store, pool, runner, { endpointId: "assistant-local", threadId: "assistant", attachments });
  context.after(() => dispatcher.stop());
  await dispatcher.accept(chat("first", "chat-1", [image.id, document.id]));
  assert.deepEqual(runner.starts[0]?.params.input, [
    { type: "text", text: "hello", text_elements: [] },
    attachments.toUserInput("first", image.id),
    attachments.toUserInput("first", document.id),
  ]);
  runner.starts[0]!.result.resolve({ turn: { id: "turn", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
});

test("capacity exhaustion leaves input pending and wakes once after capacity release", async () => {
  const { db, pool, runner, dispatcher } = fixture();
  const blocker = pool.claimTurnCapacity("assistant-local", "other", "blocker");
  await dispatcher.accept(chat("first"));
  assert.equal(runner.starts.length, 0);
  assert.equal(db.prepare("SELECT state FROM source_contexts WHERE id = 'first'").get()!.state, "pending");
  pool.releaseTurnCapacityClaim(blocker);
  await waitFor(() => runner.starts.length === 1);
  assert.equal(runner.starts.length, 1);
  assert.equal(storeClaim(db), runner.starts[0]?.claim.id);
  runner.starts[0]!.result.resolve({ turn: { id: "turn", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  await dispatcher.stop();
});

test("ambiguous history retains the unresolved source and provisional capacity without retransmission", async () => {
  const { db, pool, runner, dispatcher } = fixture();
  runner.history = {
    status: "active",
    turns: [{ id: "other", status: "inProgress", itemsView: "summary", items: [] }],
  };
  await dispatcher.accept(chat("first"));
  runner.starts[0]!.result.reject(new Error("response lost"));
  await dispatcher.idle();
  assert.equal(runner.starts.length, 1);
  assert.equal(pool.activeTurnCount, 1);
  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources").get()!.state, "uncertain");
  assert.equal(db.prepare("SELECT steer_paused FROM assistant_turn_lease").get()!.steer_paused, 1);
  await dispatcher.stop();
});

test("full terminal absence restores a failed start without an immediate retry", async () => {
  const { db, pool, runner, dispatcher } = fixture();
  runner.history = {
    status: "idle",
    turns: [{ id: "older", status: "completed", itemsView: "full", items: [] }],
  };
  await dispatcher.accept(chat("first"));
  runner.starts[0]!.result.reject(new Error("definite after read"));
  await dispatcher.idle();
  assert.equal(runner.starts.length, 1);
  assert.equal(pool.activeTurnCount, 0);
  assert.equal(db.prepare("SELECT state FROM source_contexts WHERE id = 'first'").get()!.state, "pending");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assistant_turn_lease").get()!.n, 0);
  await dispatcher.stop();
});

test("an active thread with empty full history cannot prove an ambiguous start absent", async () => {
  const { db, pool, runner, dispatcher } = fixture();
  runner.history = { status: { type: "active" }, turns: [] };
  await dispatcher.accept(chat("first"));
  runner.starts[0]!.result.reject(new Error("response lost"));
  await dispatcher.idle();
  assert.equal(pool.activeTurnCount, 1);
  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources").get()!.state, "uncertain");
  assert.ok(db.prepare("SELECT attempt_id FROM assistant_turn_lease").get());
  await dispatcher.stop();
});

test("positive full-history correlation binds an ambiguous start exactly once", async () => {
  const { db, pool, runner, dispatcher } = fixture();
  runner.history = {
    status: "active",
    turns: [{ id: "recovered-turn", status: "inProgress", itemsView: "full", items: [{ type: "userMessage", clientId: "first" }] }],
  };
  await dispatcher.accept(chat("first"));
  runner.starts[0]!.result.reject(new Error("response lost"));
  await dispatcher.idle();
  assert.equal(runner.starts.length, 1);
  assert.equal(pool.activeTurnCount, 1);
  assert.equal(db.prepare("SELECT turn_id FROM assistant_turn_lease").get()!.turn_id, "recovered-turn");
  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources").get()!.state, "submitted");
  await dispatcher.stop();
});

test("terminal history correlation forwards the recovered turn for finalization", async () => {
  const db = createTestDatabase();
  const store = new ConversationStore(db, new DeliveryStore(db));
  const endpoint: AppServerEndpoint = { id: "assistant-local", state: "ready", request: async () => { throw new Error("unused"); } };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  const runner = new FakeRunner();
  const terminal: TurnSnapshot[] = [];
  runner.history = {
    status: "idle",
    turns: [{ id: "recovered-terminal", status: "completed", itemsView: "full", items: [{ type: "userMessage", clientId: "first" }] }],
  };
  const dispatcher = new ConversationDispatcher(store, pool, runner, {
    endpointId: "assistant-local",
    threadId: "assistant",
    onDeferredTerminal: (turn) => { terminal.push(turn); },
  });
  await dispatcher.accept(chat("first"));
  runner.starts[0]!.result.reject(new Error("response lost"));
  await dispatcher.idle();
  assert.deepEqual(terminal.map((turn) => turn.id), ["recovered-terminal"]);
  await dispatcher.stop();
});

test("a lease CAS loss releases the unused native capacity claim", async () => {
  const { store, pool, runner, dispatcher } = fixture();
  const original = store.acquireLease.bind(store);
  store.acquireLease = (() => { throw new Error("lease changed"); }) as typeof store.acquireLease;
  await assert.rejects(dispatcher.accept(chat("first")), /lease changed/u);
  assert.equal(pool.activeTurnCount, 0);
  assert.equal(runner.starts.length, 0);
  store.acquireLease = original;
  await dispatcher.stop();
});

test("a starved internal event wins only at a lease boundary and materializes once", async () => {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const store = new ConversationStore(db, deliveries);
  const scheduler = new AssistantScheduler({ now: () => 1, batchWindowMs: 10_000 });
  db.prepare("INSERT INTO events(id, endpoint_id, thread_id, kind, payload_json, state, created_at) VALUES ('e1', 'local', 'worker', 'terminal', '{}', 'pending', 1)").run();
  scheduler.enqueueEvent({ id: "e1", sessionKey: "worker", payload: { final: true } });
  for (let index = 0; index < 5; index += 1) scheduler.noteConversationPeriodCompleted();
  const endpoint: AppServerEndpoint = { id: "assistant-local", state: "ready", request: async () => { throw new Error("unused"); } };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  const runner = new FakeRunner();
  const dispatcher = new ConversationDispatcher(store, pool, runner, { endpointId: "assistant-local", threadId: "assistant", scheduler });
  await dispatcher.accept(chat("chat-pending"));
  assert.equal(runner.starts[0]?.params.clientUserMessageId, "batch:e1");
  assert.equal(deliveries.get("queued:chat-pending")?.body, "[system] queued");
  assert.equal(scheduler.peekEligibleEventBatch(), undefined);
  runner.starts[0]!.result.resolve({ turn: { id: "event-turn", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM event_batches").get()!.n, 1);
  await dispatcher.stop();
});

test("a due event never interrupts an active conversation period", async () => {
  const value = fixture();
  const scheduler = new AssistantScheduler({ now: () => 40_000, batchWindowMs: 0 });
  const dispatcher = new ConversationDispatcher(value.store, value.pool, value.runner, { endpointId: "assistant-local", threadId: "assistant", scheduler });
  await dispatcher.accept(chat("first"));
  value.runner.starts[0]!.result.resolve({ turn: { id: "turn", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  value.db.prepare("INSERT INTO events(id, endpoint_id, thread_id, kind, payload_json, state, created_at) VALUES ('e1', 'local', 'worker', 'terminal', '{}', 'pending', 1)").run();
  scheduler.enqueueEvent({ id: "e1", sessionKey: "worker", payload: { final: true } });
  await dispatcher.enqueueInternal("e1");
  assert.equal(value.runner.starts.length, 1);
  await dispatcher.stop();
  await value.dispatcher.stop();
});

function storeClaim(db: ReturnType<typeof createTestDatabase>): string {
  return String(db.prepare("SELECT capacity_claim_id FROM assistant_turn_lease").get()!.capacity_claim_id);
}
