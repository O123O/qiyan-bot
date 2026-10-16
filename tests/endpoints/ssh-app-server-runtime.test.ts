import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { RpcWire } from "../../src/app-server/rpc-client.ts";
import { SshAppServerRuntime } from "../../src/endpoints/ssh-app-server-runtime.ts";
import type { ReadyProcessStream } from "../../src/endpoints/ssh-process.ts";
import type { SshRuntimeController } from "../../src/endpoints/ssh-runtime.ts";
import { taggedLossReason } from "../../src/endpoints/types.ts";
import type { EndpointLossKind, RuntimeIdentity } from "../../src/endpoints/types.ts";

const identity: RuntimeIdentity = { kind: "ssh", token: "a".repeat(32), pid: 10, linuxStartTime: "20", processGroupId: 10 };
const replacement: RuntimeIdentity = { kind: "ssh", token: "b".repeat(32), pid: 11, linuxStartTime: "21", processGroupId: 11 };

class FakeWire implements RpcWire {
  private readonly messages = new Set<(message: string) => void>();
  private readonly closes = new Set<(error?: Error) => void>();
  closed = false;
  closeError: Error | undefined;
  send(): void {}
  close(): void {
    if (!this.closed) { this.closed = true; for (const listener of this.closes) listener(); }
    if (this.closeError) throw this.closeError;
  }
  fail(error = new Error("wire lost")): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closes) listener(error);
  }
  onMessage(listener: (message: string) => void): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
  onClose(listener: (error?: Error) => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }
}

class FakeProcessStream implements ReadyProcessStream {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  private readonly closes = new Set<(error?: Error) => void>();
  closeCalls = 0;
  closeFailures = 0;
  closeGate?: Promise<void>;
  onClose(listener: (error?: Error) => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }
  fail(error = new Error("proxy lost")): void { for (const listener of this.closes) listener(error); }
  async close(): Promise<void> {
    this.closeCalls += 1;
    await this.closeGate;
    if (this.closeFailures-- > 0) throw new Error("proxy cleanup failed");
    this.input.destroy();
    this.output.destroy();
  }
}

class FakeRemoteRuntime implements SshRuntimeController {
  current: RuntimeIdentity | undefined = identity;
  classification: EndpointLossKind = "connection-lost";
  starts = 0;
  streamOpens = 0;
  transportCloses = 0;
  streamFailure?: Error;
  readonly stops: RuntimeIdentity[] = [];
  readonly streams: FakeProcessStream[] = [];
  nextStream?: FakeProcessStream;
  async ensureStarted(): Promise<RuntimeIdentity> { this.starts += 1; return identity; }
  async openAppServerStream(expected: RuntimeIdentity): Promise<ReadyProcessStream> {
    assert.deepEqual(expected, identity);
    this.streamOpens += 1;
    if (this.streamFailure) throw this.streamFailure;
    const stream = this.nextStream ?? new FakeProcessStream();
    delete this.nextStream;
    this.streams.push(stream);
    return stream;
  }
  async runtimeIdentity(): Promise<RuntimeIdentity | undefined> { return this.current; }
  async classifyLoss(): Promise<EndpointLossKind> { return this.classification; }
  async closeTransport(): Promise<void> { this.transportCloses += 1; }
  async stop(expected: RuntimeIdentity) { this.stops.push(expected); return { destroyedIdentity: expected }; }
}

function fixture(remote = new FakeRemoteRuntime(), options: {
  connectWire?: (stream: ReadyProcessStream) => Promise<RpcWire>;
} = {}) {
  const wires: FakeWire[] = [];
  const runtime = new SshAppServerRuntime({
    runtime: remote,
    connectWire: options.connectWire ?? (async () => { const wire = new FakeWire(); wires.push(wire); return wire; }),
  });
  return { runtime, remote, wires };
}

test("opening starts one user-owned proxy and closing leaves the detached runtime alive", async () => {
  const value = fixture();

  const connection = await value.runtime.open();

  assert.equal(value.remote.starts, 1);
  assert.equal(value.remote.streamOpens, 1);
  await connection.close();
  assert.equal(value.remote.streams[0]!.closeCalls, 1);
  assert.deepEqual(value.remote.stops, []);
});

test("proxy startup failure does not open a wire or stop the detached runtime", async () => {
  const remote = new FakeRemoteRuntime();
  remote.streamFailure = new Error("proxy readiness failed");
  let wireOpened = false;
  const value = fixture(remote, { connectWire: async () => { wireOpened = true; return new FakeWire(); } });

  await assert.rejects(value.runtime.open(), /proxy readiness failed/u);

  assert.equal(wireOpened, false);
  assert.deepEqual(remote.stops, []);
});

test("wire connection failure closes the proxy without stopping the runtime", async () => {
  const value = fixture(new FakeRemoteRuntime(), {
    connectWire: async () => { throw new Error("wire connect failed"); },
  });

  await assert.rejects(value.runtime.open(), /wire connect failed/u);

  assert.equal(value.remote.streams[0]!.closeCalls, 1);
  assert.deepEqual(value.remote.stops, []);
});

test("overlapping opens reserve one proxy before the first await completes", async () => {
  let release!: (wire: RpcWire) => void;
  let beginConnect!: () => void;
  const connecting = new Promise<void>((resolve) => { beginConnect = resolve; });
  const connected = new Promise<RpcWire>((resolve) => { release = resolve; });
  const value = fixture(new FakeRemoteRuntime(), { connectWire: () => { beginConnect(); return connected; } });
  const first = value.runtime.open();

  await assert.rejects(value.runtime.open(), /already open/iu);
  await connecting;
  assert.equal(value.remote.streamOpens, 1);
  release(new FakeWire());
  await (await first).close();
});

