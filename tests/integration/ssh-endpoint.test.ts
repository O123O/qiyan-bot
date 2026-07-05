import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { WebSocketWire } from "../../src/app-server/websocket-wire.ts";
import { MINIMUM_SUPPORTED_CODEX_VERSION } from "../../src/app-server/protocol.ts";
import { openSshUnixTunnel, SshEndpoint } from "../../src/endpoints/ssh-endpoint.ts";
import { SshRemoteClient, SshRuntime } from "../../src/endpoints/ssh-runtime.ts";

const enabled = process.env.QIYAN_SSH_ENDPOINT_INTEGRATION === "1";

test("Docker SSH endpoint reconnects to the same detached App Server incarnation", { skip: !enabled }, async () => {
  const config = resolve(".tmp/ssh-worker/config");
  await readFile(config).catch(() => { throw new Error("SSH fixture is unavailable; run npm run ssh-worker:up first"); });
  const root = await mkdtemp(join(tmpdir(), "qiyan-ssh-integration-"));
  const plan = {
    alias: "qiyan-ssh-worker",
    destination: { hostname: "127.0.0.1", user: "codex", port: Number(process.env.QIYAN_SSH_WORKER_PORT ?? 2222) },
    commonArgs: ["-F", config, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"],
    controlPath: join(root, "control"),
    ownsControlMaster: true,
  };
  const remote = new SshRemoteClient({ plan, helperSource: await readFile("assets/remote/qiyan-ssh-helper.mjs") });
  const runtime = new SshRuntime({ endpointId: "fixture", remote });
  const socketRoot = join(root, "socket");
  const localSocket = join(socketRoot, "app.sock");
  const endpoint = new SshEndpoint({
    id: "fixture",
    runtime,
    minimumVersion: MINIMUM_SUPPORTED_CODEX_VERSION,
    openTunnel: (remoteSocketPath) => openSshUnixTunnel({ plan, localSocketPath: localSocket, remoteSocketPath }),
    connectWire: () => WebSocketWire.connect(localSocket, { timeoutMs: 10_000, trustedRoot: socketRoot }),
  });
  const connect = async () => {
    try { await endpoint.start(); }
    catch (error) {
      if (!(error instanceof Error && /not authenticated/u.test(error.message))) throw error;
    }
  };
  let identity;
  try {
    await connect();
    identity = await runtime.runtimeIdentity();
    assert.equal(identity?.kind, "ssh");
    const transferBytes = Buffer.from("ssh-file-bridge");
    const transferSha = createHash("sha256").update(transferBytes).digest("hex");
    const uploaded = await remote.invokeTransfer<{ path: string }>("write-file", [JSON.stringify({
      runtimeDir: runtime.remoteRuntimeDir, size: transferBytes.byteLength, sha256: transferSha,
    })], { input: Readable.from([transferBytes]), maxOutputBytes: 64 * 1024 }, runtime.remoteHelperPath);
    const downloaded = await remote.invokeTransfer<{ dataBase64: string; sha256: string }>("read-file", [JSON.stringify({
      path: uploaded.path, root: runtime.remoteRuntimeDir, maxBytes: 1024,
    })], { maxOutputBytes: 64 * 1024 }, runtime.remoteHelperPath);
    assert.equal(Buffer.from(downloaded.dataBase64, "base64").toString(), "ssh-file-bridge");
    assert.equal(downloaded.sha256, transferSha);
    await endpoint.closeConnection();
    await connect();
    assert.deepEqual(await runtime.runtimeIdentity(), identity);
  } finally {
    await endpoint.closeConnection().catch(() => undefined);
    if (identity) await runtime.stop(identity).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
