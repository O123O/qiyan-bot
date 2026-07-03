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
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { OwnerRouteStore } from "../../src/chat/owner-route-store.ts";

const mappingId = "mapping-1";
const binding = { adapterId: "telegram", conversationKey: "telegram:42", destination: { chatId: "42" } } as const;

class RelayEndpoint implements AppServerEndpoint {
  readonly id = "local"; state: AppServerEndpoint["state"] = "ready";
  turns: any[] = [];
  async request<T>(): Promise<T> { return { thread: { turns: this.turns } } as T; }
}

async function fixture(onTerminal?: (event: any) => void | Promise<void>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "relay-")));
  const db = createTestDatabase();
  const registry = await SessionRegistry.open(join(dir, "sessions.json"), {
    version: 3, assistant: { endpoint: "local", thread_id: "coord", project_dir: dir },
    sessions: { payments: { endpoint: "local", thread_id: "worker", project_dir: dir, mapping_id: mappingId, lifecycle_state: "managed" } },
  });
  const endpoint = new RelayEndpoint();
  const runtime = new RuntimeStore(db);
  runtime.setSession("local", "worker", mappingId, "managed", "idle");
  runtime.beginEpoch("local", "worker", mappingId, "baseline", 1);
  const deliveries = new DeliveryStore(db);
  const routes = new OwnerRouteStore(db, binding);
  const conversations = new ConversationStore(db, deliveries);
  const relay = new EventRelay(db, new AppServerPool([endpoint], { maxConcurrentTurns: 4 }), registry, runtime, new FinalMessageStore(db), deliveries, { binding: () => routes.current(), clock: { now: () => 100 }, ...(onTerminal ? { onTerminal } : {}) });
  return { db, endpoint, registry, runtime, deliveries, relay, conversations, routes };
}

function terminal(id = "turn-1", status = "completed", text = "done") {
  return { id, status, startedAt: 5, completedAt: 10, items: text ? [{ type: "agentMessage", id: `${id}-final`, text, phase: "final_answer" }] : [] };
}

test("reports terminal metadata after final persistence without copying the body", async () => {
  const observed: any[] = [];
  const { db, endpoint, relay } = await fixture((event) => {
    assert.ok(db.prepare("SELECT id FROM logical_final_messages WHERE id = ?").get(event.finalMessageId));
    observed.push(event);
  });
  endpoint.turns = [terminal("baseline"), terminal()];
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal() });
  assert.deepEqual(observed, [{
    endpointId: "local",
    threadId: "worker",
    turnId: "turn-1",
    status: "completed",
    startedAt: 5,
    completedAt: 10,
    finalMessageId: "final:local:worker:turn-1:turn-1-final",
  }]);
  assert.equal(JSON.stringify(observed).includes("done"), false);
});

test("managed worker finals create automatic delivery and metadata-only assistant event exactly once", async () => {
  const { db, endpoint, deliveries, relay } = await fixture();
  endpoint.turns = [terminal("baseline"), terminal()];
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal() });
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal() });
  assert.deepEqual(deliveries.listReady().map((item) => item.body), ["[payments] done"]);
  const events = db.prepare("SELECT payload_json FROM events").all() as Array<{ payload_json: string }>;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.payload_json.includes("done"), false);
});

test("worker finals and permission warnings freeze the latest accepted owner route", async () => {
  const { endpoint, deliveries, relay, conversations } = await fixture();
  const slack = { adapterId: "slack", conversationKey: "slack:T1:thread:C1:1.0", destination: { workspaceId: "T1", channelId: "C1", threadTs: "1.0" }, reply: { messageTs: "2.0" } } as const;
  conversations.acceptChatSource({ id: "slack-owner", nativeSourceId: "T1:C1:2.0", binding: slack, rawText: "status", attachmentIds: [], receivedAt: 2 });
  endpoint.turns = [terminal("baseline"), terminal("latest")];
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal("latest") });
  await relay.handlePermissionBlocked("local", { threadId: "worker", turnId: "blocked-latest", method: "approval", params: {} });
  assert.deepEqual(deliveries.listReady().map((delivery) => delivery.binding), [slack, slack]);
});

test("failed no-final turns warn, transitional turns are excluded, and permission blocks are deduplicated", async () => {
  const { db, endpoint, registry, deliveries, relay } = await fixture();
  endpoint.turns = [terminal("baseline"), terminal("bad", "failed", "")];
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal("bad", "failed", "") });
  await relay.handlePermissionBlocked("local", { threadId: "worker", turnId: "blocked", method: "approval", params: {} });
  await relay.handlePermissionBlocked("local", { threadId: "worker", turnId: "blocked", method: "approval", params: {} });
  const session = registry.get("payments")!;
  await registry.transition("payments", session, "unadopting");
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal("removed") });
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
  endpoint.turns = [terminal("baseline"), terminal("readback", "completed", "from history")];
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal("readback", "completed", "") });
  assert.deepEqual(deliveries.listReady().map((item) => item.body), ["[payments] from history"]);
});

