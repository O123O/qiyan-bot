import assert from "node:assert/strict";
import test from "node:test";
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { handleAssistantPanelNotification, recordAssistantPanelMessage } from "../../src/production-app.ts";

const binding = { adapterId: "web", conversationKey: "web:owner", destination: { chatId: "owner" } } as const;
const slack = { adapterId: "slack", conversationKey: "slack:c1", destination: { chatId: "c1" } } as const;

function fixture() {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const conversations = new ConversationStore(db, deliveries);
  const send = (turnId: string, item: Record<string, unknown>, at = 1_000) =>
    recordAssistantPanelMessage(conversations, "assistant-thread", () => at, "item/completed",
      { threadId: "assistant-thread", turnId, item });
  const bodies = () => conversations.listOwnerConversation(undefined, 50).map((message) => message.body);
  return { db, deliveries, conversations, send, bodies };
}

// The bug: the panel streams every assistant turn live, but only turns with a chat recipient were
// written down, so a turn QiYan started itself showed once and was gone on reload.
test("a turn with no chat recipient is still in the transcript after a reload", () => {
  const f = fixture();
  f.send("turn-internal", { type: "agentMessage", phase: "final_answer", id: "i1", text: "self-started answer" });
  assert.deepEqual(f.bodies(), ["self-started answer"]);
});

// A turn CAN emit several final answers -- measured on the live bot, 5 of 1340 -- and completeAttempt
// joins them into one delivery. Keying transcript rows by turn made the second overwrite the first,
// which on an internal turn destroyed it outright: the very failure this change exists to prevent.
test("a second final answer does not overwrite the first", () => {
  const f = fixture();
  f.send("turn-1", { type: "agentMessage", phase: "final_answer", id: "a", text: "first part" }, 1_000);
  f.send("turn-1", { type: "agentMessage", phase: "final_answer", id: "b", text: "second part" }, 2_000);
  assert.deepEqual(f.bodies(), ["first part", "second part"]);
});

// The panel applies no phase filter -- it renders every agent message with a body -- and phase is
// nullable on the wire, so dropping unphased items would leave them vanishing exactly as before.
test("an agent message with no phase is recorded, because the panel shows it", () => {
  const f = fixture();
  f.send("turn-1", { type: "agentMessage", phase: null, id: "n1", text: "unphased answer" });
  assert.deepEqual(f.bodies(), ["unphased answer"]);
});

test("a delivered turn appears exactly once, however many final items it had", () => {
  const f = fixture();
  // One delivery, carrying the joined answer, as completeAttempt would write it.
  f.deliveries.prepare({ id: "assistant:turn-chat", kind: "assistant_final", binding, body: "first\nsecond", mandatory: true });
  f.send("turn-chat", { type: "agentMessage", phase: "final_answer", id: "a", text: "first" }, 1_000);
  f.send("turn-chat", { type: "agentMessage", phase: "final_answer", id: "b", text: "second" }, 1_100);
  assert.deepEqual(f.bodies(), ["first\nsecond"], "the delivery is the record for a turn that had a recipient");
});

// The shape production actually produces for a turn bound elsewhere: a final delivery and NO
// commentary delivery, because prepareAssistantWebCommentary refuses any non-web binding (all 860
// commentary rows on the live bot are adapter web). So the answer comes from the delivery, and the
// commentary -- which the panel showed and nothing ever stored -- now survives reload. That is a
// real behaviour change for Slack-bound turns, asserted here rather than left to be discovered.
test("a turn bound to another surface keeps its answer once, and gains its commentary", () => {
  const f = fixture();
  f.deliveries.prepare({ id: "assistant:turn-s", kind: "assistant_final", binding: slack, body: "answer", mandatory: true });
  f.send("turn-s", { type: "agentMessage", phase: "commentary", id: "c1", text: "let me check" }, 1_000);
  f.send("turn-s", { type: "agentMessage", phase: "final_answer", id: "f1", text: "answer" }, 1_100);
  assert.deepEqual(f.bodies(), ["let me check", "answer"]);
});

test("commentary and the answer are both kept, and re-notification does not duplicate", () => {
  const f = fixture();
  f.send("turn-1", { type: "agentMessage", phase: "commentary", id: "c1", text: "thinking out loud" }, 1_000);
  f.send("turn-1", { type: "agentMessage", phase: "final_answer", id: "f1", text: "the answer" }, 2_000);
  f.send("turn-1", { type: "agentMessage", phase: "commentary", id: "c1", text: "thinking out loud" }, 3_000);
  assert.deepEqual(f.bodies(), ["thinking out loud", "the answer"]);
});

