// When the file explorer should fetch a directory listing, and when it must not.
//
// Listing a directory is a round trip to the worker's host -- over ssh for a remote one -- and it
// used to be paid on every tab switch, for a panel most switches never look at. The rule is now
// "only what is on screen": nothing is fetched while the explorer is collapsed or showing Git, and
// the root is fetched once, when it first becomes visible for the selected tab.
//
// A pure function so the rule can be tested directly. The bug this guards against is a fetch that
// should not happen, which a rendered-output assertion cannot see.
export interface ExplorerRootRequest {
  /** The worker whose project root to list, or null for the assistant's filesystem browser. */
  session: string | null;
  path: string;
  /** The filesystem browser re-anchors its root; a worker's project root does not. */
  replaceRoot: boolean;
}

export function explorerRootToLoad(state: {
  open: boolean;
  tab: "files" | "git";
  selected: string | null;
  filesystemRoot: string;
  /** Whether a listing for this tree key is already held (or in flight). */
  isLoaded(key: string): boolean;
}): ExplorerRootRequest | undefined {
  if (!state.open || state.tab !== "files") return undefined;
  if (state.selected === null) {
    // The filesystem browser keys its cache by the resolved root, which "~" becomes once read.
    return state.isLoaded(state.filesystemRoot) ? undefined : { session: null, path: "~", replaceRoot: true };
  }
  // A worker's tree is rooted at "" -- its project directory.
  return state.isLoaded("") ? undefined : { session: state.selected, path: "", replaceRoot: false };
}
