import { AppError } from "../core/errors.ts";
import { RpcRequestTimeoutError } from "../app-server/rpc-client.ts";
import type { SshEndpointDefinition } from "./catalog.ts";
import { EndpointAdmissionGate, type EndpointDesiredState } from "./admission-gate.ts";
import type { PendingDestinationBinding } from "./ssh-config.ts";
import type { EndpointLossKind, EndpointWorkLease, ManagedAppServerEndpoint, RuntimeIdentity } from "./types.ts";

interface CatalogReader {
  reload(): Promise<void>;
  require(id: string): SshEndpointDefinition;
}

interface ActivationCandidate {
  endpoint: ManagedAppServerEndpoint;
  pendingBinding?: PendingDestinationBinding;
}

interface ShutdownTarget {
  endpoint: ManagedAppServerEndpoint;
  identity: RuntimeIdentity;
  startedForProof: boolean;
}

interface ScheduledWork { cancel(): void }

interface EndpointRecord {
  readonly gate: EndpointAdmissionGate;
  endpoint?: ManagedAppServerEndpoint;
  generation: number;
  activation?: Promise<ManagedAppServerEndpoint>;
  subscriptions: Array<() => void>;
  reconnect?: ScheduledWork;
  reconnectAttempt: number;
  lifecycle?: Promise<void>;
}

export class EndpointManager {
  private readonly records = new Map<string, EndpointRecord>();
  private readonly endpointListeners = new Set<(endpoint: ManagedAppServerEndpoint, generation: number) => void>();
  // Eager, always-ready endpoints resolved directly (no catalog, no daemon): "local"
  // plus any extra built-ins (e.g. a local Claude endpoint). Registering them here is
  // what lets leased mutations (withWorkLease → ensureReady → prepareCandidate)
  // resolve them, instead of falling through to catalog.require and throwing.
  private readonly builtins = new Map<string, ManagedAppServerEndpoint>();
  private closing = false;

  constructor(private readonly options: {
    localEndpoint: ManagedAppServerEndpoint;
    builtinEndpoints?: readonly ManagedAppServerEndpoint[];
    catalog: CatalogReader;
    createRemote(definition: SshEndpointDefinition, hasReferences: boolean): Promise<ActivationCandidate>;
    hasIdentityReferences(endpointId: string): boolean | Promise<boolean>;
    commitBinding?(binding: PendingDestinationBinding, hasReferences: boolean): void | Promise<void>;
    managedThreadIds(endpointId: string): readonly string[] | Promise<readonly string[]>;
    schedule?(delayMs: number, run: () => void): ScheduledWork;
  }) {
    this.builtins.set("local", options.localEndpoint);
    for (const endpoint of options.builtinEndpoints ?? []) this.builtins.set(endpoint.id, endpoint);
    for (const [id, endpoint] of this.builtins) this.records.set(id, this.newRecord(id, endpoint));
  }

  normalize(id?: string): string { return id ?? "local"; }

  async ensureReady(id?: string): Promise<ManagedAppServerEndpoint> {
    if (this.closing) throw new AppError("ENDPOINT_UNAVAILABLE", "endpoint manager is shutting down");
    const endpointId = this.normalize(id);
    const record = this.record(endpointId);
    if (record.gate.desiredState === "draining") throw new AppError("ENDPOINT_UNAVAILABLE", `endpoint is draining: ${endpointId}`);
    record.gate.requestAutomatic();
    try { return await this.activate(endpointId, false); }
    catch (error) {
      this.scheduleActivationRetry(endpointId, record);
      throw error;
    }
  }

  async withWorkLease<T>(
    id: string | undefined,
    _kind: "rpc" | "session-mutation" | "file-transfer",
    run: (endpoint: ManagedAppServerEndpoint, lease: EndpointWorkLease) => Promise<T>,
  ): Promise<T> {
    const endpointId = this.normalize(id);
    const endpoint = await this.ensureReady(endpointId);
    const record = this.record(endpointId);
    const generation = record.generation;
    const lease = record.gate.acquire(generation);
    try {
      if (record.endpoint !== endpoint || record.generation !== generation || endpoint.state !== "ready") {
        throw new AppError("ENDPOINT_UNAVAILABLE", `endpoint generation changed before work began: ${endpointId}`);
      }
      return await run(endpoint, lease);
    } finally {
      record.gate.release(lease);
    }
  }

