import assert from "node:assert/strict";
import test from "node:test";
import { AppServerPool, type AppServerEndpoint } from "../../src/app-server/pool.ts";
import { AppError } from "../../src/core/errors.ts";
import { EndpointManager } from "../../src/endpoints/manager.ts";
import type { PermissionBlockedEvent } from "../../src/app-server/managed-endpoint.ts";
import type { EndpointLossKind, EndpointWorkLease, ManagedAppServerEndpoint, RuntimeIdentity } from "../../src/endpoints/types.ts";

class FakeEndpoint implements AppServerEndpoint {
  readonly id: string = "local";
  state: AppServerEndpoint["state"] = "ready";
  fail = false;
  nextTurn = 1;

  async request<T>(method: string): Promise<T> {
    if (this.fail) throw new Error("transport failed");
    if (method === "thread/turns/list") {
      return { data: [], nextCursor: null, backwardsCursor: null } as T;
    }
    if (method === "turn/start") {
      return { turn: { id: `turn-${this.nextTurn++}` } } as T;
    }
    return {} as T;
  }
}

function pagedHistory<T>(method: string, params: any, thread: {
  status?: string | { type?: string };
  turns: Array<{ id: string; status: string; itemsView?: "full" | "summary" | "notLoaded"; items?: any[] }>;
}): T {
  if (method === "thread/read") return { thread: { status: thread.status } } as T;
  if (method === "thread/turns/list") {
    const ordered = params.sortDirection === "asc" ? [...thread.turns] : [...thread.turns].reverse();
    const offset = params.cursor === undefined ? 0 : Number(params.cursor);
    const limit = Number(params.limit);
    const data = ordered.slice(offset, offset + limit).map((turn) => ({
      ...turn,
      itemsView: params.itemsView ?? turn.itemsView ?? "summary",
      items: params.itemsView === "notLoaded" ? [] : turn.items ?? [],
    }));
    return {
      data,
      nextCursor: offset + data.length < ordered.length ? String(offset + data.length) : null,
      backwardsCursor: offset > 0 ? String(Math.max(0, offset - limit)) : null,
    } as T;
  }
  if (method === "thread/items/list") {
    const turn = thread.turns.find((candidate) => candidate.id === params.turnId);
    return { data: turn?.items ?? [], nextCursor: null, backwardsCursor: turn?.items?.length ? "back" : null } as T;
  }
  return {} as T;
}

class AdmissionRaceEndpoint implements ManagedAppServerEndpoint {
  private currentState: ManagedAppServerEndpoint["state"] = "stopped";
  private armedRead: number | undefined;
  private stateReads = 0;
  starts = 0;
  requests = 0;
  constructor(readonly id: string) {}
  get state(): ManagedAppServerEndpoint["state"] {
    if (this.armedRead !== undefined && ++this.stateReads >= this.armedRead) this.currentState = "unavailable";
    return this.currentState;
  }
  armUnavailableOnStateRead(read: number): void { this.armedRead = read; this.stateReads = 0; }
  async start(): Promise<void> { this.starts += 1; this.currentState = "ready"; this.armedRead = undefined; }
  async closeConnection(): Promise<void> { this.currentState = "stopped"; }
  async shutdownRuntime(): Promise<void> { this.currentState = "stopped"; }
  async runtimeIdentity(): Promise<RuntimeIdentity> {
    return { kind: "ssh", token: "a".repeat(32), pid: 1, linuxStartTime: "1", processGroupId: 1 };
  }
  async request<T>(): Promise<T> {
    this.requests += 1;
    return { thread: { status: "active", turns: [] } } as T;
  }
  onNotification(): () => void { return () => undefined; }
  onReady(): () => void { return () => undefined; }
  onUnavailable(_listener: (kind: EndpointLossKind) => void): () => void { return () => undefined; }
  onPermissionBlocked(_listener: (event: PermissionBlockedEvent) => void): () => void { return () => undefined; }
}

