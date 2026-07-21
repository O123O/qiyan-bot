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
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { OwnerRouteStore } from "../../src/chat-apps/shared/owner-route-store.ts";
import { SessionObservationProcessor } from "../../src/assistant/session-observer.ts";
import { SessionDashboardStore } from "../../src/storage/session-dashboard-store.ts";
import { SessionControlStore } from "../../src/storage/session-control-store.ts";
import { ManagedEpochStore } from "../../src/storage/managed-epoch-store.ts";
import { SessionDeliveryProgressStore } from "../../src/storage/session-delivery-progress-store.ts";
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
  async request<T>(method: string, params: any): Promise<T> { return relayResponse<T>(method, params, this.turns); }
}

function relayResponse<T>(method: string, params: any, turns: any[]): T {
  if (method === "thread/read") return { thread: { status: { type: turns.some((turn) => turn.status === "inProgress") ? "active" : "idle" }, turns } } as T;
  if (method === "thread/turns/list") {
    const ordered = params.sortDirection === "asc" ? [...turns] : [...turns].reverse();
    const offset = params.cursor === undefined ? 0 : Number(params.cursor);
    const limit = Number(params.limit);
    const selected = ordered.slice(offset, offset + limit);
    return {
      data: selected.map((turn) => ({
        ...turn,
        itemsView: params.itemsView ?? "summary",
        items: params.itemsView === "notLoaded" ? [] : turn.items ?? [],
      })),
      nextCursor: offset + selected.length < ordered.length ? String(offset + selected.length) : null,
      backwardsCursor: offset > 0 ? String(Math.max(0, offset - limit)) : null,
    } as T;
  }
  return {} as T;
}

async function fixture(
  onTerminal?: (event: any, lease?: EndpointWorkLease) => void | Promise<void>,
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
    maxRecoveryAttempts?: number;
  } = {},
) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "relay-")));
  const db = createTestDatabase();
  const registry = await SessionRegistry.open(join(dir, "sessions.json"), {
    version: 3, assistant: { endpoint: "local", thread_id: "coord", project_dir: dir },
    sessions: { payments: { endpoint: "local", thread_id: "worker", project_dir: dir, mapping_id: mappingId, lifecycle_state: "managed" } },
  });
  const endpoint = new RelayEndpoint();
  const epochs = new ManagedEpochStore(db);
  const progress = new SessionDeliveryProgressStore(db);
  epochs.begin("local", "worker", mappingId, "baseline", 1);
  const deliveries = new DeliveryStore(db);
  const routes = new OwnerRouteStore(db, binding);
  const conversations = new ConversationStore(db, deliveries);
  const pool = new AppServerPool([endpoint], {
    ...(relayOptions.poolWorkLeaseProvider ? { workLeaseProvider: relayOptions.poolWorkLeaseProvider } : {}),
  });
  const relay = new EventRelay(db, pool, registry, epochs, progress, new FinalMessageStore(db), deliveries, {
    binding: () => routes.current(),
    clock: { now: () => 100 },
    withEndpointWorkLease: relayOptions.withEndpointWorkLease
      ?? (async (_endpointId, existingLease, run) => run(existingLease ?? workLease)),
    ...(onTerminal ? { onTerminal } : {}),
    ...(relayOptions.onEventCommitted ? { onEventCommitted: relayOptions.onEventCommitted } : {}),
    ...(relayOptions.maxRecoveryAttempts === undefined ? {} : { maxRecoveryAttempts: relayOptions.maxRecoveryAttempts }),
  }, relayOptions.attachments, new ThreadGate(), relayOptions.timers);
  return { db, endpoint, pool, registry, epochs, progress, deliveries, relay, conversations, routes };
}

function terminal(id = "turn-1", status = "completed", text = "done") {
  return { id, status, itemsView: "full", startedAt: 5, completedAt: 10, items: text ? [{ type: "agentMessage", id: `${id}-final`, text, phase: "final_answer" }] : [] };
}

