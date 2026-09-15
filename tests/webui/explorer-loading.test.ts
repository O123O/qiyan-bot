import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { explorerRequestSignature, explorerRootToLoad } from "../../webui-client/src/explorer-loading.ts";

const base = {
  open: true,
  tab: "files" as "files" | "git",
  selected: "w3a16-mmlu" as string | null,
  filesystemRoot: "~",
  isLoaded: () => false,
};

// The point of the change: a directory listing is a round trip to the worker's host -- over ssh for
// a remote one -- and it was paid on every tab switch for a panel most switches never open.
test("a collapsed explorer fetches nothing, however the tab changes", () => {
  assert.equal(explorerRootToLoad({ ...base, open: false }), undefined);
  assert.equal(explorerRootToLoad({ ...base, open: false, selected: null }), undefined);
  // Even a tab it has never listed before: collapsed means nothing is on screen to list.
  assert.equal(explorerRootToLoad({ ...base, open: false, selected: "another-worker" }), undefined);
});

test("opening it loads the root for whichever tab is selected", () => {
  assert.deepEqual(explorerRootToLoad(base),
    { session: "w3a16-mmlu", path: "", replaceRoot: false },
    "a worker's tree is rooted at its project directory");
  assert.deepEqual(explorerRootToLoad({ ...base, selected: null }),
    { session: null, path: "~", replaceRoot: true },
    "the assistant's browser anchors a filesystem root instead");
});

// Without this the effect refires on its own result: loading sets `dirs`, which re-runs the effect,
// which loads again.
test("an already-listed root is not fetched again", () => {
  assert.equal(explorerRootToLoad({ ...base, isLoaded: (key) => key === "" }), undefined);
  assert.equal(
    explorerRootToLoad({ ...base, selected: null, filesystemRoot: "/home/mxin", isLoaded: (key) => key === "/home/mxin" }),
    undefined,
    "the filesystem browser keys its cache by the RESOLVED root, not by the '~' it asked for");
});

// Git is the other sidebar tab and has its own loader; the file tree is not rendered there.
test("the Git tab lists no directories", () => {
  assert.equal(explorerRootToLoad({ ...base, tab: "git" }), undefined);
  assert.equal(explorerRootToLoad({ ...base, tab: "git", selected: null }), undefined);
});

// The assistant browser re-anchors to HOME on every switch, rather than resuming wherever it was
// last navigated. That is existing behaviour (`main` did the same) and a real choice: `path` is what
// is requested, `filesystemRoot` is only what the last answer resolved to.
test("the filesystem browser always re-anchors to home, not to the last-navigated root", () => {
  assert.deepEqual(
    explorerRootToLoad({ ...base, selected: null, filesystemRoot: "/home/mxin/deep/somewhere" }),
    { session: null, path: "~", replaceRoot: true });
});

// Two effects run in one commit: the tab-switch reset only QUEUES `setDirs({})`, so the lazy effect
// sees the previous tab's `dirs`, issues a request, then re-runs on the new `{}` identity -- where
// `isLoaded` still cannot see a request that has not answered. That fired TWO concurrent listings
// per switch, doubling the round trip this change exists to remove. The signature is what the
// caller suppresses the second one with.
test("a request has a stable identity, and different requests differ", () => {
  const worker = explorerRootToLoad(base)!;
  const assistant = explorerRootToLoad({ ...base, selected: null })!;
  assert.equal(explorerRequestSignature(worker), explorerRequestSignature({ ...worker }),
    "the same request signs identically, or the suppression never matches and both fire");
  assert.notEqual(explorerRequestSignature(worker), explorerRequestSignature(assistant));
  assert.notEqual(
    explorerRequestSignature({ session: "a", path: "", replaceRoot: false }),
    explorerRequestSignature({ session: "b", path: "", replaceRoot: false }),
    "switching worker must not be mistaken for the request already in flight");
  // These two concatenate to the same string without a separator ("ab" + "" vs "a" + "b"), so a
  // naive signature would treat a switch to a different worker as the request already in flight
  // and never load it.
  assert.notEqual(
    explorerRequestSignature({ session: "ab", path: "", replaceRoot: false }),
    explorerRequestSignature({ session: "a", path: "b", replaceRoot: false }));
});

// The eager load lived in the tab-switch effect. A regression would put it back there, where no
// unit test of this rule can see it.
test("switching tabs does not itself read a directory", async () => {
  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  const switchEffect = source.slice(source.indexOf("// On tab switch:"), source.indexOf("// The lazy half:"));
  assert.ok(switchEffect.length > 0, "the tab-switch effect was not found -- this test needs updating");
  assert.doesNotMatch(switchEffect, /loadDir\(/u,
    "the tab-switch effect must not fetch; the explorer loads its root when it is actually open");

  // And the lazy effect must still suppress a request it has already issued -- see the signature
  // test above for why. A pure-function test cannot see this; it is an effect-ordering property.
  const lazyStart = source.indexOf("// The lazy half:");
  const lazyEnd = source.indexOf("// Git is the other half");
  // Both markers asserted: a missing end marker makes indexOf return -1, and slice(start, -1) then
  // widens to nearly the whole file -- where `assert.match` below would pass on some OTHER effect.
  assert.ok(lazyStart >= 0 && lazyEnd > lazyStart, "the lazy effect was not found -- this test needs updating");
  const lazyEffect = source.slice(lazyStart, lazyEnd);
  assert.match(lazyEffect, /if \(inFlightRootRef\.current === signature\) return;/u,
    "without the in-flight guard the reset and the load race, and every switch fetches twice");
});
