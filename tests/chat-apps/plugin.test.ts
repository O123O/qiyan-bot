import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalChatSource } from "../../src/core/types.ts";
import type { JsonValue } from "../../src/chat-apps/shared/binding.ts";
import type { ChatAdapter, ChatDeliveryAdapter } from "../../src/chat-apps/shared/contracts.ts";
import type { ChatApp, ChatAppDeps } from "../../src/chat-apps/shared/plugin.ts";
import { ChatAdapterRegistry } from "../../src/chat-apps/shared/adapter-registry.ts";
import { DeliveryWorker } from "../../src/chat-apps/shared/delivery-worker.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";

// A minimal chat app implemented purely against the public plugin interface. This is the "add a new app"
// path a provider (Teams, Discord, …) follows: implement ChatApp, wire an adapter in create(). The test
// proves such an app constructs, registers, and delivers idempotently through the shared machinery with no
// core changes beyond registration.
function exampleApp(sent: string[], ready: { called: number }): ChatApp<{ botToken: string }> {
  return {
    id: "example",
    displayName: "Example",
    create(deps: ChatAppDeps, config: { botToken: string }): { adapter: ChatAdapter; onAllReady?(): void } {
      assert.equal(typeof config.botToken, "string");        // app receives its own parsed config
      const delivery: ChatDeliveryAdapter = {
        id: "example",
        async sendMessage(_destination: JsonValue, body: string, _reply?: JsonValue, options?: { deliveryId: string }): Promise<JsonValue> {
          sent.push(body);
          return { deliveryId: options?.deliveryId ?? null };
        },
      };
      const adapter: ChatAdapter = {
        delivery,
        primaryBinding: { adapterId: "example", conversationKey: "example:owner", destination: { chatId: "owner" } },
        async initialize() { /* an app can validate its transport here */ },
        start() { /* begin receiving; would call deps.onMessage(source, effects) */ },
        async stop() { /* no-op */ },
        async close() { /* no-op */ },
      };
      return { adapter, onAllReady: () => { ready.called += 1; } };
    },
  };
}

function fakeDeps(onMessage: (source: CanonicalChatSource) => Promise<void>): ChatAppDeps {
  // Only the shared infra fields an app might touch; the example app uses none of the stores.
  return { onMessage: async (source: CanonicalChatSource) => onMessage(source), maxMessageBytes: 1000 } as unknown as ChatAppDeps;
}

test("a plugin app constructs, registers, and delivers idempotently through the shared machinery", async () => {
  const sent: string[] = [];
  const ready = { called: 0 };
  const app = exampleApp(sent, ready);

  const instance = app.create(fakeDeps(async () => undefined), { botToken: "t" });
  assert.equal(app.id, "example");
  assert.equal(instance.adapter.delivery.id, "example");
  assert.deepEqual(instance.adapter.primaryBinding?.adapterId, "example");

  const registry = new ChatAdapterRegistry([{ delivery: instance.adapter.delivery }]);
  assert.equal(registry.delivery("example"), instance.adapter.delivery);

  const store = new DeliveryStore(createTestDatabase());
  const worker = new DeliveryWorker(store, registry);
  store.prepare({
    id: "e1", kind: "chat", mandatory: true, body: "hello",
    binding: { adapterId: "example", conversationKey: "example:owner", destination: { chatId: "owner" } },
  });

  await worker.processOne("e1");
  await worker.processOne("e1");                    // re-dispatch is a no-op: same delivery id => one send
  assert.deepEqual(sent, ["hello"]);
  assert.equal(store.get("e1")?.state, "confirmed");

  await instance.onAllReady?.();
  assert.equal(ready.called, 1);
});
