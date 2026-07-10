import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { AppError } from "../core/errors.ts";

const privateDirectoryMode = 0o700;
const maxUnixSocketPathBytes = 103;

interface LocalRuntimeOptions {
  runtimeBase?: string;
  expectedUid?: number;
  xdgRuntimeDir?: string | null;
  temporaryDirectory?: string;
}

export async function prepareLocalSshRuntimeRoot(
  dataDir: string,
  options: LocalRuntimeOptions = {},
): Promise<string> {
  if (!isAbsolute(dataDir)) throw runtimeDirectoryError();
  const expectedUid = options.expectedUid ?? process.geteuid?.() ?? process.getuid?.();
  const runtimeBase = options.runtimeBase ?? defaultRuntimeBase(expectedUid, options);
  if (!isAbsolute(runtimeBase)) throw runtimeDirectoryError();

  await ensurePrivateOwnerDirectory(runtimeBase, expectedUid, options.runtimeBase === undefined);
  const productRoot = join(runtimeBase, "qiyan");
  await ensurePrivateOwnerDirectory(productRoot, expectedUid, true);
  const namespace = createHash("sha256").update(dataDir).digest("hex").slice(0, 16);
  const namespaceRoot = join(productRoot, namespace);
  await ensurePrivateOwnerDirectory(namespaceRoot, expectedUid, true);
  return namespaceRoot;
}

export function localSshEndpointSocketRoot(runtimeRoot: string, endpointId: string): string {
  if (!isAbsolute(runtimeRoot) || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(endpointId)) throw runtimeDirectoryError();
  const endpointNamespace = createHash("sha256").update(endpointId).digest("hex").slice(0, 16);
  const socketRoot = join(runtimeRoot, "s", endpointNamespace);
  const socketPath = join(socketRoot, "00000000");
  if (Buffer.byteLength(socketPath) > maxUnixSocketPathBytes) {
    throw new AppError("CONFIGURATION_ERROR", "local SSH Unix socket path is too long");
  }
  return socketRoot;
}

export function localSshForwardSocketPath(socketRoot: string, generation: string): string {
  if (!isAbsolute(socketRoot) || !/^[a-f0-9]{8}$/u.test(generation)) throw runtimeDirectoryError("local SSH forward socket path is invalid");
  const socketPath = join(socketRoot, generation);
  if (Buffer.byteLength(socketPath) > maxUnixSocketPathBytes) {
    throw new AppError("CONFIGURATION_ERROR", "local SSH Unix socket path is too long");
  }
  return socketPath;
}

export async function prepareLocalSshEndpointSocketRoot(
  runtimeRoot: string,
  endpointId: string,
  expectedUid = process.geteuid?.() ?? process.getuid?.(),
): Promise<string> {
  const socketRoot = localSshEndpointSocketRoot(runtimeRoot, endpointId);
  await ensurePrivateOwnerDirectory(runtimeRoot, expectedUid, false);
  const socketsRoot = join(runtimeRoot, "s");
  await ensurePrivateOwnerDirectory(socketsRoot, expectedUid, true);
  await ensurePrivateOwnerDirectory(socketRoot, expectedUid, true);
  return socketRoot;
}

function defaultRuntimeBase(uid: number | undefined, options: LocalRuntimeOptions): string {
  const configured = options.xdgRuntimeDir === undefined ? process.env.XDG_RUNTIME_DIR : options.xdgRuntimeDir ?? undefined;
  if (configured && isAbsolute(configured)) return configured;
  if (uid === undefined) throw runtimeDirectoryError();
  return join(options.temporaryDirectory ?? tmpdir(), `qiyan-${uid}`);
}

async function ensurePrivateOwnerDirectory(path: string, expectedUid: number | undefined, create: boolean): Promise<void> {
  if (create) {
    try { await mkdir(path, { mode: privateDirectoryMode }); }
    catch (error) { if (!isErrno(error, "EEXIST")) throw runtimeDirectoryError(); }
  }
  let directory;
  try { directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch { throw runtimeDirectoryError(); }
  try {
    let state = await directory.stat();
    if (!state.isDirectory() || (expectedUid !== undefined && state.uid !== expectedUid)) throw runtimeDirectoryError();
    if ((state.mode & 0o777) !== privateDirectoryMode) {
      await directory.chmod(privateDirectoryMode);
      state = await directory.stat();
    }
    if (!state.isDirectory() || (state.mode & 0o777) !== privateDirectoryMode
      || (expectedUid !== undefined && state.uid !== expectedUid)) throw runtimeDirectoryError();
  } finally { await directory.close(); }
}

function runtimeDirectoryError(message = "local SSH runtime must be a private owner directory"): AppError {
  return new AppError("CONFIGURATION_ERROR", message);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
