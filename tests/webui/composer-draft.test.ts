import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");

// A composer draft exists nowhere but the browser. When a send failed -- server down, network
// blip -- the panel cleared the box BEFORE the request and never put the text back, and for a
// worker it also deleted the optimistic bubble. A long message then existed nowhere at all.
test("a failed send gives the message back instead of destroying it", () => {
  // Both failure paths restore: a refusal (ok:false) and a transport error (throw).
  assert.match(app, /if \(!r\.ok\) \{ restore\(\);/u, "a refused send restores the text");
  assert.match(app, /catch \(e\) \{ removeRejectedOptimisticMessage\(\); restore\(\);/u, "a transport error restores the text");
  // Storage is written INSIDE the updater, so it can never disagree with the composer. Writing
  // the failed text unconditionally overwrote a draft typed during the round trip -- the exact
  // loss this exists to prevent.
  assert.match(app, /setText\(\(current\) => \{ const next = current \? current : t; writeDraft\(key, next\); return next; \}\)/u,
    "restore never overwrites newer typing, in the composer or in storage");
  // A SUCCESSFUL send must not wipe a draft typed while it was in flight either.
  assert.match(app, /else if \(composerTabRef\.current === key\) setText\(\(current\) => \{ writeDraft\(key, current\); return current; \}\)/u,
    "success persists whatever is in the box, rather than blindly clearing");
  // And the user is told where it went.
  assert.match(app, /your message is back in the box/u);
});

// "It should be cached in the web page" -- the draft survives a reload, not just a failed send.
test("an unsent draft survives a reload, per tab", () => {
  assert.match(app, /^const draftKey = \(tab: string\) => `qiyan-draft:\$\{tab\}`;/mu, "stored per tab, not globally");
  assert.match(app, /useState\(\(\) => readDraft\(ASSIST\)\)/u, "restored when the page loads");
  assert.match(app, /setText\(readDraft\(selected \?\? ASSIST\)\)/u, "and when you switch tabs");
  assert.match(app, /setText\(v\); writeDraft\(key, v\);/u, "kept in step as you type");
  // Storage can throw (private mode, quota); losing the draft to that would defeat the point.
  assert.match(app, /catch \{ return ""; \}/u, "a read that throws must not break the composer");
  assert.match(app, /catch \{ \/\* private mode, quota \*\/ \}/u, "nor a write");
});

// Every path that consumes the text must also consume the stored copy, or a sent message
// reappears in the box on the next reload.
test("consuming the text also clears the stored draft", () => {
  // Every setText must persist, except two deliberate cases: loading a draft, and the send
  // path, which defers to the outcome so a failure can hand the text back.
  const bare = [...app.matchAll(/setText\([^\n]*/gu)]
    .map((match) => match[0])
    .filter((call) => !call.includes("writeDraft") && !call.includes("readDraft"));
  assert.equal(bare.length, 1, `only the send path may skip persistence, found: ${JSON.stringify(bare)}`);
  assert.match(bare[0]!, /setText\(""\); setMentionSuggestions/u, "and that one is the send path");
});

// api() throws the parsed body on a non-2xx, so a refused stop arrives as an OBJECT. Reading it
// with String() rendered "[system] stop failed: [object Object]" and told the user nothing --
// while two other call sites in the same file already did it correctly.
test("a refused stop shows the server's reason, not [object Object]", async () => {
  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /stop failed: \$\{\(error as \{ error\?: string \}\)\.error \?\? error\}/u);
  assert.doesNotMatch(source, /stop failed: \$\{String\(error\)\}/u, "String() on the thrown body loses the reason");
  // The ok:false branch was dead code: api() never returns for a 400.
  assert.doesNotMatch(source, /if \(!result\.ok && result\.error\)/u, "unreachable branch removed");
});

// The error the user actually sees on a live worker. It must clear the cursor and re-read,
// not print an error bubble on every scroll-to-top.
test("a stale history cursor self-heals instead of reporting", async () => {
  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /reason\.includes\("cursor is stale"\) \|\| reason\.includes\("transcript changed during"\)/u,
    "both server-side staleness messages are treated as recoverable");
  assert.match(source, /\? discardWorkerHistoryCursor\(latest\)/u, "the dead cursor is dropped");
  assert.match(source, /void loadWorkerPage\(nickname, subscriptionId, snapshotPending, undefined, undefined, false, true\);/u,
    "and the newest page is re-read, marked as the one permitted retry");
  assert.match(source, /\} else push\(nickname, \{ role: "assistant", body: `Error: \$\{reason\}`/u,
    "other errors are still reported");
});

// The re-read is itself snapshot-pinned in places, so on a steadily-writing worker it can fail
// the same way. Retrying without a ceiling spins invisibly -- one ssh round trip per attempt,
// holding the endpoint's work lease, and the stale branch reports nothing.
test("a stale-cursor recovery is attempted once, then reported", async () => {
  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /const stale = !staleRetry && \(reason\.includes\("cursor is stale"\)/u,
    "a retry that fails again falls through to the normal error path");
  assert.match(source, /void loadWorkerPage\(nickname, subscriptionId, snapshotPending, undefined, undefined, false, true\);/u,
    "the recovery marks itself as the retry, and carries the caller's snapshotPending");
  assert.match(source, /before === undefined && latest\.historyLoaded && !staleRetry/u,
    "and installs the cursor it fetches rather than preserving the discarded one");
});

// There is ONE composer. Restoring into it from another tab put the message in the wrong box,
// and writing `current` under the sending tab's key overwrote that tab's unrelated draft.
test("a failed send never writes one tab's text into another tab's draft", async () => {
  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(composerTabRef\.current !== key\) \{ if \(readDraft\(key\)\.trim\(\) === t\) writeDraft\(key, t\); return; \}/u,
    "away from the sending tab, the text goes back to its own tab and the composer is untouched");
  assert.match(source, /else if \(composerTabRef\.current === key\) setText\(\(current\) => \{ writeDraft\(key, current\)/u,
    "the success path is guarded the same way");
  assert.match(source, /composerTabRef\.current = key;/u, "the ref tracks the tab actually on screen");
});

// If the retry also goes stale, no cursor is left and nothing reinstalls one -- scrolling up
// would silently do nothing until the panel resubscribed. Recovery is user-paced: bounded by
// scrolling rather than by a timer or recursion.
test("paging recovers on the next scroll-up when no cursor is left", async () => {
  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(selected !== null && workerCursor === undefined && hasOlder\[selected\]/u,
    "a missing cursor with more history is a re-read, not a dead end");
  assert.match(source, /void loadWorkerPage\(selected, workerChat\.subscriptionId, false\);/u);
  assert.match(source, /&& !workerChat\.historyInFlight/u, "never while a read is already in flight");
});

// Typing into the sending tab AFTER sending, then switching away, must not have the response
// overwrite the newer text -- the same loss the whole change exists to prevent.
test("an away-tab write never clobbers a newer draft in the sending tab", async () => {
  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(composerTabRef\.current !== key\) \{ if \(readDraft\(key\)\.trim\(\) === t\) writeDraft\(key, t\); return; \}/u,
    "restore only when the stored draft is still the text that was sent");
  assert.match(source, /else if \(readDraft\(key\)\.trim\(\) === t\) writeDraft\(key, ""\);/u,
    "and success only clears what it actually sent");
});
