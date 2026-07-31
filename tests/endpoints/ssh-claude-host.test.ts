import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LocalClaudeHost } from "../../src/claude-host/host.ts";
import { ClaudeHostServer } from "../../src/claude-host/transport.ts";
import type { SessionInput, SessionQuery } from "../../src/claude-host/session.ts";
import { SshClaudeHostRuntime } from "../../src/endpoints/ssh-claude-host.ts";
import type { ReadyProcessStream } from "../../src/endpoints/ssh-process.ts";
import type { EndpointLossKind, RuntimeIdentity } from "../../src/endpoints/types.ts";

const runtimeDir = "/tmp/qiyan-1000/abcdef0123456789abcdef01";
const identity = {
  kind: "ssh" as const,
  token: "0123456789abcdef0123456789abcdef",
  pid: 4242,
  linuxStartTime: "909",
  processGroupId: 4242,
};
const replacement = { ...identity, pid: 4343, linuxStartTime: "919", processGroupId: 4343 };

// Stands in for the SDK query the host would drive. Turns settle only when the test says so,
// which is what makes "a turn is still running" observable across a reconnect.
class FakeQuery implements SessionQuery {
  readonly received: SessionInput[] = [];
  private readonly pending: unknown[] = [];
  private readonly waiters: Array<(value: IteratorResult<unknown>) => void> = [];
  private ended = false;

  constructor(input: AsyncIterable<SessionInput>) {
    void (async () => { for await (const message of input) this.received.push(message); })();
  }

  settle(uuid: string): void {
    const message = { type: "result", subtype: "success", user_message_uuid: uuid };
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.pending.push(message);
  }

  async interrupt(): Promise<unknown> { return undefined; }
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async applyFlagSettings(): Promise<void> {}
  async stopTask(): Promise<void> {}
  async supportedModels(): Promise<unknown[]> { return []; }
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

// A real qiyan-claude-host on a real unix socket, reached through a stream that stands in
// for the helper's ssh proxy. Everything below the endpoint is therefore the production
// code path: framing, dispatch, and session actors are all genuine.
async function harness(t: { after(fn: () => void | Promise<void>): void }): Promise<{
  runtime: SshClaudeHostRuntime;
  queries: Map<string, FakeQuery>;
  invocations: Array<{ operation: string; value: Record<string, unknown> }>;
  streams: ReadyProcessStream[];
  losses: EndpointLossKind[];
  live: { identity: RuntimeIdentity; status: "absent" | "unhealthy" | "healthy" };
}> {
  const socketPath = join(await mkdtemp(join(tmpdir(), "qiyan-claude-host-")), "claude.sock");
  const queries = new Map<string, FakeQuery>();
  const host = new LocalClaudeHost(async (request) => (input) => {
    const query = new FakeQuery(input);
    queries.set(request.sessionId, query);
    return query;
  });
  const server = new ClaudeHostServer(host, {
    hostBuild: "test", sdkVersion: "0.3.220", claudeVersion: "2.1.220", runtimeGeneration: identity.token,
  });
  await server.listen(socketPath);
  const invocations: Array<{ operation: string; value: Record<string, unknown> }> = [];
  const streams: ReadyProcessStream[] = [];
  const sockets: Socket[] = [];
  const live: { identity: RuntimeIdentity; status: "absent" | "unhealthy" | "healthy" } = {
    identity, status: "absent",
  };
  const remote = {
    async bootstrap(): Promise<void> {},
    async invoke<T>(operation: string, args: readonly string[]): Promise<T> {
      const value = JSON.parse(args[0] ?? "{}") as Record<string, unknown>;
      invocations.push({ operation, value });
      if (operation === "inspect-claude-host") {
        return (live.status === "absent"
          ? { status: "absent" }
          : { status: live.status, identity: live.identity }) as T;
      }
      if (operation === "start-claude-host") {
        live.status = "healthy";
        return { identity: live.identity } as T;
      }
      if (operation === "stop-claude-host") {
        live.status = "absent";
        return { stopped: true } as T;
      }
      throw new Error(`unexpected helper operation: ${operation}`);
    },
    async openClaudeHostStream(): Promise<ReadyProcessStream> {
      const socket = await new Promise<Socket>((resolve, reject) => {
        const candidate = connect(socketPath);
        candidate.once("connect", () => resolve(candidate));
        candidate.once("error", reject);
      });
      sockets.push(socket);
      const stream: ReadyProcessStream = {
        input: socket,
        output: socket,
        onClose(listener) {
          const forward = (): void => listener();
          socket.once("close", forward);
          return () => { socket.off("close", forward); };
        },
        close: async () => { socket.destroy(); },
      };
      streams.push(stream);
      return stream;
    },
    async closeControlMaster(): Promise<void> {},
  };
  const runtime = new SshClaudeHostRuntime({
    endpointId: "claude-remote",
    host: {
      remoteUid: 1000,
      remoteHome: "/home/worker",
      remoteRuntimeDir: runtimeDir,
      remoteHelperPath: `${runtimeDir}/qiyan-ssh-helper.mjs`,
      remote,
      shell: "/bin/bash",
    },
  });
  const losses: EndpointLossKind[] = [];
  runtime.onUnavailable((kind) => losses.push(kind));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await runtime.host.shutdown();
    await server.close();
  });
  return { runtime, queries, invocations, streams, losses, live };
}