function partialTerminal(id: string, status = "completed", text = "done") {
  const turn = terminal(id, status, text);
  delete (turn as { itemsView?: string }).itemsView;
  return turn;
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
  }, {
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
  }, {
    onEventCommitted: async () => { wakes += 1; },
  });
  endpoint.turns = [terminal("baseline"), terminal()];

  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal() },
  ), "retry");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 0);
  assert.equal(wakes, 0);
});

test("permission projection commits delivery before the event wake without persisting liveness", async () => {
  let releaseWake!: () => void;
  const wakeBarrier = new Promise<void>((resolve) => { releaseWake = resolve; });
  let wakeEntered = false;
  const value = await fixture(undefined, {
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
  } finally {
    releaseWake();
  }
  await projecting;
});

test("permission projection commits no session-liveness row", async () => {
  let wakes = 0;
  const value = await fixture(undefined, {
    onEventCommitted: async () => { wakes += 1; },
  });
  await value.relay.handlePermissionBlocked(
    "local", { threadId: "worker", turnId: "blocked", method: "approval", params: {} },
  );
  assert.equal((value.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 1);
  assert.equal(wakes, 1);
  assert.equal((value.db.prepare("SELECT COUNT(*) AS n FROM session_dashboard_notifications").get() as { n: number }).n, 0);
});

test("managed worker finals create automatic delivery and metadata-only assistant event exactly once", async () => {
  const { db, endpoint, progress, deliveries, relay } = await fixture();
  endpoint.turns = [terminal("baseline"), terminal()];
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal() });
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal() });
  assert.deepEqual(deliveries.listReady().map((item) => item.body), ["[payments] done"]);
  assert.equal(progress.cursor("local", "worker", mappingId), "turn-1");
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

test("ordinary endpoint readiness never scans managed thread history", async () => {
  const { endpoint, deliveries, relay } = await fixture();
  endpoint.turns = [terminal("baseline"), terminal("missed")];
  const methods: string[] = [];
  endpoint.request = async <T>(method: string, params: any) => {
    methods.push(method);
    return relayResponse<T>(method, params, endpoint.turns);
  };

  await relay.endpointReady("local", workLease);

  assert.deepEqual(methods, []);
  assert.deepEqual(deliveries.listReady(), []);
});

test("ready reconciliation for an adopted epoch starts at its first observed turn", async () => {
  const { endpoint, epochs, deliveries, relay } = await fixture();
  epochs.end("local", "worker", mappingId, 19_999);
  epochs.begin("local", "worker", mappingId, undefined, 20_000, "from_first_turn");
  epochs.recordFirstTurn("local", "worker", mappingId, "managed");
  endpoint.turns = [
    terminal("historical", "completed", "historical final"),
    terminal("managed", "completed", "managed final"),
  ];

  await relay.reconcileEndpoint("local", workLease);

  assert.deepEqual(deliveries.listReady().map((delivery) => delivery.body), ["[payments] managed final"]);
});

test("ready reconciliation skips pre-adoption history until a first native turn is observed", async () => {
  const { endpoint, epochs, deliveries, relay } = await fixture();
  epochs.end("local", "worker", mappingId, 2);
  epochs.begin("local", "worker", mappingId, undefined, 3, "from_first_turn");
  endpoint.turns = [terminal("historical", "completed", "must not deliver")];
  let historyReads = 0;
  endpoint.request = async <T>(method: string, params: any) => {
    if (method === "thread/turns/list") historyReads += 1;
    return relayResponse<T>(method, params, endpoint.turns);
  };

  await relay.endpointReady("local", workLease);

  assert.equal(historyReads, 0);
  assert.deepEqual(deliveries.listReady(), []);
});

test("a terminal observed while adoption is pending remains retryable until promotion", async () => {
  const timers = new FakeRelayTimers();
  const { registry, epochs, deliveries, relay } = await fixture(undefined, { timers });
  const old = registry.get("payments")!;
  await registry.transition("payments", old, "unadopting");
  await registry.removeIfMatch("payments", old);
  epochs.end("local", "worker", mappingId, 2);
  const adopting = { ...old, mapping_id: "mapping-adopting", lifecycle_state: "adopting" as const };
  await registry.reserve("payments", adopting);
  epochs.begin("local", "worker", adopting.mapping_id, undefined, 3, "from_first_turn");
  epochs.recordFirstTurn("local", "worker", adopting.mapping_id, "during-adoption");

  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("during-adoption") }, workLease,
  ), "retry");
  assert.deepEqual(retainedTargets(relay).map((target: any) => target.turnId), ["during-adoption"]);

  await registry.promote("payments", adopting);
  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("during-adoption") }, workLease,
  ), "handled");
  assert.deepEqual(deliveries.listReady().map((delivery) => delivery.body), ["[payments] done"]);
  assert.deepEqual(retainedTargets(relay), []);
});

