import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ServiceAction } from "../cli.ts";
import { SERVICE_UNSET_ENV_NAMES } from "../config-source.ts";
import { AppError } from "../core/errors.ts";

export const SYSTEMD_UNIT_NAME = "qiyan-bot.service";
export const MANAGED_UNIT_MARKER = "# Managed by qiyan-bot; use `qiyan-bot service uninstall` to remove.";
const MAX_UNIT_BYTES = 64 * 1024;
const MAX_CAPTURED_PATH_BYTES = 32 * 1024;
const MAX_SYSTEMCTL_OUTPUT_BYTES = 4 * 1024;
const MAX_JOURNAL_OUTPUT_BYTES = 64 * 1024;

export interface SystemdOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
}

export type SystemdRunner = (args: readonly string[]) => Promise<SystemdOutcome>;

export interface SystemdUnitStore {
  withOperationLease<T>(operation: () => Promise<T>): Promise<T>;
  install(path: string, contents: string): Promise<void>;
  verifyManaged(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
}

export function buildServiceEffectiveEnvironment(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...host };
  for (const key of SERVICE_UNSET_ENV_NAMES) delete result[key];
  return result;
}

export function renderSystemdUserUnit(input: { nodeExecutable: string; executable: string; qiyanHome: string; path: string }): string {
  const nodeExecutable = systemdPath(input.nodeExecutable, "Node executable");
  const executable = systemdPath(input.executable, "service executable");
  const qiyanHome = systemdPath(input.qiyanHome, "QiYan home");
  const workingDirectory = systemdWorkingDirectory(input.qiyanHome, "QiYan home");
  const path = systemdSearchPath(input.path);
  const unset = [...SERVICE_UNSET_ENV_NAMES].join(" ");
  const unit = `${MANAGED_UNIT_MARKER}
[Unit]
Description=QiYan personal assistant
Documentation=https://github.com/O123O/qiyan-bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${workingDirectory}
Environment=${path}
ExecStart=${nodeExecutable} ${executable} --home ${qiyanHome}
UnsetEnvironment=${unset}
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
UMask=0077

[Install]
WantedBy=default.target
`;
  if (Buffer.byteLength(unit, "utf8") > MAX_UNIT_BYTES) throw configuration("generated systemd unit is too large");
  return unit;
}

export class SystemdUserService {
  readonly unitPath: string;
  private readonly runner: SystemdRunner;
  private readonly unitStore: SystemdUnitStore;

  constructor(private readonly options: {
    userHome: string;
    nodeExecutable: string;
    executable: string;
    runner?: SystemdRunner;
    journalRunner?: SystemdRunner;
    unitStore?: SystemdUnitStore;
    env?: NodeJS.ProcessEnv;
    expectedUid?: number;
  }) {
    const defaultConfigHome = join(options.userHome, ".config");
    const configuredHome = options.env?.XDG_CONFIG_HOME;
    if (configuredHome && resolve(configuredHome) !== defaultConfigHome) {
      throw configuration("custom XDG_CONFIG_HOME is not supported for service management");
    }
    this.unitPath = join(defaultConfigHome, "systemd", "user", SYSTEMD_UNIT_NAME);
    this.runner = options.runner ?? ((args) => runSystemctl(args, options.env ?? process.env));
    this.journalRunner = options.journalRunner ?? ((args) => runJournalctl(args, options.env ?? process.env));
    this.unitStore = options.unitStore ?? new NodeSystemdUnitStore(options.userHome, options.expectedUid ?? process.getuid?.());
  }

  private readonly journalRunner: SystemdRunner;

  async execute(action: ServiceAction, input: { qiyanHome?: string } = {}): Promise<string> {
    if (action === "status" || action === "logs") return this.executeLocked(action, input);
    if (action === "install") {
      const unit = this.renderInstallUnit(input.qiyanHome);
      return this.unitStore.withOperationLease(() => this.executeLocked(action, input, unit));
    }
    return this.unitStore.withOperationLease(() => this.executeLocked(action, input));
  }

  validateInstallEnvironment(): void {
    systemdSearchPath(this.capturedPath());
  }

