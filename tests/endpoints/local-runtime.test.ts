import assert from "node:assert/strict";
import { symlink, lstat, mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  localSshEndpointSocketRoot,
  localSshForwardSocketPath,
  prepareLocalSshEndpointSocketRoot,
  prepareLocalSshRuntimeRoot,
} from "../../src/endpoints/local-runtime.ts";
import { parseSshConfig, planSshConnection } from "../../src/endpoints/ssh-config.ts";

test("places transient SSH sockets in the host runtime instead of the durable data directory", async (t) => {
  const runtimeBase = await mkdtemp(join(tmpdir(), "qiyan-local-runtime-"));
  t.after(() => rm(runtimeBase, { recursive: true, force: true }));

  const first = await prepareLocalSshRuntimeRoot("/nfs/home/user/.qiyan-bot/data", { runtimeBase });
  const repeated = await prepareLocalSshRuntimeRoot("/nfs/home/user/.qiyan-bot/data", { runtimeBase });
  const other = await prepareLocalSshRuntimeRoot("/nfs/home/user/other-qiyan/data", { runtimeBase });

  assert.equal(first, repeated);
  assert.notEqual(first, other);
  assert.match(first, new RegExp(`^${runtimeBase}/qiyan/[a-f0-9]{16}$`, "u"));
  assert.doesNotMatch(first, /^\/nfs\/home/u);
  assert.equal((await lstat(first)).mode & 0o777, 0o700);
});

test("the production socket path binds under XDG-style and fallback runtime bases", async (t) => {
  const uid = process.geteuid?.() ?? process.getuid?.() ?? 104284;
  const fixture = await mkdtemp(join(tmpdir(), "qiyan-local-socket-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const selections = [
    {
      base: join(fixture, "run", "user", String(uid)),
      options: { xdgRuntimeDir: join(fixture, "run", "user", String(uid)) },
    },
    {
      base: join(fixture, "tmp", `qiyan-${uid}`),
      options: { xdgRuntimeDir: null, temporaryDirectory: join(fixture, "tmp") },
    },
  ];

  for (const { base, options } of selections) {
    await mkdir(base, { recursive: true, mode: 0o700 });
    const runtimeRoot = await prepareLocalSshRuntimeRoot("/nfs/home/user/.qiyan-bot/data", { expectedUid: uid, ...options });
    assert.ok(runtimeRoot.startsWith(`${base}/`));
    const socketRoot = await prepareLocalSshEndpointSocketRoot(runtimeRoot, "dfw-vscode");
    const socketPath = localSshForwardSocketPath(socketRoot, "01234567");
    assert.ok(Buffer.byteLength(socketPath) <= 103);
    const server = createServer();
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("keeps representative Linux runtime sockets within the portable path bound", () => {
  for (const runtimeRoot of [
    "/run/user/104284/qiyan/0123456789abcdef",
    "/tmp/qiyan-104284/qiyan/0123456789abcdef",
  ]) {
    const socketRoot = localSshEndpointSocketRoot(runtimeRoot, "dfw-vscode");
    const socketPath = localSshForwardSocketPath(socketRoot, "01234567");
    assert.ok(Buffer.byteLength(socketPath) <= 103);
    const owned = planSshConnection("dfw-vscode", parseSshConfig(
      "hostname host.example\nuser xin\nport 22\ncontrolmaster no\ncontrolpath none\n",
    ), runtimeRoot);
    assert.ok(Buffer.byteLength(owned.controlPath!) <= 100);
  }
  assert.throws(
    () => localSshEndpointSocketRoot(`/${"x".repeat(100)}`, "dfw-vscode"),
    /Unix socket path is too long/u,
  );
  assert.throws(() => localSshForwardSocketPath("/private/runtime", "unsafe"), /socket path/u);
});

test("rejects a symlink in the private SSH runtime path", async (t) => {
  const runtimeBase = await mkdtemp(join(tmpdir(), "qiyan-local-runtime-link-"));
  const target = await mkdtemp(join(tmpdir(), "qiyan-local-runtime-target-"));
  t.after(() => Promise.all([
    rm(runtimeBase, { recursive: true, force: true }),
    rm(target, { recursive: true, force: true }),
  ]));
  await mkdir(join(runtimeBase, "qiyan"), { mode: 0o700 });
  const namespaceRoot = await prepareLocalSshRuntimeRoot("/known-data-dir", { runtimeBase });
  await rm(namespaceRoot, { recursive: true, force: true });
  await symlink(target, namespaceRoot);

  await assert.rejects(
    prepareLocalSshRuntimeRoot("/known-data-dir", { runtimeBase }),
    /private owner directory/u,
  );
});
