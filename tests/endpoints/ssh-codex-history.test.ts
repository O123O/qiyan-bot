import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeRemoteArgument, parseRemoteHelperResponse } from "../../src/endpoints/ssh-runtime.ts";
import { runBoundedProcess } from "../../src/endpoints/ssh-process.ts";
import { readCodexRolloutHistory } from "../../src/webui/codex-rollout-history.ts";

const helperPath = new URL("../../assets/remote/qiyan-ssh-helper.mjs", import.meta.url);
const line = (timestamp: string, type: string, payload: unknown): string => JSON.stringify({ timestamp, type, payload }) + "\n";

async function readRemote(request: Record<string, unknown>): Promise<any> {
  const result = await runBoundedProcess(process.execPath, [
    helperPath.pathname, "codex-history", encodeRemoteArgument(JSON.stringify(request)),
  ], { timeoutMs: 5_000, maxOutputBytes: 1024 * 1024 });
  return parseRemoteHelperResponse(result.stdout, "codex-history");
}

test("remote Codex history stays byte-equivalent to the local bounded reader", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-codex-history-parity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const threadId = "thread-parity";
  const path = join(root, `rollout-now-${threadId}.jsonl`);
  await writeFile(path, [
    line("2026-01-01T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: "turn-1" }),
    line("2026-01-01T00:00:01.000Z", "event_msg", { type: "user_message", message: "question", client_id: "client" }),
    line("2026-01-01T00:00:02.000Z", "response_item", { type: "message", role: "assistant", id: "commentary", phase: "commentary", content: [{ type: "output_text", text: "working" }] }),
    line("2026-01-01T00:00:03.000Z", "response_item", { type: "function_call_output", output: "excluded tool body" }),
    line("2026-01-01T00:00:04.000Z", "response_item", { type: "message", role: "assistant", id: "final", phase: "final_answer", content: [{ type: "output_text", text: "done" }] }),
    line("2026-01-01T00:00:05.000Z", "event_msg", { type: "task_complete", turn_id: "turn-1" }),
  ].join(""));
  const request = { path, threadId, limit: 20 };

  const local = await readCodexRolloutHistory(request);
  const remote = await readRemote(request);

  assert.deepEqual(remote, local);
});

test("remote Codex history matches bounded continuation and escaped-body behavior", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-codex-history-window-parity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const threadId = "thread-window-parity";
  const path = join(root, `rollout-now-${threadId}.jsonl`);
  await writeFile(path, [
    line("2026-01-01T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: "turn" }),
    line("2026-01-01T00:00:01.000Z", "event_msg", { type: "user_message", message: "\0".repeat(150 * 1024) }),
    line("2026-01-01T00:00:02.000Z", "response_item", { type: "function_call_output", output: "x".repeat(9 * 1024 * 1024) }),
  ].join(""));

  let request: { path: string; threadId: string; limit: number; cursor?: string } = { path, threadId, limit: 20 };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = await readCodexRolloutHistory(request);
    const remote = await readRemote(request);
    assert.deepEqual(remote, local);
    assert.ok(Buffer.byteLength(JSON.stringify(remote), "utf8") < 768 * 1024);
    if (local.messages.length > 0 || !local.nextCursor) break;
    request = { path, threadId, limit: 20, cursor: local.nextCursor };
  }
});

test("remote Codex history matches the known active-turn window", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-codex-history-active-parity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const threadId = "thread-active-parity";
  const path = join(root, `rollout-now-${threadId}.jsonl`);
  await writeFile(path, [
    line("2026-01-01T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: "active-turn" }),
    line("2026-01-01T00:00:01.000Z", "response_item", { type: "function_call_output", output: "x".repeat(5 * 1024 * 1024) }),
    line("2026-01-01T00:00:02.000Z", "response_item", {
      type: "message", role: "assistant", id: "latest", phase: "commentary",
      content: [{ type: "output_text", text: "still working" }],
    }),
  ].join(""));
  const request = { path, threadId, limit: 20, activeTurnId: "active-turn" };

  const local = await readCodexRolloutHistory(request);
  assert.deepEqual(await readRemote(request), local);
  assert.deepEqual(local.messages.map((message) => message.body), ["still working"]);
  assert.deepEqual(local.openTurnIds, ["active-turn"]);
});

test("remote Codex history preserves completed status while draining a long turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-codex-history-long-turn-parity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const threadId = "thread-long-turn-parity";
  const path = join(root, `rollout-now-${threadId}.jsonl`);
  await writeFile(path, [
    line("2026-01-01T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: "turn" }),
    ...Array.from({ length: 4 }, (_, index) => line(`2026-01-01T00:00:0${index + 1}.000Z`, "response_item", {
      type: "message", role: "assistant", id: `a${index}`, content: [{ type: "output_text", text: `m${index}` }],
    })),
    line("2026-01-01T00:00:05.000Z", "event_msg", { type: "task_complete", turn_id: "turn" }),
  ].join(""));

  const first = await readCodexRolloutHistory({ path, threadId, limit: 2 });
  assert.deepEqual(await readRemote({ path, threadId, limit: 2 }), first);
  assert.ok(first.nextCursor);
  const request = { path, threadId, limit: 2, cursor: first.nextCursor };
  const second = await readCodexRolloutHistory(request);
  assert.deepEqual(await readRemote(request), second);
  assert.deepEqual(second.messages.map((message) => message.terminalStatus), ["completed", "completed"]);
});

test("remote Codex history matches resolved-turn continuation pages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-codex-history-resolved-parity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const threadId = "thread-resolved-parity";
  const path = join(root, `rollout-now-${threadId}.jsonl`);
  await writeFile(path, [
    line("2026-01-01T00:00:00.000Z", "event_msg", { type: "task_started", turn_id: "turn" }),
    ...Array.from({ length: 3 }, (_, index) => line(`2026-01-01T00:00:0${index + 1}.000Z`, "response_item", {
      type: "message", role: "assistant", id: `a${index}`, content: [{ type: "output_text", text: "\0".repeat(150 * 1024) }],
    })),
    line("2026-01-01T00:00:04.000Z", "event_msg", { type: "task_complete", turn_id: "turn" }),
  ].join(""));

  let request: { path: string; threadId: string; limit: number; cursor?: string } = { path, threadId, limit: 20 };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = await readCodexRolloutHistory(request);
    assert.deepEqual(await readRemote(request), local);
    if (!local.nextCursor) break;
    request = { path, threadId, limit: 20, cursor: local.nextCursor };
  }
});
