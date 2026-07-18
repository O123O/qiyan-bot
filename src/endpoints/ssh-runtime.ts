import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, statfs } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { AppError } from "../core/errors.ts";
import {
  buildControlMasterCheckArgs,
  buildControlMasterExitArgs,
  buildSshRemoteNodeProgramArgs,
  buildSshSessionProbeArgs,
  type SshConnectionPlan,
} from "./ssh-config.ts";
import {
  openReadyProcessStream,
  runBoundedProcess,
  type BoundedProcessResult,
  type ReadyProcessStream,
} from "./ssh-process.ts";
import { parseRuntimeIdentity, type EndpointLossKind, type RuntimeIdentity } from "./types.ts";

export const REMOTE_HELPER_SHA256 = "d9b4b40c9fb0deb2b2f8dfa95c1000ccb0a8cbc803e5d6189fdd5adf3700ef42";
export const REMOTE_LAUNCHER_SHA256 = "643dd9424f3d7fb5cca8d9f7cbd835fb40a57e8a7e728ed1529259e92fa793c5";
export const REMOTE_APP_SERVER_PROXY_READY = Buffer.from("qiyan-app-server-proxy-v1-ready\n");

const MAX_REMOTE_ARGUMENT_BYTES = 16 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES = 107;
const SAFE_REMOTE_PATH = /^\/[A-Za-z0-9_./+-]+$/u;
const REMOTE_HELPER_RESPONSE_PREFIX = "qiyan-helper-v1:";
const REMOTE_HELPER_TIMEOUT_MS = 300_000;
const helperOperations = new Set(["preflight", "bootstrap", "inspect", "start", "stop", "read-file", "write-file", "rollout-scan", "rollout-boundary", "claude-rollout-scan", "codex-history", "workspace"]);
const preflightSchema = z.object({
  uid: z.number().int().positive(),
  home: z.string().startsWith("/"),
  shell: z.string().regex(/^\/[A-Za-z0-9_./+-]+$/u),
  runtimeBase: z.string(),
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
  invoke<T>(operation: string, args: readonly string[], installedHelperPath?: string, options?: { signal?: AbortSignal }): Promise<T>;
  openAppServerStream?(request: RemoteAppServerProxyRequest, installedHelperPath: string): Promise<ReadyProcessStream>;
  closeControlMaster?(): Promise<void>;
}

export interface RemoteAppServerProxyRequest {
  runtimeDir: string;
  session: string;
  tmuxMode: "explicit" | "legacy";
  expected: RuntimeIdentity;
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

export async function attestUserControlMaster(
  plan: SshConnectionPlan,
  inspectFileSystem: (path: string) => Promise<{ type: number | bigint }> = statfs,
): Promise<void> {
  if (plan.ownsControlMaster) return;
  const controlPath = plan.controlPath;
  const uid = process.getuid?.();
  let parent: string;
  try {
    if (!controlPath || resolve(controlPath) !== controlPath) throw new Error("invalid path");
    parent = dirname(controlPath);
    if (await realpath(parent) !== parent) throw new Error("aliased parent");
    const [directory] = await Promise.all([
      lstat(parent),
      inspectFileSystem(parent),
    ]);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0
      || (uid !== undefined && directory.uid !== uid)) {
      throw new Error("unsafe identity");
    }
  } catch {
    throw new AppError("CONFIGURATION_ERROR", "unsafe user-owned SSH ControlMaster; use a private filesystem");
  }
  let socket;
  try { socket = await lstat(controlPath!); }
  catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw new AppError("CONFIGURATION_ERROR", "unsafe user-owned SSH ControlMaster; use a private filesystem");
  }
  if (!socket.isSocket() || socket.isSymbolicLink() || (socket.mode & 0o077) !== 0
    || (uid !== undefined && socket.uid !== uid)) {
    throw new AppError("CONFIGURATION_ERROR", "unsafe user-owned SSH ControlMaster; use a private filesystem");
  }
}

export interface SshRuntimeController {
  ensureStarted(): Promise<RuntimeIdentity>;
  openAppServerStream(expected: RuntimeIdentity): Promise<ReadyProcessStream>;
  runtimeIdentity(): Promise<RuntimeIdentity | undefined>;
  classifyLoss?(): Promise<EndpointLossKind>;
  closeTransport?(): Promise<void>;
  stop(expectedIdentity: RuntimeIdentity): Promise<void>;
}

