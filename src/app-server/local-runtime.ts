import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { AppError } from "../core/errors.ts";
import { readLinuxProcessIdentity, type LinuxProcessIdentity } from "../core/process-identity.ts";
import type { EndpointLossKind, RuntimeIdentity } from "../endpoints/types.ts";
import { JsonlWire } from "./jsonl-wire.ts";
import type {
  AppServerConnection,
  AppServerConnectionIdentity,
  AppServerInitializeResult,
  AppServerRuntimeService,
} from "./managed-endpoint.ts";
import type { RpcWire } from "./rpc-client.ts";

type Spawn = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
type ResolveMcpClientIdentity = (rootPid: number) => Promise<LinuxProcessIdentity>;

async function readDirectChildren(pid: number): Promise<number[]> {
  let value: string;
  try { value = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8"); }
  catch (error) { throw new AppError("UNSUPPORTED_CAPABILITY", "unable to verify Codex launcher topology", { cause: error }); }
  if (!value.trim()) return [];
  const children = value.trim().split(/\s+/u).map(Number);
  if (children.some((child) => !Number.isSafeInteger(child) || child <= 1)) throw new AppError("UNSUPPORTED_CAPABILITY", "invalid Codex launcher topology");
  return children;
}

export async function resolveMcpClientIdentity(
  rootPid: number,
  childrenOf: (pid: number) => Promise<readonly number[]> = readDirectChildren,
  identify: (pid: number) => Promise<LinuxProcessIdentity> = readLinuxProcessIdentity,
): Promise<LinuxProcessIdentity> {
  if (process.platform !== "linux") throw new AppError("UNSUPPORTED_CAPABILITY", "manager MCP process verification requires Linux");
  const children = await childrenOf(rootPid);
  if (children.length === 0) return identify(rootPid);
  if (children.length !== 1) throw new AppError("UNSUPPORTED_CAPABILITY", "unsupported Codex launcher topology");
  const [protocolPid] = children;
  if (!protocolPid || (await childrenOf(protocolPid)).length !== 0) throw new AppError("UNSUPPORTED_CAPABILITY", "unsupported Codex launcher topology");
  return identify(protocolPid);
}

export class LocalAppServerRuntime implements AppServerRuntimeService {
  private active?: LocalConnection;
  private identity?: RuntimeIdentity & { kind: "local" };
  private lastIdentity?: RuntimeIdentity & { kind: "local" };

  constructor(private readonly options: {
    codexBinary: string;
    spawn?: Spawn;
    env?: NodeJS.ProcessEnv;
    expectedCodexHome?: string;
    validateEnvironment?: () => Promise<void>;
    resolveMcpClientIdentity?: ResolveMcpClientIdentity;
  }) {}

  async open(): Promise<AppServerConnection> {
    if (this.active) throw new AppError("OPERATION_CONFLICT", "local App Server connection is already open");
    await this.options.validateEnvironment?.();
    const spawn = this.options.spawn ?? nodeSpawn;
    const child = spawn(this.options.codexBinary, ["app-server", "--listen", "stdio://"], {
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.on("data", () => { /* Drain without logging potentially sensitive App Server stderr. */ });
    const connection = new LocalConnection(this, child);
    this.active = connection;
    delete this.identity;
    delete this.lastIdentity;
    return connection;
  }

  async runtimeIdentity(): Promise<RuntimeIdentity | undefined> {
    return this.identity ? { ...this.identity } : undefined;
  }

  async classifyLoss(): Promise<EndpointLossKind> { return "runtime-lost"; }

  async shutdownRuntime(expected: RuntimeIdentity): Promise<void> {
    const actual = this.identity ?? this.lastIdentity;
    if (!actual || !sameLocalIdentity(actual, expected)) {
      throw new AppError("OPERATION_CONFLICT", "local App Server runtime identity changed before shutdown");
    }
    await this.active?.close();
  }

  async confirm(connection: LocalConnection, child: ChildProcessWithoutNullStreams, result: AppServerInitializeResult): Promise<AppServerConnectionIdentity> {
    if (this.active !== connection || connection.closed) throw new AppError("ENDPOINT_UNAVAILABLE", "local App Server generation changed during initialization");
    await this.options.validateEnvironment?.();
    if (this.options.expectedCodexHome) {
      const actual = result.codexHome === undefined ? undefined : await realpath(result.codexHome).catch(() => undefined);
      if (actual !== this.options.expectedCodexHome) throw new AppError("CONFIGURATION_ERROR", "assistant app-server reported an unexpected CODEX_HOME");
    }
    if (!Number.isSafeInteger(child.pid) || child.pid === undefined || child.pid <= 1) {
      throw new AppError("ENDPOINT_UNAVAILABLE", "local App Server process identity is unavailable");
    }
    const protocol = await (this.options.resolveMcpClientIdentity ?? resolveMcpClientIdentity)(child.pid);
    if (this.active !== connection || connection.closed || child.exitCode !== null || child.signalCode !== null) {
      throw new AppError("ENDPOINT_UNAVAILABLE", "local App Server generation changed during initialization");
    }
    const identity = { kind: "local" as const, pid: protocol.pid, startTime: protocol.startTime };
    this.identity = identity;
    return { runtime: identity, allowedClientProcess: { ...protocol } };
  }

  release(connection: LocalConnection): void {
    if (this.active !== connection) return;
    delete this.active;
    if (this.identity) this.lastIdentity = this.identity;
    delete this.identity;
  }
}

class LocalConnection implements AppServerConnection {
  readonly wire: RpcWire;
  private readonly closes = new Set<(error?: Error) => void>();
  private intentional = false;
  closed = false;

  constructor(private readonly runtime: LocalAppServerRuntime, private readonly child: ChildProcessWithoutNullStreams) {
    this.wire = new JsonlWire(child.stdout, child.stdin);
    child.once("error", (error) => this.lost(error));
    child.once("exit", () => this.lost(new Error("app-server process exited")));
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }

  confirmInitialized(result: AppServerInitializeResult): Promise<AppServerConnectionIdentity> {
    return this.runtime.confirm(this, this.child, result);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.intentional = true;
    this.closed = true;
    this.runtime.release(this);
    this.wire.close();
    await stopChild(this.child);
  }

  private lost(error: Error): void {
    if (this.intentional || this.closed) return;
    this.closed = true;
    this.runtime.release(this);
    for (const listener of this.closes) listener(error);
  }
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve();
    };
    child.once("exit", done);
    timeout = setTimeout(() => { child.kill("SIGKILL"); done(); }, 5_000);
    timeout.unref?.();
    child.kill();
  });
}

function sameLocalIdentity(left: RuntimeIdentity & { kind: "local" }, right: RuntimeIdentity): boolean {
  return right.kind === "local" && left.pid === right.pid && left.startTime === right.startTime;
}
