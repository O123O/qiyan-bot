import { randomUUID } from "node:crypto";
import type { AppServerPool } from "../app-server/pool.ts";
import type { Clock } from "../core/clock.ts";
import { AppError } from "../core/errors.ts";
import type { MappingIdentity, MappingLifecycleState, RegistrySession, SessionRegistry } from "../registry/session-registry.ts";
import type { ManagedEpochStore } from "../storage/managed-epoch-store.ts";
import type { PreparedProjectWorkspace, ProjectWorkspacePolicy } from "./project-workspace.ts";
import type { ThreadGate } from "./thread-gate.ts";
import { WorkspaceRouter } from "../endpoints/workspace-router.ts";
import type { EndpointManager } from "../endpoints/manager.ts";
import type { EndpointWorkLease } from "../endpoints/types.ts";
import { isExactThreadNoRollout, isExactThreadNotLoaded } from "../app-server/thread-errors.ts";
import type { NativeRefreshToken, NativeSessionIdentity } from "./native-session-state.ts";
import { NativeSessionState } from "./native-session-state.ts";
import { DISCOVERY_SOURCE_KINDS } from "./discovery.ts";

interface ThreadView { id: string; cwd: string; threadSource?: string | null; status: { type: string }; turns: Array<{ id: string; status?: unknown }> }
interface ThreadResponse { thread: ThreadView; cwd?: string; model?: string; reasoningEffort?: string | null }
export interface CurrentSessionSettings { model?: string; effort?: string | null }
export interface LifecycleCheckpoint extends MappingIdentity {
  nickname: string;
  project_dir: string;
  lifecycle_state: MappingLifecycleState;
  step: "transition_intent" | "transitioned" | "native_unsubscribed" | "native_archived" | "removed";
}

export function workerThreadStartParams(cwd: string, threadSource: string): { cwd: string; ephemeral: false; threadSource: string } {
  return { cwd, ephemeral: false, threadSource };
}

