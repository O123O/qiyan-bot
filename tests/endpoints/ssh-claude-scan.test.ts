import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { encodeRemoteArgument, parseRemoteHelperResponse } from "../../src/endpoints/ssh-runtime.ts";
import { runBoundedProcess } from "../../src/endpoints/ssh-process.ts";
import { encodeClaudeClientMarker, scanLocalClaudeTranscript } from "../../src/sessions/claude-transcript.ts";
import type { RolloutCursor } from "../../src/sessions/rollout-ownership.ts";

// The remote helper's `claude-rollout-scan` op MUST produce byte-identical
// RolloutScanResult to the local `scanLocalClaudeTranscript` — otherwise ownership
// diverges local-vs-remote. This runs the SHIPPED helper (same bytes pinned by the
// digest test) directly over local fixtures and asserts deepEqual against the scanner.
const helperPath = new URL("../../assets/remote/qiyan-ssh-helper.mjs", import.meta.url);
const fixture = (name: string) => fileURLToPath(new URL(`../sessions/fixtures/claude/${name}.jsonl`, import.meta.url));

interface Req { path: string; threadId: string; cursor?: RolloutCursor }

async function remoteScan(req: Req, opts: { allowMissing?: boolean; collectFromStart?: boolean } = {}): Promise<unknown> {
  const payload = {
    requests: [req],
    ...(opts.allowMissing ? { allowMissing: true } : {}),
    ...(opts.collectFromStart ? { collectFromStart: true } : {}),
  };
  const result = await runBoundedProcess(process.execPath, [helperPath.pathname, "claude-rollout-scan", encodeRemoteArgument(JSON.stringify(payload))], {
    timeoutMs: 10_000,
    maxOutputBytes: 1024 * 1024,
  });
  return (parseRemoteHelperResponse(result.stdout, "claude-rollout-scan") as { results: unknown[] }).results[0];
}

// collectFromStart is only accepted alongside allowMissing (mirrors the Codex op); the
// wrapping is transparent for an existing file.
async function assertParity(req: Req, mode: "meta" | "collect" | "cursor"): Promise<void> {
  if (mode === "collect") {
    assert.deepEqual(await remoteScan(req, { allowMissing: true, collectFromStart: true }), await scanLocalClaudeTranscript({ ...req, collectFromStart: true }));
  } else {
    assert.deepEqual(await remoteScan(req), await scanLocalClaudeTranscript(req));
  }
}

for (const name of ["basic-qa", "tool-use", "subagent", "interrupted"]) {
  test(`claude-rollout-scan matches the local scanner over the ${name} fixture`, async () => {
    await assertParity({ path: fixture(name), threadId: name }, "collect");
  });
}

test("claude-rollout-scan matches over an owned marker + external turn (no bodies leak)", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-claude-scan-"));
  const path = join(root, "sess-mix.jsonl");
  const secret = "PRIVATE BODY MUST NOT LEAK";
  await writeFile(path,
    `${JSON.stringify({ type: "user", promptSource: "sdk", promptId: "p1", message: { role: "user", content: `${secret} ${encodeClaudeClientMarker("ctx:1")}` } })}\n`
    + `${JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } })}\n`
    + `${JSON.stringify({ type: "user", promptSource: "user", promptId: "p2", message: { role: "user", content: "human typed this" } })}\n`
    + `${JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] } })}\n`);
  await assertParity({ path, threadId: "sess-mix" }, "collect");
  assert.equal(JSON.stringify(await remoteScan({ path, threadId: "sess-mix" }, { allowMissing: true, collectFromStart: true })).includes(secret), false);
});

test("claude-rollout-scan matches over a max_tokens-terminated turn then an open turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-claude-scan-"));
  const path = join(root, "sess-open.jsonl");
  await writeFile(path,
    `${JSON.stringify({ type: "user", promptSource: "sdk", promptId: "p1", message: { role: "user", content: `a ${encodeClaudeClientMarker("ctx:1")}` } })}\n`
    + `${JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "max_tokens", content: [{ type: "text", text: "trunc" }] } })}\n`
    + `${JSON.stringify({ type: "user", promptSource: "sdk", promptId: "p2", message: { role: "user", content: `b ${encodeClaudeClientMarker("ctx:2")}` } })}\n`);
  const local = await scanLocalClaudeTranscript({ path, threadId: "sess-open", collectFromStart: true });
  // sanity: turn 1 closed (max_tokens), turn 2 open
  assert.equal(local.starts.length, 2);
  assert.ok(local.openTurn);
  await assertParity({ path, threadId: "sess-open" }, "collect");
});

test("claude-rollout-scan matches metadata-only and incremental-cursor scans", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-claude-scan-"));
  const path = join(root, "sess-inc.jsonl");
  await writeFile(path,
    `${JSON.stringify({ type: "user", promptSource: "sdk", promptId: "p1", message: { role: "user", content: `first ${encodeClaudeClientMarker("ctx:1")}` } })}\n`
    + `${JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } })}\n`);
  // metadata-only (no cursor, no collectFromStart)
  await assertParity({ path, threadId: "sess-inc" }, "meta");
  const baseline = await scanLocalClaudeTranscript({ path, threadId: "sess-inc" });
  await appendFile(path, `${JSON.stringify({ type: "user", promptSource: "sdk", promptId: "p2", message: { role: "user", content: `second ${encodeClaudeClientMarker("ctx:2")}` } })}\n`
    + `${JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } })}\n`);
  await assertParity({ path, threadId: "sess-inc", cursor: baseline.cursor }, "cursor");
});

test("claude-rollout-scan matches over a malformed-line uncertainty boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-claude-scan-"));
  const path = join(root, "sess-mal.jsonl");
  await writeFile(path,
    `${JSON.stringify({ type: "user", promptSource: "sdk", promptId: "p1", message: { role: "user", content: `done ${encodeClaudeClientMarker("ctx:1")}` } })}\n`
    + `${JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } })}\n`);
  await appendFile(path, Buffer.from([0x7b, 0x7b, 0x0a])); // "{{\n" — invalid JSON
  const local = await scanLocalClaudeTranscript({ path, threadId: "sess-mal", collectFromStart: true });
  assert.equal(local.malformed, true); // sanity: the malformed boundary is exercised
  await assertParity({ path, threadId: "sess-mal" }, "collect");
});

test("claude-rollout-scan reports missing for an absent transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-claude-scan-"));
  const result = await remoteScan({ path: join(root, "sess-gone.jsonl"), threadId: "sess-gone" }, { allowMissing: true, collectFromStart: true });
  assert.deepEqual(result, { missing: true });
});
