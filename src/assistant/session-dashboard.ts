import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AppError } from "../core/errors.ts";
import type { RegistryDocument } from "../registry/session-registry.ts";
import type { SessionControlStore } from "../storage/session-control-store.ts";
import { SessionDashboardStore } from "../storage/session-dashboard-store.ts";
import {
  SessionDashboardDocumentSchema,
  ExistingSessionDashboardDocumentSchema,
  type SessionDashboardDocument,
  type SessionDashboardEntry,
} from "./dashboard-schema.ts";

interface RegistryView { managedSnapshot(): RegistryDocument }
interface DashboardOptions {
  root: string;
  path: string;
  writer?: (path: string, bytes: Uint8Array | string) => Promise<void>;
}

export class SessionDashboard {
  private tail: Promise<void> = Promise.resolve();
  private readonly writer: (path: string, bytes: Uint8Array | string) => Promise<void>;

  constructor(
    private readonly store: SessionDashboardStore,
    private readonly registry: RegistryView,
    private readonly controls: SessionControlStore,
    private readonly options: DashboardOptions,
  ) {
    this.writer = options.writer ?? writeDashboardAtomic;
  }

  async initializeAndRender(): Promise<void> {
    const registry = this.registry.managedSnapshot();
    if (registry.assistant.project_dir !== this.options.root) {
      throw new AppError("CONFIGURATION_ERROR", "registry assistant workdir does not match the prepared assistant workdir");
    }
    this.store.claimAssistantRoot(this.options.root);
    const state = await dashboardFileState(this.options.path);
    if (state === "special") throw new AppError("CONFIGURATION_ERROR", "assistant dashboard path must be a regular file");
    if (state === "regular") {
      try { ExistingSessionDashboardDocumentSchema.parse(JSON.parse(await readFile(this.options.path, "utf8"))); }
      catch { throw new AppError("CONFIGURATION_ERROR", "invalid assistant dashboard session-status.json"); }
    }
    this.store.markDirty();
    await this.renderIfDirty();
  }

  snapshot(): SessionDashboardDocument {
    const sessions: SessionDashboardDocument["sessions"] = {};
    const registry = this.registry.managedSnapshot();
    for (const nickname of Object.keys(registry.sessions).sort()) {
      const session = registry.sessions[nickname]!;
      const identity = { endpointId: session.endpoint, threadId: session.thread_id };
      const pending = this.controls.settings(session.endpoint, session.thread_id, session.mapping_id);
      const facts = this.store.facts(identity);
      sessions[nickname] = {
        identity: { thread_id: session.thread_id, endpoint: session.endpoint, project_dir: session.project_dir },
        auto_session_info: {
          last_sent: facts.lastSent,
          last_worker_event: facts.lastWorkerEvent,
          model: { current: facts.currentSettings.model, pending: pending.model ?? null },
          reasoning_effort: { current: facts.currentSettings.effort, pending: pending.effort ?? null },
          token_usage: facts.tokenUsage,
          goal: facts.goalObserved ? facts.goal : null,
          observed_at: facts.newestObservationAt === null ? null : new Date(facts.newestObservationAt).toISOString(),
        },
        manager_notes: this.store.notes(identity),
      } satisfies SessionDashboardEntry;
    }
    return SessionDashboardDocumentSchema.parse({ version: 3, sessions });
  }

  status(nickname: string): SessionDashboardEntry & { nickname: string } {
    const entry = this.snapshot().sessions[nickname];
    if (!entry) throw new AppError("UNKNOWN_SESSION", `unknown session: ${nickname}`);
    return { nickname, ...entry };
  }

  renderIfDirty(): Promise<void> {
    const task = this.tail.then(() => this.renderOne(), () => this.renderOne());
    this.tail = task.catch(() => undefined);
    return task;
  }

  async idle(): Promise<void> { await this.tail; }

  private async renderOne(): Promise<void> {
    const state = this.store.renderState();
    if (!state.dirty) return;
    const document = this.snapshot();
    const bytes = `${JSON.stringify(document, null, 2)}\n`;
    try {
      await this.writer(this.options.path, bytes);
      this.store.markRenderSucceeded(state.revision);
    } catch {
      this.store.markRenderFailed("dashboard render failed");
      throw new AppError("CONFIGURATION_ERROR", "dashboard render failed");
    }
  }
}

export async function writeDashboardAtomic(path: string, bytes: Uint8Array | string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o400);
    try {
      await file.writeFile(bytes);
      await file.chmod(0o400);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await unlink(temporary).catch((error) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
  }
}

async function dashboardFileState(path: string): Promise<"missing" | "regular" | "special"> {
  try {
    const value = await lstat(path);
    return value.isFile() && !value.isSymbolicLink() ? "regular" : "special";
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "missing";
    throw error;
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
