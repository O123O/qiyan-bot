import assert from "node:assert/strict";
import test from "node:test";
import {
  acknowledgeWorkerSubscription,
  addOptimisticWorkerMessage,
  applyWorkerSnapshot,
  beginWorkerHistory,
  beginWorkerSubscription,
  drainWorkerRecoveryAfterAttempt,
  dequeueWorkerRecovery,
  failWorkerHistory,
  requeueWorkerRecovery,
  receiveWorkerEvent,
  type WorkerEventEnvelope,
} from "../../webui-client/src/worker-chat-stream.ts";

const ids = { nickname: "worker", requestId: "11111111-1111-4111-8111-111111111111", subscriptionId: "22222222-2222-4222-8222-222222222222" };
const envelope = (event: WorkerEventEnvelope["event"], override: Partial<WorkerEventEnvelope> = {}): WorkerEventEnvelope => ({ type: "worker/event", ...ids, event, ...override });

test("native user item replaces the correlated optimistic bubble", () => {
  let state = acknowledgeWorkerSubscription(beginWorkerSubscription("worker", "codex", ids.requestId), ids.subscriptionId);
  state = addOptimisticWorkerMessage(state, "to:web:input", "hello", 1);
  state = receiveWorkerEvent(state, envelope({ kind: "item-started", turnId: "turn", atMs: 2, item: { type: "user-message", id: "u1", clientId: "to:web:input", text: "hello" } }));
  assert.deepEqual(state.messages.map((message) => [message.id, message.body, message.optimistic]), [["u:turn:u1", "hello", false]]);
});

test("agent deltas accumulate into one draft and item completion replaces it authoritatively", () => {
  let state = acknowledgeWorkerSubscription(beginWorkerSubscription("worker", "codex", ids.requestId), ids.subscriptionId);
  state = receiveWorkerEvent(state, envelope({ kind: "agent-message-delta", turnId: "turn", itemId: "a1", delta: "work" }));
  state = receiveWorkerEvent(state, envelope({ kind: "agent-message-delta", turnId: "turn", itemId: "a1", delta: "ing" }));
  assert.deepEqual(state.messages.map((message) => [message.body, message.streaming]), [["working", true]]);
  state = receiveWorkerEvent(state, envelope({ kind: "item-completed", turnId: "turn", atMs: 3, item: { type: "agent-message", id: "a1", text: "complete", phase: "final_answer" } }));
  assert.deepEqual(state.messages.map((message) => [message.id, message.body, message.streaming, message.phase]), [["a:turn:a1", "complete", false, "final_answer"]]);
  state = receiveWorkerEvent(state, envelope({ kind: "agent-message-delta", turnId: "turn", itemId: "a1", delta: "duplicate" }));
  assert.equal(state.messages[0]!.body, "complete");
});

test("snapshot merge trusts terminal items and recovers only a true mid-turn join", () => {
  let state = acknowledgeWorkerSubscription(beginWorkerSubscription("worker", "codex", ids.requestId), ids.subscriptionId);
  state = beginWorkerHistory(state, true).state;
  state = receiveWorkerEvent(state, envelope({ kind: "turn-started", turnId: "observed" }));
  state = receiveWorkerEvent(state, envelope({ kind: "agent-message-delta", turnId: "observed", itemId: "a2", delta: "new" }));
  state = receiveWorkerEvent(state, envelope({ kind: "agent-message-delta", turnId: "joined", itemId: "a3", delta: "suffix" }));
  state = applyWorkerSnapshot(state, {
    messages: [
      { id: "a:done:a1", turnId: "done", body: "old", completedAt: 1, terminalStatus: "completed", phase: "commentary" },
      { id: "a:observed:a2", turnId: "observed", body: "possibly overlapping", completedAt: 2, terminalStatus: "inProgress" },
      { id: "a:joined:a3", turnId: "joined", body: "prefix", completedAt: 2, terminalStatus: "inProgress" },
    ],
    hasOlder: false,
    terminalTurnIds: ["done"],
    openTurnIds: ["observed", "joined"],
  });
  assert.deepEqual(state.messages.map((message) => [message.id, message.body]), [["a:done:a1", "old"], ["a:observed:a2", "new"], ["a:joined:a3", "suffix"]]);
  assert.deepEqual(state.recoveryTurnIds, ["joined"]);

  state = receiveWorkerEvent(state, envelope({ kind: "turn-completed", turnId: "observed" }));
  assert.deepEqual(state.pendingRecoveryTurnIds, []);
  state = receiveWorkerEvent(state, envelope({ kind: "turn-completed", turnId: "joined" }));
  assert.deepEqual(state.pendingRecoveryTurnIds, ["joined"]);
});

