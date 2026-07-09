import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AppError } from "../core/errors.ts";
import { buildControlMasterExitArgs, buildSshRemoteArgs, type SshConnectionPlan } from "./ssh-config.ts";
import { runBoundedProcess, type BoundedProcessResult } from "./ssh-process.ts";
import { parseRuntimeIdentity, type EndpointLossKind, type RuntimeIdentity } from "./types.ts";

export const REMOTE_HELPER_SHA256 = "d4cbbfd2d647a19e6a5686ff2e1d3b892201c17e692b4205a26f2e702fe52178";
export const REMOTE_LAUNCHER_SHA256 = "db138ff3173f9b72d1fa8cc5fbc94c4958247691a401232d84edf0e3417bd334";

const MAX_REMOTE_ARGUMENT_BYTES = 16 * 1024;
const helperOperations = new Set(["preflight", "bootstrap", "inspect", "start", "stop", "read-file", "write-file", "rollout-scan", "workspace", "tunnel"]);
const preflightSchema = z.object({
  uid: z.number().int().positive(),
  home: z.string().startsWith("/"),
  shell: z.string().regex(/^\/[A-Za-z0-9_./+-]+$/u),
  codexPath: z.string().regex(/^\/[A-Za-z0-9_./+-]+$/u),
  tmuxPath: z.string().regex(/^\/[A-Za-z0-9_./+-]+$/u),
}).strict();
const inspectSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("absent") }).strict(),
  z.object({ status: z.literal("unhealthy"), identity: z.unknown().optional(), ownedGroup: z.array(z.number().int().positive()).optional(), groupSize: z.number().int().nonnegative().optional() }).strict(),
  z.object({ status: z.literal("healthy"), identity: z.unknown() }).strict(),
]);

export interface RemoteAssets {
  helper: Buffer;
  launcher: Buffer;
}

export interface RemoteRuntimeClient {
  bootstrap(payload: RemoteBootstrapPayload): Promise<void>;
  invoke<T>(operation: string, args: readonly string[], installedHelperPath?: string): Promise<T>;
  closeControlMaster?(): Promise<void>;
}

export interface RemoteTransferClient {
  invokeTransfer<T>(
    operation: "read-file" | "write-file",
    args: readonly string[],
    options: { input?: AsyncIterable<Uint8Array | string>; maxOutputBytes: number; timeoutMs?: number },
    installedHelperPath: string,
  ): Promise<T>;
}

export interface RemoteBootstrapPayload {
  runtimeDir: string;
  helper: Buffer;
  launcher: Buffer;
}

export interface SshRuntimeController {
  readonly remoteSocketPath: string;
  ensureStarted(): Promise<RuntimeIdentity>;
  runtimeIdentity(): Promise<RuntimeIdentity | undefined>;
  classifyLoss?(): Promise<EndpointLossKind>;
  closeTransport?(): Promise<void>;
  stop(expectedIdentity?: RuntimeIdentity): Promise<void>;
}

export class SshRuntime implements SshRuntimeController {
  private prepared?: { runtimeDir: string; helperPath: string; session: string; shell: string; home: string };