test("turn permits remain reserved until terminal completion", async () => {
  const endpoint = new FakeEndpoint();
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });

  const first = await pool.startTurn("local", { threadId: "t1", input: [] });
  assert.equal(first.turn.id, "turn-1");
  await assert.rejects(
    pool.startTurn("local", { threadId: "t2", input: [] }),
    (error: unknown) => error instanceof AppError && error.code === "CAPACITY_EXCEEDED",
  );

  pool.markTurnTerminal("local", "t1", "turn-1");
  assert.equal((await pool.startTurn("local", { threadId: "t2", input: [] })).turn.id, "turn-2");
});

test("a failed start releases capacity only after full idle history proves it absent", async () => {
  const endpoint: AppServerEndpoint = {
    id: "local", state: "ready",
    request: async <T>(method: string, params: any) => {
      if (method === "turn/start") throw new Error("start failed");
      return pagedHistory<T>(method, params, { status: "idle", turns: [] });
    },
  };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1, reconciliationTimeoutMs: 0 });
  await assert.rejects(pool.startTurn("local", { threadId: "t1", input: [] }), /start failed/u);
  assert.equal(pool.activeTurnCount, 0);
});

test("implicit starts send a correlation and retain capacity when a response is lost", async () => {
  let sent: Record<string, unknown> | undefined;
  const endpoint: AppServerEndpoint = {
    id: "local", state: "ready",
    request: async <T>(method: string, params: unknown) => {
      if (method === "thread/turns/list") {
        return { data: [], nextCursor: null, backwardsCursor: null } as T;
      }
      if (method === "turn/start") {
        sent = params as Record<string, unknown>;
        throw new Error("response lost");
      }
      throw new Error("connection lost");
    },
  };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  await assert.rejects(
    pool.startTurn("local", { threadId: "t1", input: [] }),
    (error: unknown) => error instanceof AppError && error.code === "OPERATION_UNCERTAIN",
  );
  assert.equal(typeof sent?.clientUserMessageId, "string");
  assert.notEqual(sent?.clientUserMessageId, "");
  assert.equal(pool.activeTurnCount, 1);
  pool.markEndpointUnavailable("local", "connection-lost");
  assert.equal(pool.activeTurnCount, 0);
  pool.markEndpointUnavailable("local", "runtime-lost");
  assert.equal(pool.activeTurnCount, 0);
});

test("a successful turn/start response remains authoritative over a stale correlated terminal", async () => {
  let resolveStart!: (value: any) => void;
  let reads = 0;
  const endpoint: AppServerEndpoint = {
    id: "local", state: "ready",
    request: async <T>(method: string) => method === "turn/start"
      ? new Promise<T>((resolve) => { resolveStart = resolve; })
      : (reads += 1, { thread: { turns: [{ id: "turn-stale", status: "completed", items: [{ type: "userMessage", clientId: "message-1" }] }] } }) as T,
  };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1, sleep: async () => undefined });
  const starting = pool.startTurn("local", { threadId: "t1", clientUserMessageId: "message-1", input: [] }, undefined, undefined, null);
  pool.markTurnTerminal("local", "t1", "turn-stale");
  resolveStart({ turn: { id: "turn-live", status: "inProgress" } });
  assert.equal((await starting).turn.id, "turn-live");
  assert.equal(reads, 0);
  assert.equal(pool.activeTurnCount, 1);
  pool.markTurnTerminal("local", "t1", "turn-live");
  assert.equal(pool.activeTurnCount, 0);
});

test("a caller-owned failed start remains provisional without pool history reconciliation", async () => {
  let reads = 0;
  const endpoint: AppServerEndpoint = {
    id: "local", state: "ready",
    request: async <T>(method: string) => {
      if (method === "turn/start") throw new Error("response lost");
      reads += 1;
      return { thread: { status: "idle", turns: [] } } as T;
    },
  };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1, reconciliationTimeoutMs: 0 });
  const claim = pool.claimTurnCapacity("local", "assistant", "caller-owned");
  await assert.rejects(
    pool.startTurn("local", { threadId: "assistant", clientUserMessageId: "message", input: [] }, claim),
    (error: unknown) => error instanceof AppError && error.code === "OPERATION_UNCERTAIN",
  );
  assert.equal(reads, 0);
  assert.equal(pool.activeTurnCount, 1);
  pool.releaseTurnCapacityClaim(claim);
});

