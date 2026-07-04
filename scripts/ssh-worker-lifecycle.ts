import { createHash } from "node:crypto";
import {
  DEFAULT_CODEX_VERSION,
  DEFAULT_SSH_PORT,
  buildSshArgs,
  formatSshConfig,
  resolveFixturePaths,
  withFixtureStateTransaction,
  type CommandResult,
  type CommandRunner,
  type CommandRunnerOptions,
  type FixturePaths,
} from "./ssh-worker-support.ts";

const COMPOSE_TIMEOUT_MS = 10_000;
const COMPOSE_UP_TIMEOUT_MS = 120_000;
const SSH_READY_TIMEOUT_MS = 30_000;
const SSH_SCAN_TIMEOUT_MS = 2_000;
const SSH_PROOF_TIMEOUT_MS = 10_000;
const HOST_KEY_VALIDATION_TIMEOUT_MS = 10_000;
const CODEX_VERSION = /^\d+\.\d+\.\d+$/u;

export interface FixtureLifecycleOptions {
  runner: CommandRunner;
  env?: NodeJS.ProcessEnv;
  port?: number;
  codexVersion?: string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface FixtureResetOptions extends FixtureLifecycleOptions {
  confirmed: boolean;
}

export interface FixtureResetResult {
  reset: boolean;
  stateDirectoryRetained: true;
}

function validatePaths(paths: FixturePaths): void {
  const expected = resolveFixturePaths(paths.repositoryRoot);
  for (const key of Object.keys(expected) as Array<keyof FixturePaths>) {
    if (paths[key] !== expected[key]) throw new Error("fixture paths do not match the canonical repository root");
  }
}

export function deriveComposeProjectName(paths: FixturePaths): string {
  validatePaths(paths);
  const suffix = createHash("sha256").update(paths.repositoryRoot).digest("hex").slice(0, 12);
  return `qiyan-ssh-worker-${suffix}`;
}

export function composeArgs(paths: FixturePaths, args: readonly string[]): string[] {
  return [
    "compose",
    "--project-name",
    deriveComposeProjectName(paths),
    "--file",
    paths.composeFile,
    ...args,
  ];
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SSH port must be an integer from 1 through 65535");
  }
}

function validateCodexVersion(version: string): void {
  if (!CODEX_VERSION.test(version)) {
    throw new Error("Codex version must contain exactly three decimal components");
  }
}

function fixtureEnvironment(
  paths: FixturePaths,
  base: NodeJS.ProcessEnv,
  port: number,
  codexVersion: string,
): NodeJS.ProcessEnv {
  return {
    ...base,
    QIYAN_SSH_WORKER_PUBLIC_KEY: paths.publicKey,
    QIYAN_SSH_WORKER_PORT: String(port),
    QIYAN_SSH_WORKER_CODEX_VERSION: codexVersion,
  };
}

function commandSucceeded(result: CommandResult): boolean {
  return result.code === 0 && result.signal === null;
}

async function runStable(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  options: CommandRunnerOptions,
  failure: string,
): Promise<CommandResult> {
  let result: CommandResult;
  try {
    result = await runner(command, args, options);
  } catch {
    throw new Error(failure);
  }
  if (!commandSucceeded(result)) throw new Error(failure);
  return result;
}

function hasLikelyPortConflict(stderr: string): boolean {
  return /port is already allocated|address already in use|bind[^\n]*failed/iu.test(stderr);
}

function requireEffectiveSshdConfig(value: string): void {
  const lines = new Set(value.split(/\r?\n/u).map((line) => line.trim().toLowerCase()).filter(Boolean));
  const required = [
    "hostkey /var/lib/ssh-host-keys/ssh_host_ed25519_key",
    "authorizedkeysfile .ssh/authorized_keys",
    "pubkeyauthentication yes",
    "authenticationmethods publickey",
    "disableforwarding yes",
    "permitrootlogin no",
    "passwordauthentication no",
    "kbdinteractiveauthentication no",
    "permitemptypasswords no",
    "usepam no",
  ];
  if (required.some((line) => !lines.has(line))) {
    throw new Error("SSH daemon effective configuration mismatch");
  }
}