test("the proxy confirms the exact detached runtime identity", async () => {
  const value = fixture();
  const connection = await value.runtime.open();

  assert.deepEqual(await connection.confirmInitialized({}), { runtime: identity });
  assert.deepEqual(await value.runtime.runtimeIdentity(), identity);

  await connection.close();
});

test("the connection refuses a changed detached runtime identity", async () => {
  const value = fixture();
  const connection = await value.runtime.open();
  value.remote.current = replacement;

  await assert.rejects(connection.confirmInitialized({}), /identity changed/u);
  await connection.close();
});

test("App Server wire closure remains the connection-loss signal", async () => {
  const value = fixture();
  const connection = await value.runtime.open();
  await connection.confirmInitialized({});
  const losses: string[] = [];
  connection.onClose(() => losses.push("closed"));

  value.wires[0]!.fail();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(losses, ["closed"]);
  assert.equal(await value.runtime.classifyLoss(), "connection-lost");
  await connection.close();
});

test("a wire that closes with no error of its own reports a closed transport, not an unknown one", async () => {
  // This is the common remote death: the app-server is killed, the SSH child exits 0, and the
  // wire closes carrying nothing. The connection has to synthesize an error, and for months that
  // synthetic error was untyped -- so the endpoint logged `transport_error` and a dead worker was
  // indistinguishable from a transport fault nobody had classified.
  const value = fixture();
  const connection = await value.runtime.open();
  await connection.confirmInitialized({});
  const losses: Array<Error | undefined> = [];
  connection.onClose((error) => losses.push(error));

  value.wires[0]!.close();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(losses.length, 1);
  assert.ok(losses[0]);
  assert.equal(taggedLossReason(losses[0]), "transport_closed");
  await connection.close();
});

test("the SSH stream's own failure survives the wire's errorless close", async () => {
  // `ws` never re-emits a socket error: it detaches its listener, installs a NOOP and destroys
  // the socket, so the wire reports a bare close and the exit status is gone. Everything the
  // endpoint can say about WHY a remote worker went away lives on the stream, not the wire.
  const value = fixture();
  const connection = await value.runtime.open();
  await connection.confirmInitialized({});
  const losses: Array<Error | undefined> = [];
  connection.onClose((error) => losses.push(error));

  value.remote.streams[0]!.fail(new Error("SSH process stream failed"));
  value.wires[0]!.close();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(losses.length, 1);
  assert.equal(losses[0]?.message, "SSH process stream failed");
  await connection.close();
});

test("an intentional close is not reported as a stream failure", async () => {
  const value = fixture();
  const connection = await value.runtime.open();
  await connection.confirmInitialized({});
  const losses: Array<Error | undefined> = [];
  connection.onClose((error) => losses.push(error));

  await connection.close();
  value.remote.streams[0]!.fail(new Error("SSH process stream failed"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(losses, []);
});

test("a new generation waits until previous proxy cleanup finishes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const value = fixture();
  const first = await value.runtime.open();
  value.remote.streams[0]!.closeGate = gate;
  const closing = first.close();
  let replacementOpened = false;
  const replacementOpening = value.runtime.open().then((connection) => { replacementOpened = true; return connection; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replacementOpened, false);

  release();
  await closing;
  const second = await replacementOpening;
  assert.equal(value.remote.streamOpens, 2);
  await second.close();
});

test("transport close waits for an in-flight open and closes its master last", async () => {
  let started!: () => void;
  let release!: () => void;
  const openingStarted = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const events: string[] = [];
  class DelayedRemote extends FakeRemoteRuntime {
    override async ensureStarted(): Promise<RuntimeIdentity> { events.push("ensure"); started(); await blocked; return super.ensureStarted(); }
    override async openAppServerStream(expected: RuntimeIdentity): Promise<ReadyProcessStream> { events.push("proxy"); return super.openAppServerStream(expected); }
    override async closeTransport(): Promise<void> { events.push("exit"); await super.closeTransport(); }
  }
  const value = fixture(new DelayedRemote());
  const opening = value.runtime.open();
  await openingStarted;
  let transportClosed = false;
  const closing = value.runtime.closeTransport().then(() => { transportClosed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transportClosed, false);

  release();
  const connection = await opening;
  await closing;

  assert.equal(connection.wire instanceof FakeWire && connection.wire.closed, true);
  assert.deepEqual(events, ["ensure", "proxy", "exit"]);
});

test("explicit runtime shutdown waits for an in-flight open before exact stop", async () => {
  let started!: () => void;
  let release!: () => void;
  const openingStarted = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  class DelayedRemote extends FakeRemoteRuntime {
    override async ensureStarted(): Promise<RuntimeIdentity> { started(); await blocked; return super.ensureStarted(); }
  }
  const value = fixture(new DelayedRemote());
  const opening = value.runtime.open();
  await openingStarted;
  let stopped = false;
  const stopping = value.runtime.shutdownRuntime(identity).then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);

  release();
  const connection = await opening;
  await stopping;

  assert.equal(connection.wire instanceof FakeWire && connection.wire.closed, true);
  assert.deepEqual(value.remote.stops, [identity]);
});

test("proxy cleanup failure cannot skip exact remote shutdown", async () => {
  const remote = new FakeRemoteRuntime();
  const stream = new FakeProcessStream();
  stream.closeFailures = 1;
  remote.nextStream = stream;
  const value = fixture(remote);
  const connection = await value.runtime.open();
  await connection.confirmInitialized({});
  value.wires[0]!.closeError = new Error("wire cleanup failed");

  await assert.rejects(value.runtime.shutdownRuntime(identity), /proxy cleanup failed|wire cleanup failed/u);

  assert.deepEqual(value.remote.stops, [identity]);
  assert.ok(stream.closeCalls >= 2);
});
