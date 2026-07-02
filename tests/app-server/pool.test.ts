import assert from "node:assert/strict";
import test from "node:test";
import { AppServerPool, type AppServerEndpoint } from "../../src/app-server/pool.ts";
import { AppError } from "../../src/core/errors.ts";

class FakeEndpoint implements AppServerEndpoint {
  readonly id = "local";
  state: AppServerEndpoint["state"] = "ready";
  fail = false;
  nextTurn = 1;

  async request<T>(method: string): Promise<T> {
    if (this.fail) throw new Error("transport failed");
    if (method === "turn/start") {
      return { turn: { id: `turn-${this.nextTurn++}` } } as T;
    }
    return {} as T;
  }
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

test("failed starts and endpoint loss release capacity", async () => {
  const endpoint = new FakeEndpoint();
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  endpoint.fail = true;
  await assert.rejects(pool.startTurn("local", { threadId: "t1", input: [] }));
  endpoint.fail = false;
  await pool.startTurn("local", { threadId: "t1", input: [] });
  pool.markEndpointUnavailable("local");
  endpoint.state = "ready";
  await pool.startTurn("local", { threadId: "t2", input: [] });
});

test("a terminal notification that arrives before turn/start responds does not leak capacity", async () => {
  let resolveStart!: (value: any) => void;
  let reads = 0;
  const endpoint: AppServerEndpoint = {
    id: "local", state: "ready",
    request: async <T>(method: string) => method === "turn/start"
      ? new Promise<T>((resolve) => { resolveStart = resolve; })
      : { thread: { turns: ++reads === 1 ? [] : [{ id: "turn-early", items: [{ type: "userMessage", clientId: "message-1" }] }] } } as T,
  };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1, sleep: async () => undefined });
  const starting = pool.startTurn("local", { threadId: "t1", clientUserMessageId: "message-1", input: [] });
  pool.markTurnTerminal("local", "t1", "turn-early");
  resolveStart({ turn: { id: "wrong-thread-like-id" } });
  assert.equal((await starting).turn.id, "turn-early");
  assert.equal(reads, 2);
  assert.equal(pool.activeTurnCount, 0);
});

test("a lost turn/start response is proven from history instead of retransmitted", async () => {
  let starts = 0;
  const endpoint: AppServerEndpoint = {
    id: "local", state: "ready",
    request: async <T>(method: string) => {
      if (method === "turn/start") { starts += 1; throw new Error("response lost"); }
      return { thread: { turns: [{ id: "created", status: "inProgress", items: [{ type: "userMessage", clientId: "stable-client-id" }] }] } } as T;
    },
  };
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  assert.equal((await pool.startTurn("local", { threadId: "t", clientUserMessageId: "stable-client-id", input: [] })).turn.id, "created");
  assert.equal(starts, 1);
});

test("a failed history read after turn/start uncertainty remains operation uncertainty", async () => {
  const endpoint: AppServerEndpoint = {
    id: "local", state: "ready",
    request: async <T>(method: string) => {
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
    request: async <T>(method: string) => {
      if (method === "turn/interrupt") throw new Error("response lost");
      return { thread: { turns: [{ id: "turn-1", status: "interrupted" }] } } as T;
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
  pool.markTurnTerminal("local", "assistant", "turn-1");
  assert.equal(pool.activeTurnCount, 0);
});

test("ambiguous starts and endpoint loss retain caller-owned provisional claims", async () => {
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
  assert.equal(pool.activeTurnCount, 1);
  pool.releaseTurnCapacityClaim(claim);
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
