import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantRuntime } from "../../src/assistant/runtime.ts";
import { ChatAdapterRegistry } from "../../src/chat/adapter-registry.ts";
import { DeliveryWorker } from "../../src/chat/delivery-worker.ts";
import { openDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";

const binding = { adapterId: "telegram", conversationKey: "telegram:1", destination: { chatId: "1" } } as const;

test("process restart recovers Telegram ambiguity and assistant effects without replaying originals", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "qiyan-bot-recovery-")), "state.sqlite3");
  let db = openDatabase(path);
  let deliveries = new DeliveryStore(db);
  deliveries.prepare({ id: "d_crash", kind: "text", binding, body: "[worker] result", mandatory: true });
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
  await new DeliveryWorker(deliveries, new ChatAdapterRegistry([{ delivery: { id: "telegram", sendMessage: async (_chat, body) => { sent.push(body); return { messageId: 9 }; } } }])).drain();
  assert.deepEqual(sent, ["[worker · recovery retry d_crash] result"]);
  const runtime = new AssistantRuntime(db, new OperationStore(db), deliveries, { binding });
  runtime.beginUserAttempt("ctx", "a", "turn");
  const recovery = runtime.failAttempt("turn", new Error("crashed after dispatch"));
  assert.equal(recovery?.kind, "recovery");
  assert.equal(runtime.failAttempt("turn", new Error("again"))?.id, recovery?.id);
  db.close();
});
