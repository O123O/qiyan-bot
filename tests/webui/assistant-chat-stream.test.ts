import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mergeAssistantConversation, mergeAssistantHistoryPage } from "../../webui-client/src/assistant-chat-stream.ts";

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

test("the first history page is adopted whole", () => {
  const first = message("assistant:turn-1", "first", 2);
  const second = message("worker:turn-2", "second", 4);

  assert.deepEqual(mergeAssistantHistoryPage([], [second, first]), [first, second]);
});

// The reconnect refetch used to replace `history`, so a socket blip discarded every page
// scroll-up had read back. Your own messages went with it and did not come back: the live
// stream drops role "you", so only the durable history can restore them.
test("a reconnect keeps the pages you scrolled back through", () => {
  const yours = message("you:old", "what is the status?", 1);
  const current = message("assistant:turn-1", "first", 2);
  const refreshed = message("assistant:turn-1", "first, durable", 3);
  const missed = message("worker:turn-2", "missed while offline", 4);

  const merged = mergeAssistantHistoryPage([yours, current], [refreshed, missed]);

  assert.deepEqual(merged, [yours, refreshed, missed], "the page folds in without dropping older rows");
  assert.ok(merged.includes(yours), "your own messages survive a reconnect");
  assert.ok(!merged.includes(current), "the refetched row replaces the stale copy rather than doubling it");
});

// Merging is only safe while the two runs touch. `history` is one contiguous run paged backwards
// from its oldest row, so a page starting past what we hold would strand the rows between behind
// a cursor that can never ask for them.
test("a page that starts past the loaded run replaces it rather than leaving an unreachable hole", () => {
  const yours = message("you:old", "old", 1);
  const current = message("assistant:turn-1", "first", 2);
  const laterPage = [message("assistant:turn-40", "much later", 90), message("worker:turn-41", "later still", 91)];

  const merged = mergeAssistantHistoryPage([yours, current], laterPage);

  assert.deepEqual(merged, laterPage);
  assert.ok(!merged.includes(yours) && !merged.includes(current), "no run may span a gap pagination cannot fill");
});

test("a targeted optimistic echo and its durable history row share one identity", async () => {
  const history = message("web:input-1", "→ @payments  ship it", 2);
  const optimistic = message("web:input-1", "→ @payments  ship it", 1);
  assert.equal(mergeAssistantConversation([history, optimistic], []).length, 1);

  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /selected === null && redirect && clientInputId \? \{ id: `web:\$\{clientInputId\}` \} : \{\}/u);
});

test("assistant history refresh adopts the latest server pagination state", async () => {
  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /setHasOlder\(\(current\) => \(\{ \.\.\.current, \[ASSIST\]: p\.hasOlder \}\)\)/u);
  assert.match(source, /assistantHistoryAbortRef\.current\?\.abort\(\)/u);
  assert.match(source, /if \(assistantHistoryAbortRef\.current !== abort\) return/u);
  assert.match(source, /selected === null && assistantHistoryAbortRef\.current/u);
});