test("an empty first session does not block explicit reconciliation for later sessions", async () => {
  const timers = new FakeRelayTimers();
  const { endpoint, registry, epochs, deliveries, relay } = await fixture(undefined, { timers });
  epochs.end("local", "worker", mappingId, 2);
  epochs.begin("local", "worker", mappingId, undefined, 3);
  await registry.createManaged("later", {
    endpoint: "local", thread_id: "later-worker", project_dir: registry.get("payments")!.project_dir, mapping_id: "mapping-later",
  });
  epochs.begin("local", "later-worker", "mapping-later", "later-baseline", 4);
  const requests: Array<{ threadId: string; includeTurns: boolean }> = [];
  endpoint.request = async <T>(method: string, params: any) => {
    requests.push(params);
    if (params.threadId === "worker" && method === "thread/turns/list") {
      throw new JsonRpcResponseError(-32600, "thread worker is not materialized yet; thread/turns/list is unavailable before first user message");
    }
    return relayResponse<T>(method, params, params.threadId === "worker"
      ? []
      : [terminal("later-baseline"), terminal("later-missed")]);
  };

  await relay.reconcileEndpoint("local", workLease);

  assert.equal(requests.some((params) => params.includeTurns === true), false);
  assert.deepEqual(requests.map((params) => params.threadId), ["worker", "later-worker", "later-worker", "later-worker"]);
  assert.deepEqual(deliveries.listReady().map((item) => item.body), ["[later] done"]);
  assert.equal((relay as unknown as { scanPendingEndpoints: Set<string> }).scanPendingEndpoints.size, 0);
  assert.equal(timers.scheduled.length, 0);
});

test("terminal notification with partial items reads the authoritative completed turn", async () => {
  const { endpoint, deliveries, relay } = await fixture();
  endpoint.turns = [terminal("baseline"), terminal("readback", "completed", "from history")];
  const partial = terminal("readback", "completed", "");
  delete (partial as { itemsView?: string }).itemsView;
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: partial });
  assert.deepEqual(deliveries.listReady().map((item) => item.body), ["[payments] from history"]);
});

test("a current partial terminal heals an old recovery incident without scanning historical backlog", async () => {
  const { endpoint, progress, deliveries, relay } = await fixture();
  const current = terminal("current", "completed", "new final");
  progress.setCursor("local", "worker", mappingId, "old-cursor");
  progress.markRecoveryIncident("local", "worker", mappingId, "old history gap");
  const methods: string[] = [];
  endpoint.request = async <T>(method: string, params: any) => {
    methods.push(method);
    if (method === "thread/turns/list") {
      assert.equal(params.cursor, undefined, "the exact live target must not scan from the stale cursor");
      return {
        data: [{
          ...current,
          itemsView: params.itemsView,
          items: params.itemsView === "full" ? current.items : [],
        }],
        nextCursor: "older-history",
        backwardsCursor: "newer-history",
      } as T;
    }
    throw new Error(`unexpected method: ${method}`);
  };
  const partial = partialTerminal("current", "completed", "");

  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: partial }, workLease,
  ), "handled");
  assert.deepEqual(methods, ["thread/turns/list", "thread/turns/list", "thread/turns/list"]);
  assert.deepEqual(deliveries.listReady().map((item) => item.body), ["[payments] new final"]);
  assert.equal(progress.cursor("local", "worker", mappingId), "current");
  assert.equal(progress.recoveryIncident("local", "worker", mappingId), undefined);
});

