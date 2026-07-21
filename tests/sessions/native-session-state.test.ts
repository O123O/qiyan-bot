import assert from "node:assert/strict";
import test from "node:test";
import { NativeSessionState } from "../../src/sessions/native-session-state.ts";

const identity = { endpointId: "prenyx", threadId: "thread-1", mappingId: "mapping-1" };

test("current-generation events are the only live lifecycle authority", () => {
  const state = new NativeSessionState({ now: () => 100 });
  state.register(identity, 4);

  state.observe("prenyx", 4, "turn/started", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "inProgress" },
  });
  assert.deepEqual(state.view(identity), {
    availability: "ready",
    status: "active",
    activeTurnId: "turn-1",
    endpointGeneration: 4,
    lifecycleRevision: 1,
    receiveSequence: 1,
    observedAt: 100,
  });

  state.observe("prenyx", 3, "turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed" },
  });
  assert.equal(state.view(identity)?.status, "active", "an old endpoint generation cannot mutate live state");

  state.invalidateEndpoint("prenyx", 4);
  assert.deepEqual(state.view(identity), {
    availability: "unavailable",
    status: "unknown",
    activeTurnId: null,
    endpointGeneration: 4,
    lifecycleRevision: 2,
    receiveSequence: 2,
    observedAt: 100,
  });
});

test("a late refresh response cannot overwrite lifecycle events received after dispatch", () => {
  const state = new NativeSessionState();
  state.register(identity, 8);
  const refresh = state.captureRefresh(identity, 8);

  state.observe("prenyx", 8, "turn/started", {
    threadId: "thread-1",
    turn: { id: "turn-2", status: "inProgress" },
  });
  state.observe("prenyx", 8, "turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-2", status: "completed" },
  });

  assert.equal(state.applyRefresh(refresh, { status: "idle" }), false);
  assert.equal(state.view(identity)?.status, "idle");
  assert.equal(state.view(identity)?.activeTurnId, null);
});

test("an id-less idle event fences a late turn start response", () => {
  const state = new NativeSessionState();
  state.register(identity, 12);
  const start = state.captureStart(identity, 12);

  state.observe("prenyx", 12, "thread/status/changed", {
    threadId: "thread-1",
    status: { type: "idle" },
  });

  assert.equal(state.applyStartResponse(start, "turn-late"), "refresh-required");
  assert.equal(state.view(identity)?.status, "idle");
  assert.equal(state.view(identity)?.activeTurnId, null);
});

test("terminal-before-start evidence prevents resurrection and same-turn start is idempotent", () => {
  const state = new NativeSessionState();
  state.register(identity, 15);
  const completedFirst = state.captureStart(identity, 15);
  state.observe("prenyx", 15, "turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-fast", status: "completed" },
  });
  assert.equal(state.applyStartResponse(completedFirst, "turn-fast"), "terminal");
  assert.equal(state.view(identity)?.status, "unknown");

  const normal = state.captureStart(identity, 15);
  state.observe("prenyx", 15, "turn/started", {
    threadId: "thread-1",
    turn: { id: "turn-next", status: "inProgress" },
  });
  assert.equal(state.applyStartResponse(normal, "turn-next"), "active");
  assert.equal(state.view(identity)?.activeTurnId, "turn-next");
});

test("publishes only applied view changes", () => {
  const state = new NativeSessionState();
  const changes: string[] = [];
  state.onChange((changed) => changes.push(`${changed.status}:${changed.activeTurnId ?? "-"}`));
  state.register(identity, 2);
  const refresh = state.captureRefresh(identity, 2);
  assert.equal(state.applyRefresh(refresh, { status: "idle" }), true);
  state.observe("prenyx", 1, "turn/started", { threadId: "thread-1", turn: { id: "old" } });
  assert.deepEqual(changes, ["unknown:-", "idle:-"]);
});

test("id-less active status stays metadata-only until a live turn event identifies it", () => {
  const state = new NativeSessionState();
  state.register(identity, 20);
  assert.equal(state.observe("prenyx", 20, "thread/status/changed", {
    threadId: "thread-1",
    status: { type: "active" },
  }), false);
  assert.equal(state.view(identity)?.status, "active");
  assert.equal(state.view(identity)?.activeTurnId, null);

  state.observe("prenyx", 20, "turn/started", { threadId: "thread-1", turn: { id: "known" } });
  assert.equal(state.observe("prenyx", 20, "thread/status/changed", {
    threadId: "thread-1",
    status: { type: "active" },
  }), false);
});

test("a live item notification identifies an active turn after connection recovery", () => {
  const state = new NativeSessionState();
  state.register(identity, 25);
  state.observe("prenyx", 25, "thread/status/changed", {
    threadId: "thread-1", status: { type: "active" },
  });

  assert.equal(state.observe("prenyx", 25, "item/agentMessage/delta", {
    threadId: "thread-1", turnId: "live-turn", itemId: "message", delta: "working",
  }), false);
  assert.equal(state.view(identity)?.status, "active");
  assert.equal(state.view(identity)?.activeTurnId, "live-turn");
});

test("an older completion cannot turn an id-less active session idle", () => {
  const state = new NativeSessionState();
  state.register(identity, 21);
  state.observe("prenyx", 21, "thread/status/changed", {
    threadId: "thread-1", status: { type: "active" },
  });

  assert.equal(state.observe("prenyx", 21, "turn/completed", {
    threadId: "thread-1", turn: { id: "older", status: "completed" },
  }), true);
  assert.equal(state.view(identity)?.status, "active");
  assert.equal(state.view(identity)?.activeTurnId, null);
});

test("a mismatched completion preserves the known active turn and requests refresh", () => {
  const state = new NativeSessionState();
  state.register(identity, 22);
  state.observe("prenyx", 22, "turn/started", {
    threadId: "thread-1", turn: { id: "current", status: "inProgress" },
  });

  assert.equal(state.observe("prenyx", 22, "turn/completed", {
    threadId: "thread-1", turn: { id: "older", status: "completed" },
  }), true);
  assert.equal(state.view(identity)?.status, "active");
  assert.equal(state.view(identity)?.activeTurnId, "current");
});

test("a completion for an id-less active session fences an older refresh response", () => {
  const state = new NativeSessionState();
  state.register(identity, 24);
  state.observe("prenyx", 24, "thread/status/changed", {
    threadId: "thread-1", status: { type: "active" },
  });
  const stale = state.captureRefresh(identity, 24);

  assert.equal(state.observe("prenyx", 24, "turn/completed", {
    threadId: "thread-1", turn: { id: "completed-without-start", status: "completed" },
  }), true);

  assert.equal(state.applyRefresh(stale, { status: "active" }), false);
  assert.equal(state.view(identity)?.status, "active");
  assert.equal(state.view(identity)?.activeTurnId, null);
  assert.ok((state.view(identity)?.receiveSequence ?? 0) > 0);
});

test("a completion observed while idle fences an older active refresh response", () => {
  const state = new NativeSessionState();
  state.register(identity, 23);
  const initial = state.captureRefresh(identity, 23);
  state.applyRefresh(initial, { status: "idle" });
  const stale = state.captureRefresh(identity, 23);

  assert.equal(state.observe("prenyx", 23, "turn/completed", {
    threadId: "thread-1", turn: { id: "completed-before-start", status: "completed" },
  }), false);

  assert.equal(state.applyRefresh(stale, { status: "active" }), false);
  assert.equal(state.view(identity)?.status, "idle");
});
