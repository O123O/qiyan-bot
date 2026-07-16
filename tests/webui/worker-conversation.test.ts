import assert from "node:assert/strict";
import test from "node:test";
import { openWorkerTurnIds, pageWorkerConversation, terminalWorkerTurnIds } from "../../src/webui/worker-conversation.ts";

const userMsg = (id: string, text: string) => ({ type: "userMessage", id, clientId: `client-${id}`, content: [{ type: "text", text, text_elements: [] }] });
const agentMsg = (id: string, text: string, phase: string | null = "final_answer") => ({ type: "agentMessage", id, text, phase });

test("reconstructs all visible native user, commentary, and final messages with stable metadata", () => {
  const turns = [{
    id: "t1", status: "completed", startedAt: 1_700_000_000, completedAt: 1_700_000_005,
    items: [userMsg("u1", "do X"), { type: "reasoning", id: "r1" }, agentMsg("c1", "working", "commentary"), agentMsg("a1", "did X")],
  }];
  const rows = pageWorkerConversation(turns, 20).messages;
  assert.deepEqual(rows.map((row) => [row.id, row.role, row.body, row.phase]), [
    ["u:t1:u1", "you", "do X", undefined],
    ["a:t1:c1", "worker", "working", "commentary"],
    ["a:t1:a1", "worker", "did X", "final_answer"],
  ]);
  assert.equal(rows[0]!.clientId, "client-u1");
  assert.equal(rows[0]!.completedAt, 1_700_000_000_000);
  assert.equal(rows[1]!.completedAt, 1_700_000_005_000);
  assert.equal(rows[1]!.terminalStatus, "completed");
});

test("strips setup, ignores non-text inputs, and preserves all unknown-phase agent messages", () => {
  const turns = [
    { id: "t1", status: "completed", startedAt: 1, completedAt: 2, items: [userMsg("u0", "<environment_context><cwd>/x</cwd></environment_context>"), agentMsg("a0", "ok")] },
    { id: "t2", status: "completed", startedAt: 3, completedAt: 4, items: [userMsg("u1", "<environment_context><cwd>/x</cwd></environment_context>\nreal prompt"), agentMsg("x", "one", null), agentMsg("y", "two", null)] },
  ];
  assert.deepEqual(pageWorkerConversation(turns, 20).messages.map((row) => row.body), ["ok", "real prompt", "one", "two"]);
});

test("paginates only terminal rows with an exclusive compound cursor", () => {
  const terminalItems = Array.from({ length: 25 }, (_, index) => agentMsg(`a${index}`, `done-${index}`, "commentary"));
  const openItems = Array.from({ length: 25 }, (_, index) => agentMsg(`o${index}`, `open-${index}`, "commentary"));
  const turns = [
    { id: "done", status: "completed", startedAt: 10, completedAt: 11, items: terminalItems },
    { id: "open", status: "inProgress", startedAt: 12, completedAt: null, items: openItems },
  ];
  assert.deepEqual(openWorkerTurnIds(turns), ["open"]);
  assert.deepEqual(terminalWorkerTurnIds(turns), ["done"]);
  const newest = pageWorkerConversation(turns, 20);
  assert.deepEqual(newest.messages.map((row) => row.body), Array.from({ length: 20 }, (_, index) => `done-${index + 5}`));
  assert.equal(newest.hasOlder, true);
  assert.ok(newest.nextCursor);
  const older = pageWorkerConversation(turns, 20, newest.nextCursor);
  assert.deepEqual(older.messages.map((row) => row.body), Array.from({ length: 5 }, (_, index) => `done-${index}`));
  assert.equal(older.hasOlder, false);
  assert.equal(older.nextCursor, undefined);
});

test("Claude-style userMessage without content yields agent rows only", () => {
  const turns = [{ id: "t1", status: "completed", startedAt: 1, completedAt: 2, items: [{ type: "userMessage", id: "u", clientId: "u" }, agentMsg("a", "reply")] }];
  assert.deepEqual(pageWorkerConversation(turns, 20).messages.map((row) => [row.role, row.body]), [["worker", "reply"]]);
});
