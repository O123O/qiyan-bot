import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { AppServerPool } from "../app-server/pool.ts";
import type { Clock } from "../core/clock.ts";
import { AppError } from "../core/errors.ts";
import type { MappingIdentity, MappingLifecycleState, RegistrySession, SessionRegistry } from "../registry/session-registry.ts";
import type { RuntimeStore } from "../storage/runtime-store.ts";
import type { PreparedProjectWorkspace, ProjectWorkspacePolicy } from "./project-workspace.ts";
import type { ThreadGate } from "./thread-gate.ts";

interface ThreadView { id: string; cwd: string; threadSource?: string | null; status: { type: string }; turns: Array<{ id: string }> }
interface ThreadResponse { thread: ThreadView; cwd?: string; model?: string; reasoningEffort?: string | null }
export interface CurrentSessionSettings { model?: string; effort?: string | null }
export interface LifecycleCheckpoint extends MappingIdentity {
  nickname: string;
  project_dir: string;
  lifecycle_state: MappingLifecycleState;
  step: "transitioned" | "native_unsubscribed" | "native_archived" | "removed";
}

export function workerThreadStartParams(cwd: string, threadSource: string): { cwd: string; ephemeral: false; threadSource: string } {
  return { cwd, ephemeral: false, threadSource };
}

export class SessionLifecycle {
  constructor(
    private readonly pool: AppServerPool,
    private readonly registry: SessionRegistry,
    private readonly runtime: RuntimeStore,
    private readonly clock: Clock,
    private readonly workspaces: Pick<ProjectWorkspacePolicy, "prepareExisting" | "assertDispatchable">,
    private readonly gate: ThreadGate,
  ) {}

  async create(
    nickname: string,
    endpointId: string,
    project: PreparedProjectWorkspace,
    threadSource: string,
    onThreadCreated?: (thread: ThreadView, settings: CurrentSessionSettings) => void,
    onDispatching?: () => void,
    mappingId = `mapping_${randomUUID()}`,
  ): Promise<CurrentSessionSettings> {
    if (this.registry.get(nickname)) throw new AppError("OPERATION_CONFLICT", `nickname already exists: ${nickname}`);
    await this.workspaces.assertDispatchable(project);
    onDispatching?.();
    const response = await this.pool.request<ThreadResponse>(endpointId, "thread/start", workerThreadStartParams(project.path, threadSource));
    if (response.thread.threadSource !== threadSource) throw new AppError("OPERATION_UNCERTAIN", "new thread returned an unexpected creation source");
    const settings = this.responseSettings(response);
    onThreadCreated?.(response.thread, settings);
    await this.gate.run(endpointId, response.thread.id, async () => {
      await this.workspaces.assertDispatchable(project);
      await this.verifyCwd(response.thread.cwd, project.path);
      if (response.thread.status.type !== "idle") throw new AppError("OPERATION_UNCERTAIN", `new thread ${response.thread.id} was created in ${response.thread.status.type} state`);
      await this.registry.createManaged(nickname, {
        endpoint: endpointId,
        thread_id: response.thread.id,
        project_dir: project.path,
        mapping_id: mappingId,
      });
      this.runtime.setSession(endpointId, response.thread.id, mappingId, "managed", response.thread.status.type);
      this.runtime.beginEpoch(endpointId, response.thread.id, mappingId, this.baseline(response.thread), this.clock.now());
    });
    return settings;
  }