  private renderInstallUnit(qiyanHome: string | undefined): string {
    if (!qiyanHome) throw configuration("service install requires a QiYan home");
    return renderSystemdUserUnit({
      nodeExecutable: this.options.nodeExecutable,
      executable: this.options.executable,
      qiyanHome,
      path: this.capturedPath(),
    });
  }

  private capturedPath(): string {
    return (this.options.env ?? process.env).PATH ?? "";
  }

  private async executeLocked(action: ServiceAction, input: { qiyanHome?: string }, installUnit?: string): Promise<string> {
    switch (action) {
      case "install": {
        if (installUnit === undefined) throw configuration("service install was not prepared");
        await this.unitStore.install(this.unitPath, installUnit);
        await this.required(["daemon-reload"]);
        await this.required(["enable", SYSTEMD_UNIT_NAME]);
        await this.required(["restart", SYSTEMD_UNIT_NAME]);
        return `Installed and started ${SYSTEMD_UNIT_NAME}.\n`;
      }
      case "start":
        await this.required(["start", SYSTEMD_UNIT_NAME]);
        return `Started ${SYSTEMD_UNIT_NAME}.\n`;
      case "stop":
        await this.required(["stop", SYSTEMD_UNIT_NAME]);
        return `Stopped ${SYSTEMD_UNIT_NAME}.\n`;
      case "restart":
        await this.required(["restart", SYSTEMD_UNIT_NAME]);
        return `Restarted ${SYSTEMD_UNIT_NAME}.\n`;
      case "status": {
        const active = await this.probe(["is-active", SYSTEMD_UNIT_NAME], activeStates);
        const enabled = await this.probe(["is-enabled", SYSTEMD_UNIT_NAME], enabledStates);
        return `${SYSTEMD_UNIT_NAME} is ${active} and ${enabled}.\nRecent logs: qiyan-bot service logs\n`;
      }
      case "logs": return this.logs();
      case "uninstall": {
        const managed = await this.unitStore.verifyManaged(this.unitPath);
        if (!managed) {
          await this.required(["daemon-reload"]);
          return `${SYSTEMD_UNIT_NAME} is not installed.\n`;
        }
        await this.required(["disable", "--now", SYSTEMD_UNIT_NAME]);
        await this.unitStore.remove(this.unitPath);
        await this.required(["daemon-reload"]);
        return `Stopped and removed ${SYSTEMD_UNIT_NAME}.\n`;
      }
    }
  }

  private async logs(): Promise<string> {
    const args = ["--user", "--unit", SYSTEMD_UNIT_NAME, "--lines", "100", "--no-pager", "--output", "short-iso"];
    let outcome: SystemdOutcome;
    try { outcome = await this.journalRunner(args); }
    catch { throw configuration("journalctl could not start"); }
    if (outcome.signal !== null) throw configuration(`journalctl exited from signal ${outcome.signal}`);
    if (outcome.code !== 0) throw configuration(`journalctl failed with status ${String(outcome.code)}`);
    return outcome.stdout;
  }

  private async required(args: readonly string[]): Promise<void> {
    const outcome = await this.invoke(args);
    if (outcome.signal !== null) throw configuration(`systemctl --user ${args.join(" ")} exited from signal ${outcome.signal}`);
    if (outcome.code !== 0) throw configuration(`systemctl --user ${args.join(" ")} failed with status ${String(outcome.code)}`);
  }

  private async probe(args: readonly string[], allowed: ReadonlySet<string>): Promise<string> {
    const outcome = await this.invoke(args);
    if (outcome.signal !== null) throw configuration(`systemctl --user ${args.join(" ")} exited from signal ${outcome.signal}`);
    const value = outcome.stdout.trim();
    if (allowed.has(value)) return value;
    if (outcome.code !== 0) throw configuration(`systemctl --user ${args.join(" ")} failed with status ${String(outcome.code)}`);
    return "unknown";
  }

  private async invoke(args: readonly string[]): Promise<SystemdOutcome> {
    try { return await this.runner(args); }
    catch { throw configuration(`systemctl --user ${args.join(" ")} could not start`); }
  }
}

