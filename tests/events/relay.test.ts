import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AppServerEndpoint } from "../../src/app-server/pool.ts";
import { AppServerPool } from "../../src/app-server/pool.ts";
import { EventRelay, type RelayTimers } from "../../src/events/relay.ts";
import type { EndpointWorkLease } from "../../src/endpoints/types.ts";
import { SessionRegistry } from "../../src/registry/session-registry.ts";
import { FinalMessageStore } from "../../src/sessions/final-messages.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { RuntimeStore } from "../../src/storage/runtime-store.ts";
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { OwnerRouteStore } from "../../src/chat/owner-route-store.ts";
import { SessionObservationProcessor } from "../../src/assistant/session-observer.ts";
import { SessionDashboardStore } from "../../src/storage/session-dashboard-store.ts";
import { ThreadGate } from "../../src/sessions/thread-gate.ts";
import { JsonRpcResponseError } from "../../src/app-server/rpc-client.ts";

const mappingId = "mapping-1";
const binding = { adapterId: "telegram", conversationKey: "telegram:42", destination: { chatId: "42" } } as const;
const workLease: EndpointWorkLease = {
  endpointId: "local", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "relay-test-lease",
};

type ScheduledRelayRetry = { callback: () => void; handle: ReturnType<typeof setTimeout>; ms: number };

class FakeRelayTimers implements RelayTimers {
  readonly scheduled: ScheduledRelayRetry[] = [];
  readonly cleared: Array<ReturnType<typeof setTimeout>> = [];
  private nextHandle = 1;

  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const handle = this.nextHandle as unknown as ReturnType<typeof setTimeout>;
    this.nextHandle += 1;
    this.scheduled.push({ callback, handle, ms });
    return handle;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.cleared.push(handle);
    const index = this.scheduled.findIndex((scheduled) => scheduled.handle === handle);
    if (index >= 0) this.scheduled.splice(index, 1);
  }
}

class RelayEndpoint implements AppServerEndpoint {
  readonly id = "local"; state: AppServerEndpoint["state"] = "ready";
  turns: any[] = [];
  async request<T>(_method: string, _params: unknown): Promise<T> { return { thread: { turns: this.turns } } as T; }
}

async function fixture(
  onTerminal?: (event: any, lease?: EndpointWorkLease) => void | Promise<void>,
  ownershipOverride?: {
    inspect(): Promise<{ state: "owned" | "pending" | "lost" } | { state: "external"; turnId: string } | { state: "unclassified"; turnId: string }>;
    ownsTurn(identity: unknown, turnId: string): boolean;
  },
  relayOptions: {
    timers?: RelayTimers;
    onEventCommitted?: () => void | Promise<void>;
    attachments?: { releaseTurn(endpointId: string, threadId: string, turnId: string): void };
    withEndpointWorkLease?<T>(
      endpointId: string,
      existingLease: EndpointWorkLease | undefined,
      run: (lease: EndpointWorkLease) => Promise<T>,
    ): Promise<T>;
    poolWorkLeaseProvider?<T>(
      endpointId: string,
      existingLease: EndpointWorkLease | undefined,
      run: (lease: EndpointWorkLease | undefined) => Promise<T>,
    ): Promise<T>;
  } = {},
) {
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
  const ownership = ownershipOverride ?? {
    inspect: async () => ({ state: "owned" as const }),
    ownsTurn: (_identity: unknown, _turnId: string) => true,
  };
  const pool = new AppServerPool([endpoint], {
    maxConcurrentTurns: 4,
    ...(relayOptions.poolWorkLeaseProvider ? { workLeaseProvider: relayOptions.poolWorkLeaseProvider } : {}),
  });
  const relay = new EventRelay(db, pool, registry, runtime, new FinalMessageStore(db), deliveries, {
    binding: () => routes.current(),
    clock: { now: () => 100 },
    withEndpointWorkLease: relayOptions.withEndpointWorkLease
      ?? (async (_endpointId, existingLease, run) => run(existingLease ?? workLease)),
    ...(onTerminal ? { onTerminal } : {}),
    ...(relayOptions.onEventCommitted ? { onEventCommitted: relayOptions.onEventCommitted } : {}),
  }, relayOptions.attachments, ownership, new ThreadGate(), relayOptions.timers);
  return { db, endpoint, pool, registry, runtime, deliveries, relay, conversations, routes };
}

