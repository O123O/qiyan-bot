import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCodexRolloutHistoryPage, readLocalRolloutSlice, type RolloutSlice } from "../../src/sessions/codex-rollout-history.ts";

const row = (offset: number, value: unknown) => ({ offset, line: JSON.stringify(value) });
const event = (timestamp: string, type: string, turnId: string) => ({ timestamp, type: "event_msg", payload: { type, turn_id: turnId } });
const message = (timestamp: string, role: "user" | "assistant", text: string, phase?: string, turnId?: string) => ({
  timestamp,
  type: "response_item",
  payload: {
    type: "message", role, ...(phase ? { phase } : {}),
    ...(turnId ? { internal_chat_message_metadata_passthrough: { turn_id: turnId } } : {}),
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  },
});
const userMessage = (timestamp: string, text: string) => ({
  timestamp,
  type: "event_msg",
  payload: { type: "user_message", message: text, images: [] },
});
const imageMessage = (timestamp: string) => ({
  timestamp,
  type: "event_msg",
  payload: {
    type: "user_message", message: "", images: ["data:image/png;base64,AA=="],
  },
});

test("shows semantic user messages but hides raw app-server control messages", async () => {
  const rows = [
    row(100, event("2026-01-01T00:00:00Z", "task_started", "turn-1")),
    row(200, message("2026-01-01T00:00:01Z", "user", "<subagent_notification>internal result</subagent_notification>")),
    row(300, { timestamp: "2026-01-01T00:00:02Z", type: "event_msg", payload: { type: "user_message", client_id: "to:web:input", message: "real prompt", images: [] } }),
    row(400, message("2026-01-01T00:00:03Z", "assistant", "answer", "final_answer")),
    row(500, event("2026-01-01T00:00:04Z", "task_complete", "turn-1")),
  ];
  const page = await readCodexRolloutHistoryPage({
    readSlice: async () => ({ device: "1", inode: "2", size: 600, start: 0, end: 600, rows }),
  }, { path: "/x/rollout-thread.jsonl", threadId: "thread", nativeStatus: "idle", activeTurnId: null, limit: 20 }, new AbortController().signal);
  assert.deepEqual(page.messages.map((item) => [item.role ?? "worker", item.body]), [["you", "real prompt"], ["worker", "answer"]]);
  assert.equal(page.messages[0]!.clientId, "to:web:input");
});

test("reads recent Codex messages from bounded rollout slices without native turn history", async () => {
  const slices: RolloutSlice[] = [{
    device: "1", inode: "2", size: 10_000, start: 5_000, end: 10_000,
    rows: [
      row(5_100, event("2026-01-01T00:00:00Z", "task_started", "turn-1")),
      row(5_200, userMessage("2026-01-01T00:00:01Z", "hello")),
      row(5_300, message("2026-01-01T00:00:02Z", "assistant", "working", "commentary")),
      row(5_400, message("2026-01-01T00:00:03Z", "assistant", "done", "final_answer")),
      row(5_500, event("2026-01-01T00:00:04Z", "task_complete", "turn-1")),
    ],
  }];
  const calls: Array<{ before?: number; maxBytes: number }> = [];
  const page = await readCodexRolloutHistoryPage({
    readSlice: async (_path, _threadId, before, maxBytes) => {
      calls.push({ ...(before === undefined ? {} : { before }), maxBytes });
      return slices.shift()!;
    },
  }, { path: "/x/rollout-thread.jsonl", threadId: "thread", nativeStatus: "idle", activeTurnId: null, limit: 2 }, new AbortController().signal);
  assert.deepEqual(page.messages.map((item) => [item.role ?? "worker", item.body, item.turnId, item.terminalStatus, item.phase]), [
    ["worker", "working", "turn-1", "completed", "commentary"],
    ["worker", "done", "turn-1", "completed", "final_answer"],
  ]);
  assert.deepEqual(page.terminalTurnIds, ["turn-1"]);
  assert.equal(page.hasOlder, true);
  assert.ok(page.nextCursor);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.maxBytes <= 8 * 1024 * 1024);
});

test("uses live native state for an incomplete tail turn", async () => {
  const page = await readCodexRolloutHistoryPage({
    readSlice: async () => ({
      device: "3", inode: "4", size: 1_000, start: 0, end: 1_000,
      rows: [row(100, message("2026-01-01T00:00:01Z", "assistant", "still working", "commentary"))],
    }),
  }, { path: "/x/rollout-thread.jsonl", threadId: "thread", nativeStatus: "active", activeTurnId: "active-turn", limit: 20 }, new AbortController().signal);
  assert.equal(page.messages[0]!.turnId, "active-turn");
  assert.equal(page.messages[0]!.terminalStatus, "inProgress");
  assert.deepEqual(page.openTurnIds, ["active-turn"]);
});