test("starting the remote runtime launches the host and reaches it over the proxied channel", async (t) => {
  const { runtime, invocations } = await harness(t);

  await runtime.start();

  assert.deepEqual(invocations.map((item) => item.operation), [
    // Inspect first (absent), start, then the dial re-attests before opening the channel.
    "inspect-claude-host", "start-claude-host", "inspect-claude-host",
  ]);
  const started = invocations.find((item) => item.operation === "start-claude-host");
  assert.equal(started?.value.runtimeDir, runtimeDir);
  // Distinct from the Codex app-server's `qiyan-<hash>` in the SAME runtime directory: an
  // endpoint switched between providers must not read the other's live tmux session as its
  // own unhealthy host, which would refuse activation until someone killed it by hand.
  assert.equal(started?.value.session, "qiyan-claude-abcdef0123456789abcdef01");
  assert.notEqual(started?.value.session, `qiyan-${runtimeDir.split("/").pop()}`);
  assert.equal(started?.value.shell, "/bin/bash");
  assert.match(String(started?.value.token), /^[0-9a-f]{32}$/u);
  // The channel really carries the protocol: the host answered with its own identity.
  const status = await runtime.host.hostStatus();
  assert.equal(status.claudeVersion, "2.1.220");
  assert.equal(status.runtimeGeneration, identity.token);
});

test("a turn left running on the host is recovered by id after the client reconnects", async (t) => {
  const { runtime, queries, streams } = await harness(t);
  await runtime.start();
  await runtime.host.open({ sessionId: "thread-1", mode: "create", cwd: "/work" });
  assert.equal(await runtime.host.send("thread-1", "turn-1", "keep going"), true);

  // Drop the channel underneath the client, exactly as a lost ssh connection would.
  streams[0]!.output.destroy();
  await delay(20);

  assert.deepEqual(await runtime.recoverTurn("thread-1"), { turnId: "turn-1" });
  queries.get("thread-1")!.settle("turn-1");
  await delay(20);
  assert.equal(await runtime.recoverTurn("thread-1"), undefined);
});

test("a thread the host never loaded has no turn to recover", async (t) => {
  const { runtime } = await harness(t);
  await runtime.start();

  assert.equal(await runtime.recoverTurn("never-loaded"), undefined);
});

test("releasing a thread unloads its session on the host", async (t) => {
  const { runtime, queries } = await harness(t);
  await runtime.start();
  await runtime.host.open({ sessionId: "thread-1", mode: "create", cwd: "/work" });

  await runtime.releaseThread("thread-1");

  // The session actor is gone: its query was closed and the host no longer knows the id.
  assert.equal(queries.get("thread-1")!.received.length, 0);
  await assert.rejects(runtime.host.status("thread-1"), /not loaded/u);
});

test("a replaced host is never dialled: the generation is reported lost instead", async (t) => {
  const { runtime, streams, losses, live } = await harness(t);
  await runtime.start();
  await runtime.host.open({ sessionId: "thread-1", mode: "create", cwd: "/work" });

  // The supervised process was replaced while QiYan was away; its sessions went with it.
  live.identity = replacement;
  streams[0]!.output.destroy();
  await delay(20);

  await assert.rejects(runtime.host.status("thread-1"), /was replaced/u);
  assert.deepEqual(losses, ["connection-lost"]);
  assert.equal(streams.length, 1, "no channel is opened to the replacement host");
});

test("an absent host after a dropped channel is reported as runtime loss", async (t) => {
  const { runtime, streams, losses, live } = await harness(t);
  await runtime.start();

  live.status = "absent";
  streams[0]!.output.destroy();
  await delay(20);

  assert.deepEqual(losses, ["runtime-lost"]);
});

// The manager stops and starts an endpoint runtime in place (restart, disconnect+connect,
// and every recovery path that reuses the published record). Shutting the client down must
// therefore be reversible, or activation fails against a host that is running and healthy —
// after ensureStarted has already launched or adopted one on the worker's machine.
test("a stopped runtime starts again in place and reaches the surviving host", async (t) => {
  const { runtime, invocations, live } = await harness(t);
  await runtime.start();
  await runtime.host.open({ sessionId: "thread-1", mode: "create", cwd: "/work" });

  await runtime.closeConnection();
  assert.equal(live.status, "healthy", "the worker's host outlives this client");

  await runtime.start();
  assert.equal((await runtime.host.status("thread-1")).sessionId, "thread-1",
    "the session that survived on the worker is reachable again");
  assert.equal(invocations.filter((item) => item.operation === "start-claude-host").length, 1,
    "the healthy host is adopted, not relaunched");
});

test("closing the connection leaves the remote host running; shutdown stops it by identity", async (t) => {
  const { runtime, invocations, live } = await harness(t);
  await runtime.start();

  await runtime.closeConnection();
  assert.equal(live.status, "healthy", "the worker's host outlives this QiYan client");

  const second = await harness(t);
  await second.runtime.start();
  await second.runtime.shutdownRuntime(identity);
  assert.equal(second.live.status, "absent");
  assert.deepEqual(
    second.invocations.find((item) => item.operation === "stop-claude-host")?.value.expected,
    identity,
  );
  assert.equal(invocations.some((item) => item.operation === "stop-claude-host"), false);
});