  async withReadyWorkLease<T>(
    id: string | undefined,
    run: (lease: EndpointWorkLease) => Promise<T>,
  ): Promise<T> {
    const endpointId = this.normalize(id);
    if (this.closing) throw new AppError("ENDPOINT_UNAVAILABLE", "endpoint manager is shutting down");
    const record = this.records.get(endpointId);
    const endpoint = record?.endpoint;
    if (!record || !endpoint || record.generation === 0 || endpoint.state !== "ready") {
      throw new AppError("ENDPOINT_UNAVAILABLE", `endpoint is unavailable: ${endpointId}`);
    }
    const generation = record.generation;
    const lease = record.gate.acquire(generation);
    try {
      if (this.records.get(endpointId) !== record || record.endpoint !== endpoint
        || record.generation !== generation || endpoint.state !== "ready"
        || !record.gate.validate(lease, generation)) {
        throw new AppError("ENDPOINT_UNAVAILABLE", `endpoint generation changed before work began: ${endpointId}`);
      }
      return await run(lease);
    } finally {
      record.gate.release(lease);
    }
  }

  async runWithWorkLease<T>(
    endpointId: string,
    existing: EndpointWorkLease | undefined,
    run: (lease: EndpointWorkLease | undefined) => Promise<T>,
  ): Promise<T> {
    if (existing) {
      if (!this.validateWorkLease(existing, endpointId)) throw new AppError("ENDPOINT_UNAVAILABLE", `invalid endpoint work lease: ${endpointId}`);
      return run(existing);
    }
    return this.withWorkLease(endpointId, "rpc", (_endpoint, lease) => run(lease));
  }

  async runWithReadyWorkLease<T>(
    endpointId: string,
    existing: EndpointWorkLease | undefined,
    run: (lease: EndpointWorkLease | undefined) => Promise<T>,
  ): Promise<T> {
    if (existing) {
      if (!this.validateReadyWorkLease(existing, endpointId)) {
        throw new AppError("ENDPOINT_UNAVAILABLE", `endpoint is unavailable for existing work lease: ${endpointId}`);
      }
      return run(existing);
    }
    return this.withWorkLease(endpointId, "rpc", (_endpoint, lease) => run(lease));
  }

  validateWorkLease(lease: EndpointWorkLease, endpointId: string): boolean {
    const record = this.records.get(endpointId);
    return record !== undefined && record.generation === lease.endpointGeneration && record.gate.validate(lease, record.generation);
  }

  validateReadyWorkLease(lease: EndpointWorkLease, endpointId: string): boolean {
    const record = this.records.get(endpointId);
    return record?.endpoint?.state === "ready" && record.generation === lease.endpointGeneration
      && record.gate.validate(lease, record.generation);
  }

  endpointGeneration(id: string): { endpoint: ManagedAppServerEndpoint; generation: number } {
    const record = this.records.get(id);
    if (!record?.endpoint || record.generation === 0) throw new AppError("ENDPOINT_UNAVAILABLE", `endpoint is unavailable: ${id}`);
    return { endpoint: record.endpoint, generation: record.generation };
  }

  async activateReferenced(ids: readonly string[]): Promise<{ unavailable: string[] }> {
    const unavailable: string[] = [];
    for (const id of [...new Set(ids)]) {
      try { await this.ensureReady(id); }
      catch { unavailable.push(id); }
    }
    return { unavailable };
  }

  async disconnect(id?: string, checkpoint?: (value: unknown) => void): Promise<void> {
    const endpointId = this.normalize(id);
    const record = this.record(endpointId);
    return this.enqueueLifecycle(record, () => this.disconnectInternal(endpointId, record, checkpoint));
  }

