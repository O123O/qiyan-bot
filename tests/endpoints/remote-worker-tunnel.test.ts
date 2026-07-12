import assert from "node:assert/strict";
import test from "node:test";
import { RemoteWorkerTunnel, remoteWorkerMcpPort } from "../../src/endpoints/remote-worker-tunnel.ts";
import { parseSshConfig, planSshConnection } from "../../src/endpoints/ssh-config.ts";

const plan = planSshConnection("dfw-claude", parseSshConfig(
  "hostname host.example\nuser xin\nport 22\ncontrolmaster auto\ncontrolpath /tmp/user-master\n",
), "/private/runtime");

test("remoteWorkerMcpPort is deterministic and in the stable high range", () => {
  const a = remoteWorkerMcpPort("dfw-claude");
  assert.equal(a, remoteWorkerMcpPort("dfw-claude"), "not deterministic");
  assert.notEqual(a, remoteWorkerMcpPort("other-claude"), "collides trivially");
  assert.ok(a >= 20_000 && a < 40_000, `${a} out of range`);
});

test("ensure() cancels any stale reverse forward then establishes a fresh one, once", async () => {
  const calls: Array<{ op: string }> = [];
  const run = async (_ssh: string, args: readonly string[]): Promise<{ stdout: Buffer; stderr: Buffer }> => {
    calls.push({ op: args[args.indexOf("-O") + 1]! });
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  const tunnel = new RemoteWorkerTunnel({ plan, remotePort: 34567, localPort: 40001, run: run as never });
  await tunnel.ensure();
  assert.deepEqual(calls.map((c) => c.op), ["cancel", "forward"], "must cancel-then-forward");
  await tunnel.ensure(); // cached — no new ssh
  assert.equal(calls.length, 2, "second ensure re-established the forward");
  await tunnel.cancel();
  assert.deepEqual(calls.map((c) => c.op), ["cancel", "forward", "cancel"]);
});

test("ensure() refuses to forward to an unavailable local MCP port", async () => {
  const tunnel = new RemoteWorkerTunnel({ plan, remotePort: 34567, localPort: 0, run: (async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })) as never });
  await assert.rejects(tunnel.ensure(), /local port/u);
});
