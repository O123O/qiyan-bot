import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

// The composer's newlines were never lost: they reach the database intact. CommonMark simply
// treats a single newline as a SOFT break and renders it as a space, so a multi-line paste
// arrived as one run-on line. These render the real pipeline rather than asserting the plugin
// is imported, because "wired up" and "renders as line breaks" are different claims.
const require_ = createRequire(new URL("../../webui-client/package.json", import.meta.url));

// Rendered through the real react-markdown, server-side, with the plugins that can actually
// interact with hard breaks: gfm owns tables, math owns $$...$$, and both rely on newlines
// structurally. Asserting the plugin is imported would not distinguish "wired up" from
// "renders as line breaks". The list is replicated rather than imported because App.tsx cannot
// be loaded here (JSX and asset imports); the source contract below pins that it matches.
async function render(markdown: string, hardBreaks: boolean): Promise<string> {
  const { renderToStaticMarkup } = require_("react-dom/server");
  const { createElement } = require_("react");
  const Markdown = require_("react-markdown").default;
  const remarkPlugins = [require_("remark-gfm").default, require_("remark-math").default,
    ...(hardBreaks ? [require_("remark-breaks").default] : [])];
  const rehypePlugins = [require_("rehype-katex").default];
  return renderToStaticMarkup(createElement(Markdown, { remarkPlugins, rehypePlugins }, markdown));
}

const pasted = "add this to the ssh config,\nHost lyris\n  HostName login-lyris.example.com\n  User someone";

test("a multi-line paste keeps its line breaks in chat", async () => {
  const html = await render(pasted, true);
  // Three single newlines become three hard breaks rather than three spaces.
  assert.equal((html.match(/<br\s*\/?>/gu) ?? []).length, 3, `expected 3 line breaks, got: ${html}`);
  assert.match(html, /Host lyris/u);
  // And the flattening the user reported is what happens without it.
  const flattened = await render(pasted, false);
  assert.equal((flattened.match(/<br\s*\/?>/gu) ?? []).length, 0);
  // The newline survives into the HTML and collapses at render; a string assertion can show
  // the former but never the latter, so this pins the absence of a break, not the visual reflow.
  assert.match(flattened, /ssh config,\nHost lyris/u, "without the plugin the newline stays soft: no break tag");
});

test("hard breaks do not disturb markdown structure", async () => {
  // Paragraphs, lists and fenced code must survive: chat carries real markdown too.
  const html = await render("para one\n\npara two\n\n- a\n- b\n\n```js\nconst x = 1;\nconst y = 2;\n```", true);
  assert.equal((html.match(/<p>/gu) ?? []).length, 2, "blank-line paragraphs stay separate");
  assert.equal((html.match(/<li>/gu) ?? []).length, 2);
  // Critically, a fenced block must NOT gain <br> between its lines.
  const fence = /<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/u.exec(html)?.[1] ?? "";
  assert.doesNotMatch(fence, /<br/u, "code blocks must not gain line-break tags");
  assert.match(fence, /const x = 1;\nconst y = 2;/u, "code keeps its own newlines");
});

// Math is the interaction most likely to break: remark-breaks rewrites text nodes, and a
// display-math node carries a value rather than text children, so it must be untouched.
test("display math spanning lines is not broken up", async () => {
  const html = await render("before\n$$\na = b\n$$\nafter", true);
  assert.equal((html.match(/<br\s*\/?>/gu) ?? []).length, 0, `math must not gain break tags: ${html}`);
  assert.match(html, /katex/u, "and must still render as math, so the check is not vacuous");
});

test("a GFM table is unaffected by hard breaks", async () => {
  const table = "text above\n| a | b |\n| - | - |\n| 1 | 2 |";
  const withBreaks = await render(table, true);
  assert.match(withBreaks, /<table>/u, "the table must still parse");
  assert.equal((withBreaks.match(/<td>/gu) ?? []).length, 2);
});

test("a previewed markdown file keeps CommonMark semantics", async () => {
  const source = await import("node:fs/promises")
    .then((fs) => fs.readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8"));
  // Chat opts in explicitly; the file preview must not, or a document would render with breaks
  // its author never wrote.
  assert.match(source, /plugins=\{REMARK_CHAT_PLUGINS\}/u, "chat opts into hard breaks");
  const preview = /isMd && !srcMode \? <div className="md"><MarkdownBody[^/]*\/>/u.exec(source)?.[0] ?? "";
  assert.ok(preview.length > 0, "found the markdown preview render site");
  assert.doesNotMatch(preview, /REMARK_CHAT_PLUGINS/u, "the file preview must keep CommonMark");
  // The render() helper above replicates the app's plugin list; pin that it has not drifted.
  assert.match(source, /const REMARK_PLUGINS = \[remarkGfm, remarkMath, remarkFilePaths\];/u);
  assert.match(source, /const REMARK_CHAT_PLUGINS = \[\.\.\.REMARK_PLUGINS, remarkBreaks\];/u);
});
