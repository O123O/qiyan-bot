import assert from "node:assert/strict";
import test from "node:test";
import type { ChatAdapter, ChatDeliveryAdapter } from "../../src/chat/contracts.ts";
import { AppError } from "../../src/core/errors.ts";
import { ChatAdapterRegistry } from "../../src/chat/adapter-registry.ts";

function adapter(id: string): ChatDeliveryAdapter {
  return {
    id,
    sendMessage: async () => ({ id: `${id}-receipt` }),
  };
}

function capabilities(delivery: ChatDeliveryAdapter, history?: ChatAdapter["history"]): ChatAdapter {
  return { delivery, ...(history ? { history } : {}), start: () => undefined, stop: async () => undefined, close: async () => undefined };
}

test("adapter registry selects exact IDs and rejects duplicates or unknown IDs", () => {
  const telegram = adapter("telegram");
  const slack = adapter("slack");
  const registry = new ChatAdapterRegistry([capabilities(telegram), capabilities(slack)]);
  assert.equal(registry.delivery("slack"), slack);
  assert.throws(() => registry.delivery("wechat"), /unknown chat adapter/i);
  assert.throws(() => new ChatAdapterRegistry([capabilities(telegram), capabilities(adapter("telegram"))]), /duplicate chat adapter/i);
});

test("history routes only through the binding's adapter capability", async () => {
  const telegram = capabilities(adapter("telegram"));
  const calls: unknown[] = [];
  const slack = capabilities(adapter("slack"), {
    getHistory: async (binding, request) => { calls.push({ binding, request }); return { messages: [] }; },
  });
  const registry = new ChatAdapterRegistry([telegram, slack]);
  const binding = { adapterId: "slack", conversationKey: "slack:T1:dm:D1", destination: { workspaceId: "T1", channelId: "D1" } } as const;
  assert.deepEqual(await registry.getHistory(binding, { scope: "conversation", count: 10 }), { messages: [] });
  assert.deepEqual(calls, [{ binding, request: { scope: "conversation", count: 10 } }]);
  await assert.rejects(
    registry.getHistory({ adapterId: "telegram", conversationKey: "telegram:1", destination: { chatId: 1 } }, { scope: "conversation", count: 10 }),
    (error: unknown) => error instanceof AppError && error.code === "UNSUPPORTED_CAPABILITY",
  );
});
