import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { AppError } from "../core/errors.ts";
import { buildAssistantBaseEnvironment } from "../mcp/server.ts";

const markerSchema = z.object({
  version: z.literal(1),
  creation_nonce: z.uuid(),
  pending_thread_id: z.string().min(1).nullable(),
}).strict();

interface MarkerDocument {
  version: 1;
  creation_nonce: string;
  pending_thread_id: string | null;
}

export interface PreparedAssistantProfile {
  root: string;
  home: string;
  codexHome: string;
  markerPath: string;
  activationRequired: boolean;
  creationNonce: string;
  pendingThreadId: string | null;
  assertIntact(): Promise<void>;
  markActivated(): Promise<void>;
  recordPendingThread(threadId: string): Promise<void>;
  clearPendingThread(threadId: string): Promise<void>;
}

export async function prepareAssistantProfile(dataRoot: string): Promise<PreparedAssistantProfile> {
  try {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const canonicalDataRoot = await realpath(dataRoot);
    const root = await ensurePrivateDirectory(join(canonicalDataRoot, "assistant-profile"));
    const home = await ensurePrivateDirectory(join(root, "home"));
    const codexHome = await ensurePrivateDirectory(join(root, "codex"));
    for (const path of [root, home, codexHome]) {
      if (!contains(canonicalDataRoot, path)) throw managedError("assistant profile escaped the configured data directory");
    }
    const directoryPins = await Promise.all([root, home, codexHome].map(pinDirectory));
    const markerPath = join(root, "profile.json");
    const existing = await readMarker(markerPath);
    const result: PreparedAssistantProfile = {
      root,
      home,
      codexHome,
      markerPath,
      activationRequired: existing === undefined,
      creationNonce: existing?.creation_nonce ?? randomUUID(),
      pendingThreadId: existing?.pending_thread_id ?? null,
      async assertIntact(): Promise<void> {
        for (const pin of directoryPins) await assertPinnedDirectory(pin);
      },
      async markActivated(): Promise<void> {
        await result.assertIntact();
        const document: MarkerDocument = { version: 1, creation_nonce: result.creationNonce, pending_thread_id: null };
        const current = await readMarker(markerPath);
        if (current) {
          if (current.creation_nonce !== document.creation_nonce) throw managedError("assistant profile activation marker records a different nonce");
        } else {
          await atomicWrite(markerPath, Buffer.from(`${JSON.stringify(document, null, 2)}\n`), result.assertIntact);
        }
        result.activationRequired = false;
        result.pendingThreadId = current?.pending_thread_id ?? null;
      },
      async recordPendingThread(threadId): Promise<void> {
        await result.assertIntact();
        if (!threadId) throw managedError("assistant pending thread identity is invalid");
        const current = await requireCurrentMarker(markerPath, result.creationNonce);
        if (current.pending_thread_id && current.pending_thread_id !== threadId) throw managedError("assistant profile records a different pending thread");
        if (current.pending_thread_id === null) await writeMarker(markerPath, { ...current, pending_thread_id: threadId }, result.assertIntact);
        result.activationRequired = false;
        result.pendingThreadId = threadId;
      },
      async clearPendingThread(threadId): Promise<void> {
        await result.assertIntact();
        const current = await requireCurrentMarker(markerPath, result.creationNonce);
        if (current.pending_thread_id === null) {
          result.pendingThreadId = null;
          return;
        }
        if (current.pending_thread_id !== threadId) throw managedError("assistant pending thread identity does not match the activation marker");
        await writeMarker(markerPath, { ...current, pending_thread_id: null }, result.assertIntact);
        result.pendingThreadId = null;
      },
    };
    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw managedError("cannot prepare isolated assistant profile");
  }
}

export function buildAssistantChildEnvironment(
  host: NodeJS.ProcessEnv,
  profile: Pick<PreparedAssistantProfile, "home" | "codexHome">,
  mcpToken?: string,
): NodeJS.ProcessEnv {
  return { ...buildAssistantBaseEnvironment(host, mcpToken), HOME: profile.home, CODEX_HOME: profile.codexHome };
}

interface AccountEndpoint {
  request<T>(method: string, params: unknown): Promise<T>;
}

