import type { EndpointLossKind } from "../endpoints/types.ts";
import type { RegistrySession } from "../registry/session-registry.ts";
import type { NativeSessionStatus } from "./native-session-state.ts";

export const RUNTIME_RESTART_RESUME_MESSAGE =
  "[system] The worker runtime restarted. Resume your previous work if it is not finished; otherwise, no response is needed.";

interface ManagedWorker {
  nickname: string;
  session: RegistrySession;
}

interface InterruptedWorker extends ManagedWorker {
  endpointId: string;
  threadId: string;
  mappingId: string;
}

const keyOf = (session: Pick<RegistrySession, "endpoint" | "thread_id" | "mapping_id">): string =>
  `${session.endpoint}\0${session.thread_id}\0${session.mapping_id}`;

const sameMapping = (session: RegistrySession, target: InterruptedWorker): boolean =>
  session.lifecycle_state === "managed" && session.endpoint === target.endpointId
  && session.thread_id === target.threadId && session.mapping_id === target.mappingId;

export class RuntimeRestartRecovery {
  private readonly pending = new Map<string, InterruptedWorker>();

  constructor(private readonly deps: {
    listManaged(endpointId: string): readonly ManagedWorker[];
    resolve(endpointId: string, threadId: string): ManagedWorker | undefined;
    native(session: RegistrySession): { availability: "ready" | "unavailable"; status: NativeSessionStatus } | undefined;
    enqueueResume(worker: ManagedWorker): void;
    resumeActiveGoal(worker: ManagedWorker): boolean;
  }) {}

  endpointUnavailable(endpointId: string, kind: EndpointLossKind): void {
    if (kind !== "runtime-lost") return;
    for (const worker of this.deps.listManaged(endpointId)) {
      const live = this.deps.native(worker.session);
      if (live?.availability !== "ready" || live.status !== "active") continue;
      this.pending.set(keyOf(worker.session), {
        ...worker,
        endpointId: worker.session.endpoint,
        threadId: worker.session.thread_id,
        mappingId: worker.session.mapping_id,
      });
    }
  }

  endpointReady(endpointId: string): void {
    for (const [key, target] of this.pending) {
      if (target.endpointId !== endpointId) continue;
      const current = this.deps.resolve(target.endpointId, target.threadId);
      if (!current || !sameMapping(current.session, target)) {
        this.pending.delete(key);
        continue;
      }
      const live = this.deps.native(current.session);
      if (live?.availability !== "ready" || (live.status !== "idle" && live.status !== "active")) continue;
      if (live.status === "active") {
        this.pending.delete(key);
        continue;
      }
      if (!this.deps.resumeActiveGoal(current)) this.deps.enqueueResume(current);
      this.pending.delete(key);
    }
  }
}
