import assert from "node:assert/strict";
import test from "node:test";
import {
  AssistantCompletedItems,
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
  assert.deepEqual(parseAssistantLifecycleNotification("item/completed", {
    threadId: "assistant",
    turnId: "a",
    item: { type: "agentMessage", id: "current-final", text: "current answer", phase: "final_answer" },
    completedAtMs: 10,
  }), {
    method: "item/completed",
    params: {
      threadId: "assistant",
      turnId: "a",
      item: { type: "agentMessage", id: "current-final", text: "current answer", phase: "final_answer" },
      completedAtMs: 10,
    },
  });
  assert.equal(parseAssistantLifecycleNotification("item/completed", {
    threadId: "assistant",
    turnId: "a",
    item: { type: "agentMessage", id: "comment", text: "working", phase: "commentary" },
    completedAtMs: 10,
  }), undefined);
});

test("completed assistant finals are turn-isolated, ordered, deduplicated, and consumed", () => {
  const items = new AssistantCompletedItems();
  const record = (turnId: string, id: string, text: string) => {
    const completed = parseAssistantLifecycleNotification("item/completed", {
      threadId: "assistant", turnId,
      item: { type: "agentMessage", id, text, phase: "final_answer" },
      completedAtMs: 10,
    });
    assert.equal(completed?.method, "item/completed");
    if (completed?.method === "item/completed") items.record(completed);
  };
  record("turn-a", "one", "first");
  record("turn-a", "two", "second");
  record("turn-a", "one", "updated first");
  record("turn-b", "other", "other turn");

  assert.deepEqual(items.peek("turn-a").map(({ id, text }) => ({ id, text })), [
    { id: "one", text: "updated first" },
    { id: "two", text: "second" },
  ]);
  items.discard("turn-a");
  assert.deepEqual(items.peek("turn-a"), []);
  assert.deepEqual(items.peek("turn-b").map(({ id }) => id), ["other"]);
});

test("completed assistant final buffering has deterministic turn and item bounds", () => {
  const items = new AssistantCompletedItems(2, 2);
  const record = (turnId: string, id: string) => {
    const completed = parseAssistantLifecycleNotification("item/completed", {
      threadId: "assistant", turnId,
      item: { type: "agentMessage", id, text: id, phase: "final_answer" },
      completedAtMs: 10,
    });
    if (completed?.method === "item/completed") items.record(completed);
  };
  record("turn-items", "a");
  record("turn-items", "b");
  record("turn-items", "c");
  assert.deepEqual(items.peek("turn-items").map(({ id }) => id), ["b", "c"]);
  items.discard("turn-items");

  record("turn-old", "old");
  record("turn-middle", "d");
  record("turn-new", "e");

  assert.deepEqual(items.peek("turn-old"), []);
  assert.deepEqual(items.peek("turn-middle").map(({ id }) => id), ["d"]);
  assert.deepEqual(items.peek("turn-new").map(({ id }) => id), ["e"]);
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