  async adopt(
    nickname: string,
    endpointId: string,
    threadId: string,
    onThreadRead?: (thread: ThreadView) => void,
    mappingId = `mapping_${randomUUID()}`,
  ): Promise<void> {
    await this.gate.run(endpointId, threadId, async () => {
      this.requireAvailable(nickname, endpointId, threadId);
      const before = await this.read(endpointId, threadId);
      this.requireIdle(before.thread);
      const project = await this.workspaces.prepareExisting(before.thread.cwd);
      await this.workspaces.assertDispatchable(project);
      await this.verifyCwd(before.thread.cwd, project.path);
      onThreadRead?.(before.thread);
      const reserved: RegistrySession = {
        endpoint: endpointId,
        thread_id: threadId,
        project_dir: project.path,
        mapping_id: mappingId,
        lifecycle_state: "adopting",
      };
      await this.registry.reserve(nickname, reserved);
      this.runtime.setSession(endpointId, threadId, reserved.mapping_id, "adopting", before.thread.status.type);
      let resumed = false;
      try {
        await this.pool.request<ThreadResponse>(endpointId, "thread/resume", { threadId });
        resumed = true;
        const after = await this.read(endpointId, threadId);
        this.requireIdle(after.thread);
        await this.workspaces.assertDispatchable(project);
        await this.verifyCwd(after.thread.cwd, project.path);
        await this.registry.promote(nickname, reserved);
        this.runtime.setSession(endpointId, threadId, reserved.mapping_id, "managed", after.thread.status.type);
        this.runtime.beginEpoch(endpointId, threadId, reserved.mapping_id, this.baseline(after.thread), this.clock.now());
      } catch (error) {
        if (resumed) {
          try {
            await this.pool.request(endpointId, "thread/unsubscribe", { threadId });
            await this.registry.removeIfMatch(nickname, reserved);
          } catch {
            throw new AppError("OPERATION_UNCERTAIN", "adoption failed and its subscription rollback could not be confirmed");
          }
        }
        throw error;
      }
    });
  }

  async unadopt(nickname: string, checkpoint?: (value: LifecycleCheckpoint) => void): Promise<void> {
    const expected = this.requireManaged(nickname);
    await this.gate.run(expected.endpoint, expected.thread_id, async () => {
      const session = this.assertExact(nickname, expected, "managed");
      const native = await this.read(session.endpoint, session.thread_id);
      this.requireIdle(native.thread);
      await this.registry.transition(nickname, session, "unadopting");
      this.runtime.setSession(session.endpoint, session.thread_id, session.mapping_id, "unadopting", native.thread.status.type);
      checkpoint?.(this.checkpoint(nickname, session, "unadopting", "transitioned"));
      await this.pool.request(session.endpoint, "thread/unsubscribe", { threadId: session.thread_id });
      checkpoint?.(this.checkpoint(nickname, session, "unadopting", "native_unsubscribed"));
      this.runtime.endEpoch(session.endpoint, session.thread_id, session.mapping_id, this.clock.now());
      if (!await this.registry.removeIfMatch(nickname, session)) throw new AppError("OPERATION_CONFLICT", "session mapping changed during unadoption");
      checkpoint?.(this.checkpoint(nickname, session, "unadopting", "removed"));
    });
  }

  async archive(nickname: string, checkpoint?: (value: LifecycleCheckpoint) => void): Promise<void> {
    const expected = this.requireManaged(nickname);
    await this.gate.run(expected.endpoint, expected.thread_id, async () => {
      const session = this.assertExact(nickname, expected, "managed");
      const native = await this.read(session.endpoint, session.thread_id);
      this.requireIdle(native.thread);
      await this.registry.transition(nickname, session, "archiving");
      this.runtime.setSession(session.endpoint, session.thread_id, session.mapping_id, "archiving", native.thread.status.type);
      checkpoint?.(this.checkpoint(nickname, session, "archiving", "transitioned"));
      await this.pool.request(session.endpoint, "thread/archive", { threadId: session.thread_id });
      checkpoint?.(this.checkpoint(nickname, session, "archiving", "native_archived"));
      this.runtime.endEpoch(session.endpoint, session.thread_id, session.mapping_id, this.clock.now());
      if (!await this.registry.removeIfMatch(nickname, session)) throw new AppError("OPERATION_CONFLICT", "session mapping changed during archive");
      checkpoint?.(this.checkpoint(nickname, session, "archiving", "removed"));
    });
  }

  async rename(oldNickname: string, newNickname: string): Promise<void> {
    const expected = this.requireManaged(oldNickname);
    await this.gate.run(expected.endpoint, expected.thread_id, async () => {
      const current = this.assertExact(oldNickname, expected, "managed");
      await this.registry.rename(oldNickname, newNickname, current);
    });
  }