const activeStates = new Set([
  "active", "reloading", "inactive", "failed", "activating", "deactivating", "maintenance", "refreshing", "unknown",
]);
const enabledStates = new Set([
  "enabled", "enabled-runtime", "linked", "linked-runtime", "alias", "masked", "masked-runtime", "static", "indirect",
  "disabled", "generated", "transient", "bad", "not-found", "unknown",
]);

export class NodeSystemdUnitStore implements SystemdUnitStore {
  private readonly unitDirectory: string;
  private readonly lockPath: string;

  constructor(
    private readonly userHome: string,
    private readonly expectedUid?: number,
    private readonly hooks: { beforePublish?: () => Promise<void>; beforeRemove?: () => Promise<void> } = {},
  ) {
    this.unitDirectory = join(userHome, ".config", "systemd", "user");
    this.lockPath = join(this.unitDirectory, ".qiyan-bot.service.lock");
  }

  async withOperationLease<T>(operation: () => Promise<T>): Promise<T> {
    await this.prepareDirectory(true);
    let lease: FileHandle | undefined;
    try {
      lease = await open(this.lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await lease.chmod(0o600);
      await lease.writeFile(`${JSON.stringify({ pid: process.pid, nonce: randomUUID() })}\n`, "utf8");
      await lease.sync();
    } catch (error) {
      await lease?.close().catch(() => undefined);
      if (isErrno(error, "EEXIST") || isErrno(error, "ELOOP")) {
        throw configuration("another qiyan-bot service operation is already in progress; remove a stale .qiyan-bot.service.lock only after verifying no operation is running");
      }
      throw configuration("cannot acquire the qiyan-bot service operation lock");
    }
    const identity = await fileIdentity(lease);
    try {
      return await operation();
    } finally {
      try {
        const current = await pathIdentity(this.lockPath);
        if (!sameIdentity(identity, current)) throw configuration("qiyan-bot service operation lock changed unexpectedly");
        await unlink(this.lockPath);
        await this.syncDirectory();
      } finally {
        await lease.close().catch(() => undefined);
      }
    }
  }

  async install(path: string, contents: string): Promise<void> {
    if (Buffer.byteLength(contents, "utf8") > MAX_UNIT_BYTES) throw configuration(`${SYSTEMD_UNIT_NAME} is too large`);
    this.assertPath(path);
    await this.prepareDirectory(true);
    const existing = await this.readUnit(path, true);
    if (existing?.contents === contents) return;
    if (existing !== undefined && !existing.contents.startsWith(`${MANAGED_UNIT_MARKER}\n`)) {
      throw configuration(`${SYSTEMD_UNIT_NAME} exists but is not managed by qiyan-bot`);
    }
    if (existing !== undefined) {
      throw configuration(`${SYSTEMD_UNIT_NAME} is managed but differs; uninstall it before installing a changed unit`);
    }
    await this.atomicCreate(path, contents);
  }

  async remove(path: string): Promise<void> {
    this.assertPath(path);
    await this.prepareDirectory(false);
    const expected = await this.readUnit(path, true);
    if (expected === undefined) throw configuration(`${SYSTEMD_UNIT_NAME} is not installed`);
    if (!expected.contents.startsWith(`${MANAGED_UNIT_MARKER}\n`)) {
      throw configuration(`${SYSTEMD_UNIT_NAME} exists but is not managed by qiyan-bot`);
    }
    await this.hooks.beforeRemove?.();
    const current = await this.readUnit(path, true);
    if (current === undefined || !sameUnitSnapshot(expected, current)) {
      throw configuration(`${SYSTEMD_UNIT_NAME} changed during removal`);
    }
    try { await unlink(path); }
    catch { throw configuration(`cannot remove ${SYSTEMD_UNIT_NAME}`); }
    await this.syncDirectory();
  }

  async verifyManaged(path: string): Promise<boolean> {
    this.assertPath(path);
    try { await this.prepareDirectory(false); }
    catch (error) {
      if (error instanceof MissingDirectoryError) return false;
      throw error;
    }
    const existing = await this.readUnit(path, true);
    if (existing === undefined) return false;
    if (!existing.contents.startsWith(`${MANAGED_UNIT_MARKER}\n`)) {
      throw configuration(`${SYSTEMD_UNIT_NAME} exists but is not managed by qiyan-bot`);
    }
    return true;
  }

  private assertPath(path: string): void {
    if (path !== join(this.unitDirectory, SYSTEMD_UNIT_NAME)) throw configuration("invalid systemd user unit path");
  }

  private async prepareDirectory(create: boolean): Promise<void> {
    const canonicalHome = await realpath(this.userHome).catch(() => undefined);
    if (canonicalHome !== resolve(this.userHome)) throw configuration("HOME must be a real directory for service management");
    await this.requireDirectory(this.userHome, false);
    let current = this.userHome;
    for (const component of [".config", "systemd", "user"]) {
      current = join(current, component);
      try { await this.requireDirectory(current, false); }
      catch (error) {
        if (!(error instanceof MissingDirectoryError) || !create) throw error;
        try { await mkdir(current, { mode: 0o700 }); }
        catch { throw configuration("cannot create the systemd user unit directory"); }
        await this.requireDirectory(current, false);
      }
    }
  }

  private async requireDirectory(path: string, allowMissing: boolean): Promise<void> {
    let state;
    try { state = await lstat(path); }
    catch (error) {
      if (isErrno(error, "ENOENT") && !allowMissing) throw new MissingDirectoryError();
      throw configuration("cannot inspect the systemd user unit directory");
    }
    if (!state.isDirectory() || state.isSymbolicLink() || (this.expectedUid !== undefined && state.uid !== this.expectedUid)
      || (state.mode & 0o022) !== 0) {
      throw configuration("systemd user unit directories must be real owner directories without group or world write access");
    }
  }

  private async readUnit(path: string, allowMissing: true): Promise<UnitSnapshot | undefined>;
  private async readUnit(path: string, allowMissing: false): Promise<UnitSnapshot>;
  private async readUnit(path: string, allowMissing: boolean): Promise<UnitSnapshot | undefined> {
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const state = await file.stat({ bigint: true });
      if (!state.isFile() || state.nlink !== 1n || (this.expectedUid !== undefined && state.uid !== BigInt(this.expectedUid))
        || (state.mode & 0o022n) !== 0n) throw configuration(`${SYSTEMD_UNIT_NAME} must be a regular owner file without group or world write access`);
      if (state.size > BigInt(MAX_UNIT_BYTES)) throw configuration(`${SYSTEMD_UNIT_NAME} is too large`);
      const contents = await readBounded(file, MAX_UNIT_BYTES);
      const snapshot = { contents, device: state.dev.toString(10), inode: state.ino.toString(10) };
      if (!sameIdentity(snapshot, await pathIdentity(path))) throw configuration(`${SYSTEMD_UNIT_NAME} changed while it was read`);
      return snapshot;
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        if (allowMissing) return undefined;
        throw configuration(`${SYSTEMD_UNIT_NAME} is not installed`);
      }
      if (error instanceof AppError) throw error;
      throw configuration(`${SYSTEMD_UNIT_NAME} must be a regular owner file`);
    } finally {
      await file?.close();
    }
  }

  private async atomicCreate(path: string, contents: string): Promise<void> {
    const temporary = join(this.unitDirectory, `.${SYSTEMD_UNIT_NAME}.${randomUUID()}.tmp`);
    let file;
    try {
      file = await open(temporary, "wx", 0o644);
      await file.chmod(0o644);
      await file.writeFile(contents, "utf8");
      await file.sync();
      await file.close();
      file = undefined;
      await this.hooks.beforePublish?.();
      try { await link(temporary, path); }
      catch (error) {
        if (isErrno(error, "EEXIST")) throw configuration(`${SYSTEMD_UNIT_NAME} changed during install`);
        throw error;
      }
      await this.syncDirectory();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw configuration(`cannot install ${SYSTEMD_UNIT_NAME}`);
    } finally {
      await file?.close().catch(() => undefined);
      await unlink(temporary).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
    }
  }

  private async syncDirectory(): Promise<void> {
    const directory = await open(this.unitDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

class MissingDirectoryError extends Error {}

function systemdPath(value: string, label: string): string {
  validateSystemdPath(value, label);
  return systemdQuote(value);
}

function systemdSearchPath(value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_CAPTURED_PATH_BYTES) throw configuration("PATH is too large for service installation");
  const entries = value.split(":");
  if (entries.length === 0 || entries.some((entry) => entry.length === 0)) {
    throw configuration("PATH must contain only nonempty absolute entries for service installation");
  }
  for (const entry of entries) validateSystemdPath(entry, "PATH entry");
  const assignment = systemdQuote(`PATH=${value}`);
  if (Buffer.byteLength(assignment, "utf8") > MAX_CAPTURED_PATH_BYTES) throw configuration("PATH is too large for service installation");
  return assignment;
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("%", "%%")}"`;
}

