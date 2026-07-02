import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { AppError } from "./core/errors.ts";

export const BOT_SECRET_ENV_NAMES = new Set([
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_OWNER_ID",
  "TELEGRAM_DESTINATION_CHAT_ID",
  "QIYAN_BOT_MCP_TOKEN",
]);

export const SUPPORTED_DOTENV_KEYS = new Set([
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_OWNER_ID",
  "TELEGRAM_DESTINATION_CHAT_ID",
  "ASSISTANT_WORKDIR",
  "DATA_DIR",
  "SESSION_REGISTRY_PATH",
  "CODEX_BINARY",
  "MAX_CONCURRENT_TURNS",
  "MAX_COLLECT_COUNT",
  "MCP_HOST",
  "MCP_PORT",
  "ATTACHMENT_MAX_BYTES",
  "ATTACHMENT_STORE_MAX_BYTES",
  "ASSISTANT_SANDBOX_MODE",
]);

export interface LoadedConfigSource {
  qiyanHome: string;
  dotenvPath: string;
  hostEnv: Record<string, string | undefined>;
  values: Record<string, string | undefined>;
}

export async function loadConfigSource(
  host: Record<string, string | undefined>,
  options: { cliHome?: string; maxDotenvBytes?: number; expectedUid?: number } = {},
): Promise<LoadedConfigSource> {
  const requestedUserHome = host.HOME;
  if (!requestedUserHome || !isAbsolute(requestedUserHome)) throw managedError("HOME must be an absolute path");
  const userHome = await requireRealDirectory(requestedUserHome, "HOME");
  const expectedUid = options.expectedUid ?? process.geteuid?.();
  const requested = resolveBootstrapPath(options.cliHome ?? host.QIYAN_HOME ?? join(userHome, ".qiyan-bot"), userHome);
  const projected = await projectedCanonical(requested);
  if (projected !== requested) throw managedError("QIYAN_HOME must be a real directory path without symlink aliases");
  const projectsRoot = await projectedCanonical(join(userHome, "qiyan-projects"));
  if (contains(projected, userHome)) throw managedError("QIYAN_HOME cannot equal or contain the user home");
  if (overlaps(projected, projectsRoot)) throw managedError("QIYAN_HOME cannot overlap the user project root");

  await mkdir(requested, { recursive: true, mode: 0o700 });
  const qiyanHome = await requirePrivateDirectory(requested, expectedUid);
  const dotenvPath = join(qiyanHome, ".env");
  const dotenv = await readPrivateDotenv(dotenvPath, {
    ...(expectedUid === undefined ? {} : { expectedUid }),
    maxBytes: options.maxDotenvBytes ?? 64 * 1024,
  });
  const hostEnv = { ...host };
  const values: Record<string, string | undefined> = { ...dotenv };
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value !== undefined) values[key] = value;
  }
  return { qiyanHome, dotenvPath, hostEnv, values };
}

function resolveBootstrapPath(value: string, userHome: string): string {
  if (value.startsWith("~/")) return resolve(userHome, value.slice(2));
  if (!isAbsolute(value)) throw managedError("QIYAN_HOME must be absolute or begin with ~/");
  return resolve(value);
}

async function readPrivateDotenv(
  path: string,
  options: { expectedUid?: number; maxBytes: number },
): Promise<Record<string, string>> {
  let initial;
  try { initial = await lstat(path, { bigint: true }); }
  catch (error) {
    if (isErrno(error, "ENOENT")) return {};
    throw managedError("cannot inspect the QiYan dotenv file");
  }
  if (!initial.isFile() || initial.isSymbolicLink()) throw managedError("QiYan .env must be a regular file, not a symlink");

  let file;
  try {
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    throw managedError("cannot safely open the QiYan dotenv file");
  }
  try {
    const opened = await file.stat({ bigint: true });
    if (!opened.isFile()) throw managedError("QiYan .env must be a regular file");
    if (options.expectedUid !== undefined && opened.uid !== BigInt(options.expectedUid)) throw managedError("QiYan .env must be owned by the current user");
    if ((opened.mode & 0o077n) !== 0n || (opened.mode & 0o400n) === 0n) throw managedError("QiYan .env must have private owner-only permissions");
    if (opened.size > BigInt(options.maxBytes)) throw managedError("QiYan .env is too large");
    const contents = await file.readFile("utf8");
    const current = await lstat(path, { bigint: true }).catch(() => undefined);
    if (!current?.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw managedError("QiYan .env changed unexpectedly while it was read");
    }
    assertDotenvLines(contents);
    const parsed = parseEnv(contents);
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "QIYAN_HOME") throw managedError("QIYAN_HOME cannot be defined inside .env");
      if (!SUPPORTED_DOTENV_KEYS.has(key)) throw managedError(`unsupported QiYan dotenv key: ${key}`);
      if (value !== undefined) result[key] = value;
    }
    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw managedError("QiYan .env is invalid");
  } finally {
    await file.close();
  }
}

function assertDotenvLines(contents: string): void {
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/u.test(trimmed)) throw managedError("QiYan dotenv contains an invalid line");
  }
}

async function requireRealDirectory(path: string, label: string): Promise<string> {
  let value;
  try { value = await lstat(path); }
  catch { throw managedError(`${label} must be an existing real directory`); }
  if (!value.isDirectory() || value.isSymbolicLink()) throw managedError(`${label} must be an existing real directory`);
  return realpath(path);
}

async function requirePrivateDirectory(path: string, expectedUid?: number): Promise<string> {
  const value = await lstat(path, { bigint: true });
  if (!value.isDirectory() || value.isSymbolicLink()) throw managedError("QIYAN_HOME must be a real directory");
  if (expectedUid !== undefined && value.uid !== BigInt(expectedUid)) throw managedError("QIYAN_HOME must be owned by the current user");
  if ((value.mode & 0o777n) !== 0o700n) throw managedError("QIYAN_HOME must have private mode 0700 permissions");
  return realpath(path);
}

async function projectedCanonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    const parent = resolve(path, "..");
    if (parent === path) throw managedError("path has no existing filesystem root");
    return join(await projectedCanonical(parent), path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
  }
}

function overlaps(left: string, right: string): boolean { return contains(left, right) || contains(right, left); }

function contains(parent: string, child: string): boolean {
  const candidate = relative(resolve(parent), resolve(child));
  return candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate));
}

function managedError(message: string): AppError { return new AppError("CONFIGURATION_ERROR", message); }

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
