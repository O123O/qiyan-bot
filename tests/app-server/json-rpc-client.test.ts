import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { JsonRpcClient } from "../../src/app-server/json-rpc-client.ts";

function harness() {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const client = new JsonRpcClient(fromServer, toServer, { requestTimeoutMs: 1_000 });
  const written: unknown[] = [];
  toServer.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) if (line) written.push(JSON.parse(line));
  });
  return { client, fromServer, written };
}

test("matches out-of-order responses to requests", async () => {
  const { client, fromServer, written } = harness();
  const one = client.request("one", { value: 1 });
  const two = client.request("two", { value: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  const [first, second] = written as Array<{ id: number }>;
  fromServer.write(`${JSON.stringify({ id: second?.id, result: "two" })}\n`);
  fromServer.write(`${JSON.stringify({ id: first?.id, result: "one" })}\n`);
  assert.equal(await one, "one");
  assert.equal(await two, "two");
});

test("dispatches notifications and server requests", async () => {
  const { client, fromServer, written } = harness();
  const notifications: string[] = [];
  client.onNotification((method) => notifications.push(method));
  client.onServerRequest(async (request) => ({ decision: request.method.includes("Approval") ? "decline" : "cancel" }));
  fromServer.write(`${JSON.stringify({ method: "turn/completed", params: {} })}\n`);
  fromServer.write(`${JSON.stringify({ id: 9, method: "item/commandExecution/requestApproval", params: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notifications, ["turn/completed"]);
  assert.deepEqual(written.at(-1), { id: 9, result: { decision: "decline" } });
});

test("rejects all pending requests when the stream closes", async () => {
  const { client, fromServer } = harness();
  const pending = client.request("one", {});
  fromServer.destroy(new Error("closed"));
  await assert.rejects(pending, /closed/);
});
