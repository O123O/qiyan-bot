import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { WebSocketServer } from "ws";
import { RpcClient } from "../../src/app-server/rpc-client.ts";
import { OneShotStreamAgent, WebSocketWire, createSocketCompatibleDuplex } from "../../src/app-server/websocket-wire.ts";
import type { ReadyProcessStream } from "../../src/endpoints/ssh-process.ts";

test("WebSocket wire exchanges App Server frames over a Unix socket", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-ws-"));
  const socket = join(root, "app.sock");
  const server = createServer();
  const websocket = new WebSocketServer({ server, maxPayload: 1024 * 1024 });
  t.after(async () => {
    websocket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  let extensionHeader: string | undefined;
  websocket.on("connection", (peer, request) => {
    extensionHeader = request.headers["sec-websocket-extensions"];
    peer.on("message", (value) => {
      const rpc = JSON.parse(value.toString()) as { id: number };
      peer.send(JSON.stringify({ id: rpc.id, result: { ready: true } }));
    });
  });
  await new Promise<void>((resolve, reject) => server.listen(socket, () => resolve()).once("error", reject));
  await chmod(socket, 0o600);
  const wire = await WebSocketWire.connect(socket, { timeoutMs: 500, trustedRoot: root });
  try { assert.equal(extensionHeader, undefined); }
  catch (error) { wire.close(); throw error; }
  const client = new RpcClient(wire, { requestTimeoutMs: 500 });
  assert.deepEqual(await client.request("initialize", {}), { ready: true });
  client.close();
});

test("WebSocket wire rejects non-absolute socket paths", async () => {
  await assert.rejects(WebSocketWire.connect("relative.sock", { timeoutMs: 10, trustedRoot: "/tmp" }), /absolute Unix socket/u);
});

test("WebSocket wire rejects sockets outside an owner-private trusted root and symlink substitutions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-ws-private-"));
  const other = await mkdtemp(join(tmpdir(), "qiyan-ws-other-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(other, { recursive: true, force: true })]));
  await chmod(root, 0o755);
  await assert.rejects(WebSocketWire.connect(join(root, "missing.sock"), { timeoutMs: 10, trustedRoot: root }), /private Unix socket root/u);
  await chmod(root, 0o700);
  const target = join(other, "target.sock");
  const alias = join(root, "alias.sock");
  await symlink(target, alias);
  await assert.rejects(WebSocketWire.connect(alias, { timeoutMs: 10, trustedRoot: root }), /owner Unix socket/u);
  await assert.rejects(WebSocketWire.connect(target, { timeoutMs: 10, trustedRoot: root }), /inside the trusted root/u);
});