  private async disconnectInternal(endpointId: string, record: EndpointRecord, checkpoint?: (value: unknown) => void): Promise<void> {
    if (record.gate.desiredState === "disconnected") return;
    this.cancelReconnect(record);
    const drain = await record.gate.beginDrain();
    let target: ShutdownTarget | undefined;
    let runtimeStopped = false;
    try {
      target = await this.shutdownTarget(endpointId, record);
      checkpoint?.({ phase: "draining", identity: target.identity });
      await this.requireManagedThreadsIdle(endpointId, target.endpoint);
      checkpoint?.({ phase: "idle_proven", identity: target.identity });
      await target.endpoint.shutdownRuntime(target.identity);
      runtimeStopped = true;
      checkpoint?.({ phase: "runtime_stopped", identity: target.identity });
      drain.disconnect();
    } catch (error) {
      this.reopenAfterLifecycleFailure(record, drain, !runtimeStopped && target?.startedForProof ? target.endpoint : undefined);
      throw error;
    }
  }

  async restart(id?: string, checkpoint?: (value: unknown) => void): Promise<void> {
    const endpointId = this.normalize(id);
    const record = this.record(endpointId);
    return this.enqueueLifecycle(record, () => this.restartInternal(endpointId, record, checkpoint));
  }

  async recoverDisconnect(
    id: string,
    phase: "draining" | "idle_proven" | "runtime_stopped",
    expectedIdentity: RuntimeIdentity,
    checkpoint?: (value: unknown) => void,
  ): Promise<void> {
    const record = this.record(id);
    return this.enqueueLifecycle(record, async () => {
      if (record.gate.desiredState === "disconnected") return;
      this.cancelReconnect(record);
      const drain = await record.gate.beginDrain();
      let proofEndpoint: ManagedAppServerEndpoint | undefined;
      let startedForProof = false;
      let runtimeStopped = false;
      let candidateEndpoint: ManagedAppServerEndpoint | undefined;
      let candidateWasNew = false;
      try {
        const candidate = record.endpoint ? { endpoint: record.endpoint } : await this.prepareCandidate(id);
        candidateEndpoint = candidate.endpoint;
        candidateWasNew = record.endpoint !== candidate.endpoint;
        const actual = await candidate.endpoint.runtimeIdentity();
        if (!actual) {
          await candidate.endpoint.closeConnection();
          if (phase !== "runtime_stopped") checkpoint?.({ phase: "runtime_stopped", identity: expectedIdentity });
          drain.disconnect();
          return;
        }
        if (!sameRuntimeIdentity(actual, expectedIdentity)) throw new AppError("OPERATION_UNCERTAIN", `checkpointed runtime identity changed: ${id}`);
        let endpoint = candidate.endpoint;
        if ((await this.options.managedThreadIds(id)).length > 0 && endpoint.state !== "ready") {
          endpoint = await this.startCandidate(candidate);
          startedForProof = true;
        }
        proofEndpoint = endpoint;
        await this.requireManagedThreadsIdle(id, endpoint);
        await endpoint.shutdownRuntime(actual);
        runtimeStopped = true;
        checkpoint?.({ phase: "runtime_stopped", identity: actual });
        drain.disconnect();
      } catch (error) {
        if (candidateWasNew && !startedForProof && candidateEndpoint?.state !== "stopped") {
          await candidateEndpoint?.closeConnection().catch(() => undefined);
        }
        this.reopenAfterLifecycleFailure(record, drain, !runtimeStopped && startedForProof ? proofEndpoint : undefined);
        throw error;
      }
    });
  }

