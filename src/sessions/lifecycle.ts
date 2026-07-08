import { randomUUID } from "node:crypto";
import type { AppServerPool } from "../app-server/pool.ts";
import type { Clock } from "../core/clock.ts";
import { AppError } from "../core/errors.ts";
import type { MappingIdentity, MappingLifecycleState, RegistrySession, SessionRegistry } from "../registry/session-registry.ts";
import type { RuntimeStore } from "../storage/runtime-store.ts";
import type { PreparedProjectWorkspace, ProjectWorkspacePolicy } from "./project-workspace.ts";
import type { ThreadGate } from "./thread-gate.ts";
import { WorkspaceRouter } from "../endpoints/workspace-router.ts";
import type { EndpointManager } from "../endpoints/manager.ts";
import type { EndpointWorkLease } from "../endpoints/types.ts";
import type { OwnershipInspection } from "./rollout-ownership.ts";

interface ThreadView { id: string; cwd: string; path?: string | null; threadSource?: string | null; status: { type: string }; turns: Array<{ id: string }> }
interface ThreadResponse { thread: ThreadView; cwd?: string; model?: string; reasoningEffort?: string | null }
export interface CurrentSessionSettings { model?: string; effort?: string | null }
export interface LifecycleCheckpoint extends MappingIdentity {
  nickname: string;
  project_dir: string;
  lifecycle_state: MappingLifecycleState;
  step: "transition_intent" | "transitioned" | "native_unsubscribed" | "native_archived" | "removed";
}

