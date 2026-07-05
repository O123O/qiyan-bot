import { constants } from "node:fs";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { AppError } from "../core/errors.ts";

const MAX_CATALOG_BYTES = 1024 * 1024;
const endpointId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u).refine((value) => value !== "local" && value !== "assistant-local", "reserved endpoint id");
const projectRoot = z.string().refine((value) => value.startsWith("~/") || isAbsolute(value), "must be absolute or begin with ~/");
const entry = z.object({ type: z.literal("ssh"), projects_root: projectRoot.optional() }).strict();
const documentSchema = z.object({ version: z.literal(1), endpoints: z.record(endpointId, entry) }).strict();

export interface SshEndpointDefinition {
  id: string;
  type: "ssh";
  projectsRoot: string;
}

export interface EndpointCatalogDocument {
  version: 1;
  endpoints: Record<string, { type: "ssh"; projects_root?: string }>;
}

export class EndpointCatalog {
  private constructor(private readonly path: string, private document: EndpointCatalogDocument) {}

  static async open(path: string): Promise<EndpointCatalog> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await bootstrap(path);
    return new EndpointCatalog(path, await readDocument(path));
  }

  async reload(): Promise<void> {
    const next = await readDocument(this.path);
    this.document = next;
  }

  snapshot(): EndpointCatalogDocument { return structuredClone(this.document); }

  require(id: string): SshEndpointDefinition {
    if (id === "local" || id === "assistant-local") throw new AppError("CONFIGURATION_ERROR", `${id} is a built-in endpoint`);
    const value = this.document.endpoints[id];
    if (!value) throw new AppError("ENDPOINT_UNAVAILABLE", `unknown endpoint: ${id}`);
    return { id, type: "ssh", projectsRoot: value.projects_root ?? "~/qiyan-projects" };
  }
}

async function bootstrap(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return;
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw catalogError("endpoint catalog must be a regular owner file with mode 0600");
  } finally {
    await handle?.close();
  }
  const temporary = join(dirname(path), `.${crypto.randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify({ version: 1, endpoints: {} }, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await link(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  } finally {
    await unlink(temporary).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
  }
}

async function readDocument(path: string): Promise<EndpointCatalogDocument> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const state = await file.stat();
    const expectedUid = process.getuid?.();
    if (!state.isFile() || state.nlink !== 1 || (expectedUid !== undefined && state.uid !== expectedUid)) {
      throw catalogError("endpoint catalog must be a regular owner file with mode 0600");
    }
    if ((state.mode & 0o077) !== 0) throw catalogError("endpoint catalog must have mode 0600");
    if (state.size > MAX_CATALOG_BYTES) throw catalogError("endpoint catalog exceeds 1 MiB");
    const bytes = await file.readFile();
    if (bytes.byteLength > MAX_CATALOG_BYTES) throw catalogError("endpoint catalog exceeds 1 MiB");
    try {
      return documentSchema.parse(JSON.parse(bytes.toString("utf8"))) as EndpointCatalogDocument;
    } catch (error) {
      const issue = error instanceof z.ZodError ? error.issues[0] : undefined;
      const suffix = issue?.code === "unrecognized_keys" ? issue.keys[0] : undefined;
      const path = issue ? [...issue.path, ...(suffix ? [suffix] : [])].join(".") : undefined;
      throw catalogError(`invalid endpoint catalog${path ? ` at ${path}` : ""}`);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw catalogError("endpoint catalog must be a regular owner file with mode 0600");
  } finally {
    await file?.close();
  }
}

function catalogError(message: string): AppError { return new AppError("CONFIGURATION_ERROR", message); }
function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error && error.code === code; }
