import assert from "node:assert/strict";
import test from "node:test";
import { NativeSessionState } from "../../src/sessions/native-session-state.ts";
import { repairActiveTurnIdentity } from "../../src/sessions/native-session-probe.ts";

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
    backgroundWork: false,
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
    backgroundWork: false,
    endpointGeneration: 4,
    lifecycleRevision: 2,
    receiveSequence: 2,
    observedAt: 100,
  });
});

test("a one-turn probe repairs only an exact current active turn identity", async () => {
  const native = new NativeSessionState();
  const identity = { endpointId: "remote", threadId: "thread", mappingId: "mapping" };
  native.register(identity, 3);
  native.applyRefresh(native.captureRefresh(identity, 3), { status: "active" });

  await repairActiveTurnIdentity({
    native,
    identity,
    endpointGeneration: 3,
    latestTurn: async () => ({ id: "running", status: "inProgress", itemsView: "notLoaded", items: [] }),
  });

  assert.equal(native.view(identity)?.status, "active");
  assert.equal(native.view(identity)?.activeTurnId, "running");
});

test("an inconclusive active-turn probe fails closed as unknown", async () => {
  const native = new NativeSessionState();
  const identity = { endpointId: "remote", threadId: "thread", mappingId: "mapping" };
  native.register(identity, 3);
  native.applyRefresh(native.captureRefresh(identity, 3), { status: "active" });

  await repairActiveTurnIdentity({
    native,
    identity,
    endpointGeneration: 3,
    latestTurn: async () => ({ id: "done", status: "completed", itemsView: "notLoaded", items: [] }),
  });

  assert.equal(native.view(identity)?.status, "unknown");
  assert.equal(native.view(identity)?.activeTurnId, null);
});

// Same inputs as the test above — active, no turn id, and no active turn in history — but the
// session is busy with background work, which is a complete explanation rather than a failed
// identification. Failing closed here declares a perfectly well-understood session unknowable,
// and every caller of this probe then reports its endpoint unavailable: archive and unadopt
// give ENDPOINT_UNAVAILABLE instead of the accurate "has an active turn", and the interrupt
// that could have stopped the work never gets the chance to run.
test("background work is not an unidentified turn, so the probe leaves it alone", async () => {
  const native = new NativeSessionState();
  const identity = { endpointId: "remote", threadId: "thread", mappingId: "mapping" };
  native.register(identity, 3);
  native.observe("remote", 3, "thread/status/changed", {
    threadId: "thread",
    status: { type: "active" },
    nativeActivity: { backgroundTasks: 1, subagents: 0 },
  });
  let probed = false;

  await repairActiveTurnIdentity({
    native,
    identity,
    endpointGeneration: 3,
    latestTurn: async () => {
      probed = true;
      return { id: "done", status: "completed", itemsView: "notLoaded", items: [] };
    },
  });

  assert.equal(probed, false, "no history read: there is no turn for it to find");
  assert.equal(native.view(identity)?.status, "active", "the session stays knowably busy");
  assert.equal(native.view(identity)?.activeTurnId, null);
});

// Queue a second message while the first turn runs and this is the ordinary sequence: the next
// turn is announced started, then the finished one's completion arrives, and the mismatch asks
// for a refresh. That refresh carries an expected revision, which bypasses the guard for a view
// that already names a turn — so the probe reads history, finds only the COMPLETED turn (the
// running one has not been written yet), and erases a live identity to `unknown`. Every later
// operation on the session then fails on that, which is a worker reported down mid-conversation.
test("a refresh does not erase a running turn history has not caught up with", async () => {
  const native = new NativeSessionState();
  const identity = { endpointId: "remote", threadId: "thread", mappingId: "mapping" };
  native.register(identity, 3);
  native.observe("remote", 3, "turn/started", { threadId: "thread", turn: { id: "first" } });
  native.observe("remote", 3, "turn/started", { threadId: "thread", turn: { id: "queued" } });
  const refreshRequired = native.observe("remote", 3, "turn/completed", { threadId: "thread", turn: { id: "first" } });
  assert.equal(refreshRequired, true, "the mismatched completion is what asks for the refresh");

  await repairActiveTurnIdentity({
    native,
    identity,
    endpointGeneration: 3,
    expectedLifecycleRevision: native.view(identity)!.lifecycleRevision,
    // The queued turn is executing; the transcript's newest turn is still the finished one.
    latestTurn: async () => ({ id: "first", status: "completed", itemsView: "notLoaded", items: [] }),
  });

  assert.equal(native.view(identity)?.status, "active");
  assert.equal(native.view(identity)?.activeTurnId, "queued", "the turn that is actually running is kept");
});