interface StartableAccountEndpoint extends AccountEndpoint {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function assertAssistantAuthenticated(
  endpoint: AccountEndpoint,
  profile: Pick<PreparedAssistantProfile, "root" | "home" | "codexHome">,
): Promise<void> {
  const response = await endpoint.request<{ account: unknown | null; requiresOpenaiAuth: boolean }>("account/read", { refreshToken: false });
  if (response.account !== null || !response.requiresOpenaiAuth) return;
  throw new AppError(
    "CONFIGURATION_ERROR",
    `assistant Codex profile is not authenticated (HOME ${profile.home}, CODEX_HOME ${profile.codexHome}); run qiyan-bot assistant-login with DATA_DIR set to ${dirname(profile.root)}`,
    { reason: "assistant_auth_required" },
  );
}

export async function startAuthenticatedAssistantEndpoint(
  endpoint: StartableAccountEndpoint,
  profile: Pick<PreparedAssistantProfile, "root" | "home" | "codexHome">,
): Promise<void> {
  await endpoint.start();
  try {
    await assertAssistantAuthenticated(endpoint, profile);
  } catch (error) {
    await endpoint.stop().catch(() => undefined);
    throw error;
  }
}

async function ensurePrivateDirectory(path: string): Promise<string> {
  let value;
  try { value = await lstat(path); }
  catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    await mkdir(path, { mode: 0o700 });
    value = await lstat(path);
  }
  if (value.isSymbolicLink() || !value.isDirectory()) throw managedError(`${path} must be a real directory`);
  await chmod(path, 0o700);
  return realpath(path);
}

async function readMarker(path: string): Promise<MarkerDocument | undefined> {
  let value;
  try { value = await lstat(path); }
  catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  if (value.isSymbolicLink() || !value.isFile()) throw managedError("assistant profile activation marker must be a regular file");
  let file;
  try {
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (isErrno(error, "ELOOP")) throw managedError("assistant profile activation marker must be a regular file");
    throw error;
  }
  try {
    const opened = await file.stat({ bigint: true });
    if (!opened.isFile()) throw managedError("assistant profile activation marker must be a regular file");
    let parsed: MarkerDocument;
    try { parsed = markerSchema.parse(JSON.parse(await file.readFile("utf8"))) as MarkerDocument; }
    catch { throw managedError("assistant profile activation marker is invalid"); }
    const current = await lstat(path, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw managedError("assistant profile activation marker changed unexpectedly");
    }
    await file.chmod(0o600);
    return parsed;
  } finally {
    await file.close();
  }
}

async function requireCurrentMarker(path: string, nonce: string): Promise<MarkerDocument> {
  const marker = await readMarker(path);
  if (!marker || marker.creation_nonce !== nonce) throw managedError("assistant profile activation marker changed unexpectedly");
  return marker;
}

async function writeMarker(path: string, marker: MarkerDocument, beforeCommit: () => Promise<void>): Promise<void> {
  await atomicWrite(path, Buffer.from(`${JSON.stringify(marker, null, 2)}\n`), beforeCommit);
}

async function atomicWrite(path: string, contents: Uint8Array, beforeCommit?: () => Promise<void>): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    await beforeCommit?.();
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await unlink(temporary).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
  }
}

interface DirectoryPin { path: string; dev: bigint; ino: bigint }

async function pinDirectory(path: string): Promise<DirectoryPin> {
  const value = await lstat(path, { bigint: true });
  if (!value.isDirectory() || value.isSymbolicLink()) throw managedError(`${path} must be a real directory`);
  return { path, dev: value.dev, ino: value.ino };
}

async function assertPinnedDirectory(pin: DirectoryPin): Promise<void> {
  let value;
  try { value = await lstat(pin.path, { bigint: true }); }
  catch { throw managedError(`assistant profile directory ${pin.path} changed unexpectedly`); }
  if (!value.isDirectory() || value.isSymbolicLink() || value.dev !== pin.dev || value.ino !== pin.ino
    || (value.mode & 0o777n) !== 0o700n
    || await realpath(pin.path).catch(() => undefined) !== pin.path) {
    throw managedError(`assistant profile directory ${pin.path} changed unexpectedly`);
  }
}

function contains(parent: string, child: string): boolean {
  const candidate = relative(resolve(parent), resolve(child));
  return candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate));
}

function managedError(message: string): AppError {
  return new AppError("CONFIGURATION_ERROR", message);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