export class SessionLifecycle {
  constructor(
    private readonly pool: AppServerPool,
    private readonly registry: SessionRegistry,
    private readonly epochs: ManagedEpochStore,
    private readonly native: NativeSessionState,
    private readonly clock: Clock,
    private readonly workspaces: Pick<ProjectWorkspacePolicy, "prepareExisting" | "assertDispatchable">,
    private readonly gate: ThreadGate,
    private readonly endpoints?: Pick<EndpointManager, "withWorkLease" | "runWithWorkLease">,
    private readonly beforeManagedReady?: (
      identity: MappingIdentity,
      lease?: EndpointWorkLease,
    ) => Promise<void>,
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
    this.requireFreshThread(response.thread, threadSource, project.path);
    const settings = this.responseSettings(response);
    onThreadCreated?.(response.thread, settings);
    await this.gate.run(endpointId, response.thread.id, async () => {
      const identity = {
        endpoint: endpointId,
        thread_id: response.thread.id,
        project_dir: project.path,
        mapping_id: mappingId,
      };
      await this.registry.createManaged(nickname, identity);
      this.observeManaged(identity, response.thread, lease);
      this.epochs.begin(endpointId, response.thread.id, mappingId, this.baseline(response.thread), this.clock.now());
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
      let resumed = false;
      let resumeAttempted = false;
      let reserved: RegistrySession | undefined;
      try {
        const before = await this.readListedMetadata(endpointId, threadId, lease);
        this.requireThreadIdentity(before.thread, threadId);
        const project = await this.prepareExisting(endpointId, before.thread.cwd, lease);
        await this.assertDispatchable(endpointId, project, lease);
        await this.verifyCwd(endpointId, before.thread.cwd, project.path, lease);
        onThreadRead?.(before.thread);
        reserved = {
          endpoint: endpointId,
          thread_id: threadId,
          project_dir: project.path,
          mapping_id: mappingId,
          lifecycle_state: "adopting",
        };
        await this.registry.reserve(nickname, reserved);
        this.epochs.begin(endpointId, threadId, reserved.mapping_id, undefined, this.clock.now(), "from_first_turn");
        const responseToken = this.observeManaged(reserved, before.thread, lease);
        let after = before;
        resumeAttempted = true;
        try {
          const response = await this.pool.request<ThreadResponse>(endpointId, "thread/resume", this.resumeParams(threadId), undefined, lease);
          resumed = true;
          this.requireThreadIdentity(response.thread, threadId);
          after = this.withoutTurns(response);
        } catch (error) {
          if (!isExactThreadNoRollout(error, threadId)) throw error;
          resumeAttempted = false;
          throw this.threadNotDurable(threadId);
        }
        this.requireThreadIdentity(after.thread, threadId);
        this.requireAdoptionOutcome(after.thread, resumed);
        await this.assertDispatchable(endpointId, project, lease);
        await this.verifyCwd(endpointId, after.thread.cwd, project.path, lease);
        await this.registry.promote(nickname, reserved);
        this.applyManagedResponse(responseToken, after.thread);
      } catch (error) {
        if (resumed) {
          try {
            await this.unsubscribeOrConfirmAbsent(endpointId, threadId, lease);
            if (reserved && !await this.registry.removeIfMatch(nickname, reserved)) {
              throw new Error("adopting reservation changed during rollback");
            }
            if (reserved) {
              this.epochs.end(reserved.endpoint, reserved.thread_id, reserved.mapping_id, this.clock.now());
              this.native.unregister(this.nativeIdentity(reserved));
            }
          } catch {
            throw new AppError("OPERATION_UNCERTAIN", "adoption failed and its subscription rollback could not be confirmed");
          }
        } else if (reserved && !resumeAttempted) {
          if (!await this.registry.removeIfMatch(nickname, reserved)) {
            throw new AppError("OPERATION_UNCERTAIN", "adoption failed and its reservation rollback could not be confirmed");
          }
          this.epochs.end(reserved.endpoint, reserved.thread_id, reserved.mapping_id, this.clock.now());
          this.native.unregister(this.nativeIdentity(reserved));
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
      let native: ThreadResponse | undefined;
      try { native = await this.readLight(session.endpoint, session.thread_id, lease); }
      catch (error) {
        // A never-loaded thread OR a never-materialized one (no rollout, e.g. a Claude
        // session created but never driven) has nothing to unsubscribe — just remove it.
        if (!isExactThreadNotLoaded(error, session.thread_id) && !isExactThreadNoRollout(error, session.thread_id)) throw error;
      }
      if (native) this.requireThreadIdentity(native.thread, session.thread_id);
      const alreadyUnsubscribed = native === undefined || native.thread.status.type === "notLoaded";
      if (native && native.thread.status.type !== "notLoaded") this.requireIdle(native.thread);
      checkpoint?.(this.checkpoint(nickname, session, "unadopting", "transition_intent"));
      await this.registry.transition(nickname, session, "unadopting");
      checkpoint?.(this.checkpoint(nickname, session, "unadopting", "transitioned"));
      if (!alreadyUnsubscribed) {
        await this.unsubscribeOrConfirmAbsent(session.endpoint, session.thread_id, lease);
      }
      checkpoint?.(this.checkpoint(nickname, session, "unadopting", "native_unsubscribed"));
      this.epochs.end(session.endpoint, session.thread_id, session.mapping_id, this.clock.now());
      this.native.unregister(this.nativeIdentity(session));
      if (!await this.registry.removeIfMatch(nickname, session)) {
        throw new AppError("OPERATION_UNCERTAIN", "native unadoption completed but the exact session mapping was not removed");
      }
      checkpoint?.(this.checkpoint(nickname, session, "unadopting", "removed"));
    }), existingLease);
  }

  async archive(nickname: string, checkpoint?: (value: LifecycleCheckpoint) => void): Promise<void> {
    const expected = this.requireManaged(nickname);
    await this.withMutationLease(expected.endpoint, (lease) => this.gate.run(expected.endpoint, expected.thread_id, async () => {
      const session = this.assertExact(nickname, expected, "managed");
      // A never-materialized thread (no durable rollout) has nothing to read, verify, or
      // natively archive — dropping the dangling registry entry is the whole operation. A
      // Claude session created but never driven a turn is the case this hits (Codex
      // materializes its rollout at create).
      let native: ThreadResponse | undefined;
      try { native = await this.readLight(session.endpoint, session.thread_id, lease); }
      catch (error) { if (!isExactThreadNoRollout(error, session.thread_id)) throw error; }
      if (native) this.requireIdle(native.thread);
      checkpoint?.(this.checkpoint(nickname, session, "archiving", "transition_intent"));
      await this.registry.transition(nickname, session, "archiving");
      checkpoint?.(this.checkpoint(nickname, session, "archiving", "transitioned"));
      if (native) await this.pool.request(session.endpoint, "thread/archive", { threadId: session.thread_id }, undefined, lease);
      checkpoint?.(this.checkpoint(nickname, session, "archiving", "native_archived"));
      this.epochs.end(session.endpoint, session.thread_id, session.mapping_id, this.clock.now());
      this.native.unregister(this.nativeIdentity(session));
      if (!await this.registry.removeIfMatch(nickname, session)) {
        throw new AppError("OPERATION_UNCERTAIN", "native archive completed but the exact session mapping was not removed");
      }
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
          if (!this.epochs.current(session.endpoint, session.thread_id, session.mapping_id)) {
            this.epochs.begin(session.endpoint, session.thread_id, session.mapping_id, undefined, this.clock.now(), "from_first_turn");
          }
          const responseToken = this.captureManagedRefresh(session, lease);
          await this.assertDispatchable(session.endpoint, project, lease);
          if (project.path !== session.project_dir) throw new AppError("CWD_MISMATCH", "adopting project directory changed");
          this.assertExact(nickname, expected, "adopting");
          let native: ThreadResponse;
          try {
            const response = await this.pool.request<ThreadResponse>(session.endpoint, "thread/resume", this.resumeParams(session.thread_id), undefined, lease);
            resumed = true;
            this.requireThreadIdentity(response.thread, session.thread_id);
            this.assertExact(nickname, expected, "adopting");
            native = this.withoutTurns(response);
          } catch (error) {
            if (!isExactThreadNoRollout(error, session.thread_id)) throw error;
            const current = this.assertExact(nickname, expected, "adopting");
            this.epochs.end(current.endpoint, current.thread_id, current.mapping_id, this.clock.now());
            this.native.unregister(this.nativeIdentity(current));
            if (!await this.registry.removeIfMatch(nickname, current)) {
              throw new AppError("OPERATION_UNCERTAIN", "unrestorable adoption mapping changed before removal");
            }
            throw this.threadNotDurable(session.thread_id);
          }
          this.requireThreadIdentity(native.thread, session.thread_id);
          this.requireAdoptionOutcome(native.thread, true);
          await this.verifyCwd(session.endpoint, native.thread.cwd, project.path, lease);
          await this.assertDispatchable(session.endpoint, project, lease);
          const promotable = this.assertExact(nickname, expected, "adopting");
          await this.registry.promote(nickname, promotable);
          if (resumed) this.applyManagedResponse(responseToken, native.thread);
        } catch (error) {
          const current = this.registry.get(nickname);
          if (resumed && current?.lifecycle_state === "adopting" && sameMapping(current, expected)) {
            try {
              await this.unsubscribeOrConfirmAbsent(current.endpoint, current.thread_id, lease);
              if (!await this.registry.removeIfMatch(nickname, current)) throw new Error("adopting reservation changed during rollback");
              this.epochs.end(current.endpoint, current.thread_id, current.mapping_id, this.clock.now());
              this.native.unregister(this.nativeIdentity(current));
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
    options?: { resumeForConnection?: boolean; requireRestorable?: boolean },
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
      let resumed: ThreadResponse | undefined;
      const resumeForConnection = options?.resumeForConnection === true;
      // Managed recovery needs metadata and, for a replacement connection, a live subscription.
      // Historical delivery repair is owned independently by EventRelay and must never block the
      // endpoint lifecycle by loading a large rollout here.
      let before: ThreadResponse;
      try {
        before = await this.readLight(session.endpoint, session.thread_id, lease);
      } catch (error) {
        if (options?.requireRestorable && isExactThreadNoRollout(error, session.thread_id)) {
          await this.rejectUnrestorableManaged(nickname, session, assertCurrent);
        }
        if (!isExactThreadNotLoaded(error, session.thread_id)) throw error;
        try {
          resumed = await this.pool.request<ThreadResponse>(
            session.endpoint,
            "thread/resume",
            this.resumeParams(session.thread_id),
            undefined,
            lease,
          );
        } catch (resumeError) {
          if (options?.requireRestorable && isExactThreadNoRollout(resumeError, session.thread_id)) {
            await this.rejectUnrestorableManaged(nickname, session, assertCurrent);
          }
          throw resumeError;
        }
        assertCurrent();
        this.requireThreadIdentity(resumed.thread, session.thread_id);
        before = this.withoutTurns(resumed);
      }
      assertCurrent();
      this.requireThreadIdentity(before.thread, session.thread_id);
      await this.verifyCwd(session.endpoint, before.thread.cwd, project.path, lease);
      assertCurrent();
      // Publish native state before the remaining managed-session recovery work. The active turn
      // identity is learned from live turn/item notifications, not reconstructed history.
      if (before.thread.status.type === "active") {
        this.observeManaged(session, before.thread, lease);
      }
      await this.beforeManagedReady?.(session, lease);
      assertCurrent();
      this.assertExact(nickname, expected, "managed");
      let authoritative = before;
      // Loaded state is not a subscription: every replacement remote connection must explicitly
      // resume once, including when the native thread is active.
      if (!resumed && (resumeForConnection || this.requiresManagedResume(before.thread))) {
        resumed = await this.pool.request<ThreadResponse>(
          session.endpoint,
          "thread/resume",
          this.resumeParams(session.thread_id),
          undefined,
          lease,
        );
        assertCurrent();
        this.requireThreadIdentity(resumed.thread, session.thread_id);
        const afterResume = this.assertExact(nickname, expected, "managed");
        authoritative = this.withoutTurns(resumed);
      }
      assertCurrent();
      this.requireThreadIdentity(authoritative.thread, session.thread_id);
      await this.verifyCwd(session.endpoint, authoritative.thread.cwd, project.path, lease);
      assertCurrent();
      await this.assertDispatchable(session.endpoint, project, lease);
      assertCurrent();
      const current = this.assertExact(nickname, expected, "managed");
      assertCurrent();
      this.observeManaged(current, authoritative.thread, lease);
      if (!this.epochs.current(current.endpoint, current.thread_id, current.mapping_id)) {
        this.epochs.begin(
          current.endpoint,
          current.thread_id,
          current.mapping_id,
          undefined,
          this.clock.now(),
          "from_first_turn",
        );
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
      if (current.lifecycle_state === "unadopting") {
        let alreadyUnsubscribed = false;
        try {
          const native = await this.readLight(current.endpoint, current.thread_id, lease);
          this.requireThreadIdentity(native.thread, current.thread_id);
          alreadyUnsubscribed = native.thread.status.type === "notLoaded";
        } catch (error) {
          // Tolerate a thread that was never loaded or never materialized (no rollout):
          // there is nothing to unsubscribe, so treat it as already absent and remove it.
          if (!isExactThreadNotLoaded(error, current.thread_id) && !isExactThreadNoRollout(error, current.thread_id)) throw error;
          alreadyUnsubscribed = true;
        }
        if (!alreadyUnsubscribed) {
          await this.unsubscribeOrConfirmAbsent(current.endpoint, current.thread_id, lease);
        }
      } else {
        await this.pool.request(current.endpoint, "thread/archive", { threadId: current.thread_id }, undefined, lease);
      }
      this.epochs.end(current.endpoint, current.thread_id, current.mapping_id, this.clock.now());
      this.native.unregister(this.nativeIdentity(current));
      if (!await this.registry.removeIfMatch(nickname, current)) {
        throw new AppError("OPERATION_UNCERTAIN", "native removal completed but the exact session mapping was not removed");
      }
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

  // Metadata-only read (status and cwd) — does NOT ask for turns, so codex/claude never
  // re-materializes the whole rollout. Used by managed recovery to check a thread's status cheaply
  // before deciding whether the (rare) full read is actually needed.
  private async readLight(endpointId: string, threadId: string, lease?: EndpointWorkLease): Promise<ThreadResponse> {
    const response = await this.pool.request<ThreadResponse>(endpointId, "thread/read", { threadId, includeTurns: false }, undefined, lease);
    // includeTurns:false does not return turns; normalize to [] (as the `read` fallback does) so callers
    // treat it as an unmaterialized view and never mistake it for "has turns".
    return { ...response, thread: { ...response.thread, turns: [] } };
  }

  private async readListedMetadata(endpointId: string, threadId: string, lease?: EndpointWorkLease): Promise<ThreadResponse> {
    for (const archived of [false, true]) {
      let cursor: string | undefined;
      const seen = new Set<string>();
      let complete = false;
      for (let pageNumber = 0; pageNumber < 64; pageNumber += 1) {
        const page = await this.pool.request<{ data: ThreadView[]; nextCursor?: string | null }>(endpointId, "thread/list", {
          ...(cursor === undefined ? {} : { cursor }),
          limit: 100,
          sortKey: "updated_at",
          sortDirection: "desc",
          sourceKinds: [...DISCOVERY_SOURCE_KINDS],
          archived,
          useStateDbOnly: true,
        }, undefined, lease);
        const thread = page.data.find((candidate) => candidate.id === threadId);
        if (thread) return { thread: { ...thread, turns: [] } };
        const next = page.nextCursor ?? undefined;
        if (next === undefined) {
          complete = true;
          break;
        }
        if (seen.has(next)) throw new AppError("OPERATION_UNCERTAIN", "thread metadata pagination repeated a cursor");
        seen.add(next);
        cursor = next;
      }
      if (!complete) throw new AppError("OPERATION_UNCERTAIN", "thread metadata scan exceeded its page limit");
    }
    throw this.threadNotDurable(threadId);
  }

  private resumeParams(threadId: string): { threadId: string; excludeTurns: true } {
    return { threadId, excludeTurns: true };
  }

  private withoutTurns(response: ThreadResponse): ThreadResponse {
    return { ...response, thread: { ...response.thread, turns: [] } };
  }

  private requireIdle(thread: ThreadView): void {
    if (thread.status.type !== "idle") throw new AppError("SESSION_BUSY", `thread ${thread.id} is ${thread.status.type}`);
  }

  private requireAdoptionOutcome(thread: ThreadView, allowReservedActive: boolean): void {
    // Resuming an idle thread with a persisted active goal can immediately start its next turn.
    // Active state returned after the durable reservation belongs to the managed mapping.
    if (thread.status.type !== "idle" && !(allowReservedActive && thread.status.type === "active")) {
      throw new AppError("SESSION_BUSY", `thread ${thread.id} is ${thread.status.type}`);
    }
  }

  private requiresManagedResume(thread: ThreadView): boolean {
    return thread.status.type !== "active" && (thread.status.type === "notLoaded" || thread.turns.length > 0);
  }

  private threadNotDurable(threadId: string): AppError {
    return new AppError("THREAD_NOT_FOUND", "thread is no longer restorable because it has no durable rollout", {
      recovery: "thread_not_durable", threadId,
    });
  }

  private async rejectUnrestorableManaged(
    nickname: string,
    session: RegistrySession,
    assertCurrent: () => void,
  ): Promise<never> {
    assertCurrent();
    this.assertExact(nickname, session, "managed");
    this.epochs.end(session.endpoint, session.thread_id, session.mapping_id, this.clock.now());
    this.native.unregister(this.nativeIdentity(session));
    if (!await this.registry.removeIfMatch(nickname, session)) {
      throw new AppError("OPERATION_UNCERTAIN", "unrestorable native thread mapping changed before removal");
    }
    throw this.threadNotDurable(session.thread_id);
  }

  private requireThreadIdentity(thread: ThreadView, threadId: string): void {
    if (thread.id !== threadId) throw new AppError("OPERATION_UNCERTAIN", "thread recovery returned an unexpected identity");
  }

  private requireFreshThread(thread: ThreadView, threadSource: string, cwd: string, threadId?: string): void {
    if (typeof thread.id !== "string" || thread.id.length === 0 || (threadId !== undefined && thread.id !== threadId)) {
      throw new AppError("OPERATION_UNCERTAIN", "new thread returned an unexpected identity");
    }
    if (thread.threadSource !== threadSource) {
      throw new AppError("OPERATION_UNCERTAIN", "new thread returned an unexpected creation source");
    }
    if (thread.cwd !== cwd) throw new AppError("CWD_MISMATCH", "new thread returned an unexpected cwd");
    if (thread.status.type !== "idle") {
      throw new AppError("OPERATION_UNCERTAIN", `new thread ${thread.id} was created in ${thread.status.type} state`);
    }
    if (!Array.isArray(thread.turns) || thread.turns.length !== 0) {
      throw new AppError("OPERATION_UNCERTAIN", "new thread response unexpectedly contained turns");
    }
  }

  private async unsubscribeOrConfirmAbsent(endpointId: string, threadId: string, lease?: EndpointWorkLease): Promise<void> {
    try { await this.pool.request(endpointId, "thread/unsubscribe", { threadId }, undefined, lease); }
    catch (error) {
      if (!isExactThreadNotLoaded(error, threadId)) throw error;
    }
  }

  private async verifyCwd(endpointId: string, actual: string, expected: string, lease?: EndpointWorkLease): Promise<void> {
    // The thread's reported cwd almost always already equals the canonical project path the caller
    // resolved (`expected`). When the strings are identical there is nothing to canonicalize — the
    // path was already resolved and validated by the caller — so skip the remote resolution
    // (multiple ssh round-trips over a recovery). Only a genuine drift or a non-canonical cwd string
    // (`actual !== expected`) needs canonicalization to compare fairly.
    if (actual === expected) return;
    let canonicalActual: string;
    try { canonicalActual = (await this.prepareExisting(endpointId, actual, lease)).path; }
    catch (error) {
      if (error instanceof AppError && error.code === "CONFIGURATION_ERROR") {
        throw new AppError("CWD_MISMATCH", "thread cwd could not be verified");
      }
      throw error;
    }
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

  private nativeIdentity(identity: MappingIdentity): NativeSessionIdentity {
    return { endpointId: identity.endpoint, threadId: identity.thread_id, mappingId: identity.mapping_id };
  }

  private observeManaged(
    identity: MappingIdentity,
    thread: ThreadView,
    lease?: EndpointWorkLease,
    knownActiveTurnId?: string,
  ): NativeRefreshToken {
    const token = this.captureManagedRefresh(identity, lease);
    const nativeIdentity = this.nativeIdentity(identity);
    const generation = token.endpointGeneration;
    const activeTurnId = thread.status.type === "active"
      ? knownActiveTurnId ?? [...thread.turns].reverse().find((turn) => !isTerminalTurnStatus(turn.status))?.id ?? null
      : null;
    this.native.applyRefresh(token, { status: thread.status.type, activeTurnId });
    return this.native.captureRefresh(nativeIdentity, generation);
  }

  private captureManagedRefresh(identity: MappingIdentity, lease?: EndpointWorkLease): NativeRefreshToken {
    const generation = lease?.endpointGeneration ?? this.pool.endpointGeneration(identity.endpoint).generation;
    const nativeIdentity = this.nativeIdentity(identity);
    const existing = this.native.view(nativeIdentity);
    if (!existing || existing.endpointGeneration !== generation || existing.availability !== "ready") {
      this.native.register(nativeIdentity, generation);
    }
    return this.native.captureRefresh(nativeIdentity, generation);
  }

  private applyManagedResponse(token: NativeRefreshToken, thread: ThreadView): boolean {
    const activeTurnId = thread.status.type === "active"
      ? [...thread.turns].reverse().find((turn) => !isTerminalTurnStatus(turn.status))?.id ?? undefined
      : null;
    return this.native.applyRefresh(token, {
      status: thread.status.type,
      ...(activeTurnId === undefined ? {} : { activeTurnId }),
    });
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

function isTerminalTurnStatus(status: unknown): boolean {
  const value = typeof status === "string" ? status : String((status as { type?: unknown } | undefined)?.type ?? "");
  return value === "completed" || value === "failed" || value === "interrupted";
}