// A forced refresh can arrive after the session has already settled — its turn completed while
// the refresh was in flight. There is no identity left to establish, and recording `unknown`
// replaces a good idle state with one that fails every later operation, for a session that is
// simply finished.
test("a refresh does not make an already idle session unknown", async () => {
  const native = new NativeSessionState();
  const identity = { endpointId: "remote", threadId: "thread", mappingId: "mapping" };
  native.register(identity, 3);
  native.observe("remote", 3, "turn/started", { threadId: "thread", turn: { id: "only" } });
  native.observe("remote", 3, "turn/completed", { threadId: "thread", turn: { id: "only" } });
  assert.equal(native.view(identity)?.status, "idle");

  await repairActiveTurnIdentity({
    native,
    identity,
    endpointGeneration: 3,
    expectedLifecycleRevision: native.view(identity)!.lifecycleRevision,
    latestTurn: async () => ({ id: "only", status: "completed", itemsView: "notLoaded", items: [] }),
  });

  assert.equal(native.view(identity)?.status, "idle", "a settled session stays settled");
  assert.equal(native.view(identity)?.activeTurnId, null);
});

// A reconnect settles state from a thread VIEW, not from notifications: every managed session
// is reconciled through applyRefresh after the endpoint's generation bumps. Dropping the
// activity there meant the flag reverted to false on every reconnect, the probe then ran, and
// the session was recorded unknown — the original wedge, restored by every endpoint restart.
test("a thread view establishes background work, so a reconnect does not lose it", async () => {
  const native = new NativeSessionState();
  const identity = { endpointId: "remote", threadId: "thread", mappingId: "mapping" };
  native.register(identity, 3);

  native.applyRefresh(native.captureRefresh(identity, 3), {
    status: "active",
    activeTurnId: null,
    nativeActivity: { backgroundTasks: 1, subagents: 0 },
  });
  assert.equal(native.view(identity)?.backgroundWork, true);

  let probed = false;
  await repairActiveTurnIdentity({
    native,
    identity,
    endpointGeneration: 3,
    latestTurn: async () => {
      probed = true;
      return { id: "done", status: "completed", itemsView: "notLoaded", items: [] };
    },
  });

  assert.equal(probed, false);
  assert.equal(native.view(identity)?.status, "active", "not recorded as unknown after the reconnect");
});

// Background work is a KIND of busy and cannot outlive it. A backgrounded command that ends
// during a LATER turn publishes no status of its own — the runtime suppresses that while a turn
// owns the session — so nothing but the turn's completion would ever clear this.
test("a session going idle clears background work rather than disabling repair forever", async () => {
  const state = new NativeSessionState({ now: () => 100 });
  state.register(identity, 4);
  state.observe("prenyx", 4, "thread/status/changed", {
    threadId: "thread-1",
    status: { type: "active" },
    nativeActivity: { backgroundTasks: 1, subagents: 0 },
  });
  assert.equal(state.view(identity)?.backgroundWork, true);

  state.observe("prenyx", 4, "turn/started", { threadId: "thread-1", turn: { id: "turn-2" } });
  state.observe("prenyx", 4, "turn/completed", { threadId: "thread-1", turn: { id: "turn-2" } });

  assert.equal(state.view(identity)?.status, "idle");
  assert.equal(state.view(identity)?.backgroundWork, false,
    "otherwise the probe's early return disables identity repair for this mapping for good");
});

test("a probe response cannot overwrite a newer native notification", async () => {
  const native = new NativeSessionState();
  const identity = { endpointId: "remote", threadId: "thread", mappingId: "mapping" };
  native.register(identity, 3);
  native.applyRefresh(native.captureRefresh(identity, 3), { status: "active" });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const probing = repairActiveTurnIdentity({
    native,
    identity,
    endpointGeneration: 3,
    latestTurn: async () => {
      await barrier;
      return { id: "stale", status: "inProgress", itemsView: "notLoaded", items: [] };
    },
  });
  native.observe("remote", 3, "turn/started", { threadId: "thread", turn: { id: "newer" } });
  release();
  await probing;

  assert.equal(native.view(identity)?.status, "active");
  assert.equal(native.view(identity)?.activeTurnId, "newer");
});

