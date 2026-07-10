import assert from "node:assert/strict";
import { appendFile, mkdtemp, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { JsonRpcResponseError } from "../../src/app-server/json-rpc-client.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { RuntimeStore } from "../../src/storage/runtime-store.ts";
import { createAppServerRolloutPathResolver, scanLocalRollout, SessionOwnershipGuard } from "../../src/sessions/rollout-ownership.ts";
import { RolloutAccessRouter } from "../../src/endpoints/rollout-access.ts";

function line(type: string, payload: unknown): string {
  return `${JSON.stringify({ timestamp: "2026-07-06T00:00:00.000Z", type, payload })}\n`;
}

test("incremental rollout scan returns only turn ownership metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-1.jsonl");
  const secret = "message body must not leave the scanner";
  await writeFile(path, "\n");
  const baseline = await scanLocalRollout({ path, threadId: "thread-1" });
  await appendFile(path, [
    line("event_msg", { type: "task_started", turn_id: "turn-1" }),
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: secret }] }),
    line("event_msg", { type: "user_message", message: secret, client_id: "context-1:call-1" }),
    line("event_msg", { type: "task_complete", turn_id: "turn-1", last_agent_message: secret }),
  ].join(""));

  const result = await scanLocalRollout({ path, threadId: "thread-1", cursor: baseline.cursor });

  assert.deepEqual(result.starts, [{ turnId: "turn-1", clientId: "context-1:call-1", hasUserMessage: true }]);
  assert.equal(result.openTurn, undefined);
  assert.equal(result.cursor.offset, Buffer.byteLength(await readFile(path)));
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("a malformed complete record is an uncertainty boundary but later external evidence remains visible", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-malformed.jsonl");
  const secret = "private body after malformed boundary";
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const baseline = await scanLocalRollout({ path, threadId: "thread-malformed" });
  await appendFile(path, Buffer.from([0x00, 0x00, 0x0a]));
  await appendFile(path, [
    line("event_msg", { type: "task_started", turn_id: "external-after-malformed" }),
    line("event_msg", { type: "user_message", message: secret, client_id: "ctx:external" }),
  ].join(""));

  const result = await scanLocalRollout({ path, threadId: "thread-malformed", cursor: baseline.cursor });

  assert.deepEqual(result, {
    cursor: baseline.cursor,
    starts: [{ turnId: "external-after-malformed", clientId: "ctx:external", hasUserMessage: true }],
    openTurn: { turnId: "external-after-malformed", clientId: "ctx:external", hasUserMessage: true },
    malformed: true,
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("malformed records break turn correlation across the uncertainty boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-boundary-reset.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const baseline = await scanLocalRollout({ path, threadId: "thread-boundary-reset" });
  const start = line("event_msg", { type: "task_started", turn_id: "not-correlated" });
  await appendFile(path, start);
  const malformedOffset = baseline.cursor.offset + Buffer.byteLength(start);
  await appendFile(path, Buffer.from([0x00, 0x0a]));
  await appendFile(path, line("event_msg", { type: "user_message" }));

  const result = await scanLocalRollout({ path, threadId: "thread-boundary-reset", cursor: baseline.cursor });

  assert.deepEqual(result, {
    cursor: { ...baseline.cursor, offset: malformedOffset },
    starts: [],
    malformed: true,
  });
});

test("a fully evidenced turn before a malformed record remains reportable", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-before-malformed.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const baseline = await scanLocalRollout({ path, threadId: "thread-before-malformed" });
  const evidenced = [
    line("event_msg", { type: "task_started", turn_id: "before-malformed" }),
    line("event_msg", { type: "user_message", client_id: "ctx:before" }),
  ].join("");
  await appendFile(path, evidenced);
  const malformedOffset = baseline.cursor.offset + Buffer.byteLength(evidenced);
  await appendFile(path, Buffer.from([0x00, 0x0a]));
  await appendFile(path, line("event_msg", { type: "user_message" }));

  const result = await scanLocalRollout({ path, threadId: "thread-before-malformed", cursor: baseline.cursor });

  assert.deepEqual(result, {
    cursor: { ...baseline.cursor, offset: malformedOffset },
    starts: [{ turnId: "before-malformed", clientId: "ctx:before", hasUserMessage: true }],
    malformed: true,
  });
});

test("syntactically valid non-object rollout records are ignored", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-json-values.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const baseline = await scanLocalRollout({ path, threadId: "thread-json-values" });
  await appendFile(path, [
    "null\n",
    `${JSON.stringify("ignored")}\n`,
    "1\n",
    "true\n",
    "[]\n",
    "{}\n",
    line("event_msg", { type: "task_started", turn_id: "after-json-values" }),
    line("event_msg", { type: "user_message" }),
    line("event_msg", { type: "task_complete", turn_id: "after-json-values" }),
  ].join(""));

  const result = await scanLocalRollout({ path, threadId: "thread-json-values", cursor: baseline.cursor });

  assert.deepEqual(result.starts, [{ turnId: "after-json-values", hasUserMessage: true }]);
  assert.equal(result.openTurn, undefined);
  assert.equal(result.malformed, undefined);
  assert.equal(result.cursor.offset, Buffer.byteLength(await readFile(path)));
});

test("an ownerless user turn is external while an incomplete line remains unconsumed", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-2.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const baseline = await scanLocalRollout({ path, threadId: "thread-2" });

  const partial = line("event_msg", { type: "task_started", turn_id: "external" }).trimEnd();
  await appendFile(path, partial);
  const waiting = await scanLocalRollout({ path, threadId: "thread-2", cursor: baseline.cursor });
  assert.deepEqual(waiting.starts, []);
  assert.deepEqual(waiting.cursor, baseline.cursor);

  await appendFile(path, `\n${line("event_msg", { type: "user_message" })}`);
  const detected = await scanLocalRollout({ path, threadId: "thread-2", cursor: baseline.cursor });
  assert.deepEqual(detected.starts, [{ turnId: "external", hasUserMessage: true }]);
  assert.deepEqual(detected.openTurn, { turnId: "external", hasUserMessage: true });
  assert.equal(detected.cursor.offset, Buffer.byteLength(await readFile(path)));
});

