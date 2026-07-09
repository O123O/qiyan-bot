import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RpcWire } from "../../src/app-server/rpc-client.ts";
import { AppError } from "../../src/core/errors.ts";
import { SshAppServerRuntime } from "../../src/endpoints/ssh-app-server-runtime.ts";
import type { SshConnectionPlan } from "../../src/endpoints/ssh-config.ts";
import { localSshForwardSocketPath } from "../../src/endpoints/local-runtime.ts";
import type { SshRuntimeController } from "../../src/endpoints/ssh-runtime.ts";
import type { EndpointLossKind, RuntimeIdentity } from "../../src/endpoints/types.ts";

const identity: RuntimeIdentity = { kind: "ssh", token: "a".repeat(32), pid: 10, linuxStartTime: "20", processGroupId: 10 };
const replacement: RuntimeIdentity = { kind: "ssh", token: "b".repeat(32), pid: 11, linuxStartTime: "21", processGroupId: 11 };
const plan: SshConnectionPlan = {
  alias: "devbox",
  destination: { hostname: "host.example", user: "xin", port: 22 },
  commonArgs: ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"],
  ownsControlMaster: false,
  controlPath: "/tmp/user-master",
};

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

class FakeRemoteRuntime implements SshRuntimeController {
  readonly remoteSocketPath = "/tmp/qiyan-1000/abcdef0123456789abcdef01/app-server.sock";
  current: RuntimeIdentity | undefined = identity;
  classification: EndpointLossKind = "connection-lost";
  starts = 0;
  readonly stops: RuntimeIdentity[] = [];
  async ensureStarted(): Promise<RuntimeIdentity> { this.starts += 1; return identity; }
  async runtimeIdentity(): Promise<RuntimeIdentity | undefined> { return this.current; }
  async classifyLoss(): Promise<EndpointLossKind> { return this.classification; }
  async stop(expected: RuntimeIdentity): Promise<void> { this.stops.push(expected); }
}

function controlOperation(args: readonly string[]): string {
  return args[args.indexOf("-O") + 1] ?? "";
}

function forwarding(args: readonly string[]): string {
  return args[args.indexOf("-L") + 1] ?? "";
}

function localSocket(args: readonly string[]): string {
  const value = forwarding(args);
  return value.slice(0, value.indexOf(":"));
}

function fixture(root: string, remote = new FakeRemoteRuntime(), options: {
  connectWire?: (socketPath: string) => Promise<RpcWire>;
  beforeControl?: (operation: string, args: readonly string[]) => void | Promise<void>;
  cancelClosesForward?: () => boolean;
  plan?: SshConnectionPlan;
  attestControlMaster?: (plan: SshConnectionPlan) => Promise<void>;
} = {}) {
  const commands: string[][] = [];
  const wires: FakeWire[] = [];
  const servers = new Map<string, Server>();
  const runtime = new SshAppServerRuntime({
    runtime: remote,
    plan: options.plan ?? plan,
    socketRoot: root,
    attestControlMaster: options.attestControlMaster ?? (async () => undefined),
    run: async (_command, args) => {
      commands.push([...args]);
      const operation = controlOperation(args);
      await options.beforeControl?.(operation, args);
      if (operation === "forward") {
        const socketPath = localSocket(args);
        const server = createServer();
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        });
        await chmod(socketPath, 0o600);
        servers.set(forwarding(args), server);
      } else if (operation === "cancel") {
        const server = servers.get(forwarding(args));
        if (server && (options.cancelClosesForward?.() ?? true)) {
          await new Promise<void>((resolve) => server.close(() => resolve()));
          servers.delete(forwarding(args));
        }
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
    connectWire: options.connectWire ?? (async () => { const wire = new FakeWire(); wires.push(wire); return wire; }),
    connectionTimeoutMs: 2_000,
  });
  return { runtime, remote, commands, wires, servers };
}

async function privateRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qiyan-forward-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("opening requires the existing authenticated ControlMaster", async (t) => {
  const root = await privateRoot(t);
  const value = fixture(root, new FakeRemoteRuntime(), {
    beforeControl: (operation) => { if (operation === "check") throw new Error("authenticated master unavailable"); },
  });

  await assert.rejects(value.runtime.open(), /authenticated SSH ControlMaster is unavailable/u);
  assert.deepEqual(value.commands.map(controlOperation), ["check"]);
  assert.equal(value.remote.starts, 0, "an MFA endpoint must not attempt helper authentication without its user-owned master");
  assert.deepEqual(value.remote.stops, []);
});

