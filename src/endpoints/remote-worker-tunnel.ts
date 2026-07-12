// Reverse tunnel that exposes QiYan's loopback worker-MCP on a remote Claude endpoint's host,
// so a remote `claude -p` worker can reach the scheduling/set_goal_status tools. One tunnel
// per endpoint (shared by its sessions — the per-session bearer token distinguishes them),
// established lazily on the first worker turn that needs scheduling and reused thereafter.
import { createHash } from "node:crypto";
import { buildSshReverseForwardArgs, buildSshReverseForwardCancelArgs, type SshConnectionPlan } from "./ssh-config.ts";
import { runBoundedProcess } from "./ssh-process.ts";

// Deterministic per-endpoint remote loopback port in a stable high range, so re-establishing
// after an endpoint re-lease reuses the SAME remote listener (cancel-then-forward is then
// idempotent — no accumulation of stale listeners). Same-host collisions across the 20000
// space are a birthday risk; a squatting co-tenant can DoS scheduling for that endpoint
// (fail-closed: the worker simply runs without self-scheduling), not escalate.
export function remoteWorkerMcpPort(endpointId: string): number {
  const digest = createHash("sha256").update(endpointId).digest();
  return 20_000 + (digest.readUInt32BE(0) % 20_000);
}

export class RemoteWorkerTunnel {
  private established = false;
  constructor(private readonly options: {
    plan: SshConnectionPlan;
    remotePort: number;
    localPort: number;
    sshBinary?: string;
    run?: typeof runBoundedProcess;
  }) {}

  get remotePort(): number { return this.options.remotePort; }

  // Establish the `-R 127.0.0.1:<remotePort>:127.0.0.1:<localPort>` forward once per instance.
  // cancel-then-forward makes it idempotent: any stale forward from a prior generation on the
  // same (deterministic) port is removed before the fresh one is added.
  async ensure(): Promise<void> {
    if (this.established) return;
    if (!Number.isInteger(this.options.localPort) || this.options.localPort < 1) {
      throw new Error("worker MCP local port is not available");
    }
    const run = this.options.run ?? runBoundedProcess;
    const ssh = this.options.sshBinary ?? "ssh";
    const forwardArgs = { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 };
    await run(ssh, buildSshReverseForwardCancelArgs(this.options.plan, this.options.remotePort, this.options.localPort), { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 }).catch(() => undefined);
    await run(ssh, buildSshReverseForwardArgs(this.options.plan, this.options.remotePort, this.options.localPort), forwardArgs);
    this.established = true;
  }

  async cancel(): Promise<void> {
    if (!this.established) return;
    const run = this.options.run ?? runBoundedProcess;
    await run(this.options.sshBinary ?? "ssh", buildSshReverseForwardCancelArgs(this.options.plan, this.options.remotePort, this.options.localPort), { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 }).catch(() => undefined);
    this.established = false;
  }
}