// The provider-neutral host facts a remote endpoint's consumers need (workspace router,
// worker file bridge, ownership scan). A Codex remote satisfies this via SshRuntime; a
// Claude remote (no app-server) builds a lean one over the same bootstrapped helper.
export interface RemoteHost {
  readonly remoteUid: number;
  readonly remoteHome: string;
  readonly remoteRuntimeDir: string;
  readonly remoteHelperPath: string;
  readonly remote: RemoteRuntimeClient;
}

// Runs the provider-neutral host bootstrap (preflight → install helper) and returns the
// derived host facts. Both SshRuntime (Codex) and the remote Claude endpoint use this so
// the helper lands at the SAME uid-scoped path on both providers — ownership scans and
// workspace ops resolve the identical `qiyan-ssh-helper.mjs`.
export async function prepareRemoteHost(options: {
  endpointId: string;
  remote: RemoteRuntimeClient;
  assetRoot?: string;
}): Promise<RemoteHost & { shell: string }> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(options.endpointId)) throw new AppError("CONFIGURATION_ERROR", "invalid SSH endpoint ID");
  const preflight = preflightSchema.parse(await options.remote.invoke("preflight", []));
  const endpointHash = createHash("sha256").update(options.endpointId).digest("hex").slice(0, 24);
  const runtimeBase = validateRemoteRuntimeBase(preflight.runtimeBase, preflight.uid, endpointHash);
  const remoteRuntimeDir = posix.join(runtimeBase, endpointHash);
  const assets = await loadRemoteAssets(options.assetRoot);
  await options.remote.bootstrap({ runtimeDir: remoteRuntimeDir, ...assets });
  return {
    remoteUid: preflight.uid,
    remoteHome: preflight.home,
    remoteRuntimeDir,
    remoteHelperPath: `${remoteRuntimeDir}/qiyan-ssh-helper.mjs`,
    remote: options.remote,
    shell: preflight.shell,
  };
}

export class SshRuntime implements SshRuntimeController, RemoteHost {
  private prepared?: {
    host: RemoteHost;
    runtimeDir: string;
    session: string;
    shell: string;
    tmuxMode: "explicit" | "legacy";
  };