test("server close rejects a pending RPC", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-ws-close-"));
  const socket = join(root, "app.sock");
  const server = createServer();
  const websocket = new WebSocketServer({ server });
  t.after(async () => { websocket.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  websocket.on("connection", (peer) => peer.on("message", () => peer.close()));
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await chmod(socket, 0o600);
  const client = new RpcClient(await WebSocketWire.connect(socket, { timeoutMs: 500, trustedRoot: root }), { requestTimeoutMs: 1_000 });
  await assert.rejects(client.request("pending", {}), /wire closed/u);
});

test("WebSocket wire accepts a full App Server turn beyond the old 16 MiB ceiling", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-ws-large-result-"));
  const socket = join(root, "app.sock");
  const server = createServer();
  const websocket = new WebSocketServer({ server });
  t.after(async () => {
    for (const peer of websocket.clients) peer.terminate();
    websocket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  websocket.on("connection", (peer) => peer.on("message", (value) => {
    const rpc = JSON.parse(value.toString()) as { id: number };
    peer.send(JSON.stringify({ id: rpc.id, result: { text: "x".repeat(17 * 1024 * 1024) } }));
  }));
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  await chmod(socket, 0o600);
  const client = new RpcClient(await WebSocketWire.connect(socket, { timeoutMs: 500, trustedRoot: root }), { requestTimeoutMs: 5_000 });
  const result = await client.request<{ text: string }>("large-result", {});
  assert.equal(result.text.length, 17 * 1024 * 1024);
  client.close();
});

test("binary and oversized fragmented frames close the wire", async (t) => {
  for (const kind of ["binary", "oversized"] as const) {
    await t.test(kind, async () => {
      const root = await mkdtemp(join(tmpdir(), `qiyan-ws-${kind}-`));
      const socket = join(root, "app.sock");
      const server = createServer();
      const websocket = new WebSocketServer({ server });
      websocket.on("connection", (peer) => setTimeout(() => {
        if (kind === "binary") peer.send(Buffer.from("no"), { binary: true });
        else {
          peer.send("x".repeat(33 * 1024 * 1024), { fin: false });
          peer.send("x".repeat(33 * 1024 * 1024), { fin: true });
        }
      }, 10));
      await new Promise<void>((resolve) => server.listen(socket, resolve));
      await chmod(socket, 0o600);
      const client = new RpcClient(await WebSocketWire.connect(socket, { timeoutMs: 500, trustedRoot: root }), { requestTimeoutMs: 1_000 });
      await assert.rejects(client.request("pending", {}), /frame|payload|wire closed/iu);
      for (const peer of websocket.clients) peer.terminate();
      websocket.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });
  }
});

test("redirects and stalled handshakes fail within the bound", async (t) => {
  for (const kind of ["redirect", "stalled"] as const) {
    await t.test(kind, async () => {
      const root = await mkdtemp(join(tmpdir(), `qiyan-ws-${kind}-`));
      const socket = join(root, "app.sock");
      const server = kind === "redirect"
        ? createServer((_request, response) => { response.writeHead(302, { location: "http://example.invalid" }); response.end(); })
        : createServer();
      await new Promise<void>((resolve) => server.listen(socket, resolve));
      await chmod(socket, 0o600);
      await assert.rejects(WebSocketWire.connect(socket, { timeoutMs: 30, trustedRoot: root }), /response|handshake/iu);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });
  }
});

test("WebSocket wire performs a real handshake over a non-Socket byte stream", async (t) => {
  const server = createServer();
  const websocket = new WebSocketServer({ server });
  websocket.on("connection", (peer) => peer.on("message", (value) => {
    const rpc = JSON.parse(value.toString()) as { id: number };
    peer.send(JSON.stringify({ id: rpc.id, result: { stream: true } }));
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const transport = connect(address.port, "127.0.0.1");
  await once(transport, "connect");
  const input = new PassThrough();
  const output = new PassThrough();
  input.pipe(transport);
  transport.pipe(output);
  let closeCalls = 0;
  const stream: ReadyProcessStream = {
    input,
    output,
    onClose: () => () => undefined,
    close: async () => { closeCalls += 1; transport.destroy(); input.destroy(); output.destroy(); },
  };
  t.after(async () => {
    for (const peer of websocket.clients) peer.terminate();
    websocket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const client = new RpcClient(await WebSocketWire.connectStream(stream, { timeoutMs: 500 }), { requestTimeoutMs: 500 });
  assert.deepEqual(await client.request("initialize", {}), { stream: true });
  client.close();
  for (let attempt = 0; attempt < 20 && closeCalls === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closeCalls, 1);
});

test("the socket adapter preserves a byte-stream error", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const stream: ReadyProcessStream = {
    input, output,
    onClose: () => () => undefined,
    close: async () => undefined,
  };
  const socket = createSocketCompatibleDuplex(stream);
  const failed = once(socket, "error");

  output.destroy(new Error("specific byte stream failure"));

  const [error] = await failed;
  assert.match(String(error), /specific byte stream failure/u);
  socket.destroy();
});

test("the stream HTTP agent rejects a concurrent second request instead of queueing", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const stream: ReadyProcessStream = {
    input, output, onClose: () => () => undefined,
    close: async () => { input.destroy(); output.destroy(); },
  };
  const socket = createSocketCompatibleDuplex(stream);
  const agent = new OneShotStreamAgent(socket);
  const first = request({ host: "stream.invalid", agent });
  first.on("error", () => undefined);
  first.end();
  assert.throws(() => request({ host: "stream.invalid", agent }), /already admitted|one-shot/u);
  first.destroy();
  agent.destroy();
});
