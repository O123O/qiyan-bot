import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CoordinatorRuntime } from "../../src/coordinator/runtime.ts";
import { openDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";
import { DeliveryWorker } from "../../src/telegram/delivery-worker.ts";

test("process restart recovers Telegram ambiguity and coordinator effects without replaying originals", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "codex-bot-recovery-")), "state.sqlite3");
  let db = openDatabase(path);
  let deliveries = new DeliveryStore(db);
  deliveries.prepare({ id: "d_crash", kind: "text", destination: "1", body: "[worker] result", mandatory: true });
  deliveries.markDispatched("d_crash");
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "1", rawText: "go", attachmentIds: [] });
  const operation = operations.prepare({ contextId: "ctx", attemptId: "a", callId: "c", kind: "send", args: { text: "go" } });
  operations.markDispatched(operation.id);
  db.close();

  db = openDatabase(path);
  deliveries = new DeliveryStore(db);
  deliveries.recoverAfterCrash();
  const sent: string[] = [];
  await new DeliveryWorker(deliveries, { sendMessage: async (_chat, body) => { sent.push(body); return { message_id: 9 }; } }).drain();
  assert.deepEqual(sent, ["[worker · recovery retry d_crash] result"]);
  const runtime = new CoordinatorRuntime(db, new OperationStore(db), deliveries, { destination: "1" });
  runtime.beginUserAttempt("ctx", "a", "turn");
  const recovery = runtime.failAttempt("turn", new Error("crashed after dispatch"));
  assert.equal(recovery?.kind, "recovery");
  assert.equal(runtime.failAttempt("turn", new Error("again"))?.id, recovery?.id);
  db.close();
});