  async recoverRestart(
    id: string,
    phase: "draining" | "idle_proven" | "runtime_stopped" | "runtime_started",
    expectedIdentity: RuntimeIdentity,
    checkpoint?: (value: unknown) => void,
  ): Promise<void> {
    const record = this.record(id);
    return this.enqueueLifecycle(record, async () => {
      this.cancelReconnect(record);
      if (record.gate.desiredState === "disconnected") record.gate.requestAutomatic();
      const replacement = phase === "runtime_started" || phase === "runtime_stopped"
        ? record.endpoint ? { endpoint: record.endpoint } : await this.prepareCandidate(id)
        : await this.prepareCandidate(id);
      const drain = await record.gate.beginDrain();
      let proofEndpoint: ManagedAppServerEndpoint | undefined;
      let proofStarted = false;
      let replacementEndpoint: ManagedAppServerEndpoint | undefined;
      let runtimeStopped = phase === "runtime_stopped" || phase === "runtime_started";
      try {
        if (phase === "runtime_started" || phase === "runtime_stopped") {
          replacementEndpoint = replacement.endpoint.state === "ready"
            ? replacement.endpoint
            : await this.startCandidate(replacement);
          const identity = phase === "runtime_started"
            ? await this.requireRuntimeIdentity(replacementEndpoint)
            : await this.requireReplacementIdentity(replacementEndpoint, expectedIdentity);
          if (phase === "runtime_started" && !sameRuntimeIdentity(identity, expectedIdentity)) {
            throw new AppError("OPERATION_UNCERTAIN", `checkpointed replacement runtime identity changed: ${id}`);
          }
          if (phase === "runtime_stopped") checkpoint?.({ phase: "runtime_started", identity });
          this.publishAfterReopen(record, drain, replacementEndpoint);
          return;
        }
        const target = record.endpoint ? { endpoint: record.endpoint } : await this.prepareCandidate(id);
        const actual = await target.endpoint.runtimeIdentity();
        if (!actual) {
          await target.endpoint.closeConnection();
          checkpoint?.({ phase: "runtime_stopped", identity: expectedIdentity });
          runtimeStopped = true;
          const started = await this.startCandidate(replacement);
          replacementEndpoint = started;
          const identity = await this.requireReplacementIdentity(started, expectedIdentity);
          checkpoint?.({ phase: "runtime_started", identity });
          this.publishAfterReopen(record, drain, started);
          return;
        }
        if (!sameRuntimeIdentity(actual, expectedIdentity)) throw new AppError("OPERATION_UNCERTAIN", `checkpointed runtime identity changed: ${id}`);
        let endpoint = target.endpoint;
        if ((await this.options.managedThreadIds(id)).length > 0 && endpoint.state !== "ready") {
          endpoint = await this.startCandidate(target);
          proofStarted = true;
        }
        proofEndpoint = endpoint;
        await this.requireManagedThreadsIdle(id, endpoint);
        await endpoint.shutdownRuntime(actual);
        runtimeStopped = true;
        checkpoint?.({ phase: "runtime_stopped", identity: actual });
        const started = await this.startCandidate(replacement);
        replacementEndpoint = started;
        const identity = await this.requireReplacementIdentity(started, expectedIdentity);
        checkpoint?.({ phase: "runtime_started", identity });
        this.publishAfterReopen(record, drain, started);
      } catch (error) {
        if (runtimeStopped && replacementEndpoint && replacementEndpoint.state !== "stopped") {
          await replacementEndpoint.closeConnection().catch(() => undefined);
        }
        this.reopenAfterLifecycleFailure(record, drain, !runtimeStopped && proofStarted ? proofEndpoint : undefined);
        throw error;
      }
    });
  }

