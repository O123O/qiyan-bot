import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AppServerEndpoint } from "../../src/app-server/pool.ts";
import { AppServerPool } from "../../src/app-server/pool.ts";
import { EventRelay } from "../../src/events/relay.ts";
import { SessionRegistry } from "../../src/registry/session-registry.ts";
import { FinalMessageStore } from "../../src/sessions/final-messages.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { RuntimeStore } from "../../src/storage/runtime-store.ts";

class RelayEndpoint implements AppServerEndpoint {
  readonly id = "local"; state: AppServerEndpoint["state"] = "ready";
  turns: any[] = [];
  async request<T>(): Promise<T> { return { thread: { turns: this.turns } } as T; }
}

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "relay-")));
  const db = createTestDatabase();
  const registry = await SessionRegistry.open(join(dir, "sessions.json"), {
    version: 1, coordinator: { endpoint: "local", thread_id: "coord", project_dir: dir },
    sessions: { payments: { endpoint: "local", thread_id: "worker", project_dir: dir } },
  });
  const endpoint = new RelayEndpoint();
  const runtime = new RuntimeStore(db);
  runtime.setSession("local", "worker", "managed", "idle");
  runtime.beginEpoch("local", "worker", "baseline", 1);
  const deliveries = new DeliveryStore(db);
  const relay = new EventRelay(db, new AppServerPool([endpoint], { maxConcurrentTurns: 4 }), registry, runtime, new FinalMessageStore(db), deliveries, { destination: "42", clock: { now: () => 100 } });
  return { db, endpoint, runtime, deliveries, relay };
}

function terminal(id = "turn-1", status = "completed", text = "done") {
  return { id, status, completedAt: 10, items: text ? [{ type: "agentMessage", id: `${id}-final`, text, phase: "final_answer" }] : [] };
}

test("managed worker finals create automatic delivery and metadata-only coordinator event exactly once", async () => {
  const { db, deliveries, relay } = await fixture();
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal() });
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal() });
  assert.deepEqual(deliveries.listReady().map((item) => item.body), ["[payments] done"]);
  const events = db.prepare("SELECT payload_json FROM events").all() as Array<{ payload_json: string }>;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.payload_json.includes("done"), false);
});

test("failed no-final turns warn, detached turns are excluded, and permission blocks are deduplicated", async () => {
  const { db, runtime, deliveries, relay } = await fixture();
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal("bad", "failed", "") });
  runtime.setSession("local", "worker", "detached", "idle");
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal("detached") });
  runtime.setSession("local", "worker", "managed", "idle");
  await relay.handlePermissionBlocked("local", { threadId: "worker", turnId: "blocked", method: "approval", params: {} });
  await relay.handlePermissionBlocked("local", { threadId: "worker", turnId: "blocked", method: "approval", params: {} });
  assert.deepEqual(deliveries.listReady().map((item) => item.body), [
    "[payments] turn bad failed without a final response",
    "[payments] blocked by a permission request",
  ]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events").get() as any).n, 2);
});

test("ready reconciliation reads history after baseline and advances a durable cursor", async () => {
  const { endpoint, deliveries, relay } = await fixture();
  endpoint.turns = [terminal("adopted"), terminal("baseline"), terminal("missed")];
  await relay.reconcileEndpoint("local");
  await relay.reconcileEndpoint("local");
  assert.deepEqual(deliveries.listReady().map((item) => item.body), ["[payments] done"]);
});

test("terminal notification with partial items reads the authoritative completed turn", async () => {
  const { endpoint, deliveries, relay } = await fixture();
  endpoint.turns = [terminal("readback", "completed", "from history")];
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal("readback", "completed", "") });
  assert.deepEqual(deliveries.listReady().map((item) => item.body), ["[payments] from history"]);
});

test("reconciliation stops at an in-progress turn without advancing past it", async () => {
  const { endpoint, runtime, deliveries, relay } = await fixture();
  endpoint.turns = [terminal("baseline"), { id: "working", status: "inProgress", completedAt: null, items: [] }];
  await relay.reconcileEndpoint("local");
  assert.equal(runtime.getSession("local", "worker")?.deliveryCursor, undefined);

  endpoint.turns = [terminal("baseline"), terminal("working", "completed", "later")];
  await relay.reconcileEndpoint("local");
  assert.deepEqual(deliveries.listReady().map((item) => item.body), ["[payments] later"]);
});

test("replaying an older terminal does not clear a newer active worker turn", async () => {
  const { endpoint, runtime, relay } = await fixture();
  runtime.setActiveTurn("local", "worker", "current");
  endpoint.turns = [terminal("baseline"), terminal("old"), { id: "current", status: "inProgress", completedAt: null, items: [] }];
  await relay.reconcileEndpoint("local");
  assert.equal(runtime.activeTurn("local", "worker"), "current");
  assert.equal(runtime.getSession("local", "worker")?.nativeStatus, "active");
});
