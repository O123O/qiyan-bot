import assert from "node:assert/strict";
import test from "node:test";
import { nodeCommandRunner, nodeStreamingChildFactory } from "../../scripts/ssh-worker.ts";

test("short command runner rejects a deadline even when SIGTERM produces a clean exit", async () => {
  await assert.rejects(
    nodeCommandRunner(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 10000)",
    ], { timeoutMs: 100 }),
    /timed out/u,
  );
});

test("streaming child turns a closed remote stdin into a rejected write instead of an unhandled EPIPE", async (t) => {
  const child = nodeStreamingChildFactory(process.execPath, [
    "-e",
    "require('node:fs').closeSync(0); process.stdout.write('ready\\n'); setTimeout(() => {}, 10000)",
  ]);
  t.after(async () => {
    child.kill("SIGKILL");
    await child.close;
  });
  await child.started;
  const iterator = child.stdout[Symbol.asyncIterator]();
  const ready = await iterator.next();
  assert.equal(Buffer.from(ready.value ?? []).toString("utf8"), "ready\n");

  await assert.rejects(child.writeStdin("x".repeat(1024 * 1024)), /EPIPE|closed|write/iu);
  await assert.rejects(child.writeStdin("again"), /EPIPE|closed|write/iu);
});
