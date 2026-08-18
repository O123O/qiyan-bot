import assert from "node:assert/strict";
import test from "node:test";
import { sessionSnapshot } from "../../src/webui/web-reads.ts";

// The browser polls the session snapshot. The database is on an NFS home, where every implicit
// transaction costs a byte-range lock cycle and a change-counter re-read over the wire, so a
// snapshot built from a statement per session per fact was seconds of round trips while blocking
// the event loop. What matters is not that readBatch is called but that every read happens INSIDE
// it -- a read left outside pays the full per-statement cost again.
function deps(overrides: Record<string, unknown> = {}) {
  const seen: string[] = [];
  let batchDepth = 0;
  const record = (name: string) => { seen.push(`${name}:${batchDepth > 0 ? "inside" : "OUTSIDE"}`); };
  return {
    seen,
    batches: () => batchDepth,
    value: {
      registrySnapshot: () => {
        record("registrySnapshot");
        return { version: 3, assistant: { endpoint: "a", thread_id: "t", project_dir: "/p" },
          sessions: { one: { endpoint: "e", thread_id: "t1", project_dir: "/p", mapping_id: "m1", lifecycle_state: "managed" },
            two: { endpoint: "e", thread_id: "t2", project_dir: "/p", mapping_id: "m2", lifecycle_state: "managed" } } } as never;
      },
      dashboardSnapshot: () => { record("dashboardSnapshot"); return { version: 3, sessions: {} } as never; },
      assistantSession: () => { record("assistantSession"); return { nickname: "assistant" } as never; },
      nativeSession: () => { record("nativeSession"); return undefined; },
      provider: () => { record("provider"); return "codex" as const; },
      host: () => { record("host"); return "h"; },
      historyReadable: () => { record("historyReadable"); return true; },
      readWorkerTurns: async () => ({ turns: [] } as never),
      listOwnerConversation: () => [],
      readBatch: <T>(action: () => T): T => { batchDepth += 1; try { return action(); } finally { batchDepth -= 1; } },
      ...overrides,
    } as never,
  };
}

test("every session-snapshot read happens inside one batch", () => {
  const harness = deps();
  sessionSnapshot(harness.value);

  assert.ok(harness.seen.length >= 8, `expected the snapshot to read repeatedly, saw ${harness.seen.length}`);
  const outside = harness.seen.filter((entry) => entry.endsWith("OUTSIDE"));
  assert.deepEqual(outside, [], "a read outside the batch pays the per-statement NFS cost again");
  assert.equal(harness.batches(), 0, "the batch closed");
});

// A caller with no database passes through. Kept because the pass-through form must stay valid:
// the type now requires readBatch, and the temptation is to satisfy it with something that quietly
// does nothing in production.
test("a pass-through batch still produces a complete snapshot", () => {
  const harness = deps({ readBatch: <T>(action: () => T): T => action() });
  const snapshot = sessionSnapshot(harness.value);
  assert.equal(snapshot.sessions.length, 2);
  assert.deepEqual(harness.seen.filter((entry) => entry.endsWith("OUTSIDE")).length > 0, true,
    "a pass-through batch does not claim to be inside a transaction");
});
