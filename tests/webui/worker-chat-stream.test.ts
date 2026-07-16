import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  retainWorkerDraftMessages,
  storeWorkerDraftMessages,
  takeWorkerDraftMessages,
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

test("switching away and back retains only the running turn transcript", () => {
  let state = acknowledgeWorkerSubscription(beginWorkerSubscription("worker", "codex", ids.requestId), ids.subscriptionId);
  state = applyWorkerSnapshot(state, {
    messages: [{ id: "a:done:a1", turnId: "done", body: "old", completedAt: 1, terminalStatus: "completed", turnOrder: 0, itemOrder: 0 }],
    hasOlder: false, terminalTurnIds: ["done"], openTurnIds: [],
  });
  state = receiveWorkerEvent(state, envelope({ kind: "item-completed", turnId: "running", item: { type: "user-message", id: "u1", text: "question" } }));
  state = receiveWorkerEvent(state, envelope({ kind: "agent-message-delta", turnId: "running", itemId: "a2", delta: "working" }));

  const retained = retainWorkerDraftMessages(state);
  const restored = beginWorkerSubscription("worker", "codex", crypto.randomUUID(), retained);

  assert.deepEqual(restored.messages.map((message) => [message.body, message.streaming]), [
    ["question", false],
    ["working", true],
  ]);
});

test("a fresh snapshot prunes retained rows that belong to a replaced worker", () => {
  let old = acknowledgeWorkerSubscription(beginWorkerSubscription("worker", "codex", ids.requestId), ids.subscriptionId);
  old = receiveWorkerEvent(old, envelope({ kind: "item-completed", turnId: "old-turn", item: { type: "user-message", id: "u1", text: "old question" } }));
  const retained = retainWorkerDraftMessages(old);
  let replacement = beginWorkerSubscription("worker", "codex", crypto.randomUUID(), retained);
  replacement = applyWorkerSnapshot(replacement, { messages: [], hasOlder: false, terminalTurnIds: [], openTurnIds: [] });
  assert.deepEqual(replacement.messages, []);
  assert.deepEqual(replacement.retainedMessageIds, []);
});

test("a replacement mapping cannot inherit an optimistic row", () => {
  let old = beginWorkerSubscription("worker", "codex", ids.requestId, [], "mapping-old");
  old = addOptimisticWorkerMessage(old, "to:web:old", "old question", 1);
  const cache = new Map();
  storeWorkerDraftMessages(cache, old);
  assert.deepEqual(takeWorkerDraftMessages(cache, "worker", "mapping-new"), []);

  let restored = beginWorkerSubscription("worker", "codex", crypto.randomUUID(), retainWorkerDraftMessages(old), "mapping-old");
  restored = addOptimisticWorkerMessage(restored, "to:web:fresh", "new question", 2);
  const rebound = acknowledgeWorkerSubscription(restored, crypto.randomUUID(), "mapping-new");
  assert.deepEqual(rebound.messages.map((message) => [message.clientId, message.body]), [["to:web:fresh", "new question"]]);
  assert.deepEqual(rebound.retainedMessageIds, []);
});

test("the selected panel resubscribes when its mapping identity changes", async () => {
  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /const selectedMappingId = selected === null \? null : sessions\.find\([^;]+\?\.mappingId \?\? null;/u);
  assert.match(source, /\}, \[selected, selectedMappingId, subscribeWorker, loadDir\]\);/u);
  assert.match(source, /active\?\.nickname === target && active\.mappingId === mappingId/u);
});

test("terminal proof drops a retained partial item omitted from the bounded page", () => {
  const retained = [{
    id: "a:turn:a", turnId: "turn", body: "partial", completedAt: 1,
    terminalStatus: "", role: "worker" as const, streaming: true, optimistic: false,
  }];
  let state = beginWorkerSubscription("worker", "codex", ids.requestId, retained);
  state = applyWorkerSnapshot(state, { messages: [], hasOlder: true, terminalTurnIds: ["turn"], openTurnIds: [] });
  assert.deepEqual(state.messages, []);
});