function terminal(id = "turn-1", status = "completed", text = "done") {
  return { id, status, startedAt: 5, completedAt: 10, items: text ? [{ type: "agentMessage", id: `${id}-final`, text, phase: "final_answer" }] : [] };
}

function retainedTargets(relay: EventRelay): unknown[] {
  return [...(relay as unknown as { retryTargets: Map<string, unknown> }).retryTargets.values()];
}

async function relayIdle(relay: EventRelay): Promise<void> {
  await Promise.all([...(relay as unknown as { endpointTails: Map<string, Promise<void>> }).endpointTails.values()]);
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

test("an idle status recovers a missing completion notification through worker delivery", async () => {
  let observer!: SessionObservationProcessor;
  const value = await fixture((event, lease) => observer.observeTerminal(event, lease));
  const dashboard = new SessionDashboardStore(value.db);
  observer = new SessionObservationProcessor(dashboard, value.registry, value.runtime, {
    now: () => 100,
    readThread: async (endpointId, threadId, lease) => (await value.pool.request<any>(
      endpointId, "thread/read", { threadId, includeTurns: true }, undefined, lease,
    )).thread,
    readGoal: async () => ({ goal: null }),
    onIdleTurn: async ({ endpointId, threadId, turnId }) => {
      await value.relay.handleNotification(endpointId, "turn/completed", { threadId, turn: { id: turnId } }, workLease);
    },
    onChanged: () => undefined,
    onError: (error) => { throw error; },
  });
  value.endpoint.turns = [terminal("baseline"), terminal("missed")];
  value.runtime.setActiveTurn("local", "worker", mappingId, "missed");

  observer.accept("local", "thread/status/changed", { threadId: "worker", status: { type: "idle" } });
  await observer.idle();

  assert.deepEqual(value.deliveries.listReady().map((delivery) => delivery.body), ["[payments] done"]);
  assert.equal((value.db.prepare("SELECT COUNT(*) AS n FROM events WHERE turn_id = 'missed'").get() as { n: number }).n, 1);
  assert.equal(dashboard.facts({ endpointId: "local", threadId: "worker" }).lastWorkerEvent?.turn_id, "missed");
  assert.equal(value.runtime.activeTurn("local", "worker", mappingId), undefined);
  assert.equal(dashboard.pendingNotifications().length, 0);
});

test("a final terminal projection wakes once only after the inserted event is ready", async () => {
  let releaseTerminal!: () => void;
  const terminalBarrier = new Promise<void>((resolve) => { releaseTerminal = resolve; });
  let terminalEntered = false;
  const sequence: string[] = [];
  let readyDeliveryIds = (): string[] => [];
  const value = await fixture(async () => {
    terminalEntered = true;
    await terminalBarrier;
    sequence.push("terminal");
  }, undefined, {
    attachments: {
      releaseTurn: () => { sequence.push("attachments"); },
    },
    onEventCommitted: async (...args: unknown[]) => {
      assert.deepEqual(args, [], "the wake receives no event payload or message body");
      assert.deepEqual(readyDeliveryIds(), ["worker:local:worker:turn-1:turn-1-final"]);
      sequence.push("wake");
    },
  });
  readyDeliveryIds = () => value.deliveries.listReady().map((delivery) => delivery.id);
  value.endpoint.turns = [terminal("baseline"), terminal()];

  const projecting = value.relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal() },
  );
  try {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(terminalEntered, true);
    assert.equal((value.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 0);
    assert.deepEqual(sequence, []);
  } finally {
    releaseTerminal();
  }
  assert.equal(await projecting, "handled");
  assert.deepEqual(sequence, ["terminal", "attachments", "wake"]);

  assert.equal(await value.relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal() },
  ), "handled");
  assert.deepEqual(sequence, ["terminal", "attachments", "wake", "terminal", "attachments"],
    "replaying an ignored insert does not wake again");
});

test("a rejected terminal observer leaves no terminal event and does not wake", async () => {
  let wakes = 0;
  const { db, endpoint, relay } = await fixture(async () => {
    throw new Error("observation failed");
  }, undefined, {
    onEventCommitted: async () => { wakes += 1; },
  });
  endpoint.turns = [terminal("baseline"), terminal()];

  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal() },
  ), "retry");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 0);
  assert.equal(wakes, 0);
});