function parseHostKeyScan(value: string, port: number): { trusted: string; knownHosts: string } | undefined {
  const records = value.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (records.length === 0) return undefined;
  const unique = [...new Set(records)];
  if (unique.length !== 1) throw new Error("SSH host key scan returned an invalid result");
  const fields = unique[0]!.split(/[\t ]+/u);
  const expectedHost = `[127.0.0.1]:${port}`;
  if (fields.length !== 3 || fields[0] !== expectedHost || fields[1] !== "ssh-ed25519" || !fields[2]) {
    throw new Error("SSH host key scan returned an invalid result");
  }
  return {
    trusted: `ssh-ed25519 ${fields[2]}\n`,
    knownHosts: `${expectedHost} ssh-ed25519 ${fields[2]}\n`,
  };
}

function parseTrustedHostKey(value: string): string {
  const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (normalized.includes("\n") || normalized.includes("\r")) {
    throw new Error("trusted SSH host key is invalid");
  }
  const fields = normalized.trim().split(/[\t ]+/u);
  if (fields.length !== 2 || fields[0] !== "ssh-ed25519" || !fields[1]) {
    throw new Error("trusted SSH host key is invalid");
  }
  return `${fields[0]} ${fields[1]}\n`;
}

function composeExecSshdArgs(paths: FixturePaths): string[] {
  return composeArgs(paths, [
    "exec", "--no-TTY", "--user", "root", "ssh-worker",
    "/usr/sbin/sshd", "-T", "-f", "/etc/ssh/sshd_config",
    "-C", "user=codex,host=localhost,addr=127.0.0.1",
  ]);
}

function composeExecHostKeyAbsenceArgs(paths: FixturePaths): string[] {
  return composeArgs(paths, [
    "exec", "--no-TTY", "--user", "root", "ssh-worker",
    "find", "/etc/ssh", "-maxdepth", "1",
    "-name", "ssh_host_*", "-print", "-quit",
  ]);
}

