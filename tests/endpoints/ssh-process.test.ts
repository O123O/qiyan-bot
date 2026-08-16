import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { chargeDiagnosticBytes, openReadyProcessStream, runBoundedProcess } from "../../src/endpoints/ssh-process.ts";

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

// The helper's own failure line IS carried back, while everything else the child prints is
// not. Reporting nothing at all made every remote failure the same opaque `exit 1`: a runtime
// refusing to start behind a stale process group and one whose state directory sat on a stalled
// filesystem read identically, and neither reason ever left the remote host.
test("carries the remote helper's own failure line but no other child output", async () => {
  const secret = "REMOTE_CREDENTIAL_OUTPUT";
  const script = `process.stderr.write(${JSON.stringify(`${secret}\nqiyan remote helper failed: existing runtime is unhealthy\n`)}); process.exit(1)`;
  await assert.rejects(
    runBoundedProcess(process.execPath, ["-e", script], { timeoutMs: 1_000, maxOutputBytes: 1024 }),
    (error: unknown) => error instanceof AppError
      && error.message.includes("existing runtime is unhealthy")
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

test("a readiness chunk may contain post-marker output beyond the preamble limit", async () => {
  const program = [
    `process.stdout.write(Buffer.concat([Buffer.from(${JSON.stringify(readyMarker.toString())}), Buffer.alloc(2048, 120)]));`,
    "process.stdin.resume();",
  ].join("\n");
  const stream = await openReadyProcessStream(process.execPath, ["-e", program], {
    readyMarker, timeoutMs: 1_000, maxPreludeBytes: 1024,
  });

  const [output] = await once(stream.output, "data");
  assert.equal((output as Buffer).byteLength, 2048);
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


// The window arithmetic is tested directly rather than through pipes: a stalled event loop
// coalesces a child's separate writes into one chunk, so any test that infers windows from write
// timing is a coin flip on a loaded machine. These assert the accounting itself.
test("diagnostic bytes accumulate inside a window and reset once it elapses", () => {
  const B = 1024, W = 1000;
  let state = { windowStart: 0, bytes: 0 };
  // Two sub-budget chunks inside one window do add up, and the second one trips it.
  let charged = chargeDiagnosticBytes(state, 600, 0, W, B);
  assert.equal(charged.exceeded, false);
  charged = chargeDiagnosticBytes(charged.state, 600, 999, W, B);
  assert.equal(charged.exceeded, true, "1200 bytes inside one window exceeds a 1024 budget");

  // The same two chunks either side of the boundary do not: the window resets at exactly W.
  charged = chargeDiagnosticBytes({ windowStart: 0, bytes: 600 }, 600, 1000, W, B);
  assert.equal(charged.exceeded, false, "the window resets at exactly windowMs, not after it");
  assert.deepEqual(charged.state, { windowStart: 1000, bytes: 600 });
});

// The drip that used to kill a healthy endpoint: far past the budget in total, never within one
// window. This is the whole point of the change.
test("a slow drip never accumulates across windows", () => {
  const B = 1024, W = 1000;
  let state = { windowStart: 0, bytes: 0 };
  let total = 0;
  for (let i = 0; i < 100; i += 1) {
    const charged = chargeDiagnosticBytes(state, 400, i * W, W, B);
    assert.equal(charged.exceeded, false, `drip chunk ${i} must not trip the budget`);
    state = charged.state;
    total += 400;
  }
  assert.ok(total > B * 30, "the drip really did exceed the old lifetime budget many times over");
});

test("a burst inside one window is still cut off", () => {
  const charged = chargeDiagnosticBytes({ windowStart: 0, bytes: 0 }, 2048, 0, 60_000, 1024);
  assert.equal(charged.exceeded, true);
});

// Idle time earns no credit: a stream silent for hours gets one fresh budget at the burst, not
// one per elapsed window.
test("a long silence grants exactly one fresh window, not accrued credit", () => {
  const charged = chargeDiagnosticBytes({ windowStart: 0, bytes: 900 }, 1025, 3_600_000, 1000, 1024);
  assert.equal(charged.exceeded, true, "the fresh window is one budget, not many");
  assert.deepEqual(charged.state.windowStart, 3_600_000);
});

// Wall clocks step backwards under NTP. Treating that as "no time has passed" would freeze the
// window and silently reinstate the lifetime budget for the length of the step.
test("a backwards clock starts a fresh window instead of freezing one", () => {
  const charged = chargeDiagnosticBytes({ windowStart: 5_000, bytes: 1000 }, 100, 4_000, 1000, 1024);
  assert.equal(charged.exceeded, false, "a backwards step must not keep charging the old window");
  assert.deepEqual(charged.state, { windowStart: 4_000, bytes: 100 });
});

test("a non-positive diagnostic window is refused rather than degrading to per-chunk", async () => {
  await assert.rejects(openReadyProcessStream(process.execPath, ["-e", ""], {
    readyMarker, timeoutMs: 1_000, maxPreludeBytes: 1024, diagnosticWindowMs: 0,
  }), /invalid diagnostic window/u);
});

// Kept as an end-to-end regression guard: a genuine runaway still terminates the live stream.
test("a ready process stream terminates on a runaway burst", async () => {
  const program = [
    `process.stdout.write(${JSON.stringify(readyMarker.toString())});`,
    "setTimeout(() => process.stderr.write('x'.repeat(4096)), 10);",
    "setInterval(() => {}, 10000);",
  ].join("\n");
  const stream = await openReadyProcessStream(process.execPath, ["-e", program], {
    readyMarker, timeoutMs: 1_000, maxPreludeBytes: 1024, diagnosticWindowMs: 60_000,
  });
  const closed = new Promise<Error | undefined>((resolve) => stream.onClose(resolve));

  assert.match(String(await closed), /diagnostic output limit/u);
  await stream.close();
});