test("an exact caller claim can be rebound after its turn terminal races the start response", async () => {
  for (const terminalTiming of ["before-response", "after-response"] as const) {
    let resolveStart!: (value: any) => void;
    const endpoint: AppServerEndpoint = {
      id: "local", state: "ready",
      request: async <T>() => new Promise<T>((resolve) => { resolveStart = resolve; }),
    };
    const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
    const claim = pool.claimTurnCapacity("local", "assistant", `claim-${terminalTiming}`);
    const starting = pool.startTurn("local", { threadId: "assistant", input: [] }, claim);
    if (terminalTiming === "before-response") pool.markTurnTerminal("local", "assistant", "turn-raced");
    resolveStart({ turn: { id: "turn-raced", status: "completed" } });
    const response = await starting;
    if (terminalTiming === "after-response") pool.markTurnTerminal("local", "assistant", "turn-raced");

    assert.doesNotThrow(() => pool.bindTurnCapacityClaim(claim, response.turn.id));
    assert.throws(() => pool.bindTurnCapacityClaim(claim, "turn-other"), /unknown capacity claim/iu);
    assert.equal(pool.activeTurnCount, 0);
  }
});

test("a stale terminal claim cannot bind or release a reused claim ID", () => {
  const endpoint = new FakeEndpoint();
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  const stale = pool.claimTurnCapacity("local", "assistant", "reused-claim");
  pool.bindTurnCapacityClaim(stale, "turn-old");
  pool.markTurnTerminal("local", "assistant", "turn-old");

  const current = pool.claimTurnCapacity("local", "assistant", "reused-claim");
  assert.notEqual(current.generation, stale.generation);
  assert.doesNotThrow(() => pool.bindTurnCapacityClaim(stale, "turn-old"));
  pool.markTurnTerminal("local", "assistant", "turn-old");
  assert.equal(pool.activeTurnCount, 1);

  pool.bindTurnCapacityClaim(current, "turn-new");
  assert.equal(pool.activeTurnCount, 1);
  pool.markTurnTerminal("local", "assistant", "turn-new");
  assert.equal(pool.activeTurnCount, 0);
});

test("restoring a terminal claim never reserves capacity again", () => {
  const terminalFixture = () => {
    const pool = new AppServerPool([new FakeEndpoint()], { maxConcurrentTurns: 1 });
    const claim = pool.claimTurnCapacity("local", "assistant", "terminal-claim");
    pool.bindTurnCapacityClaim(claim, "turn-terminal");
    pool.markTurnTerminal("local", "assistant", "turn-terminal");
    return { pool, claim };
  };

  const exact = terminalFixture();
  assert.deepEqual(exact.pool.restoreTurnCapacityClaim("local", "assistant", "terminal-claim", {
    phase: "active", turnId: "turn-terminal",
  }), exact.claim);
  assert.equal(exact.pool.activeTurnCount, 0);

  const mismatched = terminalFixture();
  assert.throws(() => mismatched.pool.restoreTurnCapacityClaim("local", "assistant", "terminal-claim", {
    phase: "active", turnId: "turn-other",
  }), /terminal capacity claim/iu);
  assert.equal(mismatched.pool.activeTurnCount, 0);

  const provisional = terminalFixture();
  assert.deepEqual(provisional.pool.restoreTurnCapacityClaim("local", "assistant", "terminal-claim", {
    phase: "provisional",
  }), provisional.claim);
  assert.equal(provisional.pool.activeTurnCount, 0);
});

test("a lost turn/start response is proven from history instead of retransmitted", async () => {
  let starts = 0;
  const endpoint: AppServerEndpoint = {
    id: "local", state: "ready",
    request: async <T>(method: string, params: any) => {
      if (method === "turn/start") { starts += 1; throw new Error("response lost"); }
      return pagedHistory<T>(method, params, { status: starts > 0 ? "active" : "idle", turns: starts > 0 ? [{
        id: "created", status: "inProgress", items: [{ type: "userMessage", id: "user", clientId: "stable-client-id" }],
      }] : [] });
    },
  };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  assert.equal((await pool.startTurn("local", { threadId: "t", clientUserMessageId: "stable-client-id", input: [] })).turn.id, "created");
  assert.equal(starts, 1);
});

