import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { WebSocketWire } from "../../src/app-server/websocket-wire.ts";
import { ManagedAppServerEndpoint } from "../../src/app-server/managed-endpoint.ts";
import { MINIMUM_SUPPORTED_CODEX_VERSION } from "../../src/app-server/protocol.ts";
import { SshAppServerRuntime } from "../../src/endpoints/ssh-app-server-runtime.ts";
import { SshRemoteClient, SshRuntime } from "../../src/endpoints/ssh-runtime.ts";
import { SshHost } from "../../src/endpoints/ssh-host.ts";

const enabled = process.env.QIYAN_SSH_ENDPOINT_INTEGRATION === "1";

test("Docker SSH endpoint uses a ControlMaster stream-local forward and reconnects to the same detached App Server", { skip: !enabled }, async () => {
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
  await mkdir(socketRoot, { mode: 0o700 });
  const endpoint = new ManagedAppServerEndpoint({
    id: "fixture",
    runtime: new SshAppServerRuntime({
      runtime,
      plan,
      socketRoot,
      connectWire: (socketPath) => WebSocketWire.connect(socketPath, { timeoutMs: 10_000, trustedRoot: socketRoot }),
    }),
    minimumVersion: MINIMUM_SUPPORTED_CODEX_VERSION,
  });
  const connect = () => endpoint.start();
  let identity;
  try {
    await connect();
    identity = await runtime.runtimeIdentity();
    assert.equal(identity?.kind, "ssh");
    const projectDir = `/home/codex/projects/qiyan-endpoint-${process.pid}`;
    await new SshHost("fixture", remote, runtime.remoteHelperPath).mkdir(projectDir, { recursive: true, mode: 0o700 });
    const started = await endpoint.request<{ thread: { id: string; cwd: string } }>("thread/start", {
      cwd: projectDir,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: false,
      threadSource: crypto.randomUUID(),
    });
    assert.match(started.thread.id, /^[0-9a-f-]{36}$/u);
    assert.equal(started.thread.cwd, projectDir);
    const transferBytes = Buffer.from("ssh-file-bridge");
    const transferSha = createHash("sha256").update(transferBytes).digest("hex");
    const uploaded = await remote.invokeTransfer<{ path: string }>("write-file", [JSON.stringify({
      runtimeDir: runtime.remoteRuntimeDir, size: transferBytes.byteLength, sha256: transferSha,
    })], { input: Readable.from([transferBytes]), maxOutputBytes: 64 * 1024 }, runtime.remoteHelperPath);
    const rootIdentity = await remote.invoke<{ device: string; inode: string }>("workspace", [JSON.stringify({
      action: "lstat", path: runtime.remoteRuntimeDir,
    })], runtime.remoteHelperPath);
    const downloaded = await remote.invokeTransfer<{ dataBase64: string; sha256: string }>("read-file", [JSON.stringify({
      path: uploaded.path, root: runtime.remoteRuntimeDir,
      rootDevice: rootIdentity.device, rootInode: rootIdentity.inode, maxBytes: 1024,
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