test("paging does not reclassify an already observed live turn as a mid-turn join", () => {
  let state = acknowledgeWorkerSubscription(beginWorkerSubscription("worker", "codex", ids.requestId), ids.subscriptionId);
  state = receiveWorkerEvent(state, envelope({ kind: "turn-started", turnId: "live" }));
  state = beginWorkerHistory(state, false).state;
  state = applyWorkerSnapshot(state, { messages: [], hasOlder: true, terminalTurnIds: [], openTurnIds: ["live"] });
  assert.deepEqual(state.recoveryTurnIds, []);
});

test("a failed initial snapshot releases buffered live events instead of stranding them", () => {
  let state = acknowledgeWorkerSubscription(beginWorkerSubscription("worker", "codex", ids.requestId), ids.subscriptionId);
  state = beginWorkerHistory(state, true).state;
  state = receiveWorkerEvent(state, envelope({ kind: "agent-message-delta", turnId: "live", itemId: "a", delta: "still visible" }));
  state = failWorkerHistory(state);
  assert.equal(state.snapshotPending, false);
  assert.deepEqual(state.messages.map((message) => message.body), ["still visible"]);
  assert.deepEqual(state.bufferedEvents, []);
});

test("completion recovery queues behind paging for Claude and joined Codex turns", () => {
  let claude = acknowledgeWorkerSubscription(beginWorkerSubscription("worker", "claude", ids.requestId), ids.subscriptionId);
  claude = beginWorkerHistory(claude, false).state;
  claude = receiveWorkerEvent(claude, envelope({ kind: "turn-completed", turnId: "fast" }));
  assert.equal(claude.historyInFlight, true);
  assert.deepEqual(claude.pendingRecoveryTurnIds, ["fast"]);
  assert.equal(dequeueWorkerRecovery({ ...claude, historyInFlight: false }).turnId, "fast");

  let codex = acknowledgeWorkerSubscription(beginWorkerSubscription("worker", "codex", ids.requestId), ids.subscriptionId);
  codex = { ...codex, recoveryTurnIds: ["joined"] };
  codex = beginWorkerHistory(codex, false).state;
  codex = receiveWorkerEvent(codex, envelope({ kind: "turn-completed", turnId: "joined" }));
  assert.equal(dequeueWorkerRecovery({ ...codex, historyInFlight: false }).turnId, "joined");
});

test("exhausting one recovery attempt drains the next queued completed turn", () => {
  const state = {
    ...acknowledgeWorkerSubscription(beginWorkerSubscription("worker", "claude", ids.requestId), ids.subscriptionId),
    pendingRecoveryTurnIds: ["first", "second"],
  };
  const waiting = drainWorkerRecoveryAfterAttempt(state, "first", true);
  assert.equal(waiting.turnId, undefined);
  assert.deepEqual(waiting.state.pendingRecoveryTurnIds, ["first", "second"]);

  const exhausted = drainWorkerRecoveryAfterAttempt(state, "first", false);
  assert.equal(exhausted.turnId, "second");
  assert.deepEqual(exhausted.state.pendingRecoveryTurnIds, []);
});

