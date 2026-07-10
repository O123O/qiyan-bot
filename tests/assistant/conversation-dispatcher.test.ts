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
import type { ConversationBinding } from "../../src/chat-apps/shared/binding.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { AssistantScheduler } from "../../src/assistant/scheduler.ts";
import { AssistantRuntime } from "../../src/assistant/runtime.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";
import { commitAssistantTerminalFinals } from "../../src/production-app.ts";
import { FinalMessageStore } from "../../src/sessions/final-messages.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("condition did not become true");
}

class FakeRunner implements AssistantTurnPort {
  starts: Array<{ params: TurnStartParams; claim: TurnCapacityClaim; result: ReturnType<typeof deferred<{ turn: TurnSnapshot }>> }> = [];
  steers: Array<{ params: TurnSteerParams; result: ReturnType<typeof deferred<{ turnId: string }>> }> = [];
  history: ThreadSnapshot = { status: "idle", turns: [] };
  historyErrors: unknown[] = [];
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

  async readThread(): Promise<ThreadSnapshot> {
    this.historyReads += 1;
    const error = this.historyErrors.shift();
    if (error) throw error;
    return this.history;
  }
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

function fixture(maxConcurrentTurns = 1, dispatcherOptions: {
  onDeferredTerminal?: (turn: TurnSnapshot) => void;
  onOperationalEvent?: (event: "assistant_turn_started" | "assistant_turn_steered" | "assistant_submission_uncertain" | "assistant_turn_terminal") => void;
  scheduler?: AssistantScheduler;
  membershipObserver?: { notifyMembership(contextId: string): void };
} = {}) {
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

test("stop durably marks an unresolved native submission and awaits its handler", async () => {
  const { db, runner, dispatcher } = fixture();
  await dispatcher.accept(chat("first"));
  let stopped = false;
  const stopping = dispatcher.stop().then(() => { stopped = true; });
  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources WHERE context_id = 'first'").get()!.state, "uncertain");
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, false);
  runner.starts[0]!.result.resolve({ turn: { id: "late", status: "inProgress", itemsView: "full", items: [] } });
  await stopping;
  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources WHERE context_id = 'first'").get()!.state, "uncertain");
});

test("starts an idle conversation and naturally steers same-conversation follow-ups", async () => {
  const operational: string[] = [];
  const { runner, dispatcher } = fixture(1, { onOperationalEvent: (event) => { operational.push(event); } });
  await dispatcher.accept(chat("first"));
  assert.equal(runner.starts.length, 1);
  const startClientId = runner.starts[0]!.params.clientUserMessageId;
  assert.match(startClientId, /^qiyan:attempt_[0-9a-f-]{36}:1$/u);
  assert.deepEqual(runner.starts[0]?.params, {
    threadId: "assistant",
    clientUserMessageId: startClientId,
    input: [{ type: "text", text: "[telegram]", text_elements: [] }, { type: "text", text: "hello", text_elements: [] }],
  });
  runner.starts[0]!.result.resolve({ turn: { id: "turn-1", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();

  await dispatcher.accept(chat("follow-up"));
  const steerClientId = runner.steers[0]!.params.clientUserMessageId;
  assert.equal(steerClientId, startClientId.replace(/:1$/u, ":2"));
  assert.deepEqual(runner.steers[0]?.params, {
    threadId: "assistant",
    expectedTurnId: "turn-1",
    clientUserMessageId: steerClientId,
    input: [{ type: "text", text: "[telegram]", text_elements: [] }, { type: "text", text: "more", text_elements: [] }],
  });
  runner.steers[0]!.result.resolve({ turnId: "turn-1" });
  await dispatcher.idle();
  await dispatcher.terminal({ id: "turn-1", status: "completed", itemsView: "full", items: [] });
  assert.deepEqual(operational, ["assistant_turn_started", "assistant_turn_steered", "assistant_turn_terminal"]);
  await dispatcher.stop();
});

test("turn/started binds an unresolved start before the same successful response", async () => {
  const { store, runner, dispatcher } = fixture();
  await dispatcher.accept(chat("first"));
  const clientId = runner.starts[0]!.params.clientUserMessageId;
  await dispatcher.started({ id: "turn-a", status: "inProgress", itemsView: "full", items: [{ type: "userMessage", clientId }] });
  assert.deepEqual({ phase: store.lease()?.phase, turnId: store.lease()?.turnId }, { phase: "active", turnId: "turn-a" });

  runner.starts[0]!.result.resolve({ turn: { id: "turn-a", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  assert.equal(store.membersForAttempt(store.lease()!.attemptId)[0]?.state, "submitted");
  assert.equal(store.lease()?.steerPaused, false);
  await dispatcher.stop();
});

test("turn/started remains authoritative when the pending start response rejects", async () => {
  const { store, runner, dispatcher } = fixture();
  await dispatcher.accept(chat("first"));
  const clientId = runner.starts[0]!.params.clientUserMessageId;
  await dispatcher.started({ id: "turn-a", status: "inProgress", itemsView: "full", items: [{ type: "userMessage", clientId }] });

  runner.starts[0]!.result.reject(new Error("response lost"));
  await dispatcher.idle();
  assert.deepEqual({ phase: store.lease()?.phase, turnId: store.lease()?.turnId }, { phase: "active", turnId: "turn-a" });
  assert.equal(store.membersForAttempt(store.lease()!.attemptId)[0]?.state, "submitted");
  await dispatcher.stop();
});

test("a correlated completion waits for the authoritative start response before terminalizing", async () => {
  const deferred: string[] = [];
  let deferredCommit: Promise<unknown> | undefined;
  const { store, pool, runner, dispatcher } = fixture(1, { onDeferredTerminal: (turn) => {
    deferred.push(turn.id);
    const terminal = {
      id: turn.id,
      status: turn.status,
      itemsView: turn.itemsView,
      items: turn.items.map((item) => ({ ...item })) as Array<Record<string, unknown>>,
    };
    deferredCommit = commitAssistantTerminalFinals(
      terminal,
      async () => [{
        ...terminal, itemsView: "full" as const,
        items: [{ type: "agentMessage", id: "old-final", text: "old answer", phase: "final_answer" }],
      }],
      () => undefined,
    );
  } });
  const markedTerminal: string[] = [];
  const markTurnTerminal = pool.markTurnTerminal.bind(pool);
  pool.markTurnTerminal = (endpointId, threadId, turnId) => {
    markedTerminal.push(turnId);
    markTurnTerminal(endpointId, threadId, turnId);
  };
  await dispatcher.accept(chat("first"));
  const clientId = runner.starts[0]!.params.clientUserMessageId;
  await dispatcher.terminal({ id: "turn-a", status: "completed", itemsView: "summary", items: [{ type: "userMessage", clientId }] });
  assert.deepEqual({ phase: store.lease()?.phase, turnId: store.lease()?.turnId }, { phase: "starting", turnId: undefined });
  assert.deepEqual(deferred, []);
  assert.deepEqual(markedTerminal, []);

  runner.starts[0]!.result.resolve({ turn: { id: "turn-a", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  assert.deepEqual({ phase: store.lease()?.phase, turnId: store.lease()?.turnId }, { phase: "terminalizing", turnId: "turn-a" });
  assert.equal(store.membersForAttempt(store.lease()!.attemptId)[0]?.state, "submitted");
  assert.deepEqual(deferred, ["turn-a"]);
  assert.deepEqual(markedTerminal, ["turn-a"]);
  await deferredCommit;
  await dispatcher.stop();
});

test("a client-correlated reconstructed completion cannot replace the live start response", async () => {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const store = new ConversationStore(db, deliveries);
  const endpoint: AppServerEndpoint = { id: "assistant-local", state: "ready", request: async () => { throw new Error("unused"); } };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  const runner = new FakeRunner();
  const runtime = new AssistantRuntime(db, new OperationStore(db), deliveries, { binding: route("chat-1") });
  const dispatcher = new ConversationDispatcher(store, pool, runner, {
    endpointId: "assistant-local", threadId: "assistant", runtimeObserver: runtime, retryMs: 10,
  });
  await dispatcher.accept(chat("first"));
  await dispatcher.accept(chat("outsider", "chat-2"));
  const clientId = runner.starts[0]!.params.clientUserMessageId;

  await dispatcher.terminal({
    id: "rollout-2061", status: "completed", itemsView: "full", items: [{ type: "userMessage", clientId }],
  });
  assert.deepEqual({ phase: store.lease()?.phase, turnId: store.lease()?.turnId }, { phase: "starting", turnId: undefined });
  assert.equal(store.membersForAttempt(store.lease()!.attemptId)[0]?.state, "uncertain");
  assert.equal(store.lease()?.pauseReason, "unknown_terminal_observed");
  assert.equal(runtime.current()?.contextId, "first");

  runner.starts[0]!.result.resolve({ turn: { id: "turn-live", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  assert.deepEqual({ phase: store.lease()?.phase, turnId: store.lease()?.turnId }, { phase: "active", turnId: "turn-live" });
  assert.equal(runtime.current()?.turnId, "turn-live");
  assert.equal(runner.steers.length, 0);
  assert.equal(db.prepare("SELECT state FROM source_contexts WHERE id = 'outsider'").get()!.state, "pending");
  await dispatcher.stop();
});

test("a notification-bound start rejects a later mismatched response without overwriting or pumping", async () => {
  const { store, runner, dispatcher } = fixture();
  await dispatcher.accept(chat("first"));
  const clientId = runner.starts[0]!.params.clientUserMessageId;
  await dispatcher.started({ id: "turn-a", status: "inProgress", itemsView: "full", items: [{ type: "userMessage", clientId }] });
  await dispatcher.accept(chat("follow-up"));

  runner.starts[0]!.result.resolve({ turn: { id: "turn-b", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  assert.equal(store.lease()?.turnId, "turn-a");
  assert.equal(store.lease()?.steerPaused, true);
  assert.equal(runner.steers.length, 0);
  await dispatcher.stop();
});

test("a real pool response mismatch pauses the notification-bound start", async () => {
  let resolveStart!: (value: { turn: TurnSnapshot }) => void;
  const endpoint: AppServerEndpoint = {
    id: "assistant-local", state: "ready",
    request: async <T>(method: string) => method === "turn/start"
      ? new Promise<T>((resolve) => { resolveStart = resolve as typeof resolveStart; })
      : { thread: { status: "active", turns: [] } } as T,
  };
  const db = createTestDatabase();
  const store = new ConversationStore(db, new DeliveryStore(db));
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  const steers: TurnSteerParams[] = [];
  const runner: AssistantTurnPort = {
    start: (params, claim) => pool.startTurn("assistant-local", { ...params }, claim),
    steer: async (params) => { steers.push(params); return { turnId: params.expectedTurnId }; },
    readThread: async () => ({ status: "active", turns: [] }),
  };
  const operational: string[] = [];
  const dispatcher = new ConversationDispatcher(store, pool, runner, {
    endpointId: "assistant-local", threadId: "assistant",
    onOperationalEvent: (event) => { operational.push(event); },
  });
  await dispatcher.accept(chat("first"));
  const clientId = store.lease()!.clientUserMessageId;
  await dispatcher.started({ id: "turn-a", status: "inProgress", itemsView: "full", items: [{ type: "userMessage", clientId }] });
  await dispatcher.accept(chat("follow-up"));
  resolveStart({ turn: { id: "turn-b", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();

  assert.equal(store.lease()?.turnId, "turn-a");
  assert.equal(store.lease()?.steerPaused, true);
  assert.equal(steers.length, 0);
  assert.ok(operational.includes("assistant_submission_uncertain"));
  await dispatcher.stop();
});

test("retrying a restored source uses a new native submission identity", async () => {
  const { db, deliveries, runner, dispatcher } = fixture();
  const runtime = new AssistantRuntime(db, new OperationStore(db), deliveries, { binding: route("chat-1") });
  await dispatcher.accept(chat("first"));
  const firstClientId = runner.starts[0]?.params.clientUserMessageId;
  runner.starts[0]!.result.resolve({ turn: { id: "interrupted", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  await dispatcher.terminal({ id: "interrupted", status: "interrupted", itemsView: "full", items: [] });
  runtime.handleTerminal("interrupted", "interrupted");

  await dispatcher.enqueueInternal("retry");
  await waitFor(() => runner.starts.length === 2);
  assert.notEqual(runner.starts[1]?.params.clientUserMessageId, firstClientId);
  runner.starts[1]!.result.resolve({ turn: { id: "retry", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  await dispatcher.stop();
});

test("startup recovery retries a terminal lease until authoritative history is available", async () => {
  const { store, pool, runner, dispatcher } = fixture();
  await dispatcher.accept(chat("first"));
  runner.starts[0]!.result.resolve({ turn: { id: "terminal", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  await dispatcher.terminal({ id: "terminal", status: "interrupted", itemsView: "full", items: [] });
  await dispatcher.stop();

  const recovered: TurnSnapshot[] = [];
  const recoveryRunner = new FakeRunner();
  recoveryRunner.history = {
    status: "idle",
    turns: [{ id: "terminal", status: "interrupted", itemsView: "full", items: [] }],
  };
  recoveryRunner.readThread = async () => {
    recoveryRunner.historyReads += 1;
    if (recoveryRunner.historyReads === 1) return { status: { type: "notLoaded" }, turns: [] };
    if (recoveryRunner.historyReads === 2) throw new Error("transient thread read failure");
    return recoveryRunner.history;
  };
  const recoveredDispatcher = new ConversationDispatcher(store, pool, recoveryRunner, {
    endpointId: "assistant-local",
    threadId: "assistant",
    retryMs: 0,
    onDeferredTerminal: (turn) => { recovered.push(turn); },
  });

  await recoveredDispatcher.recover();
  await waitFor(() => recovered.length === 1);
  assert.equal(recoveryRunner.historyReads, 3);
  assert.equal(recovered[0]?.id, "terminal");
  await recoveredDispatcher.stop();
});

test("requested recovery coalesces on the existing timer and stop cancels a pending wake", async () => {
  const { runner, dispatcher } = fixture();
  await dispatcher.accept(chat("first"));
  runner.starts[0]!.result.resolve({ turn: { id: "terminal", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  await dispatcher.terminal({ id: "terminal", status: "completed", itemsView: "full", items: [] });
  runner.history = {
    status: "idle",
    turns: [{ id: "terminal", status: "completed", itemsView: "full", items: [] }],
  };

  dispatcher.requestRecovery();
  dispatcher.requestRecovery();
  await waitFor(() => runner.historyReads === 1);
  await dispatcher.idle();
  assert.equal(runner.historyReads, 1);

  dispatcher.requestRecovery();
  await dispatcher.stop();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(runner.historyReads, 1);
});

test("stop awaits an active authoritative recovery read without a time bound", async () => {
  const { runner, dispatcher } = fixture();
  await dispatcher.accept(chat("first"));
  runner.starts[0]!.result.resolve({ turn: { id: "terminal", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  await dispatcher.terminal({ id: "terminal", status: "completed", itemsView: "full", items: [] });
  const history = deferred<ThreadSnapshot>();
  runner.readThread = () => {
    runner.historyReads += 1;
    return history.promise;
  };

  dispatcher.requestRecovery();
  await waitFor(() => runner.historyReads === 1);
  let stopped = false;
  const stopping = dispatcher.stop().then(() => { stopped = true; });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, false);
  history.resolve({
    status: "idle",
    turns: [{ id: "terminal", status: "completed", itemsView: "full", items: [] }],
  });
  await stopping;
  assert.equal(stopped, true);
});

test("startup recovery retains history-only identity until an authoritative started notification", async () => {
  const { store, pool, runner, dispatcher } = fixture();
  await dispatcher.accept(chat("first"));
  const clientId = runner.starts[0]!.params.clientUserMessageId;
  const stopping = dispatcher.stop();
  runner.starts[0]!.result.reject(new Error("transport stopped"));
  await stopping;
  assert.equal(store.membersForAttempt(store.lease()!.attemptId)[0]?.state, "uncertain");

  const recoveryRunner = new FakeRunner();
  recoveryRunner.history = {
    status: "active",
    turns: [{ id: "recovered", status: "inProgress", itemsView: "full", items: [{ type: "userMessage", clientId }] }],
  };
  recoveryRunner.readThread = async () => {
    recoveryRunner.historyReads += 1;
    if (recoveryRunner.historyReads === 1) {
      return { status: "active", turns: [{ id: "other", status: "inProgress", itemsView: "summary", items: [] }] };
    }
    if (recoveryRunner.historyReads === 2) throw new Error("transient thread read failure");
    return recoveryRunner.history;
  };
  const recoveredDispatcher = new ConversationDispatcher(store, pool, recoveryRunner, {
    endpointId: "assistant-local",
    threadId: "assistant",
    retryMs: 0,
  });

  await recoveredDispatcher.recover();
  await waitFor(() => recoveryRunner.historyReads >= 3);
  await recoveredDispatcher.started({
    id: "recovered", status: "inProgress", itemsView: "full", items: [{ type: "userMessage", clientId }],
  });
  await waitFor(() => store.membersForAttempt(store.lease()!.attemptId)[0]?.state === "submitted");
  assert.ok(recoveryRunner.historyReads >= 3);
  assert.equal(store.lease()?.turnId, "recovered");
  await recoveredDispatcher.stop();
});

test("a stale overlapping recovery read cannot overwrite newer authoritative correlation", async () => {
  const { store, pool, runner, dispatcher } = fixture();
  await dispatcher.accept(chat("first"));
  const clientId = runner.starts[0]!.params.clientUserMessageId;
  const stopping = dispatcher.stop();
  runner.starts[0]!.result.reject(new Error("transport stopped"));
  await stopping;

  const older = deferred<ThreadSnapshot>();
  const newer = deferred<ThreadSnapshot>();
  const reads = [older, newer];
  const recoveryRunner = new FakeRunner();
  recoveryRunner.readThread = () => {
    recoveryRunner.historyReads += 1;
    return reads[recoveryRunner.historyReads - 1]!.promise;
  };
  const recoveredDispatcher = new ConversationDispatcher(store, pool, recoveryRunner, {
    endpointId: "assistant-local",
    threadId: "assistant",
  });

  await recoveredDispatcher.recover();
  await waitFor(() => recoveryRunner.historyReads === 1);
  await recoveredDispatcher.recover();
  await waitFor(() => recoveryRunner.historyReads === 2);
  newer.resolve({
    status: "active",
    turns: [{ id: "recovered", status: "inProgress", itemsView: "full", items: [{ type: "userMessage", clientId }] }],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await recoveredDispatcher.started({
    id: "recovered", status: "inProgress", itemsView: "full", items: [{ type: "userMessage", clientId }],
  });
  await waitFor(() => store.membersForAttempt(store.lease()!.attemptId)[0]?.state === "submitted");
  older.resolve({ status: "idle", turns: [] });
  await recoveredDispatcher.idle();

  assert.equal(store.membersForAttempt(store.lease()!.attemptId)[0]?.state, "submitted");
  assert.equal(store.lease()?.turnId, "recovered");
  await recoveredDispatcher.stop();
});

test("recovery cannot prove absence while a native start is still in flight", async () => {
  const { store, pool } = fixture();
  store.acceptChatSource(chat("first"));
  const claim = pool.claimTurnCapacity("assistant-local", "assistant", "recovered-start");
  store.acquireLease({ kind: "chat", contextId: "first" }, claim.id);
  const recoveryRunner = new FakeRunner();
  recoveryRunner.history = { status: "idle", turns: [] };
  const recoveredDispatcher = new ConversationDispatcher(store, pool, recoveryRunner, {
    endpointId: "assistant-local",
    threadId: "assistant",
    retryMs: 100,
  });

  await recoveredDispatcher.recover();
  assert.equal(recoveryRunner.starts.length, 1);
  await recoveredDispatcher.recover();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recoveryRunner.historyReads, 0);
  recoveryRunner.starts[0]!.result.resolve({ turn: { id: "late-start", status: "inProgress", itemsView: "full", items: [] } });
  await recoveredDispatcher.idle();

  assert.equal(store.lease()?.phase, "active");
  assert.equal(store.lease()?.turnId, "late-start");
  assert.equal(store.membersForAttempt(store.lease()!.attemptId)[0]?.state, "submitted");
  await recoveredDispatcher.stop();
});

test("recovery waits until an immediate native start response is durably committed", async () => {
  const { store, pool } = fixture();
  store.acceptChatSource(chat("first"));
  const claim = pool.claimTurnCapacity("assistant-local", "assistant", "immediate-recovered-start");
  store.acquireLease({ kind: "chat", contextId: "first" }, claim.id);
  let historyReads = 0;
  const runner: AssistantTurnPort = {
    start: async () => ({ turn: { id: "immediate-start", status: "inProgress", itemsView: "full", items: [] } }),
    steer: async () => { throw new Error("unused"); },
    readThread: async () => { historyReads += 1; return { status: "idle", turns: [] }; },
  };
  const recoveredDispatcher = new ConversationDispatcher(store, pool, runner, {
    endpointId: "assistant-local",
    threadId: "assistant",
    retryMs: 100,
  });

  await recoveredDispatcher.recover();
  await recoveredDispatcher.recover();
  await recoveredDispatcher.idle();

  assert.equal(historyReads, 0);
  assert.equal(store.lease()?.phase, "active");
  assert.equal(store.lease()?.turnId, "immediate-start");
  await recoveredDispatcher.stop();
});

test("a synchronous native start failure remains fenced until durable reconciliation", async () => {
  const { store, pool } = fixture();
  store.acceptChatSource(chat("first"));
  const claim = pool.claimTurnCapacity("assistant-local", "assistant", "sync-failed-start");
  const lease = store.acquireLease({ kind: "chat", contextId: "first" }, claim.id);
  let historyReads = 0;
  const runner: AssistantTurnPort = {
    start: () => { throw new Error("synchronous start failure"); },
    steer: async () => { throw new Error("unused"); },
    readThread: async () => {
      historyReads += 1;
      return {
        status: "active",
        turns: [{ id: "recovered", status: "inProgress", itemsView: "full", items: [{ type: "userMessage", clientId: lease.clientUserMessageId }] }],
      };
    },
  };
  const recoveredDispatcher = new ConversationDispatcher(store, pool, runner, {
    endpointId: "assistant-local",
    threadId: "assistant",
    retryMs: 100,
  });

  await recoveredDispatcher.recover();
  await recoveredDispatcher.recover();
  await recoveredDispatcher.idle();

  assert.equal(historyReads, 1);
  assert.equal(store.membersForAttempt(lease.attemptId)[0]?.state, "uncertain");
  assert.equal(store.lease()?.turnId, undefined);
  await recoveredDispatcher.started({
    id: "recovered", status: "inProgress", itemsView: "full", items: [{ type: "userMessage", clientId: lease.clientUserMessageId }],
  });
  assert.equal(store.membersForAttempt(lease.attemptId)[0]?.state, "submitted");
  assert.equal(store.lease()?.turnId, "recovered");
  await recoveredDispatcher.stop();
});

test("recovery-launched start keeps reconciling after ambiguous nested history", async () => {
  const { store, pool } = fixture();
  store.acceptChatSource(chat("first"));
  const claim = pool.claimTurnCapacity("assistant-local", "assistant", "recovered-ambiguous-start");
  const lease = store.acquireLease({ kind: "chat", contextId: "first" }, claim.id);
  const recoveryRunner = new FakeRunner();
  recoveryRunner.history = {
    status: "active",
    turns: [{ id: "recovered", status: "inProgress", itemsView: "full", items: [{ type: "userMessage", clientId: lease.clientUserMessageId }] }],
  };
  recoveryRunner.readThread = async () => {
    recoveryRunner.historyReads += 1;
    if (recoveryRunner.historyReads === 1) {
      return { status: "active", turns: [{ id: "other", status: "inProgress", itemsView: "summary", items: [] }] };
    }
    return recoveryRunner.history;
  };
  const recoveredDispatcher = new ConversationDispatcher(store, pool, recoveryRunner, {
    endpointId: "assistant-local",
    threadId: "assistant",
    retryMs: 0,
  });

  await recoveredDispatcher.recover();
  recoveryRunner.starts[0]!.result.reject(new Error("start outcome unknown"));
  await waitFor(() => recoveryRunner.historyReads >= 2);
  assert.equal(store.membersForAttempt(lease.attemptId)[0]?.state, "uncertain");
  await recoveredDispatcher.started({
    id: "recovered", status: "inProgress", itemsView: "full", items: [{ type: "userMessage", clientId: lease.clientUserMessageId }],
  });

  assert.ok(recoveryRunner.historyReads >= 2);
  assert.equal(store.lease()?.turnId, "recovered");
  await recoveredDispatcher.stop();
});

test("ordinary submission reconciliation is fenced from a newer recovery read", async () => {
  const { store, runner, dispatcher } = fixture();
  await dispatcher.accept(chat("first"));
  const clientId = runner.starts[0]!.params.clientUserMessageId;
  const older = deferred<ThreadSnapshot>();
  const newer = deferred<ThreadSnapshot>();
  const reads = [older, newer];
  runner.readThread = () => {
    runner.historyReads += 1;
    return reads[runner.historyReads - 1]!.promise;
  };

  runner.starts[0]!.result.reject(new Error("start outcome unknown"));
  await waitFor(() => runner.historyReads === 1);
  await dispatcher.recover();
  await waitFor(() => runner.historyReads === 2);
  newer.resolve({
    status: "active",
    turns: [{ id: "recovered", status: "inProgress", itemsView: "full", items: [{ type: "userMessage", clientId }] }],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await dispatcher.started({
    id: "recovered", status: "inProgress", itemsView: "full", items: [{ type: "userMessage", clientId }],
  });
  await waitFor(() => store.membersForAttempt(store.lease()!.attemptId)[0]?.state === "submitted");
  older.resolve({ status: "idle", turns: [] });
  await dispatcher.idle();

  assert.equal(store.membersForAttempt(store.lease()!.attemptId)[0]?.state, "submitted");
  assert.equal(store.lease()?.turnId, "recovered");
  await dispatcher.stop();
});

test("Slack origin is a separate derived input item and does not alter immutable owner text", async (context) => {
  const { db, runner, dispatcher } = fixture();
  context.after(() => dispatcher.stop());
  await dispatcher.accept({
    id: "slack-first",
    nativeSourceId: "T1:C1:1.1",
    binding: { adapterId: "slack", conversationKey: "slack:T1:thread:C1:1.0", destination: { workspaceId: "T1", channelId: "C1", threadTs: "1.0" } },
    rawText: "/pass exact",
    attachmentIds: [],
    receivedAt: 1,
  });
  assert.deepEqual(runner.starts[0]?.params.input, [
    { type: "text", text: "[slack C1 thread]", text_elements: [] },
    { type: "text", text: "/pass exact", text_elements: [] },
  ]);
  assert.equal(db.prepare("SELECT raw_text FROM source_contexts WHERE id = 'slack-first'").get()!.raw_text, "/pass exact");
  runner.starts[0]!.result.resolve({ turn: { id: "turn", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
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
  const deferred: string[] = [];
  const memberships: string[] = [];
  const { store, runner, dispatcher } = fixture(1, {
    onDeferredTerminal: (turn) => { deferred.push(turn.id); },
    membershipObserver: { notifyMembership: (contextId) => { memberships.push(contextId); } },
  });
  await dispatcher.accept(chat("first"));
  runner.starts[0]!.result.resolve({ turn: { id: "turn-1", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  await dispatcher.accept(chat("follow-up"));
  await dispatcher.terminal({ id: "turn-1", status: "completed", itemsView: "full", items: [] });
  assert.equal(store.lease()?.phase, "terminalizing");
  runner.steers[0]!.result.resolve({ turnId: "turn-1" });
  await dispatcher.idle();
  assert.equal(store.lease()?.phase, "terminalizing");
  assert.deepEqual(deferred, ["turn-1"]);
  assert.ok(memberships.includes("follow-up"));
  await dispatcher.stop();
});

test("terminal notification resumes after a late nonsteerable response restores the owner input", async () => {
  const deferred: string[] = [];
  const { db, store, runner, dispatcher } = fixture(1, { onDeferredTerminal: (turn) => { deferred.push(turn.id); } });
  await dispatcher.accept(chat("first"));
  runner.starts[0]!.result.resolve({ turn: { id: "turn-1", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  await dispatcher.accept(chat("follow-up"));
  await dispatcher.terminal({ id: "turn-1", status: "completed", itemsView: "full", items: [] });
  runner.steers[0]!.result.reject(new JsonRpcResponseError(-32000, "active turn cannot be steered", {
    codexErrorInfo: { activeTurnNotSteerable: { turnId: "turn-1" } },
  }));
  await dispatcher.idle();

  assert.equal(db.prepare("SELECT state FROM source_contexts WHERE id = 'follow-up'").get()!.state, "pending");
  assert.deepEqual({ phase: store.lease()?.phase, reason: store.lease()?.pauseReason }, { phase: "terminalizing", reason: "terminalizing" });
  assert.deepEqual(deferred, ["turn-1"]);
  await dispatcher.stop();
});

test("an empty completion after an admitted steer restores both chat sources", async () => {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const store = new ConversationStore(db, deliveries);
  const endpoint: AppServerEndpoint = { id: "assistant-local", state: "ready", request: async () => { throw new Error("unused"); } };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  const runner = new FakeRunner();
  const runtime = new AssistantRuntime(db, new OperationStore(db), deliveries, { binding: route("chat-1") });
  const finals = new FinalMessageStore(db);
  let deferredTerminal: Promise<void> | undefined;
  const dispatcher = new ConversationDispatcher(store, pool, runner, {
    endpointId: "assistant-local",
    threadId: "assistant",
    runtimeObserver: runtime,
    onDeferredTerminal: (turn) => {
      deferredTerminal = commitAssistantTerminalFinals(
        { ...turn, items: turn.items.map((item) => ({ ...item })) as Array<Record<string, unknown>> },
        async () => [{ ...turn, itemsView: "full" as const, items: [] }],
        (resolved) => {
          const messages = finals.persistTerminalTurn("assistant-local", "assistant", {
            ...resolved,
            completedAt: null,
            items: resolved.items as Array<{ type: string; id: string; text?: string; phase?: string | null }>,
          }, 10);
          runtime.handleTerminal(resolved.id, "completed", messages.map((message) => message.body).join("\n") || undefined);
        },
      );
    },
  });

  await dispatcher.accept(chat("first"));
  runner.starts[0]!.result.resolve({ turn: { id: "turn-empty", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  await dispatcher.accept(chat("follow-up"));
  await dispatcher.terminal({ id: "turn-empty", status: "completed", itemsView: "full", items: [] });
  runner.steers[0]!.result.resolve({ turnId: "turn-empty" });
  await waitFor(() => deferredTerminal !== undefined);
  await deferredTerminal;

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assistant_attempts WHERE state = 'failed'").get()!.n, 1);
  assert.deepEqual(
    db.prepare("SELECT state FROM assistant_attempt_sources WHERE attempt_id = (SELECT id FROM assistant_attempts WHERE turn_id = 'turn-empty') ORDER BY source_ordinal").all().map((row) => row.state),
    ["failed", "failed"],
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_contexts WHERE state = 'completed'").get()!.n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM logical_final_messages").get()!.n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE kind = 'assistant_final'").get()!.n, 0);
  const stopping = dispatcher.stop();
  runner.starts[1]?.result.reject(new Error("stopped"));
  await stopping;
});

test("a correlated started notification consumes a matching buffered early completion", async () => {
  const deferred: string[] = [];
  const { store, runner, dispatcher } = fixture(1, { onDeferredTerminal: (turn) => { deferred.push(turn.id); } });
  await dispatcher.accept(chat("first"));
  const clientId = runner.starts[0]!.params.clientUserMessageId;
  await dispatcher.terminal({ id: "turn-a", status: "completed", itemsView: "full", items: [] });
  await dispatcher.started({ id: "turn-a", status: "inProgress", itemsView: "full", items: [{ type: "userMessage", clientId }] });

  assert.deepEqual({ phase: store.lease()?.phase, turnId: store.lease()?.turnId }, { phase: "terminalizing", turnId: "turn-a" });
  assert.deepEqual(deferred, ["turn-a"]);
  runner.starts[0]!.result.resolve({ turn: { id: "turn-a", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  assert.deepEqual(deferred, ["turn-a"]);
  await dispatcher.stop();
});

test("unrelated early completion is cleared after successful start settlement", async () => {
  const { db, store, pool, runner, dispatcher } = fixture();
  const runtime = new AssistantRuntime(db, new OperationStore(db), new DeliveryStore(db), { binding: route("chat-1") });
  await dispatcher.accept(chat("first"));
  await dispatcher.terminal({ id: "turn-b", status: "completed", itemsView: "full", items: [] });
  runner.starts[0]!.result.resolve({ turn: { id: "turn-a", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  await dispatcher.terminal({ id: "turn-a", status: "completed", itemsView: "full", items: [] });
  runtime.handleTerminal("turn-a", "completed", "done");
  await dispatcher.accept(chat("second"));
  runner.starts[1]!.result.resolve({ turn: { id: "turn-b", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();

  assert.deepEqual({ phase: store.lease()?.phase, turnId: store.lease()?.turnId }, { phase: "active", turnId: "turn-b" });
  pool.markTurnTerminal("assistant-local", "assistant", "turn-b");
  await dispatcher.stop();
});

test("an early unknown completion survives failed start settlement without retransmission", async () => {
  const { db, store, pool, runner, dispatcher } = fixture();
  runner.history = { status: "idle", turns: [] };
  await dispatcher.accept(chat("first"));
  await dispatcher.terminal({ id: "turn-b", status: "completed", itemsView: "full", items: [] });
  runner.starts[0]!.result.reject(new Error("response lost"));
  await dispatcher.idle();
  await dispatcher.enqueueInternal("retry");
  await dispatcher.idle();

  assert.equal(runner.starts.length, 1);
  assert.equal(pool.activeTurnCount, 1);
  assert.deepEqual({ phase: store.lease()?.phase, turnId: store.lease()?.turnId, reason: store.lease()?.pauseReason }, {
    phase: "starting", turnId: undefined, reason: "unknown_terminal_observed",
  });
  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources").get()!.state, "uncertain");
  await dispatcher.stop();
});

test("a late correlated completion cannot mint an identity after the start response is lost", async () => {
  const { db, store, runner, dispatcher } = fixture();
  runner.history = { status: "active", turns: [] };
  await dispatcher.accept(chat("first"));
  const clientId = runner.starts[0]!.params.clientUserMessageId;
  runner.starts[0]!.result.reject(new Error("response lost"));
  await dispatcher.idle();

  await dispatcher.terminal({
    id: "rollout-late", status: "completed", itemsView: "full", items: [{ type: "userMessage", clientId }],
  });
  assert.deepEqual({ phase: store.lease()?.phase, turnId: store.lease()?.turnId, reason: store.lease()?.pauseReason }, {
    phase: "starting", turnId: undefined, reason: "unknown_terminal_observed",
  });
  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources").get()!.state, "uncertain");
  await dispatcher.stop();
});

test("a late completion wins over an in-flight idle-history absence proof", async () => {
  const { db, store, runner, dispatcher } = fixture();
  let readStarted!: () => void;
  let releaseRead!: (value: ThreadSnapshot) => void;
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  const blockedRead = new Promise<ThreadSnapshot>((resolve) => { releaseRead = resolve; });
  runner.readThread = async () => {
    runner.historyReads += 1;
    readStarted();
    return blockedRead;
  };
  await dispatcher.accept(chat("first"));
  const clientId = runner.starts[0]!.params.clientUserMessageId;
  runner.starts[0]!.result.reject(new Error("response lost"));
  await started;

  await dispatcher.terminal({
    id: "rollout-late", status: "completed", itemsView: "full", items: [{ type: "userMessage", clientId }],
  });
  releaseRead({ status: "idle", turns: [] });
  await dispatcher.idle();

  assert.equal(runner.starts.length, 1);
  assert.equal(runner.historyReads, 1);
  assert.deepEqual({ phase: store.lease()?.phase, turnId: store.lease()?.turnId, reason: store.lease()?.pauseReason }, {
    phase: "starting", turnId: undefined, reason: "unknown_terminal_observed",
  });
  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources").get()!.state, "uncertain");
  await dispatcher.stop();
});

test("unknown terminal evidence survives dispatcher reconstruction without recovery polling", async () => {
  const first = fixture();
  first.runner.history = { status: "idle", turns: [] };
  await first.dispatcher.accept(chat("first"));
  await first.dispatcher.terminal({ id: "turn-unknown", status: "completed", itemsView: "full", items: [] });
  first.runner.starts[0]!.result.reject(new Error("response lost"));
  await first.dispatcher.idle();
  await first.dispatcher.stop();

  const endpoint: AppServerEndpoint = { id: "assistant-local", state: "ready", request: async () => { throw new Error("unused"); } };
  const recoveredPool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  const recoveredRunner = new FakeRunner();
  recoveredRunner.history = { status: "idle", turns: [] };
  const recovered = new ConversationDispatcher(first.store, recoveredPool, recoveredRunner, {
    endpointId: "assistant-local", threadId: "assistant", retryMs: 10,
  });
  await recovered.recover();
  await recovered.idle();

  assert.equal(recoveredRunner.starts.length, 0);
  assert.equal(recoveredRunner.historyReads, 0);
  assert.deepEqual({ phase: first.store.lease()?.phase, reason: first.store.lease()?.pauseReason }, {
    phase: "starting", reason: "unknown_terminal_observed",
  });
  await recovered.stop();
});

test("direct terminal start paths account for one completed conversation period", async () => {
  const correlatedScheduler = new AssistantScheduler();
  let correlatedPeriods = 0;
  correlatedScheduler.noteConversationPeriodCompleted = () => { correlatedPeriods += 1; };
  const correlated = fixture(1, { scheduler: correlatedScheduler });
  await correlated.dispatcher.accept(chat("first"));
  const clientId = correlated.runner.starts[0]!.params.clientUserMessageId;
  await correlated.dispatcher.terminal({
    id: "turn-a", status: "completed", itemsView: "full", items: [{ type: "userMessage", clientId }],
  });
  assert.equal(correlatedPeriods, 0);
  correlated.runner.starts[0]!.result.resolve({ turn: { id: "turn-a", status: "inProgress", itemsView: "full", items: [] } });
  await correlated.dispatcher.idle();
  assert.equal(correlatedPeriods, 1);
  await correlated.dispatcher.stop();

  const responseScheduler = new AssistantScheduler();
  let responsePeriods = 0;
  responseScheduler.noteConversationPeriodCompleted = () => { responsePeriods += 1; };
  const response = fixture(1, { scheduler: responseScheduler });
  await response.dispatcher.accept(chat("first"));
  response.runner.starts[0]!.result.resolve({ turn: { id: "turn-b", status: "completed", itemsView: "full", items: [] } });
  await response.dispatcher.idle();
  assert.equal(responsePeriods, 1);
  await response.dispatcher.stop();
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
  const memberships: string[] = [];
  const { db, runner, dispatcher } = fixture(1, {
    onDeferredTerminal: (turn) => { deferred.push(turn); },
    membershipObserver: { notifyMembership: (contextId) => { memberships.push(contextId); } },
  });
  await dispatcher.accept(chat("first"));
  runner.starts[0]!.result.resolve({ turn: { id: "turn-1", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
  await dispatcher.accept(chat("follow-up"));
  const steerClientId = runner.steers[0]!.params.clientUserMessageId;
  const terminal = {
    id: "turn-1",
    status: "completed",
    itemsView: "full" as const,
    items: [{ type: "userMessage", clientId: steerClientId }],
  };
  runner.history = { status: "idle", turns: [terminal] };
  await dispatcher.terminal(terminal);
  runner.steers[0]!.result.reject(new Error("response lost"));
  await dispatcher.idle();

  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources WHERE context_id = 'follow-up'").get()!.state, "submitted");
  assert.deepEqual(deferred.map((turn) => turn.id), ["turn-1"]);
  assert.ok(memberships.includes("follow-up"));
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
    { type: "text", text: "[telegram]", text_elements: [] },
    { type: "text", text: "hello", text_elements: [] },
    attachments.toUserInput("first", image.id),
    attachments.toUserInput("first", document.id),
  ]);
  runner.starts[0]!.result.resolve({ turn: { id: "turn", status: "inProgress", itemsView: "full", items: [] } });
  await dispatcher.idle();
});

test("failed attachments are separate model input and never mutate owner text", async (context) => {
  const { db, runner, dispatcher } = fixture();
  context.after(() => dispatcher.stop());
  await dispatcher.accept({
    ...chat("first"),
    rawText: "/pass exact",
    failedAttachments: [{ nativeId: "F1", displayName: "missing.txt", reasonCode: "not_accessible" }],
  });
  assert.deepEqual(runner.starts[0]?.params.input, [
    { type: "text", text: "[telegram]", text_elements: [] },
    { type: "text", text: "/pass exact", text_elements: [] },
    { type: "text", text: "[Slack attachment unavailable: missing.txt]", text_elements: [] },
  ]);
  assert.equal(db.prepare("SELECT raw_text FROM source_contexts WHERE id = 'first'").get()!.raw_text, "/pass exact");
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

test("positive full-history correlation never mints an ambiguous start identity", async () => {
  const { db, pool, runner, dispatcher } = fixture();
  await dispatcher.accept(chat("first"));
  runner.history = {
    status: "active",
    turns: [{ id: "recovered-turn", status: "inProgress", itemsView: "full", items: [{ type: "userMessage", clientId: runner.starts[0]!.params.clientUserMessageId }] }],
  };
  runner.starts[0]!.result.reject(new Error("response lost"));
  await dispatcher.idle();
  assert.equal(runner.starts.length, 1);
  assert.equal(pool.activeTurnCount, 1);
  assert.equal(db.prepare("SELECT turn_id FROM assistant_turn_lease").get()!.turn_id, null);
  assert.equal(db.prepare("SELECT state FROM assistant_attempt_sources").get()!.state, "uncertain");
  await dispatcher.stop();
});

test("terminal history correlation cannot mint an identity or trigger finalization", async () => {
  const db = createTestDatabase();
  const store = new ConversationStore(db, new DeliveryStore(db));
  const endpoint: AppServerEndpoint = { id: "assistant-local", state: "ready", request: async () => { throw new Error("unused"); } };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  const runner = new FakeRunner();
  const terminal: TurnSnapshot[] = [];
  const dispatcher = new ConversationDispatcher(store, pool, runner, {
    endpointId: "assistant-local",
    threadId: "assistant",
    onDeferredTerminal: (turn) => { terminal.push(turn); },
  });
  await dispatcher.accept(chat("first"));
  runner.history = {
    status: "idle",
    turns: [{ id: "recovered-terminal", status: "completed", itemsView: "full", items: [{ type: "userMessage", clientId: runner.starts[0]!.params.clientUserMessageId }] }],
  };
  runner.starts[0]!.result.reject(new Error("response lost"));
  await dispatcher.idle();
  assert.deepEqual(terminal, []);
  assert.equal(store.lease()?.phase, "starting");
  assert.equal(store.lease()?.turnId, undefined);
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
  assert.match(runner.starts[0]!.params.clientUserMessageId, /^qiyan:attempt_[0-9a-f-]{36}:1$/u);
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
