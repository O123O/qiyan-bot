import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCodexRolloutHistory } from "../../src/webui/codex-rollout-history.ts";

const line = (timestamp: string, type: string, payload: unknown): string => JSON.stringify({ timestamp, type, payload }) + "\n";

test("Codex rollout history pages exact visible messages by a stable byte cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-web-history-"));
  const threadId = "thread-one";
  const path = join(root, `rollout-now-${threadId}.jsonl`);
  await writeFile(path, [
    line("2026-01-01T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: "turn-1" }),
    line("2026-01-01T00:00:01.000Z", "event_msg", { type: "user_message", message: "first question", client_id: "client-1" }),
    line("2026-01-01T00:00:02.000Z", "response_item", { type: "message", role: "assistant", id: "agent-1", phase: "commentary", content: [{ type: "output_text", text: "first update" }] }),
    line("2026-01-01T00:00:03.000Z", "response_item", { type: "function_call_output", output: "must not leak" }),
    line("2026-01-01T00:00:04.000Z", "event_msg", { type: "task_complete", turn_id: "turn-1" }),
    line("2026-01-01T00:01:00.000Z", "event_msg", { type: "task_started", turn_id: "turn-2" }),
    line("2026-01-01T00:01:01.000Z", "event_msg", { type: "user_message", message: "second question", client_id: "client-2" }),
    line("2026-01-01T00:01:02.000Z", "response_item", { type: "message", role: "assistant", id: "agent-2", phase: "final_answer", content: [{ type: "output_text", text: "second answer" }] }),
  ].join(""));

  const latest = await readCodexRolloutHistory({ path, threadId, limit: 2 });
  assert.deepEqual(latest.messages.map((message) => [message.id, message.turnId, message.body, message.clientId, message.phase]), [
    ["u:turn-2:client-2", "turn-2", "second question", "client-2", undefined],
    ["a:turn-2:agent-2", "turn-2", "second answer", undefined, "final_answer"],
  ]);
  assert.deepEqual(latest.openTurnIds, ["turn-2"]);
  assert.equal(latest.hasOlder, true);
  assert.ok(latest.nextCursor);

  const older = await readCodexRolloutHistory({ path, threadId, limit: 2, cursor: latest.nextCursor! });
  assert.deepEqual(older.messages.map((message) => [message.id, message.turnId, message.body, message.terminalStatus]), [
    ["u:turn-1:client-1", "turn-1", "first question", "completed"],
    ["a:turn-1:agent-1", "turn-1", "first update", "completed"],
  ]);
  assert.deepEqual(older.terminalTurnIds, ["turn-1"]);
  assert.equal(older.hasOlder, false);
});

test("Codex rollout history preserves terminal proof across pages of one long turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-web-history-long-turn-"));
  const threadId = "thread-long-turn";
  const path = join(root, `rollout-now-${threadId}.jsonl`);
  await writeFile(path, [
    line("2026-01-01T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: "turn" }),
    ...Array.from({ length: 4 }, (_, index) => line(`2026-01-01T00:00:0${index + 1}.000Z`, "response_item", {
      type: "message", role: "assistant", id: `a${index}`, content: [{ type: "output_text", text: `m${index}` }],
    })),
    line("2026-01-01T00:00:05.000Z", "event_msg", { type: "task_complete", turn_id: "turn" }),
  ].join(""));

  const latest = await readCodexRolloutHistory({ path, threadId, limit: 2 });
  assert.deepEqual(latest.messages.map((message) => [message.body, message.terminalStatus]), [["m2", "completed"], ["m3", "completed"]]);
  assert.ok(latest.nextCursor);
  const older = await readCodexRolloutHistory({ path, threadId, limit: 2, cursor: latest.nextCursor });
  assert.deepEqual(older.messages.map((message) => [message.body, message.terminalStatus]), [["m0", "completed"], ["m1", "completed"]]);
  assert.deepEqual(older.openTurnIds, []);
  assert.deepEqual(older.terminalTurnIds, ["turn"]);
});