test("an adopted recovery incident never authorizes the latest pre-adoption terminal", async () => {
  const { endpoint, epochs, progress, deliveries, relay } = await fixture();
  epochs.end("local", "worker", mappingId, 2);
  epochs.begin("local", "worker", mappingId, undefined, 3, "from_first_turn");
  epochs.recordFirstTurn("local", "worker", mappingId, "missing-managed-turn");
  progress.markRecoveryIncident("local", "worker", mappingId, "managed boundary is absent");
  endpoint.turns = [terminal("historical", "completed", "must not deliver")];
  let historyReads = 0;
  endpoint.request = async <T>(method: string, params: any) => {
    if (method === "thread/turns/list") historyReads += 1;
    return relayResponse<T>(method, params, endpoint.turns);
  };

  await relay.endpointReady("local", workLease);

  assert.equal(historyReads, 0);
  assert.deepEqual(deliveries.listReady(), []);
  assert.deepEqual(progress.recoveryIncident("local", "worker", mappingId), { reason: "managed boundary is absent" });
});

test("a history scan budget opens one durable mapping incident instead of retrying", async () => {
  const timers = new FakeRelayTimers();
  const { endpoint, progress, deliveries, relay } = await fixture(undefined, { timers });
  endpoint.request = async <T>(method: string, params: any) => {
    if (method === "thread/turns/list") {
      const index = Number(String(params.cursor ?? "page-0").replace("page-", ""));
      return {
        data: [{ id: `old-${index}`, status: "completed", itemsView: "notLoaded", items: [] }],
        nextCursor: `page-${index + 1}`,
        backwardsCursor: null,
      } as T;
    }
    return relayResponse<T>(method, params, []);
  };
  const partial = terminal("missing");
  delete (partial as { itemsView?: string }).itemsView;

  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: partial }, workLease,
  ), "needs_attention");
  assert.deepEqual(progress.recoveryIncident("local", "worker", mappingId), {
    reason: "native history scan budget was exhausted",
  });
  assert.equal(timers.scheduled.length, 0);
  assert.deepEqual(deliveries.listReady().map((delivery) => delivery.body), [
    "[payments] message recovery needs attention; native history scan budget was exhausted",
  ]);
});

test("explicit recovery re-establishes an incident mapping from only its latest terminal", async () => {
  const { endpoint, progress, deliveries, relay } = await fixture();
  progress.setCursor("local", "worker", mappingId, "old-cursor");
  progress.markRecoveryIncident("local", "worker", mappingId, "old history gap");
  endpoint.turns = [terminal("baseline"), terminal("latest", "completed", "latest final")];

  await relay.reconcileEndpoint("local", workLease);

  assert.deepEqual(deliveries.listReady().map((delivery) => delivery.body), ["[payments] latest final"]);
  assert.equal(progress.cursor("local", "worker", mappingId), "latest");
  assert.equal(progress.recoveryIncident("local", "worker", mappingId), undefined);
});

test("reconciliation stops at an in-progress turn without advancing past it", async () => {
  const { endpoint, progress, deliveries, relay } = await fixture();
  endpoint.turns = [terminal("baseline"), { id: "working", status: "inProgress", completedAt: null, items: [] }];
  await relay.reconcileEndpoint("local");
  assert.equal(progress.cursor("local", "worker", mappingId), undefined);

  endpoint.turns = [terminal("baseline"), terminal("working", "completed", "later")];
  await relay.reconcileEndpoint("local");
  assert.deepEqual(deliveries.listReady().map((item) => item.body), ["[payments] later"]);
});

test("replaying an older terminal does not infer lifecycle from later history", async () => {
  const { endpoint, deliveries, relay } = await fixture();
  endpoint.turns = [terminal("baseline"), terminal("old"), { id: "current", status: "inProgress", completedAt: null, items: [] }];
  await relay.reconcileEndpoint("local");
  assert.deepEqual(deliveries.listReady().map((delivery) => delivery.body), ["[payments] done"]);
});

test("a delayed terminal on the current managed mapping is delivered without owner inference", async () => {
  const { endpoint, deliveries, relay } = await fixture();
  endpoint.turns = [terminal("old"), terminal("baseline")];
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal("old") });
  assert.deepEqual(deliveries.listReady().map((delivery) => delivery.body), ["[payments] done"]);
});

