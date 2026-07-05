import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AppError } from "../core/errors.ts";
import { buildSshRemoteArgs, type SshConnectionPlan } from "./ssh-config.ts";
import { runBoundedProcess, type BoundedProcessResult } from "./ssh-process.ts";
import { parseRuntimeIdentity, type EndpointLossKind, type RuntimeIdentity } from "./types.ts";

export const REMOTE_HELPER_SHA256 = "56b02c7b807ab9ad4f4ee89e4d44ebbb0a2783a1c8274fdbe207ab75edc5c7e7";
export const REMOTE_LAUNCHER_SHA256 = "051e003f215d28cad899d8ab27777a04c627f825a385b32383d47f35037dc630";

const MAX_REMOTE_ARGUMENT_BYTES = 16 * 1024;
const helperOperations = new Set(["preflight", "bootstrap", "inspect", "start", "stop"]);
const preflightSchema = z.object({
  uid: z.number().int().positive(),
  home: z.string().startsWith("/"),
  shell: z.string().regex(/^\/[A-Za-z0-9_./+-]+$/u),
  codexPath: z.string().regex(/^\/[A-Za-z0-9_./+-]+$/u),
  tmuxPath: z.string().regex(/^\/[A-Za-z0-9_./+-]+$/u),
}).strict();
const inspectSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("absent") }).strict(),
  z.object({ status: z.literal("unhealthy") }).strict(),
  z.object({ status: z.literal("healthy"), identity: z.unknown() }).strict(),
]);

export interface RemoteAssets {
  helper: Buffer;
  launcher: Buffer;
}

export interface RemoteRuntimeClient {
  bootstrap(payload: RemoteBootstrapPayload): Promise<void>;
  invoke<T>(operation: string, args: readonly string[], installedHelperPath?: string): Promise<T>;
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
  stop(): Promise<void>;
}

export class SshRuntime implements SshRuntimeController {
  private prepared?: { runtimeDir: string; helperPath: string; session: string; shell: string };

  constructor(private readonly options: { endpointId: string; remote: RemoteRuntimeClient; assetRoot?: string }) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(options.endpointId)) throw new AppError("CONFIGURATION_ERROR", "invalid SSH endpoint ID");
  }

  get remoteSocketPath(): string {
    if (!this.prepared) throw new AppError("ENDPOINT_UNAVAILABLE", "SSH runtime is not prepared");
    return `${this.prepared.runtimeDir}/app-server.sock`;
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
    return current.status === "healthy" ? current.identity : undefined;
  }

  async classifyLoss(): Promise<EndpointLossKind> {
    const prepared = await this.prepare();
    return (await this.inspectPrepared(prepared)).status === "absent" ? "runtime-lost" : "connection-lost";
  }

  async stop(): Promise<void> {
    const prepared = await this.prepare();
    await this.options.remote.invoke("stop", [JSON.stringify({ runtimeDir: prepared.runtimeDir, session: prepared.session })], prepared.helperPath);
  }

  private async prepare(): Promise<NonNullable<SshRuntime["prepared"]>> {
    const preflight = preflightSchema.parse(await this.options.remote.invoke("preflight", []));
    const endpointHash = createHash("sha256").update(this.options.endpointId).digest("hex").slice(0, 24);
    const runtimeDir = `/tmp/qiyan-${preflight.uid}/${endpointHash}`;
    const prepared = {
      runtimeDir,
      helperPath: `${runtimeDir}/qiyan-ssh-helper.mjs`,
      session: `qiyan-${endpointHash}`,
      shell: preflight.shell,
    };
    const assets = await loadRemoteAssets(this.options.assetRoot);
    await this.options.remote.bootstrap({ runtimeDir, ...assets });
    this.prepared = prepared;
    return prepared;
  }

  private async inspectPrepared(prepared: NonNullable<SshRuntime["prepared"]>): Promise<
    { status: "absent" | "unhealthy" } | { status: "healthy"; identity: RuntimeIdentity }
  > {
    const parsed = inspectSchema.parse(await this.options.remote.invoke("inspect", [JSON.stringify({
      runtimeDir: prepared.runtimeDir, session: prepared.session,
    })], prepared.helperPath));
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
    await this.execute(["node", "-", "bootstrap", encodeRemoteArgument(value)], this.options.helperSource);
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

  private execute(command: readonly string[], input?: Buffer): Promise<BoundedProcessResult> {
    const run = this.options.run ?? runBoundedProcess;
    return run(this.options.sshBinary ?? "ssh", buildSshRemoteArgs(this.options.plan, command), {
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
      ...(input ? { input } : {}),
    });
  }
}

export function encodeRemoteArgument(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_REMOTE_ARGUMENT_BYTES) throw new AppError("CONFIGURATION_ERROR", "remote argument is too large");
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