test("opening preserves an actionable ControlMaster configuration error", async (t) => {
  const root = await privateRoot(t);
  const value = fixture(root, new FakeRemoteRuntime(), {
    attestControlMaster: async () => {
      throw new AppError("CONFIGURATION_ERROR", "unsafe user-owned SSH ControlMaster; use a private local filesystem");
    },
  });

  await assert.rejects(
    value.runtime.open(),
    (error: unknown) => error instanceof AppError
      && error.code === "CONFIGURATION_ERROR"
      && /private local filesystem/u.test(error.message),
  );
  assert.deepEqual(value.commands, []);
  assert.equal(value.remote.starts, 0);
});

test("wire connection failure cancels the exact forward without stopping the remote runtime", async (t) => {
  const root = await privateRoot(t);
  const value = fixture(root, new FakeRemoteRuntime(), {
    connectWire: async () => { throw new Error("wire connect failed"); },
  });

  await assert.rejects(value.runtime.open(), /wire connect failed/u);

  assert.deepEqual(value.commands.map(controlOperation), ["check", "forward", "cancel"]);
  const socketPath = localSocket(value.commands[1]!);
  await assert.rejects(lstat(socketPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.deepEqual(value.remote.stops, []);
});

test("open reclaims a stale master-owned forward socket left by a crashed process", async (t) => {
  const root = await privateRoot(t);
  const stalePath = localSshForwardSocketPath(root, "00000000");
  const stale = createServer();
  await new Promise<void>((resolve, reject) => {
    stale.once("error", reject);
    stale.listen(stalePath, resolve);
  });
  await chmod(stalePath, 0o600);
  const value = fixture(root);
  value.servers.set(`${stalePath}:${value.remote.remoteSocketPath}`, stale);

  const connection = await value.runtime.open();

  assert.deepEqual(value.commands.map(controlOperation), ["check", "cancel", "forward"]);
  assert.equal(stale.listening, false);
  assert.equal(localSocket(value.commands[2]!), stalePath);
  assert.equal((await lstat(stalePath)).isSocket(), true);
  await connection.close();
});

test("overlapping opens reserve one ControlMaster forward before the first await", async (t) => {
  const root = await privateRoot(t);
  let release!: (wire: RpcWire) => void;
  let beginConnect!: () => void;
  const connecting = new Promise<void>((resolve) => { beginConnect = resolve; });
  const connected = new Promise<RpcWire>((resolve) => { release = resolve; });
  const value = fixture(root, new FakeRemoteRuntime(), { connectWire: () => { beginConnect(); return connected; } });
  const first = value.runtime.open();

  await assert.rejects(value.runtime.open(), /already open/iu);
  await connecting;
  assert.equal(value.commands.filter((args) => controlOperation(args) === "forward").length, 1);
  release(new FakeWire());
  await (await first).close();
});

test("SSH runtime reuses one authenticated ControlMaster and confirms exact remote identity", async (t) => {
  const root = await privateRoot(t);
  const value = fixture(root);

  const connection = await value.runtime.open();
  const confirmed = await connection.confirmInitialized({});

  assert.deepEqual(confirmed, { runtime: identity });
  assert.equal(value.remote.starts, 1);
  assert.deepEqual(value.commands.slice(0, 2).map(controlOperation), ["check", "forward"]);
  for (const args of value.commands) {
    assert.deepEqual(args.slice(args.indexOf("-S"), args.indexOf("-S") + 2), ["-S", "/tmp/user-master"]);
    assert.doesNotMatch(args.join(" "), /ControlMaster=auto|ControlPath=none/u);
    for (const standalone of ["-N", "-T", "-n"]) assert.equal(args.includes(standalone), false);
  }
  assert.deepEqual(await value.runtime.runtimeIdentity(), identity);

  await connection.close();
  assert.equal(controlOperation(value.commands.at(-1)!), "cancel");
  assert.deepEqual(value.remote.stops, [], "closing the forward must leave the detached runtime alive");
});

test("SSH connection refuses a changed detached runtime identity", async (t) => {
  const root = await privateRoot(t);
  const value = fixture(root);
  const connection = await value.runtime.open();
  value.remote.current = replacement;

  await assert.rejects(connection.confirmInitialized({}), /identity changed/u);
  await connection.close();
});

test("App Server wire closure is the forward-loss signal", async (t) => {
  const root = await privateRoot(t);
  const value = fixture(root);
  const connection = await value.runtime.open();
  await connection.confirmInitialized({});
  const losses: string[] = [];
  connection.onClose(() => losses.push("closed"));

  value.wires[0]!.fail();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(losses, ["closed"]);
  assert.equal(await value.runtime.classifyLoss(), "connection-lost");
  await connection.close();
  await value.runtime.shutdownRuntime(identity);
  assert.deepEqual(value.remote.stops, [identity]);
});

test("a new generation waits until the previous forward cancellation and cleanup finish", async (t) => {
  const root = await privateRoot(t);
  let cancelStarted!: () => void;
  let releaseCancel!: () => void;
  const cancelling = new Promise<void>((resolve) => { cancelStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseCancel = resolve; });
  let firstForward = "";
  const value = fixture(root, new FakeRemoteRuntime(), {
    beforeControl: async (operation, args) => {
      if (operation === "forward" && !firstForward) firstForward = forwarding(args);
      if (operation === "cancel" && forwarding(args) === firstForward) { cancelStarted(); await release; }
    },
  });
  const first = await value.runtime.open();
  await first.confirmInitialized({});
  const closing = first.close();
  await cancelling;
  let replacementOpened = false;
  const replacementOpening = value.runtime.open().then((connection) => {
    replacementOpened = true;
    return connection;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replacementOpened, false);

  releaseCancel();
  await closing;

  const second = await replacementOpening;
  await second.confirmInitialized({});
  const forwardCommands = value.commands.filter((args) => controlOperation(args) === "forward");
  const secondPath = localSocket(forwardCommands[1]!);
  assert.equal((await lstat(secondPath)).isSocket(), true);
  assert.equal(value.wires[1]!.closed, false);
  await second.close();
});

test("cancel failure with a live master preserves the socket and blocks overlap until retry succeeds", async (t) => {
  const root = await privateRoot(t);
  let cancelFailures = 1;
  const value = fixture(root, new FakeRemoteRuntime(), {
    beforeControl: (operation) => {
      if (operation === "cancel" && cancelFailures-- > 0) throw new Error("cancel timeout");
    },
  });
  const connection = await value.runtime.open();
  const socketPath = localSocket(value.commands.find((args) => controlOperation(args) === "forward")!);

  await assert.rejects(connection.close(), /forward cleanup could not be confirmed/u);
  assert.equal((await lstat(socketPath)).isSocket(), true);

  const replacement = await value.runtime.open();
  assert.equal((await lstat(socketPath)).isSocket(), true);
  await replacement.close();
});

test("exit-zero cancel that leaves the listener alive preserves cleanup ownership", async (t) => {
  const root = await privateRoot(t);
  let closeForward = false;
  const value = fixture(root, new FakeRemoteRuntime(), { cancelClosesForward: () => closeForward });
  const connection = await value.runtime.open();
  const socketPath = localSocket(value.commands.find((args) => controlOperation(args) === "forward")!);

  await assert.rejects(connection.close(), /forward cleanup could not be confirmed/u);

  assert.equal((await lstat(socketPath)).isSocket(), true);
  closeForward = true;
  const replacement = await value.runtime.open();
  await replacement.close();
});

test("a failed control check cannot prove cancellation while the listener still accepts", async (t) => {
  const root = await privateRoot(t);
  let cleanup = false;
  const value = fixture(root, new FakeRemoteRuntime(), {
    beforeControl: (operation) => {
      if (cleanup && operation === "cancel") throw new Error("cancel failed");
      if (cleanup && operation === "check") {
        throw new AppError("ENDPOINT_UNAVAILABLE", "SSH process failed (exit 255)");
      }
    },
  });
  const connection = await value.runtime.open();
  const socketPath = localSocket(value.commands.find((args) => controlOperation(args) === "forward")!);
  cleanup = true;

  await assert.rejects(connection.close(), /forward cleanup could not be confirmed/u);

  assert.equal((await lstat(socketPath)).isSocket(), true);
  cleanup = false;
  const replacement = await value.runtime.open();
  await replacement.close();
});

test("opening rollback retains failed forward cleanup for the next open", async (t) => {
  const root = await privateRoot(t);
  let connectAttempts = 0;
  let cancelFailures = 1;
  const value = fixture(root, new FakeRemoteRuntime(), {
    connectWire: async () => {
      connectAttempts += 1;
      if (connectAttempts === 1) throw new Error("wire failed");
      return new FakeWire();
    },
    beforeControl: (operation) => {
      if (operation === "cancel" && cancelFailures-- > 0) throw new Error("cancel timeout");
    },
  });

  await assert.rejects(value.runtime.open(), /wire failed|cleanup/iu);
  const socketPath = localSocket(value.commands.find((args) => controlOperation(args) === "forward")!);
  assert.equal((await lstat(socketPath)).isSocket(), true);

  const connection = await value.runtime.open();
  assert.equal(connectAttempts, 2);
  await connection.close();
});

test("a rejected forward request without a listener does not retain cleanup ownership", async (t) => {
  const root = await privateRoot(t);
  let rejectForward = true;
  const value = fixture(root, new FakeRemoteRuntime(), {
    beforeControl: (operation) => {
      if (operation === "forward" && rejectForward) throw new Error("forward rejected");
    },
  });

  await assert.rejects(value.runtime.open(), /forward rejected/u);

  rejectForward = false;
  const connection = await value.runtime.open();
  await connection.close();
});

test("transport close waits for an in-flight owned open and exits the master last", async (t) => {
  const root = await privateRoot(t);
  let started!: () => void;
  let release!: () => void;
  const openingStarted = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const events: string[] = [];
  class DelayedRemote extends FakeRemoteRuntime {
    override async ensureStarted(): Promise<RuntimeIdentity> {
      events.push("ensure");
      started();
      await blocked;
      events.push("ensured");
      return identity;
    }
    async closeTransport(): Promise<void> { events.push("exit"); }
  }
  const ownedPlan = { ...plan, ownsControlMaster: true, controlPath: join(root, "owned-master") };
  const value = fixture(root, new DelayedRemote(), {
    plan: ownedPlan,
    beforeControl: (operation) => { events.push(operation); },
  });
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
  assert.equal(events.at(-1), "exit");
  await assert.rejects(
    lstat(localSshForwardSocketPath(root, "00000000")),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("explicit runtime shutdown waits for an in-flight open before stopping the remote runtime", async (t) => {
  const root = await privateRoot(t);
  let started!: () => void;
  let release!: () => void;
  const openingStarted = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const events: string[] = [];
  class DelayedRemote extends FakeRemoteRuntime {
    override async ensureStarted(): Promise<RuntimeIdentity> {
      events.push("ensure");
      started();
      await blocked;
      events.push("ensured");
      return identity;
    }
    override async stop(expected: RuntimeIdentity): Promise<void> {
      await super.stop(expected);
      events.push("stop");
    }
  }
  const value = fixture(root, new DelayedRemote(), {
    beforeControl: (operation) => { events.push(operation); },
  });
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
  assert.equal(events.at(-1), "stop");
  await assert.rejects(
    lstat(localSshForwardSocketPath(root, "00000000")),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("closed stale Unix listener inode is reclaimed", async (t) => {
  const root = await privateRoot(t);
  const socketPath = localSshForwardSocketPath(root, "00000000");
  const child = spawn(process.execPath, ["-e", [
    "const net=require('node:net');",
    "const fs=require('node:fs');",
    "const server=net.createServer();",
    "server.listen(process.argv[1],()=>{fs.chmodSync(process.argv[1],0o600);process.stdout.write('ready')});",
  ].join(""), socketPath], { stdio: ["ignore", "pipe", "ignore"] });
  await once(child.stdout!, "data");
  child.kill("SIGKILL");
  await once(child, "exit");
  assert.equal((await lstat(socketPath)).isSocket(), true);
  const value = fixture(root);

  const connection = await value.runtime.open();

  assert.equal((await lstat(socketPath)).isSocket(), true);
  await connection.close();
});

test("wire cleanup failure cannot leak the forward or skip exact remote shutdown", async (t) => {
  const root = await privateRoot(t);
  const value = fixture(root);
  const connection = await value.runtime.open();
  await connection.confirmInitialized({});
  const socketPath = localSocket(value.commands.find((args) => controlOperation(args) === "forward")!);
  value.wires[0]!.closeError = new Error("wire cleanup failed");

  await assert.rejects(value.runtime.shutdownRuntime(identity), /wire cleanup failed/u);

  assert.equal(value.commands.some((args) => controlOperation(args) === "cancel"), true);
  await assert.rejects(lstat(socketPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.deepEqual(value.remote.stops, [identity]);
});
