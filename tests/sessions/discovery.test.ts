import assert from "node:assert/strict";
import test from "node:test";
import type { AppServerEndpoint } from "../../src/app-server/pool.ts";
import { AppServerPool } from "../../src/app-server/pool.ts";
import { AppError } from "../../src/core/errors.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { SessionDiscovery, DISCOVERY_SOURCE_KINDS } from "../../src/sessions/discovery.ts";
import type { EndpointWorkLease } from "../../src/endpoints/types.ts";

type Row = { id: string; updatedAt: number; cwd: string; ephemeral: boolean; parentThreadId: string | null; preview: string };

class DiscoveryEndpoint implements AppServerEndpoint {
  readonly id = "local";
  state: AppServerEndpoint["state"] = "ready";
  readonly calls: Array<Record<string, unknown>> = [];
  pages = new Map<string, { data: Row[]; nextCursor: string | null }>();

  async request<T>(method: string, params: unknown): Promise<T> {
    assert.equal(method, "thread/list");
    const value = params as Record<string, unknown>;
    this.calls.push(value);
    const key = `${String(value.archived)}:${String(value.cursor ?? "first")}`;
    const page = this.pages.get(key);
    if (!page) throw new Error(`missing page ${key}`);
    return { ...page, backwardsCursor: null } as T;
  }
}

function row(id: string, updatedAt: number, overrides: Partial<Row> = {}): Row {
  return { id, updatedAt, cwd: "/work", ephemeral: false, parentThreadId: null, preview: id, ...overrides };
}

test("discovery exhausts both archives and returns stable filtered snapshot pages", async () => {
  let now = 1_000;
  const endpoint = new DiscoveryEndpoint();
  endpoint.pages.set("false:first", { data: [row("b", 20), row("child", 99, { parentThreadId: "p" })], nextCursor: "n2" });
  endpoint.pages.set("false:n2", { data: [row("a", 20), row("temp", 100, { ephemeral: true })], nextCursor: null });
  endpoint.pages.set("true:first", { data: [row("old", 10)], nextCursor: null });
  const db = createTestDatabase();
  const discovery = new SessionDiscovery(db, new AppServerPool([endpoint], { maxConcurrentTurns: 2 }), {
    clock: { now: () => now }, snapshotTtlMs: 100,
  });

  db.prepare("INSERT INTO discovery_snapshots(id, query_hash, rows_json, expires_at) VALUES ('expired', 'x', '[]', ?)").run(now - 1);
  const first = await discovery.list({ endpointId: "local", limit: 2 });
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM discovery_snapshots WHERE id = 'expired'").get() as { count: number }).count, 0);
  assert.deepEqual(first.sessions.map((item) => item.id), ["a", "b"]);
  assert.ok(first.nextCursor);
  assert.equal(endpoint.calls.length, 3);
  for (const call of endpoint.calls) {
    assert.deepEqual(call.sourceKinds, DISCOVERY_SOURCE_KINDS);
    assert.equal(call.useStateDbOnly, false);
    assert.equal("cwd" in call, false);
  }
  assert.deepEqual(endpoint.calls.map((call) => call.archived), [false, false, true]);

  endpoint.pages.clear();
  const second = await discovery.list({ endpointId: "local", limit: 2, cursor: first.nextCursor! });
  assert.deepEqual(second.sessions.map((item) => item.id), ["old"]);
  assert.equal(endpoint.calls.length, 3, "cursor reads the stored snapshot, not the changed server");

  await assert.rejects(
    discovery.list({ endpointId: "local", cwd: "/different", limit: 2, cursor: first.nextCursor! }),
    (error: unknown) => error instanceof AppError && error.code === "OPERATION_CONFLICT",
  );
  await assert.rejects(discovery.list({ endpointId: "local", limit: 2, cursor: `${first.nextCursor}x` }));
  now += 101;
  await assert.rejects(discovery.list({ endpointId: "local", limit: 2, cursor: first.nextCursor! }));
});

test("discovery search filters the combined snapshot by id, cwd, or preview", async () => {
  const endpoint = new DiscoveryEndpoint();
  endpoint.pages.set("false:first", { data: [row("one", 2, { preview: "Payments API" }), row("two", 1, { cwd: "/work/website" })], nextCursor: null });
  endpoint.pages.set("true:first", { data: [], nextCursor: null });
  const discovery = new SessionDiscovery(createTestDatabase(), new AppServerPool([endpoint], { maxConcurrentTurns: 2 }));
  assert.deepEqual((await discovery.list({ endpointId: "local", search: "payments" })).sessions.map((item) => item.id), ["one"]);
});

test("recovery discovery reuses the caller's endpoint lease for every native page", async () => {
  const endpoint = new DiscoveryEndpoint();
  endpoint.pages.set("false:first", { data: [], nextCursor: null });
  endpoint.pages.set("true:first", { data: [], nextCursor: null });
  const lease: EndpointWorkLease = { endpointId: "local", lifecycleGeneration: 1, endpointGeneration: 2, leaseId: "lease-1" };
  const seen: Array<EndpointWorkLease | undefined> = [];
  const pool = new AppServerPool([endpoint], {
    maxConcurrentTurns: 2,
    workLeaseProvider: async (_endpointId, existing, run) => { seen.push(existing); return run(existing); },
  });

  await new SessionDiscovery(createTestDatabase(), pool).list({ endpointId: "local" }, lease);

  assert.deepEqual(seen, [lease, lease]);
});
