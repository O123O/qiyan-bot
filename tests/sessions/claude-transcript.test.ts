import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import {
  encodeClaudeClientMarker,
  scanLocalClaudeTranscript,
  validClaudeTranscriptPath,
} from "../../src/sessions/claude-transcript.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/claude/${name}.jsonl`, import.meta.url));

// ---- real Phase-0 transcript fixtures (spike/fixtures) ----

test("basic Q&A transcript reconstructs two completed turns, no open turn", async () => {
  const result = await scanLocalClaudeTranscript({ path: fixture("basic-qa"), threadId: "basic-qa", collectFromStart: true });
  assert.equal(result.starts.length, 2);
  for (const turn of result.starts) {
    assert.equal(turn.hasUserMessage, true);
    assert.equal(turn.clientId, undefined); // no QiYan marker in a plain spike transcript
    assert.equal(typeof turn.turnId, "string");
    assert.ok(turn.turnId.length > 0);
  }
  assert.equal(result.openTurn, undefined);
  assert.equal(result.malformed, undefined);
});

test("a tool_result user row is mid-turn, not a turn boundary", async () => {
  // tool-use fixture: one user turn -> assistant tool_use:Bash -> user(tool_result) -> assistant end_turn.
  const result = await scanLocalClaudeTranscript({ path: fixture("tool-use"), threadId: "tool-use", collectFromStart: true });
  assert.equal(result.starts.length, 1);
  assert.equal(result.openTurn, undefined);
});

test("a subagent (Task/Agent) is encapsulated as one tool call, not extra turns", async () => {
  const result = await scanLocalClaudeTranscript({ path: fixture("subagent"), threadId: "subagent", collectFromStart: true });
  assert.equal(result.starts.length, 1);
  assert.equal(result.openTurn, undefined);
});

test("an interrupted turn (no end_turn) is reported and surfaced as openTurn", async () => {
  const result = await scanLocalClaudeTranscript({ path: fixture("interrupted"), threadId: "interrupted", collectFromStart: true });
  assert.equal(result.starts.length, 1);
  assert.ok(result.openTurn);
  assert.equal(result.openTurn?.hasUserMessage, true);
});

// ---- synthetic transcripts: ownership marker, cursor, privacy, malformed ----

function userTurn(promptId: string, promptSource: string, content: string): string {
  return `${JSON.stringify({ type: "user", promptSource, promptId, message: { role: "user", content } })}\n`;
}
function endTurn(): string {
  return `${JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } })}\n`;
}
function toolResult(): string {
  return `${JSON.stringify({ type: "user", promptSource: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } })}\n`;
}

test("a QiYan-stamped clientId marker makes a turn owned; message body never leaves the scanner", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-claude-"));
  const path = join(root, "sess-owned.jsonl");
  const secret = "this private body must not appear in scan output";
  await writeFile(path, userTurn("p1", "sdk", `${secret} ${encodeClaudeClientMarker("context-9:call-3")}`) + endTurn());

  const result = await scanLocalClaudeTranscript({ path, threadId: "sess-owned", collectFromStart: true });

  assert.deepEqual(result.starts, [{ turnId: "context-9:call-3", clientId: "context-9:call-3", hasUserMessage: true }]);
  assert.equal(result.openTurn, undefined);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("a turn with a user message but no marker is external (no clientId)", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-claude-"));
  const path = join(root, "sess-external.jsonl");
  await writeFile(path, userTurn("p1", "user", "human typed this directly") + endTurn());

  const result = await scanLocalClaudeTranscript({ path, threadId: "sess-external", collectFromStart: true });

  assert.deepEqual(result.starts, [{ turnId: "p1", hasUserMessage: true }]);
});

test("incremental scan from a cursor returns only new turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-claude-"));
  const path = join(root, "sess-inc.jsonl");
  await writeFile(path, userTurn("p1", "sdk", `first ${encodeClaudeClientMarker("ctx:1")}`) + endTurn());
  const baseline = await scanLocalClaudeTranscript({ path, threadId: "sess-inc" });
  assert.equal(baseline.starts.length, 0); // no cursor + not collectFromStart => metadata only

  await appendFile(path, toolResult() + userTurn("p2", "sdk", `second ${encodeClaudeClientMarker("ctx:2")}`) + endTurn());
  const result = await scanLocalClaudeTranscript({ path, threadId: "sess-inc", cursor: baseline.cursor });

  assert.deepEqual(result.starts, [{ turnId: "ctx:2", clientId: "ctx:2", hasUserMessage: true }]);
  assert.equal(result.cursor.offset, Buffer.byteLength(await readFile(path)));
});

test("a malformed line is an uncertainty boundary that keeps earlier turns visible", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-claude-"));
  const path = join(root, "sess-malformed.jsonl");
  await writeFile(path, userTurn("p1", "sdk", `done ${encodeClaudeClientMarker("ctx:1")}`) + endTurn());
  await appendFile(path, Buffer.from([0x7b, 0x7b, 0x0a])); // "{{\n" — invalid JSON

  const result = await scanLocalClaudeTranscript({ path, threadId: "sess-malformed", collectFromStart: true });

  assert.equal(result.malformed, true);
  assert.deepEqual(result.starts, [{ turnId: "ctx:1", clientId: "ctx:1", hasUserMessage: true }]);
});

test("validClaudeTranscriptPath accepts <session_id>.jsonl and rejects Codex rollout names", () => {
  assert.equal(validClaudeTranscriptPath("/a/b/sess-1.jsonl", "sess-1"), true);
  assert.equal(validClaudeTranscriptPath("/a/b/rollout-x-sess-1.jsonl", "sess-1"), false);
  assert.equal(validClaudeTranscriptPath("relative/sess-1.jsonl", "sess-1"), false);
  assert.equal(validClaudeTranscriptPath("/a/b/sess-1.jsonl", "../evil"), false);
});