test("a mapping generation change during authoritative read suppresses the delayed terminal", async () => {
  const { endpoint, registry, epochs, deliveries, relay } = await fixture();
  endpoint.turns = [terminal("baseline"), terminal("delayed")];
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  endpoint.request = async <T>(method: string, params: any) => {
    entered();
    await barrier;
    return relayResponse<T>(method, params, endpoint.turns);
  };

  const partial = terminal("delayed");
  delete (partial as { itemsView?: string }).itemsView;
  const pending = relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: partial });
  await reading;
  const old = registry.get("payments")!;
  await registry.transition("payments", old, "unadopting");
  await registry.removeIfMatch("payments", old);
  const replacement = { ...old, mapping_id: "mapping-2", lifecycle_state: "adopting" as const };
  await registry.reserve("payments", replacement);
  await registry.promote("payments", replacement);
  epochs.begin("local", "worker", "mapping-2", "baseline", 2);
  release();
  await pending;

  assert.deepEqual(deliveries.listReady(), []);
});

test("ready reconciliation cannot deliver across a re-adoption during its history read", async () => {
  const { endpoint, registry, epochs, deliveries, relay } = await fixture();
  endpoint.turns = [terminal("baseline"), terminal("missed")];
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  endpoint.request = async <T>(method: string, params: any) => {
    entered();
    await barrier;
    return relayResponse<T>(method, params, endpoint.turns);
  };

  const pending = relay.reconcileEndpoint("local");
  await reading;
  const old = registry.get("payments")!;
  await registry.transition("payments", old, "unadopting");
  await registry.removeIfMatch("payments", old);
  const replacement = { ...old, mapping_id: "mapping-2", lifecycle_state: "adopting" as const };
  await registry.reserve("payments", replacement);
  await registry.promote("payments", replacement);
  epochs.begin("local", "worker", "mapping-2", "baseline", 2);
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
  endpoint.request = async <T>(method: string, params: any) => {
    entered();
    await barrier;
    return relayResponse<T>(method, params, endpoint.turns);
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
    const { registry, deliveries, relay } = await fixture();
    const current = registry.get("payments")!;
    if (state === "adopting") {
      await registry.transition("payments", current, "unadopting");
      await registry.removeIfMatch("payments", current);
      await registry.reserve("payments", { ...current, mapping_id: "mapping-adopting", lifecycle_state: "adopting" });
    } else {
      await registry.transition("payments", current, state);
    }
    await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: terminal(`turn-${state}`) });
    assert.deepEqual(deliveries.listReady(), []);
  }
});

test("terminal projection exposes exact handled, epoch-duplicate, and retry outcomes", async () => {
  const handled = await fixture();
  handled.endpoint.turns = [terminal("baseline"), terminal("handled")];
  assert.equal(await handled.relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("handled", "completed", "projected") }, workLease,
  ), "handled");

  const baseline = await fixture();
  baseline.endpoint.turns = [terminal("baseline")];
  assert.equal(await baseline.relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("baseline") }, workLease,
  ), "conclusively_ignored");

  const older = await fixture();
  older.endpoint.turns = [terminal("older"), terminal("baseline")];
  assert.equal(await older.relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("older") }, workLease,
  ), "handled");

  const absent = await fixture();
  absent.endpoint.turns = [terminal("baseline")];
  const absentPartial = terminal("absent");
  delete (absentPartial as { itemsView?: string }).itemsView;
  assert.equal(await absent.relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: absentPartial }, workLease,
  ), "retry");

  const transient = await fixture();
  transient.endpoint.request = async () => { throw new Error("transient read failure"); };
  const transientPartial = terminal("transient");
  delete (transientPartial as { itemsView?: string }).itemsView;
  assert.equal(await transient.relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: transientPartial }, workLease,
  ), "retry");
});

test("notification item hydration projects the managed terminal without an ownership classifier", async () => {
  const value = await fixture();
  value.endpoint.turns = [terminal("baseline"), terminal("racing")];

  assert.equal(await value.relay.handleNotification(
    "local", "turn/completed", {
      threadId: "worker",
      turn: { id: "racing", status: "completed", itemsView: "notLoaded", items: [], completedAt: 10 },
    }, workLease,
  ), "handled");
  assert.deepEqual(value.deliveries.listReady().map((delivery) => delivery.body), ["[payments] done"]);
});