test("reconciliation stops at an in-progress turn without advancing past it", async () => {
  const { endpoint, runtime, deliveries, relay } = await fixture();
  endpoint.turns = [terminal("baseline"), { id: "working", status: "inProgress", completedAt: null, items: [] }];
  await relay.reconcileEndpoint("local");
  assert.equal(runtime.getSession("local", "worker", mappingId)?.deliveryCursor, undefined);

  endpoint.turns = [terminal("baseline"), terminal("working", "completed", "later")];
  await relay.reconcileEndpoint("local");
  assert.deepEqual(deliveries.listReady().map((item) => item.body), ["[payments] later"]);
});

test("replaying an older terminal does not clear a newer active worker turn", async () => {
  const { endpoint, runtime, relay } = await fixture();
  runtime.setActiveTurn("local", "worker", mappingId, "current");
  endpoint.turns = [terminal("baseline"), terminal("old"), { id: "current", status: "inProgress", completedAt: null, items: [] }];
  await relay.reconcileEndpoint("local");
  assert.equal(runtime.activeTurn("local", "worker", mappingId), "current");
  assert.equal(runtime.getSession("local", "worker", mappingId)?.nativeStatus, "active");
});

test("a delayed terminal from before the current mapping epoch is not delivered after re-adoption", async () => {
  const { endpoint, deliveries, relay } = await fixture();
  endpoint.turns = [terminal("old"), terminal("baseline")];
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal("old") });
  assert.deepEqual(deliveries.listReady(), []);
});

test("a mapping generation change during authoritative read suppresses the delayed terminal", async () => {
  const { endpoint, registry, runtime, deliveries, relay } = await fixture();
  endpoint.turns = [terminal("baseline"), terminal("delayed")];
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  endpoint.request = async <T>() => {
    entered();
    await barrier;
    return { thread: { turns: endpoint.turns } } as T;
  };

  const pending = relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal("delayed") });
  await reading;
  const old = registry.get("payments")!;
  await registry.transition("payments", old, "unadopting");
  await registry.removeIfMatch("payments", old);
  const replacement = { ...old, mapping_id: "mapping-2", lifecycle_state: "adopting" as const };
  await registry.reserve("payments", replacement);
  await registry.promote("payments", replacement);
  runtime.setSession("local", "worker", "mapping-2", "managed", "idle");
  runtime.beginEpoch("local", "worker", "mapping-2", "baseline", 2);
  release();
  await pending;

  assert.deepEqual(deliveries.listReady(), []);
});

test("ready reconciliation cannot deliver across a re-adoption during its history read", async () => {
  const { endpoint, registry, runtime, deliveries, relay } = await fixture();
  endpoint.turns = [terminal("baseline"), terminal("missed")];
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  endpoint.request = async <T>() => {
    entered();
    await barrier;
    return { thread: { turns: endpoint.turns } } as T;
  };

  const pending = relay.reconcileEndpoint("local");
  await reading;
  const old = registry.get("payments")!;
  await registry.transition("payments", old, "unadopting");
  await registry.removeIfMatch("payments", old);
  const replacement = { ...old, mapping_id: "mapping-2", lifecycle_state: "adopting" as const };
  await registry.reserve("payments", replacement);
  await registry.promote("payments", replacement);
  runtime.setSession("local", "worker", "mapping-2", "managed", "idle");
  runtime.beginEpoch("local", "worker", "mapping-2", "baseline", 2);
  release();
  await pending;

  assert.deepEqual(deliveries.listReady(), []);
});

test("ready reconciliation refreshes the nickname after a concurrent rename", async () => {
  const { endpoint, registry, deliveries, relay } = await fixture();
  endpoint.turns = [terminal("baseline"), terminal("missed")];
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  endpoint.request = async <T>() => {
    entered();
    await barrier;
    return { thread: { turns: endpoint.turns } } as T;
  };

  const pending = relay.reconcileEndpoint("local");
  await reading;
  const mapping = registry.get("payments")!;
  await registry.rename("payments", "billing", mapping);
  release();
  await pending;

  assert.deepEqual(deliveries.listReady().map((delivery) => delivery.body), ["[billing] done"]);
});

test("automatic worker delivery is suppressed for every transitional mapping lifecycle", async () => {
  for (const state of ["adopting", "unadopting", "archiving"] as const) {
    const { registry, runtime, deliveries, relay } = await fixture();
    const current = registry.get("payments")!;
    if (state === "adopting") {
      await registry.transition("payments", current, "unadopting");
      await registry.removeIfMatch("payments", current);
      await registry.reserve("payments", { ...current, mapping_id: "mapping-adopting", lifecycle_state: "adopting" });
      runtime.setSession("local", "worker", "mapping-adopting", "adopting", "idle");
    } else {
      await registry.transition("payments", current, state);
      runtime.setSession("local", "worker", current.mapping_id, state, "idle");
    }
    await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal(`turn-${state}`) });
    assert.deepEqual(deliveries.listReady(), []);
  }
});