test("a failed history read after turn/start uncertainty remains operation uncertainty", async () => {
  let baselineRead = false;
  const endpoint: AppServerEndpoint = {
    id: "local", state: "ready",
    request: async <T>(method: string) => {
      if (method === "thread/turns/list" && !baselineRead) {
        baselineRead = true;
        return { data: [], nextCursor: null, backwardsCursor: null } as T;
      }
      if (method === "turn/start") throw new Error("start response timed out");
      throw new Error("history read timed out");
    },
  };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  await assert.rejects(
    pool.startTurn("local", { threadId: "t", clientUserMessageId: "stable-client-id", input: [] }),
    (error: unknown) => error instanceof AppError && error.code === "OPERATION_UNCERTAIN",
  );
});

test("a lost interrupt response succeeds only when the exact turn is proven terminal", async () => {
  const endpoint: AppServerEndpoint = {
    id: "local", state: "ready",
    request: async <T>(method: string, params: any) => {
      if (method === "turn/interrupt") throw new Error("response lost");
      return pagedHistory<T>(method, params, { status: "idle", turns: [{ id: "turn-1", status: "interrupted", items: [] }] });
    },
  };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  await pool.interrupt("local", "thread", "turn-1");
});

test("caller-owned capacity claims restore, bind, and release on exact terminal turns", () => {
  const endpoint = new FakeEndpoint();
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  const claim = pool.claimTurnCapacity("local", "assistant", "claim-1");
  assert.equal(pool.activeTurnCount, 1);
  assert.deepEqual(pool.restoreTurnCapacityClaim("local", "assistant", "claim-1", { phase: "provisional" }), claim);
  assert.equal(pool.activeTurnCount, 1);
  pool.bindTurnCapacityClaim(claim, "turn-1");
  assert.throws(() => pool.restoreTurnCapacityClaim("local", "assistant", "claim-1", {
    phase: "active", turnId: "turn-other",
  }), /already bound|changed turn/iu);
  assert.equal(pool.activeTurnCount, 1);
  pool.markTurnTerminal("local", "assistant", "turn-1");
  assert.equal(pool.activeTurnCount, 0);
});

test("an invalid active restore cannot reserve capacity", () => {
  const pool = new AppServerPool([new FakeEndpoint()], { maxConcurrentTurns: 1 });
  assert.throws(() => pool.restoreTurnCapacityClaim("local", "assistant", "claim-invalid", {
    phase: "active",
  }), /no turn ID/iu);
  assert.equal(pool.activeTurnCount, 0);
});

test("endpoint loss releases caller-owned provisional claims", async () => {
  const endpoint: AppServerEndpoint = {
    id: "local", state: "ready",
    request: async <T>(method: string) => {
      if (method === "turn/start") throw new Error("response lost");
      return { thread: { turns: [{ id: "older", status: "completed", itemsView: "summary", items: [] }] } } as T;
    },
  };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1, reconciliationTimeoutMs: 0 });
  const claim = pool.claimTurnCapacity("local", "assistant", "claim-ambiguous");
  await assert.rejects(
    pool.startTurn("local", { threadId: "assistant", clientUserMessageId: "message", input: [] }, claim),
    (error: unknown) => error instanceof AppError && error.code === "OPERATION_UNCERTAIN",
  );
  pool.markEndpointUnavailable("local");
  assert.equal(pool.activeTurnCount, 0);
});

test("active thread state prevents empty full history from proving a lost start absent", async () => {
  const endpoint: AppServerEndpoint = {
    id: "local", state: "ready",
    request: async <T>(method: string) => {
      if (method === "turn/start") throw new Error("response lost");
      return { thread: { status: { type: "active" }, turns: [] } } as T;
    },
  };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1, reconciliationTimeoutMs: 0 });
  const claim = pool.claimTurnCapacity("local", "assistant", "claim-active-empty");
  await assert.rejects(
    pool.startTurn("local", { threadId: "assistant", clientUserMessageId: "message", input: [] }, claim),
    (error: unknown) => error instanceof AppError && error.code === "OPERATION_UNCERTAIN",
  );
  assert.equal(pool.activeTurnCount, 1);
  pool.releaseTurnCapacityClaim(claim);
});