  constructor(private readonly options: { endpointId: string; remote: RemoteRuntimeClient; assetRoot?: string }) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(options.endpointId)) throw new AppError("CONFIGURATION_ERROR", "invalid SSH endpoint ID");
  }

  get remoteHelperPath(): string {
    if (!this.prepared) throw new AppError("ENDPOINT_UNAVAILABLE", "SSH runtime is not prepared");
    return this.prepared.host.remoteHelperPath;
  }
  get remoteRuntimeDir(): string {
    if (!this.prepared) throw new AppError("ENDPOINT_UNAVAILABLE", "SSH runtime is not prepared");
    return this.prepared.host.remoteRuntimeDir;
  }
  get remoteHome(): string {
    if (!this.prepared) throw new AppError("ENDPOINT_UNAVAILABLE", "SSH runtime is not prepared");
    return this.prepared.host.remoteHome;
  }
  get remoteUid(): number {
    if (!this.prepared) throw new AppError("ENDPOINT_UNAVAILABLE", "SSH runtime is not prepared");
    return this.prepared.host.remoteUid;
  }
  get remote(): RemoteRuntimeClient { return this.options.remote; }

  async ensureStarted(): Promise<RuntimeIdentity> {
    const prepared = await this.prepare();
    const current = await this.inspectPrepared(prepared);
    if (current.status === "healthy") return current.identity;
    if (current.status === "unhealthy") throw new AppError("ENDPOINT_UNAVAILABLE", `existing SSH runtime is unhealthy: ${this.options.endpointId}`);
    if (prepared.tmuxMode === "legacy") {
      delete this.prepared;
      return this.ensureStarted();
    }
    const result = await this.options.remote.invoke<{ identity: unknown }>("start", [JSON.stringify({
      runtimeDir: prepared.runtimeDir,
      session: prepared.session,
      shell: prepared.shell,
      tmuxMode: prepared.tmuxMode,
      token: randomBytes(16).toString("hex"),
    })], prepared.host.remoteHelperPath);
    return parseRuntimeIdentity(result.identity);
  }

  async runtimeIdentity(): Promise<RuntimeIdentity | undefined> {
    const prepared = await this.prepare();
    const current = await this.inspectPrepared(prepared);
    if (current.status === "healthy" || (current.status === "unhealthy" && current.identity)) return current.identity;
    if (current.status === "unhealthy") throw new AppError("OPERATION_UNCERTAIN", `SSH runtime identity is unavailable: ${this.options.endpointId}`);
    return undefined;
  }

  async openAppServerStream(expected: RuntimeIdentity): Promise<ReadyProcessStream> {
    const prepared = await this.prepare();
    if (expected.kind !== "ssh" || !this.options.remote.openAppServerStream) {
      throw new AppError("CONFIGURATION_ERROR", "SSH App Server proxy is unavailable");
    }
    return this.options.remote.openAppServerStream({
      runtimeDir: prepared.runtimeDir,
      session: prepared.session,
      tmuxMode: prepared.tmuxMode,
      expected,
    }, prepared.host.remoteHelperPath);
  }

  async classifyLoss(): Promise<EndpointLossKind> {
    const prepared = await this.prepare();
    return (await this.inspectPrepared(prepared)).status === "absent" ? "runtime-lost" : "connection-lost";
  }

  async stop(expectedIdentity: RuntimeIdentity): Promise<void> {
    const prepared = await this.prepare();
    if (expectedIdentity?.kind !== "ssh") throw new AppError("OPERATION_CONFLICT", "exact SSH runtime identity is required for shutdown");
    try {
      await this.options.remote.invoke("stop", [JSON.stringify({
        runtimeDir: prepared.runtimeDir,
        session: prepared.session,
        tmuxMode: prepared.tmuxMode,
        expected: expectedIdentity,
      })], prepared.host.remoteHelperPath);
      if (prepared.tmuxMode === "legacy") delete this.prepared;
    }
    finally { await this.closeTransport(); }
  }

  async closeTransport(): Promise<void> { await this.options.remote.closeControlMaster?.(); }

  private async prepare(): Promise<NonNullable<SshRuntime["prepared"]>> {
    if (this.prepared) return this.prepared;
    const host = await prepareRemoteHost({ endpointId: this.options.endpointId, remote: this.options.remote, ...(this.options.assetRoot ? { assetRoot: this.options.assetRoot } : {}) });
    const endpointHash = createHash("sha256").update(this.options.endpointId).digest("hex").slice(0, 24);
    const shared = {
      host,
      runtimeDir: host.remoteRuntimeDir,
      session: `qiyan-${endpointHash}`,
      shell: host.shell,
      tmuxMode: "explicit" as const,
    };
    const legacy = {
      ...shared,
      runtimeDir: `/tmp/qiyan-${host.remoteUid}/${endpointHash}`,
      tmuxMode: "legacy" as const,
    };
    const sharedState = await this.inspectPrepared(shared);
    if (shared.runtimeDir !== legacy.runtimeDir && sharedState.status !== "absent") return (this.prepared = shared);
    const legacyState = await this.inspectPrepared(legacy);
    if (shared.runtimeDir === legacy.runtimeDir) {
      if (sharedState.status === "healthy") return (this.prepared = shared);
      if (legacyState.status === "healthy") return (this.prepared = legacy);
      if (sharedState.status === "unhealthy") return (this.prepared = shared);
      if (legacyState.status === "unhealthy") return (this.prepared = legacy);
    }
    return (this.prepared = legacyState.status === "absent" ? shared : legacy);
  }

  private async inspectPrepared(prepared: NonNullable<SshRuntime["prepared"]>): Promise<
    { status: "absent" } | { status: "unhealthy"; identity?: RuntimeIdentity } | { status: "healthy"; identity: RuntimeIdentity }
  > {
    const parsed = inspectSchema.parse(await this.options.remote.invoke("inspect", [JSON.stringify({
      runtimeDir: prepared.runtimeDir, session: prepared.session, tmuxMode: prepared.tmuxMode,
    })], prepared.host.remoteHelperPath));
    if (parsed.status === "unhealthy") return { status: "unhealthy", ...(parsed.identity === undefined ? {} : { identity: parseRuntimeIdentity(parsed.identity) }) };
    if (parsed.status !== "healthy") return parsed;
    return { status: "healthy", identity: parseRuntimeIdentity(parsed.identity) };
  }
}

