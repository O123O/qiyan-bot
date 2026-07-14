import assert from "node:assert/strict";
import test from "node:test";
import { mapWorkerConversation } from "../../src/sessions/worker-conversation.ts";

// Codex-shaped native items (thread/read): userMessage carries `content: Array<UserInput>`; agentMessage
// carries `text` + `phase`.
const userMsg = (id: string, text: string) => ({ type: "userMessage", id, clientId: id, content: [{ type: "text", text, text_elements: [] }] });
const agentMsg = (id: string, text: string, phase: string | null = "final_answer") => ({ type: "agentMessage", id, text, phase });

test("maps native turns to a two-sided prompt→reply list, oldest→newest, seconds→millis", () => {
  const turns = [
    { id: "t1", status: "completed", startedAt: 1_700_000_000, completedAt: 1_700_000_005, items: [userMsg("u1", "do X"), { type: "reasoning", id: "r1", summary: [], content: [] }, agentMsg("a1", "did X")] },
    { id: "t2", status: "completed", startedAt: 1_700_000_010, completedAt: 1_700_000_015, items: [userMsg("u2", "now Y"), agentMsg("a2", "did Y")] },
  ];
  const rows = mapWorkerConversation(turns, 20);
  assert.deepEqual(rows.map((r) => [r.role, r.body]), [["you", "do X"], ["worker", "did X"], ["you", "now Y"], ["worker", "did Y"]]);
  assert.equal(rows[0]!.completedAt, 1_700_000_000_000); // prompt sorts at the turn's startedAt (seconds→millis)
  assert.equal(rows[1]!.completedAt, 1_700_000_005_000); // reply at completedAt
  assert.equal(rows[1]!.terminalStatus, "completed");
  assert.ok(rows.every((r) => r.id.includes(":"))); // stable ids for client dedup
});

test("strips the codex <environment_context> setup block; drops a pure-setup message, keeps a real prompt after it", () => {
  const turns = [
    { id: "t1", status: "completed", startedAt: 1, completedAt: 2, items: [userMsg("u0", "<environment_context>\n<cwd>/x</cwd>\n</environment_context>"), agentMsg("a0", "ok")] },
    { id: "t2", status: "completed", startedAt: 3, completedAt: 4, items: [userMsg("u1", "<environment_context><cwd>/x</cwd></environment_context>\nreal prompt"), agentMsg("a1", "done")] },
  ];
  assert.deepEqual(mapWorkerConversation(turns, 20).map((r) => r.body), ["ok", "real prompt", "done"]);
});

test("chooses explicit final_answer items, else the last unknown-phase agent message; excludes commentary", () => {
  const turns = [
    { id: "t1", status: "completed", startedAt: 1, completedAt: 2, items: [{ type: "agentMessage", id: "c", text: "thinking", phase: "commentary" }, agentMsg("f", "answer", "final_answer")] },
    { id: "t2", status: "completed", startedAt: 3, completedAt: 4, items: [agentMsg("x", "one", null), agentMsg("y", "two", null)] },
  ];
  assert.deepEqual(mapWorkerConversation(turns, 20).map((r) => r.body), ["answer", "two"]);
});

test("Claude-style userMessage without content yields no prompt row (agent replies only)", () => {
  const turns = [{ id: "t1", status: "completed", startedAt: 1, completedAt: 2, items: [{ type: "userMessage", id: "u", clientId: "u" }, agentMsg("a", "reply")] }];
  assert.deepEqual(mapWorkerConversation(turns, 20).map((r) => [r.role, r.body]), [["worker", "reply"]]);
});

test("paginates newest-first with an inclusive before-cursor", () => {
  const turns = [
    { id: "t1", status: "completed", startedAt: 10, completedAt: 11, items: [userMsg("u1", "one"), agentMsg("a1", "r1")] },
    { id: "t2", status: "completed", startedAt: 12, completedAt: 13, items: [userMsg("u2", "two"), agentMsg("a2", "r2")] },
  ]; // ascending by time: one(10k), r1(11k), two(12k), r2(13k)
  assert.deepEqual(mapWorkerConversation(turns, 10).map((r) => r.body), ["one", "r1", "two", "r2"]);
  assert.deepEqual(mapWorkerConversation(turns, 2).map((r) => r.body), ["two", "r2"]);      // newest 2
  assert.deepEqual(mapWorkerConversation(turns, 2, 11_000).map((r) => r.body), ["one", "r1"]); // ≤ r1's time
});

test("an in-progress turn shows the prompt even before a reply exists", () => {
  const turns = [{ id: "t1", status: "inProgress", startedAt: 5, completedAt: null, items: [userMsg("u1", "please start")] }];
  assert.deepEqual(mapWorkerConversation(turns, 20).map((r) => [r.role, r.body]), [["you", "please start"]]);
});
