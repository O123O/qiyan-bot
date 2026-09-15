import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { explorerRootToLoad } from "../../webui-client/src/explorer-loading.ts";

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

// The eager load lived in the tab-switch effect. A regression would put it back there, where no
// unit test of this rule can see it.
test("switching tabs does not itself read a directory", async () => {
  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  const switchEffect = source.slice(source.indexOf("// On tab switch:"), source.indexOf("// The lazy half:"));
  assert.ok(switchEffect.length > 0, "the tab-switch effect was not found -- this test needs updating");
  assert.doesNotMatch(switchEffect, /loadDir\(/u,
    "the tab-switch effect must not fetch; the explorer loads its root when it is actually open");
});
