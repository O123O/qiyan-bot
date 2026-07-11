import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { reconstructClaudeThread, type ClaudeThreadView } from "../../src/sessions/claude-thread.ts";

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

test("an interrupted turn is inProgress with no final_answer; thread is active", () => {
  const v = view("interrupted");
  assert.equal(v.turns.length, 1);
  assert.equal(v.turns[0]?.status, "inProgress");
  assert.equal(v.status.type, "active");
  assert.equal(finalAnswers(v).length, 0);
  assert.equal(v.turns[0]?.items[0]?.type, "userMessage");
});

test("a known-interrupted turn id is reported interrupted (terminal)", () => {
  const raw = records("interrupted");
  const turnStart = raw.find((r): r is Record<string, unknown> => !!r && typeof r === "object" && (r as Record<string, unknown>).type === "user" && typeof (r as Record<string, unknown>).promptSource === "string");
  const turnId = String((turnStart as Record<string, unknown>).promptId);
  const v = reconstructClaudeThread({ threadId: "interrupted", cwd: "/tmp/x", records: raw, interruptedTurnIds: new Set([turnId]) });
  assert.equal(v.turns[0]?.status, "interrupted");
});

test("userMessage carries the QiYan clientId marker; phases split final vs commentary", () => {
  const recs = [
    { type: "user", promptSource: "sdk", promptId: "p1", uuid: "u1", message: { role: "user", content: "hello <!-- qiyan-cid:ctx:7 -->" } },
    { type: "assistant", uuid: "a1", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "let me check" }] } },
    { type: "user", promptSource: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } },
    { type: "assistant", uuid: "a2", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "the answer" }] } },
  ];
  const v = reconstructClaudeThread({ threadId: "s1", cwd: "/tmp/x", records: recs });
  assert.equal(v.turns.length, 1);
  const items = v.turns[0]!.items;
  assert.deepEqual(items[0], { type: "userMessage", id: "u1", clientId: "ctx:7" });
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