  constructor(private readonly options: { endpointId: string; remote: RemoteRuntimeClient; assetRoot?: string }) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(options.endpointId)) throw new AppError("CONFIGURATION_ERROR", "invalid SSH endpoint ID");
  }

  get remoteSocketPath(): string {
    if (!this.prepared) throw new AppError("ENDPOINT_UNAVAILABLE", "SSH runtime is not prepared");
    return `${this.prepared.runtimeDir}/app-server.sock`;
  }
  get remoteHelperPath(): string {
    if (!this.prepared) throw new AppError("ENDPOINT_UNAVAILABLE", "SSH runtime is not prepared");
    return this.prepared.helperPath;
  }
  get remoteRuntimeDir(): string {
    if (!this.prepared) throw new AppError("ENDPOINT_UNAVAILABLE", "SSH runtime is not prepared");
    return this.prepared.runtimeDir;
  }
  get remoteHome(): string {
    if (!this.prepared) throw new AppError("ENDPOINT_UNAVAILABLE", "SSH runtime is not prepared");
    return this.prepared.home;
  }

  async ensureStarted(): Promise<RuntimeIdentity> {
    const prepared = await this.prepare();
    const current = await this.inspectPrepared(prepared);
    if (current.status === "healthy") return current.identity;
    if (current.status === "unhealthy") throw new AppError("ENDPOINT_UNAVAILABLE", `existing SSH runtime is unhealthy: ${this.options.endpointId}`);
    const result = await this.options.remote.invoke<{ identity: unknown }>("start", [JSON.stringify({
      runtimeDir: prepared.runtimeDir,
      session: prepared.session,
      shell: prepared.shell,
      token: randomBytes(16).toString("hex"),
    })], prepared.helperPath);
    return parseRuntimeIdentity(result.identity);
  }

  async runtimeIdentity(): Promise<RuntimeIdentity | undefined> {
    const prepared = await this.prepare();
    const current = await this.inspectPrepared(prepared);
    if (current.status === "healthy" || (current.status === "unhealthy" && current.identity)) return current.identity;
    if (current.status === "unhealthy") throw new AppError("OPERATION_UNCERTAIN", `SSH runtime identity is unavailable: ${this.options.endpointId}`);
    return undefined;
  }

  async classifyLoss(): Promise<EndpointLossKind> {
    const prepared = await this.prepare();
    return (await this.inspectPrepared(prepared)).status === "absent" ? "runtime-lost" : "connection-lost";
  }

  async stop(expectedIdentity?: RuntimeIdentity): Promise<void> {
    const prepared = await this.prepare();
    if (expectedIdentity?.kind !== "ssh") throw new AppError("OPERATION_CONFLICT", "exact SSH runtime identity is required for shutdown");
    try { await this.options.remote.invoke("stop", [JSON.stringify({ runtimeDir: prepared.runtimeDir, session: prepared.session, expected: expectedIdentity })], prepared.helperPath); }
    finally { await this.closeTransport(); }
  }

  async closeTransport(): Promise<void> { await this.options.remote.closeControlMaster?.(); }

  private async prepare(): Promise<NonNullable<SshRuntime["prepared"]>> {
    const preflight = preflightSchema.parse(await this.options.remote.invoke("preflight", []));
    const endpointHash = createHash("sha256").update(this.options.endpointId).digest("hex").slice(0, 24);
    const runtimeDir = `/tmp/qiyan-${preflight.uid}/${endpointHash}`;
    const prepared = {
      runtimeDir,
      helperPath: `${runtimeDir}/qiyan-ssh-helper.mjs`,
      session: `qiyan-${endpointHash}`,
      shell: preflight.shell,
      home: preflight.home,
    };
    const assets = await loadRemoteAssets(this.options.assetRoot);
    await this.options.remote.bootstrap({ runtimeDir, ...assets });
    this.prepared = prepared;
    return prepared;
  }

  private async inspectPrepared(prepared: NonNullable<SshRuntime["prepared"]>): Promise<
    { status: "absent" } | { status: "unhealthy"; identity?: RuntimeIdentity } | { status: "healthy"; identity: RuntimeIdentity }
  > {
    const parsed = inspectSchema.parse(await this.options.remote.invoke("inspect", [JSON.stringify({
      runtimeDir: prepared.runtimeDir, session: prepared.session,
    })], prepared.helperPath));
    if (parsed.status === "unhealthy") return { status: "unhealthy", ...(parsed.identity === undefined ? {} : { identity: parseRuntimeIdentity(parsed.identity) }) };
    if (parsed.status !== "healthy") return parsed;
    return { status: "healthy", identity: parseRuntimeIdentity(parsed.identity) };
  }
}

export class SshRemoteClient implements RemoteRuntimeClient {
  constructor(private readonly options: {
    plan: SshConnectionPlan;
    sshBinary?: string;
    helperSource: Buffer;
    run?: typeof runBoundedProcess;
  }) {}

  async bootstrap(payload: RemoteBootstrapPayload): Promise<void> {
    const value = JSON.stringify({
      runtimeDir: payload.runtimeDir,
      helperBase64: payload.helper.toString("base64url"),
      helperSha256: REMOTE_HELPER_SHA256,
      launcherBase64: payload.launcher.toString("base64url"),
      launcherSha256: REMOTE_LAUNCHER_SHA256,
    });
    await this.execute(["node", "-", "bootstrap", encodeRemoteBootstrapArgument(value)], this.options.helperSource);
  }

  async invoke<T>(operation: string, args: readonly string[], installedHelperPath?: string): Promise<T> {
    if (!helperOperations.has(operation)) throw new AppError("CONFIGURATION_ERROR", "unsupported SSH helper operation");
    const command = installedHelperPath
      ? buildInstalledHelperCommand(installedHelperPath, operation, args)
      : ["node", "-", operation, ...args.map(encodeRemoteArgument)];
    const result = await this.execute(command, installedHelperPath ? undefined : this.options.helperSource);
    try { return JSON.parse(result.stdout.toString("utf8")) as T; }
    catch { throw new AppError("ENDPOINT_UNAVAILABLE", "SSH helper returned an invalid response"); }
  }