  async reconcileAdopting(): Promise<void> {
    const entries = Object.entries(this.registry.snapshot().sessions).filter(([, session]) => session.lifecycle_state === "adopting");
    for (const [nickname, expected] of entries) {
      await this.gate.run(expected.endpoint, expected.thread_id, async () => {
        const session = this.assertExact(nickname, expected, "adopting");
        const project = await this.workspaces.prepareExisting(session.project_dir);
        let resumed = false;
        try {
          await this.workspaces.assertDispatchable(project);
          if (project.path !== session.project_dir) throw new AppError("CWD_MISMATCH", "adopting project directory changed");
          const before = await this.read(session.endpoint, session.thread_id);
          this.requireIdle(before.thread);
          await this.verifyCwd(before.thread.cwd, project.path);
          this.assertExact(nickname, expected, "adopting");
          await this.pool.request(session.endpoint, "thread/resume", { threadId: session.thread_id });
          resumed = true;
          const afterResume = this.assertExact(nickname, expected, "adopting");
          const native = await this.read(afterResume.endpoint, afterResume.thread_id);
          this.requireIdle(native.thread);
          await this.verifyCwd(native.thread.cwd, project.path);
          await this.workspaces.assertDispatchable(project);
          const promotable = this.assertExact(nickname, expected, "adopting");
          await this.registry.promote(nickname, promotable);
          this.runtime.setSession(promotable.endpoint, promotable.thread_id, promotable.mapping_id, "managed", native.thread.status.type);
          if (!this.runtime.currentEpoch(promotable.endpoint, promotable.thread_id, promotable.mapping_id)) {
            this.runtime.beginEpoch(promotable.endpoint, promotable.thread_id, promotable.mapping_id, this.baseline(native.thread), this.clock.now());
          }
        } catch (error) {
          const current = this.registry.get(nickname);
          if (resumed && current?.lifecycle_state === "adopting" && sameMapping(current, expected)) {
            try {
              await this.pool.request(current.endpoint, "thread/unsubscribe", { threadId: current.thread_id });
              if (!await this.registry.removeIfMatch(nickname, current)) throw new Error("adopting reservation changed during rollback");
            } catch {
              throw new AppError("OPERATION_UNCERTAIN", "adoption recovery failed and its subscription rollback could not be confirmed");
            }
          }
          throw error;
        }
      });
    }
  }

  async reconcileManaged(nickname: string, expected: RegistrySession): Promise<ThreadResponse> {
    return this.gate.run(expected.endpoint, expected.thread_id, async () => {
      const session = this.assertExact(nickname, expected, "managed");
      const project = await this.workspaces.prepareExisting(session.project_dir);
      await this.workspaces.assertDispatchable(project);
      if (project.path !== session.project_dir) throw new AppError("CWD_MISMATCH", "managed project directory changed");
      const before = await this.read(session.endpoint, session.thread_id);
      await this.verifyCwd(before.thread.cwd, project.path);
      this.assertExact(nickname, expected, "managed");
      const resumed = await this.pool.request<ThreadResponse>(session.endpoint, "thread/resume", { threadId: session.thread_id });
      const afterResume = this.assertExact(nickname, expected, "managed");
      const authoritative = await this.read(afterResume.endpoint, afterResume.thread_id);
      await this.verifyCwd(authoritative.thread.cwd, project.path);
      await this.workspaces.assertDispatchable(project);
      const current = this.assertExact(nickname, expected, "managed");
      this.runtime.setSession(current.endpoint, current.thread_id, current.mapping_id, "managed", authoritative.thread.status.type);
      if (!this.runtime.currentEpoch(current.endpoint, current.thread_id, current.mapping_id)) {
        this.runtime.beginEpoch(current.endpoint, current.thread_id, current.mapping_id, this.baseline(authoritative.thread), this.clock.now());
      }
      return { ...resumed, thread: authoritative.thread };
    });
  }