test("permission projection commits delivery and runtime before the event wake", async () => {
  let releaseWake!: () => void;
  const wakeBarrier = new Promise<void>((resolve) => { releaseWake = resolve; });
  let wakeEntered = false;
  const value = await fixture(undefined, undefined, {
    onEventCommitted: async () => {
      wakeEntered = true;
      await wakeBarrier;
    },
  });

  const projecting = value.relay.handlePermissionBlocked(
    "local", { threadId: "worker", turnId: "blocked", method: "approval", params: {} },
  );
  try {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(wakeEntered, true);
    assert.deepEqual(value.deliveries.listReady().map((delivery) => delivery.id), [
      "permission:local:worker:blocked:approval",
    ]);
    assert.equal(value.runtime.getSession("local", "worker", mappingId)?.nativeStatus, "permissionBlocked");
  } finally {
    releaseWake();
  }
  await projecting;
});

test("permission runtime projection failure inserts no event and does not wake", async () => {
  let wakes = 0;
  const value = await fixture(undefined, undefined, {
    onEventCommitted: async () => { wakes += 1; },
  });
  value.runtime.setSession = () => { throw new Error("runtime projection failed"); };

  await assert.rejects(value.relay.handlePermissionBlocked(
    "local", { threadId: "worker", turnId: "blocked", method: "approval", params: {} },
  ), /runtime projection failed/u);
  assert.equal((value.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 0);
  assert.equal(wakes, 0);
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

test("an ownership fence suppresses external replay but recovers an exact owned terminal", async () => {
  const { endpoint, runtime, deliveries, relay } = await fixture(undefined, {
    inspect: async () => ({ state: "external", turnId: "external" }),
    ownsTurn: (_identity, turnId) => turnId === "owned-active",
  });
  runtime.setActiveTurn("local", "worker", mappingId, "owned-active");
  runtime.setSession("local", "worker", mappingId, "unadopting", "active");
  endpoint.turns = [terminal("baseline"), terminal("external", "interrupted", ""), terminal("owned-active", "completed", "owned final")];

  await relay.reconcileEndpoint("local");
  assert.deepEqual(deliveries.listReady().map((delivery) => delivery.body), ["[payments] owned final"]);
  assert.equal(runtime.activeTurn("local", "worker", mappingId), undefined);
  assert.equal(runtime.getSession("local", "worker", mappingId)?.deliveryCursor, "owned-active");
});

test("an external terminal notification is ownership-scanned and cannot use cached active state", async () => {
  const { endpoint, runtime, deliveries, registry, routes, db } = await fixture();
  const sequence: string[] = [];
  endpoint.turns = [terminal("baseline"), terminal("external", "completed", "external body")];
  endpoint.request = async <T>() => { sequence.push("read"); return { thread: { turns: endpoint.turns } } as T; };
  const observer = new SessionObservationProcessor(new SessionDashboardStore(db), registry, runtime, {
    now: () => 50,
    readThread: async () => ({ turns: [] }),
    readGoal: async () => ({ goal: null }),
    onChanged: () => undefined,
    onError: (error) => { throw error; },
  });
  assert.equal(observer.accept("local", "turn/started", { threadId: "worker", turn: { id: "external", startedAt: 5 } }), true);
  await observer.idle();
  assert.equal(runtime.activeTurn("local", "worker", mappingId), "external");
  runtime.setSession("local", "worker", mappingId, "unadopting", "active");
  const ownership = {
    inspect: async () => { sequence.push("scan"); return { state: "external" as const, turnId: "external" }; },
    ownsTurn: () => { sequence.push("prove"); return false; },
  };
  const relay = new EventRelay(db, new AppServerPool([endpoint], { maxConcurrentTurns: 4 }), registry, runtime, new FinalMessageStore(db), deliveries, {
    binding: () => routes.current(), clock: { now: () => 100 },
    withEndpointWorkLease: async (_endpointId, existingLease, run) => run(existingLease ?? workLease),
  }, undefined, ownership, new ThreadGate());

  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal("external", "completed", "") });

  assert.deepEqual(sequence, ["scan", "read", "scan", "prove"]);
  assert.deepEqual(deliveries.listReady(), []);
});

test("a turn that becomes external during authoritative read is fenced before delivery", async () => {
  const { endpoint, runtime, deliveries, registry, routes, db } = await fixture();
  endpoint.turns = [terminal("baseline"), terminal("racing-external", "completed", "must not deliver")];
  let scans = 0;
  const ownership = {
    inspect: async () => {
      scans += 1;
      if (scans === 1) return { state: "owned" as const };
      runtime.setSession("local", "worker", mappingId, "unadopting", "idle");
      return { state: "external" as const, turnId: "racing-external" };
    },
    ownsTurn: () => false,
  };
  const relay = new EventRelay(db, new AppServerPool([endpoint], { maxConcurrentTurns: 4 }), registry, runtime, new FinalMessageStore(db), deliveries, {
    binding: () => routes.current(), clock: { now: () => 100 },
    withEndpointWorkLease: async (_endpointId, existingLease, run) => run(existingLease ?? workLease),
  }, undefined, ownership, new ThreadGate());

  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal("racing-external", "completed", "") });

  assert.equal(scans, 2);
  assert.deepEqual(deliveries.listReady(), []);
});

