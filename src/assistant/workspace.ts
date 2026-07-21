import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { AppError } from "../core/errors.ts";

const POLICY_FILE = "AGENTS.md";
const POLICY_APPEND_FILE = "AGENTS.append.md";
const DIGEST_FILE = ".qiyan-bot-agents.sha256";
const CONTEXT_FILE = "assistant-context.json";
const CONTEXT_DIGEST_FILE = ".qiyan-bot-context.sha256";

export interface AssistantWorkspaceOptions {
  workdir: string;
  dataDir: string;
  registryPath: string;
  policyTemplatePath: string;
  userHome: string;
  qiyanHome: string;
  defaultProjectsRoot?: string;
}

export interface PreparedAssistantWorkspace {
  root: string;
  dataRoot: string;
  registryPath: string;
  dashboardPath: string;
  contextPath: string;
  userHome: string;
  qiyanHome: string;
  defaultProjectsRoot: string;
  warnings: string[];
}

export async function validateAssistantWorkspacePaths(options: Pick<AssistantWorkspaceOptions, "workdir" | "dataDir" | "registryPath">): Promise<void> {
  const requestedRoot = resolve(options.workdir);
  const requestedDataRoot = resolve(options.dataDir);
  const requestedRegistryPath = resolve(options.registryPath);
  assertSeparated(requestedRoot, requestedDataRoot, "configured data directory");
  assertSeparated(requestedRoot, requestedRegistryPath, "configured registry path");
  const [projectedRoot, projectedDataRoot, projectedRegistryPath] = await Promise.all([
    canonicalProjectedPath(requestedRoot),
    canonicalProjectedPath(requestedDataRoot),
    canonicalProjectedPath(requestedRegistryPath),
  ]);
  assertSeparated(projectedRoot, projectedDataRoot, "canonical data directory");
  assertSeparated(projectedRoot, projectedRegistryPath, "canonical registry path");
}

export async function prepareAssistantWorkspace(options: AssistantWorkspaceOptions): Promise<PreparedAssistantWorkspace> {
  try {
    const requestedRoot = resolve(options.workdir);
    const requestedDataRoot = resolve(options.dataDir);
    const requestedRegistryPath = resolve(options.registryPath);
    await validateAssistantWorkspacePaths(options);

    await mkdir(options.workdir, { recursive: true, mode: 0o700 });
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    await mkdir(dirname(options.registryPath), { recursive: true, mode: 0o700 });

    const root = await realpath(options.workdir);
    const dataRoot = await realpath(options.dataDir);
    const registryPath = await canonicalFilePath(options.registryPath);
    const userHome = await realpath(options.userHome);
    const qiyanHome = await realpath(options.qiyanHome);
    const defaultProjectsRoot = await canonicalProjectedPath(options.defaultProjectsRoot ?? join(userHome, "qiyan-projects"));
    assertSeparated(root, requestedDataRoot, "configured data directory");
    assertSeparated(root, requestedRegistryPath, "configured registry path");
    assertSeparated(requestedRoot, dataRoot, "canonical data directory");
    assertSeparated(requestedRoot, registryPath, "canonical registry path");
    assertSeparated(root, dataRoot, "data directory");
    assertSeparated(root, registryPath, "registry path");

    const policyPath = join(root, POLICY_FILE);
    const appendPath = join(root, POLICY_APPEND_FILE);
    const digestPath = join(root, DIGEST_FILE);
    const packagedPolicy = await readFile(options.policyTemplatePath);
    const appendState = await regularFileState(appendPath);
    const expectedPolicy = appendState === "file"
      ? Buffer.concat([packagedPolicy, Buffer.from("\n\n"), await readFile(appendPath)])
      : packagedPolicy;
    const expectedDigest = digest(expectedPolicy);
    const policyState = await regularFileState(policyPath);
    const digestState = await regularFileState(digestPath);

    if (policyState === "missing" && digestState === "missing") {
      await atomicWrite(policyPath, expectedPolicy);
      await atomicWrite(digestPath, Buffer.from(`${expectedDigest}\n`));
    } else if (policyState === "file" && digestState === "missing") {
      const installed = await readFile(policyPath);
      if (digest(installed) !== expectedDigest) throw managedError(`${policyPath} has no bot digest and does not match the expected generated policy`);
      await atomicWrite(digestPath, Buffer.from(`${expectedDigest}\n`));
    } else if (policyState === "missing" && digestState === "file") {
      throw managedError(`digest exists but AGENTS.md is missing at ${policyPath}`);
    } else {
      const installed = await readFile(policyPath);
      const recorded = (await readFile(digestPath, "utf8")).trim();
      if (!/^[a-f0-9]{64}$/u.test(recorded) || digest(installed) !== recorded) {
        throw managedError(`${policyPath} is managed by qiyan-bot and was modified; put additions in AGENTS.append.md or a complete replacement in AGENTS.override.md`);
      }
      if (recorded !== expectedDigest) {
        await atomicWrite(policyPath, expectedPolicy);
        await atomicWrite(digestPath, Buffer.from(`${expectedDigest}\n`));
      }
    }

    const contextPath = join(root, CONTEXT_FILE);
    const contextDigestPath = join(root, CONTEXT_DIGEST_FILE);
    const context = Buffer.from(`${JSON.stringify({
      version: 2,
      user_home: userHome,
      qiyan_home: qiyanHome,
      default_projects_root: defaultProjectsRoot,
    }, null, 2)}\n`);
    await installGeneratedContext(contextPath, contextDigestPath, context);

    const gitRoot = await findGitAncestor(root);
    const warnings = gitRoot ? [`Assistant workdir ${root} is inside Git worktree ${gitRoot}; Codex may inherit parent instructions, project configuration, and repository skills.`] : [];
    return { root, dataRoot, registryPath, dashboardPath: join(root, "session-status.json"), contextPath, userHome, qiyanHome, defaultProjectsRoot, warnings };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw managedError(`cannot prepare assistant workdir ${options.workdir}`);
  }
}

