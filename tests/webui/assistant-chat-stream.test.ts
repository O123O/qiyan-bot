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

  assert.deepEqual(mergeAssistantHistoryPage([], [second, first]), { messages: [first, second], replaced: true });
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

  assert.deepEqual(merged.messages, [yours, refreshed, missed], "the page folds in without dropping older rows");
  assert.equal(merged.replaced, false, "the run was extended, not restarted");
  assert.ok(merged.messages.includes(yours), "your own messages survive a reconnect");
  assert.ok(!merged.messages.includes(current), "the refetched row replaces the stale copy rather than doubling it");
});

// Merging is only safe while the two runs touch. `history` is one contiguous run paged backwards
// from its oldest row, so a page starting past what we hold would strand the rows between behind
// a cursor that can never ask for them.
test("a page that starts past the loaded run replaces it rather than leaving an unreachable hole", () => {
  const yours = message("you:old", "old", 1);
  const current = message("assistant:turn-1", "first", 2);
  const laterPage = [message("assistant:turn-40", "much later", 90), message("worker:turn-41", "later still", 91)];

  const merged = mergeAssistantHistoryPage([yours, current], laterPage);

  assert.deepEqual(merged.messages, laterPage);
  assert.equal(merged.replaced, true, "a run that cannot be continued is restarted");
  assert.ok(!merged.messages.includes(yours) && !merged.messages.includes(current),
    "no run may span a gap pagination cannot fill");
});

// The decision turns on one row, so the two sides of it are what need pinning: a page whose
// oldest row is the newest row we hold touches the run exactly, and the very next page along
// -- one row later, no overlap at all -- is already a hole.
test("the merge boundary is the page's oldest row, not how far apart the two runs look", () => {
  const first = message("you:1", "first", 1);
  const second = message("assistant:2", "second", 2);
  const third = message("assistant:3", "third", 3);

  const touching = mergeAssistantHistoryPage([first, second], [second, third]);
  assert.equal(touching.replaced, false, "a page starting on the newest row we hold continues the run");
  assert.deepEqual(touching.messages, [first, second, third]);

  const abutting = mergeAssistantHistoryPage([first, second], [third]);
  assert.equal(abutting.replaced, true, "one row past the run is still a hole the cursor cannot reach");
  assert.deepEqual(abutting.messages, [third]);
});

// `loadOlder` pages backwards from `history[0]`, so whatever this returns has to start at the
// oldest row still held or the next scroll-up silently skips everything before it.
test("the merged run still starts at the oldest row held, so the scroll-up cursor stays valid", () => {
  const oldest = message("you:1", "oldest", 1);
  const middle = message("assistant:2", "middle", 2);
  const newest = message("assistant:9", "newest", 9);

  const merged = mergeAssistantHistoryPage([oldest, middle], [middle, newest]);
  assert.equal(merged.messages[0], oldest);
});

// Guard, not a path: the owner transcript gives every row a string id. Without ids the page
// cannot be placed against the run at all, so it is treated as a gap rather than merged blind.
test("a page whose oldest row carries no id is treated as a gap", () => {
  const held = message("assistant:1", "held", 1);
  const anonymous = { body: "no id", at: 2 };

  const merged = mergeAssistantHistoryPage([held], [anonymous as typeof held]);
  assert.equal(merged.replaced, true);
  assert.deepEqual(merged.messages, [anonymous]);
});

test("a targeted optimistic echo and its durable history row share one identity", async () => {
  const history = message("web:input-1", "→ @payments  ship it", 2);
  const optimistic = message("web:input-1", "→ @payments  ship it", 1);
  assert.equal(mergeAssistantConversation([history, optimistic], []).length, 1);

  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /selected === null && redirect && clientInputId \? \{ id: `web:\$\{clientInputId\}` \} : \{\}/u);
});

// A source guard, not a behavioural test, and named so it stops claiming otherwise. There is no
// render harness for App.tsx in this repo, so these pin the two spellings whose absence each
// caused a real bug on this branch. They prove the code says the right thing, not that it does
// it; the behaviour itself is pinned on the pure function above.
test("source guard: the run has one writer, one reader, and pagination state that follows the merge", async () => {
  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");

  // `p.hasOlder` describes the page, not the run. Adopting it after a merge re-armed the "load
  // older" affordance on a conversation already paged back to its first message.
  assert.match(source, /if \(refreshed\.replaced\) setHasOlder\(/u);

  // One writer, so the ref and the state cannot drift apart.
  assert.equal(source.match(/setHistory\(/gu)?.length, 1, "setHistory is called only inside applyHistory");
  assert.match(source, /const applyHistory = useCallback\(\(next: Msg\[\]\) => \{ historyRef\.current = next; setHistory\(next\); \}/u);

  // One reader. `loadHistory` writes the ref synchronously and the state at default priority, so
  // a discrete event landing between them re-enters `loadOlder` from the render before it. Its
  // closure still holds the pre-merge run, and prepending onto that drops exactly the rows the
  // merge recovered -- rows no live path can supply again, your own messages among them.
  const loadOlder = source.slice(source.indexOf("const loadOlder ="), source.indexOf("loadWorkerPage, applyHistory]);"));
  assert.ok(loadOlder.length > 0, "loadOlder must be locatable for this guard to mean anything");
  assert.match(loadOlder, /const loaded = historyRef\.current;/u);
  // Lookarounds, not a negated class: the spelling that caused the bug was the spread
  // `[...fresh, ...history]`, and a class excluding `.` to spare `historyRef` let it through.
  assert.doesNotMatch(loadOlder, /(?<![A-Za-z_])history(?![A-Za-z_(])/u,
    "loadOlder must read the run from historyRef, never from the `history` closure");

  // The abort handshake these two share, which is what keeps them from overlapping at all.
  assert.match(source, /assistantHistoryAbortRef\.current\?\.abort\(\)/u);
  assert.match(source, /if \(assistantHistoryAbortRef\.current !== abort\) return/u);
  assert.match(source, /selected === null && assistantHistoryAbortRef\.current/u);
});
