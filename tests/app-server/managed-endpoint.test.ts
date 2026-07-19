import assert from "node:assert/strict";
import test from "node:test";
import type { RpcWire } from "../../src/app-server/rpc-client.ts";
import {
  EndpointAuthenticationRequiredError,
  ManagedAppServerEndpoint,
  type AppServerConnection,
  type AppServerConnectionIdentity,
  type AppServerInitializeResult,
  type AppServerRuntimeService,
} from "../../src/app-server/managed-endpoint.ts";
import type { EndpointLossKind, EndpointLossReason, RuntimeIdentity } from "../../src/endpoints/types.ts";

const firstIdentity: RuntimeIdentity = { kind: "local", pid: 10, startTime: "20" };
const secondIdentity: RuntimeIdentity = { kind: "local", pid: 11, startTime: "21" };

class FakeWire implements RpcWire {
  private readonly messages = new Set<(message: string) => void>();
  private readonly closes = new Set<(error?: Error) => void>();
  readonly methods: string[] = [];
  readonly responses: Array<Record<string, unknown>> = [];
  account: unknown = { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
  initialize: AppServerInitializeResult = { userAgent: "codex_app_server/0.143.0" };

  send(message: string): void {
    const request = JSON.parse(message) as { id?: number; method?: string };
    if (request.method === undefined) { this.responses.push(request); return; }
    this.methods.push(request.method);
    if (request.id === undefined) return;
    const result = request.method === "initialize" ? this.initialize
      : request.method === "account/read" ? this.account
        : {};
    queueMicrotask(() => this.receive({ id: request.id, result }));
  }
  close(): void { this.emitClose(); }
  emitClose(error?: Error): void { for (const listener of this.closes) listener(error); }
  receive(message: unknown): void { for (const listener of this.messages) listener(JSON.stringify(message)); }
  onMessage(listener: (message: string) => void): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
  onClose(listener: (error?: Error) => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }
}

class FakeConnection implements AppServerConnection {
  private readonly closes = new Set<(error?: Error) => void>();
  closed = false;
  confirms = 0;
  closeError: Error | undefined;
  constructor(readonly wire: FakeWire, private readonly identity: AppServerConnectionIdentity) {}
  onClose(listener: (error?: Error) => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }
  async confirmInitialized(): Promise<AppServerConnectionIdentity> { this.confirms += 1; return this.identity; }
  async close(): Promise<void> { this.closed = true; this.wire.close(); if (this.closeError) throw this.closeError; }
  fail(error = new Error("connection lost")): void { for (const listener of this.closes) listener(error); }
  closeUnexpectedly(): void { for (const listener of this.closes) listener(); }
}

class FakeRuntime implements AppServerRuntimeService {
  readonly shutdowns: RuntimeIdentity[] = [];
  transportCloses = 0;
  opens = 0;
  classify: EndpointLossKind | Error = "connection-lost";
  current: RuntimeIdentity | undefined = firstIdentity;
  constructor(readonly connections: FakeConnection[]) {}
  async open(): Promise<AppServerConnection> { return this.connections[this.opens++]!; }
  async runtimeIdentity(): Promise<RuntimeIdentity | undefined> { return this.current; }
  async classifyLoss(): Promise<EndpointLossKind> {
    if (this.classify instanceof Error) throw this.classify;
    return this.classify;
  }
  async shutdownRuntime(expected: RuntimeIdentity): Promise<void> { this.shutdowns.push(expected); }
  async closeTransport(): Promise<void> { this.transportCloses += 1; }
}

test("one endpoint implementation initializes and authenticates every runtime connection", async () => {
  const wire = new FakeWire();
  const connection = new FakeConnection(wire, { runtime: firstIdentity, allowedClientProcess: { pid: 12, startTime: "22" } });
  const endpoint = new ManagedAppServerEndpoint({ id: "worker", runtime: new FakeRuntime([connection]), minimumVersion: "0.142.5" });

  await endpoint.start();

  assert.equal(endpoint.state, "ready");
  assert.deepEqual(wire.methods.slice(0, 3), ["initialize", "initialized", "account/read"]);
  assert.equal(connection.confirms, 1);
  assert.deepEqual(endpoint.mcpClientIdentity, { pid: 12, startTime: "22" });
});

test("common authentication handling rejects missing or malformed account state", async (t) => {
  await t.test("required", async () => {
    const wire = new FakeWire();
    wire.account = { account: null, requiresOpenaiAuth: true };
    const endpoint = new ManagedAppServerEndpoint({
      id: "worker", runtime: new FakeRuntime([new FakeConnection(wire, { runtime: firstIdentity })]), minimumVersion: "0.142.5",
    });
    await assert.rejects(endpoint.start(), (error: unknown) => error instanceof EndpointAuthenticationRequiredError && error.endpointId === "worker");
    assert.equal(endpoint.state, "unavailable");
  });
  for (const account of [
    {}, { account: null }, { account: null, requiresOpenaiAuth: "yes" },
    { account: undefined, requiresOpenaiAuth: true }, { account: "user", requiresOpenaiAuth: true },
  ]) await t.test("malformed", async () => {
    const wire = new FakeWire();
    wire.account = account;
    const endpoint = new ManagedAppServerEndpoint({
      id: "worker", runtime: new FakeRuntime([new FakeConnection(wire, { runtime: firstIdentity })]), minimumVersion: "0.142.5",
    });
    await assert.rejects(endpoint.start(), /invalid account response/iu);
    assert.equal(endpoint.state, "unavailable");
  });
});

test("approval handling is common to every runtime", async () => {
  const wire = new FakeWire();
  const endpoint = new ManagedAppServerEndpoint({
    id: "worker", runtime: new FakeRuntime([new FakeConnection(wire, { runtime: firstIdentity })]), minimumVersion: "0.142.5",
  });
  const blocked: unknown[] = [];
  endpoint.onPermissionBlocked((event) => blocked.push(event));
  await endpoint.start();

  wire.receive({ id: 91, method: "item/fileChange/requestApproval", params: { threadId: "t", turnId: "turn", itemId: "item" } });
  wire.receive({ id: 92, method: "item/permissions/requestApproval", params: { threadId: "t", turnId: "turn", itemId: "permissions" } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(blocked.length, 2);
  assert.deepEqual(wire.responses.find((response) => response.id === 91), { id: 91, result: { decision: "decline" } });
  assert.deepEqual(wire.responses.find((response) => response.id === 92), {
    id: 92, error: { code: -32000, message: "permission escalation is disabled" },
  });
});

test("unsupported interactive dynamic tools fail closed without leaving the turn waiting", async () => {
  const wire = new FakeWire();
  const endpoint = new ManagedAppServerEndpoint({
    id: "worker", runtime: new FakeRuntime([new FakeConnection(wire, { runtime: firstIdentity })]), minimumVersion: "0.142.5",
  });
  await endpoint.start();

  wire.receive({
    id: 93,
    method: "item/tool/call",
    params: { threadId: "t", turnId: "turn", callId: "call", namespace: null, tool: "request_plugin_install", arguments: { plugin_id: "example" } },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(wire.responses.find((response) => response.id === 93), {
    id: 93,
    result: {
      success: false,
      contentItems: [{ type: "inputText", text: "Interactive client tools are unavailable in this managed session. Continue without this tool." }],
    },
  });
});

test("common minimum-version rejection never exposes the raw user agent", async () => {
  const wire = new FakeWire();
  wire.initialize = { userAgent: "codex_app_server/0.142.4 (DO_NOT_LEAK)" };
  const endpoint = new ManagedAppServerEndpoint({
    id: "worker", runtime: new FakeRuntime([new FakeConnection(wire, { runtime: firstIdentity })]), minimumVersion: "0.142.5",
  });
  let thrown: unknown;
  try { await endpoint.start(); } catch (error) { thrown = error; }
  assert.match(String(thrown), /0\.142\.5 or newer/iu);
  assert.doesNotMatch(String(thrown), /DO_NOT_LEAK/u);
});

test("stop during initialization cannot publish a stale generation", async () => {
  let release!: (connection: AppServerConnection) => void;
  let opening!: () => void;
  const openStarted = new Promise<void>((resolve) => { opening = resolve; });
  const opened = new Promise<AppServerConnection>((resolve) => { release = resolve; });
  const connection = new FakeConnection(new FakeWire(), { runtime: firstIdentity });
  const runtime = new FakeRuntime([]);
  runtime.open = async () => { opening(); return opened; };
  const endpoint = new ManagedAppServerEndpoint({ id: "worker", runtime, minimumVersion: "0.142.5" });

  const starting = endpoint.start();
  await openStarted;
  await endpoint.closeConnection();
  release(connection);
  await assert.rejects(starting, /generation changed/iu);

  assert.equal(endpoint.state, "stopped");
  assert.equal(endpoint.mcpClientIdentity, undefined);
  assert.equal(connection.closed, true);
});

test("explicit connection close also closes runtime-owned transport", async () => {
  const connection = new FakeConnection(new FakeWire(), { runtime: firstIdentity });
  const runtime = new FakeRuntime([connection]);
  const endpoint = new ManagedAppServerEndpoint({ id: "worker", runtime, minimumVersion: "0.142.5" });
  await endpoint.start();

  await endpoint.closeConnection();

  assert.equal(runtime.transportCloses, 1);
});

test("confirmed connection identity is validated before readiness", async (t) => {
  for (const identity of [
    {} as AppServerConnectionIdentity,
    { runtime: undefined } as unknown as AppServerConnectionIdentity,
    { runtime: { kind: "local", pid: 0, startTime: "20" } as RuntimeIdentity },
    { runtime: firstIdentity, allowedClientProcess: { pid: 0, startTime: "x" } },
  ]) await t.test("invalid identity", async () => {
    const endpoint = new ManagedAppServerEndpoint({
      id: "worker", runtime: new FakeRuntime([new FakeConnection(new FakeWire(), identity)]), minimumVersion: "0.142.5",
    });
    await assert.rejects(endpoint.start(), /identity/iu);
    assert.notEqual(endpoint.state, "ready");
  });
});

test("stale connection loss cannot affect a newer ready generation", async () => {
  const first = new FakeConnection(new FakeWire(), { runtime: firstIdentity });
  const second = new FakeConnection(new FakeWire(), { runtime: secondIdentity });
  const runtime = new FakeRuntime([first, second]);
  const endpoint = new ManagedAppServerEndpoint({ id: "worker", runtime, minimumVersion: "0.142.5" });
  const losses: EndpointLossKind[] = [];
  endpoint.onUnavailable((kind) => losses.push(kind));
  await endpoint.start();
  await endpoint.closeConnection();
  runtime.current = secondIdentity;
  await endpoint.start();

  first.fail();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(endpoint.state, "ready");
  assert.deepEqual(losses, []);

  second.fail();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(endpoint.state, "unavailable");
  assert.deepEqual(losses, ["connection-lost"]);
});

test("loss classification failure still emits one conservative reconnect event", async () => {
  const connection = new FakeConnection(new FakeWire(), { runtime: firstIdentity });
  const runtime = new FakeRuntime([connection]);
  runtime.classify = new Error("inspection failed");
  const endpoint = new ManagedAppServerEndpoint({ id: "worker", runtime, minimumVersion: "0.142.5" });
  const losses: EndpointLossKind[] = [];
  endpoint.onUnavailable((kind) => losses.push(kind));
  await endpoint.start();

  connection.fail();
  connection.fail();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(losses, ["connection-lost"]);
});

test("connection loss exposes only a bounded transport reason", async (t) => {
  for (const [error, expected] of [
    [Object.assign(new RangeError("Max payload size exceeded"), { code: "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" }), "frame_too_large"],
    [new Error("SSH process exceeded its diagnostic output limit"), "ssh_diagnostic_limit"],
    [new Error("SSH process input closed"), "ssh_input_closed"],
    [new Error("SSH process stream failed"), "ssh_process_failed"],
    [Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), "transport_reset"],
    [Object.assign(new Error("Invalid WebSocket frame"), { code: "WS_ERR_INVALID_OPCODE" }), "invalid_frame"],
    [new Error("App Server byte stream failed"), "byte_stream_error"],
    [new Error("private transport detail"), "transport_error"],
    [undefined, "transport_closed"],
  ] as const) await t.test(expected, async () => {
    const connection = new FakeConnection(new FakeWire(), { runtime: firstIdentity });
    const endpoint = new ManagedAppServerEndpoint({
      id: "worker", runtime: new FakeRuntime([connection]), minimumVersion: "0.142.5",
    });
    const losses: Array<{ kind: EndpointLossKind; reason: EndpointLossReason }> = [];
    endpoint.onUnavailable((kind, reason) => {
      assert.ok(reason);
      losses.push({ kind, reason });
    });
    await endpoint.start();

    if (error) connection.fail(error);
    else connection.closeUnexpectedly();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(losses, [{ kind: "connection-lost", reason: expected }]);
  });
});

test("cleanup failure cannot suppress loss, replace auth error, or skip shutdown", async (t) => {
  await t.test("loss", async () => {
    const connection = new FakeConnection(new FakeWire(), { runtime: firstIdentity });
    connection.closeError = new Error("close failed");
    const runtime = new FakeRuntime([connection]);
    const endpoint = new ManagedAppServerEndpoint({ id: "worker", runtime, minimumVersion: "0.142.5" });
    const losses: EndpointLossKind[] = [];
    endpoint.onUnavailable((kind) => losses.push(kind));
    await endpoint.start();
    connection.fail();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(losses, ["connection-lost"]);
  });
  await t.test("authentication", async () => {
    const wire = new FakeWire();
    wire.account = { account: null, requiresOpenaiAuth: true };
    const connection = new FakeConnection(wire, { runtime: firstIdentity });
    connection.closeError = new Error("close failed");
    const endpoint = new ManagedAppServerEndpoint({
      id: "worker", runtime: new FakeRuntime([connection]), minimumVersion: "0.142.5",
    });
    await assert.rejects(endpoint.start(), EndpointAuthenticationRequiredError);
  });
  await t.test("shutdown", async () => {
    const connection = new FakeConnection(new FakeWire(), { runtime: firstIdentity });
    connection.closeError = new Error("close failed");
    const runtime = new FakeRuntime([connection]);
    const endpoint = new ManagedAppServerEndpoint({ id: "worker", runtime, minimumVersion: "0.142.5" });
    await endpoint.start();
    await assert.rejects(endpoint.shutdownRuntime(firstIdentity), /close failed/u);
    assert.deepEqual(runtime.shutdowns, [firstIdentity]);
  });
});

test("explicit shutdown delegates one mandatory exact runtime identity", async () => {
  const connection = new FakeConnection(new FakeWire(), { runtime: firstIdentity });
  const runtime = new FakeRuntime([connection]);
  const endpoint = new ManagedAppServerEndpoint({ id: "worker", runtime, minimumVersion: "0.142.5" });
  await endpoint.start();

  await endpoint.shutdownRuntime(firstIdentity);

  assert.deepEqual(runtime.shutdowns, [firstIdentity]);
  assert.equal(runtime.transportCloses, 0, "runtime shutdown owns transport teardown after its remote stop");
  assert.equal(endpoint.state, "stopped");
});
