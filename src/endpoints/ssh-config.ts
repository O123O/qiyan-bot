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
    && new Set(["yes", "ask", "auto", "autoask"]).has(effective.controlMaster)
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

export function buildControlMasterExitArgs(plan: SshConnectionPlan): string[] {
  if (!plan.ownsControlMaster) throw new AppError("OPERATION_CONFLICT", "cannot stop a user-owned SSH ControlMaster");
  return [...baseArgs(plan, false), "-S", plan.controlPath!, "-O", "exit", plan.alias];
}

export class SshGenerationPlanner {
  constructor(private readonly options: {
    sshBinary: string;
    runtimeDir: string;
    hasReferences(endpointId: string): boolean | Promise<boolean>;
    checkExisting(endpointId: string, destination: SshDestination, hasReferences: boolean): void;
    run?: (command: string, args: readonly string[], options: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal }) => Promise<BoundedProcessResult>;
  }) {}

  async createGeneration(endpointId: string, signal?: AbortSignal): Promise<SshConnectionGeneration> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(endpointId)) throw new AppError("CONFIGURATION_ERROR", "invalid SSH endpoint alias");
    const run = this.options.run ?? runBoundedProcess;
    const result = await run(this.options.sshBinary, ["-G", endpointId], { timeoutMs: 15_000, maxOutputBytes: 1024 * 1024, ...(signal ? { signal } : {}) });
    const plan = planSshConnection(endpointId, parseSshConfig(result.stdout.toString("utf8")), this.options.runtimeDir);
    const references = await this.options.hasReferences(endpointId);
    this.options.checkExisting(endpointId, plan.destination, references);
    return { plan, pendingBinding: { endpointId, destination: { ...plan.destination } } };
  }
}

function baseArgs(plan: SshConnectionPlan, establishOwnedMaster: boolean): string[] {
  const pinned = ["-o", `HostName=${plan.destination.hostname}`, "-l", plan.destination.user, "-p", String(plan.destination.port)];
  const control = plan.ownsControlMaster
    ? ["-S", plan.controlPath!, ...(establishOwnedMaster ? ["-o", "ControlMaster=auto", "-o", "ControlPersist=60"] : [])]
    : [];
  return [...plan.commonArgs, ...pinned, ...control];
}

function usableControlPath(value: string): boolean {
  return isAbsolute(value) && Buffer.byteLength(value) <= 100 && !/[\0\r\n]/u.test(value);
}
