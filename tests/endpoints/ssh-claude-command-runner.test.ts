import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { SshClaudeCommandRunner } from "../../src/endpoints/ssh-claude-command-runner.ts";
import type { ReadyProcessStream } from "../../src/endpoints/ssh-process.ts";

const runtimeIdentity = {
  kind: "ssh" as const,
  token: "0123456789abcdef0123456789abcdef",
  pid: 101,
  linuxStartTime: "202",
  processGroupId: 101,
};
const turnIdentity = {
  kind: "ssh" as const,
  token: runtimeIdentity.token,
  pid: 303,
  linuxStartTime: "404",
  processGroupId: 303,
};

class FakeStream implements ReadyProcessStream {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly listeners = new Set<(error?: Error) => void>();
  closes = 0;
  onClose(listener: (error?: Error) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async close(): Promise<void> {
    this.closes += 1;
    for (const listener of this.listeners) listener();
  }
  fail(error?: Error): void {
    for (const listener of this.listeners) listener(error);
  }
}

class FakeRemote {
  readonly invocations: Array<{ operation: string; value: any }> = [];
  readonly transfers: Array<{ operation: string; value: any; input: string }> = [];
  readonly streams: Array<{ operation: string; stream: FakeStream }> = [];
  controlMasterCloses = 0;
  runtimePresent = true;
  turnRuntimeUnavailable = false;
  turnInspectionFailures = 0;
  turnInspectionCalls = 0;
  turn: {
    status: "running";
    paneId: string;
    turnId: string;
    dispatchToken: string;
    identity: typeof turnIdentity;
  } | undefined;

  async invoke<T>(operation: string, args: readonly string[]): Promise<T> {
    const value = JSON.parse(args[0] ?? "{}");
    this.invocations.push({ operation, value });
    if (operation === "start-claude-runtime") {
      return { identity: runtimeIdentity, claudePath: "/usr/bin/claude" } as T;
    }
    if (operation === "inspect-claude-runtime") {
      return (this.runtimePresent ? { status: "healthy", identity: runtimeIdentity } : { status: "absent" }) as T;
    }
    if (operation === "inspect-claude-turn") {
      this.turnInspectionCalls += 1;
      if (this.turnRuntimeUnavailable) return { status: "runtime-unavailable" } as T;
      if (this.turnInspectionFailures > 0) {
        this.turnInspectionFailures -= 1;
        throw new Error("persistent helper failure");
      }
      return (this.turn ?? { status: "idle" }) as T;
    }
    if (operation === "interrupt-claude-turn") {
      this.turn = undefined;
      return { interrupted: true } as T;
    }
    return {} as T;
  }

  async invokeTransfer<T>(
    operation: string,
    args: readonly string[],
    options: { input?: AsyncIterable<Uint8Array | string> },
  ): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const chunk of options.input ?? []) chunks.push(Buffer.from(chunk));
    const value = JSON.parse(args[0] ?? "{}");
    this.transfers.push({ operation, value, input: Buffer.concat(chunks).toString("utf8") });
    if (operation === "configure-claude-thread") {
      return { path: "/tmp/qiyan-1000/abcdef0123456789abcdef01/claude-threads/thread.json" } as T;
    }
    this.turn = {
      status: "running",
      paneId: "%7",
      turnId: value.turnId,
      dispatchToken: value.dispatchToken,
      identity: turnIdentity,
    };
    return this.turn as T;
  }

  async openHelperStream(operation: string): Promise<ReadyProcessStream> {
    const stream = new FakeStream();
    this.streams.push({ operation, stream });
    return stream;
  }

  async closeControlMaster(): Promise<void> { this.controlMasterCloses += 1; }
}

function runner(remote: FakeRemote): SshClaudeCommandRunner {
  return new SshClaudeCommandRunner({
    plan: {
      alias: "worker",
      destination: { hostname: "worker", user: "user", port: 22 },
      commonArgs: [],
      controlPath: "/tmp/qiyan-test/master",
      ownsControlMaster: true,
    },
    host: {
      remoteUid: 1000,
      remoteHome: "/home/user",
      remoteRuntimeDir: "/tmp/qiyan-1000/abcdef0123456789abcdef01",
      remoteHelperPath: "/tmp/qiyan-1000/abcdef0123456789abcdef01/qiyan-ssh-helper.mjs",
      shell: "/bin/bash",
      remote: remote as any,
    },
  });
}

test("detaching a remote Claude runner closes observers but neither interrupts nor settles its turn", async () => {
  const remote = new FakeRemote();
  const first = runner(remote);
  await first.start();
  const handle = await first.startTurn({
    threadId: "thread-one",
    cwd: "/work",
    message: "continue\n\n<!-- qiyan-cid:ctx:one -->",
    resume: true,
    flags: { model: "claude-opus-4-8", effort: "high" },
  });
  await delay(0);
  assert.equal(remote.streams.some((item) => item.operation === "watch-claude-runtime"), true);
  assert.equal(remote.streams.some((item) => item.operation === "watch-claude-turn"), true);

  await first.closeConnection();
  assert.equal(remote.invocations.some((item) => item.operation === "interrupt-claude-turn"), false);
  assert.equal(await Promise.race([handle.done.then(() => "settled"), delay(10, "pending")]), "pending");

  const replacement = runner(remote);
  await replacement.start();
  const recovered = await replacement.recoverTurn("thread-one", "/work");
  assert.equal(recovered?.turnId, "ctx:one");
  await replacement.closeConnection();
});

test("loss of the endpoint liveness stream is classified through a fresh runtime probe", async () => {
  const remote = new FakeRemote();
  const value = runner(remote);
  const losses: string[] = [];
  value.onUnavailable((kind) => losses.push(kind));
  await value.start();
  remote.runtimePresent = false;
  remote.streams.find((item) => item.operation === "watch-claude-runtime")!.stream.fail(new Error("lost"));
  await delay(5);
  assert.deepEqual(losses, ["runtime-lost"]);
  await value.closeConnection();
});

test("persistent turn-observer failures back off and enter endpoint recovery", async () => {
  const remote = new FakeRemote();
  remote.turnInspectionFailures = Number.POSITIVE_INFINITY;
  const value = runner(remote);
  const loss = new Promise<string>((resolve) => value.onUnavailable(resolve));
  await value.start();
  await value.startTurn({
    threadId: "thread-one",
    cwd: "/work",
    message: "continue\n\n<!-- qiyan-cid:ctx:one -->",
    resume: true,
    flags: {},
  });

  assert.equal(await Promise.race([loss, delay(2_000, "timeout")]), "connection-lost");
  assert.ok(remote.turnInspectionCalls <= 4, "observer retries must be bounded and backed off");
  await value.closeConnection();
});

test("runtime-unavailable leaves the turn unsettled and enters endpoint recovery", async () => {
  const remote = new FakeRemote();
  remote.turnRuntimeUnavailable = true;
  remote.runtimePresent = false;
  const value = runner(remote);
  const loss = new Promise<string>((resolve) => value.onUnavailable(resolve));
  await value.start();
  const handle = await value.startTurn({
    threadId: "thread-one",
    cwd: "/work",
    message: "continue\n\n<!-- qiyan-cid:ctx:one -->",
    resume: true,
    flags: {},
  });

  assert.equal(await Promise.race([loss, delay(1_000, "timeout")]), "runtime-lost");
  assert.equal(await Promise.race([handle.done.then(() => "settled"), delay(10, "pending")]), "pending");
  await value.closeConnection();
});