  private async restartInternal(endpointId: string, record: EndpointRecord, checkpoint?: (value: unknown) => void): Promise<void> {
    this.cancelReconnect(record);
    if (record.gate.desiredState === "disconnected") {
      record.gate.requestAutomatic();
      const prepared = await this.prepareCandidate(endpointId);
      const drain = await record.gate.beginDrain();
      let replacement: ManagedAppServerEndpoint | undefined;
      try {
        replacement = await this.startCandidate(prepared);
        const identity = await this.requireRuntimeIdentity(replacement);
        checkpoint?.({ phase: "runtime_started", identity });
        this.publishAfterReopen(record, drain, replacement);
      } catch (error) {
        if (replacement?.state !== "stopped") await replacement?.closeConnection().catch(() => undefined);
        this.reopenAfterLifecycleFailure(record, drain);
        throw error;
      }
      return;
    }
    const preparedReplacement = await this.prepareCandidate(endpointId);
    const drain = await record.gate.beginDrain();
    let target: ShutdownTarget | undefined;
    let runtimeStopped = false;
    let replacement: ManagedAppServerEndpoint | undefined;
    try {
      target = await this.shutdownTarget(endpointId, record);
      checkpoint?.({ phase: "draining", identity: target.identity });
      await this.requireManagedThreadsIdle(endpointId, target.endpoint);
      checkpoint?.({ phase: "idle_proven", identity: target.identity });
      await target.endpoint.shutdownRuntime(target.identity);
      runtimeStopped = true;
      checkpoint?.({ phase: "runtime_stopped", identity: target.identity });
      replacement = await this.startCandidate(preparedReplacement);
      const replacementIdentity = await this.requireReplacementIdentity(replacement, target.identity);
      checkpoint?.({ phase: "runtime_started", identity: replacementIdentity });
      this.publishAfterReopen(record, drain, replacement);
    } catch (error) {
      if (runtimeStopped && replacement && replacement.state !== "stopped") {
        await replacement.closeConnection().catch(() => undefined);
      } else if (!runtimeStopped && record.endpoint !== preparedReplacement.endpoint) {
        await preparedReplacement.endpoint.closeConnection().catch(() => undefined);
      }
      this.reopenAfterLifecycleFailure(record, drain, !runtimeStopped && target?.startedForProof ? target.endpoint : undefined);
      throw error;
    }
  }

  async closeConnections(): Promise<void> {
    this.closing = true;
    const records = [...this.records.values()];
    for (const record of records) this.cancelReconnect(record);
    await Promise.allSettled(records.flatMap((record) => record.lifecycle ? [record.lifecycle] : []));
    await Promise.allSettled(records.flatMap((record) => record.activation ? [record.activation] : []));
    const closing = records.flatMap((record) => {
      this.cancelReconnect(record);
      return record.endpoint ? [record.endpoint.closeConnection()] : [];
    });
    await Promise.allSettled(closing);
  }

  desiredState(id: string): EndpointDesiredState { return this.record(id).gate.desiredState; }

  onEndpoint(listener: (endpoint: ManagedAppServerEndpoint, generation: number) => void): () => void {
    this.endpointListeners.add(listener);
    return () => this.endpointListeners.delete(listener);
  }

  private async activate(endpointId: string, lifecycle: boolean): Promise<ManagedAppServerEndpoint> {
    const record = this.record(endpointId);
    if (!lifecycle && record.gate.desiredState !== "automatic") throw new AppError("ENDPOINT_UNAVAILABLE", `endpoint is ${record.gate.desiredState}: ${endpointId}`);
    if (record.endpoint?.state === "ready") return record.endpoint;
    if (record.activation) return record.activation;
    let activation!: Promise<ManagedAppServerEndpoint>;
    activation = (async () => {
      const endpoint = await this.startCandidate(await this.prepareCandidate(endpointId));
      try { this.requireReadyCandidate(endpoint); }
      catch (error) {
        await endpoint.closeConnection().catch(() => undefined);
        throw error;
      }
      this.publish(record, endpoint);
      return endpoint;
    })().finally(() => { if (record.activation === activation) delete record.activation; });
    record.activation = activation;
    return activation;
  }

  private async prepareCandidate(endpointId: string): Promise<ActivationCandidate> {
    const builtin = this.builtins.get(endpointId);
    if (builtin) return { endpoint: builtin };
    await this.options.catalog.reload();
    const definition = this.options.catalog.require(endpointId);
    return this.options.createRemote(definition, await this.options.hasIdentityReferences(endpointId));
  }

  private async startCandidate(candidate: ActivationCandidate): Promise<ManagedAppServerEndpoint> {
    try {
      await candidate.endpoint.start();
      if (candidate.pendingBinding && this.options.commitBinding) {
        await this.options.commitBinding(candidate.pendingBinding, await this.options.hasIdentityReferences(candidate.endpoint.id));
      }
    } catch (error) {
      await candidate.endpoint.closeConnection().catch(() => undefined);
      throw error;
    }
    return candidate.endpoint;
  }

