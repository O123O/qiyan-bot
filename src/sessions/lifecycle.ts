import { realpath } from "node:fs/promises";
import type { AppServerPool } from "../app-server/pool.ts";
import type { Clock } from "../core/clock.ts";
import { AppError } from "../core/errors.ts";
import type { ManagementState } from "../core/types.ts";
import type { SessionRegistry } from "../registry/session-registry.ts";
import type { RuntimeStore } from "../storage/runtime-store.ts";
import { secureShellConfig } from "../mcp/server.ts";

interface ThreadView { id: string; cwd: string; status: { type: string }; turns: Array<{ id: string }> }
interface ThreadResponse { thread: ThreadView; cwd?: string; model?: string; reasoningEffort?: string | null }
export interface CurrentSessionSettings { model?: string; effort?: string | null }
interface AttachObservers {
  onResumed?(settings: CurrentSessionSettings): void;
  onThreadRead?(thread: ThreadView): void;
}

export class SessionLifecycle {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly pool: AppServerPool,
    private readonly registry: SessionRegistry,
    private readonly runtime: RuntimeStore,
    private readonly clock: Clock,
    private readonly execution: { sandboxMode: "read-only" | "workspace-write" | "danger-full-access" } = { sandboxMode: "workspace-write" },
  ) {}

  async create(nickname: string, endpointId: string, projectDir: string, onThreadCreated?: (thread: ThreadView, settings: CurrentSessionSettings) => void): Promise<CurrentSessionSettings> {
    return this.lock(`${endpointId}:new:${nickname}`, async () => {
      if (this.registry.get(nickname)) throw new AppError("OPERATION_CONFLICT", `nickname already exists: ${nickname}`);
      const canonical = await realpath(projectDir);
      const response = await this.pool.request<ThreadResponse>(endpointId, "thread/start", {
        cwd: canonical, approvalPolicy: "never", sandbox: this.execution.sandboxMode, config: secureShellConfig(), ephemeral: false,
      });
      const settings = this.responseSettings(response);
      onThreadCreated?.(response.thread, settings);
      await this.verifyCwd(response.thread.cwd, canonical);
      if (response.thread.status.type !== "idle") throw new AppError("OPERATION_UNCERTAIN", `new thread ${response.thread.id} was created in ${response.thread.status.type} state`);
      await this.registry.register(nickname, { endpoint: endpointId, thread_id: response.thread.id, project_dir: canonical });
      this.runtime.setSession(endpointId, response.thread.id, "managed", response.thread.status.type);
      this.runtime.beginEpoch(endpointId, response.thread.id, this.baseline(response.thread), this.clock.now());
      return settings;
    });
  }

  register(nickname: string, endpointId: string, threadId: string, projectDir: string, onThreadRead?: (thread: ThreadView) => void): Promise<void> {
    return this.adopt(nickname, endpointId, threadId, projectDir, onThreadRead);
  }

  async adopt(nickname: string, endpointId: string, threadId: string, projectDir: string, onThreadRead?: (thread: ThreadView) => void): Promise<void> {
    await this.lock(`${endpointId}:${threadId}`, async () => {
      if (this.registry.get(nickname)) throw new AppError("OPERATION_CONFLICT", `nickname already exists: ${nickname}`);
      const canonical = await realpath(projectDir);
      const response = await this.read(endpointId, threadId);
      await this.verifyCwd(response.thread.cwd, canonical);
      this.requireIdle(response.thread);
      onThreadRead?.(response.thread);
      await this.registry.register(nickname, { endpoint: endpointId, thread_id: threadId, project_dir: canonical });
      this.runtime.setSession(endpointId, threadId, "managed", response.thread.status.type);
      this.runtime.beginEpoch(endpointId, threadId, this.baseline(response.thread), this.clock.now());
    });
  }

  async detach(nickname: string): Promise<void> {
    const session = this.required(nickname);
    await this.lock(`${session.endpoint}:${session.thread_id}`, async () => {
      this.requireManagementState(session.endpoint, session.thread_id, ["managed"]);
      const response = await this.read(session.endpoint, session.thread_id);
      this.requireIdle(response.thread);
      this.runtime.setSession(session.endpoint, session.thread_id, "detaching", "idle");
      await this.pool.request(session.endpoint, "thread/unsubscribe", { threadId: session.thread_id });
      this.runtime.endEpoch(session.endpoint, session.thread_id, this.clock.now());
      this.runtime.setSession(session.endpoint, session.thread_id, "detached", "notLoaded");
    });
  }

  async attach(nickname: string, observers: AttachObservers = {}): Promise<CurrentSessionSettings> {
    const session = this.required(nickname);
    return this.lock(`${session.endpoint}:${session.thread_id}`, async () => {
      this.requireManagementState(session.endpoint, session.thread_id, ["detached", "unavailable"]);
      const before = await this.read(session.endpoint, session.thread_id);
      this.requireIdle(before.thread);
      this.runtime.setSession(session.endpoint, session.thread_id, "attaching", "idle");
      let resumed = false;
      try {
        const response = await this.pool.request<ThreadResponse>(session.endpoint, "thread/resume", {
          threadId: session.thread_id, cwd: session.project_dir, approvalPolicy: "never", sandbox: this.execution.sandboxMode, config: secureShellConfig(),
        });
        resumed = true;
        const settings = this.responseSettings(response);
        observers.onResumed?.(settings);
        await this.verifyCwd(response.thread.cwd, session.project_dir);
        const after = await this.read(session.endpoint, session.thread_id);
        this.requireIdle(after.thread);
        observers.onThreadRead?.(after.thread);
        this.runtime.beginEpoch(session.endpoint, session.thread_id, this.baseline(after.thread), this.clock.now());
        this.runtime.setSession(session.endpoint, session.thread_id, "managed", "idle");
        return settings;
      } catch (error) {
        if (resumed) {
          try { await this.pool.request(session.endpoint, "thread/unsubscribe", { threadId: session.thread_id }); }
          catch (rollbackError) {
            throw new AppError("OPERATION_UNCERTAIN", `attach failed and unsubscribe rollback could not be confirmed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
          }
        }
        this.runtime.setSession(session.endpoint, session.thread_id, "detached", before.thread.status.type);
        throw error;
      }
    });
  }

  async archive(nickname: string): Promise<void> {
    const session = this.required(nickname);
    await this.lock(`${session.endpoint}:${session.thread_id}`, async () => {
      this.requireManagementState(session.endpoint, session.thread_id, ["managed", "detached"]);
      const response = await this.read(session.endpoint, session.thread_id);
      this.requireIdle(response.thread);
      await this.pool.request(session.endpoint, "thread/archive", { threadId: session.thread_id });
      this.runtime.endEpoch(session.endpoint, session.thread_id, this.clock.now());
      this.runtime.setSession(session.endpoint, session.thread_id, "archived", "notLoaded");
    });
  }

  async reconcileStartup(only?: { endpointId: string; threadId: string }, attachObservers: AttachObservers = {}): Promise<void> {
    for (const entry of this.runtime.listSessions()) {
      if (only && (entry.endpointId !== only.endpointId || entry.threadId !== only.threadId)) continue;
      if (entry.managementState === "detaching") {
        await this.pool.request(entry.endpointId, "thread/unsubscribe", { threadId: entry.threadId });
        this.runtime.endEpoch(entry.endpointId, entry.threadId, this.clock.now());
        this.runtime.setSession(entry.endpointId, entry.threadId, "detached", "notLoaded");
      } else if (entry.managementState === "attaching") {
        const nickname = this.nicknameFor(entry.endpointId, entry.threadId);
        this.runtime.endEpoch(entry.endpointId, entry.threadId, this.clock.now());
        this.runtime.setSession(entry.endpointId, entry.threadId, "detached", entry.nativeStatus);
        if (nickname) await this.attach(nickname, attachObservers);
      }
    }
  }

  private required(nickname: string) {
    const session = this.registry.get(nickname);
    if (!session) throw new AppError("UNKNOWN_SESSION", `unknown session: ${nickname}`);
    return session;
  }

  private nicknameFor(endpointId: string, threadId: string): string | undefined {
    return Object.entries(this.registry.snapshot().sessions).find(([, value]) => value.endpoint === endpointId && value.thread_id === threadId)?.[0];
  }

  private read(endpointId: string, threadId: string): Promise<ThreadResponse> {
    return this.pool.request(endpointId, "thread/read", { threadId, includeTurns: true });
  }

  private requireIdle(thread: ThreadView): void {
    if (thread.status.type !== "idle") throw new AppError("SESSION_BUSY", `thread ${thread.id} is ${thread.status.type}`);
  }

  private requireManagementState(endpointId: string, threadId: string, allowed: ManagementState[]): void {
    const current = this.runtime.getSession(endpointId, threadId)?.managementState;
    if (!current || !allowed.includes(current)) throw new AppError("OPERATION_CONFLICT", `thread ${threadId} is ${current ?? "unregistered"}, expected ${allowed.join(" or ")}`);
  }

  private async verifyCwd(actual: string, expected: string): Promise<void> {
    let canonicalActual: string;
    try { canonicalActual = await realpath(actual); } catch { throw new AppError("CWD_MISMATCH", `thread cwd does not exist: ${actual}`); }
    if (canonicalActual !== expected) throw new AppError("CWD_MISMATCH", `thread cwd ${canonicalActual} does not match ${expected}`);
  }

  private baseline(thread: ThreadView): string | undefined { return thread.turns.at(-1)?.id; }

  private responseSettings(response: ThreadResponse): CurrentSessionSettings {
    return {
      ...(typeof response.model === "string" ? { model: response.model } : {}),
      ...(typeof response.reasoningEffort === "string" || response.reasoningEffort === null ? { effort: response.reasoningEffort } : {}),
    };
  }

  private async lock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, current);
    await previous;
    try { return await action(); } finally { release(); if (this.tails.get(key) === current) this.tails.delete(key); }
  }
}
