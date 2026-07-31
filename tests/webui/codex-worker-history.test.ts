import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AppError } from "../../src/core/errors.ts";
import {
  CodexRolloutLocations,
  createCodexConversationHistoryRead,
} from "../../src/sessions/codex-conversation-history.ts";

const threadId = "019f949a-51be-7a72-ae4b-ce8ce38095db";
const path = `/home/user/.codex/sessions/2026/07/24/rollout-2026-07-24T14-49-29-${threadId}.jsonl`;

test("Codex worker history reuses a bounded page until a native event changes the thread", async () => {
  const locations = new CodexRolloutLocations();
  locations.observe("remote", { id: threadId, path, preview: "" });
  let receiveSequence = 1;
  let reads = 0;
  const read = createCodexConversationHistoryRead({
    locations,
    nativeSession: () => ({
      availability: "ready",
      status: "idle",
      activeTurnId: null,
      endpointGeneration: 1,
      lifecycleRevision: receiveSequence,
      receiveSequence,
      observedAt: 1,
    }),
    readPage: async (input) => {
      reads += 1;
      assert.equal(input.endpointId, "remote");
      assert.equal(input.path, path);
      assert.equal(input.allowMissing, reads === 1);
      locations.markMaterialized("remote", threadId);
      return {
        messages: [{
          id: "message-1",
          turnId: "turn-1",
          body: "done",
          completedAt: 1,
          terminalStatus: "completed",
          turnOrder: 0,
          itemOrder: 0,
        }],
        hasOlder: false,
        openTurnIds: [],
        terminalTurnIds: ["turn-1"],
      };
    },
  });

  const signal = new AbortController().signal;
  const first = await read("remote", threadId, "mapping-1", 20, undefined, signal);
  const second = await read("remote", threadId, "mapping-1", 20, undefined, signal);
  assert.deepEqual(second, first);
  assert.equal(reads, 1);

  receiveSequence += 1;
  await read("remote", threadId, "mapping-1", 20, undefined, signal);
  assert.equal(reads, 2);
});

test("Codex rollout locations accept only the exact thread rollout path", () => {
  const locations = new CodexRolloutLocations();
  locations.observe("remote", { id: threadId, path, preview: "" });
  assert.deepEqual(locations.get("remote", threadId), { path, allowMissing: true });

  locations.observe("remote", {
    id: threadId,
    path: `/home/user/.codex/sessions/rollout-other.jsonl`,
    preview: "changed",
  });
  assert.deepEqual(locations.get("remote", threadId), { path, allowMissing: true });

  locations.markMaterialized("remote", threadId);
  assert.deepEqual(locations.get("remote", threadId), { path, allowMissing: false });
});

test("only an initial latest-page read may tolerate an unmaterialized rollout", async () => {
  const locations = new CodexRolloutLocations();
  locations.observe("remote", { id: threadId, path, preview: "" });
  const read = createCodexConversationHistoryRead({
    locations,
    nativeSession: () => undefined,
    readPage: async (input) => {
      assert.equal(input.allowMissing, false);
      return { messages: [], hasOlder: false, openTurnIds: [], terminalTurnIds: [] };
    },
  });
  await read("remote", threadId, "mapping-1", 20, "older-cursor", new AbortController().signal);
});

test("the production Web UI history path does not call thread/read", async () => {
  const source = await readFile(new URL("../../src/production-app.ts", import.meta.url), "utf8");
  const start = source.indexOf("const readWorkerTurns =");
  const end = source.indexOf("const phases:", start);
  assert.ok(start >= 0 && end > start);
  const historyPath = source.slice(start, end);
  assert.doesNotMatch(historyPath, /thread\/read/u);
  assert.match(historyPath, /readCodexWorkerTurns/u);
});

// Rollout locations are learned only from a thread/read on the worker's own endpoint, and
// the map starts empty on every boot. An endpoint QiYan cannot reach therefore has no
// location — history really is unavailable, but only until it reconnects. Reporting that as
// a bare error made a self-healing outage read as corruption in the chat panel.
test("an unreachable endpoint reports history as unavailable, not as a defect", async () => {
  const read = createCodexConversationHistoryRead({
    locations: new CodexRolloutLocations(),          // empty: nothing has been read yet
    nativeSession: () => ({ availability: "unavailable", status: "unknown" }) as never,
    readPage: async () => assert.fail("no page can be read without a location"),
  });

  await assert.rejects(
    read("prenyx", threadId, "mapping-1", 20, undefined, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "ENDPOINT_UNAVAILABLE", "retryable, so the panel can say it will load later");
      assert.match(error.message, /prenyx is not connected/u);
      assert.match(error.message, /reconnects/u, "the message says it resolves itself");
      return true;
    });
});

// A reachable endpoint with no location is a different situation: the bounded map evicted
// the entry, or the thread was never read. That is not an outage and must not claim to be.
test("a reachable endpoint with no location reports a distinct, non-outage failure", async () => {
  const read = createCodexConversationHistoryRead({
    locations: new CodexRolloutLocations(),
    nativeSession: () => ({ availability: "ready", status: "idle" }) as never,
    readPage: async () => assert.fail("no page can be read without a location"),
  });

  await assert.rejects(
    read("prenyx", threadId, "mapping-1", 20, undefined, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "OPERATION_FAILED");
      assert.match(error.message, /no rollout location is known/u);
      return true;
    });
});