test("Codex rollout history drains a JSON-limited resolved turn through bounded cursors", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-web-history-resolved-turn-"));
  const threadId = "thread-resolved-turn";
  const path = join(root, `rollout-now-${threadId}.jsonl`);
  await writeFile(path, [
    line("2026-01-01T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: "turn" }),
    ...Array.from({ length: 3 }, (_, index) => line(`2026-01-01T00:00:0${index + 1}.000Z`, "response_item", {
      type: "message", role: "assistant", id: `a${index}`, content: [{ type: "output_text", text: "\0".repeat(150 * 1024) }],
    })),
    line("2026-01-01T00:00:04.000Z", "event_msg", { type: "task_complete", turn_id: "turn" }),
  ].join(""));

  let page = await readCodexRolloutHistory({ path, threadId, limit: 20 });
  assert.ok(page.nextCursor);
  const cursor = JSON.parse(Buffer.from(page.nextCursor, "base64url").toString("utf8")) as { resolved?: unknown };
  assert.ok(cursor.resolved);
  const messages = [...page.messages];
  for (let attempt = 0; attempt < 4 && page.nextCursor; attempt += 1) {
    page = await readCodexRolloutHistory({ path, threadId, limit: 20, cursor: page.nextCursor });
    messages.push(...page.messages);
  }
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map((message) => message.terminalStatus), ["completed", "completed", "completed"]);
});

test("Codex rollout history keeps an older cursor stable while the rollout grows", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-web-history-growth-"));
  const threadId = "thread-growth";
  const path = join(root, `rollout-now-${threadId}.jsonl`);
  const original = [
    line("2026-01-01T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: "turn-1" }),
    line("2026-01-01T00:00:01.000Z", "event_msg", { type: "user_message", message: "one" }),
    line("2026-01-01T00:00:02.000Z", "response_item", { type: "message", role: "assistant", id: "a1", content: [{ type: "output_text", text: "two" }] }),
    line("2026-01-01T00:00:03.000Z", "response_item", { type: "message", role: "assistant", id: "a2", content: [{ type: "output_text", text: "three" }] }),
  ].join("");
  await writeFile(path, original);
  const latest = await readCodexRolloutHistory({ path, threadId, limit: 1 });
  assert.equal(latest.messages[0]?.body, "three");

  await writeFile(path, original + line("2026-01-01T00:00:04.000Z", "response_item", {
    type: "message", role: "assistant", id: "a3", content: [{ type: "output_text", text: "new append" }],
  }));
  const older = await readCodexRolloutHistory({ path, threadId, limit: 2, cursor: latest.nextCursor! });
  assert.deepEqual(older.messages.map((message) => message.body), ["one", "two"]);
});

test("Codex rollout history bounds a single oversized message", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-web-history-bounds-"));
  const threadId = "thread-bounds";
  const path = join(root, `rollout-now-${threadId}.jsonl`);
  await writeFile(path, [
    line("2026-01-01T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: "turn" }),
    line("2026-01-01T00:00:01.000Z", "response_item", { type: "message", role: "assistant", id: "large", content: [{ type: "output_text", text: "x".repeat(400 * 1024) }] }),
  ].join(""));

  const page = await readCodexRolloutHistory({ path, threadId, limit: 20 });
  assert.equal(page.messages.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") < 256 * 1024);
  assert.match(page.messages[0]!.body, /message truncated/u);
});

test("Codex rollout history budgets JSON-escaped message bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-web-history-json-bounds-"));
  const threadId = "thread-json-bounds";
  const path = join(root, `rollout-now-${threadId}.jsonl`);
  await writeFile(path, [
    line("2026-01-01T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: "turn" }),
    line("2026-01-01T00:00:01.000Z", "response_item", { type: "message", role: "assistant", id: "controls", content: [{ type: "output_text", text: "\0".repeat(200 * 1024) }] }),
  ].join(""));

  const page = await readCodexRolloutHistory({ path, threadId, limit: 20 });
  assert.equal(page.messages.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") < 768 * 1024);
});

