import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LocalClaudeHost, type OpenSessionRequest } from "../../src/claude-host/host.ts";
import { ClaudeHostServer, RemoteClaudeHost, unixSocketChannel, type HostChannel } from "../../src/claude-host/transport.ts";
import { decodeFrames, encodeFrame, type HostEvent } from "../../src/claude-host/protocol.ts";
import type { SessionInput, SessionQuery } from "../../src/claude-host/session.ts";

class FakeQuery implements SessionQuery {
  readonly received: SessionInput[] = [];
  private readonly pending: unknown[] = [];
  private readonly waiters: Array<(value: IteratorResult<unknown>) => void> = [];
  private ended = false;

  constructor(input: AsyncIterable<SessionInput>) {
    void (async () => { for await (const message of input) this.received.push(message); })();
  }

  push(message: Record<string, unknown>): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.pending.push(message);
  }

  async interrupt(): Promise<unknown> { return undefined; }
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async applyFlagSettings(): Promise<void> {}
  async stopTask(): Promise<void> {}
  async supportedModels(): Promise<unknown[]> { return [{ value: "opus" }]; }
  async initializationResult(): Promise<unknown> { return {}; }
  close(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async (): Promise<IteratorResult<unknown>> => {
        const ready = this.pending.shift();
        if (ready !== undefined) return { value: ready, done: false };
        if (this.ended) return { value: undefined, done: true };
        return await new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

async function harness(t: { after(fn: () => void | Promise<void>): void }): Promise<{
  client: RemoteClaudeHost;
  queries: Map<string, FakeQuery>;
  socketPath: string;
  server: ClaudeHostServer;
  restart: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-host-sock-"));
  const socketPath = join(dir, "host.sock");
  const queries = new Map<string, FakeQuery>();
  const host = new LocalClaudeHost(async (request) => (input) => {
    const query = new FakeQuery(input);
    queries.set(request.sessionId, query);
    return query;
  });
  const identity = {
    hostBuild: "test", sdkVersion: "0.3.220", claudeVersion: "2.1.220", runtimeGeneration: "gen-1",
  };
  let server = new ClaudeHostServer(host, identity);
  await server.listen(socketPath);
  const client = new RemoteClaudeHost(unixSocketChannel(socketPath));
  t.after(async () => { await client.shutdown(); await server.close(); });
  return {
    client, queries, socketPath, server,
    restart: async () => {
      await server.close();
      server = new ClaudeHostServer(host, identity);
      await server.listen(socketPath);
    },
  };
}

const request = (sessionId: string): OpenSessionRequest =>
  ({ sessionId, mode: "create", cwd: "/tmp/x" });

test("frames survive being split and coalesced across chunks", () => {
  const wire = encodeFrame({ id: 1, result: { a: 1 } }) + encodeFrame({ id: 2, result: { b: 2 } });
  const split = wire.length - 5;
  const first = decodeFrames(wire.slice(0, split));
  assert.equal(first.frames.length, 1, "an incomplete trailing frame is held back");
  const second = decodeFrames(first.rest + wire.slice(split));
  assert.equal(second.frames.length, 1);
  assert.deepEqual(second.frames[0]!.result, { b: 2 });
});

test("a corrupt line is dropped without desynchronising the stream", () => {
  const { frames } = decodeFrames(`{not json\n${encodeFrame({ id: 7, result: "ok" })}`);
  assert.deepEqual(frames.map((frame) => frame.id), [7]);
});

test("the socket is owner-only", async (t) => {
  const { socketPath } = await harness(t);
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
});

test("requests round-trip and reach the real host", async (t) => {
  const { client, queries } = await harness(t);
  const status = await client.open(request("s1"));
  assert.equal(status.sessionId, "s1");
  assert.equal(status.activity, "idle");

  assert.equal(await client.send("s1", "u1", "hello"), true);
  await delay(20);
  assert.equal(queries.get("s1")!.received[0]!.message.content, "hello");
  assert.equal((await client.status("s1")).activity, "working");
  assert.deepEqual(await client.models("s1"), [{ value: "opus" }]);
});

test("a duplicate uuid is reported as already accepted, not queued twice", async (t) => {
  const { client, queries } = await harness(t);
  await client.open(request("s1"));
  assert.equal(await client.send("s1", "u1", "hello"), true);
  assert.equal(await client.send("s1", "u1", "hello"), false);
  await delay(20);
  assert.equal(queries.get("s1")!.received.length, 1);
});

test("a host-side error keeps its code across the wire", async (t) => {
  const { client } = await harness(t);
  await assert.rejects(client.send("missing", "u1", "hi"), (error: any) => {
    assert.equal(error.code, "UNKNOWN_SESSION");
    assert.match(error.message, /not loaded: missing/u);
    return true;
  });
});

test("events stream to the client as they happen", async (t) => {
  const { client, queries } = await harness(t);
  await client.open(request("s1"));
  const events: HostEvent[] = [];
  client.subscribe((event) => events.push(event));

  await client.send("s1", "u1", "hello");
  queries.get("s1")!.push({ type: "assistant", parent_tool_use_id: null, message: { content: [] } });
  await delay(30);
  assert.deepEqual(events.map((event) => event.type), ["turn/accepted", "content/assistant"]);
});

test("host/status reports protocol and build identity", async (t) => {
  const { client } = await harness(t);
  const status = await client.hostStatus();
  assert.equal(status.protocolVersion, 1);
  assert.equal(status.claudeVersion, "2.1.220");
  assert.equal(status.runtimeGeneration, "gen-1");
});

// The whole point of the remote transport: the client going away does not stop the host.
// The work continues and the result lands; the client just has to reload to see it.
test("the host keeps working while the client is disconnected", async (t) => {
  const { client, queries, restart } = await harness(t);
  await client.open(request("s1"));
  await client.send("s1", "u1", "hello");
  await delay(20);
  assert.equal((await client.status("s1")).activity, "working");

  await restart();                                     // the client's connection drops
  queries.get("s1")!.push({ type: "result", subtype: "success", origin: { kind: "human" }, user_message_uuid: "u1" });
  await delay(20);

  // The turn ran to completion on the host with nobody listening.
  assert.equal((await client.status("s1")).activity, "idle");
});

test("in-flight requests fail loudly when the connection drops", async (t) => {
  // A host whose call never returns, so the request is provably still in flight when the
  // connection drops — otherwise the assertion races the response.
  const dir = await mkdtemp(join(tmpdir(), "qiyan-host-hang-"));
  const socketPath = join(dir, "host.sock");
  const stalling = {
    ...new LocalClaudeHost(async () => (input) => new FakeQuery(input)),
    models: () => new Promise<unknown[]>(() => {}),
    subscribe: () => () => {},
  } as unknown as LocalClaudeHost;
  const server = new ClaudeHostServer(stalling, {
    hostBuild: "test", sdkVersion: "0", claudeVersion: "2.1.220", runtimeGeneration: "gen-1",
  });
  await server.listen(socketPath);
  const client = new RemoteClaudeHost(unixSocketChannel(socketPath));
  t.after(async () => { await client.shutdown(); await server.close(); });

  const inflight = client.models("s1");
  await delay(20);
  await server.close();
  await assert.rejects(inflight, (error: any) => {
    // OPERATION_UNCERTAIN, not a hang: the caller retries with the same idempotency uuid,
    // which the host drops as a duplicate.
    assert.equal(error.code, "OPERATION_UNCERTAIN");
    return true;
  });
});

// The failure this project already hit with the remote Codex app-server: the peer is alive
// and the stream is open, but nothing answers. No close/error/end fires, so only a deadline
// can end the request — otherwise the turn behind it hangs for the life of the process and
// even an endpoint restart cannot drain the work lease it holds.
test("a request to an alive but silent host is bounded rather than hung", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qiyan-host-mute-"));
  const socketPath = join(dir, "host.sock");
  const mute = {
    ...new LocalClaudeHost(async () => (input) => new FakeQuery(input)),
    models: () => new Promise<unknown[]>(() => {}),
    subscribe: () => () => {},
  } as unknown as LocalClaudeHost;
  const server = new ClaudeHostServer(mute, {
    hostBuild: "test", sdkVersion: "0", claudeVersion: "2.1.220", runtimeGeneration: "gen-1",
  });
  await server.listen(socketPath);
  const client = new RemoteClaudeHost(unixSocketChannel(socketPath), { requestTimeoutMs: 30 });
  t.after(async () => { await client.shutdown(); await server.close(); });

  await assert.rejects(client.models("s1"), (error: any) => {
    // OPERATION_UNCERTAIN: the host may have applied it, so the caller retries with the same
    // idempotency uuid rather than treating it as proven-not-dispatched.
    assert.equal(error.code, "OPERATION_UNCERTAIN");
    assert.match(error.message, /timed out: models/u);
    return true;
  });
  // The connection itself is unharmed — only the abandoned request went away.
  assert.equal((await client.hostStatus()).protocolVersion, 1);
});

test("a shut-down client refuses further calls instead of reconnecting", async (t) => {
  const { client } = await harness(t);
  await client.open(request("s1"));
  await client.shutdown();
  await assert.rejects(client.status("s1"), /client is closed/u);
});

// The endpoint runtime that owns this client is stopped and started again in place, so
// being shut down must be reversible — otherwise activation fails deterministically
// against a host that is running and healthy.
test("a reopened client dials again instead of staying latched shut", async (t) => {
  const { client } = await harness(t);
  await client.open(request("s1"));
  await client.shutdown();
  await assert.rejects(client.status("s1"), /client is closed/u);

  client.reopen();
  assert.equal((await client.status("s1")).sessionId, "s1", "the surviving session is reachable again");
});

// shutdown() cannot cancel a dial that has not produced a channel yet: the request is in
// neither map. Without a hand-off the caller waits forever and the ssh child the channel
// wraps keeps the process alive.
test("shutting down during a dial fails the caller and closes the channel that arrives", async (t) => {
  const { socketPath } = await harness(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const opened: HostChannel[] = [];
  const open = unixSocketChannel(socketPath);
  const client = new RemoteClaudeHost(async () => {
    await gate;
    const channel = await open();
    opened.push(channel);
    return channel;
  });
  t.after(() => client.shutdown());

  const inflight = client.status("s1");
  await delay(10);
  const stopped = client.shutdown();
  release();

  await assert.rejects(inflight, /client is closed/u);
  await stopped;
  assert.equal(opened.length, 1);
  assert.equal((opened[0]!.input as Socket).destroyed, true, "the late channel is closed, not leaked");
});

test("an unreachable host reports where it failed to connect", async () => {
  const client = new RemoteClaudeHost(unixSocketChannel(join(tmpdir(), "qiyan-nonexistent", "host.sock")));
  await assert.rejects(client.status("s1"), (error: any) => {
    assert.equal(error.code, "ENDPOINT_UNAVAILABLE");
    assert.match(error.message, /cannot reach the claude host/u);
    return true;
  });
});
