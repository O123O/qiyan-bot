import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { openReadyProcessStream, runBoundedProcess } from "../../src/endpoints/ssh-process.ts";

const readyMarker = Buffer.from("qiyan-app-server-proxy-v1-ready\n");

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
    "process.send('ready');",
    "setTimeout(() => process.stdout.write('late'), 3200);",
  ].join("\n");
  const parent = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], { stdio: ['ignore', 1, 2, 'ipc'] });`,
    "child.once('message', () => process.exit(0));",
  ].join("\n");

  await assert.rejects(
    runBoundedProcess(process.execPath, ["-e", parent], { timeoutMs: 1_000, maxOutputBytes: 64 }),
    /timed out/u,
  );
  for (let attempt = 0; attempt < 80; attempt += 1) {
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

test("reports a nonzero process exit structurally without returning diagnostic output", async () => {
  const secret = "REMOTE_CREDENTIAL_OUTPUT";
  await assert.rejects(
    runBoundedProcess(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(secret)}); process.exit(23)`], {
      timeoutMs: 1_000, maxOutputBytes: 1024,
    }),
    (error: unknown) => error instanceof AppError
      && error.code === "ENDPOINT_UNAVAILABLE"
      && error.details?.exitCode === 23
      && !error.message.includes(secret),
  );
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

test("a ready process stream consumes bounded preamble and exposes only post-marker bytes", async () => {
  const program = [
    "process.stdout.write('remote shell banner\\n');",
    `process.stdout.write(${JSON.stringify(readyMarker.subarray(0, 11).toString())});`,
    `setTimeout(() => process.stdout.write(${JSON.stringify(readyMarker.subarray(11).toString())}), 10);`,
    "process.stdin.on('data', (chunk) => process.stdout.write(chunk));",
  ].join("\n");
  const stream = await openReadyProcessStream(process.execPath, ["-e", program], {
    readyMarker, timeoutMs: 1_000, maxPreludeBytes: 1024,
  });
  const received = once(stream.output, "data");

  stream.input.write("websocket bytes");

  assert.equal(String((await received)[0]), "websocket bytes");
  await stream.close();
});

test("a ready process stream backpressures and resumes its producer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-ssh-backpressure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const completed = join(root, "producer-completed");
  const program = [
    "const fs = require('node:fs');",
    `process.stdout.write(${JSON.stringify(readyMarker.toString())});`,
    `process.stdout.write(Buffer.alloc(16 * 1024 * 1024), () => fs.writeFileSync(${JSON.stringify(completed)}, 'yes'));`,
    "process.stdin.resume();",
  ].join("\n");
  const stream = await openReadyProcessStream(process.execPath, ["-e", program], {
    readyMarker, timeoutMs: 1_000, maxPreludeBytes: 1024,
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(readFile(completed), /ENOENT/u);

  stream.output.resume();
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { assert.equal(await readFile(completed, "utf8"), "yes"); break; }
    catch {
      if (attempt === 79) assert.fail("the producer did not resume after output drained");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  await stream.close();
});

test("a ready process stream ignores final stdout during intentional shutdown", async () => {
  const program = [
    "process.on('SIGTERM', () => process.stdout.write('late', () => process.exit(0)));",
    `process.stdout.write(${JSON.stringify(readyMarker.toString())});`,
    "setInterval(() => {}, 10000);",
  ].join("\n");
  const stream = await openReadyProcessStream(process.execPath, ["-e", program], {
    readyMarker, timeoutMs: 1_000, maxPreludeBytes: 1024,
  });

  await stream.close();
});

test("a ready process stream fails generically before its marker and cleans up", async () => {
  const secret = "REMOTE_CREDENTIAL_OUTPUT";
  const program = `process.stderr.write(${JSON.stringify(secret)}); process.stdout.write('banner'); process.exit(23)`;

  await assert.rejects(
    openReadyProcessStream(process.execPath, ["-e", program], {
      readyMarker, timeoutMs: 1_000, maxPreludeBytes: 1024,
    }),
    (error: unknown) => error instanceof AppError
      && /stream failed before readiness/u.test(error.message)
      && error.details?.exitCode === 23
      && !error.message.includes(secret),
  );
});

test("a ready process stream rejects unbounded output before its marker", async () => {
  await assert.rejects(
    openReadyProcessStream(process.execPath, ["-e", "process.stdout.write('x'.repeat(2048)); setTimeout(() => {}, 10000)"], {
      readyMarker, timeoutMs: 1_000, maxPreludeBytes: 1024,
    }),
    /readiness output limit/u,
  );
});

test("a ready process stream terminates after bounded diagnostic output is exceeded", async () => {
  const program = [
    `process.stdout.write(${JSON.stringify(readyMarker.toString())});`,
    "setTimeout(() => process.stderr.write('x'.repeat(2048)), 10);",
    "setInterval(() => {}, 10000);",
  ].join("\n");
  const stream = await openReadyProcessStream(process.execPath, ["-e", program], {
    readyMarker, timeoutMs: 1_000, maxPreludeBytes: 1024,
  });
  const closed = new Promise<Error | undefined>((resolve) => stream.onClose(resolve));

  assert.match(String(await closed), /diagnostic output limit/u);
  await stream.close();
});