test("a complete task start without its user record remains unclassified", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-boundary.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const operations = new OperationStore(db);
  const identity = { endpoint: "local", thread_id: "thread-boundary", mapping_id: "mapping-boundary" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const guard = new SessionOwnershipGuard(db, runtime, operations, {
    scan: async (_endpointId, requests) => Promise.all(requests.map((request) => scanLocalRollout(request))),
  });
  await guard.initialize(identity, path);
  await appendFile(path, line("event_msg", { type: "task_started", turn_id: "not-yet-classified" }));

  assert.deepEqual(await guard.inspect(identity), { state: "unclassified", turnId: "not-yet-classified" });
  assert.equal(runtime.getSession(identity.endpoint, identity.thread_id, identity.mapping_id)?.managementState, "managed");
});

test("materialization-required inspection reports a never-written rollout as lost", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-nodurable.jsonl");
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const identity = { endpoint: "local", thread_id: "thread-nodurable", mapping_id: "mapping-nodurable" };
  const guard = new SessionOwnershipGuard(db, runtime, new OperationStore(db), {
    scan: async () => assert.fail("a missing rollout must not be scanned as materialized"),
    scanUnmaterialized: async () => ({ state: "missing" as const }),
  });
  guard.recordUnmaterialized(identity, path);

  // Default inspection treats an unmaterialized (in-flight) rollout as still owned...
  assert.deepEqual(await guard.inspect(identity), { state: "owned" });
  // ...but the create-completion durability gate must classify a never-written rollout as lost.
  assert.deepEqual(await guard.inspect(identity, undefined, { requireMaterialized: true }), { state: "lost" });
});

test("an ownerless autonomous turn is owned only while QiYan controls the goal", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-goal.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const operations = new OperationStore(db);
  const identity = { endpoint: "local", thread_id: "thread-goal", mapping_id: "mapping-goal" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const guard = new SessionOwnershipGuard(db, runtime, operations, {
    scan: async (_endpointId, requests) => Promise.all(requests.map((request) => scanLocalRollout(request))),
  });
  await guard.initialize(identity, path);
  runtime.setGoalControlled(identity.endpoint, identity.thread_id, identity.mapping_id, true);
  guard.authorizeTurn(identity, "goal-turn");
  runtime.setGoalControlled(identity.endpoint, identity.thread_id, identity.mapping_id, false);
  await appendFile(path, line("event_msg", { type: "task_started", turn_id: "goal-turn" }));

  assert.deepEqual(await guard.inspect(identity), { state: "owned" });
  assert.equal(guard.ownsTurn(identity, "goal-turn"), true);
});

test("goal control leaves an unproven open turn unclassified until user evidence identifies it", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-goal-pending.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const identity = { endpoint: "local", thread_id: "thread-goal-pending", mapping_id: "mapping-goal-pending" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const guard = new SessionOwnershipGuard(db, runtime, new OperationStore(db), {
    scan: async (_endpointId, requests) => Promise.all(requests.map((request) => scanLocalRollout(request))),
  });
  await guard.initialize(identity, path);
  runtime.setGoalControlled(identity.endpoint, identity.thread_id, identity.mapping_id, true);
  await appendFile(path, line("event_msg", { type: "task_started", turn_id: "pending-goal-turn" }));

  assert.deepEqual(await guard.inspect(identity), { state: "unclassified", turnId: "pending-goal-turn" });
  assert.equal(guard.ownsTurn(identity, "pending-goal-turn"), false);

  await appendFile(path, line("event_msg", { type: "user_message", client_id: "external-client" }));

  assert.deepEqual(await guard.inspect(identity), { state: "external", turnId: "pending-goal-turn" });
});

test("goal control recognizes a completed autonomous turn when its notification was missed", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-goal-completed.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const identity = { endpoint: "local", thread_id: "thread-goal-completed", mapping_id: "mapping-goal-completed" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const guard = new SessionOwnershipGuard(db, runtime, new OperationStore(db), {
    scan: async (_endpointId, requests) => Promise.all(requests.map((request) => scanLocalRollout(request))),
  });
  await guard.initialize(identity, path);
  const baseline = db.prepare(`SELECT byte_offset FROM session_rollout_ownership
    WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
    .get(identity.endpoint, identity.thread_id, identity.mapping_id) as { byte_offset: number };
  runtime.setGoalControlled(identity.endpoint, identity.thread_id, identity.mapping_id, true, 1);
  await appendFile(path, [
    line("event_msg", { type: "task_started", turn_id: "completed-goal-turn" }),
    line("event_msg", { type: "task_complete", turn_id: "completed-goal-turn" }),
  ].join(""));

  assert.deepEqual(await guard.inspect(identity), { state: "owned" });
  const recovered = db.prepare(`SELECT byte_offset, external_turn_id FROM session_rollout_ownership
    WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
    .get(identity.endpoint, identity.thread_id, identity.mapping_id) as { byte_offset: number; external_turn_id: string | null };
  assert.ok(recovered.byte_offset > baseline.byte_offset);
  assert.equal(recovered.external_turn_id, null);
  assert.equal(guard.ownsTurn(identity, "completed-goal-turn"), true);
});

test("an exact terminal goal authorization resolves an open restart boundary after goal control clears", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-goal-restart-terminal.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const identity = { endpoint: "local", thread_id: "thread-goal-restart-terminal", mapping_id: "mapping-goal-restart-terminal" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const guard = new SessionOwnershipGuard(db, runtime, new OperationStore(db), {
    scan: async (_endpointId, requests) => Promise.all(requests.map((request) => scanLocalRollout(request))),
  });
  await guard.initialize(identity, path);
  runtime.setGoalControlled(identity.endpoint, identity.thread_id, identity.mapping_id, true);
  await appendFile(path, line("event_msg", { type: "task_started", turn_id: "restart-goal-turn" }));
  assert.deepEqual(await guard.inspect(identity), { state: "unclassified", turnId: "restart-goal-turn" });

  guard.authorizeTurn(identity, "restart-goal-turn");
  runtime.setGoalControlled(identity.endpoint, identity.thread_id, identity.mapping_id, false);
  await appendFile(path, line("event_msg", { type: "task_complete", turn_id: "restart-goal-turn" }));

  assert.deepEqual(await guard.inspect(identity), { state: "owned" });
  assert.equal(guard.ownsTurn(identity, "restart-goal-turn"), true);
});

test("initialization persists an exact active legacy goal turn when the ownership row is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-legacy-active-goal.jsonl");
  await writeFile(path, line("event_msg", { type: "task_started", turn_id: "legacy-active-goal-turn" }));
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const identity = { endpoint: "local", thread_id: "thread-legacy-active-goal", mapping_id: "mapping-legacy-active-goal" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "active");
  runtime.setGoalControlled(identity.endpoint, identity.thread_id, identity.mapping_id, true);
  const guard = new SessionOwnershipGuard(db, runtime, new OperationStore(db), {
    scan: async (_endpointId, requests) => Promise.all(requests.map((request) => scanLocalRollout(request))),
  });

  assert.equal(guard.authorizeTurnIfInitialized(identity, "legacy-active-goal-turn"), false);
  await guard.initialize(identity, path, undefined, { authorizedTurnId: "legacy-active-goal-turn" });

  assert.deepEqual(await guard.inspect(identity), { state: "owned" });
  assert.equal(guard.ownsTurn(identity, "legacy-active-goal-turn"), true);
});