  async invokeTransfer<T>(
    operation: "read-file" | "write-file",
    args: readonly string[],
    options: { input?: AsyncIterable<Uint8Array | string>; maxOutputBytes: number; timeoutMs?: number },
    installedHelperPath: string,
  ): Promise<T> {
    const command = buildInstalledHelperCommand(installedHelperPath, operation, args);
    const result = await this.executePrepared(command, options.input, options.maxOutputBytes, options.timeoutMs ?? 60_000);
    try { return JSON.parse(result.stdout.toString("utf8")) as T; }
    catch { throw new AppError("ENDPOINT_UNAVAILABLE", "SSH file helper returned an invalid response"); }
  }

  async closeControlMaster(): Promise<void> {
    if (!this.options.plan.ownsControlMaster) return;
    const run = this.options.run ?? runBoundedProcess;
    await run(this.options.sshBinary ?? "ssh", buildControlMasterExitArgs(this.options.plan), {
      timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
    }).catch(() => undefined);
  }

  private execute(command: readonly string[], input?: Buffer): Promise<BoundedProcessResult> {
    return this.executePrepared(command, input);
  }

  private async executePrepared(
    command: readonly string[],
    input?: Uint8Array | AsyncIterable<Uint8Array | string>,
    maxOutputBytes = 1024 * 1024,
    timeoutMs = 30_000,
  ): Promise<BoundedProcessResult> {
    if (this.options.plan.ownsControlMaster) {
      const directory = dirname(this.options.plan.controlPath!);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const state = await lstat(directory);
      const uid = process.getuid?.();
      if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077) !== 0 || (uid !== undefined && state.uid !== uid)) {
        throw new AppError("CONFIGURATION_ERROR", "unsafe SSH ControlMaster directory");
      }
    }
    const run = this.options.run ?? runBoundedProcess;
    return run(this.options.sshBinary ?? "ssh", buildSshRemoteArgs(this.options.plan, command), {
      timeoutMs,
      maxOutputBytes,
      ...(input ? { input } : {}),
    });
  }
}

export function encodeRemoteArgument(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_REMOTE_ARGUMENT_BYTES) throw new AppError("CONFIGURATION_ERROR", "remote argument is too large");
  return bytes.toString("base64url");
}

export function encodeRemoteBootstrapArgument(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) throw new AppError("CONFIGURATION_ERROR", "remote bootstrap argument is too large");
  return bytes.toString("base64url");
}

export function decodeRemoteArgument(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > Math.ceil(MAX_REMOTE_ARGUMENT_BYTES * 4 / 3)) {
    throw new AppError("CONFIGURATION_ERROR", "invalid remote argument");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_REMOTE_ARGUMENT_BYTES || bytes.toString("base64url") !== value) {
    throw new AppError("CONFIGURATION_ERROR", "invalid remote argument");
  }
  return bytes.toString("utf8");
}

export function buildInstalledHelperCommand(helperPath: string, operation: string, args: readonly string[]): string[] {
  if (!/^\/tmp\/qiyan-\d+\/[a-f0-9]{24}\/qiyan-ssh-helper\.mjs$/u.test(helperPath) || !helperOperations.has(operation)) {
    throw new AppError("CONFIGURATION_ERROR", "invalid installed SSH helper invocation");
  }
  return ["node", helperPath, operation, ...args.map(encodeRemoteArgument)];
}

async function loadRemoteAssets(root?: string): Promise<RemoteAssets> {
  const candidates = root ? [root] : [
    resolve(dirname(fileURLToPath(import.meta.url)), "../assets/remote"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../assets/remote"),
  ];
  for (const candidate of candidates) {
    try {
      const helper = await readFile(resolve(candidate, "qiyan-ssh-helper.mjs"));
      const launcher = await readFile(resolve(candidate, "qiyan-app-server-launcher.sh"));
      requireDigest(helper, REMOTE_HELPER_SHA256);
      requireDigest(launcher, REMOTE_LAUNCHER_SHA256);
      return { helper, launcher };
    } catch (error) {
      if (candidate === candidates.at(-1) || root) throw error;
    }
  }
  throw new AppError("CONFIGURATION_ERROR", "packaged SSH runtime assets are unavailable");
}

function requireDigest(bytes: Buffer, expected: string): void {
  if (createHash("sha256").update(bytes).digest("hex") !== expected) {
    throw new AppError("CONFIGURATION_ERROR", "packaged SSH runtime asset failed integrity verification");
  }
}