test("local rollout slices transfer only conversational and turn-boundary rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const threadId = "019f0000-0000-7000-8000-000000000001";
  const path = join(dir, `rollout-2026-01-01T00-00-00-${threadId}.jsonl`);
  const lines = [
    JSON.stringify(event("2026-01-01T00:00:00Z", "task_started", "turn-1")),
    JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(1_000) } }),
    JSON.stringify(message("2026-01-01T00:00:01Z", "assistant", "visible", "commentary")),
  ];
  await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  const slice = await readLocalRolloutSlice(path, threadId, undefined, 8 * 1024 * 1024, new AbortController().signal);
  assert.equal(slice.start, 0);
  assert.equal(slice.rows.length, 2);
  assert.ok(slice.rows.every((item) => !item.line.includes("function_call_output")));
});

test("carries terminal status across message-page boundaries and exposes only the authoritative active turn", async () => {
  const rows = [
    row(100, message("2026-01-01T00:00:01Z", "assistant", "old-one", "commentary", "old")),
    row(200, message("2026-01-01T00:00:02Z", "assistant", "old-two", "final_answer", "old")),
    row(300, event("2026-01-01T00:00:03Z", "task_complete", "old")),
    row(400, event("2026-01-01T00:00:04Z", "task_started", "active")),
    row(500, message("2026-01-01T00:00:05Z", "assistant", "new", "commentary", "active")),
  ];
  const readSlice = async (_path: string, _threadId: string, before: number | undefined): Promise<RolloutSlice> => ({
    device: "1", inode: "2", size: 600, start: 0, end: before ?? 600, rows: rows.filter((item) => item.offset < (before ?? 600)),
  });
  const input = { path: "/x/rollout-thread.jsonl", threadId: "thread", nativeStatus: "active", activeTurnId: "active", limit: 1 };
  const first = await readCodexRolloutHistoryPage({ readSlice }, input, new AbortController().signal);
  const second = await readCodexRolloutHistoryPage({ readSlice }, { ...input, cursor: first.nextCursor! }, new AbortController().signal);
  const third = await readCodexRolloutHistoryPage({ readSlice }, { ...input, cursor: second.nextCursor! }, new AbortController().signal);
  assert.deepEqual([first.messages[0]!.body, second.messages[0]!.body, third.messages[0]!.body], ["new", "old-two", "old-one"]);
  assert.equal(third.messages[0]!.terminalStatus, "completed");
  assert.deepEqual(third.openTurnIds, ["active"]);
});

test("maps aborted and error completions to interrupted and failed terminal turns", async () => {
  const rows = [
    row(100, message("2026-01-01T00:00:01Z", "assistant", "aborted", "commentary", "a")),
    row(200, event("2026-01-01T00:00:02Z", "turn_aborted", "a")),
    row(300, message("2026-01-01T00:00:03Z", "assistant", "failed", "commentary", "f")),
    row(400, { timestamp: "2026-01-01T00:00:04Z", type: "event_msg", payload: { type: "task_complete", turn_id: "f", error: { message: "no" } } }),
  ];
  const page = await readCodexRolloutHistoryPage({
    readSlice: async () => ({ device: "1", inode: "2", size: 500, start: 0, end: 500, rows }),
  }, { path: "/x/rollout-thread.jsonl", threadId: "thread", nativeStatus: "idle", activeTurnId: null, limit: 20 }, new AbortController().signal);
  assert.deepEqual(page.messages.map((item) => [item.body, item.terminalStatus]), [["aborted", "interrupted"], ["failed", "failed"]]);
  assert.deepEqual(page.terminalTurnIds, ["a", "f"]);
});

test("removes rolled-back turns from paged history", async () => {
  const rows = [
    row(100, userMessage("2026-01-01T00:00:01Z", "keep")),
    row(200, userMessage("2026-01-01T00:00:02Z", "remove")),
    row(300, { timestamp: "2026-01-01T00:00:03Z", type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } }),
    row(400, userMessage("2026-01-01T00:00:04Z", "latest")),
  ];
  const readSlice = async (_path: string, _threadId: string, before: number | undefined): Promise<RolloutSlice> => ({
    device: "1", inode: "2", size: 500, start: 0, end: before ?? 500, rows: rows.filter((item) => item.offset < (before ?? 500)),
  });
  const input = { path: "/x/rollout-thread.jsonl", threadId: "thread", nativeStatus: "idle", activeTurnId: null, limit: 1 };
  const first = await readCodexRolloutHistoryPage({ readSlice }, input, new AbortController().signal);
  const second = await readCodexRolloutHistoryPage({ readSlice }, { ...input, cursor: first.nextCursor! }, new AbortController().signal);
  assert.deepEqual([first.messages[0]!.body, second.messages[0]!.body], ["latest", "keep"]);
  assert.equal(second.hasOlder, false);
});

