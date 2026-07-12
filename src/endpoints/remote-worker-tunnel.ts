// Reverse tunnel that exposes QiYan's loopback worker-MCP on a remote Claude endpoint's host,
// so a remote `claude -p` worker can reach the scheduling/set_goal_status tools. One tunnel
// per endpoint (shared by its sessions — the per-session bearer token distinguishes them),
// established lazily on the first worker turn that needs scheduling and reused thereafter.
import { AppError } from "../core/errors.ts";
import { buildSshReverseForwardArgs, buildSshReverseForwardCancelArgs, type SshConnectionPlan } from "./ssh-config.ts";
import { runBoundedProcess } from "./ssh-process.ts";

export class RemoteWorkerTunnel {
  // The remote listen port the sshd allocated for us (`ssh -O forward -R 127.0.0.1:0:...`
  // reports it on stdout). Set once ensure() succeeds; the worker's --mcp-config URL points at
  // it. Dynamic allocation avoids a fixed port a stale forward from a prior QiYan instance
  // could squat (an ssh forward is only cancellable with its EXACT original spec, so a fixed
  // remote port becomes unreclaimable once the original local port is forgotten).
  private allocatedRemotePort: number | undefined;
  constructor(private readonly options: {
    plan: SshConnectionPlan;
    localPort: number;
    sshBinary?: string;
    run?: typeof runBoundedProcess;
  }) {}

  get remotePort(): number {
    if (this.allocatedRemotePort === undefined) throw new AppError("ENDPOINT_UNAVAILABLE", "worker MCP tunnel is not established");
    return this.allocatedRemotePort;
  }

  // Establish the reverse forward once per instance and record the sshd-allocated remote port.
  async ensure(): Promise<void> {
    if (this.allocatedRemotePort !== undefined) return;
    if (!Number.isInteger(this.options.localPort) || this.options.localPort < 1) {
      throw new Error("worker MCP local port is not available");
    }
    const run = this.options.run ?? runBoundedProcess;
    const ssh = this.options.sshBinary ?? "ssh";
    const result = await run(ssh, buildSshReverseForwardArgs(this.options.plan, 0, this.options.localPort), { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
    const allocated = Number.parseInt(result.stdout.toString("utf8").trim(), 10);
    if (!Number.isInteger(allocated) || allocated < 1 || allocated > 65_535) {
      // The forward never took effect (nothing dispatched), so this is proven-not-dispatched:
      // ENDPOINT_UNAVAILABLE lets a goal-drive fire retry cleanly rather than being swallowed.
      throw new AppError("ENDPOINT_UNAVAILABLE", "remote sshd did not report an allocated worker MCP port");
    }
    this.allocatedRemotePort = allocated;
  }

  // Cancels the forward with its EXACT allocated spec (the only form OpenSSH accepts). Not wired
  // to a teardown path today: a forward left by an unclean exit leaks only until the ControlMaster
  // exits, and with dynamic ports a leaked listener never collides with a future establishment.
  async cancel(): Promise<void> {
    if (this.allocatedRemotePort === undefined) return;
    const run = this.options.run ?? runBoundedProcess;
    await run(this.options.sshBinary ?? "ssh", buildSshReverseForwardCancelArgs(this.options.plan, this.allocatedRemotePort, this.options.localPort), { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 }).catch(() => undefined);
    this.allocatedRemotePort = undefined;
  }
}
