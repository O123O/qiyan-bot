import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { AppError } from "../core/errors.ts";
import { buildCodexChildEnvironment } from "../mcp/server.ts";

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

export interface PreparedCoordinatorProfile {
  root: string;
  home: string;
  codexHome: string;
  markerPath: string;
  activationRequired: boolean;
  creationNonce: string;
  pendingThreadId: string | null;
  markActivated(): Promise<void>;
  recordPendingThread(threadId: string): Promise<void>;
  clearPendingThread(threadId: string): Promise<void>;
}

export async function prepareCoordinatorProfile(dataRoot: string): Promise<PreparedCoordinatorProfile> {
  try {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const canonicalDataRoot = await realpath(dataRoot);
    const root = await ensurePrivateDirectory(join(canonicalDataRoot, "coordinator-profile"));
    const home = await ensurePrivateDirectory(join(root, "home"));
    const codexHome = await ensurePrivateDirectory(join(root, "codex"));
    for (const path of [root, home, codexHome]) {
      if (!contains(canonicalDataRoot, path)) throw managedError("coordinator profile escaped the configured data directory");
    }
    const markerPath = join(root, "profile.json");
    const existing = await readMarker(markerPath);
    const result: PreparedCoordinatorProfile = {
      root,
      home,
      codexHome,
      markerPath,
      activationRequired: existing === undefined,
      creationNonce: existing?.creation_nonce ?? randomUUID(),
      pendingThreadId: existing?.pending_thread_id ?? null,
      async markActivated(): Promise<void> {
        const document: MarkerDocument = { version: 1, creation_nonce: result.creationNonce, pending_thread_id: null };
        const current = await readMarker(markerPath);
        if (current) {
          if (current.creation_nonce !== document.creation_nonce) throw managedError("coordinator profile activation marker records a different nonce");
        } else {
          await atomicWrite(markerPath, Buffer.from(`${JSON.stringify(document, null, 2)}\n`));
        }
        result.activationRequired = false;
        result.pendingThreadId = current?.pending_thread_id ?? null;
      },
      async recordPendingThread(threadId): Promise<void> {
        if (!threadId) throw managedError("coordinator pending thread identity is invalid");
        const current = await requireCurrentMarker(markerPath, result.creationNonce);
        if (current.pending_thread_id && current.pending_thread_id !== threadId) throw managedError("coordinator profile records a different pending thread");
        if (current.pending_thread_id === null) await writeMarker(markerPath, { ...current, pending_thread_id: threadId });
        result.activationRequired = false;
        result.pendingThreadId = threadId;
      },
      async clearPendingThread(threadId): Promise<void> {
        const current = await requireCurrentMarker(markerPath, result.creationNonce);
        if (current.pending_thread_id === null) {
          result.pendingThreadId = null;
          return;
        }
        if (current.pending_thread_id !== threadId) throw managedError("coordinator pending thread identity does not match the activation marker");
        await writeMarker(markerPath, { ...current, pending_thread_id: null });
        result.pendingThreadId = null;
      },
    };
    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw managedError("cannot prepare isolated coordinator profile");
  }
}

export function buildCoordinatorChildEnvironment(
  host: NodeJS.ProcessEnv,
  profile: Pick<PreparedCoordinatorProfile, "home" | "codexHome">,
  mcpToken?: string,
): NodeJS.ProcessEnv {
  return { ...buildCodexChildEnvironment(host, mcpToken), HOME: profile.home, CODEX_HOME: profile.codexHome };
}

interface AccountEndpoint {
  request<T>(method: string, params: unknown): Promise<T>;
}

interface StartableAccountEndpoint extends AccountEndpoint {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function assertCoordinatorAuthenticated(
  endpoint: AccountEndpoint,
  profile: Pick<PreparedCoordinatorProfile, "root" | "home" | "codexHome">,
): Promise<void> {
  const response = await endpoint.request<{ account: unknown | null; requiresOpenaiAuth: boolean }>("account/read", { refreshToken: false });
  if (response.account !== null || !response.requiresOpenaiAuth) return;
  throw new AppError(
    "CONFIGURATION_ERROR",
    `coordinator Codex profile is not authenticated (HOME ${profile.home}, CODEX_HOME ${profile.codexHome}); run codex-bot coordinator-login with DATA_DIR set to ${dirname(profile.root)}`,
    { reason: "coordinator_auth_required" },
  );
}

export async function startAuthenticatedCoordinatorEndpoint(
  endpoint: StartableAccountEndpoint,
  profile: Pick<PreparedCoordinatorProfile, "root" | "home" | "codexHome">,
): Promise<void> {
  await endpoint.start();
  try {
    await assertCoordinatorAuthenticated(endpoint, profile);
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
  if (value.isSymbolicLink() || !value.isFile()) throw managedError("coordinator profile activation marker must be a regular file");
  let parsed: MarkerDocument;
  try { parsed = markerSchema.parse(JSON.parse(await readFile(path, "utf8"))) as MarkerDocument; }
  catch { throw managedError("coordinator profile activation marker is invalid"); }
  await chmod(path, 0o600);
  return parsed;
}

async function requireCurrentMarker(path: string, nonce: string): Promise<MarkerDocument> {
  const marker = await readMarker(path);
  if (!marker || marker.creation_nonce !== nonce) throw managedError("coordinator profile activation marker changed unexpectedly");
  return marker;
}

async function writeMarker(path: string, marker: MarkerDocument): Promise<void> {
  await atomicWrite(path, Buffer.from(`${JSON.stringify(marker, null, 2)}\n`));
}

async function atomicWrite(path: string, contents: Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await unlink(temporary).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
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
