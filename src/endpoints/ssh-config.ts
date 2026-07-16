import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { AppError } from "../core/errors.ts";
import type { SshDestination } from "./binding-store.ts";
import { runBoundedProcess, type BoundedProcessResult } from "./ssh-process.ts";

export interface EffectiveSshConfig extends SshDestination {
  controlMaster: string;
  controlPath?: string;
}

export interface SshConnectionPlan {
  alias: string;
  destination: SshDestination;
  commonArgs: readonly string[];
  controlPath?: string;
  ownsControlMaster: boolean;
}

export interface PendingDestinationBinding { endpointId: string; destination: SshDestination }
export interface SshConnectionGeneration { plan: SshConnectionPlan; pendingBinding: PendingDestinationBinding }

export function parseSshConfig(output: string): EffectiveSshConfig {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const index = line.indexOf(" ");
    if (index <= 0) continue;
    values.set(line.slice(0, index).toLowerCase(), line.slice(index + 1).trim());
  }
  const hostname = values.get("hostname");
  const user = values.get("user");
  const port = Number(values.get("port"));
  if (!hostname) throw new AppError("CONFIGURATION_ERROR", "effective SSH hostname is missing");
  if (!user) throw new AppError("CONFIGURATION_ERROR", "effective SSH user is missing");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new AppError("CONFIGURATION_ERROR", "effective SSH port is invalid");
  const controlPath = values.get("controlpath");
  return {
    hostname,
    user,
    port,
    controlMaster: values.get("controlmaster")?.toLowerCase() ?? "no",
    ...(controlPath && controlPath !== "none" ? { controlPath } : {}),
  };
}

export function planSshConnection(alias: string, effective: EffectiveSshConfig, runtimeDir: string): SshConnectionPlan {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(alias)) throw new AppError("CONFIGURATION_ERROR", "invalid SSH endpoint alias");
  const userMaster = effective.controlPath !== undefined
    && new Set(["yes", "auto"]).has(effective.controlMaster)
    && usableControlPath(effective.controlPath);
  const ownedPath = join(runtimeDir, "ssh", createHash("sha256").update(`${alias}\0${effective.hostname}\0${effective.user}\0${effective.port}`).digest("hex").slice(0, 24));
  if (!userMaster && Buffer.byteLength(ownedPath) > 100) throw new AppError("CONFIGURATION_ERROR", "QiYan SSH control path is too long");
  return {
    alias,
    destination: { hostname: effective.hostname, user: effective.user, port: effective.port },
    commonArgs: [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
    ],
    controlPath: userMaster ? effective.controlPath! : ownedPath,
    ownsControlMaster: !userMaster,
  };
}

export function buildSshArgs(plan: SshConnectionPlan, operationArgs: readonly string[]): string[] {
  if (!plan.ownsControlMaster && operationArgs.includes("-O")) {
    throw new AppError("OPERATION_CONFLICT", "cannot operate a user-owned SSH ControlMaster");
  }
  return [...baseArgs(plan, true), ...operationArgs, plan.alias];
}

export function buildSshRemoteArgs(plan: SshConnectionPlan, command: readonly string[]): string[] {
  if (command.length === 0 || command.some((token) => !/^[A-Za-z0-9_./-]+$/u.test(token))) {
    throw new AppError("CONFIGURATION_ERROR", "unsafe SSH remote command token");
  }
  return [...baseArgs(plan, true), plan.alias, ...command];
}

// Diagnoses whether an already-attested user-owned ControlMaster can open one new
// session channel. It must never establish or operate the master and carries no
// caller-controlled remote command.
export function buildSshSessionProbeArgs(plan: SshConnectionPlan): string[] {
  if (plan.ownsControlMaster) {
    throw new AppError("OPERATION_CONFLICT", "fresh-channel probe requires a user-owned SSH ControlMaster");
  }
  return [...baseArgs(plan, false), plan.alias, "true"];
}

// Carries a locally pinned, gzip-compressed Node.js module in a shell-safe base64url
// argument. Unlike `node -`, this leaves stdin available for bounded streaming uploads.
// The only shell syntax is this fixed loader; the program and all caller arguments remain
// strict safe tokens.
export function buildSshRemoteNodeProgramArgs(
  plan: SshConnectionPlan,
  programBase64Url: string,
  command: readonly string[],
): string[] {
  const loader = 'import("node:zlib").then(m=>import("data:text/javascript;base64,"+m.gunzipSync(Buffer.from(process.argv[1],"base64url")).toString("base64")))';
  if (!/^[A-Za-z0-9_-]+$/u.test(programBase64Url) || programBase64Url.length > 64 * 1024
    || command.length === 0 || command.some((token) => !/^[A-Za-z0-9_./-]+$/u.test(token))) {
    throw new AppError("CONFIGURATION_ERROR", "unsafe SSH remote Node.js program");
  }
  return [...baseArgs(plan, true), plan.alias, "node", "-e", `'${loader}'`, programBase64Url, ...command];
}

// Runs a single opaque shell command string over the endpoint's existing ControlMaster
// (established eagerly at bootstrap). Unlike buildSshRemoteArgs, the command is NOT
// tokenized/validated per token — the caller (SshClaudeCommandRunner) builds it with
// POSIX single-quoting, so it is one argv element handed to the remote login shell. A
// newline inside those single quotes is a literal, so it is allowed (a multi-line
// --append-system-prompt is valid); only a NUL, which cannot occur in an argv element,
// is rejected. Uses baseArgs(plan,false): reuse the master, never establish one here.
export function buildSshStreamArgs(plan: SshConnectionPlan, remoteCommand: string): string[] {
  if (remoteCommand.length === 0 || remoteCommand.includes("\0")) {
    throw new AppError("CONFIGURATION_ERROR", "unsafe SSH stream command");
  }
  return [...baseArgs(plan, false), plan.alias, remoteCommand];
}