test("only full item views can prove a client message absent", async () => {
  for (const itemsView of ["summary", "notLoaded"] as const) {
    const endpoint: AppServerEndpoint = {
      id: "local", state: "ready",
      request: async <T>() => ({ thread: { turns: [{ id: "turn", status: "completed", itemsView, items: [] }] } }) as T,
    };
    const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
    await assert.rejects(pool.readFullThread("local", "assistant"), (error: unknown) => error instanceof AppError && error.code === "OPERATION_UNCERTAIN");
  }
  const endpoint: AppServerEndpoint = {
    id: "local", state: "ready",
    request: async <T>() => ({ thread: { turns: [{ id: "turn", status: "completed", itemsView: "full", items: [] }] } }) as T,
  };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  assert.equal((await pool.readFullThread("local", "assistant")).turns[0]?.itemsView, "full");
});

test("capacity listeners fire once when a full pool becomes available and unsubscribe cleanly", async () => {
  const endpoint = new FakeEndpoint();
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  const calls: number[] = [];
  const unsubscribe = pool.onCapacityAvailable(() => { calls.push(1); });
  const first = pool.claimTurnCapacity("local", "assistant", "claim-1");
  assert.throws(() => pool.claimTurnCapacity("local", "other", "claim-2"), (error: unknown) => error instanceof AppError && error.code === "CAPACITY_EXCEEDED");
  pool.releaseTurnCapacityClaim(first);
  await Promise.resolve();
  assert.equal(calls.length, 1);
  unsubscribe();
  const second = pool.claimTurnCapacity("local", "assistant", "claim-3");
  pool.releaseTurnCapacityClaim(second);
  await Promise.resolve();
  assert.equal(calls.length, 1);
});

test("lazily resolves and starts one endpoint generation", async () => {
  class Remote extends FakeEndpoint implements ManagedAppServerEndpoint {
    override readonly id = "devbox";
    override state: ManagedAppServerEndpoint["state"] = "stopped";
    starts = 0;
    async start() { this.starts += 1; this.state = "ready"; }
    async closeConnection() { this.state = "stopped"; }
    async shutdownRuntime() { this.state = "stopped"; }
    async runtimeIdentity() { return { kind: "ssh" as const, token: "a".repeat(32), pid: 10, linuxStartTime: "20", processGroupId: 10 }; }
    onNotification() { return () => undefined; }
    onReady() { return () => undefined; }
    onUnavailable() { return () => undefined; }
    onPermissionBlocked() { return () => undefined; }
  }
  const remote = new Remote();
  let resolutions = 0;
  const pool = new AppServerPool([new FakeEndpoint()], {
    maxConcurrentTurns: 2,
    resolveEndpoint: async (id) => { resolutions += 1; assert.equal(id, "devbox"); return remote; },
  });
  await Promise.all([pool.request("devbox", "model/list", {}), pool.request("devbox", "thread/list", {})]);
  assert.equal(resolutions, 1);
  assert.equal(remote.starts, 1);
});