test("initialization persists active legacy authorization before its rollout start is visible", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-legacy-late-start.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const identity = { endpoint: "local", thread_id: "thread-legacy-late-start", mapping_id: "mapping-legacy-late-start" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "active");
  runtime.setGoalControlled(identity.endpoint, identity.thread_id, identity.mapping_id, true);
  const guard = new SessionOwnershipGuard(db, runtime, new OperationStore(db), {
    scan: async (_endpointId, requests) => Promise.all(requests.map((request) => scanLocalRollout(request))),
  });

  await guard.initialize(identity, path, undefined, { authorizedTurnId: "legacy-late-start" });
  assert.equal(guard.ownsTurn(identity, "legacy-late-start"), true);
  await appendFile(path, line("event_msg", { type: "task_started", turn_id: "legacy-late-start" }));

  assert.deepEqual(await guard.inspect(identity), { state: "owned" });
});

test("user evidence overrides exact migration authorization during ownership initialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-legacy-external-goal.jsonl");
  await writeFile(path, [
    line("event_msg", { type: "task_started", turn_id: "legacy-external-goal-turn" }),
    line("event_msg", { type: "user_message", client_id: "external-client" }),
  ].join(""));
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const identity = { endpoint: "local", thread_id: "thread-legacy-external-goal", mapping_id: "mapping-legacy-external-goal" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "active");
  runtime.setGoalControlled(identity.endpoint, identity.thread_id, identity.mapping_id, true);
  const guard = new SessionOwnershipGuard(db, runtime, new OperationStore(db), {
    scan: async (_endpointId, requests) => Promise.all(requests.map((request) => scanLocalRollout(request))),
  });

  await assert.rejects(
    guard.initialize(identity, path, undefined, { authorizedTurnId: "legacy-external-goal-turn" }),
    (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY",
  );
  assert.equal(guard.ownsTurn(identity, "legacy-external-goal-turn"), false);
});

test("goal control never authorizes an external client turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-goal-external.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const identity = { endpoint: "local", thread_id: "thread-goal-external", mapping_id: "mapping-goal-external" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const guard = new SessionOwnershipGuard(db, runtime, new OperationStore(db), {
    scan: async (_endpointId, requests) => Promise.all(requests.map((request) => scanLocalRollout(request))),
  });
  await guard.initialize(identity, path);
  runtime.setGoalControlled(identity.endpoint, identity.thread_id, identity.mapping_id, true);
  await appendFile(path, [
    line("event_msg", { type: "task_started", turn_id: "external-during-goal" }),
    line("event_msg", { type: "user_message", client_id: "external-client" }),
  ].join(""));

  assert.deepEqual(await guard.inspect(identity), { state: "external", turnId: "external-during-goal" });
  assert.equal(guard.ownsTurn(identity, "external-during-goal"), false);
});

test("external user evidence overrides an earlier exact goal-turn authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-authorized-goal-external.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const identity = { endpoint: "local", thread_id: "thread-authorized-goal-external", mapping_id: "mapping-authorized-goal-external" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const guard = new SessionOwnershipGuard(db, runtime, new OperationStore(db), {
    scan: async (_endpointId, requests) => Promise.all(requests.map((request) => scanLocalRollout(request))),
  });
  await guard.initialize(identity, path);
  runtime.setGoalControlled(identity.endpoint, identity.thread_id, identity.mapping_id, true);
  guard.authorizeTurn(identity, "authorized-goal-external");
  await appendFile(path, [
    line("event_msg", { type: "task_started", turn_id: "authorized-goal-external" }),
    line("event_msg", { type: "user_message", client_id: "external-client" }),
  ].join(""));

  assert.deepEqual(await guard.inspect(identity), { state: "external", turnId: "authorized-goal-external" });
  assert.equal(guard.ownsTurn(identity, "authorized-goal-external"), false);
});

