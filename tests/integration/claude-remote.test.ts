import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { HostEvent } from "../../src/claude-host/protocol.ts";
import { SshClaudeCommandRunner } from "../../src/endpoints/ssh-claude-command-runner.ts";
import { SshClaudeHostRuntime } from "../../src/endpoints/ssh-claude-host.ts";
import { parseSshConfig, planSshConnection } from "../../src/endpoints/ssh-config.ts";
import { runBoundedProcess } from "../../src/endpoints/ssh-process.ts";
import { prepareRemoteHost, SshRemoteClient } from "../../src/endpoints/ssh-runtime.ts";

const remoteAssetRoot = new URL("../../assets/remote", import.meta.url).pathname;
const helperPath = new URL("../../assets/remote/qiyan-ssh-helper.mjs", import.meta.url);

// Real end-to-end against a remote machine.
// RUN_CLAUDE_REMOTE_INTEGRATION=1 CLAUDE_REMOTE_HOST=dfw-vscode
const host = process.env.CLAUDE_REMOTE_HOST;
const enabled = process.env.RUN_CLAUDE_REMOTE_INTEGRATION === "1" && !!host;

async function remoteHost(endpointId: string) {
  const effective = parseSshConfig((await runBoundedProcess("ssh", ["-G", host!], { timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 })).stdout.toString("utf8"));
  const plan = planSshConnection(host!, effective, await mkdtemp(join(tmpdir(), "qiyan-claude-remote-")));
  const remote = new SshRemoteClient({ plan, helperSource: await readFile(helperPath) });
  const prepared = await prepareRemoteHost({ endpointId, remote, assetRoot: remoteAssetRoot });
  return { plan, remote, host: { ...prepared, remote } };
}

// The reason the persistent host exists: a turn belongs to the remote machine, not to the
// QiYan process that started it. Start a turn, throw the client away mid-turn as a service
// restart would, and prove a fresh client re-attaches to the SAME host, finds the same turn
// still running, and still sees it settle.
test("a remote turn survives losing the QiYan client", { skip: !enabled, timeout: 300_000 }, async (t) => {
  const endpointId = "claude-remote-turn";
  const first = new SshClaudeHostRuntime({ endpointId, host: (await remoteHost(endpointId)).host });
  const prepared = await remoteHost(endpointId);
  const second = new SshClaudeHostRuntime({ endpointId, host: prepared.host });
  t.after(async () => {
    const identity = await second.runtimeIdentity().catch(() => undefined);
    if (identity) await second.shutdownRuntime(identity).catch(() => undefined);
    await second.closeConnection().catch(() => undefined);
  });

  await first.start();
  const threadId = randomUUID();
  const turnId = randomUUID();
  await first.host.open({ sessionId: threadId, mode: "create", cwd: prepared.host.remoteHome });
  assert.equal(await first.host.send(threadId, turnId, "Count slowly from 1 to 20, writing one line per number."), true);
  assert.deepEqual(await first.recoverTurn(threadId), { turnId });
  const startedOn = await first.runtimeIdentity();
  // QiYan goes away mid-turn. The remote host keeps working.
  await first.closeConnection();

  const events: HostEvent[] = [];
  second.host.subscribe((event) => events.push(event));
  await second.start();
  assert.deepEqual(await second.runtimeIdentity(), startedOn, "the fresh client re-attached to the same host process");
  assert.deepEqual(await second.recoverTurn(threadId), { turnId }, "the turn outlived the client that started it");

  const completed = await waitFor(() => events.find((event) => event.type === "turn/completed" && event.uuid === turnId), 240_000);
  assert.equal(completed.type === "turn/completed" ? completed.status : undefined, "completed");
  assert.equal(await second.recoverTurn(threadId), undefined, "a settled turn is no longer in flight");
});

// A worker `monitor` check must evaluate on the REMOTE host (over ssh), not the QiYan host.
// runShellCheck resolves true only when the remote command exits 0, so a create/observe/remove
// round-trip on the remote filesystem proves it both runs remotely and maps the exit code.
test("a remote monitor check runs on the remote host over ssh", { skip: !enabled, timeout: 60_000 }, async () => {
  const prepared = await remoteHost("claude-remote-check");
  const runner = new SshClaudeCommandRunner({ plan: prepared.plan });
  // Exit code → boolean mapping.
  assert.equal(await runner.runShellCheck("true"), true);
  assert.equal(await runner.runShellCheck("false"), false);
  assert.equal(await runner.runShellCheck("exit 3"), false);
  // Real remote filesystem state: the check sees a marker only after it is created ON the
  // remote host, and stops seeing it once removed there.
  const marker = `/tmp/qiyan-check-${process.pid}-${Date.now()}`;
  assert.equal(await runner.runShellCheck(`test ! -e ${marker}`), true);
  assert.equal(await runner.runShellCheck(`touch -- ${marker} && test -f ${marker}`), true);
  assert.equal(await runner.runShellCheck(`test -f ${marker}`), true);
  assert.equal(await runner.runShellCheck(`rm -f -- ${marker} && test ! -e ${marker}`), true);
  assert.equal(await runner.runShellCheck(`test -f ${marker}`), false);
});

async function waitFor<T>(read: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for a remote host event");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
