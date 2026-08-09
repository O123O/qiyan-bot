import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = new URL("../../webui-client/src/App.tsx", import.meta.url);

// The rendered window is meant to stay small: the recent messages, widened only while you are
// reading back through history. It never narrowed again, so a long conversation ended up
// rendering everything it had ever shown -- REVEAL_STEP widens it on scroll-up, and every
// message arriving while you are scrolled up widens it by one more to hold your scroll
// position. Both are correct on their own; neither was ever released.
test("the rendered history window collapses again once you return to the bottom", async () => {
  const source = await readFile(app, "utf8");

  // The widening paths that made a release necessary.
  assert.match(source, /setVisible\(\(v\) => Math\.min\(v \+ REVEAL_STEP/u, "scroll-up widens the window");
  assert.match(source, /if \(!stickRef\.current\) setVisible\(\(value\) => value \+ 1\)/u, "arrivals widen it while scrolled up");

  // The release: back at the bottom, everything revealed is given up again, so loading older
  // messages hides them once you scroll down rather than pinning them on screen forever.
  assert.match(source, /if \(atBottom && visible > RENDER_CAP\) setVisible\(RENDER_CAP\)/u,
    "returning to the bottom must collapse the window back to the recent messages");
});

// The stream reducer bounds the worker snapshot (MAX_ACTIVE_MESSAGES). `log` -- your sent
// echoes and live replies -- had no bound at all, so it grew for the life of the page. That is
// memory, but it is also CPU: the shown-memo re-sorts the merged array on every message.
test("live messages retained per tab are bounded", async () => {
  const source = await readFile(app, "utf8");
  assert.match(source, /^const MAX_LIVE_LOG = \d+;/mu, "the live log needs an explicit bound");
  assert.match(source, /next\.length > MAX_LIVE_LOG \? next\.slice\(next\.length - MAX_LIVE_LOG\) : next/u,
    "push must drop the oldest rather than append without limit");

  // Trimming is only safe because what it drops is durable and comes back on scroll-up.
  assert.match(source, /hasOlder\[key\]/u, "older messages must still be loadable from the server");
});