test("explicit reconciliation hydrates every terminal after the managed baseline", async () => {
  const value = await fixture();
  value.endpoint.turns = [terminal("baseline"), terminal("missed")];

  await value.relay.reconcileEndpoint("local", workLease);

  assert.deepEqual(value.deliveries.listReady().map((delivery) => delivery.body), ["[payments] done"]);
  assert.equal(value.progress.cursor("local", "worker", mappingId), "missed");
});

test("relay retains two exact targets without retaining notification contents", async () => {
  const timers = new FakeRelayTimers();
  const { endpoint, epochs, relay } = await fixture(undefined, { timers });
  endpoint.turns = [terminal("baseline")];
  const epochId = epochs.current("local", "worker", mappingId)!.id;

  const one = terminal("one", "completed", "secret one");
  const two = terminal("two", "completed", "secret two");
  delete (one as { itemsView?: string }).itemsView;
  delete (two as { itemsView?: string }).itemsView;
  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: one }, workLease,
  ), "retry");
  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: two }, workLease,
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
  const { relay } = await fixture(undefined, {
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

test("endpoint retry backoff opens one durable mapping incident after its finite budget", async () => {
  const timers = new FakeRelayTimers();
  const { endpoint, progress, deliveries, relay } = await fixture(undefined, { timers });
  endpoint.turns = [terminal("baseline")];
  const partial = terminal("backoff");
  delete (partial as { itemsView?: string }).itemsView;
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: partial }, workLease);

  for (const expected of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
    assert.equal(timers.scheduled.length, 1);
    const scheduled = timers.scheduled.shift()!;
    assert.equal(scheduled.ms, expected);
    scheduled.callback();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  assert.equal(timers.scheduled.length, 0);
  assert.deepEqual(progress.recoveryIncident("local", "worker", mappingId), {
    reason: "native history remained unavailable after bounded retries",
  });
  assert.deepEqual(deliveries.listReady().map((delivery) => delivery.body), [
    "[payments] message recovery needs attention; native history remained unavailable after bounded retries",
  ]);
  await relay.stop();
});

test("worker completions use one serialized in-flight tail per endpoint", async () => {
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let acquisitions = 0;
  const { endpoint, relay } = await fixture(undefined, {
    withEndpointWorkLease: async (_endpointId, existingLease, run) => {
      acquisitions += 1;
      return run(existingLease ?? workLease);
    },
  });
  endpoint.turns = [terminal("baseline")];
  let reads = 0;
  endpoint.request = async <T>(method: string, params: any) => {
    reads += 1;
    if (reads === 1) { entered(); await barrier; }
    return relayResponse<T>(method, params, endpoint.turns);
  };

  const first = relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: partialTerminal("first") }, workLease);
  await reading;
  const second = relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: partialTerminal("second") }, workLease);
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
  endpoint.request = async <T>(method: string, params: any) => {
    reads += 1;
    if (reads === 1) { entered(); await barrier; }
    return relayResponse<T>(method, params, endpoint.turns);
  };
  const first = relay.handleNotification("local", "turn/completed", {
    threadId: "worker", turn: partialTerminal("blocked-first", "completed", "first secret"),
  }, workLease);
  await reading;
  const queuedParams = {
    threadId: "worker",
    turn: partialTerminal("queued-second", "completed", "queued notification secret"),
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

test("a failed explicit history scan retries even without a prior exact target", async () => {
  const timers = new FakeRelayTimers();
  const { endpoint, progress, deliveries, relay } = await fixture(undefined, { timers });
  endpoint.turns = [terminal("baseline"), terminal("missed", "completed", "found on retry")];
  let reads = 0;
  endpoint.request = async <T>(method: string, params: any) => {
    reads += 1;
    if (reads === 1) throw new Error("transient initial scan failure");
    return relayResponse<T>(method, params, endpoint.turns);
  };

  await assert.rejects(relay.reconcileEndpoint("local", workLease), /transient initial scan failure/);
  assert.equal(retainedTargets(relay).length, 0);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0]?.ms, 1_000);
  timers.scheduled.shift()!.callback();
  await relayIdle(relay);

  assert.deepEqual(deliveries.listReady().map((delivery) => delivery.body), ["[payments] found on retry"]);
  assert.equal(progress.cursor("local", "worker", mappingId), "missed");
});