export class SshRemoteClient implements RemoteRuntimeClient {
  private readonly helperProgram: string;

  constructor(private readonly options: {
    plan: SshConnectionPlan;
    sshBinary?: string;
    helperSource: Buffer;
    run?: typeof runBoundedProcess;
    openStream?: typeof openReadyProcessStream;
  }) {
    requireDigest(options.helperSource, REMOTE_HELPER_SHA256);
    this.helperProgram = gzipSync(options.helperSource).toString("base64url");
  }

  async bootstrap(payload: RemoteBootstrapPayload): Promise<void> {
    const value = JSON.stringify({
      runtimeDir: payload.runtimeDir,
      helperBase64: payload.helper.toString("base64url"),
      helperSha256: REMOTE_HELPER_SHA256,
      launcherBase64: payload.launcher.toString("base64url"),
      launcherSha256: REMOTE_LAUNCHER_SHA256,
    });
    // Keep the large asset payload off argv: the pinned helper program itself is already carried
    // there, and their combined size can exceed the host's execve limit.
    await this.executeHelper("bootstrap", [], Buffer.from(value, "utf8"));
  }

  async invoke<T>(operation: string, args: readonly string[], installedHelperPath?: string, options?: { signal?: AbortSignal }): Promise<T> {
    if (!helperOperations.has(operation)) throw new AppError("CONFIGURATION_ERROR", "unsupported SSH helper operation");
    if (installedHelperPath) validateInstalledHelperPath(installedHelperPath);
    const result = await this.executeHelper(operation, args.map(encodeRemoteArgument), undefined, 1024 * 1024, REMOTE_HELPER_TIMEOUT_MS, options?.signal);
    return parseRemoteHelperResponse<T>(result.stdout, operation);
  }

  async invokeTransfer<T>(
    operation: "read-file" | "write-file",
    args: readonly string[],
    options: { input?: AsyncIterable<Uint8Array | string>; maxOutputBytes: number; timeoutMs?: number },
    installedHelperPath: string,
  ): Promise<T> {
    validateInstalledHelperPath(installedHelperPath);
    const result = await this.executeHelper(
      operation,
      args.map(encodeRemoteArgument),
      options.input,
      options.maxOutputBytes,
      options.timeoutMs ?? REMOTE_HELPER_TIMEOUT_MS,
    );
    return parseRemoteHelperResponse<T>(result.stdout, operation);
  }

  async openAppServerStream(
    request: RemoteAppServerProxyRequest,
    installedHelperPath: string,
  ): Promise<ReadyProcessStream> {
    validateInstalledHelperPath(installedHelperPath);
    parseRuntimeIdentity(request.expected);
    await this.prepareConnection();
    const args = buildSshRemoteNodeProgramArgs(
      this.options.plan,
      this.helperProgram,
      ["proxy-app-server", encodeRemoteArgument(JSON.stringify(request))],
    );
    try {
      return await (this.options.openStream ?? openReadyProcessStream)(this.options.sshBinary ?? "ssh", args, {
        readyMarker: REMOTE_APP_SERVER_PROXY_READY,
        timeoutMs: 10_000,
        maxPreludeBytes: 64 * 1024,
      });
    } catch (error) {
      return this.throwFreshChannelFailure(error);
    }
  }

  async closeControlMaster(): Promise<void> {
    if (!this.options.plan.ownsControlMaster) return;
    const run = this.options.run ?? runBoundedProcess;
    await run(this.options.sshBinary ?? "ssh", buildControlMasterExitArgs(this.options.plan), {
      timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
    }).catch(() => undefined);
  }

