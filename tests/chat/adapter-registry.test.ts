import assert from "node:assert/strict";
import test from "node:test";
import type { ChatAdapter, ChatDeliveryAdapter } from "../../src/chat-apps/shared/contracts.ts";
import { AppError } from "../../src/core/errors.ts";
import { ChatAdapterRegistry } from "../../src/chat-apps/shared/adapter-registry.ts";

function adapter(id: string): ChatDeliveryAdapter {
  return {
    id,
    sendMessage: async () => ({ id: `${id}-receipt` }),
  };
}

function capabilities(delivery: ChatDeliveryAdapter, history?: ChatAdapter["history"]): ChatAdapter {
  return { delivery, ...(history ? { history } : {}), initialize: async () => undefined, start: () => undefined, stop: async () => undefined, close: async () => undefined };
}

test("adapter registry selects exact IDs and rejects duplicates or unknown IDs", () => {
  const telegram = adapter("telegram");
  const slack = adapter("slack");
  const weixin = adapter("weixin");
  const registry = new ChatAdapterRegistry([capabilities(telegram), capabilities(slack), capabilities(weixin)]);
  assert.equal(registry.delivery("slack"), slack);
  assert.equal(registry.delivery("weixin"), weixin);
  assert.throws(() => registry.delivery("unknown"), /unknown chat adapter/i);
  assert.throws(() => new ChatAdapterRegistry([capabilities(telegram), capabilities(adapter("telegram"))]), /duplicate chat adapter/i);
});

test("history routes only through the binding's adapter capability", async () => {
  const telegram = capabilities(adapter("telegram"));
  const calls: unknown[] = [];
  const slack = capabilities(adapter("slack"), {
    getHistory: async (binding, request) => { calls.push({ binding, request }); return { messages: [] }; },
  });
  const weixin = capabilities(adapter("weixin"));
  const registry = new ChatAdapterRegistry([telegram, slack, weixin]);
  const binding = { adapterId: "slack", conversationKey: "slack:T1:dm:D1", destination: { workspaceId: "T1", channelId: "D1" } } as const;
  assert.deepEqual(await registry.getHistory(binding, { scope: "conversation", count: 10 }), { messages: [] });
  assert.deepEqual(calls, [{ binding, request: { scope: "conversation", count: 10 } }]);
  await assert.rejects(
    registry.getHistory({ adapterId: "telegram", conversationKey: "telegram:1", destination: { chatId: 1 } }, { scope: "conversation", count: 10 }),
    (error: unknown) => error instanceof AppError && error.code === "UNSUPPORTED_CAPABILITY",
  );
  await assert.rejects(
    registry.getHistory({ adapterId: "weixin", conversationKey: "weixin:g:o", destination: { generationId: "g" } }, { scope: "conversation", count: 10 }),
    (error: unknown) => error instanceof AppError && error.code === "UNSUPPORTED_CAPABILITY",
  );
});