test("a legacy completed turn without user evidence or a goal marker remains unclassified", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-legacy-goal.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const identity = { endpoint: "local", thread_id: "thread-legacy-goal", mapping_id: "mapping-legacy-goal" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const guard = new SessionOwnershipGuard(db, runtime, new OperationStore(db), {
    scan: async (_endpointId, requests) => Promise.all(requests.map((request) => scanLocalRollout(request))),
  });
  await guard.initialize(identity, path);
  await appendFile(path, [
    line("event_msg", { type: "task_started", turn_id: "legacy-goal-turn" }),
    line("event_msg", { type: "task_complete", turn_id: "legacy-goal-turn" }),
  ].join(""));

  assert.deepEqual(await guard.inspect(identity), { state: "unclassified", turnId: "legacy-goal-turn" });
  assert.equal(runtime.getSession(identity.endpoint, identity.thread_id, identity.mapping_id)?.managementState, "managed");
});

test("a completed external turn takes precedence over a trailing unclassified start", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-precedence.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const operations = new OperationStore(db);
  const identity = { endpoint: "local", thread_id: "thread-precedence", mapping_id: "mapping-precedence" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const guard = new SessionOwnershipGuard(db, runtime, operations, {
    scan: async (_endpointId, requests) => Promise.all(requests.map((request) => scanLocalRollout(request))),
  });
  await guard.initialize(identity, path);
  await appendFile(path, [
    line("event_msg", { type: "task_started", turn_id: "external-first" }),
    line("event_msg", { type: "user_message" }),
    line("event_msg", { type: "task_complete", turn_id: "external-first" }),
    line("event_msg", { type: "task_started", turn_id: "boundary-after" }),
  ].join(""));

  assert.deepEqual(await guard.inspect(identity), { state: "external", turnId: "external-first" });
  assert.equal(runtime.getSession(identity.endpoint, identity.thread_id, identity.mapping_id)?.managementState, "unadopting");
});

