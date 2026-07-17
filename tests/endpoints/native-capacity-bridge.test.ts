import assert from "node:assert/strict";
import test from "node:test";
import { NativeCapacityBridge } from "../../src/endpoints/native-capacity-bridge.ts";
import { NativeSessionState } from "../../src/sessions/native-session-state.ts";

test("live native transitions, not persisted receipts, own capacity", () => {
  const native = new NativeSessionState();
  const restored: string[] = [];
  const terminal: string[] = [];
  const bridge = new NativeCapacityBridge(native, {
    restoreObservedActiveTurn: (endpointId, threadId, turnId) => {
      restored.push(`${endpointId}/${threadId}/${turnId}`);
      return {} as never;
    },
    markTurnTerminal: (endpointId, threadId, turnId) => { terminal.push(`${endpointId}/${threadId}/${turnId}`); },
  });
  const identity = { endpointId: "prenyx", threadId: "thread-1", mappingId: "mapping-1" };
  native.register(identity, 3);
  native.observe("prenyx", 3, "turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
  native.observe("prenyx", 3, "thread/status/changed", { threadId: "thread-1", status: { type: "idle" } });
  native.observe("prenyx", 3, "turn/completed", { threadId: "thread-1", turn: { id: "turn-1" } });

  assert.deepEqual(restored, ["prenyx/thread-1/turn-1"]);
  assert.deepEqual(terminal, ["prenyx/thread-1/turn-1"]);
  bridge.close();
});

test("connection invalidation does not misclassify an active turn as terminal", () => {
  const native = new NativeSessionState();
  const terminal: string[] = [];
  const bridge = new NativeCapacityBridge(native, {
    restoreObservedActiveTurn: () => ({} as never),
    markTurnTerminal: (_endpointId, _threadId, turnId) => { terminal.push(turnId); },
  });
  const identity = { endpointId: "remote", threadId: "thread", mappingId: "mapping" };
  native.register(identity, 1);
  native.observe("remote", 1, "turn/started", { threadId: "thread", turn: { id: "turn" } });
  native.invalidateEndpoint("remote", 1);

  assert.deepEqual(terminal, []);
  bridge.close();
});

test("an authoritative active-turn replacement releases the superseded claim", () => {
  const native = new NativeSessionState();
  const restored: string[] = [];
  const terminal: string[] = [];
  const bridge = new NativeCapacityBridge(native, {
    restoreObservedActiveTurn: (_endpointId, _threadId, turnId) => {
      restored.push(turnId);
      return {} as never;
    },
    markTurnTerminal: (_endpointId, _threadId, turnId) => { terminal.push(turnId); },
  });
  const identity = { endpointId: "remote", threadId: "thread", mappingId: "mapping" };
  native.register(identity, 1);
  native.observe("remote", 1, "turn/started", { threadId: "thread", turn: { id: "old" } });
  native.observe("remote", 1, "turn/started", { threadId: "thread", turn: { id: "new" } });

  assert.deepEqual(restored, ["old", "new"]);
  assert.deepEqual(terminal, ["old"]);
  bridge.close();
});
