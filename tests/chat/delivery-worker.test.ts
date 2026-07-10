import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "../../src/chat/binding.ts";
import type { ChatDeliveryAdapter, UncertainDeliveryResolution } from "../../src/chat/contracts.ts";
import { ChatAdapterRegistry } from "../../src/chat/adapter-registry.ts";
import { DeliveryWorker } from "../../src/chat/delivery-worker.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

class FakeAdapter implements ChatDeliveryAdapter {
  readonly sent: Array<{ destination: JsonValue; body: string; deliveryId?: string }> = [];
  constructor(readonly id: string, private readonly receipt: JsonValue) {}
  async sendMessage(destination: JsonValue, body: string, _reply?: JsonValue, options?: { deliveryId: string }): Promise<JsonValue> {
    this.sent.push({ destination, body, ...(options ? { deliveryId: options.deliveryId } : {}) });
    return this.receipt;
  }
}

test("delivery worker routes by adapter and persists opaque binding and receipt", async () => {
  const db = createTestDatabase();
  const store = new DeliveryStore(db);
  const telegram = new FakeAdapter("telegram", { messageId: 7 });
  const slack = new FakeAdapter("slack", { ts: "1.2" });
  const worker = new DeliveryWorker(store, new ChatAdapterRegistry([{ delivery: telegram }, { delivery: slack }]));
  const binding = { adapterId: "slack", conversationKey: "slack:C1:thread:9", destination: { channel: "C1", threadTs: "9" } } as const;
  const delivery = store.prepare({ id: "d1", kind: "chat", binding, body: "hello", mandatory: true });
  assert.deepEqual(store.get("d1")?.binding, binding);
  await worker.processOne(delivery.id);
  assert.deepEqual(store.get("d1")?.receipt, { ts: "1.2" });
  assert.deepEqual(slack.sent, [{ destination: { channel: "C1", threadTs: "9" }, body: "hello", deliveryId: "d1" }]);
  assert.equal(telegram.sent.length, 0);
});

test("a confirmed delivery stays confirmed when projection requests restart and throws", async () => {
  const store = new DeliveryStore(createTestDatabase());
  const adapter = new FakeAdapter("telegram", { messageId: 7 });
  const delivery = store.prepare({
    id: "confirmed-before-projection",
    kind: "chat",
    binding: { adapterId: "telegram", conversationKey: "owner", destination: { chatId: "owner" } },
    body: "private body",
    mandatory: true,
  });
  let restarts = 0;
  const worker = new DeliveryWorker(
    store,
    new ChatAdapterRegistry([{ delivery: adapter }]),
    undefined,
    undefined,
    () => {
      restarts += 1;
      throw new Error("projection failed");
    },
  );

  await worker.processOne(delivery.id);
  assert.equal(store.get(delivery.id)?.state, "confirmed");
  assert.equal(restarts, 1);
});