test("the guard rejects malformed scans without external proof or durable state changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-uncertain.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const operations = new OperationStore(db);
  const identity = { endpoint: "local", thread_id: "thread-uncertain", mapping_id: "mapping-uncertain" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const guard = new SessionOwnershipGuard(db, runtime, operations, {
    scan: async (_endpointId, requests) => Promise.all(requests.map((request) => scanLocalRollout(request))),
  });
  await guard.initialize(identity, path);
  const storedBefore = db.prepare(`SELECT device, inode, byte_offset, external_turn_id FROM session_rollout_ownership
    WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
    .get(identity.endpoint, identity.thread_id, identity.mapping_id);
  operations.prepare({
    contextId: "ctx-uncertain", attemptId: "attempt-uncertain", callId: "call-uncertain",
    kind: "send_to_session", args: { nickname: "worker", content: "private" },
  });
  await appendFile(path, [
    line("event_msg", { type: "task_started", turn_id: "owned-before-malformed" }),
    line("event_msg", { type: "user_message", client_id: "ctx-uncertain:call-uncertain" }),
  ].join(""));
  await appendFile(path, Buffer.from([0x00, 0x0a]));

  await assert.rejects(guard.inspect(identity), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "OPERATION_UNCERTAIN");
    assert.equal((error as Error).message, "rollout ownership is temporarily uncertain");
    assert.equal((error as AppError).details?.recovery, "ownership_unclassified");
    return true;
  });

  const storedAfter = db.prepare(`SELECT device, inode, byte_offset, external_turn_id FROM session_rollout_ownership
    WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
    .get(identity.endpoint, identity.thread_id, identity.mapping_id);
  assert.deepEqual(storedAfter, storedBefore);
  const ownedCount = db.prepare(`SELECT COUNT(*) AS count FROM session_rollout_owned_turns
    WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
    .get(identity.endpoint, identity.thread_id, identity.mapping_id) as { count: number };
  assert.equal(ownedCount.count, 0);
  assert.equal(runtime.getSession(identity.endpoint, identity.thread_id, identity.mapping_id)?.managementState, "managed");
});

test("the guard fences later external evidence despite an earlier malformed record", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-malformed-external.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const operations = new OperationStore(db);
  const identity = { endpoint: "local", thread_id: "thread-malformed-external", mapping_id: "mapping-malformed-external" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const guard = new SessionOwnershipGuard(db, runtime, operations, {
    scan: async (_endpointId, requests) => Promise.all(requests.map((request) => scanLocalRollout(request))),
  });
  await guard.initialize(identity, path);
  const baselineOffset = (db.prepare(`SELECT byte_offset FROM session_rollout_ownership
    WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
    .get(identity.endpoint, identity.thread_id, identity.mapping_id) as { byte_offset: number }).byte_offset;
  await appendFile(path, Buffer.from([0x00, 0x0a]));
  await appendFile(path, [
    line("event_msg", { type: "task_started", turn_id: "external-after-boundary" }),
    line("event_msg", { type: "user_message" }),
  ].join(""));

  assert.deepEqual(await guard.inspect(identity), { state: "external", turnId: "external-after-boundary" });

  const storedOffset = (db.prepare(`SELECT byte_offset FROM session_rollout_ownership
    WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
    .get(identity.endpoint, identity.thread_id, identity.mapping_id) as { byte_offset: number }).byte_offset;
  assert.equal(storedOffset, baselineOffset);
  assert.equal(runtime.getSession(identity.endpoint, identity.thread_id, identity.mapping_id)?.managementState, "unadopting");
});

test("initialization accepts only positive active external evidence from a malformed scan", async () => {
  const cursor = { device: "1", inode: "2", offset: 100 };
  const uncertainDb = createTestDatabase();
  const uncertainRuntime = new RuntimeStore(uncertainDb);
  const uncertainIdentity = { endpoint: "local", thread_id: "thread-init-uncertain", mapping_id: "mapping-init-uncertain" };
  uncertainRuntime.setSession(uncertainIdentity.endpoint, uncertainIdentity.thread_id, uncertainIdentity.mapping_id, "managed", "idle");
  const uncertainGuard = new SessionOwnershipGuard(uncertainDb, uncertainRuntime, new OperationStore(uncertainDb), {
    scan: async () => [{ cursor, starts: [], malformed: true }],
  });

  await assert.rejects(uncertainGuard.initialize(uncertainIdentity, "/tmp/rollout-thread-init-uncertain.jsonl"), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "OPERATION_UNCERTAIN");
    assert.equal((error as AppError).details?.recovery, "ownership_unclassified");
    return true;
  });
  const uncertainRows = uncertainDb.prepare(`SELECT COUNT(*) AS count FROM session_rollout_ownership
    WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
    .get(uncertainIdentity.endpoint, uncertainIdentity.thread_id, uncertainIdentity.mapping_id) as { count: number };
  assert.equal(uncertainRows.count, 0);
  assert.equal(uncertainRuntime.getSession(uncertainIdentity.endpoint, uncertainIdentity.thread_id, uncertainIdentity.mapping_id)?.managementState, "managed");

  const externalDb = createTestDatabase();
  const externalRuntime = new RuntimeStore(externalDb);
  const externalIdentity = { endpoint: "local", thread_id: "thread-init-external", mapping_id: "mapping-init-external" };
  externalRuntime.setSession(externalIdentity.endpoint, externalIdentity.thread_id, externalIdentity.mapping_id, "managed", "idle");
  const externalGuard = new SessionOwnershipGuard(externalDb, externalRuntime, new OperationStore(externalDb), {
    scan: async () => [{
      cursor,
      starts: [{ turnId: "external-active", hasUserMessage: true }],
      openTurn: { turnId: "external-active", hasUserMessage: true },
      malformed: true,
    }],
  });

  await assert.rejects(externalGuard.initialize(externalIdentity, "/tmp/rollout-thread-init-external.jsonl"), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "SESSION_BUSY");
    assert.equal((error as AppError).details?.recovery, "external_turn");
    return true;
  });
  assert.deepEqual(await externalGuard.inspect(externalIdentity), { state: "external", turnId: "external-active" });
  assert.equal(externalRuntime.getSession(externalIdentity.endpoint, externalIdentity.thread_id, externalIdentity.mapping_id)?.managementState, "unadopting");
});

test("recordUnmaterialized stores an idempotent offset-zero baseline without rollout access", () => {
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const identity = { endpoint: "devbox", thread_id: "thread-fresh", mapping_id: "mapping-fresh" };
  let scans = 0;
  const guard = new SessionOwnershipGuard(db, runtime, new OperationStore(db), {
    scan: async () => { scans += 1; throw new Error("rollout access is forbidden"); },
    scanUnmaterialized: async () => { scans += 1; throw new Error("rollout access is forbidden"); },
  });
  const path = "/tmp/rollout-thread-fresh.jsonl";

  guard.recordUnmaterialized(identity, path);
  guard.recordUnmaterialized(identity, path);

  assert.equal(scans, 0);
  const row = db.prepare(`SELECT rollout_path, device, inode, byte_offset, materialized, external_turn_id
    FROM session_rollout_ownership WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
    .get(identity.endpoint, identity.thread_id, identity.mapping_id);
  assert.deepEqual({ ...row as object }, {
    rollout_path: path, device: "", inode: "", byte_offset: 0, materialized: 0, external_turn_id: null,
  });
  assert.throws(() => guard.recordUnmaterialized(identity, "/tmp/rollout-other-thread.jsonl"), /path|rollout/iu);
  assert.throws(() => guard.recordUnmaterialized(identity, "relative.jsonl"), /path|rollout/iu);
});

test("a pathless created thread stays pending until its exact rollout path can be bound", async () => {
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const identity = { endpoint: "devbox", thread_id: "thread-pathless", mapping_id: "mapping-pathless" };
  let resolvedPath: string | undefined;
  let scans = 0;
  const guard = new SessionOwnershipGuard(db, runtime, new OperationStore(db), {
    scan: async () => { scans += 1; throw new Error("materialized scan is not expected"); },
    scanUnmaterialized: async (_endpoint, request) => {
      scans += 1;
      assert.equal(request.path, resolvedPath);
      return { state: "missing" };
    },
  }, async (candidate) => {
    assert.deepEqual(candidate, identity);
    return resolvedPath ? { state: "resolved", path: resolvedPath } : { state: "pending" };
  });

  guard.recordUnmaterialized(identity);
  assert.deepEqual(await guard.inspect(identity), { state: "pending" });
  assert.equal(scans, 0);
  assert.equal((db.prepare(`SELECT rollout_path FROM session_rollout_ownership
    WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`).get(
    identity.endpoint, identity.thread_id, identity.mapping_id,
  ) as { rollout_path: string }).rollout_path, "");

  resolvedPath = "/tmp/rollout-thread-pathless.jsonl";
  assert.deepEqual(await guard.inspect(identity), { state: "owned" });
  assert.equal(scans, 1);
  guard.recordUnmaterialized(identity);
  assert.equal((db.prepare(`SELECT rollout_path FROM session_rollout_ownership
    WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`).get(
    identity.endpoint, identity.thread_id, identity.mapping_id,
  ) as { rollout_path: string }).rollout_path, resolvedPath);
});

test("a committed pathless mapping resumes a durable thread or terminally detects its missing rollout", async (t) => {
  const identity = { endpoint: "local", thread_id: "thread-restart", mapping_id: "mapping-restart" };
  await t.test("resumable", async () => {
    const calls: string[] = [];
    const resolver = createAppServerRolloutPathResolver({
      request: async <T>(_endpoint: string, method: string) => {
        calls.push(method);
        if (method === "thread/read") throw new JsonRpcResponseError(-32600, "thread not loaded: thread-restart");
        return { thread: { id: identity.thread_id, path: "/tmp/rollout-thread-restart.jsonl" } } as T;
      },
    });
    assert.deepEqual(await resolver(identity), {
      state: "resolved", path: "/tmp/rollout-thread-restart.jsonl",
    });
    assert.deepEqual(calls, ["thread/read", "thread/resume"]);
  });
  await t.test("volatile rollout lost", async () => {
    const resolver = createAppServerRolloutPathResolver({
      request: async <T>(_endpoint: string, method: string) => {
        if (method === "thread/read") throw new JsonRpcResponseError(-32600, "thread not loaded: thread-restart");
        throw new JsonRpcResponseError(-32600, "no rollout found for thread id thread-restart");
      },
    });
    assert.deepEqual(await resolver(identity), { state: "lost" });
  });
  await t.test("live rollout not materialized", async () => {
    const resolver = createAppServerRolloutPathResolver({
      request: async <T>() => {
        throw new JsonRpcResponseError(-32600, "no rollout found for thread id thread-restart");
      },
    });
    assert.deepEqual(await resolver(identity), { state: "pending" });
  });
});

test("recordUnmaterialized never downgrades existing materialized or external evidence", () => {
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const identity = { endpoint: "devbox", thread_id: "thread-existing", mapping_id: "mapping-existing" };
  const path = "/tmp/rollout-thread-existing.jsonl";
  db.prepare(`INSERT INTO session_rollout_ownership
    (endpoint_id, thread_id, mapping_id, rollout_path, device, inode, byte_offset, materialized, external_turn_id, updated_at)
    VALUES (?, ?, ?, ?, '10', '20', 30, 1, 'external-turn', 40)`)
    .run(identity.endpoint, identity.thread_id, identity.mapping_id, path);
  const guard = new SessionOwnershipGuard(db, runtime, new OperationStore(db), {
    scan: async () => { throw new Error("unused"); },
  });

  guard.recordUnmaterialized(identity, path);

  const row = db.prepare(`SELECT device, inode, byte_offset, materialized, external_turn_id, updated_at
    FROM session_rollout_ownership WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
    .get(identity.endpoint, identity.thread_id, identity.mapping_id);
  assert.deepEqual({ ...row as object }, {
    device: "10", inode: "20", byte_offset: 30, materialized: 1, external_turn_id: "external-turn", updated_at: 40,
  });
});

test("an empty created thread promotes a completed owned first turn from the real rollout scanner", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-lazy.jsonl");
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const operations = new OperationStore(db);
  const identity = { endpoint: "local", thread_id: "thread-lazy", mapping_id: "mapping-lazy" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const guard = new SessionOwnershipGuard(db, runtime, operations, new RolloutAccessRouter({ remote: () => undefined }));

  await guard.initialize(identity, path, undefined, { allowUnmaterialized: true });
  const pending = db.prepare(`SELECT materialized FROM session_rollout_ownership
    WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
    .get(identity.endpoint, identity.thread_id, identity.mapping_id) as { materialized: number };
  assert.equal(pending.materialized, 0);
  assert.deepEqual(await guard.inspect(identity), { state: "owned" });

  operations.prepare({ contextId: "ctx", attemptId: "attempt", callId: "call", kind: "send_to_session", args: { nickname: "worker", content: "private" } });
  await writeFile(path, [
    line("event_msg", { type: "task_started", turn_id: "owned-first-turn" }),
    line("event_msg", { type: "user_message", client_id: "ctx:call" }),
    line("event_msg", { type: "task_complete", turn_id: "owned-first-turn" }),
  ].join(""));

  assert.deepEqual(await guard.inspect(identity), { state: "owned" });
  const materialized = db.prepare(`SELECT materialized, device, inode, byte_offset FROM session_rollout_ownership
    WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
    .get(identity.endpoint, identity.thread_id, identity.mapping_id) as Record<string, unknown>;
  assert.equal(materialized.materialized, 1);
  assert.notEqual(materialized.device, "");
  assert.notEqual(materialized.inode, "");
  assert.equal(materialized.byte_offset, (await stat(path)).size);
  assert.equal(guard.ownsTurn(identity, "owned-first-turn"), true);
});

test("a pending rollout detects active and completed external first turns with the real scanner", async (t) => {
  for (const terminal of [false, true]) await t.test(terminal ? "completed" : "active", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const threadId = terminal ? "thread-external-completed" : "thread-external-active";
  const path = join(root, `rollout-${threadId}.jsonl`);
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const identity = { endpoint: "local", thread_id: threadId, mapping_id: `mapping-${threadId}` };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const guard = new SessionOwnershipGuard(db, runtime, new OperationStore(db), new RolloutAccessRouter({ remote: () => undefined }));
  await guard.initialize(identity, path, undefined, { allowUnmaterialized: true });
  await writeFile(path, [
    line("event_msg", { type: "task_started", turn_id: "external-first-turn" }),
    line("event_msg", { type: "user_message" }),
    ...(terminal ? [line("event_msg", { type: "task_complete", turn_id: "external-first-turn" })] : []),
  ].join(""));

  assert.deepEqual(await guard.inspect(identity), { state: "external", turnId: "external-first-turn" });
  assert.equal(runtime.getSession(identity.endpoint, identity.thread_id, identity.mapping_id)?.managementState, "unadopting");
  });
});

test("restart initialization reclassifies an existing pending or external ownership row", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-restart-lazy.jsonl");
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const operations = new OperationStore(db);
  const identity = { endpoint: "local", thread_id: "thread-restart-lazy", mapping_id: "mapping-restart-lazy" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "adopting", "idle");
  const access = new RolloutAccessRouter({ remote: () => undefined });
  await new SessionOwnershipGuard(db, runtime, operations, access)
    .initialize(identity, path, undefined, { allowUnmaterialized: true });
  await writeFile(path, [
    line("event_msg", { type: "task_started", turn_id: "external-during-restart" }),
    line("event_msg", { type: "user_message" }),
    line("event_msg", { type: "task_complete", turn_id: "external-during-restart" }),
  ].join(""));

  const recovered = new SessionOwnershipGuard(db, runtime, operations, access);
  for (const phase of ["pending", "external-persisted"]) {
    await assert.rejects(
      recovered.initialize(identity, path, undefined, { allowUnmaterialized: true }),
      (error: unknown) => {
        assert.equal(error instanceof AppError && error.code === "SESSION_BUSY", true, phase);
        return true;
      },
    );
  }
  const row = db.prepare(`SELECT materialized, external_turn_id FROM session_rollout_ownership
    WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
    .get(identity.endpoint, identity.thread_id, identity.mapping_id) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { materialized: 1, external_turn_id: "external-during-restart" });
});

test("known-empty initialization detects a first turn that materialized before the pending row commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-initialize-race.jsonl");
  await writeFile(path, [
    line("event_msg", { type: "task_started", turn_id: "external-before-initialize" }),
    line("event_msg", { type: "user_message" }),
    line("event_msg", { type: "task_complete", turn_id: "external-before-initialize" }),
  ].join(""));
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const identity = { endpoint: "local", thread_id: "thread-initialize-race", mapping_id: "mapping-initialize-race" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "adopting", "idle");
  const guard = new SessionOwnershipGuard(
    db,
    runtime,
    new OperationStore(db),
    new RolloutAccessRouter({ remote: () => undefined }),
  );

  await assert.rejects(
    guard.initialize(identity, path, undefined, { allowUnmaterialized: true }),
    (error: unknown) => {
      assert.equal(error instanceof AppError && error.code === "SESSION_BUSY", true);
      return true;
    },
  );
  const row = db.prepare(`SELECT materialized, external_turn_id FROM session_rollout_ownership
    WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
    .get(identity.endpoint, identity.thread_id, identity.mapping_id) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { materialized: 1, external_turn_id: "external-before-initialize" });
});

test("existing-row initialization rechecks a partial first turn after its user record arrives", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-partial-retry.jsonl");
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const identity = { endpoint: "local", thread_id: "thread-partial-retry", mapping_id: "mapping-partial-retry" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "adopting", "idle");
  const guard = new SessionOwnershipGuard(
    db,
    runtime,
    new OperationStore(db),
    new RolloutAccessRouter({ remote: () => undefined }),
  );
  await guard.initialize(identity, path, undefined, { allowUnmaterialized: true });
  await writeFile(path, line("event_msg", { type: "task_started", turn_id: "external-partial" }));

  await assert.rejects(
    guard.initialize(identity, path, undefined, { allowUnmaterialized: true }),
    (error: unknown) => error instanceof AppError && error.code === "OPERATION_UNCERTAIN",
  );
  await appendFile(path, [
    line("event_msg", { type: "user_message" }),
    line("event_msg", { type: "task_complete", turn_id: "external-partial" }),
  ].join(""));

  await assert.rejects(
    guard.initialize(identity, path, undefined, { allowUnmaterialized: true }),
    (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY",
  );
  const row = db.prepare(`SELECT materialized, external_turn_id FROM session_rollout_ownership
    WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
    .get(identity.endpoint, identity.thread_id, identity.mapping_id) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { materialized: 1, external_turn_id: "external-partial" });
});

test("a pending baseline requires a classified turn when native metadata is no longer empty", async (t) => {
  for (const rollout of ["missing", "recreated-empty"] as const) await t.test(rollout, async () => {
    const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
    const threadId = `thread-native-nonempty-${rollout}`;
    const path = join(root, `rollout-${threadId}.jsonl`);
    const db = createTestDatabase();
    const runtime = new RuntimeStore(db);
    const identity = { endpoint: "local", thread_id: threadId, mapping_id: `mapping-${threadId}` };
    runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "adopting", "idle");
    const guard = new SessionOwnershipGuard(
      db,
      runtime,
      new OperationStore(db),
      new RolloutAccessRouter({ remote: () => undefined }),
    );
    await guard.initialize(identity, path, undefined, { allowUnmaterialized: true });
    if (rollout === "recreated-empty") await writeFile(path, "");

    await assert.rejects(
      guard.initialize(identity, path, undefined, { allowUnmaterialized: false }),
      (error: unknown) => error instanceof AppError && error.code === "OPERATION_UNCERTAIN",
    );
    const row = db.prepare(`SELECT materialized, device, inode, byte_offset, external_turn_id FROM session_rollout_ownership
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
      .get(identity.endpoint, identity.thread_id, identity.mapping_id) as Record<string, unknown>;
    assert.deepEqual({ ...row }, { materialized: 0, device: "", inode: "", byte_offset: 0, external_turn_id: null });
  });
});

