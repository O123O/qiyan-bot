import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBoundedProcess } from "../../src/endpoints/ssh-process.ts";

test("runs an argv-only process and bounds captured output", async () => {
  const result = await runBoundedProcess(process.execPath, ["-e", "process.stdout.write('ok')"], { timeoutMs: 1_000, maxOutputBytes: 16 });
  assert.equal(result.stdout.toString(), "ok");
  await assert.rejects(
    runBoundedProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(100))"], { timeoutMs: 1_000, maxOutputBytes: 16 }),
    /output limit/u,
  );
});

test("waits for inherited output pipes to close after the direct child exits", async () => {
  const writer = "setTimeout(() => process.stdout.write('late-json'), 25)";
  const parent = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], { stdio: ['ignore', 1, 2] });`,
    "child.unref();",
  ].join("\n");

  const result = await runBoundedProcess(process.execPath, ["-e", parent], { timeoutMs: 1_000, maxOutputBytes: 64 });
  assert.equal(result.stdout.toString(), "late-json");
});

test("hard timeout closes inherited output pipes after the direct child exits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-ssh-pipe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "pipe-closed");
  const writer = [
    "const fs = require('node:fs');",
    `process.stdout.on('error', () => { fs.writeFileSync(${JSON.stringify(marker)}, 'closed'); process.exit(0); });`,
    "setTimeout(() => process.stdout.write('late'), 2200);",
  ].join("\n");
  const parent = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], { stdio: ['ignore', 1, 2] });`,
    "child.unref();",
  ].join("\n");

  await assert.rejects(
    runBoundedProcess(process.execPath, ["-e", parent], { timeoutMs: 25, maxOutputBytes: 64 }),
    /timed out/u,
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { assert.equal(await readFile(marker, "utf8"), "closed"); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  assert.fail("the inherited output pipe remained open after the hard timeout");
});

test("times out without returning child output in the error", async () => {
  const started = Date.now();
  await assert.rejects(
    runBoundedProcess(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); process.stderr.write('SECRET'); setTimeout(() => {}, 10000)"], { timeoutMs: 100, maxOutputBytes: 1024 }),
    (error: unknown) => error instanceof Error && /timed out/u.test(error.message) && !error.message.includes("SECRET"),
  );
  assert.ok(Date.now() - started >= 200, "the timeout waits for bounded child termination");
});

test("rejects pre-aborted work without spawning and handles an early stdin close", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-ssh-process-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "spawned");
  const controller = new AbortController();
  controller.abort(new Error("cancelled before spawn"));
  await assert.rejects(
    runBoundedProcess(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`], {
      timeoutMs: 1_000, maxOutputBytes: 1_024, signal: controller.signal,
    }),
    /cancelled before spawn/u,
  );
  await assert.rejects(readFile(marker), /ENOENT/u);

  await assert.rejects(
    runBoundedProcess(process.execPath, ["-e", "process.stdin.destroy(); process.exit(0)"], {
      timeoutMs: 1_000, maxOutputBytes: 1_024, input: Buffer.alloc(8 * 1024 * 1024),
    }),
    /input|stdin|closed/u,
  );
});