test("inactive worker drafts use a byte-bounded four-worker LRU", () => {
  const cache = new Map();
  for (let index = 0; index < 5; index += 1) {
    const state = {
      ...beginWorkerSubscription(`worker-${index}`, "codex", crypto.randomUUID()),
      messages: [{
        id: `a:turn-${index}:a`, turnId: `turn-${index}`, body: "draft", completedAt: index,
        terminalStatus: "", role: "worker" as const, streaming: true, optimistic: false,
      }],
    };
    storeWorkerDraftMessages(cache, state);
  }
  assert.equal(cache.size, 4);
  assert.deepEqual(takeWorkerDraftMessages(cache, "worker-0", ""), []);
  assert.deepEqual(takeWorkerDraftMessages(cache, "worker-4", "").map((message) => message.body), ["draft"]);
  assert.equal(cache.size, 3);

  const oversized = {
    ...beginWorkerSubscription("huge", "codex", crypto.randomUUID()),
    messages: [{
      id: "a:huge:a", turnId: "huge", body: "x".repeat(512 * 1024), completedAt: 1,
      terminalStatus: "", role: "worker" as const, streaming: true, optimistic: false,
    }],
  };
  storeWorkerDraftMessages(cache, oversized);
  assert.deepEqual(takeWorkerDraftMessages(cache, "huge", ""), []);

  cache.clear();
  for (let index = 0; index < 3; index += 1) {
    const state = {
      ...beginWorkerSubscription(`large-${index}`, "codex", crypto.randomUUID()),
      messages: [{
        id: `a:large-${index}:a`, turnId: `large-${index}`, body: "x".repeat(400 * 1024), completedAt: index,
        terminalStatus: "", role: "worker" as const, streaming: true, optimistic: false,
      }],
    };
    storeWorkerDraftMessages(cache, state);
  }
  assert.equal(cache.size, 2);
  assert.deepEqual(takeWorkerDraftMessages(cache, "large-0", ""), []);
});

test("snapshot merge trusts terminal items and recovers only a true mid-turn join", () => {
  let state = acknowledgeWorkerSubscription(beginWorkerSubscription("worker", "codex", ids.requestId), ids.subscriptionId);
  state = beginWorkerHistory(state, true).state;
  state = receiveWorkerEvent(state, envelope({ kind: "turn-started", turnId: "observed" }));
  state = receiveWorkerEvent(state, envelope({ kind: "agent-message-delta", turnId: "observed", itemId: "a4", delta: "new" }));
  state = receiveWorkerEvent(state, envelope({ kind: "agent-message-delta", turnId: "joined", itemId: "a5", delta: "suffix" }));
  state = applyWorkerSnapshot(state, {
    messages: [
      { id: "a:done:a1", turnId: "done", body: "old", completedAt: 1, terminalStatus: "completed", phase: "commentary" },
      { id: "a:observed:a2", turnId: "observed", body: "completed while loading", completedAt: 2, terminalStatus: "inProgress" },
      { id: "a:joined:a3", turnId: "joined", body: "earlier", completedAt: 2, terminalStatus: "inProgress" },
    ],
    hasOlder: false,
    terminalTurnIds: ["done"],
    openTurnIds: ["observed", "joined"],
  });
  assert.deepEqual(state.messages.map((message) => [message.id, message.body]), [
    ["a:done:a1", "old"],
    ["a:observed:a2", "completed while loading"],
    ["a:joined:a3", "earlier"],
    ["a:observed:a4", "new"],
    ["a:joined:a5", "suffix"],
  ]);
  assert.deepEqual(state.recoveryTurnIds, ["joined"]);

  state = receiveWorkerEvent(state, envelope({ kind: "turn-completed", turnId: "observed" }));
  assert.deepEqual(state.pendingRecoveryTurnIds, []);
  state = receiveWorkerEvent(state, envelope({ kind: "turn-completed", turnId: "joined" }));
  assert.deepEqual(state.pendingRecoveryTurnIds, ["joined"]);
});

test("initial snapshot shows items from a turn that started before the panel subscribed", () => {
  let state = acknowledgeWorkerSubscription(beginWorkerSubscription("worker", "codex", ids.requestId), ids.subscriptionId);
  state = beginWorkerHistory(state, true).state;
  state = applyWorkerSnapshot(state, {
    messages: [
      { id: "u:joined:u1", turnId: "joined", body: "latest question", completedAt: 1, terminalStatus: "inProgress", role: "you", turnOrder: 0, itemOrder: 0 },
      { id: "a:joined:a1", turnId: "joined", body: "latest update", completedAt: 1, terminalStatus: "inProgress", phase: "commentary", turnOrder: 0, itemOrder: 1 },
    ],
    hasOlder: false, terminalTurnIds: [], openTurnIds: ["joined"],
  });

  assert.deepEqual(state.messages.map((message) => [message.id, message.body, message.terminalStatus, message.streaming]), [
    ["u:joined:u1", "latest question", "", false],
    ["a:joined:a1", "latest update", "", false],
  ]);
  assert.deepEqual(state.recoveryTurnIds, ["joined"]);
});