test("a replacement generation ignores stale endpoint callbacks", () => {
  class Managed extends FakeEndpoint implements ManagedAppServerEndpoint {
    override readonly id = "devbox";
    private readonly unavailable = new Set<(kind: "connection-lost" | "runtime-lost") => void>();
    async start() { this.state = "ready"; }
    async closeConnection() { this.state = "stopped"; }
    async shutdownRuntime() { this.state = "stopped"; }
    async runtimeIdentity() { return { kind: "ssh" as const, token: "a".repeat(32), pid: 10, linuxStartTime: "20", processGroupId: 10 }; }
    onNotification() { return () => undefined; }
    onReady() { return () => undefined; }
    onUnavailable(listener: (kind: "connection-lost" | "runtime-lost") => void) {
      this.unavailable.add(listener);
      return () => { this.unavailable.delete(listener); };
    }
    onPermissionBlocked() { return () => undefined; }
    emitUnavailable(kind: "connection-lost" | "runtime-lost" = "runtime-lost") {
      for (const listener of this.unavailable) listener(kind);
    }
  }
  const first = new Managed();
  const second = new Managed();
  const pool = new AppServerPool([first], { maxConcurrentTurns: 1 });
  const old = pool.endpointGeneration("devbox");
  pool.replaceEndpoint(second);
  first.emitUnavailable();
  const current = pool.endpointGeneration("devbox");
  assert.equal(old.endpoint, first);
  assert.equal(current.endpoint, second);
  assert.equal(current.generation, old.generation + 1);
});

test("connection loss releases reconstructed claims until a new native snapshot reclaims them", async () => {
  let terminal = false;
  const endpoint: AppServerEndpoint = {
    id: "devbox", state: "ready",
    request: async <T>(method: string, params: any) => pagedHistory<T>(method, params, {
      status: { type: terminal ? "idle" : "active" },
      turns: [{ id: "turn-a", status: terminal ? "completed" : "inProgress", itemsView: "full", items: [{ type: "userMessage", id: "user", clientId: "message-a" }] }],
    }),
  };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  pool.restoreObservedActiveTurn("devbox", "thread-a", "turn-a");
  pool.restoreProvisionalTurnCapacity("devbox", "thread-a", "recovered:op-a", "message-a", null);
  assert.equal(pool.activeTurnCount, 2);
  pool.markEndpointUnavailable("devbox", "connection-lost");
  assert.equal(pool.activeTurnCount, 0);
  await pool.reconcileEndpointClaims("devbox");
  assert.equal(pool.activeTurnCount, 0);
  terminal = true;
  await pool.reconcileEndpointClaims("devbox");
  assert.equal(pool.activeTurnCount, 0);
  await pool.reconcileEndpointClaims("devbox");
  assert.equal(pool.activeTurnCount, 0);
});

