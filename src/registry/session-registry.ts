import { open, readFile, realpath, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";

const sessionSchema = z.object({
  endpoint: z.string().min(1),
  thread_id: z.string().min(1),
  project_dir: z.string().min(1),
  description: z.string().optional(),
});
const registrySchema = z.object({
  version: z.literal(1),
  coordinator: sessionSchema,
  sessions: z.record(z.string().min(1), sessionSchema),
});

export type RegistrySession = z.infer<typeof sessionSchema>;
export type RegistryDocument = z.infer<typeof registrySchema>;

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${crypto.randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function canonicalSession(session: RegistrySession): Promise<RegistrySession> {
  return { ...session, project_dir: await realpath(session.project_dir) };
}

async function normalize(document: RegistryDocument): Promise<RegistryDocument> {
  const parsed = registrySchema.parse(document);
  const sessions: Record<string, RegistrySession> = {};
  const seen = new Set<string>();
  for (const [nickname, session] of Object.entries(parsed.sessions)) {
    const normalized = await canonicalSession(session);
    const key = `${normalized.endpoint}:${normalized.thread_id}`;
    if (seen.has(key)) throw new Error(`duplicate thread mapping ${key}`);
    seen.add(key);
    sessions[nickname] = normalized;
  }
  return { version: 1, coordinator: await canonicalSession(parsed.coordinator), sessions };
}

export class SessionRegistry {
  private tail: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string, private document: RegistryDocument) {}

  static async open(path: string, initial: RegistryDocument): Promise<SessionRegistry> {
    try {
      const document = await normalize(JSON.parse(await readFile(path, "utf8")) as RegistryDocument);
      return new SessionRegistry(path, document);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const document = await normalize(initial);
      await atomicWrite(path, document);
      return new SessionRegistry(path, document);
    }
  }

  snapshot(): RegistryDocument {
    return structuredClone(this.document);
  }

  get(nickname: string): RegistrySession | undefined {
    const session = this.document.sessions[nickname];
    return session ? structuredClone(session) : undefined;
  }

  async register(nickname: string, session: RegistrySession): Promise<void> {
    await this.lock(async () => {
      if (this.document.sessions[nickname]) throw new Error(`nickname already exists: ${nickname}`);
      const normalized = await canonicalSession(session);
      if (Object.values(this.document.sessions).some((candidate) => candidate.endpoint === normalized.endpoint && candidate.thread_id === normalized.thread_id)) {
        throw new Error(`thread is already registered: ${normalized.thread_id}`);
      }
      await this.replace({ ...this.document, sessions: { ...this.document.sessions, [nickname]: normalized } });
    });
  }

  async setCoordinator(session: RegistrySession): Promise<void> {
    await this.lock(async () => {
      await this.replace({ ...this.document, coordinator: await canonicalSession(session) });
    });
  }

  async rename(oldNickname: string, newNickname: string): Promise<void> {
    await this.lock(async () => {
      const session = this.document.sessions[oldNickname];
      if (!session) throw new Error(`unknown nickname: ${oldNickname}`);
      if (this.document.sessions[newNickname]) throw new Error(`nickname already exists: ${newNickname}`);
      const sessions = { ...this.document.sessions };
      delete sessions[oldNickname];
      sessions[newNickname] = session;
      await this.replace({ ...this.document, sessions });
    });
  }

  async reload(): Promise<boolean> {
    try {
      const document = await normalize(JSON.parse(await readFile(this.path, "utf8")) as RegistryDocument);
      this.document = document;
      return true;
    } catch {
      return false;
    }
  }

  private async replace(document: RegistryDocument): Promise<void> {
    const normalized = await normalize(document);
    await atomicWrite(this.path, normalized);
    this.document = normalized;
  }

  private async lock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  }
}
