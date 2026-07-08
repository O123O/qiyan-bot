import assert from "node:assert/strict";
import test from "node:test";
import { OwnershipEventStore } from "../../src/sessions/ownership-event-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";

const incident = {
  nickname: "worker",
  endpoint: "local",
  thread_id: "thread-1",
  mapping_id: "mapping-1",
  turnId: "external-turn",
};

test("a pending external incident becomes completed only after its exact mapping is absent", () => {
  const db = createTestDatabase();
  const store = new OwnershipEventStore(db, { now: () => 100 });
  let currentMappingId: string | undefined = "mapping-1";
  const registry = {
    getByIdentity: () => currentMappingId
      ? { nickname: "worker", session: {
        endpoint: incident.endpoint,
        thread_id: incident.thread_id,
        project_dir: "/project",
        mapping_id: currentMappingId,
        lifecycle_state: "unadopting" as const,
      } }
      : undefined,
  };

  assert.equal(store.record(incident, "pending"), true);
  assert.equal(store.reconcileReleased(registry), 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind = 'external_worker_session_released'").get() as { count: number }).count, 0);

  currentMappingId = undefined;
  assert.equal(store.reconcileReleased(registry), 1);
  assert.equal(store.reconcileReleased(registry), 0);
  const completed = db.prepare("SELECT id, payload_json, created_at FROM events WHERE kind = 'external_worker_session_released'").get() as Record<string, unknown>;
  assert.equal(completed.id, "external-release:local:thread-1:mapping-1:external-turn");
  assert.equal(completed.created_at, 100);
  assert.deepEqual(JSON.parse(String(completed.payload_json)), {
    event: "external_worker_session_released",
    releaseStatus: "completed",
    nickname: "worker",
    mappingId: "mapping-1",
    turnId: "external-turn",
  });
});

test("a replacement mapping proves the pending generation was released", () => {
  const db = createTestDatabase();
  const store = new OwnershipEventStore(db, { now: () => 200 });
  store.record(incident, "pending");

  assert.equal(store.reconcileReleased({
    getByIdentity: () => ({ nickname: "replacement", session: {
      endpoint: incident.endpoint,
      thread_id: incident.thread_id,
      project_dir: "/replacement",
      mapping_id: "mapping-2",
      lifecycle_state: "managed" as const,
    } }),
  }), 1);
});

test("pending incidents are ordered, endpoint-filtered, and disappear after completion", () => {
  const db = createTestDatabase();
  let now = 100;
  const store = new OwnershipEventStore(db, { now: () => now++ });
  const remoteIncident = {
    ...incident,
    nickname: "remote-worker",
    endpoint: "devbox",
    thread_id: "thread-2",
    mapping_id: "mapping-2",
    turnId: "external-turn-2",
  };

  assert.equal(store.record(incident, "pending"), true);
  assert.equal(store.record(remoteIncident, "pending"), true);
  assert.deepEqual(store.pending(), [incident, remoteIncident]);
  assert.deepEqual(store.pending("local"), [incident]);
  assert.deepEqual(store.pending("devbox"), [remoteIncident]);
  assert.deepEqual(store.pending("other"), []);

  assert.equal(store.record(incident, "completed"), true);
  assert.deepEqual(store.pending("local"), []);
  assert.deepEqual(store.pending(), [remoteIncident]);
});

test("pending rejects malformed persisted metadata with a fixed payload-free error", () => {
  const db = createTestDatabase();
  const store = new OwnershipEventStore(db);
  const secretPayload = "sensitive-message-body";
  db.prepare(`INSERT INTO events(id, endpoint_id, thread_id, turn_id, kind, payload_json, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
    "external-turn:local:thread-1:mapping-1:external-turn",
    "local",
    "thread-1",
    "external-turn",
    "external_worker_turn_detected",
    secretPayload,
    1,
  );

  assert.throws(
    () => store.pending(),
    (error: unknown) => {
      assert.equal((error as Error).message, "invalid persisted external ownership event");
      assert.equal((error as Error).message.includes(secretPayload), false);
      return true;
    },
  );
});
