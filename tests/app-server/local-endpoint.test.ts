import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { LocalEndpoint } from "../../src/app-server/local-endpoint.ts";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() { this.killed = true; this.emit("exit", 0, null); return true; }
}

test("initializes app-server before becoming ready", async () => {
  const child = new FakeChild();
  const requests: Array<Record<string, unknown>> = [];
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
    requests.push(request);
    if (request.method === "initialize") child.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: "test", platformFamily: "unix", platformOs: "linux" } })}\n`);
  });
  const endpoint = new LocalEndpoint({ codexBinary: "codex", spawn: () => child as never });
  await endpoint.start();
  assert.equal(endpoint.state, "ready");
  assert.equal(requests[0]?.method, "initialize");
  assert.equal(requests[1]?.method, "initialized");
  await endpoint.stop();
  assert.equal(child.killed, true);
});

test("declines approval requests and emits a blocked event", async () => {
  const child = new FakeChild();
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
    if (request.method === "initialize") child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
  });
  const endpoint = new LocalEndpoint({ codexBinary: "codex", spawn: () => child as never });
  const blocked: unknown[] = [];
  endpoint.onPermissionBlocked((event) => blocked.push(event));
  await endpoint.start();
  child.stdout.write(`${JSON.stringify({ id: 17, method: "item/fileChange/requestApproval", params: { threadId: "t1", turnId: "turn1", itemId: "i1", reason: "write" } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(blocked.length, 1);
});