test("claim reconciliation stops after endpoint loss and reuses its exact lease without activation", async () => {
  const lease: EndpointWorkLease = {
    endpointId: "devbox", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "claim-recovery",
  };
  let firstReadStarted!: () => void;
  let releaseFirstRead!: () => void;
  const started = new Promise<void>((resolve) => { firstReadStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
  const reads: string[] = [];
  let activations = 0;
  const endpoint: AppServerEndpoint = {
    id: "devbox",
    state: "ready",
    request: async <T>(_method: string, params: any) => {
      reads.push(params.threadId);
      if (reads.length === 1) {
        firstReadStarted();
        await blocked;
      }
      return { thread: { status: "active", turns: [{
        id: `turn-${params.threadId}`, status: "inProgress", itemsView: "full", items: [],
      }] } } as T;
    },
  };
  const pool = new AppServerPool([endpoint], {
    maxConcurrentTurns: 2,
    workLeaseProvider: async (_endpointId, existingLease, run) => {
      if (!existingLease) activations += 1;
      return run(existingLease);
    },
  });
  pool.restoreObservedActiveTurn("devbox", "thread-a", "turn-thread-a");
  pool.restoreObservedActiveTurn("devbox", "thread-b", "turn-thread-b");
  let current = true;

  const reconciling = pool.reconcileEndpointClaims("devbox", lease, () => current);
  await started;
  current = false;
  releaseFirstRead();
  await reconciling;

  assert.deepEqual(reads, ["thread-a"]);
  assert.equal(activations, 0);
  assert.equal(pool.activeTurnCount, 2);
});

test("real ready-lease admission cannot activate after loss between predicate and request", async () => {
  const local = new AdmissionRaceEndpoint("local");
  const remote = new AdmissionRaceEndpoint("devbox");
  const manager = new EndpointManager({
    localEndpoint: local,
    catalog: {
      reload: async () => undefined,
      require: (id) => ({ id, provider: "codex" as const, transport: "ssh" as const, host: id, projectsRoot: "~/projects" }),
    },
    createRemote: async () => ({ endpoint: remote }),
    hasIdentityReferences: () => true,
    managedThreadIds: () => [],
  });
  const published = await manager.ensureReady("devbox");
  let resolveCalls = 0;
  const pool = new AppServerPool([published], {
    maxConcurrentTurns: 2,
    resolveEndpoint: async (id) => {
      resolveCalls += 1;
      return manager.ensureReady(id);
    },
    workLeaseProvider: (id, existing, run) => manager.runWithReadyWorkLease(id, existing, run),
  });
  pool.restoreObservedActiveTurn("devbox", "thread-a", "turn-a");
  pool.restoreObservedActiveTurn("devbox", "thread-b", "turn-b");

  await manager.withReadyWorkLease("devbox", async (lease) => {
    remote.armUnavailableOnStateRead(3);
    await pool.reconcileEndpointClaims(
      "devbox", lease, () => manager.validateReadyWorkLease(lease, "devbox"),
    );
  });

  assert.equal(resolveCalls, 0);
  assert.equal(remote.starts, 1, "the published runtime is never restarted by stale claim recovery");
  assert.equal(remote.requests, 0, "the unavailable endpoint is rejected at final admission before its RPC");
  assert.equal(pool.activeTurnCount, 2, "no later claim is reconciled after the loss");
});

test("a provisional claim bound during recovery stays resolved after its turn terminates", async () => {
  let terminal = false;
  const endpoint: AppServerEndpoint = {
    id: "devbox", state: "ready",
    request: async <T>(method: string, params: any) => pagedHistory<T>(method, params, {
      status: terminal ? "idle" : "active",
      turns: [{ id: "turn-a", status: terminal ? "completed" : "inProgress", itemsView: "full", items: [{ type: "userMessage", id: "user", clientId: "message-a" }] }],
    }),
  };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  pool.restoreProvisionalTurnCapacity("devbox", "thread-a", "recovered:op-a", "message-a", null);
  await pool.reconcileEndpointClaims("devbox");
  assert.equal(pool.activeTurnCount, 1);
  terminal = true;
  await pool.reconcileEndpointClaims("devbox");
  assert.equal(pool.activeTurnCount, 0);
  assert.equal(pool.restoreProvisionalTurnCapacity("devbox", "thread-a", "recovered:op-a", "message-a", null), undefined);
  assert.equal(pool.activeTurnCount, 0);
});

test("provisional reconciliation hydrates only turns newer than its durable baseline", async () => {
  const hydrated: string[] = [];
  const turns = [
    { id: "historical", status: "completed", items: [{ type: "userMessage", id: "old-user", clientId: "message-a" }] },
    { id: "baseline", status: "completed", items: [{ type: "agentMessage", id: "baseline-agent", text: "baseline" }] },
    { id: "candidate", status: "inProgress", items: [{ type: "userMessage", id: "new-user", clientId: "message-a" }] },
  ];
  const endpoint: AppServerEndpoint = {
    id: "devbox", state: "ready",
    request: async <T>(method: string, params: any) => {
      if (method === "thread/items/list") hydrated.push(params.turnId);
      return pagedHistory<T>(method, params, { status: "active", turns });
    },
  };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  pool.restoreProvisionalTurnCapacity("devbox", "thread-a", "recovered:bounded", "message-a", "baseline");

  await pool.reconcileEndpointClaims("devbox");
  pool.markTurnTerminal("devbox", "thread-a", "candidate");

  assert.deepEqual(hydrated, ["candidate"]);
  assert.equal(pool.activeTurnCount, 0, "the matching candidate was bound before terminal release");
});

test("a nonterminal reconciliation candidate is rescanned when its user item materializes", async () => {
  let itemReads = 0;
  const endpoint: AppServerEndpoint = {
    id: "devbox", state: "ready",
    request: async <T>(method: string, params: any) => {
      const turns = [{
        id: "candidate", status: "inProgress",
        items: itemReads > 0 ? [{ type: "userMessage", id: "user", clientId: "message-a" }] : [],
      }];
      if (method === "thread/items/list") itemReads += 1;
      return pagedHistory<T>(method, params, { status: "active", turns });
    },
  };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  pool.restoreProvisionalTurnCapacity("devbox", "thread-a", "recovered:late-item", "message-a", null);

  await pool.reconcileEndpointClaims("devbox");
  assert.equal(pool.activeTurnCount, 1);
  await pool.reconcileEndpointClaims("devbox");
  pool.markTurnTerminal("devbox", "thread-a", "candidate");

  assert.equal(itemReads, 2);
  assert.equal(pool.activeTurnCount, 0, "the second scan bound the same candidate");
});

test("legacy restored provisional claims without a baseline remain unresolved", async () => {
  let itemReads = 0;
  const endpoint: AppServerEndpoint = {
    id: "devbox", state: "ready",
    request: async <T>(method: string, params: any) => {
      if (method === "thread/items/list") itemReads += 1;
      return pagedHistory<T>(method, params, {
        status: "idle",
        turns: [{ id: "historical", status: "completed", items: [{ type: "userMessage", id: "user", clientId: "message-a" }] }],
      });
    },
  };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  pool.restoreProvisionalTurnCapacity("devbox", "thread-a", "recovered:legacy", "message-a");

  await pool.reconcileEndpointClaims("devbox");

  assert.equal(itemReads, 0);
  assert.equal(pool.activeTurnCount, 1);
});

test("claim reconciliation reads one bounded turn page and preserves an uncovered baseline", async () => {
  let turnPageReads = 0;
  const turns = Array.from({ length: 129 }, (_, index) => ({
    id: `turn-${index}`,
    status: "completed",
    items: [{ type: "userMessage", id: `user-${index}`, clientId: `other-${index}` }],
  }));
  const endpoint: AppServerEndpoint = {
    id: "devbox", state: "ready",
    request: async <T>(method: string, params: any) => {
      if (method === "thread/turns/list") turnPageReads += 1;
      return pagedHistory<T>(method, params, { status: "idle", turns });
    },
  };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  pool.restoreProvisionalTurnCapacity("devbox", "thread-a", "recovered:bounded-page", "message-a", null);

  await pool.reconcileEndpointClaims("devbox");

  assert.equal(turnPageReads, 1);
  assert.equal(pool.activeTurnCount, 1, "a partial page cannot prove a start absent from an empty-thread baseline");
});

test("a restored provisional claim cannot change its stable message correlation", () => {
  const pool = new AppServerPool([new FakeEndpoint()], { maxConcurrentTurns: 1 });
  pool.restoreProvisionalTurnCapacity("devbox", "thread-a", "recovered:op-a", "message-a");
  assert.throws(
    () => pool.restoreProvisionalTurnCapacity("devbox", "thread-a", "recovered:op-a", "message-b"),
    /changed message correlation/u,
  );
  assert.equal(pool.activeTurnCount, 1);
});

test("cold restored claims may exceed the limit but block new claims and release on runtime loss", () => {
  const pool = new AppServerPool([new FakeEndpoint()], { maxConcurrentTurns: 1 });
  pool.restoreObservedActiveTurn("remote", "t1", "turn-1");
  pool.restoreProvisionalTurnCapacity("remote", "t2", "recovered:op-2", "message-2");
  assert.equal(pool.activeTurnCount, 2);
  assert.equal(pool.hasClaims("remote"), true);
  assert.throws(() => pool.claimTurnCapacity("local", "new", "new"), /at most 1 turn/u);
  pool.markEndpointUnavailable("remote", "runtime-lost");
  assert.equal(pool.activeTurnCount, 0);
});

test("one endpoint lease spans a turn start and its nested RPC", async () => {
  const endpoint = new FakeEndpoint();
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  let acquisitions = 0;
  pool.setWorkLeaseProvider(async (endpointId, existing, run) => {
    if (existing) return run(existing);
    acquisitions += 1;
    return run({ endpointId, lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "lease-1" });
  });
  await pool.startTurn("local", { threadId: "thread-1", input: [] });
  assert.equal(acquisitions, 1);
});