  private requireReadyCandidate(endpoint: ManagedAppServerEndpoint): void {
    if (endpoint.state === "ready") return;
    throw new AppError("ENDPOINT_UNAVAILABLE", `endpoint candidate lost readiness before publication: ${endpoint.id}`);
  }

  private publishAfterReopen(
    record: EndpointRecord,
    drain: { reopen(): void },
    endpoint: ManagedAppServerEndpoint,
  ): void {
    this.requireReadyCandidate(endpoint);
    drain.reopen();
    this.publish(record, endpoint);
  }

  private reopenAfterLifecycleFailure(
    record: EndpointRecord,
    drain: { reopen(): void },
    readyTarget?: ManagedAppServerEndpoint,
  ): void {
    if (readyTarget?.state === "ready") {
      drain.reopen();
      this.publish(record, readyTarget);
      return;
    }
    drain.reopen();
  }

  private publish(record: EndpointRecord, endpoint: ManagedAppServerEndpoint): void {
    this.cancelReconnect(record);
    for (const unsubscribe of record.subscriptions) unsubscribe();
    record.subscriptions = [];
    record.endpoint = endpoint;
    record.generation += 1;
    record.reconnectAttempt = 0;
    const generation = record.generation;
    record.subscriptions.push(endpoint.onUnavailable((kind) => {
      if (record.endpoint !== endpoint || record.generation !== generation) return;
      this.scheduleReconnect(endpoint.id, record, generation, kind);
    }));
    for (const listener of this.endpointListeners) listener(endpoint, generation);
  }

  private async requireManagedThreadsIdle(endpointId: string, endpoint: ManagedAppServerEndpoint): Promise<void> {
    for (const threadId of await this.options.managedThreadIds(endpointId)) {
      let response: { thread?: { status?: string | { type?: string } } };
      try { response = await endpoint.request("thread/read", { threadId, includeTurns: false }); }
      catch (error) {
        if (error instanceof RpcRequestTimeoutError) throw error;
        throw new AppError("OPERATION_UNCERTAIN", `could not prove managed thread idle on endpoint ${endpointId}`, { cause: error });
      }
      const status = typeof response.thread?.status === "string" ? response.thread.status : response.thread?.status?.type;
      if (status !== "idle") throw new AppError("OPERATION_CONFLICT", `managed thread is not idle on endpoint ${endpointId}`);
    }
  }

