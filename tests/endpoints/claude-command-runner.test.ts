import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalClaudeCommandRunner, claudePreviewFromRecords, CLAUDE_PREVIEW_MAX } from "../../src/endpoints/claude-command-runner.ts";

function line(record: unknown): string { return `${JSON.stringify(record)}\n`; }

async function writeTranscript(home: string, dirHash: string, id: string, records: unknown[]): Promise<void> {
  const dir = join(home, ".claude", "projects", dirHash);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.jsonl`), records.map(line).join(""));
}

test("listThreads enumerates all project dirs, derives cwd from records, filters by cwd", async () => {
  const home = await mkdtemp(join(tmpdir(), "claude-home-"));
  // Two projects (different cwds) under differently-named hash dirs — cwd comes from the
  // records, NOT the dir name (the runner never reproduces Claude's cwd-hashing).
  await writeTranscript(home, "hash-A", "sess-a", [
    { type: "user", cwd: "/work/alpha", message: { role: "user", content: "first alpha prompt" } },
  ]);
  await writeTranscript(home, "hash-B", "sess-b", [
    { type: "user", cwd: "/work/beta", message: { role: "user", content: "beta prompt" } },
  ]);
  const runner = new LocalClaudeCommandRunner({ home });

  const all = await runner.listThreads();
  assert.deepEqual(all.map((t) => t.id).sort(), ["sess-a", "sess-b"]);

  const alpha = await runner.listThreads("/work/alpha");
  assert.equal(alpha.length, 1);
  assert.equal(alpha[0]!.id, "sess-a");
  assert.equal(alpha[0]!.cwd, "/work/alpha");
  assert.equal(alpha[0]!.preview, "first alpha prompt");
});

test("preview is the first USER message, marker-stripped and length-capped; never assistant output", () => {
  const long = "x".repeat(500);
  const preview = claudePreviewFromRecords([
    { type: "assistant", message: { content: [{ type: "text", text: "SECRET assistant output" }] } },
    { type: "user", message: { role: "user", content: `hello world <!-- qiyan-cid:ctx:call --> ${long}` } },
  ]);
  assert.ok(!preview.includes("SECRET"), "never leaks assistant/tool output");
  assert.ok(!preview.includes("qiyan-cid"), "marker stripped");
  assert.ok(preview.startsWith("hello world"));
  assert.ok(preview.length <= CLAUDE_PREVIEW_MAX);
});

test("transcript reads are positional, byte-bounded, and snapshot-pinned", async () => {
  const home = await mkdtemp(join(tmpdir(), "claude-home-"));
  await writeTranscript(home, "hash", "large", [
    { type: "user", cwd: "/work", promptSource: "sdk", promptId: "p", message: { content: "x".repeat(100_000) } },
  ]);
  const runner = new LocalClaudeCommandRunner({ home });
  const tail = await runner.readTranscriptChunk("large", "/work", { offset: "tail", length: 128 });
  assert.ok(tail);
  assert.equal(tail.bytes.length, 128);
  assert.equal(tail.offset, tail.snapshot.size - 128);

  await writeTranscript(home, "hash", "large", [
    { type: "user", cwd: "/work", promptSource: "sdk", promptId: "changed", message: { content: "changed" } },
  ]);
  await assert.rejects(
    runner.readTranscriptChunk("large", "/work", { offset: 0, length: 128, expected: tail.snapshot }),
    /changed during bounded history paging/u,
  );
});

test("local turns preserve exact prompt bytes and take their identity from native JSONL", async () => {
  const home = await mkdtemp(join(tmpdir(), "claude-home-"));
  const threadId = "native-local";
  const transcriptDir = join(home, ".claude", "projects", "fixture");
  const transcript = join(transcriptDir, `${threadId}.jsonl`);
  await mkdir(transcriptDir, { recursive: true });
  const command = join(home, "fake-claude.mjs");
  await writeFile(command, [
    "#!/usr/bin/env node",
    'import { appendFile } from "node:fs/promises";',
    "const chunks=[];",
    "for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));",
    'const prompt=Buffer.concat(chunks).toString("utf8");',
    `const path=${JSON.stringify(transcript)};`,
    `await appendFile(path,JSON.stringify({type:"user",cwd:${JSON.stringify(home)},promptSource:"sdk",promptId:"native-prompt",uuid:"native-user",message:{role:"user",content:prompt}})+"\\n");`,
    'await appendFile(path,JSON.stringify({type:"assistant",message:{role:"assistant",stop_reason:"end_turn",content:[{type:"text",text:"done"}]}})+"\\n");',
  ].join("\n"), { mode: 0o700 });
  const runner = new LocalClaudeCommandRunner({ home, command });

  const handle = await runner.startTurn({
    threadId,
    cwd: home,
    message: "exact user prompt",
    resume: true,
    flags: {},
  });

  assert.deepEqual(await handle.materialization, { turnId: "native-prompt", userItemId: "native-user" });
  assert.equal(await handle.done, "completed");
  const user = JSON.parse((await readFile(transcript, "utf8")).split("\n")[0]!) as any;
  assert.equal(user.message.content, "exact user prompt");
  assert.doesNotMatch(user.message.content, /qiyan-cid/u);
});
