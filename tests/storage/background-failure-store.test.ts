import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundFailureReporter } from "../../src/core/background-failure-reporter.ts";
import { BackgroundFailureStore } from "../../src/storage/background-failure-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

const binding = { adapterId: "telegram", conversationKey: "telegram:42", destination: { chatId: "42" } } as const;

test("a fresh reporter creates a matching durable pair despite retained incident ids", () => {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  for (const id of ["background-failure:1", "background-failure:old-run:1"]) {
    deliveries.prepare({ id, kind: "system_warning", binding, body: "old warning", mandatory: true });
    db.prepare(`INSERT INTO events(id, endpoint_id, thread_id, kind, payload_json, state, created_at)
      VALUES (?, 'local', 'assistant', 'background_failure', '{}', 'pending', 1)`).run(id);
  }
  const store = new BackgroundFailureStore(db, deliveries);
  const reporter = createBackgroundFailureReporter({
    runId: "new-run",
    onOperational: () => undefined,
    onDurable: (notice) => {
      store.record({ ...notice, endpointId: "local", threadId: "assistant", binding });
    },
  });

  reporter.report("maintenance", { episode: "maintenance" });
  reporter.report("maintenance", { episode: "maintenance" });

  const id = "background-failure:new-run:1";
  assert.equal(deliveries.get(id)?.body, "[system] maintenance failed; durable reconciliation will retry");
  const event = db.prepare("SELECT endpoint_id, thread_id, kind, payload_json FROM events WHERE id = ?").get(id) as
    { endpoint_id: string; thread_id: string; kind: string; payload_json: string };
  assert.deepEqual({ endpointId: event.endpoint_id, threadId: event.thread_id, kind: event.kind }, {
    endpointId: "local", threadId: "assistant", kind: "background_failure",
  });
  assert.deepEqual(JSON.parse(event.payload_json), { label: "maintenance", incident: 1 });
  assert.equal(deliveries.get("background-failure:new-run:2"), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM deliveries").get()!.count, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind = 'background_failure'").get()!.count, 3);
});

test("a failed event insert rolls back its delivery and remains retryable with a fresh id", () => {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const store = new BackgroundFailureStore(db, deliveries);
  db.exec(`CREATE TRIGGER reject_first_background_event
    BEFORE INSERT ON events
    WHEN NEW.id = 'background-failure:rollback-run:1'
    BEGIN SELECT RAISE(ABORT, 'forced event failure'); END`);
  const reporter = createBackgroundFailureReporter({
    runId: "rollback-run",
    onOperational: () => undefined,
    onDurable: (notice) => {
      store.record({ ...notice, endpointId: "local", threadId: "assistant", binding });
    },
  });

  reporter.report("maintenance", { episode: "maintenance" });
  assert.equal(deliveries.get("background-failure:rollback-run:1"), undefined);
  assert.equal(db.prepare("SELECT 1 FROM events WHERE id = 'background-failure:rollback-run:1'").get(), undefined);

  db.exec("DROP TRIGGER reject_first_background_event");
  reporter.report("maintenance", { episode: "maintenance" });
  assert.ok(deliveries.get("background-failure:rollback-run:2"));
  assert.ok(db.prepare("SELECT 1 FROM events WHERE id = 'background-failure:rollback-run:2'").get());
  reporter.report("maintenance", { episode: "maintenance" });
  assert.equal(deliveries.get("background-failure:rollback-run:3"), undefined);
});