type FileState = "missing" | "file";

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function managedError(message: string): AppError {
  return new AppError("CONFIGURATION_ERROR", message);
}

async function regularFileState(path: string): Promise<FileState> {
  try {
    const value = await lstat(path);
    if (!value.isFile() || value.isSymbolicLink()) throw managedError(`${path} must be a regular file`);
    return "file";
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "missing";
    throw error;
  }
}

async function atomicWrite(path: string, value: Uint8Array, mode = 0o600): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, value, { flag: "wx", mode });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
  }
}

async function installGeneratedContext(path: string, digestPath: string, expected: Uint8Array): Promise<void> {
  const expectedDigest = digest(expected);
  const contextState = await regularFileState(path);
  const digestState = await regularFileState(digestPath);
  if (contextState === "missing" && digestState === "missing") {
    await atomicWrite(path, expected, 0o400);
    await atomicWrite(digestPath, Buffer.from(`${expectedDigest}\n`));
    return;
  }
  if (contextState === "missing") throw managedError(`digest exists but assistant-context.json is missing at ${path}`);
  const installed = await readFile(path);
  if (digestState === "missing") {
    if (digest(installed) !== expectedDigest) throw managedError(`${path} has no bot digest and does not match the generated assistant context`);
    await chmod(path, 0o400);
    await atomicWrite(digestPath, Buffer.from(`${expectedDigest}\n`));
    return;
  }
  const recorded = (await readFile(digestPath, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/u.test(recorded) || digest(installed) !== recorded) {
    throw managedError(`${path} is managed by qiyan-bot and was modified`);
  }
  if (recorded !== expectedDigest) {
    await atomicWrite(path, expected, 0o400);
    await atomicWrite(digestPath, Buffer.from(`${expectedDigest}\n`));
  } else {
    await chmod(path, 0o400);
  }
}

async function canonicalFilePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    return join(await realpath(dirname(path)), basename(path));
  }
}

async function canonicalProjectedPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalProjectedPath(parent), basename(path));
  }
}

function assertSeparated(workdir: string, protectedPath: string, label: string): void {
  if (contains(workdir, protectedPath) || contains(protectedPath, workdir)) {
    throw managedError(`assistant workdir ${workdir} and backend ${label} ${protectedPath} must be separate from backend state`);
  }
}

function contains(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate));
}

async function findGitAncestor(start: string): Promise<string | undefined> {
  const filesystemRoot = parse(start).root;
  let current = start;
  while (true) {
    try {
      await lstat(join(current, ".git"));
      return current;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    if (current === filesystemRoot) return undefined;
    current = dirname(current);
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