test("only agent messages with text, on this thread, are recorded", () => {
  const f = fixture();
  f.send("turn-1", { type: "reasoning", phase: "commentary", id: "r1", text: "internal reasoning" });
  f.send("turn-1", { type: "agentMessage", phase: "final_answer", id: "e1", text: "   " });
  f.send("turn-1", { type: "agentMessage", phase: "final_answer", text: "no item id" });
  recordAssistantPanelMessage(f.conversations, "assistant-thread", () => 1_000, "item/completed",
    { threadId: "other-thread", turnId: "turn-2", item: { type: "agentMessage", phase: "final_answer", id: "x", text: "not ours" } });
  assert.deepEqual(f.bodies(), []);
});

// Paging draws from three sources now, and the cursor value is bound once per branch. Page for
// real -- the previous version of this test never passed `before`, so it asserted nothing about it.
test("paging across deliveries and transcript entries loses nothing", () => {
  const f = fixture();
  f.deliveries.prepare({ id: "assistant:turn-a", kind: "assistant_final", binding, body: "delivered", mandatory: true });
  f.send("turn-b", { type: "agentMessage", phase: "final_answer", id: "b1", text: "recorded one" }, 3_000);
  f.send("turn-c", { type: "agentMessage", phase: "final_answer", id: "c1", text: "recorded two" }, 5_000);

  const all = f.conversations.listOwnerConversation(undefined, 50);
  assert.equal(all.length, 3);
  const page1 = f.conversations.listOwnerConversation(undefined, 2);
  const page2 = f.conversations.listOwnerConversation(page1[0]!.at, 2);
  // The cursor is inclusive, so the boundary row repeats by design; nothing may be missing.
  const seen = new Set([...page1, ...page2].map((message) => message.id));
  assert.equal(seen.size, all.length, "paging must reach every message across all three sources");
});

// The property that was broken and is now pinned: the record happens even though the delivery gate
// declines. A turn QiYan starts itself has no binding, so prepareAssistantWebCommentary refuses --
// and that refusal used to mean nothing was kept at all.
test("an internal turn is recorded even though nothing is delivered", () => {
  const f = fixture();
  let recordFailures = 0;
  const consumed = handleAssistantPanelNotification({
    // Delegate rather than spread: recordOwnerTranscriptEntry lives on the prototype, and a spread
    // would silently drop it.
    conversations: {
      recordOwnerTranscriptEntry: (input: never) => f.conversations.recordOwnerTranscriptEntry(input),
      bindingForTurn: () => undefined,
    } as never,
    deliveries: { prepare: () => assert.fail("an internal turn must not be delivered anywhere") } as never,
    now: () => 1_000,
    onRecordFailed: () => { recordFailures += 1; },
    isActiveTurn: () => true,
  }, "assistant-thread", "item/completed",
    { threadId: "assistant-thread", turnId: "turn-internal", item: { type: "agentMessage", phase: "final_answer", id: "i1", text: "kept anyway" } });

  assert.equal(consumed, false, "the notification is not consumed, so later routing still runs");
  assert.equal(recordFailures, 0);
  assert.deepEqual(f.bodies(), ["kept anyway"]);
});

// A failing record must not take the rest of the notification path down with it. Uses a COMMENTARY
// item with a web binding on purpose: a final_answer would make the delivery gate return false at
// its own phase guard, so asserting `consumed === false` would pass whether or not the gate ran at
// all. Asserting the delivery WAS prepared is what actually proves containment.
test("a failing transcript write is contained, reported, and does not stop delivery", () => {
  let reported = 0;
  const prepared: string[] = [];
  const consumed = handleAssistantPanelNotification({
    conversations: {
      recordOwnerTranscriptEntry: () => { throw new Error("database is locked"); },
      bindingForTurn: () => binding,
    } as never,
    deliveries: { prepare: (input: { id: string }) => { prepared.push(input.id); } } as never,
    now: () => 1_000,
    onRecordFailed: () => { reported += 1; },
    isActiveTurn: () => true,
  }, "assistant-thread", "item/completed",
    { threadId: "assistant-thread", turnId: "turn-1", item: { type: "agentMessage", phase: "commentary", id: "c1", text: "thinking" } });

  assert.equal(reported, 1, "the failure is reported rather than swallowed silently");
  assert.deepEqual(prepared, ["assistant-commentary:turn-1:c1"], "the delivery gate still ran after the throw");
  assert.equal(consumed, true, "and its verdict is still returned to the caller");
});