test("endpoint readiness resumes an already-pending explicit scan without creating routine scans", async () => {
  const timers = new FakeRelayTimers();
  const { endpoint, progress, deliveries, relay } = await fixture(undefined, { timers });
  endpoint.turns = [terminal("baseline"), terminal("missed", "completed", "found after readiness")];
  let reads = 0;
  endpoint.request = async <T>(method: string, params: any) => {
    reads += 1;
    if (reads === 1) throw new Error("transient explicit scan failure");
    return relayResponse<T>(method, params, endpoint.turns);
  };

  await assert.rejects(relay.reconcileEndpoint("local", workLease), /transient explicit scan failure/);
  assert.equal(timers.scheduled.length, 1);

  await relay.endpointReady("local");

  assert.equal(timers.scheduled.length, 0, "readiness replaces the pending retry timer");
  assert.deepEqual(deliveries.listReady().map((delivery) => delivery.body), ["[payments] found after readiness"]);
  assert.equal(progress.cursor("local", "worker", mappingId), "missed");
});

test("partial explicit projection failure retains the scan and later terminal turns for its timer", async () => {
  const timers = new FakeRelayTimers();
  let observations = 0;
  const { endpoint, progress, deliveries, relay } = await fixture(() => {
    observations += 1;
    if (observations === 1) throw new Error("transient projection failure");
  }, { timers });
  endpoint.turns = [
    terminal("baseline"),
    terminal("first", "completed", "first final"),
    terminal("second", "completed", "second final"),
  ];

  await assert.rejects(relay.reconcileEndpoint("local", workLease), /transient projection failure/);
  assert.deepEqual(retainedTargets(relay).map((target: any) => target.turnId), ["first"]);
  assert.equal(timers.scheduled.length, 1);
  timers.scheduled.shift()!.callback();
  await relayIdle(relay);

  assert.deepEqual(deliveries.listReady().map((delivery) => delivery.body), ["[payments] first final", "[payments] second final"]);
  assert.equal(progress.cursor("local", "worker", mappingId), "second");
  assert.deepEqual(retainedTargets(relay), []);
});

test("a replacement mapping conclusively discards but cannot consume an old retained target", async () => {
  const timers = new FakeRelayTimers();
  const { endpoint, registry, epochs, deliveries, relay } = await fixture(undefined, { timers });
  endpoint.turns = [terminal("baseline")];
  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: partialTerminal("old", "completed", "old body") }, workLease,
  ), "retry");

  const old = registry.get("payments")!;
  await registry.transition("payments", old, "unadopting");
  await registry.removeIfMatch("payments", old);
  const replacement = { ...old, mapping_id: "mapping-2", lifecycle_state: "adopting" as const };
  await registry.reserve("payments", replacement);
  await registry.promote("payments", replacement);
  epochs.begin("local", "worker", "mapping-2", "replacement-baseline", 2);
  endpoint.turns = [terminal("old", "completed", "must not deliver"), terminal("replacement-baseline")];

  await relay.endpointReady("local", workLease);
  assert.deepEqual(retainedTargets(relay), []);
  assert.deepEqual(deliveries.listReady(), []);
});

test("endpoint loss cancels its timer, fences stale callbacks, and ready reconciliation resolves the exact target", async () => {
  const timers = new FakeRelayTimers();
  const observed: unknown[] = [];
  const { endpoint, deliveries, relay } = await fixture((event) => { observed.push(event); }, { timers });
  endpoint.turns = [terminal("baseline")];
  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: partialTerminal("later", "completed", "recovered") }, workLease,
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
  const { endpoint, deliveries, relay } = await fixture(undefined, { timers });
  endpoint.turns = [terminal("baseline"), terminal("racing", "completed", "must not project")];
  endpoint.request = async <T>(method: string, params: any) => {
    relay.endpointUnavailable("local");
    return relayResponse<T>(method, params, endpoint.turns);
  };

  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: partialTerminal("racing") }, workLease,
  ), "retry");
  assert.deepEqual(deliveries.listReady(), []);
  assert.equal(retainedTargets(relay).length, 1);
  assert.equal(timers.scheduled.length, 0);
});

