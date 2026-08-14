import assert from "node:assert/strict";
import test from "node:test";
import { reconstructClaudeThread } from "../../src/sessions/claude-thread.ts";
import { openWorkerTurnIds, pageWorkerConversation, terminalWorkerTurnIds, workerConversationRows } from "../../src/webui/worker-conversation.ts";

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

test("paginates terminal and open rows with a bounded exclusive compound cursor", () => {
  const terminalItems = Array.from({ length: 25 }, (_, index) => agentMsg(`a${index}`, `done-${index}`, "commentary"));
  const openItems = Array.from({ length: 25 }, (_, index) => agentMsg(`o${index}`, `open-${index}`, "commentary"));
  const turns = [
    { id: "done", status: "completed", startedAt: 10, completedAt: 11, items: terminalItems },
    { id: "open", status: "inProgress", startedAt: 12, completedAt: null, items: openItems },
  ];
  assert.deepEqual(openWorkerTurnIds(turns), ["open"]);
  assert.deepEqual(terminalWorkerTurnIds(turns), ["done"]);
  const newest = pageWorkerConversation(turns, 20);
  assert.deepEqual(newest.messages.map((row) => row.body), Array.from({ length: 20 }, (_, index) => `open-${index + 5}`));
  assert.equal(newest.hasOlder, true);
  assert.ok(newest.nextCursor);
  const older = pageWorkerConversation(turns, 20, newest.nextCursor);
  assert.deepEqual(older.messages.map((row) => row.body), [
    ...Array.from({ length: 15 }, (_, index) => `done-${index + 10}`),
    ...Array.from({ length: 5 }, (_, index) => `open-${index}`),
  ]);
  assert.equal(older.hasOlder, true);
  assert.ok(older.nextCursor);
  const oldest = pageWorkerConversation(turns, 20, older.nextCursor);
  assert.deepEqual(oldest.messages.map((row) => row.body), Array.from({ length: 10 }, (_, index) => `done-${index}`));
  assert.equal(oldest.hasOlder, false);
  assert.equal(oldest.nextCursor, undefined);
});

test("Claude-style userMessage without content yields agent rows only", () => {
  const turns = [{ id: "t1", status: "completed", startedAt: 1, completedAt: 2, items: [{ type: "userMessage", id: "u", clientId: "u" }, agentMsg("a", "reply")] }];
  assert.deepEqual(pageWorkerConversation(turns, 20).messages.map((row) => [row.role, row.body]), [["worker", "reply"]]);
});

test("Claude transcript history places the response after its correlated user message", () => {
  const started = "2026-07-25T03:25:02.550Z";
  const completed = "2026-07-25T03:25:23.621Z";
  const thread = reconstructClaudeThread({
    threadId: "claude",
    cwd: "/work",
    records: [
      {
        type: "user", promptSource: "sdk", promptId: "prompt", uuid: "user", timestamp: started,
        message: { role: "user", content: "do the work\n\n<!-- qiyan-cid:to:web:input -->" },
      },
      {
        type: "assistant", uuid: "agent", timestamp: completed,
        message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
      },
    ],
  });

  assert.deepEqual(
    pageWorkerConversation(thread.turns, 20).messages.map((row) => [row.role, row.body, row.completedAt, row.clientId]),
    [
      ["you", "do the work", Date.parse(started), "to:web:input"],
      ["worker", "done", Date.parse(completed), undefined],
    ],
  );
});

// A steer joins a turn that is already running, so its reply belongs to THAT turn. A turn
// carries only a start and an end, and while it runs the end is null -- so stamping every item
// with the turn's time collapsed them all onto its START. A message sent mid-turn then sorted
// after replies written minutes later, and Claude's answers appeared above the question.
test("items in a running turn keep their own moment, so a mid-turn message stays in order", () => {
  const turns = [{
    id: "running", status: "inProgress", turnOrder: 0,
    startedAt: 1_786_000_000_000, completedAt: null,
    items: [
      { type: "userMessage", id: "u0", itemOrder: 0, atMs: 1_786_000_000_000, content: [{ type: "text", text: "start the work" }] },
      { type: "agentMessage", id: "a1", itemOrder: 1, atMs: 1_786_000_060_000, text: "before the steer" },
      // Your steer, folded into this turn, then the reply to it.
      { type: "userMessage", id: "u1", itemOrder: 2, atMs: 1_786_000_120_000, content: [{ type: "text", text: "actually do X" }] },
      { type: "agentMessage", id: "a2", itemOrder: 3, atMs: 1_786_000_180_000, text: "answering the steer" },
    ],
  }];

  const rows = workerConversationRows(turns);
  assert.deepEqual(rows.map((row) => [row.role, row.body, row.completedAt]), [
    ["you", "start the work", 1_786_000_000_000],
    ["worker", "before the steer", 1_786_000_060_000],
    ["you", "actually do X", 1_786_000_120_000],
    ["worker", "answering the steer", 1_786_000_180_000],
  ]);
});

// Without per-item times nothing changes: the turn's own start and end still order the rows.
test("a turn whose items carry no timestamps still orders by the turn", () => {
  const rows = workerConversationRows([{
    id: "done", status: "completed", turnOrder: 0, startedAt: 1_786_000_000_000, completedAt: 1_786_000_090_000,
    items: [
      { type: "userMessage", id: "u0", itemOrder: 0, content: [{ type: "text", text: "ask" }] },
      { type: "agentMessage", id: "a1", itemOrder: 1, text: "answer" },
    ],
  }]);
  assert.deepEqual(rows.map((row) => [row.role, row.completedAt]), [["you", 1_786_000_000_000], ["worker", 1_786_000_090_000]]);
});
