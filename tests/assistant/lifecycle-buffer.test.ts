import assert from "node:assert/strict";
import test from "node:test";
import {
  AssistantLifecycleBuffer,
  parseAssistantLifecycleNotification,
  type AssistantTurnLifecycleNotification,
} from "../../src/assistant/lifecycle-buffer.ts";

const notification = (method: AssistantTurnLifecycleNotification["method"], id: string): AssistantTurnLifecycleNotification => ({
  method,
  params: { threadId: "assistant", turn: { id } },
});

test("assistant lifecycle parsing is method-first and rejects malformed shapes", () => {
  assert.equal(parseAssistantLifecycleNotification("warning", undefined), undefined);
  assert.equal(parseAssistantLifecycleNotification("turn/started", undefined), undefined);
  assert.equal(parseAssistantLifecycleNotification("turn/completed", { threadId: "assistant" }), undefined);
  assert.deepEqual(parseAssistantLifecycleNotification("turn/started", { threadId: "assistant", turn: { id: "a" } }), notification("turn/started", "a"));
  // item/completed is no longer consumed by the assistant path; the terminal turn is read from thread/read.
  assert.equal(parseAssistantLifecycleNotification("item/completed", {
    threadId: "assistant",
    turnId: "a",
    item: { type: "agentMessage", id: "current-final", text: "current answer", phase: "final_answer" },
    completedAtMs: 10,
  }), undefined);
});

test("startup lifecycle notifications drain in arrival order including arrivals during activation", async () => {
  const buffer = new AssistantLifecycleBuffer();
  const seen: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const handle = async (entry: AssistantTurnLifecycleNotification) => {
    seen.push(entry.params.turn.id);
    if (entry.params.turn.id === "a") await blocked;
  };
  await buffer.accept(notification("turn/started", "a"), handle);
  const activating = buffer.activate(handle);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await buffer.accept(notification("turn/completed", "b"), handle);
  release();
  await activating;
  await buffer.accept(notification("turn/started", "c"), handle);
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.equal(buffer.size, 0);
});

test("assistant lifecycle buffer is bounded and clear fences failed startup", async () => {
  const buffer = new AssistantLifecycleBuffer(1);
  const handle = async () => undefined;
  await buffer.accept(notification("turn/started", "a"), handle);
  await assert.rejects(buffer.accept(notification("turn/completed", "b"), handle), /buffer is full/iu);
  buffer.clear();
  assert.equal(buffer.size, 0);
  await buffer.accept(notification("turn/started", "c"), handle);
  assert.equal(buffer.size, 1);
});
