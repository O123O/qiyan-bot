import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { claudeMessagePhase, reconstructClaudeThread, type ClaudeThreadView } from "../../src/sessions/claude-thread.ts";

function records(name: string): unknown[] {
  const path = fileURLToPath(new URL(`./fixtures/claude/${name}.jsonl`, import.meta.url));
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}
const view = (name: string, extra?: Partial<Parameters<typeof reconstructClaudeThread>[0]>): ClaudeThreadView =>
  reconstructClaudeThread({ threadId: name, cwd: "/tmp/x", records: records(name), ...extra });

function finalAnswers(v: ClaudeThreadView) {
  return v.turns.flatMap((t) => t.items.filter((i) => i.type === "agentMessage" && i.phase === "final_answer" && i.text));
}

test("basic Q&A reconstructs two completed turns, each with a userMessage and a final_answer", () => {
  const v = view("basic-qa");
  assert.equal(v.turns.length, 2);
  assert.equal(v.status.type, "idle");
  for (const turn of v.turns) {
    assert.equal(turn.status, "completed");
    assert.equal(turn.itemsView, "full");
    assert.equal(turn.items[0]?.type, "userMessage");
    assert.ok(turn.items.some((i) => i.type === "agentMessage" && i.phase === "final_answer" && (i.text?.length ?? 0) > 0));
  }
});

test("a tool-use turn is one completed turn with a delivered final_answer", () => {
  const v = view("tool-use");
  assert.equal(v.turns.length, 1);
  assert.equal(v.turns[0]?.status, "completed");
  assert.equal(finalAnswers(v).length >= 1, true);
});

test("a native subagent task notification remains internal to its parent turn", () => {
  const recs = [
    { type: "user", promptSource: "sdk", promptId: "p1", uuid: "u1", message: { role: "user", content: "delegate this" } },
    { type: "assistant", uuid: "a1", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "delegating" }] } },
    {
      type: "user", promptSource: "sdk", promptId: "subagent-result", uuid: "notification",
      message: { role: "user", content: "<task-notification><task-id>agent-1</task-id><summary>done</summary></task-notification>" },
    },
    { type: "assistant", uuid: "a2", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "parent result" }] } },
  ];

  const v = reconstructClaudeThread({ threadId: "s1", cwd: "/tmp/x", records: recs });
  assert.equal(v.turns.length, 1);
  // The turn id is the user row's own uuid — for a QiYan-driven turn that IS the
  // clientUserMessageId handed to the SDK, so live events and history agree. promptId is
  // a separate Claude-generated id that matches nothing QiYan knows.
  assert.equal(v.turns[0]?.id, "u1");
  assert.equal(v.turns[0]?.items.filter((item) => item.type === "userMessage").length, 1);
  assert.equal(v.turns[0]?.items.find((item) => item.phase === "final_answer")?.text, "parent result");
});

test("a cold incomplete transcript is interrupted because no tracked Claude child is running", () => {
  const v = view("interrupted");
  assert.equal(v.turns.length, 1);
  assert.equal(v.turns[0]?.status, "interrupted");
  assert.equal(v.status.type, "idle");
  assert.equal(finalAnswers(v).length, 0);
  assert.equal(v.turns[0]?.items[0]?.type, "userMessage");
});

test("an incomplete transcript is active only while its exact tracked Claude child is running", () => {
  const raw = records("interrupted");
  const turnStart = raw.find((record): record is Record<string, unknown> => !!record && typeof record === "object"
    && (record as Record<string, unknown>).type === "user" && typeof (record as Record<string, unknown>).promptSource === "string");
  const runningTurnId = String((turnStart as Record<string, unknown>).uuid);
  const v = reconstructClaudeThread({ threadId: "interrupted", cwd: "/tmp/x", records: raw, runningTurnId });
  assert.equal(v.turns[0]?.status, "inProgress");
  assert.equal(v.status.type, "active");
});

test("a known-interrupted turn id is reported interrupted (terminal)", () => {
  const raw = records("interrupted");
  const turnStart = raw.find((r): r is Record<string, unknown> => !!r && typeof r === "object" && (r as Record<string, unknown>).type === "user" && typeof (r as Record<string, unknown>).promptSource === "string");
  const turnId = String((turnStart as Record<string, unknown>).uuid);
  const v = reconstructClaudeThread({ threadId: "interrupted", cwd: "/tmp/x", records: raw, interruptedTurnIds: new Set([turnId]) });
  assert.equal(v.turns[0]?.status, "interrupted");
});

