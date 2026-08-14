import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");

// A composer draft exists nowhere but the browser. When a send failed -- server down, network
// blip -- the panel cleared the box BEFORE the request and never put the text back, and for a
// worker it also deleted the optimistic bubble. A long message then existed nowhere at all.
test("a failed send gives the message back instead of destroying it", () => {
  // Cleared only after the server accepts it.
  assert.match(app, /else writeDraft\(key, ""\);/u, "the draft is surrendered only on success");
  // Both failure paths restore: a refusal (ok:false) and a transport error (throw).
  assert.match(app, /if \(!r\.ok\) \{ restore\(\);/u, "a refused send restores the text");
  assert.match(app, /catch \(e\) \{ removeRejectedOptimisticMessage\(\); restore\(\);/u, "a transport error restores the text");
  // Restoring must not clobber something typed in the meantime.
  assert.match(app, /setText\(\(current\) => \(current \? current : t\)\)/u, "never overwrite newer typing");
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
  const consumers = app.match(/setText\(""\)/gu) ?? [];
  const cleared = app.match(/setText\(""\); writeDraft\(key, ""\)/gu) ?? [];
  assert.equal(consumers.length, cleared.length + 1,
    "every setText('') clears the draft except the send path, which clears it on success");
});