test("rollback skips standalone assistant turns without consuming the user-turn count", async () => {
  const rows = [
    row(100, userMessage("2026-01-01T00:00:01Z", "keep")),
    row(200, userMessage("2026-01-01T00:00:02Z", "remove")),
    row(250, message("2026-01-01T00:00:02Z", "assistant", "standalone", "commentary", "standalone")),
    row(300, { timestamp: "2026-01-01T00:00:03Z", type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } }),
  ];
  const page = await readCodexRolloutHistoryPage({
    readSlice: async () => ({ device: "1", inode: "2", size: 400, start: 0, end: 400, rows }),
  }, { path: "/x/rollout-thread.jsonl", threadId: "thread", nativeStatus: "idle", activeTurnId: null, limit: 20 }, new AbortController().signal);
  assert.deepEqual(page.messages.map((item) => item.body), ["keep"]);
});

test("attachment-only user messages remain rollback turn boundaries", async () => {
  const rows = [
    row(100, userMessage("2026-01-01T00:00:01Z", "keep")),
    row(200, imageMessage("2026-01-01T00:00:02Z")),
    row(250, message("2026-01-01T00:00:02Z", "assistant", "image reply", "final_answer", "image")),
    row(300, { timestamp: "2026-01-01T00:00:03Z", type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } }),
  ];
  const page = await readCodexRolloutHistoryPage({
    readSlice: async () => ({ device: "1", inode: "2", size: 400, start: 0, end: 400, rows }),
  }, { path: "/x/rollout-thread.jsonl", threadId: "thread", nativeStatus: "idle", activeTurnId: null, limit: 20 }, new AbortController().signal);
  assert.deepEqual(page.messages.map((item) => item.body), ["keep"]);
});

test("carries attachment-only rollback boundaries across bounded pages", async () => {
  const mib = 1024 * 1024;
  const size = 100 * mib;
  const rows = [
    row(1 * mib, userMessage("2026-01-01T00:00:01Z", "keep")),
    row(40 * mib, imageMessage("2026-01-01T00:00:02Z")),
    row(41 * mib, message("2026-01-01T00:00:02Z", "assistant", "image reply", "final_answer", "image")),
    row(70 * mib, { timestamp: "2026-01-01T00:00:03Z", type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } }),
    row(80 * mib, userMessage("2026-01-01T00:00:04Z", "latest")),
  ];
  const readSlice = async (_path: string, _threadId: string, before: number | undefined, maxBytes: number): Promise<RolloutSlice> => {
    const end = before ?? size;
    const start = Math.max(0, end - maxBytes);
    return { device: "1", inode: "2", size, start, end, rows: rows.filter((item) => item.offset >= start && item.offset < end) };
  };
  const input = { path: "/x/rollout-thread.jsonl", threadId: "thread", nativeStatus: "idle", activeTurnId: null, limit: 1 };
  let page = await readCodexRolloutHistoryPage({ readSlice }, input, new AbortController().signal);
  const bodies = [...page.messages.map((item) => item.body)];
  while (page.hasOlder && page.nextCursor) {
    page = await readCodexRolloutHistoryPage({ readSlice }, { ...input, cursor: page.nextCursor }, new AbortController().signal);
    bodies.push(...page.messages.map((item) => item.body));
  }
  assert.deepEqual(bodies, ["latest", "keep"]);
});

test("carries unresolved rollback state across bounded empty pages", async () => {
  const mib = 1024 * 1024;
  const size = 100 * mib;
  const rows = [
    row(1 * mib, userMessage("2026-01-01T00:00:01Z", "keep")),
    row(2 * mib, userMessage("2026-01-01T00:00:02Z", "remove")),
    row(60 * mib, message("2026-01-01T00:00:02Z", "assistant", "standalone", "commentary", "standalone")),
    row(70 * mib, { timestamp: "2026-01-01T00:00:03Z", type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } }),
    row(80 * mib, userMessage("2026-01-01T00:00:04Z", "latest")),
  ];
  const readSlice = async (_path: string, _threadId: string, before: number | undefined, maxBytes: number): Promise<RolloutSlice> => {
    const end = before ?? size;
    const start = Math.max(0, end - maxBytes);
    return { device: "1", inode: "2", size, start, end, rows: rows.filter((item) => item.offset >= start && item.offset < end) };
  };
  const input = { path: "/x/rollout-thread.jsonl", threadId: "thread", nativeStatus: "idle", activeTurnId: null, limit: 1 };
  let page = await readCodexRolloutHistoryPage({ readSlice }, input, new AbortController().signal);
  assert.equal(page.messages[0]!.body, "latest");
  const bodies: string[] = [];
  while (page.hasOlder && page.nextCursor) {
    page = await readCodexRolloutHistoryPage({ readSlice }, { ...input, cursor: page.nextCursor }, new AbortController().signal);
    bodies.push(...page.messages.map((item) => item.body));
  }
  assert.deepEqual(bodies, ["keep"]);
});
