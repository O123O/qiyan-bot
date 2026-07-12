import assert from "node:assert/strict";
import test from "node:test";
import { RemoteWorkerTunnel } from "../../src/endpoints/remote-worker-tunnel.ts";
import { parseSshConfig, planSshConnection } from "../../src/endpoints/ssh-config.ts";

const plan = planSshConnection("dfw-claude", parseSshConfig(
  "hostname host.example\nuser xin\nport 22\ncontrolmaster auto\ncontrolpath /tmp/user-master\n",
), "/private/runtime");

test("ensure() forwards a dynamic (0) remote port and adopts the sshd-allocated port", async () => {
  const calls: Array<{ op: string; spec: string }> = [];
  const run = async (_ssh: string, args: readonly string[]): Promise<{ stdout: Buffer; stderr: Buffer }> => {
    calls.push({ op: args[args.indexOf("-O") + 1]!, spec: args[args.indexOf("-R") + 1]! });
    return { stdout: Buffer.from("34567\n"), stderr: Buffer.alloc(0) };
  };
  const tunnel = new RemoteWorkerTunnel({ plan, localPort: 40001, run: run as never });
  await tunnel.ensure();
  assert.equal(calls[0]!.op, "forward");
  assert.equal(calls[0]!.spec, "127.0.0.1:0:127.0.0.1:40001", "must request a dynamic remote port bound to the local MCP port");
  assert.equal(tunnel.remotePort, 34567, "must adopt the port the remote sshd reported");
  await tunnel.ensure(); // cached — no new ssh
  assert.equal(calls.length, 1, "second ensure re-forwarded");
  // cancel uses the EXACT allocated spec (only form ssh accepts to remove a forward)
  await tunnel.cancel();
  assert.deepEqual(calls.map((c) => c.op), ["forward", "cancel"]);
  assert.equal(calls[1]!.spec, "127.0.0.1:34567:127.0.0.1:40001");
});

test("remotePort before ensure() is an error, not a bogus value", () => {
  const tunnel = new RemoteWorkerTunnel({ plan, localPort: 40001, run: (async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })) as never });
  assert.throws(() => tunnel.remotePort, /not established/u);
});

test("ensure() rejects a non-numeric or out-of-range allocated port", async () => {
  for (const reported of ["", "notaport", "0", "70000"]) {
    const tunnel = new RemoteWorkerTunnel({ plan, localPort: 40001, run: (async () => ({ stdout: Buffer.from(reported), stderr: Buffer.alloc(0) })) as never });
    await assert.rejects(tunnel.ensure(), /allocated worker MCP port/u);
  }
});

test("ensure() refuses to forward to an unavailable local MCP port", async () => {
  const tunnel = new RemoteWorkerTunnel({ plan, localPort: 0, run: (async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })) as never });
  await assert.rejects(tunnel.ensure(), /local port/u);
});