test("an unclassified task-start boundary blocks relay history reads", async () => {
  const { endpoint, deliveries, registry, routes, db, runtime } = await fixture();
  let reads = 0;
  endpoint.request = async <T>() => { reads += 1; return { thread: { turns: endpoint.turns } } as T; };
  const ownership = {
    inspect: async () => ({ state: "unclassified" as const, turnId: "boundary-turn" }),
    ownsTurn: () => false,
  };
  const relay = new EventRelay(db, new AppServerPool([endpoint], { maxConcurrentTurns: 4 }), registry, runtime, new FinalMessageStore(db), deliveries, {
    binding: () => routes.current(), clock: { now: () => 100 },
    withEndpointWorkLease: async (_endpointId, existingLease, run) => run(existingLease ?? workLease),
  }, undefined, ownership, new ThreadGate());

  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal("boundary-turn") });

  assert.equal(reads, 0);
  assert.deepEqual(deliveries.listReady(), []);
});

test("a pathless ownership boundary blocks notification and ready-history reads", async () => {
  let reads = 0;
  const value = await fixture(undefined, {
    inspect: async () => ({ state: "pending" }),
    ownsTurn: () => false,
  });
  value.endpoint.request = async <T>() => { reads += 1; return { thread: { turns: value.endpoint.turns } } as T; };

  assert.equal(await value.relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("pending-turn") }, workLease,
  ), "retry");
  await value.relay.reconcileEndpoint("local");

  assert.equal(reads, 0);
  assert.equal(value.runtime.getSession("local", "worker", mappingId)?.deliveryCursor, undefined);
  assert.deepEqual(value.deliveries.listReady(), []);
});

test("ready reconciliation reads history after baseline and advances a durable cursor", async () => {
  const { endpoint, deliveries, relay } = await fixture();
  endpoint.turns = [terminal("adopted"), terminal("baseline"), terminal("missed")];
  await relay.reconcileEndpoint("local");
  await relay.reconcileEndpoint("local");
  assert.deepEqual(deliveries.listReady().map((item) => item.body), ["[payments] done"]);
});

