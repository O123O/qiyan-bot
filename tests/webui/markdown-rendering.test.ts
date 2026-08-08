import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = new URL("../../webui-client/src/App.tsx", import.meta.url);

// The composer draft lives in App state, so every keystroke re-renders the whole component --
// including the message log, where each body is parsed as markdown, syntax-highlighted and
// typeset for maths. Nothing memoised that work, so typing stuttered in proportion to how much
// history was on screen (RENDER_CAP is 30 messages). These are cheap source contracts rather
// than render benchmarks, but each one pins a specific way that memoisation gets silently lost.
test("message bodies are not re-parsed when unrelated state changes", async () => {
  const source = await readFile(app, "utf8");

  // A memoised body is the thing that stops a keystroke reaching the markdown parser.
  assert.match(source, /const MarkdownBody = memo\(/u, "message bodies must render through a memoised component");
  assert.match(source, /<MarkdownBody body=\{m\.body\}/u, "the chat log must use it");

  // Plugin arrays built inside the component get a new identity every render, which defeats
  // both the memo above and react-markdown's own caching. They belong at module scope.
  assert.match(source, /^const REMARK_PLUGINS = /mu);
  assert.match(source, /^const REHYPE_PLUGINS = /mu);
  assert.doesNotMatch(source, /remarkPlugins=\{\[/u, "an inline plugin array is a fresh identity each render");
  assert.doesNotMatch(source, /rehypePlugins=\{\[/u, "an inline plugin array is a fresh identity each render");

  // The components map is a prop of the memoised body, so rebuilding it per render would
  // defeat the memo just as thoroughly as an inline plugin array.
  assert.match(source, /const mdComponentsFor = useCallback\(/u, "the components factory must be stable");
  assert.match(source, /mdComponentCache\.current\.set\(key, built\)/u, "and must return one identity per key");

  // The cache is only safe to hold indefinitely because what it closes over never changes.
  assert.match(source, /const openMentioned = useCallback\(/u, "a cached closure over an unstable callback would go stale");
  assert.match(source, /const openPreview = useCallback\(/u);
});