test("concurrent delivery processing dispatches one chat write", async () => {
  const store = new DeliveryStore(createTestDatabase());
  const delivery = store.prepare({
    id: "concurrent", kind: "chat",
    binding: { adapterId: "slack", conversationKey: "owner", destination: { channel: "owner" } },
    body: "private body", mandatory: true,
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let sends = 0;
  const adapter: ChatDeliveryAdapter = {
    id: "slack",
    sendMessage: async () => { sends += 1; await blocked; return { messageTs: String(sends) }; },
  };
  const worker = new DeliveryWorker(store, new ChatAdapterRegistry([{ delivery: adapter }]));

  const first = worker.processOne(delivery.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = worker.processOne(delivery.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sends, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(store.get(delivery.id)?.attemptCount, 1);
});

test("adapter-specific retry proof overrides generic HTTP status handling", async () => {
  const store = new DeliveryStore(createTestDatabase());
  const binding = { adapterId: "slack", conversationKey: "slack:C1", destination: { channel: "C1" } } as const;
  const safe = store.prepare({ id: "safe", kind: "chat", binding, body: "one", mandatory: true });
  const ambiguous = store.prepare({ id: "ambiguous", kind: "chat", binding, body: "two", mandatory: true });
  const adapter: ChatDeliveryAdapter = {
    id: "slack",
    sendMessage: async (_destination, _body, _reply, options) => {
      throw { status: 429, safeToRetry: options?.deliveryId === "safe" };
    },
    isSafeToRetry: (error) => (error as { safeToRetry?: boolean }).safeToRetry === true,
  };
  const worker = new DeliveryWorker(store, new ChatAdapterRegistry([{ delivery: adapter }]));
  await assert.rejects(worker.processOne(safe.id));
  await assert.rejects(worker.processOne(ambiguous.id));
  assert.equal(store.get(safe.id)?.state, "prepared");
  assert.equal(store.get(ambiguous.id)?.state, "uncertain");
});

test("every delivery failure reaches the metadata-only operational callback", async () => {
  const store = new DeliveryStore(createTestDatabase());
  const delivery = store.prepare({
    id: "observable", kind: "chat",
    binding: { adapterId: "telegram", conversationKey: "owner", destination: { chatId: "owner" } },
    body: "secret body", mandatory: true,
  });
  const adapter: ChatDeliveryAdapter = {
    id: "telegram",
    sendMessage: async () => { throw new Error("secret-token"); },
    isSafeToRetry: () => true,
  };
  const seen: Array<{ adapter: string; state: string }> = [];
  const worker = new DeliveryWorker(
    store,
    new ChatAdapterRegistry([{ delivery: adapter }]),
    undefined,
    undefined,
    undefined,
    (record) => { seen.push({ adapter: record.binding.adapterId, state: record.state }); },
  );
  await assert.rejects(worker.processOne(delivery.id));
  assert.deepEqual(seen, [{ adapter: "telegram", state: "prepared" }]);
  assert.equal(JSON.stringify(seen).includes("secret"), false);
});

test("a deterministic Slack rejection fails without retrying", async () => {
  const store = new DeliveryStore(createTestDatabase());
  const binding = { adapterId: "slack", conversationKey: "slack:C1", destination: { channel: "C1" } } as const;
  const delivery = store.prepare({ id: "rejected", kind: "chat", binding, body: "one", mandatory: true });
  let attempts = 0;
  const adapter: ChatDeliveryAdapter = {
    id: "slack",
    sendMessage: async () => { attempts += 1; throw { deterministic: true, safeToRetry: false }; },
    isSafeToRetry: () => false,
  };
  const worker = new DeliveryWorker(store, new ChatAdapterRegistry([{ delivery: adapter }]));
  await assert.rejects(worker.processOne(delivery.id));
  assert.equal(store.get(delivery.id)?.state, "failed");
  assert.equal(attempts, 1);
});

test("same destination JSON does not erase distinct conversation keys", () => {
  const store = new DeliveryStore(createTestDatabase());
  const first = store.prepare({
    id: "one", kind: "chat", binding: { adapterId: "slack", conversationKey: "slack:C1", destination: { channel: "C1" } }, body: "1", mandatory: true,
  });
  const second = store.prepare({
    id: "two", kind: "chat", binding: { adapterId: "slack", conversationKey: "slack:C1:T2", destination: { channel: "C1" } }, body: "2", mandatory: true,
  });
  assert.notEqual(first.binding.conversationKey, second.binding.conversationKey);
});

test("adapter reconciliation confirms, resumes, or preserves uncertain deliveries before generic policy", async () => {
  for (const mandatory of [true, false]) {
    for (const resolution of [
      { outcome: "confirmed", receipt: { remote: "ok" } },
      { outcome: "resume_safe" },
      { outcome: "unresolved" },
    ] as UncertainDeliveryResolution[]) {
      const store = new DeliveryStore(createTestDatabase());
      const delivery = store.prepare({
        id: `${mandatory}-${resolution.outcome}`, kind: "chat",
        binding: { adapterId: "reconciling", conversationKey: "one", destination: { owner: "one" } },
        body: "body", mandatory,
      });
      store.markDispatched(delivery.id);
      store.recoverAfterCrash();
      let sends = 0;
      const seen: unknown[] = [];
      const adapter: ChatDeliveryAdapter = {
        id: "reconciling",
        async reconcileUncertain(context) { seen.push(context); return resolution; },
        async sendMessage() { sends += 1; return {}; },
      };
      const worker = new DeliveryWorker(store, new ChatAdapterRegistry([{ delivery: adapter }]));
      if (resolution.outcome === "unresolved") {
        await assert.rejects(worker.processOne(delivery.id), /may already have been sent/u);
        assert.equal(store.get(delivery.id)?.state, "uncertain");
      } else {
        await worker.processOne(delivery.id);
        assert.equal(store.get(delivery.id)?.state, resolution.outcome === "confirmed" ? "confirmed" : "prepared");
      }
      assert.equal(sends, 0);
      assert.deepEqual(seen, [{
        id: delivery.id, binding: delivery.binding, mandatory, hasAttachment: false,
      }]);
      assert.equal(store.get(`delivery-warning:${delivery.id}`), undefined);
    }
  }
});

test("unresolved adapter reconciliation retains mandatory and optional attachment snapshots", async () => {
  for (const mandatory of [true, false]) {
    const db = createTestDatabase();
    db.prepare(`INSERT INTO attachments
      (id, scope_id, display_name, media_type, local_path, size, sha256, ref_count, expires_at, created_at)
      VALUES ('attachment', 'scope', 'file', 'x', '/tmp/file', 1, 'hash', 0, 999, 1)`).run();
    const store = new DeliveryStore(db);
    const delivery = store.prepareAttachment({
      id: `attachment-${mandatory}`, kind: "file",
      binding: { adapterId: "reconciling", conversationKey: "one", destination: {} }, body: "", mandatory,
      attachmentId: "attachment", attachmentScopeId: "scope",
    });
    store.markDispatched(delivery.id);
    store.recoverAfterCrash();
    const adapter: ChatDeliveryAdapter = {
      id: "reconciling", reconcileUncertain: async () => ({ outcome: "unresolved" }), sendMessage: async () => ({}),
    };
    await assert.rejects(new DeliveryWorker(store, new ChatAdapterRegistry([{ delivery: adapter }])).processOne(delivery.id));
    assert.equal(db.prepare("SELECT ref_count FROM attachments WHERE id = 'attachment'").get()!.ref_count, 1);
  }
});

test("drain sends a newly prepared warning for an abandoned optional uncertain delivery", async () => {
  const store = new DeliveryStore(createTestDatabase());
  const delivery = store.prepare({
    id: "optional-uncertain",
    kind: "chat",
    binding: { adapterId: "legacy", conversationKey: "one", destination: {} },
    body: "possibly sent",
    mandatory: false,
  });
  store.markDispatched(delivery.id);
  store.recoverAfterCrash();
  const adapter = new FakeAdapter("legacy", { messageId: "warning" });

  await new DeliveryWorker(store, new ChatAdapterRegistry([{ delivery: adapter }])).drain();

  assert.equal(store.get(delivery.id)?.state, "uncertain");
  assert.deepEqual(adapter.sent, [{
    destination: {},
    body: "[system] delivery optional-uncertain could not be confirmed and was not automatically retried",
    deliveryId: "delivery-warning:optional-uncertain",
  }]);
  assert.equal(store.get("delivery-warning:optional-uncertain")?.state, "confirmed");
});