function systemdWorkingDirectory(value: string, label: string): string {
  validateSystemdPath(value, label);
  if (/\s$/u.test(value)) throw configuration(`${label} contains unsupported trailing whitespace`);
  return value.replaceAll("%", "%%");
}

function validateSystemdPath(value: string, label: string): void {
  if (!isAbsolute(value) || resolve(value) !== value) throw configuration(`${label} must be an absolute normalized path`);
  if (/[\u0000-\u001f\u007f$]/u.test(value)) throw configuration(`${label} contains unsupported characters`);
}

async function runSystemctl(args: readonly string[], hostEnv: NodeJS.ProcessEnv): Promise<SystemdOutcome> {
  return runBoundedCommand("systemctl", ["--user", ...args], hostEnv, MAX_SYSTEMCTL_OUTPUT_BYTES);
}

async function runJournalctl(args: readonly string[], hostEnv: NodeJS.ProcessEnv): Promise<SystemdOutcome> {
  return runBoundedCommand("journalctl", args, hostEnv, MAX_JOURNAL_OUTPUT_BYTES);
}

async function runBoundedCommand(command: string, args: readonly string[], hostEnv: NodeJS.ProcessEnv, maxOutputBytes: number): Promise<SystemdOutcome> {
  const child = spawn(command, [...args], {
    env: systemctlEnvironment(hostEnv),
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return await new Promise<SystemdOutcome>((resolveOutcome, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let exceeded = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (exceeded) return;
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) {
        exceeded = true;
        chunks.length = 0;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (exceeded) return reject(configuration(`${command} returned too much output`));
      resolveOutcome({ code, signal, stdout: Buffer.concat(chunks, bytes).toString("utf8") });
    });
  });
}