  async reconcileRemovals(): Promise<void> {
    const entries = Object.entries(this.registry.snapshot().sessions)
      .filter(([, session]) => session.lifecycle_state === "unadopting" || session.lifecycle_state === "archiving");
    for (const [nickname, session] of entries) await this.reconcileRemoval(nickname, session);
  }

  async reconcileRemoval(nickname: string, expected: RegistrySession): Promise<void> {
    await this.gate.run(expected.endpoint, expected.thread_id, async () => {
      const current = this.registry.get(nickname);
      if (!current || !sameMapping(current, expected)) return;
      if (current.lifecycle_state !== "unadopting" && current.lifecycle_state !== "archiving") return;
      const method = current.lifecycle_state === "unadopting" ? "thread/unsubscribe" : "thread/archive";
      await this.pool.request(current.endpoint, method, { threadId: current.thread_id });
      this.runtime.endEpoch(current.endpoint, current.thread_id, current.mapping_id, this.clock.now());
      await this.registry.removeIfMatch(nickname, current);
    });
  }

  private requireAvailable(nickname: string, endpointId: string, threadId: string): void {
    if (this.registry.get(nickname)) throw new AppError("OPERATION_CONFLICT", `nickname already exists: ${nickname}`);
    if (this.registry.getByIdentity(endpointId, threadId)) throw new AppError("OPERATION_CONFLICT", `thread is already registered: ${threadId}`);
  }

  private requireManaged(nickname: string): RegistrySession {
    const session = this.registry.get(nickname);
    if (!session) throw new AppError("UNKNOWN_SESSION", `unknown session: ${nickname}`);
    if (session.lifecycle_state !== "managed") throw new AppError("OPERATION_CONFLICT", `${nickname} is ${session.lifecycle_state}`);
    return session;
  }

  private assertExact(nickname: string, expected: MappingIdentity, state: MappingLifecycleState): RegistrySession {
    const current = this.registry.get(nickname);
    if (!current || !sameMapping(current, expected)) throw new AppError("OPERATION_CONFLICT", `mapping changed for nickname: ${nickname}`);
    if (current.lifecycle_state !== state) throw new AppError("OPERATION_CONFLICT", `${nickname} is ${current.lifecycle_state}, expected ${state}`);
    return current;
  }

  private read(endpointId: string, threadId: string): Promise<ThreadResponse> {
    return this.pool.request(endpointId, "thread/read", { threadId, includeTurns: true });
  }

  private requireIdle(thread: ThreadView): void {
    if (thread.status.type !== "idle") throw new AppError("SESSION_BUSY", `thread ${thread.id} is ${thread.status.type}`);
  }

  private async verifyCwd(actual: string, expected: string): Promise<void> {
    let canonicalActual: string;
    try { canonicalActual = await realpath(actual); }
    catch { throw new AppError("CWD_MISMATCH", `thread cwd does not exist: ${actual}`); }
    if (canonicalActual !== expected) throw new AppError("CWD_MISMATCH", `thread cwd ${canonicalActual} does not match ${expected}`);
  }

  private baseline(thread: ThreadView): string | undefined { return thread.turns.at(-1)?.id; }
  private responseSettings(response: ThreadResponse): CurrentSessionSettings {
    return {
      ...(typeof response.model === "string" ? { model: response.model } : {}),
      ...(typeof response.reasoningEffort === "string" || response.reasoningEffort === null ? { effort: response.reasoningEffort } : {}),
    };
  }
  private checkpoint(nickname: string, session: RegistrySession, lifecycleState: "unadopting" | "archiving", step: LifecycleCheckpoint["step"]): LifecycleCheckpoint {
    return {
      nickname,
      endpoint: session.endpoint,
      thread_id: session.thread_id,
      project_dir: session.project_dir,
      mapping_id: session.mapping_id,
      lifecycle_state: lifecycleState,
      step,
    };
  }
}

function sameMapping(left: RegistrySession, right: MappingIdentity): boolean {
  return left.endpoint === right.endpoint && left.thread_id === right.thread_id && left.mapping_id === right.mapping_id;
}
