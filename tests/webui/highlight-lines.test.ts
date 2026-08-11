import assert from "node:assert/strict";
import test from "node:test";
import { splitHighlightedLines } from "../../webui-client/src/highlight-lines.ts";

test("plain text splits into one fragment per line", () => {
  assert.deepEqual(splitHighlightedLines("alpha\nbeta\ngamma"), ["alpha", "beta", "gamma"]);
  assert.deepEqual(splitHighlightedLines(""), [""]);
  // A trailing newline is a real empty last line, and the gutter must number it.
  assert.deepEqual(splitHighlightedLines("only\n"), ["only", ""]);
});

// The whole reason this exists: highlight.js wraps a block comment or a template literal in one
// span that crosses lines. Splitting on "\n" alone would leave the span unclosed on the first
// line and orphan its closing tag on the last, and the browser would then colour the rest of
// the file as comment.
test("a span crossing lines is closed and reopened so every line stands alone", () => {
  const lines = splitHighlightedLines('<span class="hljs-comment">/* one\ntwo\nthree */</span>');
  assert.deepEqual(lines, [
    '<span class="hljs-comment">/* one</span>',
    '<span class="hljs-comment">two</span>',
    '<span class="hljs-comment">three */</span>',
  ]);
  for (const line of lines) {
    assert.equal((line.match(/<span/gu) ?? []).length, (line.match(/<\/span>/gu) ?? []).length,
      `every fragment must balance its tags: ${line}`);
  }
});

test("nested spans reopen in the original order", () => {
  const lines = splitHighlightedLines('<span class="a"><span class="b">x\ny</span>z</span>');
  assert.deepEqual(lines, [
    '<span class="a"><span class="b">x</span></span>',
    '<span class="a"><span class="b">y</span>z</span>',
  ]);
});

test("text is carried through untouched, entities included", () => {
  // hljs escapes source, so the fragments must not re-escape or unescape anything.
  const lines = splitHighlightedLines('<span class="hljs-string">"a &lt; b"</span>\nplain &amp; text');
  assert.deepEqual(lines, ['<span class="hljs-string">"a &lt; b"</span>', "plain &amp; text"]);
});

test("malformed markup degrades to plain output rather than scrambled output", () => {
  assert.deepEqual(splitHighlightedLines("before <span class=unterminated"), ["before <span class=unterminated"]);
});

// The line count has to match the source exactly, or every number below a multi-line construct
// is wrong — which is worse than having no numbers at all.
test("the fragment count always equals the source line count", () => {
  const source = 'a\n/* b\nc */\nd\n\ne';
  const highlighted = 'a\n<span class="hljs-comment">/* b\nc */</span>\nd\n\ne';
  assert.equal(splitHighlightedLines(highlighted).length, source.split("\n").length);
});