test("a queued forced probe cannot start after a newer notification resolves the state", async () => {
  const native = new NativeSessionState();
  const identity = { endpointId: "remote", threadId: "thread", mappingId: "mapping" };
  native.register(identity, 3);
  native.applyRefresh(native.captureRefresh(identity, 3), {
    status: "active",
    activeTurnId: "older",
  });
  const expectedLifecycleRevision = native.view(identity)!.lifecycleRevision;
  native.observe("remote", 3, "turn/started", {
    threadId: "thread",
    turn: { id: "newer" },
  });
  let probes = 0;

  await repairActiveTurnIdentity({
    native,
    identity,
    endpointGeneration: 3,
    expectedLifecycleRevision,
    latestTurn: async () => {
      probes += 1;
      return { id: "stale", status: "inProgress", itemsView: "notLoaded", items: [] };
    },
  });

  assert.equal(probes, 0);
  assert.equal(native.view(identity)?.activeTurnId, "newer");
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

test("id-less active status requests identity repair until a live turn event identifies it", () => {
  const state = new NativeSessionState();
  state.register(identity, 20);
  assert.equal(state.observe("prenyx", 20, "thread/status/changed", {
    threadId: "thread-1",
    status: { type: "active" },
  }), true);
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

// A Claude worker whose background task or subagent outlives its turn announces itself
// active through thread/status/changed. That is what stops archive_session and
// unadopt_session: their idle proof refuses a session reporting active, so the host is
// never closed — and the running work never killed — out from under a worker that is
// about to speak again.
test("background work reported as a status change keeps a session non-idle", () => {
  const state = new NativeSessionState({ now: () => 100 });
  state.register(identity, 4);

  // The turn ends; the background task is still running.
  state.observe("prenyx", 4, "turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
  state.observe("prenyx", 4, "turn/completed", { threadId: "thread-1", turn: { id: "turn-1" } });
  const refreshRequired = state.observe("prenyx", 4, "thread/status/changed", {
    threadId: "thread-1",
    status: { type: "active" },
    nativeActivity: { backgroundTasks: 0, subagents: 1 },
  });

  assert.equal(state.view(identity)?.status, "active",
    "a session with live background work is not idle, so the archive idle proof refuses it");
  assert.equal(state.view(identity)?.backgroundWork, true, "and what makes it active is recorded");
  // The refresh looks for the active turn in history and, finding none, records the session
  // state as unknown — which fails every later operation on it. Background work has no turn to
  // find, so asking is not merely wasteful: it is how the session became unusable.
  assert.equal(refreshRequired, false, "background work must not request an active-turn refresh");

  // It settles, and the session becomes archivable again.
  state.observe("prenyx", 4, "thread/status/changed", { threadId: "thread-1", status: { type: "idle" } });
  assert.equal(state.view(identity)?.status, "idle");
  assert.equal(state.view(identity)?.backgroundWork, false);
});

// A resume response is built from a thread view that may have been read moments before the
// turn it names settled. Adopting that id leaves the session active on a finished turn, which
// `send` steers into and is refused — and with the active turn now taken from the response
// rather than probed for afterwards, nothing corrects it until the next turn starts.
test("a refresh cannot reinstate a turn this generation already saw settle", () => {
  const state = new NativeSessionState({ now: () => 100 });
  state.register(identity, 4);
  state.observe("prenyx", 4, "turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
  state.observe("prenyx", 4, "turn/completed", { threadId: "thread-1", turn: { id: "turn-1" } });

  // The response was assembled before that completion and still calls turn-1 the active one.
  state.applyRefresh(state.captureRefresh(identity, 4), { status: "active", activeTurnId: "turn-1" });

  assert.equal(state.view(identity)?.status, "idle");
  assert.equal(state.view(identity)?.activeTurnId, null);
});

// The same stale response, but the session really is still busy — on work that belongs to no
// turn. The settled turn is dropped; the reason it is busy is not.
test("a stale refresh still reports background work as busy", () => {
  const state = new NativeSessionState({ now: () => 100 });
  state.register(identity, 4);
  state.observe("prenyx", 4, "turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
  state.observe("prenyx", 4, "turn/completed", { threadId: "thread-1", turn: { id: "turn-1" } });

  state.applyRefresh(state.captureRefresh(identity, 4), {
    status: "active",
    activeTurnId: "turn-1",
    nativeActivity: { backgroundTasks: 1, subagents: 0 },
  });

  assert.equal(state.view(identity)?.status, "active");
  assert.equal(state.view(identity)?.activeTurnId, null);
  assert.equal(state.view(identity)?.backgroundWork, true);
});

// Without the activity to explain it, an id-less active status is a turn whose identity is
// not yet established — the Codex case, which must keep asking for the refresh.
test("an id-less active status with no background work still requests identity repair", () => {
  const state = new NativeSessionState({ now: () => 100 });
  state.register(identity, 4);

  const refreshRequired = state.observe("prenyx", 4, "thread/status/changed", {
    threadId: "thread-1",
    status: { type: "active" },
  });

  assert.equal(refreshRequired, true);
  assert.equal(state.view(identity)?.backgroundWork, false);
});