// Reverse-forward (`-R`) a REMOTE loopback TCP port to a LOCAL port over the ControlMaster —
// exposes QiYan's loopback worker-MCP on the remote host so a remote `claude -p` worker can
// reach it. The remote listener binds to `127.0.0.1` (not `0.0.0.0`) — with the default
// `GatewayPorts no` this is bind-not-relax: only processes ON the remote host can connect,
// never the network. Auth is the per-session bearer token in the worker's --mcp-config.
// A remotePort of 0 asks the remote sshd to allocate a free port (reported on stdout); this
// avoids a fixed port that a stale forward from a prior instance could squat (a forward can
// only be cancelled with its EXACT original spec, so a fixed remote port is unreclaimable
// once the original local port is forgotten).
export function buildSshReverseForwardArgs(plan: SshConnectionPlan, remotePort: number, localPort: number): string[] {
  return [
    ...baseArgs(plan, false),
    "-o", "ExitOnForwardFailure=yes",
    "-O", "forward",
    "-R", reverseForwarding(remotePort, localPort),
    plan.alias,
  ];
}

export function buildSshReverseForwardCancelArgs(plan: SshConnectionPlan, remotePort: number, localPort: number): string[] {
  return [...baseArgs(plan, false), "-O", "cancel", "-R", reverseForwarding(remotePort, localPort), plan.alias];
}

function reverseForwarding(remotePort: number, localPort: number): string {
  // remotePort 0 = dynamic allocation (listen side); localPort must be a real bound port.
  if (!Number.isInteger(remotePort) || remotePort < 0 || remotePort > 65_535
    || !Number.isInteger(localPort) || localPort < 1 || localPort > 65_535) {
    throw new AppError("CONFIGURATION_ERROR", "invalid SSH reverse-forward port");
  }
  return `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`;
}

export function buildControlMasterCheckArgs(plan: SshConnectionPlan): string[] {
  return [...baseArgs(plan, false), "-O", "check", plan.alias];
}

export function buildControlMasterExitArgs(plan: SshConnectionPlan): string[] {
  if (!plan.ownsControlMaster) throw new AppError("OPERATION_CONFLICT", "cannot stop a user-owned SSH ControlMaster");
  return [...baseArgs(plan, false), "-O", "exit", plan.alias];
}

export class SshGenerationPlanner {
  constructor(private readonly options: {
    sshBinary: string;
    runtimeDir: string;
    hasReferences(endpointId: string): boolean | Promise<boolean>;
    checkExisting(endpointId: string, destination: SshDestination, hasReferences: boolean): void;
    attestControlMaster(plan: SshConnectionPlan): Promise<void>;
    run?: (command: string, args: readonly string[], options: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal }) => Promise<BoundedProcessResult>;
  }) {}

  // `host` is the ssh alias (drives `ssh -G` + the ControlMaster path); `endpointId` is the
  // stable identity/binding key. They were the same value when the catalog key WAS the alias;
  // they are now distinct (endpoints.json carries `host` separately from the endpoint id).
  async createGeneration(endpointId: string, host: string, signal?: AbortSignal): Promise<SshConnectionGeneration> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(host)) throw new AppError("CONFIGURATION_ERROR", "invalid SSH host alias");
    const run = this.options.run ?? runBoundedProcess;
    const result = await run(this.options.sshBinary, ["-G", host], { timeoutMs: 15_000, maxOutputBytes: 1024 * 1024, ...(signal ? { signal } : {}) });
    const effective = parseSshConfig(result.stdout.toString("utf8"));
    let plan = planSshConnection(host, effective, this.options.runtimeDir);
    const references = await this.options.hasReferences(endpointId);
    this.options.checkExisting(endpointId, plan.destination, references);
    if (!plan.ownsControlMaster) {
      try {
        await this.options.attestControlMaster(plan);
        await run(this.options.sshBinary, buildControlMasterCheckArgs(plan), {
          timeoutMs: 5_000,
          maxOutputBytes: 64 * 1024,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        plan = planSshConnection(host, {
          hostname: effective.hostname,
          user: effective.user,
          port: effective.port,
          controlMaster: "no",
        }, this.options.runtimeDir);
      }
    }
    return { plan, pendingBinding: { endpointId, destination: { ...plan.destination } } };
  }
}

function baseArgs(plan: SshConnectionPlan, establishOwnedMaster: boolean): string[] {
  const pinned = ["-o", `HostName=${plan.destination.hostname}`, "-l", plan.destination.user, "-p", String(plan.destination.port)];
  const control = ["-S", plan.controlPath!, ...(plan.ownsControlMaster && establishOwnedMaster
    ? ["-o", "ControlMaster=auto", "-o", "ControlPersist=yes"]
    : !plan.ownsControlMaster ? ["-o", "ControlMaster=no"] : [])];
  return [...plan.commonArgs, ...pinned, ...control];
}

function usableControlPath(value: string): boolean {
  return isAbsolute(value) && Buffer.byteLength(value) <= 100 && !/[\0\r\n]/u.test(value);
}
