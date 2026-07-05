import { AppError } from "../core/errors.ts";
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
  private closing = false;

  constructor(private readonly options: {
    localEndpoint: ManagedAppServerEndpoint;
    catalog: CatalogReader;
    createRemote(definition: SshEndpointDefinition, hasReferences: boolean): Promise<ActivationCandidate>;
    hasIdentityReferences(endpointId: string): boolean | Promise<boolean>;
    commitBinding?(binding: PendingDestinationBinding, hasReferences: boolean): void | Promise<void>;
    managedThreadIds(endpointId: string): readonly string[] | Promise<readonly string[]>;
    schedule?(delayMs: number, run: () => void): ScheduledWork;
  }) {
    this.records.set("local", this.newRecord("local", options.localEndpoint));
  }

  normalize(id?: string): string { return id ?? "local"; }

  async ensureReady(id?: string): Promise<ManagedAppServerEndpoint> {
    if (this.closing) throw new AppError("ENDPOINT_UNAVAILABLE", "endpoint manager is shutting down");
    const endpointId = this.normalize(id);
    const record = this.record(endpointId);
    if (record.gate.desiredState === "draining") throw new AppError("ENDPOINT_UNAVAILABLE", `endpoint is draining: ${endpointId}`);
    record.gate.requestAutomatic();
    return this.activate(endpointId, false);
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

  validateWorkLease(lease: EndpointWorkLease, endpointId: string): boolean {
    const record = this.records.get(endpointId);
    return record !== undefined && record.generation === lease.endpointGeneration && record.gate.validate(lease, record.generation);
  }

  endpointGeneration(id: string): { endpoint: ManagedAppServerEndpoint; generation: number } {
    const record = this.records.get(id);
    if (!record?.endpoint || record.generation === 0) throw new AppError("ENDPOINT_UNAVAILABLE", `endpoint is unavailable: ${id}`);
    return { endpoint: record.endpoint, generation: record.generation };
  }

  async activateReferenced(ids: readonly string[]): Promise<{ unavailable: string[] }> {
    const unavailable: string[] = [];
    for (const id of [...new Set(ids)]) {
      try { await this.ensureReady(id); } catch { unavailable.push(id); }
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
    try {
      const endpoint = await this.activate(endpointId, true);
      const identity = await this.requireRuntimeIdentity(endpoint);
      checkpoint?.({ phase: "draining", identity });
      await this.requireManagedThreadsIdle(endpointId, endpoint);
      checkpoint?.({ phase: "idle_proven", identity });
      await endpoint.shutdownRuntime(identity);
      checkpoint?.({ phase: "runtime_stopped", identity });
      drain.disconnect();
    } catch (error) {
      drain.reopen();
      throw error;
    }
  }

  async restart(id?: string, checkpoint?: (value: unknown) => void): Promise<void> {
    const endpointId = this.normalize(id);
    const record = this.record(endpointId);
    return this.enqueueLifecycle(record, () => this.restartInternal(endpointId, record, checkpoint));
  }

  private async restartInternal(endpointId: string, record: EndpointRecord, checkpoint?: (value: unknown) => void): Promise<void> {
    this.cancelReconnect(record);
    if (record.gate.desiredState === "disconnected") record.gate.requestAutomatic();
    const preparedReplacement = await this.prepareCandidate(endpointId);
    const drain = await record.gate.beginDrain();
    try {
      const endpoint = await this.activate(endpointId, true);
      const identity = await this.requireRuntimeIdentity(endpoint);
      checkpoint?.({ phase: "draining", identity });
      await this.requireManagedThreadsIdle(endpointId, endpoint);
      checkpoint?.({ phase: "idle_proven", identity });
      await endpoint.shutdownRuntime(identity);
      checkpoint?.({ phase: "runtime_stopped", identity });
      const replacement = await this.startCandidate(record, preparedReplacement);
      checkpoint?.({ phase: "runtime_started", identity: await this.requireRuntimeIdentity(replacement) });
      drain.reopen();
    } catch (error) {
      drain.reopen();
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
      return this.startCandidate(record, await this.prepareCandidate(endpointId));
    })().finally(() => { if (record.activation === activation) delete record.activation; });
    record.activation = activation;
    return activation;
  }

  private async prepareCandidate(endpointId: string): Promise<ActivationCandidate> {
    if (endpointId === "local") return { endpoint: this.options.localEndpoint };
    await this.options.catalog.reload();
    const definition = this.options.catalog.require(endpointId);
    return this.options.createRemote(definition, await this.options.hasIdentityReferences(endpointId));
  }

  private async startCandidate(record: EndpointRecord, candidate: ActivationCandidate): Promise<ManagedAppServerEndpoint> {
    try {
      await candidate.endpoint.start();
      if (candidate.pendingBinding && this.options.commitBinding) {
        await this.options.commitBinding(candidate.pendingBinding, await this.options.hasIdentityReferences(candidate.endpoint.id));
      }
    } catch (error) {
      await candidate.endpoint.closeConnection().catch(() => undefined);
      throw error;
    }
    this.publish(record, candidate.endpoint);
    return candidate.endpoint;
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
      try { response = await endpoint.request("thread/read", { threadId, includeTurns: true }); }
      catch (error) { throw new AppError("OPERATION_UNCERTAIN", `could not prove managed thread idle on endpoint ${endpointId}`, { cause: error }); }
      const status = typeof response.thread?.status === "string" ? response.thread.status : response.thread?.status?.type;
      if (status !== "idle") throw new AppError("OPERATION_CONFLICT", `managed thread is not idle on endpoint ${endpointId}`);
    }
  }

  private scheduleReconnect(endpointId: string, record: EndpointRecord, generation: number, _kind: EndpointLossKind): void {
    if (record.gate.desiredState !== "automatic" || record.reconnect) return;
    void Promise.resolve(this.options.hasIdentityReferences(endpointId)).then((referenced) => {
      if (!referenced || record.endpoint?.id !== endpointId || record.generation !== generation || record.gate.desiredState !== "automatic" || record.reconnect) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(record.reconnectAttempt, 5));
      record.reconnectAttempt += 1;
      const schedule = this.options.schedule ?? ((delayMs: number, run: () => void) => {
        const timer = setTimeout(run, delayMs);
        timer.unref?.();
        return { cancel: () => clearTimeout(timer) };
      });
      record.reconnect = schedule(delay, () => {
        delete record.reconnect;
        if (record.generation !== generation || record.gate.desiredState !== "automatic") return;
        void this.activate(endpointId, false).catch(() => this.scheduleReconnect(endpointId, record, generation, "connection-lost"));
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

  private enqueueLifecycle<T>(record: EndpointRecord, run: () => Promise<T>): Promise<T> {
    const previous = record.lifecycle ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(run);
    const settled = result.then(() => undefined, () => undefined);
    record.lifecycle = settled;
    void settled.finally(() => { if (record.lifecycle === settled) delete record.lifecycle; });
    return result;
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