test("a malformed record can heal in place and is reparsed from the durable cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-healing.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const operations = new OperationStore(db);
  const identity = { endpoint: "local", thread_id: "thread-healing", mapping_id: "mapping-healing" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const guard = new SessionOwnershipGuard(db, runtime, operations, {
    scan: async (_endpointId, requests) => Promise.all(requests.map((request) => scanLocalRollout(request))),
  });
  await guard.initialize(identity, path);
  const baselineOffset = (db.prepare(`SELECT byte_offset FROM session_rollout_ownership
    WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
    .get(identity.endpoint, identity.thread_id, identity.mapping_id) as { byte_offset: number }).byte_offset;
  const start = Buffer.from(line("event_msg", { type: "task_started", turn_id: "healed-external" }));
  await appendFile(path, start);
  await appendFile(path, line("event_msg", { type: "user_message" }));
  const damagedFile = await open(path, "r+");
  try {
    await damagedFile.write(Buffer.alloc(start.byteLength - 1), 0, start.byteLength - 1, baselineOffset);
  } finally {
    await damagedFile.close();
  }

  await assert.rejects(guard.inspect(identity), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "OPERATION_UNCERTAIN");
    return true;
  });
  const unchangedOffset = (db.prepare(`SELECT byte_offset FROM session_rollout_ownership
    WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
    .get(identity.endpoint, identity.thread_id, identity.mapping_id) as { byte_offset: number }).byte_offset;
  assert.equal(unchangedOffset, baselineOffset);

  const healedFile = await open(path, "r+");
  try {
    await healedFile.write(start, 0, start.byteLength, baselineOffset);
  } finally {
    await healedFile.close();
  }

  assert.deepEqual(await guard.inspect(identity), { state: "external", turnId: "healed-external" });
  const healedOffset = (db.prepare(`SELECT byte_offset FROM session_rollout_ownership
    WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
    .get(identity.endpoint, identity.thread_id, identity.mapping_id) as { byte_offset: number }).byte_offset;
  assert.equal(healedOffset, (await stat(path)).size);
  assert.equal(runtime.getSession(identity.endpoint, identity.thread_id, identity.mapping_id)?.managementState, "unadopting");
});

test("a cursor cannot cross rollout replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-3.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const baseline = await scanLocalRollout({ path, threadId: "thread-3" });
  const replacement = join(root, "replacement");
  await writeFile(replacement, line("event_msg", { type: "task_started", turn_id: "external" }));
  await rename(replacement, path);

  await assert.rejects(scanLocalRollout({ path, threadId: "thread-3", cursor: baseline.cursor }), /rollout identity changed/u);
});

test("initialization scans transcripts larger than the former whole-file buffer limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-large.jsonl");
  const file = await open(path, "w");
  try {
    const blankMegabyte = Buffer.alloc(1024 * 1024, 0x0a);
    for (let index = 0; index < 65; index += 1) await file.write(blankMegabyte);
    await file.write(line("event_msg", { type: "task_complete", turn_id: "historical" }));
  } finally {
    await file.close();
  }

  const result = await scanLocalRollout({ path, threadId: "thread-large" });

  assert.equal(result.cursor.offset, (await stat(path)).size);
  assert.equal(result.openTurn, undefined);
});

test("the guard advances owned turns and durably fences the first external turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-"));
  const path = join(root, "rollout-thread-4.jsonl");
  await writeFile(path, line("event_msg", { type: "task_complete", turn_id: "historical" }));
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const operations = new OperationStore(db);
  const identity = { endpoint: "local", thread_id: "thread-4", mapping_id: "mapping-4" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const guard = new SessionOwnershipGuard(db, runtime, operations, {
    scan: async (_endpointId, requests) => Promise.all(requests.map((request) => scanLocalRollout(request))),
  });
  await guard.initialize(identity, path);

  operations.prepare({ contextId: "ctx", attemptId: "attempt", callId: "call", kind: "send_to_session", args: { nickname: "worker", content: "private" } });
  await appendFile(path, [
    line("event_msg", { type: "task_started", turn_id: "owned" }),
    line("event_msg", { type: "user_message", client_id: "ctx:call" }),
    line("event_msg", { type: "task_complete", turn_id: "owned" }),
  ].join(""));
  assert.deepEqual(await guard.inspect(identity), { state: "owned" });
  assert.equal(guard.ownsTurn(identity, "owned"), true);
  assert.equal(guard.ownsTurn(identity, "external"), false);
  assert.equal(runtime.getSession(identity.endpoint, identity.thread_id, identity.mapping_id)?.managementState, "managed");

  await appendFile(path, [
    line("event_msg", { type: "task_started", turn_id: "external" }),
    line("event_msg", { type: "user_message" }),
  ].join(""));
  assert.deepEqual(await guard.inspect(identity), { state: "external", turnId: "external" });
  assert.equal(runtime.getSession(identity.endpoint, identity.thread_id, identity.mapping_id)?.managementState, "unadopting");
  assert.deepEqual(await guard.inspect(identity), { state: "external", turnId: "external" });

  operations.prepare({ contextId: "ctx-after", attemptId: "attempt-after", callId: "call-after", kind: "send_to_session", args: { nickname: "worker", content: "late" } });
  await appendFile(path, [
    line("event_msg", { type: "task_started", turn_id: "owned-after-fence" }),
    line("event_msg", { type: "user_message", client_id: "ctx-after:call-after" }),
  ].join(""));
  assert.deepEqual(await guard.inspect(identity), { state: "external", turnId: "external" });
  assert.equal(guard.ownsTurn(identity, "owned-after-fence"), true);
});

test("initialization durably fences an already active external turn for managed-session recovery", async () => {
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const operations = new OperationStore(db);
  const identity = { endpoint: "local", thread_id: "thread-recovery", mapping_id: "mapping-recovery" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const cursor = { device: "1", inode: "2", offset: 100 };
  const guard = new SessionOwnershipGuard(db, runtime, operations, {
    scan: async () => [{
      cursor,
      starts: [{ turnId: "external-active", hasUserMessage: true }],
      openTurn: { turnId: "external-active", hasUserMessage: true },
    }],
  });

  await assert.rejects(guard.initialize(identity, "/tmp/rollout-thread-recovery.jsonl"), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "SESSION_BUSY");
    assert.equal((error as AppError).details?.recovery, "external_turn");
    return true;
  });

  assert.deepEqual(await guard.inspect(identity), { state: "external", turnId: "external-active" });
  assert.equal(runtime.getSession(identity.endpoint, identity.thread_id, identity.mapping_id)?.managementState, "unadopting");
});

test("only incomplete ownership evidence is retry-tagged while rollout identity drift is permanent", async () => {
  const db = createTestDatabase();
  const runtime = new RuntimeStore(db);
  const operations = new OperationStore(db);
  const identity = { endpoint: "local", thread_id: "thread-tags", mapping_id: "mapping-tags" };
  runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "managed", "idle");
  const cursor = { device: "1", inode: "2", offset: 0 };
  let scanResult: any = undefined;
  const guard = new SessionOwnershipGuard(db, runtime, operations, {
    scan: async () => scanResult === undefined ? [] : [scanResult],
  });

  await assert.rejects(guard.initialize(identity, "/tmp/rollout-thread-tags.jsonl"), (error: unknown) => {
    assert.equal((error as AppError).details?.recovery, "ownership_unclassified");
    return true;
  });
  scanResult = { cursor, starts: [] };
  await guard.initialize(identity, "/tmp/rollout-thread-tags.jsonl");
  await assert.rejects(guard.initialize(identity, "/tmp/rollout-thread-tags-changed.jsonl"), (error: unknown) => {
    assert.equal((error as AppError).code, "OPERATION_UNCERTAIN");
    assert.equal((error as AppError).details?.recovery, undefined);
    return true;
  });
});