test("endpoint loss during ready projection advances neither cursor nor retained target", async () => {
  const timers = new FakeRelayTimers();
  let relay!: EventRelay;
  const value = await fixture(() => { relay.endpointUnavailable("local"); }, { timers });
  relay = value.relay;
  value.endpoint.turns = [terminal("baseline")];
  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("racing-ready") }, workLease,
  ), "retry");
  assert.equal(retainedTargets(relay).length, 1);
  value.endpoint.turns = [terminal("baseline"), terminal("racing-ready", "completed", "durable but not advanced")];

  await relay.endpointReady("local", workLease);

  assert.equal(value.progress.cursor("local", "worker", mappingId), undefined);
  assert.deepEqual(retainedTargets(relay).map((target: any) => target.turnId), ["racing-ready"]);
  assert.equal(timers.scheduled.length, 0);
});

test("final resolution cancels its timer immediately and reconnect resets retry backoff", async () => {
  const timers = new FakeRelayTimers();
  const { endpoint, relay } = await fixture(undefined, { timers });
  endpoint.turns = [terminal("baseline")];
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: partialTerminal("resolved") }, workLease);
  const pendingTimer = timers.scheduled[0]!;
  endpoint.turns = [terminal("baseline"), terminal("resolved")];
  assert.equal(await relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("resolved") }, workLease,
  ), "handled");
  assert.equal(timers.scheduled.length, 0);
  assert.deepEqual(timers.cleared, [pendingTimer.handle]);

  endpoint.turns = [terminal("baseline")];
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: partialTerminal("reconnect") }, workLease);
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
  const { endpoint, relay } = await fixture(undefined, { timers });
  endpoint.turns = [terminal("baseline"), terminal("ready-wins", "completed", "resolved by ready")];
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  endpoint.request = async <T>(method: string, params: any) => {
    reads += 1;
    if (reads === 1) { entered(); await barrier; }
    return relayResponse<T>(method, params, endpoint.turns);
  };

  const notification = relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: partialTerminal("ready-wins") }, workLease,
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

test("terminal observation does not start an additional history read", async () => {
  const seen: Array<EndpointWorkLease | undefined> = [];
  let processor!: SessionObservationProcessor;
  const value = await fixture(
    (event, lease) => processor.observeTerminal(event, lease),
    {
      poolWorkLeaseProvider: async (_endpointId, existingLease, run) => {
        seen.push(existingLease);
        return run(existingLease);
      },
    },
  );
  const dashboard = new SessionDashboardStore(value.db);
  processor = new SessionObservationProcessor(dashboard, value.registry, new SessionControlStore(value.db), {
    now: () => 100,
    readGoal: async () => ({ goal: null }),
    onChanged: () => undefined,
    onError: (error) => { throw error; },
  });
  value.endpoint.turns = [terminal("baseline"), terminal("lease-hydration")];

  assert.equal(await value.relay.handleNotification(
    "local", "turn/completed", { threadId: "worker", turn: terminal("lease-hydration") }, workLease,
  ), "handled");
  assert.deepEqual(seen, []);
});

test("relay stop cancels retry timers and awaits active endpoint work", async () => {
  const timers = new FakeRelayTimers();
  const { endpoint, relay } = await fixture(undefined, { timers });
  endpoint.turns = [terminal("baseline")];
  await relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: partialTerminal("waiting") }, workLease);
  assert.equal(timers.scheduled.length, 1);

  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  endpoint.turns = [terminal("baseline"), terminal("blocked")];
  endpoint.request = async <T>(method: string, params: any) => {
    entered();
    await barrier;
    return relayResponse<T>(method, params, endpoint.turns);
  };
  const handling = relay.handleNotification("local", "turn/completed", { threadId: "worker", turn: partialTerminal("blocked") }, workLease);
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