test("open snapshot reconciles by item identity instead of message text", () => {
  let state = acknowledgeWorkerSubscription(beginWorkerSubscription("worker", "codex", ids.requestId), ids.subscriptionId);
  state = beginWorkerHistory(state, true).state;
  state = receiveWorkerEvent(state, envelope({ kind: "agent-message-delta", turnId: "joined", itemId: "a1", delta: "ha" }));
  state = receiveWorkerEvent(state, envelope({ kind: "agent-message-delta", turnId: "joined", itemId: "a2", delta: "ha" }));
  state = receiveWorkerEvent(state, envelope({ kind: "item-completed", turnId: "joined", item: { type: "agent-message", id: "a3", text: "authoritative", phase: "commentary" } }));
  state = applyWorkerSnapshot(state, {
    messages: [
      { id: "a:joined:a1", turnId: "joined", body: "alpha", completedAt: 1, terminalStatus: "inProgress", phase: "commentary", turnOrder: 0, itemOrder: 0 },
    ],
    hasOlder: false, terminalTurnIds: [], openTurnIds: ["joined"],
  });

  assert.deepEqual(state.messages.map((message) => [message.id, message.body]), [
    ["a:joined:a1", "alpha"],
    ["a:joined:a2", "ha"],
    ["a:joined:a3", "authoritative"],
  ]);
});

test("paging does not classify an open turn as a mid-turn join", () => {
  let state = acknowledgeWorkerSubscription(beginWorkerSubscription("worker", "codex", ids.requestId), ids.subscriptionId);
  state = beginWorkerHistory(state, false).state;
  state = applyWorkerSnapshot(state, { messages: [], hasOlder: true, terminalTurnIds: [], openTurnIds: ["live"] });
  assert.deepEqual(state.recoveryTurnIds, []);
});

test("a stale older page cannot downgrade a live terminal turn", () => {
  let state = acknowledgeWorkerSubscription(beginWorkerSubscription("worker", "codex", ids.requestId), ids.subscriptionId);
  state = receiveWorkerEvent(state, envelope({ kind: "item-completed", turnId: "turn", item: { type: "agent-message", id: "a1", text: "already visible" } }));
  state = beginWorkerHistory(state, false).state;
  state = receiveWorkerEvent(state, envelope({ kind: "turn-completed", turnId: "turn", status: "completed" }));
  state = applyWorkerSnapshot(state, {
    messages: [
      { id: "a:turn:a1", turnId: "turn", body: "already visible", completedAt: 1, terminalStatus: "inProgress" },
      { id: "a:turn:a2", turnId: "turn", body: "older row", completedAt: 1, terminalStatus: "inProgress" },
    ],
    hasOlder: false, terminalTurnIds: [], openTurnIds: ["turn"],
  });

  assert.deepEqual(state.messages.map((message) => [message.body, message.terminalStatus]), [
    ["already visible", "completed"],
    ["older row", "completed"],
  ]);
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

test("terminal recovery overrides a provisional status-less Claude completion", () => {
  let state = acknowledgeWorkerSubscription(beginWorkerSubscription("worker", "claude", ids.requestId), ids.subscriptionId);
  state = receiveWorkerEvent(state, envelope({ kind: "turn-completed", turnId: "turn" }));
  state = beginWorkerHistory(state, true).state;
  state = applyWorkerSnapshot(state, {
    messages: [{ id: "a:turn:a", turnId: "turn", body: "failed", completedAt: 2, terminalStatus: "failed", turnOrder: 0, itemOrder: 0 }],
    hasOlder: false, terminalTurnIds: ["turn"], openTurnIds: [],
  }, "turn");

  assert.deepEqual(state.messages.map((message) => [message.body, message.terminalStatus]), [["failed", "failed"]]);
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
