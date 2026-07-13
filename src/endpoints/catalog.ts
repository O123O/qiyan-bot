import { constants } from "node:fs";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { AppError } from "../core/errors.ts";

const MAX_CATALOG_BYTES = 1024 * 1024;
const endpointId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u).refine((value) => value !== "local" && value !== "assistant-local", "reserved endpoint id");
const projectRoot = z.string().refine((value) => value.startsWith("~/") || isAbsolute(value), "must be absolute or begin with ~/");
const sshAlias = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u, "invalid ssh host alias");
// An endpoint has an orthogonal PROVIDER (codex | claude) and TRANSPORT (local | ssh). Codex only
// runs remotely — a local Codex worker is the built-in `local` endpoint — so codex is ssh-only.
// A claude worker runs either locally (`claude -p` on QiYan's host) or over ssh. `host` is the ssh
// alias (required for ssh, forbidden for local). model/effort/command are claude-only per-endpoint.
const entry = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("codex"), transport: z.literal("ssh"), host: sshAlias, projects_root: projectRoot.optional() }).strict(),
  z.object({
    provider: z.literal("claude"), transport: z.enum(["local", "ssh"]),
    host: sshAlias.optional(), projects_root: projectRoot.optional(),
    command: z.string().min(1).optional(), model: z.string().min(1).optional(), effort: z.string().min(1).optional(),
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.provider !== "claude") return;
  if ((value.transport === "ssh") !== (value.host !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "host is required for ssh transport and forbidden for local", path: ["host"] });
  }
  if (value.transport === "local" && value.projects_root !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "projects_root is not allowed for a local endpoint", path: ["projects_root"] });
  }
});
const documentSchema = z.object({ version: z.literal(1), endpoints: z.record(endpointId, entry) }).strict();

export type EndpointProvider = "codex" | "claude";
export type EndpointTransport = "local" | "ssh";
type RawEntry = z.infer<typeof entry>;

// A resolved catalog entry (projects_root defaulted). `host` is present iff transport is "ssh";
// command/model/effort only for claude.
export interface EndpointDefinition {
  id: string;
  provider: EndpointProvider;
  transport: EndpointTransport;
  host?: string;
  projectsRoot: string;
  command?: string;
  model?: string;
  effort?: string;
}

export interface EndpointCatalogDocument {
  version: 1;
  endpoints: Record<string, RawEntry>;
}

function resolve(id: string, value: RawEntry): EndpointDefinition {
  const projectsRoot = value.projects_root ?? "~/qiyan-projects";
  if (value.provider === "codex") return { id, provider: "codex", transport: "ssh", host: value.host, projectsRoot };
  return {
    id, provider: "claude", transport: value.transport, projectsRoot,
    ...(value.host === undefined ? {} : { host: value.host }),
    ...(value.command === undefined ? {} : { command: value.command }),
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.effort === undefined ? {} : { effort: value.effort }),
  };
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

  require(id: string): EndpointDefinition {
    if (id === "local" || id === "assistant-local") throw new AppError("CONFIGURATION_ERROR", `${id} is a built-in endpoint`);
    const value = this.document.endpoints[id];
    if (!value) throw new AppError("ENDPOINT_UNAVAILABLE", `unknown endpoint: ${id}`);
    return resolve(id, value);
  }

  // All configured endpoints, resolved. Used at startup to build local Claude builtins
  // (transport:"local") and to look up an endpoint's provider.
  definitions(): EndpointDefinition[] {
    return Object.entries(this.document.endpoints).map(([id, value]) => resolve(id, value));
  }
}

async function bootstrap(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const state = await file.stat();
    const expectedUid = process.getuid?.();
    if (!state.isFile() || state.nlink !== 1 || (expectedUid !== undefined && state.uid !== expectedUid)) {
      throw catalogError("endpoint catalog must be a regular owner file with mode 0600");
    }
    if ((state.mode & 0o7777 & ~0o600) !== 0) throw catalogError("endpoint catalog must have mode 0600");
    if (state.size > MAX_CATALOG_BYTES) throw catalogError("endpoint catalog exceeds 1 MiB");
    const bytes = await boundedRead(file);
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

async function boundedRead(file: Awaited<ReturnType<typeof open>>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAX_CATALOG_BYTES) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_CATALOG_BYTES + 1 - total));
    const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > MAX_CATALOG_BYTES) throw catalogError("endpoint catalog exceeds 1 MiB");
  return Buffer.concat(chunks, total);
}

function catalogError(message: string): AppError { return new AppError("CONFIGURATION_ERROR", message); }
function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error && error.code === code; }
