import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SshClaudeCommandRunner } from "../../src/endpoints/ssh-claude-command-runner.ts";
import { parseSshConfig, planSshConnection } from "../../src/endpoints/ssh-config.ts";
import { runBoundedProcess } from "../../src/endpoints/ssh-process.ts";
import { prepareRemoteHost, SshRemoteClient } from "../../src/endpoints/ssh-runtime.ts";

const remoteAssetRoot = new URL("../../assets/remote", import.meta.url).pathname;
const helperPath = new URL("../../assets/remote/qiyan-ssh-helper.mjs", import.meta.url);

async function remoteRunner(endpointId: string, plan: ReturnType<typeof planSshConnection>) {
  const remote = new SshRemoteClient({ plan, helperSource: await readFile(helperPath) });
  const host = await prepareRemoteHost({ endpointId, remote, assetRoot: remoteAssetRoot });
  return new SshClaudeCommandRunner({ plan, host: { ...host, remote } });
}

// Remote Claude TURNS are not exercised here: they now run inside a long-lived
// `qiyan-claude-host` on the remote machine, which is the next stage of the migration
// (see TODO(remote-claude-host) in src/production-app.ts). Until it ships, activating a
// remote Claude endpoint fails closed rather than running Claude on the QiYan host
// against the wrong filesystem, so there is no remote turn to drive. What remains here is
// the part of a remote Claude endpoint that is already host-independent: the ssh-side
// runner used for discovery, transcript reads, and monitor checks.
// RUN_CLAUDE_REMOTE_INTEGRATION=1 CLAUDE_REMOTE_HOST=dfw-vscode
const host = process.env.CLAUDE_REMOTE_HOST;
const enabled = process.env.RUN_CLAUDE_REMOTE_INTEGRATION === "1" && !!host;

// A worker `monitor` check must evaluate on the REMOTE host (over ssh), not the QiYan host.
// runShellCheck resolves true only when the remote command exits 0, so a create/observe/remove
// round-trip on the remote filesystem proves it both runs remotely and maps the exit code.
test("a remote monitor check runs on the remote host over ssh", { skip: !enabled, timeout: 60_000 }, async () => {
  const effective = parseSshConfig((await runBoundedProcess("ssh", ["-G", host!], { timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 })).stdout.toString("utf8"));
  const plan = planSshConnection(host!, effective, await mkdtemp(join(tmpdir(), "qiyan-claude-check-")));
  const runner = await remoteRunner("claude-remote-check", plan);
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
