import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { AppError } from "../core/errors.ts";
import { buildCodexChildEnvironment } from "../mcp/server.ts";

const markerSchema = z.object({
  version: z.literal(1),
  creation_nonce: z.uuid(),
  creation_baseline: z.array(z.string().min(1)),
}).strict();

interface MarkerDocument {
  version: 1;
  creation_nonce: string;
  creation_baseline: string[];
}

export interface PreparedCoordinatorProfile {
  root: string;
  home: string;
  codexHome: string;
  markerPath: string;
  activationRequired: boolean;
  creationNonce: string;
  creationBaseline: readonly string[];
  markActivated(creationBaseline: readonly string[]): Promise<void>;
}

export async function prepareCoordinatorProfile(dataRoot: string): Promise<PreparedCoordinatorProfile> {
  try {
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
      creationBaseline: existing ? [...existing.creation_baseline] : [],
      async markActivated(values): Promise<void> {
        const creationBaseline = [...new Set(values)].sort();
        if (creationBaseline.some((value) => value.length === 0)) throw managedError("coordinator profile activation baseline is invalid");
        const document: MarkerDocument = { version: 1, creation_nonce: result.creationNonce, creation_baseline: creationBaseline };
        const current = await readMarker(markerPath);
        if (current) {
          if (current.creation_nonce !== document.creation_nonce || !sameStrings(current.creation_baseline, creationBaseline)) {
            throw managedError("coordinator profile activation marker already records a different baseline");
          }
        } else {
          await atomicWrite(markerPath, Buffer.from(`${JSON.stringify(document, null, 2)}\n`));
        }
        result.activationRequired = false;
        result.creationBaseline = creationBaseline;
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
  if (!sameStrings(parsed.creation_baseline, [...new Set(parsed.creation_baseline)].sort())) {
    throw managedError("coordinator profile activation marker is invalid");
  }
  await chmod(path, 0o600);
  return parsed;
}

async function atomicWrite(path: string, contents: Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await unlink(temporary).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