async function scanHostKey(
  runner: CommandRunner,
  port: number,
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<{ trusted: string; knownHosts: string }> {
  const deadline = now() + SSH_READY_TIMEOUT_MS;
  while (now() < deadline) {
    let result: CommandResult | undefined;
    try {
      result = await runner(
        "ssh-keyscan",
        ["-T", "1", "-t", "ed25519", "-p", String(port), "127.0.0.1"],
        { timeoutMs: SSH_SCAN_TIMEOUT_MS },
      );
    } catch {
      // Readiness failures are retried until the fixed deadline.
    }
    if (result !== undefined && commandSucceeded(result)) {
      const parsed = parseHostKeyScan(result.stdout, port);
      if (parsed !== undefined) return parsed;
    }
    await sleep(Math.min(1_000, Math.max(0, deadline - now())));
  }
  throw new Error("SSH worker readiness timed out after 30 seconds");
}

function resolvedOptions(options: FixtureLifecycleOptions): {
  port: number;
  codexVersion: string;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
} {
  const port = options.port ?? DEFAULT_SSH_PORT;
  const codexVersion = options.codexVersion ?? DEFAULT_CODEX_VERSION;
  validatePort(port);
  validateCodexVersion(codexVersion);
  return {
    port,
    codexVersion,
    now: options.now ?? Date.now,
    sleep: options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
}

export async function upFixture(paths: FixturePaths, options: FixtureLifecycleOptions): Promise<void> {
  validatePaths(paths);
  const { port, codexVersion, now, sleep } = resolvedOptions(options);
  const env = fixtureEnvironment(paths, options.env ?? process.env, port, codexVersion);
  await runStable(
    options.runner,
    "docker",
    ["compose", "version"],
    { env, timeoutMs: COMPOSE_TIMEOUT_MS },
    "Docker Compose is not available",
  );
  await withFixtureStateTransaction(paths, async (transaction) => {
    await transaction.ensureClientKey(async (command, args, runnerOptions) => options.runner(command, args, {
      ...runnerOptions,
      timeoutMs: runnerOptions?.timeoutMs ?? HOST_KEY_VALIDATION_TIMEOUT_MS,
    }));
    let startup: CommandResult;
    try {
      startup = await options.runner(
        "docker",
        composeArgs(paths, ["up", "--detach", "--build"]),
        { env, timeoutMs: COMPOSE_UP_TIMEOUT_MS },
      );
    } catch {
      throw new Error("SSH worker image build or startup failed");
    }
    if (!commandSucceeded(startup)) {
      if (hasLikelyPortConflict(startup.stderr)) throw new Error("SSH worker port is already in use");
      throw new Error("SSH worker image build or startup failed");
    }

    const effective = await runStable(
      options.runner,
      "docker",
      composeExecSshdArgs(paths),
      { env, timeoutMs: COMPOSE_TIMEOUT_MS },
      "SSH daemon effective configuration check failed",
    );
    requireEffectiveSshdConfig(effective.stdout);
    const isolated = await runStable(
      options.runner,
      "docker",
      composeExecHostKeyAbsenceArgs(paths),
      { env, timeoutMs: COMPOSE_TIMEOUT_MS },
      "SSH daemon host-key isolation check failed",
    );
    if (isolated.stdout.trim()) throw new Error("SSH daemon host-key isolation check failed");

    const scanned = await scanHostKey(options.runner, port, now, sleep);
    await transaction.withOwnerOnlyTemporaryFile(scanned.knownHosts, async (candidatePath) => {
      await runStable(
        options.runner,
        "ssh-keygen",
        ["-lf", candidatePath, "-E", "sha256"],
        { timeoutMs: HOST_KEY_VALIDATION_TIMEOUT_MS },
        "SSH host key validation failed",
      );
    });

    const [trusted, knownHosts] = await Promise.all([
      transaction.readOwnerOnlyFile("trustedHostKey"),
      transaction.readOwnerOnlyFile("knownHosts"),
    ]);
    if (trusted === undefined && knownHosts !== undefined) {
      throw new Error("known_hosts exists without authoritative SSH host trust");
    }
    if (trusted === undefined) {
      await transaction.replaceOwnerOnlyFile("trustedHostKey", scanned.trusted);
    } else if (parseTrustedHostKey(trusted) !== scanned.trusted) {
      throw new Error("SSH host key changed");
    }
    if (knownHosts !== scanned.knownHosts) {
      await transaction.replaceOwnerOnlyFile("knownHosts", scanned.knownHosts);
    }
    await transaction.replaceOwnerOnlyFile("sshConfig", formatSshConfig(paths, port));

    await runStable(
      options.runner,
      "ssh",
      buildSshArgs(paths, ["true"]),
      { timeoutMs: SSH_PROOF_TIMEOUT_MS },
      "SSH client key was rejected",
    );
  });
}

export async function downFixture(paths: FixturePaths, options: FixtureLifecycleOptions): Promise<void> {
  validatePaths(paths);
  const { port, codexVersion } = resolvedOptions(options);
  const env = fixtureEnvironment(paths, options.env ?? process.env, port, codexVersion);
  await runStable(
    options.runner,
    "docker",
    composeArgs(paths, ["down"]),
    { env, timeoutMs: COMPOSE_TIMEOUT_MS },
    "SSH worker shutdown failed",
  );
}

export async function resetFixture(paths: FixturePaths, options: FixtureResetOptions): Promise<FixtureResetResult> {
  validatePaths(paths);
  const { port, codexVersion } = resolvedOptions(options);
  if (!options.confirmed) return { reset: false, stateDirectoryRetained: true };
  const env = fixtureEnvironment(paths, options.env ?? process.env, port, codexVersion);
  await withFixtureStateTransaction(paths, async (transaction) => {
    await transaction.preflightGeneratedStateRemoval();
    await transaction.beginReset();
    await runStable(
      options.runner,
      "docker",
      composeArgs(paths, ["down", "--volumes", "--remove-orphans"]),
      { env, timeoutMs: COMPOSE_UP_TIMEOUT_MS },
      "SSH worker reset failed",
    );
    await transaction.removeGeneratedState();
  });
  return { reset: true, stateDirectoryRetained: true };
}