// A live turn and its reconstructed history must key identically or the Web UI merges
// nothing and renders every message twice: it matches on item id first, then clientId,
// then a fallback needing turnId + body + phase to agree.
test("reconstructed ids match what the live host events carry", () => {
  const recs = [
    { type: "user", promptSource: "sdk", promptId: "claude-generated", uuid: "client-uuid",
      message: { role: "user", content: "hi" } },
    { type: "assistant", uuid: "assistant-uuid",
      message: { role: "assistant", stop_reason: "end_turn", content: [
        { type: "text", text: "first" }, { type: "thinking", thinking: "ignored" }, { type: "text", text: "second" },
      ] } },
  ];
  const v = reconstructClaudeThread({ threadId: "s1", cwd: "/tmp/x", records: recs });
  assert.equal(v.turns[0]?.id, "client-uuid", "turn id === the uuid QiYan sent");
  const items = v.turns[0]!.items;
  assert.equal(items.find((item) => item.type === "userMessage")?.id, "client-uuid");
  // Non-text blocks are skipped by BOTH enumerations, so the indices stay aligned.
  assert.deepEqual(items.filter((item) => item.type === "agentMessage").map((item) => item.id),
    ["assistant-uuid:0", "assistant-uuid:1"]);
});

test("userMessage carries the QiYan clientId marker; phases split final vs commentary", () => {
  const recs = [
    { type: "user", promptSource: "sdk", promptId: "p1", uuid: "u1", timestamp: "2026-07-25T03:25:02.550Z", message: { role: "user", content: "hello <!-- qiyan-cid:ctx:7 -->" } },
    { type: "assistant", uuid: "a1", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "let me check" }] } },
    { type: "user", promptSource: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } },
    { type: "assistant", uuid: "a2", timestamp: "2026-07-25T03:25:23.621Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "the answer" }] } },
  ];
  const v = reconstructClaudeThread({ threadId: "s1", cwd: "/tmp/x", records: recs });
  assert.equal(v.turns.length, 1);
  const turn = v.turns[0]!;
  const items = turn.items;
  assert.deepEqual(items[0], {
    type: "userMessage",
    id: "u1",
    clientId: "ctx:7",
    content: [{ type: "text", text: "hello", text_elements: [] }],
  });
  assert.equal(turn.startedAt, Date.parse("2026-07-25T03:25:02.550Z"));
  assert.equal(turn.completedAt, Date.parse("2026-07-25T03:25:23.621Z"));
  assert.deepEqual(items.filter((i) => i.type === "agentMessage").map((i) => i.phase), ["commentary", "final_answer"]);
  assert.equal(items.find((i) => i.phase === "final_answer")?.text, "the answer");
});

test("a failed turn with no transcript row is synthesized as a findable interrupted turn", () => {
  // claude died before writing its user row (e.g. spawn ENOENT); the relay must
  // still find a terminal turn by id to release capacity instead of retrying forever.
  const v = reconstructClaudeThread({ threadId: "s1", cwd: "/w", records: [], interruptedTurnIds: new Set(["ctx:x"]) });
  assert.equal(v.turns.length, 1);
  assert.equal(v.turns[0]?.id, "ctx:x");
  assert.equal(v.turns[0]?.status, "interrupted");
  assert.equal(v.turns[0]?.items[0]?.clientId, "ctx:x");
  assert.equal(v.status.type, "idle");
});

test("a turn truncated by max_tokens still completes (not open forever)", () => {
  const recs = [
    { type: "user", promptSource: "sdk", promptId: "p1", uuid: "u1", message: { role: "user", content: "go" } },
    { type: "assistant", uuid: "a1", message: { role: "assistant", stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }] } },
  ];
  const v = reconstructClaudeThread({ threadId: "s1", cwd: "/tmp/x", records: recs });
  assert.equal(v.turns[0]?.status, "completed");
  assert.equal(v.status.type, "idle");
});

// Live SDK events and reconstructed history are merged by item id, so they must phase an
// assistant message identically or the merged message describes itself two ways.
test("the phase rule is shared between the live path and reconstruction", () => {
  assert.equal(claudeMessagePhase({ message: { stop_reason: "end_turn" } }), "final_answer");
  assert.equal(claudeMessagePhase({ message: { stop_reason: "max_tokens" } }), "final_answer",
    "a turn truncated by the model still ends it");
  assert.equal(claudeMessagePhase({ message: { stop_reason: "tool_use" } }), "commentary",
    "text before a tool call is intermediate, and is shown as it arrives");
  assert.equal(claudeMessagePhase({ message: {} }), "commentary", "still streaming");
  assert.equal(claudeMessagePhase({}), "commentary", "a malformed record is never a final answer");

  // The same rule must produce the same phases reconstruction assigns.
  const view = reconstructClaudeThread({ threadId: "s1", cwd: "/tmp/x", records: [
    { type: "user", promptSource: "sdk", uuid: "u1", message: { role: "user", content: "go" } },
    { type: "assistant", uuid: "a1", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "checking" }] } },
    { type: "assistant", uuid: "a2", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } },
  ] });
  assert.deepEqual(
    view.turns[0]!.items.filter((item) => item.type === "agentMessage").map((item) => [item.text, item.phase]),
    [["checking", "commentary"], ["done", "final_answer"]]);
});
