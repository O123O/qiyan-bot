import assert from "node:assert/strict";
import test from "node:test";
import { AppServerPool, type AppServerEndpoint } from "../../src/app-server/pool.ts";
import { AppError } from "../../src/core/errors.ts";
import type { ManagedAppServerEndpoint } from "../../src/endpoints/types.ts";

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
  return {} as T;
}

test("implicit worker starts do not retain claims or read history", async () => {
  const endpoint = new FakeEndpoint();
  const pool = new AppServerPool([endpoint], {});

  const first = await pool.startTurn("local", { threadId: "t1", input: [] });
  assert.equal(first.turn.id, "turn-1");
  const second = await pool.startTurn("local", { threadId: "t2", input: [] });
  assert.equal(second.turn.id, "turn-2");
  assert.equal(pool.activeTurnCount, 0);
});

test("a failed implicit start releases its claim without reading history", async () => {
  const endpoint: AppServerEndpoint = {
    id: "local", state: "ready",
    request: async <T>(method: string, params: any) => {
      if (method === "turn/start") throw new Error("start failed");
      return pagedHistory<T>(method, params, { status: "idle", turns: [] });
    },
  };
  const pool = new AppServerPool([endpoint]);
  await assert.rejects(
    pool.startTurn("local", { threadId: "t1", input: [] }),
    (error: unknown) => error instanceof AppError && error.code === "OPERATION_UNCERTAIN",
  );
  assert.equal(pool.activeTurnCount, 0);
});

test("implicit starts send a correlation and do not scan history when a response is lost", async () => {
  let sent: Record<string, unknown> | undefined;
  let historyReads = 0;
  const endpoint: AppServerEndpoint = {
    id: "local", state: "ready",
    request: async <T>(method: string, params: unknown) => {
      if (method === "thread/turns/list") {
        historyReads += 1;
        return { data: [], nextCursor: null, backwardsCursor: null } as T;
      }
      if (method === "turn/start") {
        sent = params as Record<string, unknown>;
        throw new Error("response lost");
      }
      throw new Error("connection lost");
    },
  };
  const pool = new AppServerPool([endpoint], {});
  await assert.rejects(
    pool.startTurn("local", { threadId: "t1", input: [] }),
    (error: unknown) => error instanceof AppError && error.code === "OPERATION_UNCERTAIN",
  );
  assert.equal(typeof sent?.clientUserMessageId, "string");
  assert.notEqual(sent?.clientUserMessageId, "");
  assert.equal(historyReads, 0);
  assert.equal(pool.activeTurnCount, 0);
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
  const pool = new AppServerPool([endpoint]);
  const starting = pool.startTurn("local", { threadId: "t1", clientUserMessageId: "message-1", input: [] });
  pool.markTurnTerminal("local", "t1", "turn-stale");
  resolveStart({ turn: { id: "turn-live", status: "inProgress" } });
  assert.equal((await starting).turn.id, "turn-live");
  assert.equal(reads, 0);
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
  const pool = new AppServerPool([endpoint]);
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
    const pool = new AppServerPool([endpoint], {});
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
  const pool = new AppServerPool([endpoint], {});
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

test("a lost interrupt response succeeds only when the exact turn is proven terminal", async () => {
  const endpoint: AppServerEndpoint = {
    id: "local", state: "ready",
    request: async <T>(method: string, params: any) => {
      if (method === "turn/interrupt") throw new Error("response lost");
      return pagedHistory<T>(method, params, { status: "idle", turns: [{ id: "turn-1", status: "interrupted", items: [] }] });
    },
  };
  const pool = new AppServerPool([endpoint], {});
  await pool.interrupt("local", "thread", "turn-1");
});

test("endpoint loss releases caller-owned provisional claims", async () => {
  const endpoint: AppServerEndpoint = {
    id: "local", state: "ready",
    request: async <T>(method: string) => {
      if (method === "turn/start") throw new Error("response lost");
      return { thread: { turns: [{ id: "older", status: "completed", itemsView: "summary", items: [] }] } } as T;
    },
  };
  const pool = new AppServerPool([endpoint]);
  const claim = pool.claimTurnCapacity("local", "assistant", "claim-ambiguous");
  await assert.rejects(
    pool.startTurn("local", { threadId: "assistant", clientUserMessageId: "message", input: [] }, claim),
    (error: unknown) => error instanceof AppError && error.code === "OPERATION_UNCERTAIN",
  );
  pool.markEndpointUnavailable("local");
  assert.equal(pool.activeTurnCount, 0);
});

test("a caller-owned uncertain start remains claimed until its owner settles it", async () => {
  const endpoint: AppServerEndpoint = {
    id: "local", state: "ready",
    request: async <T>(method: string) => {
      if (method === "turn/start") throw new Error("response lost");
      return { thread: { status: { type: "active" }, turns: [] } } as T;
    },
  };
  const pool = new AppServerPool([endpoint]);
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
    const pool = new AppServerPool([endpoint], {});
    await assert.rejects(pool.readFullThread("local", "assistant"), (error: unknown) => error instanceof AppError && error.code === "OPERATION_UNCERTAIN");
  }
  const endpoint: AppServerEndpoint = {
    id: "local", state: "ready",
    request: async <T>() => ({ thread: { turns: [{ id: "turn", status: "completed", itemsView: "full", items: [] }] } }) as T,
  };
  const pool = new AppServerPool([endpoint], {});
  assert.equal((await pool.readFullThread("local", "assistant")).turns[0]?.itemsView, "full");
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
  const pool = new AppServerPool([first], {});
  const old = pool.endpointGeneration("devbox");
  pool.replaceEndpoint(second);
  first.emitUnavailable();
  const current = pool.endpointGeneration("devbox");
  assert.equal(old.endpoint, first);
  assert.equal(current.endpoint, second);
  assert.equal(current.generation, old.generation + 1);
});

test("one endpoint lease spans a turn start and its nested RPC", async () => {
  const endpoint = new FakeEndpoint();
  const pool = new AppServerPool([endpoint], {});
  let acquisitions = 0;
  pool.setWorkLeaseProvider(async (endpointId, existing, run) => {
    if (existing) return run(existing);
    acquisitions += 1;
    return run({ endpointId, lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "lease-1" });
  });
  await pool.startTurn("local", { threadId: "thread-1", input: [] });
  assert.equal(acquisitions, 1);
});