test("an empty first session does not block endpoint-ready reconciliation for later sessions", async () => {
  const timers = new FakeRelayTimers();
  const { endpoint, registry, runtime, deliveries, relay } = await fixture(undefined, undefined, { timers });
  runtime.endEpoch("local", "worker", mappingId, 2);
  runtime.beginEpoch("local", "worker", mappingId, undefined, 3);
  await registry.createManaged("later", {
    endpoint: "local", thread_id: "later-worker", project_dir: registry.get("payments")!.project_dir, mapping_id: "mapping-later",
  });
  runtime.setSession("local", "later-worker", "mapping-later", "managed", "idle");
  runtime.beginEpoch("local", "later-worker", "mapping-later", "later-baseline", 4);
  const requests: Array<{ threadId: string; includeTurns: boolean }> = [];
  endpoint.request = async <T>(_method: string, params: any) => {
    requests.push(params);
    if (params.threadId === "worker" && params.includeTurns === true) {
      throw new JsonRpcResponseError(-32600, "thread worker is not materialized yet; includeTurns is unavailable before first user message");
    }
    if (params.threadId === "worker") return { thread: { id: "worker", status: { type: "idle" }, turns: [] } } as T;
    return { thread: { turns: [terminal("later-baseline"), terminal("later-missed")] } } as T;
  };

  await relay.endpointReady("local", workLease);

  assert.deepEqual(requests, [
    { threadId: "worker", includeTurns: true },
    { threadId: "worker", includeTurns: false },
    { threadId: "later-worker", includeTurns: true },
  ]);
  assert.deepEqual(deliveries.listReady().map((item) => item.body), ["[later] done"]);
  assert.equal((relay as unknown as { scanPendingEndpoints: Set<string> }).scanPendingEndpoints.size, 0);
  assert.equal(timers.scheduled.length, 0);
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

test("terminal projection exposes exact handled, conclusively ignored, and retry outcomes", async () => {
  const handled = await fixture();
  handled.endpoint.turns = [terminal("baseline"), terminal("handled")];
  assert.equal(await handled.relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("handled", "completed", "projected") }, workLease,
  ), "handled");

  const external = await fixture(undefined, {
    inspect: async () => ({ state: "external", turnId: "external" }),
    ownsTurn: () => false,
  });
  external.endpoint.turns = [terminal("baseline"), terminal("external")];
  assert.equal(await external.relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("external") }, workLease,
  ), "conclusively_ignored");

  const unclassified = await fixture(undefined, {
    inspect: async () => ({ state: "unclassified", turnId: "uncertain" }),
    ownsTurn: () => false,
  });
  unclassified.endpoint.turns = [terminal("baseline"), terminal("uncertain")];
  assert.equal(await unclassified.relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("uncertain") }, workLease,
  ), "retry");

  const pending = await fixture(undefined, {
    inspect: async () => ({ state: "pending" }),
    ownsTurn: () => false,
  });
  pending.endpoint.turns = [terminal("baseline"), terminal("pending")];
  assert.equal(await pending.relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("pending") }, workLease,
  ), "retry");

  const absent = await fixture();
  absent.endpoint.turns = [terminal("baseline")];
  assert.equal(await absent.relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("absent") }, workLease,
  ), "retry");

  const transient = await fixture();
  transient.endpoint.request = async () => { throw new Error("transient read failure"); };
  assert.equal(await transient.relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("transient") }, workLease,
  ), "retry");
});

test("relay retains two exact targets without retaining notification contents", async () => {
  const timers = new FakeRelayTimers();
  const { endpoint, runtime, relay } = await fixture(undefined, undefined, { timers });
  endpoint.turns = [terminal("baseline")];
  const epochId = runtime.currentEpoch("local", "worker", mappingId)!.id;

  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("one", "completed", "secret one") }, workLease,
  ), "retry");
  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("two", "completed", "secret two") }, workLease,
  ), "retry");

  assert.deepEqual(retainedTargets(relay), [
    { endpointId: "local", threadId: "worker", turnId: "one", mappingId, epochId },
    { endpointId: "local", threadId: "worker", turnId: "two", mappingId, epochId },
  ]);
  assert.equal(JSON.stringify(retainedTargets(relay)).includes("secret"), false);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0]?.ms, 1_000);
});

test("a stale endpoint lease retains the immutable target for retry", async () => {
  const timers = new FakeRelayTimers();
  const { relay } = await fixture(undefined, undefined, {
    timers,
    withEndpointWorkLease: async () => { throw new Error("stale lease"); },
  });

  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("stale-lease", "completed", "not retained") }, workLease,
  ), "retry");
  assert.deepEqual(retainedTargets(relay).map((target: any) => target.turnId), ["stale-lease"]);
  assert.equal(JSON.stringify(retainedTargets(relay)).includes("not retained"), false);
  assert.equal(timers.scheduled.length, 1);
});

