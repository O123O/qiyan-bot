import { open, readFile, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";

const normalizedAbsolutePath = z.string().min(1).refine((path) => isAbsolute(path) && resolve(path) === path, "must be a normalized absolute path");
const assistantSchema = z.object({
  endpoint: z.string().min(1),
  thread_id: z.string().min(1),
  project_dir: normalizedAbsolutePath,
  description: z.string().optional(),
}).strict();

export type MappingLifecycleState = "adopting" | "managed" | "unadopting" | "archiving";
const sessionSchema = assistantSchema.extend({
  mapping_id: z.string().min(1),
  lifecycle_state: z.enum(["adopting", "managed", "unadopting", "archiving"]),
}).strict();
const registrySchema = z.object({
  version: z.literal(3),
  assistant: assistantSchema,
  sessions: z.record(z.string().min(1), sessionSchema),
}).strict();

export type RegistryAssistant = z.infer<typeof assistantSchema>;
export type RegistrySession = z.infer<typeof sessionSchema>;
export type RegistryDocument = z.infer<typeof registrySchema>;
export type MappingIdentity = Pick<RegistrySession, "endpoint" | "thread_id" | "mapping_id">;

async function atomicWriteOne(path: string, value: unknown): Promise<void> {
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

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await atomicWriteOne(`${path}.last-good`, value);
  await atomicWriteOne(path, value);
}

function normalize(document: RegistryDocument): RegistryDocument {
  const parsed = registrySchema.parse(document);
  const seen = new Set<string>();
  for (const session of Object.values(parsed.sessions)) {
    const key = `${session.endpoint}:${session.thread_id}`;
    if (seen.has(key)) throw new Error(`duplicate thread mapping ${key}`);
    seen.add(key);
  }
  return structuredClone(parsed);
}

function sameMapping(left: RegistrySession, right: MappingIdentity): boolean {
  return left.endpoint === right.endpoint && left.thread_id === right.thread_id && left.mapping_id === right.mapping_id;
}

export class SessionRegistry {
  private tail: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string, private document: RegistryDocument, private readonly startupWarnings: string[] = []) {}

  static async open(path: string, initial: RegistryDocument): Promise<SessionRegistry> {
    try {
      const document = normalize(JSON.parse(await readFile(path, "utf8")) as RegistryDocument);
      return new SessionRegistry(path, document);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        let document: RegistryDocument;
        try { document = normalize(JSON.parse(await readFile(`${path}.last-good`, "utf8")) as RegistryDocument); }
        catch { throw new Error("registry is invalid and no valid last-known-good snapshot is available", { cause: error }); }
        await rename(path, `${path}.invalid-${Date.now()}`).catch(() => undefined);
        await atomicWrite(path, document);
        return new SessionRegistry(path, document, ["invalid registry was quarantined and the last-known-good registry was restored"]);
      }
      const document = normalize(initial);
      await atomicWrite(path, document);
      return new SessionRegistry(path, document);
    }
  }

  warnings(): readonly string[] { return [...this.startupWarnings]; }
  snapshot(): RegistryDocument { return structuredClone(this.document); }
  managedSnapshot(): RegistryDocument {
    const document = structuredClone(this.document);
    document.sessions = Object.fromEntries(Object.entries(document.sessions).filter(([, session]) => session.lifecycle_state === "managed"));
    return document;
  }
  get(nickname: string): RegistrySession | undefined {
    const session = this.document.sessions[nickname];
    return session ? structuredClone(session) : undefined;
  }
  getByIdentity(endpoint: string, threadId: string): { nickname: string; session: RegistrySession } | undefined {
    const found = Object.entries(this.document.sessions).find(([, session]) => session.endpoint === endpoint && session.thread_id === threadId);
    return found ? { nickname: found[0], session: structuredClone(found[1]) } : undefined;
  }

  async reserve(nickname: string, session: RegistrySession): Promise<void> {
    await this.lock(async () => {
      if (session.lifecycle_state !== "adopting") throw new Error("new mapping reservation must be adopting");
      this.assertAvailable(nickname, session);
      await this.replace({ ...this.document, sessions: { ...this.document.sessions, [nickname]: structuredClone(session) } });
    });
  }

  async createManaged(nickname: string, session: Omit<RegistrySession, "lifecycle_state"> | RegistrySession): Promise<void> {
    await this.lock(async () => {
      const managed = { ...session, lifecycle_state: "managed" as const };
      this.assertAvailable(nickname, managed);
      await this.replace({ ...this.document, sessions: { ...this.document.sessions, [nickname]: managed } });
    });
  }

  async promote(nickname: string, expected: MappingIdentity): Promise<void> {
    await this.lock(async () => {
      const current = this.requireMatch(nickname, expected);
      if (current.lifecycle_state !== "adopting") throw new Error(`mapping is ${current.lifecycle_state}, expected adopting`);
      await this.replace({ ...this.document, sessions: { ...this.document.sessions, [nickname]: { ...current, lifecycle_state: "managed" } } });
    });
  }

  async transition(nickname: string, expected: MappingIdentity, state: "unadopting" | "archiving"): Promise<void> {
    await this.lock(async () => {
      const current = this.requireMatch(nickname, expected);
      if (current.lifecycle_state !== "managed") throw new Error(`mapping is ${current.lifecycle_state}, expected managed`);
      await this.replace({ ...this.document, sessions: { ...this.document.sessions, [nickname]: { ...current, lifecycle_state: state } } });
    });
  }

  async removeIfMatch(nickname: string, expected: MappingIdentity): Promise<boolean> {
    return this.lock(async () => {
      const current = this.document.sessions[nickname];
      if (!current || !sameMapping(current, expected)) return false;
      const sessions = { ...this.document.sessions };
      delete sessions[nickname];
      await this.replace({ ...this.document, sessions });
      return true;
    });
  }

  async setAssistant(session: RegistryAssistant): Promise<void> {
    await this.lock(async () => { await this.replace({ ...this.document, assistant: structuredClone(session) }); });
  }

  async rename(oldNickname: string, newNickname: string, expected: MappingIdentity): Promise<void> {
    await this.lock(async () => {
      const session = this.requireMatch(oldNickname, expected);
      if (this.document.sessions[newNickname]) throw new Error(`nickname already exists: ${newNickname}`);
      const sessions = { ...this.document.sessions };
      delete sessions[oldNickname];
      sessions[newNickname] = session;
      await this.replace({ ...this.document, sessions });
    });
  }

  private assertAvailable(nickname: string, session: RegistrySession): void {
    if (this.document.sessions[nickname]) throw new Error(`nickname already exists: ${nickname}`);
    if (Object.values(this.document.sessions).some((candidate) => candidate.endpoint === session.endpoint && candidate.thread_id === session.thread_id)) {
      throw new Error(`thread is already registered: ${session.thread_id}`);
    }
  }
  private requireMatch(nickname: string, expected: MappingIdentity): RegistrySession {
    const current = this.document.sessions[nickname];
    if (!current) throw new Error(`unknown nickname: ${nickname}`);
    if (!sameMapping(current, expected)) throw new Error(`mapping changed for nickname: ${nickname}`);
    return current;
  }
  private async replace(document: RegistryDocument): Promise<void> {
    const normalized = normalize(document);
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