  private scheduleReconnect(endpointId: string, record: EndpointRecord, generation: number, _kind: EndpointLossKind): void {
    if (this.closing || record.gate.desiredState !== "automatic" || record.reconnect) return;
    void Promise.resolve(this.options.hasIdentityReferences(endpointId)).then((referenced) => {
      if (this.closing || !referenced || record.endpoint?.id !== endpointId || record.generation !== generation || record.gate.desiredState !== "automatic" || record.reconnect) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(record.reconnectAttempt, 5));
      record.reconnectAttempt += 1;
      const schedule = this.options.schedule ?? ((delayMs: number, run: () => void) => {
        const timer = setTimeout(run, delayMs);
        timer.unref?.();
        return { cancel: () => clearTimeout(timer) };
      });
      record.reconnect = schedule(delay, () => {
        delete record.reconnect;
        if (this.closing || record.generation !== generation || record.gate.desiredState !== "automatic") return;
        void this.activate(endpointId, false).catch(() => this.scheduleReconnect(endpointId, record, generation, "connection-lost"));
      });
    }).catch(() => undefined);
  }

  private scheduleActivationRetry(endpointId: string, record: EndpointRecord): void {
    const generation = record.generation;
    if (this.closing || record.gate.desiredState !== "automatic" || record.reconnect
      || record.endpoint?.state === "ready") return;
    void Promise.resolve(this.options.hasIdentityReferences(endpointId)).then((referenced) => {
      if (this.closing || !referenced || record.generation !== generation
        || record.endpoint?.state === "ready" || record.gate.desiredState !== "automatic" || record.reconnect) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(record.reconnectAttempt, 5));
      record.reconnectAttempt += 1;
      const schedule = this.options.schedule ?? ((delayMs: number, run: () => void) => {
        const timer = setTimeout(run, delayMs);
        timer.unref?.();
        return { cancel: () => clearTimeout(timer) };
      });
      record.reconnect = schedule(delay, () => {
        delete record.reconnect;
        if (this.closing || record.generation !== generation
          || record.endpoint?.state === "ready" || record.gate.desiredState !== "automatic") return;
        void Promise.resolve(this.options.hasIdentityReferences(endpointId)).then((stillReferenced) => {
          if (this.closing || !stillReferenced || record.generation !== generation || record.reconnect
            || record.endpoint?.state === "ready" || record.gate.desiredState !== "automatic") return;
          void this.ensureReady(endpointId).catch(() => undefined);
        }).catch(() => undefined);
      });
    }).catch(() => undefined);
  }

  private cancelReconnect(record: EndpointRecord): void {
    record.reconnect?.cancel();
    delete record.reconnect;
  }

  private async requireRuntimeIdentity(endpoint: ManagedAppServerEndpoint): Promise<RuntimeIdentity> {
    const identity = await endpoint.runtimeIdentity();
    if (!identity) throw new AppError("OPERATION_UNCERTAIN", `runtime identity is unavailable: ${endpoint.id}`);
    return identity;
  }

  private async requireReplacementIdentity(endpoint: ManagedAppServerEndpoint, previous: RuntimeIdentity): Promise<RuntimeIdentity> {
    const identity = await this.requireRuntimeIdentity(endpoint);
    if (sameRuntimeIdentity(identity, previous)) throw new AppError("OPERATION_UNCERTAIN", `replacement runtime retained the stopped identity: ${endpoint.id}`);
    return identity;
  }

  private enqueueLifecycle<T>(record: EndpointRecord, run: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new AppError("ENDPOINT_UNAVAILABLE", "endpoint manager is shutting down"));
    const previous = record.lifecycle ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(run);
    const settled = result.then(() => undefined, () => undefined);
    record.lifecycle = settled;
    void settled.finally(() => { if (record.lifecycle === settled) delete record.lifecycle; });
    return result;
  }

  private async shutdownTarget(endpointId: string, record: EndpointRecord): Promise<ShutdownTarget> {
    const current = record.endpoint;
    if (current) {
      const identity = await current.runtimeIdentity().catch(() => undefined);
      if (identity) {
        const managed = await this.options.managedThreadIds(endpointId);
        if (managed.length === 0 || current.state === "ready") return { endpoint: current, identity, startedForProof: false };
      }
    }
    const candidate = current ? { endpoint: current } : await this.prepareCandidate(endpointId);
    const endpoint = await this.startCandidate(candidate);
    try {
      return { endpoint, identity: await this.requireRuntimeIdentity(endpoint), startedForProof: true };
    } catch (error) {
      await endpoint.closeConnection().catch(() => undefined);
      throw error;
    }
  }

  private record(id: string): EndpointRecord {
    let record = this.records.get(id);
    if (!record) { record = this.newRecord(id); this.records.set(id, record); }
    return record;
  }

  private newRecord(id: string, endpoint?: ManagedAppServerEndpoint): EndpointRecord {
    return { gate: new EndpointAdmissionGate(id), ...(endpoint ? { endpoint } : {}), generation: 0, subscriptions: [], reconnectAttempt: 0 };
  }
}

function sameRuntimeIdentity(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return left.kind === right.kind && (left.kind === "local"
    ? right.kind === "local" && left.pid === right.pid && left.startTime === right.startTime
    : right.kind === "ssh" && left.token === right.token && left.pid === right.pid
      && left.linuxStartTime === right.linuxStartTime && left.processGroupId === right.processGroupId);
}