test("endpoint retry backoff is capped and never owns more than one timer", async () => {
  const timers = new FakeRelayTimers();
  const { endpoint, relay } = await fixture(undefined, undefined, { timers });
  endpoint.turns = [terminal("baseline")];
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal("backoff") }, workLease);

  for (const expected of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    assert.equal(timers.scheduled.length, 1);
    const scheduled = timers.scheduled.shift()!;
    assert.equal(scheduled.ms, expected);
    scheduled.callback();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  await relay.stop();
  assert.equal(timers.scheduled.length, 0);
});

test("worker completions use one serialized in-flight tail per endpoint", async () => {
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let acquisitions = 0;
  const { endpoint, relay } = await fixture(undefined, undefined, {
    withEndpointWorkLease: async (_endpointId, existingLease, run) => {
      acquisitions += 1;
      return run(existingLease ?? workLease);
    },
  });
  endpoint.turns = [terminal("baseline")];
  let reads = 0;
  endpoint.request = async <T>() => {
    reads += 1;
    if (reads === 1) { entered(); await barrier; }
    return { thread: { turns: endpoint.turns } } as T;
  };

  const first = relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal("first") }, workLease);
  await reading;
  const second = relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal("second") }, workLease);
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(acquisitions, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["retry", "retry"]);
  assert.equal(acquisitions, 2);
});

test("a blocked endpoint tail retains only exact IDs from later notification work", async () => {
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const { endpoint, relay } = await fixture();
  endpoint.turns = [terminal("baseline")];
  let reads = 0;
  endpoint.request = async <T>() => {
    reads += 1;
    if (reads === 1) { entered(); await barrier; }
    return { thread: { turns: endpoint.turns } } as T;
  };
  const first = relay.handleNotification("local", "turn/completed", {
    threadId: "worker", turn: terminal("blocked-first", "completed", "first secret"),
  }, workLease);
  await reading;
  const queuedParams = {
    threadId: "worker",
    turn: terminal("queued-second", "completed", "queued notification secret"),
    ignored: { attachment: "raw notification content" },
  };
  const second = relay.handleNotification("local", "turn/completed", queuedParams, workLease);
  await new Promise<void>((resolve) => { setImmediate(resolve); });

  assert.deepEqual(retainedTargets(relay).map((target: any) => Object.keys(target).sort()), [
    ["endpointId", "epochId", "mappingId", "threadId", "turnId"],
  ]);
  assert.equal(JSON.stringify(retainedTargets(relay)).includes("secret"), false);
  assert.equal(JSON.stringify(retainedTargets(relay)).includes("raw notification"), false);
  queuedParams.turn.id = "mutated-after-queue";
  queuedParams.turn.items[0]!.text = "mutated secret";
  release();
  await Promise.all([first, second]);
  assert.deepEqual(retainedTargets(relay).map((target: any) => target.turnId), ["blocked-first", "queued-second"]);
  assert.equal(JSON.stringify(retainedTargets(relay)).includes("mutated"), false);
});

test("a failed ready history scan retries even without a prior exact target", async () => {
  const timers = new FakeRelayTimers();
  const { endpoint, runtime, deliveries, relay } = await fixture(undefined, undefined, { timers });
  endpoint.turns = [terminal("baseline"), terminal("missed", "completed", "found on retry")];
  let reads = 0;
  endpoint.request = async <T>() => {
    reads += 1;
    if (reads === 1) throw new Error("transient initial scan failure");
    return { thread: { turns: endpoint.turns } } as T;
  };

  await assert.rejects(relay.endpointReady("local", workLease), /transient initial scan failure/);
  assert.equal(retainedTargets(relay).length, 0);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0]?.ms, 1_000);
  timers.scheduled.shift()!.callback();
  await relayIdle(relay);

  assert.deepEqual(deliveries.listReady().map((delivery) => delivery.body), ["[payments] found on retry"]);
  assert.equal(runtime.getSession("local", "worker", mappingId)?.deliveryCursor, "missed");
});

