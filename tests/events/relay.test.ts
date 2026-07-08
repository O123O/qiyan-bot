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
  async request<T>(): Promise<T> { return { thread: { turns: this.turns } } as T; }
}

async function fixture(
  onTerminal?: (event: any) => void | Promise<void>,
  ownershipOverride?: {
    inspect(): Promise<{ state: "owned" } | { state: "external"; turnId: string } | { state: "unclassified"; turnId: string }>;
    ownsTurn(identity: unknown, turnId: string): boolean;
  },
  relayOptions: {
    timers?: RelayTimers;
    withEndpointWorkLease?<T>(
      endpointId: string,
      existingLease: EndpointWorkLease | undefined,
      run: (lease: EndpointWorkLease) => Promise<T>,
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
  const relay = new EventRelay(db, new AppServerPool([endpoint], { maxConcurrentTurns: 4 }), registry, runtime, new FinalMessageStore(db), deliveries, {
    binding: () => routes.current(),
    clock: { now: () => 100 },
    withEndpointWorkLease: relayOptions.withEndpointWorkLease
      ?? (async (_endpointId, existingLease, run) => run(existingLease ?? workLease)),
    ...(onTerminal ? { onTerminal } : {}),
  }, undefined, ownership, new ThreadGate(), relayOptions.timers);
  return { db, endpoint, registry, runtime, deliveries, relay, conversations, routes };
}

function terminal(id = "turn-1", status = "completed", text = "done") {
  return { id, status, startedAt: 5, completedAt: 10, items: text ? [{ type: "agentMessage", id: `${id}-final`, text, phase: "final_answer" }] : [] };
}

function retainedTargets(relay: EventRelay): unknown[] {
  return [...(relay as unknown as { retryTargets: Map<string, unknown> }).retryTargets.values()];
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