function systemctlEnvironment(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TERM", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    if (host[key] !== undefined) result[key] = host[key];
  }
  for (const [key, value] of Object.entries(host)) if (key.startsWith("LC_") && value !== undefined) result[key] = value;
  return result;
}

interface FileIdentity { device: string; inode: string }
interface UnitSnapshot extends FileIdentity { contents: string }

async function fileIdentity(file: FileHandle): Promise<FileIdentity> {
  const state = await file.stat({ bigint: true });
  return { device: state.dev.toString(10), inode: state.ino.toString(10) };
}

async function pathIdentity(path: string): Promise<FileIdentity | undefined> {
  try {
    const state = await lstat(path, { bigint: true });
    return { device: state.dev.toString(10), inode: state.ino.toString(10) };
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity | undefined): boolean {
  return right !== undefined && left.device === right.device && left.inode === right.inode;
}

function sameUnitSnapshot(left: UnitSnapshot, right: UnitSnapshot): boolean {
  return sameIdentity(left, right) && left.contents === right.contents;
}

async function readBounded(file: FileHandle, maxBytes: number): Promise<string> {
  const bytes = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const read = await file.read(bytes, offset, bytes.length - offset, offset);
    if (read.bytesRead === 0) break;
    offset += read.bytesRead;
  }
  if (offset > maxBytes) throw configuration(`${SYSTEMD_UNIT_NAME} is too large`);
  return bytes.subarray(0, offset).toString("utf8");
}

function configuration(message: string): AppError { return new AppError("CONFIGURATION_ERROR", message); }
function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