test("partial ready projection failure retains the scan and later terminal turns for its timer", async () => {
  const timers = new FakeRelayTimers();
  let observations = 0;
  const { endpoint, runtime, deliveries, relay } = await fixture(() => {
    observations += 1;
    if (observations === 1) throw new Error("transient projection failure");
  }, undefined, { timers });
  endpoint.turns = [
    terminal("baseline"),
    terminal("first", "completed", "first final"),
    terminal("second", "completed", "second final"),
  ];

  await assert.rejects(relay.endpointReady("local", workLease), /transient projection failure/);
  assert.deepEqual(retainedTargets(relay).map((target: any) => target.turnId), ["first"]);
  assert.equal(timers.scheduled.length, 1);
  timers.scheduled.shift()!.callback();
  await relayIdle(relay);

  assert.deepEqual(deliveries.listReady().map((delivery) => delivery.body), ["[payments] first final", "[payments] second final"]);
  assert.equal(runtime.getSession("local", "worker", mappingId)?.deliveryCursor, "second");
  assert.deepEqual(retainedTargets(relay), []);
});

test("a replacement mapping conclusively discards but cannot consume an old retained target", async () => {
  const timers = new FakeRelayTimers();
  const { endpoint, registry, runtime, deliveries, relay } = await fixture(undefined, undefined, { timers });
  endpoint.turns = [terminal("baseline")];
  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("old", "completed", "old body") }, workLease,
  ), "retry");

  const old = registry.get("payments")!;
  await registry.transition("payments", old, "unadopting");
  await registry.removeIfMatch("payments", old);
  const replacement = { ...old, mapping_id: "mapping-2", lifecycle_state: "adopting" as const };
  await registry.reserve("payments", replacement);
  await registry.promote("payments", replacement);
  runtime.setSession("local", "worker", "mapping-2", "managed", "idle");
  runtime.beginEpoch("local", "worker", "mapping-2", "replacement-baseline", 2);
  endpoint.turns = [terminal("old", "completed", "must not deliver"), terminal("replacement-baseline")];

  await relay.endpointReady("local", workLease);
  assert.deepEqual(retainedTargets(relay), []);
  assert.deepEqual(deliveries.listReady(), []);
});

test("endpoint loss cancels its timer, fences stale callbacks, and ready reconciliation resolves the exact target", async () => {
  const timers = new FakeRelayTimers();
  const observed: unknown[] = [];
  const { endpoint, deliveries, relay } = await fixture((event) => { observed.push(event); }, undefined, { timers });
  endpoint.turns = [terminal("baseline")];
  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("later", "completed", "recovered") }, workLease,
  ), "retry");
  const stale = timers.scheduled[0]!;

  relay.endpointUnavailable("local");
  assert.equal(timers.scheduled.length, 0);
  assert.deepEqual(timers.cleared, [stale.handle]);
  endpoint.turns = [terminal("baseline"), terminal("later", "completed", "recovered")];
  stale.callback();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.deepEqual(deliveries.listReady(), []);
  assert.equal(retainedTargets(relay).length, 1);

  await relay.endpointReady("local", workLease);
  assert.deepEqual(deliveries.listReady().map((delivery) => delivery.body), ["[payments] recovered"]);
  assert.equal(observed.length, 1);
  assert.deepEqual(retainedTargets(relay), []);
});

test("an endpoint generation change during authoritative history read neither projects nor clears the target", async () => {
  const timers = new FakeRelayTimers();
  const { endpoint, deliveries, relay } = await fixture(undefined, undefined, { timers });
  endpoint.turns = [terminal("baseline"), terminal("racing", "completed", "must not project")];
  endpoint.request = async <T>() => {
    relay.endpointUnavailable("local");
    return { thread: { turns: endpoint.turns } } as T;
  };

  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("racing") }, workLease,
  ), "retry");
  assert.deepEqual(deliveries.listReady(), []);
  assert.equal(retainedTargets(relay).length, 1);
  assert.equal(timers.scheduled.length, 0);
});

test("endpoint loss during ready projection advances neither cursor nor retained target", async () => {
  const timers = new FakeRelayTimers();
  let relay!: EventRelay;
  const value = await fixture(() => { relay.endpointUnavailable("local"); }, undefined, { timers });
  relay = value.relay;
  value.endpoint.turns = [terminal("baseline")];
  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("racing-ready") }, workLease,
  ), "retry");
  assert.equal(retainedTargets(relay).length, 1);
  value.endpoint.turns = [terminal("baseline"), terminal("racing-ready", "completed", "durable but not advanced")];

  await relay.endpointReady("local", workLease);

  assert.equal(value.runtime.getSession("local", "worker", mappingId)?.deliveryCursor, undefined);
  assert.deepEqual(retainedTargets(relay).map((target: any) => target.turnId), ["racing-ready"]);
  assert.equal(timers.scheduled.length, 0);
});

