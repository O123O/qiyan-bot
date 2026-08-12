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
  // The browser test builds its own DOM, so it cannot see whether the app actually routes your
  // messages to the verbatim branch. Without this, deleting that branch passes everything.
  assert.match(source, /m\.role === "you"\s*\n?\s*\? <div className="verbatim">\{m\.body\}<\/div>/u,
    "your own messages must render verbatim, not through markdown");
  assert.match(source, /: <div className="md"><MarkdownBody/u, "replies must still render markdown");
  // The render() helper above replicates the app's plugin list; pin that it has not drifted.
  assert.match(source, /const REMARK_PLUGINS = \[remarkGfm, remarkMath, remarkFilePaths\];/u);
  assert.match(source, /const REMARK_CHAT_PLUGINS = \[\.\.\.REMARK_PLUGINS, remarkBreaks\];/u);
});

// Your own messages render verbatim. Markdown is what stripped the indentation: CommonMark
// drops leading whitespace on a continuation line before any renderer sees it, so a pasted
// config arrived flush left. These assert the bytes survive AND that copying gives back real
// spaces -- an &nbsp; workaround would look right and paste broken into a terminal.
const chromium = await import("playwright-core").then((m) => m.chromium).catch(() => undefined);
const browserPath = (() => {
  const { existsSync, readdirSync } = require_("node:fs") as typeof import("node:fs");
  const { homedir } = require_("node:os") as typeof import("node:os");
  const { join } = require_("node:path") as typeof import("node:path");
  const root = join(homedir(), ".cache/ms-playwright");
  if (!existsSync(root)) return undefined;
  return readdirSync(root).filter((entry: string) => entry.startsWith("chromium-")).sort().reverse()
    .flatMap((entry: string) => ["chrome-linux64/chrome", "chrome-linux/chrome"].map((bin) => join(root, entry, bin)))
    .find((path: string) => existsSync(path));
})();

test("a pasted message keeps its exact spacing, and copies back as real spaces",
  { skip: chromium && browserPath ? false : "no local chromium available" }, async () => {
  const { STYLES } = await import("../../webui-client/src/styles.ts");
  const config = "add this to the ssh config,\nHost lyris\n  HostName login.example.com\n  User someone\ntrailing  double  spaces";
  const browser = await chromium!.launch({ executablePath: browserPath! });
  try {
    const view = await browser.newPage();
    const escaped = config.replace(/[&<>]/gu, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
    await view.setContent(`<!doctype html><html data-theme="dark"><head><style>${STYLES}</style></head>
      <body><div class="msg you"><div class="verbatim">${escaped}</div></div></body></html>`);

    const rendered = await view.evaluate(`(() => {
      const el = document.querySelector(".verbatim");
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      // Measured against a one-line control: line-height computes to "normal" here, so
      // dividing by it yields NaN and the assertion would silently never fail.
      const control = document.createElement("div");
      control.className = "verbatim";
      control.textContent = "one line";
      el.parentElement.appendChild(control);
      const lines = el.getBoundingClientRect().height / control.getBoundingClientRect().height;
      control.remove();
      return { text: el.textContent, copied: selection.toString(),
               whiteSpace: getComputedStyle(el).whiteSpace, lines };
    })()`) as { text: string; copied: string; whiteSpace: string; lines: number };

    assert.equal(rendered.whiteSpace, "pre-wrap", "spaces and newlines must both be preserved");
    assert.equal(rendered.text, config, "the DOM must hold the message byte for byte");
    // The indentation the markdown parser used to eat.
    assert.match(rendered.text, /\n {2}HostName/u, "leading indentation must survive");
    assert.match(rendered.text, /trailing {2}double {2}spaces/u, "interior runs of spaces must survive");
    // Real U+0020, not U+00A0: a non-breaking space looks identical and pastes broken.
    assert.doesNotMatch(rendered.copied, / /u, "copied text must contain no non-breaking spaces");
    assert.equal(rendered.copied.replace(/\r/gu, ""), config, "copying must return the original text");
    assert.ok(rendered.lines >= 5, `all five lines must render (measured ${rendered.lines})`);
  } finally {
    await browser.close();
  }
});
