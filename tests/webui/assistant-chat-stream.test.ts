import assert from "node:assert/strict";
import test from "node:test";
import { mergeAssistantConversation } from "../../webui-client/src/assistant-chat-stream.ts";

const message = (id: string, body: string, at: number, extra = {}) => ({ id, body, at, ...extra });

test("a live QiYan message remains visible until its durable replacement arrives", () => {
  const live = message("a:turn-1:item-1", "checking", 2, {
    role: "worker", turnId: "turn-1", phase: "commentary", terminalStatus: "completed",
  });

  assert.deepEqual(mergeAssistantConversation([], [live]), [{ ...live, role: "assistant" }]);

  const durable = message("assistant-commentary:turn-1:item-1", "checking", 3);
  assert.deepEqual(mergeAssistantConversation([durable], [live]), [durable]);
});

test("a final live message is replaced without a duplicate or disappearance gap", () => {
  const live = message("a:turn-1:final-1", "done", 2, {
    turnId: "turn-1", phase: "final_answer", terminalStatus: "completed",
  });
  const durable = message("assistant:turn-1", "done", 3);

  assert.deepEqual(mergeAssistantConversation([], [live]), [{ ...live, role: "assistant" }]);
  assert.deepEqual(mergeAssistantConversation([durable], [live]), [durable]);
});

test("the same durable WebSocket and history message is rendered once", () => {
  const history = message("assistant:turn-1", "done", 2);
  const socket = message("assistant:turn-1", "done", 3);

  assert.deepEqual(mergeAssistantConversation([history, socket], []), [socket]);
});