test("final resolution cancels its timer immediately and reconnect resets retry backoff", async () => {
  const timers = new FakeRelayTimers();
  const { endpoint, relay } = await fixture(undefined, undefined, { timers });
  endpoint.turns = [terminal("baseline")];
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal("resolved") }, workLease);
  const pendingTimer = timers.scheduled[0]!;
  endpoint.turns = [terminal("baseline"), terminal("resolved")];
  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("resolved") }, workLease,
  ), "handled");
  assert.equal(timers.scheduled.length, 0);
  assert.deepEqual(timers.cleared, [pendingTimer.handle]);

  endpoint.turns = [terminal("baseline")];
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal("reconnect") }, workLease);
  for (const delay of [1_000, 2_000, 4_000]) {
    const scheduled = timers.scheduled.shift()!;
    assert.equal(scheduled.ms, delay);
    scheduled.callback();
    await relayIdle(relay);
  }
  relay.endpointUnavailable("local");
  endpoint.request = async () => { throw new Error("still transient after reconnect"); };
  await assert.rejects(relay.endpointReady("local", workLease), /still transient after reconnect/);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0]?.ms, 1_000);
});

test("ready scan clears a timer armed by stale notification work ahead of it", async () => {
  const timers = new FakeRelayTimers();
  const { endpoint, relay } = await fixture(undefined, undefined, { timers });
  endpoint.turns = [terminal("baseline"), terminal("ready-wins", "completed", "resolved by ready")];
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  endpoint.request = async <T>() => {
    reads += 1;
    if (reads === 1) { entered(); await barrier; }
    return { thread: { turns: endpoint.turns } } as T;
  };

  const notification = relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("ready-wins") }, workLease,
  );
  await reading;
  const ready = relay.endpointReady("local", workLease);
  release();
  assert.equal(await notification, "retry");
  await ready;

  assert.equal(timers.scheduled.length, 0);
  assert.equal((relay as unknown as { retryAttempts: Map<string, number> }).retryAttempts.size, 0);
  assert.deepEqual(retainedTargets(relay), []);
});

test("terminal ordinal hydration reuses the relay's exact active endpoint lease", async () => {
  const seen: Array<EndpointWorkLease | undefined> = [];
  let processor!: SessionObservationProcessor;
  const value = await fixture(
    (event, lease) => processor.observeTerminal(event, lease),
    undefined,
    {
      poolWorkLeaseProvider: async (_endpointId, existingLease, run) => {
        seen.push(existingLease);
        return run(existingLease);
      },
    },
  );
  const dashboard = new SessionDashboardStore(value.db);
  processor = new SessionObservationProcessor(dashboard, value.registry, value.runtime, {
    now: () => 100,
    readThread: async (endpointId, threadId, lease) => (await value.pool.request<any>(
      endpointId, "thread/read", { threadId, includeTurns: true }, undefined, lease,
    )).thread,
    readGoal: async () => ({ goal: null }),
    onChanged: () => undefined,
    onError: (error) => { throw error; },
  });
  value.endpoint.turns = [terminal("baseline"), terminal("lease-hydration")];

  assert.equal(await value.relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("lease-hydration") }, workLease,
  ), "handled");
  assert.deepEqual(seen, [workLease, workLease]);
});

test("relay stop cancels retry timers and awaits active endpoint work", async () => {
  const timers = new FakeRelayTimers();
  const { endpoint, relay } = await fixture(undefined, undefined, { timers });
  endpoint.turns = [terminal("baseline")];
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal("waiting") }, workLease);
  assert.equal(timers.scheduled.length, 1);

  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  endpoint.turns = [terminal("baseline"), terminal("blocked")];
  endpoint.request = async <T>() => { entered(); await barrier; return { thread: { turns: endpoint.turns } } as T; };
  const handling = relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal("blocked") }, workLease);
  await reading;
  let stopped = false;
  const stopping = relay.stop().then(() => { stopped = true; });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(stopped, false);
  assert.equal(timers.scheduled.length, 0);
  release();
  await Promise.all([handling, stopping]);
  assert.equal(stopped, true);
});