interface SessionOwnershipLifecycle {
  initialize(identity: MappingIdentity, path: string, lease?: EndpointWorkLease): Promise<void>;
  inspectIfInitialized?(identity: MappingIdentity, lease?: EndpointWorkLease): Promise<
    { state: "uninitialized" } | OwnershipInspection
  >;
  release(identity: MappingIdentity): void;
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
    private readonly endpoints?: Pick<EndpointManager, "withWorkLease" | "runWithWorkLease">,
    private readonly ownership?: SessionOwnershipLifecycle,
  ) {}

  async create(
    nickname: string,
    endpointId: string,
    project: PreparedProjectWorkspace,
    threadSource: string,
    onThreadCreated?: (thread: ThreadView, settings: CurrentSessionSettings) => void,
    onDispatching?: () => void,
    mappingId = `mapping_${randomUUID()}`,
    existingLease?: EndpointWorkLease,
  ): Promise<CurrentSessionSettings> {
    return this.withMutationLease(endpointId, async (lease) => {
    if (this.registry.get(nickname)) throw new AppError("OPERATION_CONFLICT", `nickname already exists: ${nickname}`);
    await this.assertDispatchable(endpointId, project, lease);
    onDispatching?.();
    const response = await this.pool.request<ThreadResponse>(endpointId, "thread/start", workerThreadStartParams(project.path, threadSource), undefined, lease);
    if (response.thread.threadSource !== threadSource) throw new AppError("OPERATION_UNCERTAIN", "new thread returned an unexpected creation source");
    const settings = this.responseSettings(response);
    onThreadCreated?.(response.thread, settings);
    await this.gate.run(endpointId, response.thread.id, async () => {
      const managedThread = this.ownership && !response.thread.path
        ? (await this.read(endpointId, response.thread.id, lease)).thread
        : response.thread;
      if (managedThread.id !== response.thread.id) throw new AppError("OPERATION_UNCERTAIN", "new thread read returned an unexpected identity");
      await this.assertDispatchable(endpointId, project, lease);
      await this.verifyCwd(endpointId, managedThread.cwd, project.path, lease);
      if (managedThread.status.type !== "idle") throw new AppError("OPERATION_UNCERTAIN", `new thread ${managedThread.id} was created in ${managedThread.status.type} state`);
      const identity = {
        endpoint: endpointId,
        thread_id: response.thread.id,
        project_dir: project.path,
        mapping_id: mappingId,
      };
      try {
        if (this.ownership) await this.ownership.initialize(identity, this.requireRolloutPath(managedThread), lease);
        await this.registry.createManaged(nickname, identity);
      } catch (error) {
        this.ownership?.release(identity);
        throw error;
      }
      this.runtime.setSession(endpointId, managedThread.id, mappingId, "managed", managedThread.status.type);
      this.runtime.beginEpoch(endpointId, managedThread.id, mappingId, this.baseline(managedThread), this.clock.now());
    });
    return settings;
    }, existingLease);
  }

  async adopt(
    nickname: string,
    endpointId: string,
    threadId: string,
    onThreadRead?: (thread: ThreadView) => void,
    mappingId = `mapping_${randomUUID()}`,
    existingLease?: EndpointWorkLease,
  ): Promise<void> {
    await this.withMutationLease(endpointId, (lease) => this.gate.run(endpointId, threadId, async () => {
      this.requireAvailable(nickname, endpointId, threadId);
      const before = await this.read(endpointId, threadId, lease);
      this.requireAdoptableBeforeResume(before.thread);
      const project = await this.prepareExisting(endpointId, before.thread.cwd, lease);
      await this.assertDispatchable(endpointId, project, lease);
      await this.verifyCwd(endpointId, before.thread.cwd, project.path, lease);
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
        await this.pool.request<ThreadResponse>(endpointId, "thread/resume", { threadId }, undefined, lease);
        resumed = true;
        const after = await this.read(endpointId, threadId, lease);
        this.requireIdle(after.thread);
        await this.assertDispatchable(endpointId, project, lease);
        await this.verifyCwd(endpointId, after.thread.cwd, project.path, lease);
        if (this.ownership) await this.ownership.initialize(reserved, this.requireRolloutPath(after.thread), lease);
        await this.registry.promote(nickname, reserved);
        this.runtime.setSession(endpointId, threadId, reserved.mapping_id, "managed", after.thread.status.type);
        this.runtime.beginEpoch(endpointId, threadId, reserved.mapping_id, this.baseline(after.thread), this.clock.now());
      } catch (error) {
        this.ownership?.release(reserved);
        if (resumed) {
          try {
            await this.pool.request(endpointId, "thread/unsubscribe", { threadId }, undefined, lease);
            await this.registry.removeIfMatch(nickname, reserved);
          } catch {
            throw new AppError("OPERATION_UNCERTAIN", "adoption failed and its subscription rollback could not be confirmed");
          }
        }
        throw error;
      }
    }), existingLease);
  }

  async unadopt(
    nickname: string,
    checkpoint?: (value: LifecycleCheckpoint) => void,
    existingLease?: EndpointWorkLease,
  ): Promise<void> {
    const expected = this.requireManaged(nickname);
    await this.withMutationLease(expected.endpoint, (lease) => this.gate.run(expected.endpoint, expected.thread_id, async () => {
      const session = this.assertExact(nickname, expected, "managed");
      const native = await this.read(session.endpoint, session.thread_id, lease);
      this.requireIdle(native.thread);
      checkpoint?.(this.checkpoint(nickname, session, "unadopting", "transition_intent"));
      await this.registry.transition(nickname, session, "unadopting");
      this.runtime.setSession(session.endpoint, session.thread_id, session.mapping_id, "unadopting", native.thread.status.type);
      checkpoint?.(this.checkpoint(nickname, session, "unadopting", "transitioned"));
      await this.pool.request(session.endpoint, "thread/unsubscribe", { threadId: session.thread_id }, undefined, lease);
      checkpoint?.(this.checkpoint(nickname, session, "unadopting", "native_unsubscribed"));
      this.runtime.endEpoch(session.endpoint, session.thread_id, session.mapping_id, this.clock.now());
      if (!await this.registry.removeIfMatch(nickname, session)) throw new AppError("OPERATION_CONFLICT", "session mapping changed during unadoption");
      this.ownership?.release(session);
      checkpoint?.(this.checkpoint(nickname, session, "unadopting", "removed"));
    }), existingLease);
  }

  async archive(nickname: string, checkpoint?: (value: LifecycleCheckpoint) => void): Promise<void> {
    const expected = this.requireManaged(nickname);
    await this.withMutationLease(expected.endpoint, (lease) => this.gate.run(expected.endpoint, expected.thread_id, async () => {
      const session = this.assertExact(nickname, expected, "managed");
      const native = await this.read(session.endpoint, session.thread_id, lease);
      this.requireIdle(native.thread);
      checkpoint?.(this.checkpoint(nickname, session, "archiving", "transition_intent"));
      await this.registry.transition(nickname, session, "archiving");
      this.runtime.setSession(session.endpoint, session.thread_id, session.mapping_id, "archiving", native.thread.status.type);
      checkpoint?.(this.checkpoint(nickname, session, "archiving", "transitioned"));
      await this.pool.request(session.endpoint, "thread/archive", { threadId: session.thread_id }, undefined, lease);
      checkpoint?.(this.checkpoint(nickname, session, "archiving", "native_archived"));
      this.runtime.endEpoch(session.endpoint, session.thread_id, session.mapping_id, this.clock.now());
      if (!await this.registry.removeIfMatch(nickname, session)) throw new AppError("OPERATION_CONFLICT", "session mapping changed during archive");
      this.ownership?.release(session);
      checkpoint?.(this.checkpoint(nickname, session, "archiving", "removed"));
    }));
  }

  async rename(oldNickname: string, newNickname: string): Promise<void> {
    const expected = this.requireManaged(oldNickname);
    await this.gate.run(expected.endpoint, expected.thread_id, async () => {
      const current = this.assertExact(oldNickname, expected, "managed");
      await this.registry.rename(oldNickname, newNickname, current);
    });
  }

  async reconcileAdopting(options: { endpointId?: string; nickname?: string; existingLease?: EndpointWorkLease; onError?(nickname: string, session: RegistrySession, error: unknown): void | Promise<void> } = {}): Promise<void> {
    const entries = Object.entries(this.registry.snapshot().sessions).filter(([nickname, session]) => session.lifecycle_state === "adopting"
      && (options.endpointId === undefined || session.endpoint === options.endpointId)
      && (options.nickname === undefined || nickname === options.nickname));
    for (const [nickname, expected] of entries) {
      try { await this.withMutationLease(expected.endpoint, (lease) => this.gate.run(expected.endpoint, expected.thread_id, async () => {
        const session = this.assertExact(nickname, expected, "adopting");
        const project = await this.prepareExisting(session.endpoint, session.project_dir, lease);
        let resumed = false;
        try {
          await this.assertDispatchable(session.endpoint, project, lease);
          if (project.path !== session.project_dir) throw new AppError("CWD_MISMATCH", "adopting project directory changed");
          const before = await this.read(session.endpoint, session.thread_id, lease);
          this.requireAdoptableBeforeResume(before.thread);
          await this.verifyCwd(session.endpoint, before.thread.cwd, project.path, lease);
          this.assertExact(nickname, expected, "adopting");
          await this.pool.request(session.endpoint, "thread/resume", { threadId: session.thread_id }, undefined, lease);
          resumed = true;
          const afterResume = this.assertExact(nickname, expected, "adopting");
          const native = await this.read(afterResume.endpoint, afterResume.thread_id, lease);
          this.requireIdle(native.thread);
          await this.verifyCwd(session.endpoint, native.thread.cwd, project.path, lease);
          await this.assertDispatchable(session.endpoint, project, lease);
          const promotable = this.assertExact(nickname, expected, "adopting");
          if (this.ownership) await this.ownership.initialize(promotable, this.requireRolloutPath(native.thread), lease);
          await this.registry.promote(nickname, promotable);
          this.runtime.setSession(promotable.endpoint, promotable.thread_id, promotable.mapping_id, "managed", native.thread.status.type);
          if (!this.runtime.currentEpoch(promotable.endpoint, promotable.thread_id, promotable.mapping_id)) {
            this.runtime.beginEpoch(promotable.endpoint, promotable.thread_id, promotable.mapping_id, this.baseline(native.thread), this.clock.now());
          }
        } catch (error) {
          this.ownership?.release(session);
          const current = this.registry.get(nickname);
          if (resumed && current?.lifecycle_state === "adopting" && sameMapping(current, expected)) {
            try {
              await this.pool.request(current.endpoint, "thread/unsubscribe", { threadId: current.thread_id }, undefined, lease);
              if (!await this.registry.removeIfMatch(nickname, current)) throw new Error("adopting reservation changed during rollback");
            } catch {
              throw new AppError("OPERATION_UNCERTAIN", "adoption recovery failed and its subscription rollback could not be confirmed");
            }
          }
          throw error;
        }
      }), options.existingLease); } catch (error) {
        if (!options.onError) throw error;
        await options.onError(nickname, expected, error);
      }
    }
  }

  async reconcileManaged(
    nickname: string,
    expected: RegistrySession,
    existingLease?: EndpointWorkLease,
    canPublish: () => boolean = () => true,
  ): Promise<ThreadResponse> {
    return this.withMutationLease(expected.endpoint, (lease) => this.gate.run(expected.endpoint, expected.thread_id, async () => {
      const assertCurrent = (): void => {
        if (!canPublish()) throw new AppError("ENDPOINT_UNAVAILABLE", "managed recovery generation changed before publication");
      };
      assertCurrent();
      const session = this.assertExact(nickname, expected, "managed");
      const project = await this.prepareExisting(session.endpoint, session.project_dir, lease);
      assertCurrent();
      await this.assertDispatchable(session.endpoint, project, lease);
      assertCurrent();
      if (project.path !== session.project_dir) throw new AppError("CWD_MISMATCH", "managed project directory changed");
      const guarded = await this.ownership?.inspectIfInitialized?.(session, lease);
      assertCurrent();
      if (guarded?.state === "external") {
        throw new AppError("SESSION_BUSY", `thread ${session.thread_id} has an externally started turn`, { recovery: "external_turn" });
      }
      if (guarded?.state === "unclassified") {
        throw new AppError("OPERATION_UNCERTAIN", `thread ${session.thread_id} has a turn whose ownership is not yet classified`, {
          recovery: "ownership_unclassified",
        });
      }
      const before = await this.read(session.endpoint, session.thread_id, lease);
      assertCurrent();
      await this.verifyCwd(session.endpoint, before.thread.cwd, project.path, lease);
      assertCurrent();
      if (this.ownership) {
        await this.ownership.initialize(session, this.requireRolloutPath(before.thread), lease);
        assertCurrent();
      }
      this.assertExact(nickname, expected, "managed");
      const resumed = await this.pool.request<ThreadResponse>(session.endpoint, "thread/resume", { threadId: session.thread_id }, undefined, lease);
      assertCurrent();
      const afterResume = this.assertExact(nickname, expected, "managed");
      const authoritative = await this.read(afterResume.endpoint, afterResume.thread_id, lease);
      assertCurrent();
      await this.verifyCwd(session.endpoint, authoritative.thread.cwd, project.path, lease);
      assertCurrent();
      await this.assertDispatchable(session.endpoint, project, lease);
      assertCurrent();
      const current = this.assertExact(nickname, expected, "managed");
      assertCurrent();
      this.runtime.setSession(current.endpoint, current.thread_id, current.mapping_id, "managed", authoritative.thread.status.type);
      if (!this.runtime.currentEpoch(current.endpoint, current.thread_id, current.mapping_id)) {
        this.runtime.beginEpoch(current.endpoint, current.thread_id, current.mapping_id, this.baseline(authoritative.thread), this.clock.now());
      }
      return { ...resumed, thread: authoritative.thread };
    }), existingLease);
  }

  async reconcileRemovals(options: { endpointId?: string; nickname?: string; onError?(nickname: string, session: RegistrySession, error: unknown): void | Promise<void> } = {}): Promise<void> {
    const entries = Object.entries(this.registry.snapshot().sessions)
      .filter(([nickname, session]) => (session.lifecycle_state === "unadopting" || session.lifecycle_state === "archiving")
        && (options.endpointId === undefined || session.endpoint === options.endpointId)
        && (options.nickname === undefined || nickname === options.nickname));
    for (const [nickname, session] of entries) {
      try { await this.reconcileRemoval(nickname, session); }
      catch (error) {
        if (!options.onError) throw error;
        await options.onError(nickname, session, error);
      }
    }
  }

  async reconcileRemoval(nickname: string, expected: RegistrySession, existingLease?: EndpointWorkLease): Promise<void> {
    await this.withMutationLease(expected.endpoint, (lease) => this.gate.run(expected.endpoint, expected.thread_id, async () => {
      const current = this.registry.get(nickname);
      if (!current || !sameMapping(current, expected)) return;
      if (current.lifecycle_state !== "unadopting" && current.lifecycle_state !== "archiving") return;
      const method = current.lifecycle_state === "unadopting" ? "thread/unsubscribe" : "thread/archive";
      await this.pool.request(current.endpoint, method, { threadId: current.thread_id }, undefined, lease);
      this.runtime.endEpoch(current.endpoint, current.thread_id, current.mapping_id, this.clock.now());
      await this.registry.removeIfMatch(nickname, current);
      this.ownership?.release(current);
    }), existingLease);
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

  private read(endpointId: string, threadId: string, lease?: EndpointWorkLease): Promise<ThreadResponse> {
    return this.pool.request(endpointId, "thread/read", { threadId, includeTurns: true }, undefined, lease);
  }

  private requireIdle(thread: ThreadView): void {
    if (thread.status.type !== "idle") throw new AppError("SESSION_BUSY", `thread ${thread.id} is ${thread.status.type}`);
  }

  private requireAdoptableBeforeResume(thread: ThreadView): void {
    if (thread.status.type !== "idle" && thread.status.type !== "notLoaded") {
      throw new AppError("SESSION_BUSY", `thread ${thread.id} is ${thread.status.type}`);
    }
  }

  private async verifyCwd(endpointId: string, actual: string, expected: string, lease?: EndpointWorkLease): Promise<void> {
    let canonicalActual: string;
    try { canonicalActual = (await this.prepareExisting(endpointId, actual, lease)).path; }
    catch { throw new AppError("CWD_MISMATCH", `thread cwd does not exist: ${actual}`); }
    if (canonicalActual !== expected) throw new AppError("CWD_MISMATCH", `thread cwd ${canonicalActual} does not match ${expected}`);
  }

  private withMutationLease<T>(endpointId: string, run: (lease?: EndpointWorkLease) => Promise<T>, existing?: EndpointWorkLease): Promise<T> {
    if (!this.endpoints) return run(existing);
    return existing
      ? this.endpoints.runWithWorkLease(endpointId, existing, run)
      : this.endpoints.withWorkLease(endpointId, "session-mutation", (_endpoint, lease) => run(lease));
  }
  private prepareExisting(endpointId: string, path: string, lease?: EndpointWorkLease) {
    return this.workspaces instanceof WorkspaceRouter ? this.workspaces.prepareExisting(endpointId, path, lease) : this.workspaces.prepareExisting(path);
  }
  private assertDispatchable(endpointId: string, project: PreparedProjectWorkspace, lease?: EndpointWorkLease) {
    return this.workspaces instanceof WorkspaceRouter ? this.workspaces.assertDispatchable(endpointId, project, lease) : this.workspaces.assertDispatchable(project);
  }

  private baseline(thread: ThreadView): string | undefined { return thread.turns.at(-1)?.id; }
  private responseSettings(response: ThreadResponse): CurrentSessionSettings {
    return {
      ...(typeof response.model === "string" ? { model: response.model } : {}),
      ...(typeof response.reasoningEffort === "string" || response.reasoningEffort === null ? { effort: response.reasoningEffort } : {}),
    };
  }
  private requireRolloutPath(thread: ThreadView): string {
    if (typeof thread.path !== "string" || thread.path.length === 0) throw new AppError("UNSUPPORTED_CAPABILITY", "Codex did not expose the managed thread rollout path");
    return thread.path;
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
