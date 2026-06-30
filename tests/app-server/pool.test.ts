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