test("Codex rollout history continues across a tool-heavy scan window", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-web-history-scan-budget-"));
  const threadId = "thread-scan-budget";
  const path = join(root, `rollout-now-${threadId}.jsonl`);
  await writeFile(path, [
    line("2026-01-01T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: "turn" }),
    line("2026-01-01T00:00:01.000Z", "event_msg", { type: "user_message", message: "still reachable" }),
    line("2026-01-01T00:00:02.000Z", "response_item", { type: "function_call_output", output: "x".repeat(9 * 1024 * 1024) }),
  ].join(""));

  let page = await readCodexRolloutHistory({ path, threadId, limit: 20 });
  assert.deepEqual(page.messages, []);
  assert.equal(page.hasOlder, true);
  for (let attempt = 0; attempt < 4 && page.messages.length === 0; attempt += 1) {
    assert.ok(page.nextCursor);
    page = await readCodexRolloutHistory({ path, threadId, limit: 20, cursor: page.nextCursor });
  }
  assert.deepEqual(page.messages.map((message) => message.body), ["still reachable"]);
});

test("Codex rollout history shows the latest window of a known long-running turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-web-history-active-window-"));
  const threadId = "thread-active-window";
  const path = join(root, `rollout-now-${threadId}.jsonl`);
  await writeFile(path, [
    line("2026-01-01T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: "active-turn" }),
    line("2026-01-01T00:00:01.000Z", "event_msg", { type: "user_message", message: "original prompt" }),
    line("2026-01-01T00:00:02.000Z", "response_item", { type: "function_call_output", output: "x".repeat(5 * 1024 * 1024) }),
    line("2026-01-01T00:00:03.000Z", "event_msg", { type: "user_message", message: "latest steering", client_id: "latest-client" }),
    line("2026-01-01T00:00:04.000Z", "response_item", {
      type: "message", role: "assistant", id: "latest-commentary", phase: "commentary",
      content: [{ type: "output_text", text: "latest progress" }],
    }),
  ].join(""));

  const withoutActiveTurn = await readCodexRolloutHistory({ path, threadId, limit: 20 });
  assert.deepEqual(withoutActiveTurn.messages, []);

  const page = await readCodexRolloutHistory({ path, threadId, limit: 20, activeTurnId: "active-turn" });
  assert.deepEqual(page.messages.map((message) => [message.turnId, message.body, message.terminalStatus]), [
    ["active-turn", "latest steering", "inProgress"],
    ["active-turn", "latest progress", "inProgress"],
  ]);
  assert.deepEqual(page.openTurnIds, ["active-turn"]);
  assert.ok(page.nextCursor);
});

test("Codex rollout history continues across a record-heavy scan window", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-web-history-record-budget-"));
  const threadId = "thread-record-budget";
  const path = join(root, `rollout-now-${threadId}.jsonl`);
  await writeFile(path, [
    line("2026-01-01T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: "turn" }),
    line("2026-01-01T00:00:01.000Z", "event_msg", { type: "user_message", message: "still reachable" }),
    ...Array.from({ length: 20_001 }, () => "{}\n"),
  ].join(""));

  const first = await readCodexRolloutHistory({ path, threadId, limit: 20 });
  assert.deepEqual(first.messages, []);
  assert.ok(first.nextCursor);
  const second = await readCodexRolloutHistory({ path, threadId, limit: 20, cursor: first.nextCursor });
  assert.deepEqual(second.messages.map((message) => message.body), ["still reachable"]);
});

test("Codex rollout history rejects unordered or aggregate-unbounded pending offsets", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-web-history-cursor-budget-"));
  const threadId = "thread-cursor-budget";
  const path = join(root, `rollout-now-${threadId}.jsonl`);
  await writeFile(path, "x".repeat(7 * 1024 * 1024));
  const identity = await stat(path, { bigint: true });
  const cursor = Buffer.from(JSON.stringify({
    v: 2, device: identity.dev.toString(10), inode: identity.ino.toString(10), before: 0,
    pending: [
      { start: 5 * 1024 * 1024, end: 7 * 1024 * 1024 },
      { start: 3 * 1024 * 1024, end: 5 * 1024 * 1024 },
      { start: 1024 * 1024, end: 3 * 1024 * 1024 },
    ],
    terminals: [], skipPartial: false, pendingSkipped: false,
  }), "utf8").toString("base64url");

  await assert.rejects(readCodexRolloutHistory({ path, threadId, limit: 20, cursor }), /invalid.*cursor/iu);
});