  private async executeHelper(
    operation: string,
    encodedArgs: readonly string[],
    input?: Uint8Array | AsyncIterable<Uint8Array | string>,
    maxOutputBytes = 1024 * 1024,
    timeoutMs = REMOTE_HELPER_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<BoundedProcessResult> {
    await this.prepareConnection();
    const run = this.options.run ?? runBoundedProcess;
    const args = buildSshRemoteNodeProgramArgs(
      this.options.plan,
      this.helperProgram,
      [operation, ...encodedArgs],
    );
    try {
      return await run(this.options.sshBinary ?? "ssh", args, {
        timeoutMs,
        maxOutputBytes,
        ...(input ? { input } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      return this.throwFreshChannelFailure(error);
    }
  }

  private async throwFreshChannelFailure(error: unknown): Promise<never> {
    if (this.options.plan.ownsControlMaster || !isProcessExit(error, 255)) throw error;
    const run = this.options.run ?? runBoundedProcess;
    const command = this.options.sshBinary ?? "ssh";
    try {
      await attestUserControlMaster(this.options.plan);
      await run(command, buildControlMasterCheckArgs(this.options.plan), {
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
      });
    } catch {
      throw error;
    }
    try {
      await run(command, buildSshSessionProbeArgs(this.options.plan), {
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
      });
    } catch (probeError) {
      if (isProcessExit(probeError, 255)) {
        throw new AppError("ENDPOINT_UNAVAILABLE", "SSH ControlMaster cannot open a fresh remote session", {
          recovery: "ssh_fresh_channel_unavailable",
          sshHost: this.options.plan.alias,
          exitCode: 255,
        });
      }
    }
    throw error;
  }

  private async prepareConnection(): Promise<void> {
    if (this.options.plan.ownsControlMaster) {
      const directory = dirname(this.options.plan.controlPath!);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const state = await lstat(directory);
      const uid = process.getuid?.();
      if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077) !== 0 || (uid !== undefined && state.uid !== uid)) {
        throw new AppError("CONFIGURATION_ERROR", "unsafe SSH ControlMaster directory");
      }
    }
    if (!this.options.plan.ownsControlMaster) await attestUserControlMaster(this.options.plan);
  }
}

export function encodeRemoteArgument(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_REMOTE_ARGUMENT_BYTES) throw new AppError("CONFIGURATION_ERROR", "remote argument is too large");
  return bytes.toString("base64url");
}

export function encodeRemoteBootstrapArgument(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > 96 * 1024) throw new AppError("CONFIGURATION_ERROR", "remote bootstrap argument is too large");
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

export function parseRemoteHelperResponse<T = unknown>(stdout: Buffer, operation: string): T {
  const frames = stdout.toString("utf8").split(/\r?\n/u)
    .filter((line) => line.startsWith(REMOTE_HELPER_RESPONSE_PREFIX));
  if (frames.length !== 1) throw invalidHelperResponse(operation);
  const body = frames[0]!.slice(REMOTE_HELPER_RESPONSE_PREFIX.length);
  try { return JSON.parse(body) as T; }
  catch { throw invalidHelperResponse(operation); }
}

export function validateInstalledHelperPath(helperPath: string): void {
  const parent = posix.dirname(helperPath);
  if (!SAFE_REMOTE_PATH.test(helperPath)
    || !posix.isAbsolute(helperPath)
    || posix.normalize(helperPath) !== helperPath
    || posix.basename(helperPath) !== "qiyan-ssh-helper.mjs"
    || !/^[a-f0-9]{24}$/u.test(posix.basename(parent))) {
    throw new AppError("CONFIGURATION_ERROR", "invalid installed SSH helper path");
  }
}

function validateRemoteRuntimeBase(value: string, uid: number, endpointHash: string): string {
  const fallback = `/tmp/qiyan-${uid}`;
  const shared = value.endsWith("/qiyan-bot") && value.length > "/qiyan-bot".length;
  const socketPath = posix.join(value, endpointHash, "app-server.sock");
  if (!SAFE_REMOTE_PATH.test(value)
    || !posix.isAbsolute(value)
    || posix.normalize(value) !== value
    || (value !== fallback && !shared)
    || Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new AppError("CONFIGURATION_ERROR", "remote preflight returned an invalid runtime base");
  }
  return value;
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

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isProcessExit(error: unknown, exitCode: number): boolean {
  return error instanceof AppError
    && error.code === "ENDPOINT_UNAVAILABLE"
    && error.details?.exitCode === exitCode;
}

function invalidHelperResponse(operation: string): AppError {
  const label = helperOperations.has(operation) ? operation : "remote";
  return new AppError("ENDPOINT_UNAVAILABLE", `SSH ${label} helper returned an invalid response`);
}