test("recovery is complete only after the native snapshot proves the turn terminal", () => {
  let state = acknowledgeWorkerSubscription(beginWorkerSubscription("worker", "claude", ids.requestId), ids.subscriptionId);
  state = { ...state, pendingRecoveryTurnIds: ["turn"] };
  state = applyWorkerSnapshot(state, { messages: [], hasOlder: false, terminalTurnIds: [], openTurnIds: [] }, "turn");
  assert.deepEqual(state.recoveredTurnIds, []);
  assert.deepEqual(state.pendingRecoveryTurnIds, ["turn"]);

  state = applyWorkerSnapshot(state, {
    messages: [{ id: "a:turn:a", turnId: "turn", body: "complete", completedAt: 2, terminalStatus: "completed", turnOrder: 0, itemOrder: 0 }],
    hasOlder: false, terminalTurnIds: ["turn"], openTurnIds: [],
  }, "turn");
  assert.deepEqual(state.recoveredTurnIds, ["turn"]);
  assert.deepEqual(state.pendingRecoveryTurnIds, []);

  state = requeueWorkerRecovery({ ...state, recoveredTurnIds: [] }, "retry");
  assert.deepEqual(state.pendingRecoveryTurnIds, ["retry"]);
});

test("a long recovered turn advances paging so omitted target rows remain reachable", () => {
  let state = acknowledgeWorkerSubscription(beginWorkerSubscription("worker", "claude", ids.requestId), ids.subscriptionId);
  state = { ...state, historyLoaded: true, hasOlder: true, olderCursor: "pre-recovery-cursor", pendingRecoveryTurnIds: ["long"] };
  const messages = Array.from({ length: 20 }, (_, index) => ({
    id: `a:long:a${index + 10}`, turnId: "long", body: `item-${index + 10}`,
    completedAt: 2, terminalStatus: "completed", turnOrder: 1, itemOrder: index + 10,
  }));
  state = applyWorkerSnapshot(state, {
    messages, hasOlder: true, nextCursor: "recovery-cursor", terminalTurnIds: ["long"], openTurnIds: [],
  }, "long");
  assert.deepEqual(state.messages.map((message) => message.body), messages.map((message) => message.body));
  assert.equal(state.olderCursor, "recovery-cursor", "scroll-up must begin before the newest recovery page");
  assert.equal(state.hasOlder, true);
  assert.deepEqual(state.recoveredTurnIds, ["long"]);
});

test("buffer replay cannot downgrade terminal items and recovered items keep native order", () => {
  let state = acknowledgeWorkerSubscription(beginWorkerSubscription("worker", "codex", ids.requestId), ids.subscriptionId);
  state = beginWorkerHistory(state, true).state;
  state = receiveWorkerEvent(state, envelope({ kind: "item-started", turnId: "turn", item: { type: "agent-message", id: "a1", text: "partial" } }));
  state = receiveWorkerEvent(state, envelope({ kind: "item-completed", turnId: "turn", item: { type: "agent-message", id: "a2", text: "later" } }));
  state = applyWorkerSnapshot(state, {
    messages: [
      { id: "a:turn:a1", turnId: "turn", body: "earlier", completedAt: 2, terminalStatus: "completed", turnOrder: 0, itemOrder: 0 },
      { id: "a:turn:a2", turnId: "turn", body: "later", completedAt: 2, terminalStatus: "completed", turnOrder: 0, itemOrder: 1 },
    ],
    hasOlder: false, terminalTurnIds: ["turn"], openTurnIds: [],
  });
  assert.deepEqual(state.messages.map((message) => [message.id, message.body, message.streaming, message.itemOrder]), [
    ["a:turn:a1", "earlier", false, 0], ["a:turn:a2", "later", false, 1],
  ]);
});

test("stale events are ignored and the pre-snapshot buffer is bounded", () => {
  let state = acknowledgeWorkerSubscription(beginWorkerSubscription("worker", "codex", ids.requestId), ids.subscriptionId);
  state = beginWorkerHistory(state, true).state;
  const stale = receiveWorkerEvent(state, envelope({ kind: "agent-message-delta", turnId: "t", itemId: "a", delta: "bad" }, { subscriptionId: crypto.randomUUID() }));
  assert.deepEqual(stale, state);
  const huge = "x".repeat(1024 * 1024 + 1);
  state = receiveWorkerEvent(state, envelope({ kind: "agent-message-delta", turnId: "t", itemId: "a", delta: huge }));
  assert.equal(state.overflow, true);
  assert.deepEqual(state.bufferedEvents, []);
});
