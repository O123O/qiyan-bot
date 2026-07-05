import assert from "node:assert/strict";
import test from "node:test";
import { RpcClient, type RpcWire } from "../../src/app-server/rpc-client.ts";

class MemoryWire implements RpcWire {
  sent: string[] = [];
  private messages = new Set<(message: string) => void>();
  private closes = new Set<(error?: Error) => void>();
  send(message: string): void { this.sent.push(message); }
  close(): void { this.emitClose(); }
  onMessage(listener: (message: string) => void): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
  onClose(listener: (error?: Error) => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }
  receive(message: unknown): void { for (const listener of this.messages) listener(JSON.stringify(message)); }
  receiveRaw(message: string): void { for (const listener of this.messages) listener(message); }
  emitClose(error?: Error): void { for (const listener of this.closes) listener(error); }
}

test("generic RPC client matches responses and dispatches server messages", async () => {
  const wire = new MemoryWire();
  const client = new RpcClient(wire, { requestTimeoutMs: 1_000 });
  const notifications: string[] = [];
  client.onNotification((method) => notifications.push(method));
  client.onServerRequest(async ({ method }) => ({ accepted: method === "approve" }));
  const pending = client.request("thread/read", { threadId: "t" });
  const request = JSON.parse(wire.sent[0]!) as { id: number };
  wire.receive({ method: "turn/completed", params: {} });
  wire.receive({ id: 7, method: "approve", params: {} });
  wire.receive({ id: request.id, result: { thread: { id: "t" } } });
  assert.deepEqual(await pending, { thread: { id: "t" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notifications, ["turn/completed"]);
  assert.deepEqual(JSON.parse(wire.sent.at(-1)!), { id: 7, result: { accepted: true } });
});

test("generic RPC client rejects aborts, timeouts, and wire closure", async () => {
  const wire = new MemoryWire();
  const client = new RpcClient(wire, { requestTimeoutMs: 5 });
  const controller = new AbortController();
  const aborted = client.request("abort", {}, controller.signal);
  controller.abort(new Error("stop"));
  await assert.rejects(aborted, /stop/u);
  await assert.rejects(client.request("timeout", {}), /timed out/u);
  const closed = client.request("close", {});
  wire.emitClose(new Error("wire lost"));
  await assert.rejects(closed, /wire lost/u);
});

test("ignores valid JSON with invalid RPC shapes", () => {
  const wire = new MemoryWire();
  new RpcClient(wire, { requestTimeoutMs: 100 });
  for (const value of ["null", "[]", "1", "true", JSON.stringify({ id: {} }), JSON.stringify({ method: 1 })]) {
    assert.doesNotThrow(() => wire.receiveRaw(value));
  }
});

test("closing during an asynchronous server request never writes or rejects unhandled", async () => {
  const wire = new MemoryWire();
  const client = new RpcClient(wire, { requestTimeoutMs: 100 });
  let resolve!: (value: unknown) => void;
  client.onServerRequest(() => new Promise((done) => { resolve = done; }));
  wire.receive({ id: 7, method: "approve", params: {} });
  await new Promise((done) => setImmediate(done));
  client.close();
  resolve({ accepted: true });
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(wire.sent, []);
});
