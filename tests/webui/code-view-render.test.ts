import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { STYLES } from "../../webui-client/src/styles.ts";
import { splitHighlightedLines } from "../../webui-client/src/highlight-lines.ts";
import { selectedSourceText } from "../../webui-client/src/code-selection.ts";

// Rendered in a real browser, not resolved by hand. A hand-written specificity resolver stood
// here first and was worse than nothing: it modelled neither inheritance, nor descendant
// specificity, nor `:not()`, nor `overflow` -- so it reported this feature healthy while the
// palette's `.hljs{overflow-x:auto}` was silently killing the sticky gutter. Four separate
// cascade regressions shipped to the user; every one of them is visible to getComputedStyle
// and none of them to a substring match.
const chromium = await import("playwright-core").then((m) => m.chromium).catch(() => undefined);
// Drive whichever Chromium this machine already has rather than the exact build playwright-core
// would fetch, so the test needs no network and no browser download to run.
const executablePath = (() => {
  const root = join(homedir(), ".cache/ms-playwright");
  if (!existsSync(root)) return undefined;
  // Globbed, not a hardcoded list: pinning build numbers meant any other Chromium skipped the
  // ONLY test of this feature's CSS and reported a pass.
  return readdirSync(root).filter((entry) => entry.startsWith("chromium-")).sort().reverse()
    .flatMap((entry) => ["chrome-linux64/chrome", "chrome-linux/chrome"].map((bin) => join(root, entry, bin)))
    .find((path) => existsSync(path));
})();

// The exact DOM CodeView builds, so the assertions describe the shipped markup.
// Just the <pre>, for embedding in the real modal.
function viewerMarkup(text: string, lang?: string): string {
  const document_ = page(text, lang);
  return document_.slice(document_.indexOf("<pre class=\"code-view\">"), document_.indexOf("</pre>") + 6);
}

function modal(body: string): string {
  return `<!doctype html><html data-theme="dark"><head><style>${STYLES}</style></head><body>
    <div class="sheet"><div class="sheet-head">title</div><div class="sheet-body">${body}</div></div>
  </body></html>`;
}

function page(text: string, lang?: string): string {
  const highlighted = lang ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : escapeForTest(text);
  const lines = splitHighlightedLines(highlighted);
  const rows = lines.map((line, index) =>
    `<span class="code-line"><span class="code-gutter" aria-hidden="true">${index + 1}</span>`
    + `<span class="code-text">${line}</span></span>`).join("");
  const gutter = `${String(lines.length).length}ch`;
  return `<!doctype html><html data-theme="dark"><head><style>${STYLES}</style></head><body>
    <div class="sheet"><div class="sheet-body" style="height:400px;width:600px">
      <pre class="code-view"><code class="hljs code-lines" style="--gutter:${gutter}">${rows}</code></pre>
    </div></div>
    <div class="md"><pre><code class="hljs">fenced</code></pre></div>
  </body></html>`;
}
// highlight.js is a webui-client dependency, so it is resolved from there rather than the root.
const hljs = createRequire(new URL("../../webui-client/package.json", import.meta.url))("highlight.js");

const escapeForTest = (value: string): string =>
  value.replace(/[&<>]/gu, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

test("the file viewer renders correctly in a browser", { skip: chromium && executablePath ? false : "no local chromium available" }, async () => {
  const browser = await chromium!.launch({ executablePath: executablePath! });
  try {
    const view = await browser.newPage();
    // Enough lines that the gutter reserves several characters, which is where an exact width
    // (border-box, so padding eats the content box) makes the digits collide with the code.
    // A 4-line fixture reserves 1ch and hides that entirely.
    const wide = [`const short = 1;`, "x".repeat(400), ...Array.from({ length: 1200 }, (_, i) => `const line${i} = ${i};`)].join("\n") + "\n";
    await view.setContent(page(wide, "typescript"));

    // Evaluated as source: tsx compiles inner functions with an esbuild `__name` helper that
    // does not exist in the page, so the callbacks are sent as strings instead.
    const styles = await view.evaluate(`(() => {
      const pick = (el, names) => { const s = getComputedStyle(el); const out = {};
        for (const n of names) out[n] = s.getPropertyValue(n); return out; };
      return {
        code: pick(document.querySelector("code.code-lines"), ["display","overflow-x","background-color"]),
        gutter: pick(document.querySelector(".code-gutter"), ["white-space","word-break","position","user-select","background-color","opacity","width","min-width"]),
        text: pick(document.querySelector(".code-text"), ["white-space","word-break"]),
        fenced: pick(document.querySelector(".md code.hljs"), ["display","background-color"]),
      };
    })()`) as { code: Record<string,string>; gutter: Record<string,string>; text: Record<string,string>; fenced: Record<string,string> };

    // The grid must survive the palette rule that follows it in the sheet.
    assert.equal(styles.code.display, "grid", "the palette's display:block must not win");
    // The fourth property the palette sets, and the one that was missed: a scrollport here
    // makes the sticky gutter resolve against a box that never scrolls.
    assert.equal(styles.code["overflow-x"], "visible", "scrolling belongs to .code-view, not to the grid");
    // background:inherit resolved to transparent, silently dropping the code background.
    assert.notEqual(styles.code["background-color"], "rgba(0, 0, 0, 0)", "the viewer must keep a code background");
    assert.notEqual(styles.gutter["background-color"], "rgba(0, 0, 0, 0)", "code must not scroll through the numbers");
    // opacity fades the background too, so an opaque colour alone does not keep code from
    // showing through. background-color cannot see this; it has to be asserted directly.
    assert.equal(styles.gutter.opacity, "1", "a faded gutter lets code show through the numbers");

    assert.equal(styles.text["white-space"], "pre", "source must not soft-wrap");
    assert.equal(styles.gutter["white-space"], "pre", "a number must not break across lines");
    assert.equal(styles.gutter["word-break"], "normal");
    assert.equal(styles.gutter.position, "sticky");

    assert.match(String(styles.gutter["user-select"]), /none/u, "numbers must never land in copied code");

    // Markdown fenced code keeps the palette's own treatment.
    assert.equal(styles.fenced.display, "block");
    assert.notEqual(styles.fenced["background-color"], "rgba(0, 0, 0, 0)");

    // Geometry: the gutter has to stay put when a wide file scrolls sideways.
    const sticky = await view.evaluate(`(() => {
      const scroller = document.querySelector("pre.code-view");
      const gutter = document.querySelector(".code-gutter");
      const before = gutter.getBoundingClientRect().left;
      scroller.scrollLeft = 300;
      return { scrolled: scroller.scrollLeft, before, after: gutter.getBoundingClientRect().left };
    })()`) as { scrolled: number; before: number; after: number };
    assert.ok(sticky.scrolled > 0, "a long line must make the viewer scrollable");
    assert.ok(Math.abs(sticky.after - sticky.before) < 2,
      `the gutter must stay visible while scrolling (moved ${sticky.before} -> ${sticky.after})`);

    // A reserved minimum, never a cap. With box-sizing:border-box an exact width includes the
    // padding, so the digits get less room than they need and spill into the code. Asserted as
    // overflow rather than as a declaration, because that is the failure the user sees.
    const widest = await view.evaluate(`(() => {
      let worst = 0;
      for (const g of document.querySelectorAll(".code-gutter")) worst = Math.max(worst, g.scrollWidth - g.clientWidth);
      return worst;
    })()`) as number;
    assert.ok(widest <= 1, `line numbers must fit their column (overflowed by ${widest}px)`);

    // One number per rendered line, including under a multi-line comment and a lone CR.
    const rows = await view.evaluate(`(() => {
      const out = [];
      for (const line of document.querySelectorAll(".code-line")) {
        const cell = line.querySelector(".code-text");
        out.push({
          gutter: line.querySelector(".code-gutter").getBoundingClientRect().height,
          text: cell.getBoundingClientRect().height,
          overflow: cell.scrollHeight - cell.clientHeight,
        });
      }
      return out;
    })()`) as Array<{ gutter: number; text: number; overflow: number }>;
    // THIS is the assertion that detects a stray line break inside a fragment. Comparing the
    // two cells' heights cannot: `.code-line` is display:contents, so they are grid items in
    // one row and align-items:stretch makes them equal by construction. Nor can overflow: the
    // row simply grows to fit the second visual line. Only a uniform row height sees it.
    const oneLine = Math.min(...rows.map((row) => row.text));
    for (const [index, row] of rows.entries()) {
      assert.ok(Math.abs(row.text - oneLine) < 2,
        `row ${index + 1}: one source line must render as one visual line (${row.text}px vs ${oneLine}px)`);
    }

    // Selecting the view must yield the source, with no line numbers mixed in.
    const copied = await view.evaluate(`(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("code.code-lines"));
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    })()`) as string;
    // Every line, not just the first: numbers leaking on lines 2..N would pass a first-line check.
    assert.equal(copied.split("\n").length, wide.split("\n").length,
      "copied text must have exactly the source's line count");
    for (const [index, line] of copied.split("\n").entries()) {
      assert.doesNotMatch(line, /^\s*\d+\s*(const|x)/u, `line ${index + 1} was copied with its number: ${line.slice(0, 40)}`);
    }
    assert.match(copied, /const short = 1;/u);
    // (#1) Exactly one box may scroll. The previous sizing guessed the modal's chrome from
    // 100vh while the sheet is sized in 92vh, so above 1440p both the view and the body
    // scrolled. Measured in the real modal, at the height where that guess broke.
    for (const height of [900, 2160]) {
      await view.setViewportSize({ width: 1400, height });
      await view.setContent(modal(viewerMarkup(wide, "typescript")));
      const scroll = await view.evaluate(`(() => {
        const b = document.querySelector(".sheet-body"), v = document.querySelector(".code-view");
        return { body: b.scrollHeight - b.clientHeight, view: v.scrollHeight - v.clientHeight };
      })()`) as { body: number; view: number };
      assert.ok(scroll.view > 1, `a tall file must scroll the viewer at ${height}px`);
      assert.ok(scroll.body <= 1,
        `only one box may scroll at ${height}px (body overflowed by ${scroll.body}px)`);
    }

    // Opposite polarity, so nobody "fixes" the body scroll by giving every child min-height:0:
    // a tall markdown preview must still scroll the BODY, since only .code-view opts in.
    await view.setViewportSize({ width: 1400, height: 900 });
    await view.setContent(modal(`<div class="md">${"<p>paragraph</p>".repeat(400)}</div>`));
    const md = await view.evaluate(`(() => { const b = document.querySelector(".sheet-body");
      return b.scrollHeight - b.clientHeight; })()`) as number;
    assert.ok(md > 1, "a tall markdown preview must still scroll the sheet body");

    // (#3) Above the numbering cap the viewer falls back to one block, and that path must not
    // soft-wrap either -- this repo's own production-app.ts is over the cap.
    const wideLines = Array.from({ length: 30 }, (_, index) => "const wide" + index + " = " + "y".repeat(200) + ";").join("\n");
    await view.setContent(modal('<pre class="code-view"><code class="hljs">' + wideLines + "</code></pre>"));
    // The scrollbar's OWNER is pinned, not just its existence. Accepting either element blesses
    // the bug: on the inner <code> the bar sits at the bottom of the whole file rather than at
    // the bottom of the view, which on a 5,767-line file is ~107,000px out of reach.
    const fallback = await view.evaluate(`(() => {
      const v = document.querySelector(".code-view"), c = v.querySelector("code");
      return { whiteSpace: getComputedStyle(c).whiteSpace,
               hScroll: v.scrollWidth - v.clientWidth,
               rows: (() => { const cs = getComputedStyle(c);
                 const inner = c.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
                 return Math.round(inner / parseFloat(cs.lineHeight)); })() }; })()`) as { whiteSpace: string; hScroll: number; rows: number };
    assert.equal(fallback.whiteSpace, "pre", "the fallback path must not soft-wrap source");
    assert.ok(fallback.hScroll > 1, "the viewer itself must own the horizontal scroll, not the inner code element");
    // 30 source lines must occupy 30 rows. Wrapping showed up as ~198% of that.
    assert.equal(fallback.rows, 30, `wrapped fallback: 30 lines rendered as ${fallback.rows} rows`);
  } finally {
    await browser.close();
  }
});


// Copying is the one thing the rendered view cannot show you is broken: indentation that survives
// on screen can still be absent from the clipboard, because what a browser serialises out of a CSS
// grid with `display:contents` rows and a sticky gutter is engine-defined. The fix does not ask the
// browser -- it rebuilds the text from the code cells -- and this drives the SHIPPED function in a
// real engine rather than a reimplementation of it.
test("copying the viewer yields the original source, not what the layout serialises", { skip: chromium && executablePath ? false : "no local chromium available" }, async () => {
  const browser = await chromium!.launch({ executablePath: executablePath! });
  try {
    const view = await browser.newPage();
    // Tabs, deep indentation and a blank line: everything a whitespace-collapsing copy destroys.
    const source = "def solve(n):\n    total = 0\n\n    for i in range(n):\n\t\tdeep = 1\n    return total";
    await view.setContent(modal(viewerMarkup(source, "python")));
    const copied = await view.evaluate(({ fnSource, expected }: { fnSource: string; expected: string }) => {
      const selectedSourceText = new Function(`return (${fnSource})`)() as
        (container: Element, selection: Selection) => string | undefined;
      const code = document.querySelector(".code-lines")!;
      const selection = window.getSelection()!;
      const whole = document.createRange();
      whole.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(whole);
      const all = selectedSourceText(code, selection);

      // A part-line drag has to give exactly the characters under the cursor, since that is how a
      // snippet is usually taken out of a file.
      const cells = [...document.querySelectorAll(".code-text")];
      const partial = document.createRange();
      // End at the line element's own end, not at its last child: highlighting makes that child an
      // element, whose length property is undefined, which silently truncates the range.
      partial.setStart(cells[1]!.firstChild!, 4);
      partial.setEnd(cells[1]!, cells[1]!.childNodes.length);
      selection.removeAllRanges();
      selection.addRange(partial);
      const dragged = selectedSourceText(code, selection);

      // A selection that reaches outside the viewer stays the browser's to serialise; rewriting it
      // would corrupt copies of the surrounding page.
      const outside = document.createRange();
      outside.selectNodeContents(document.body);
      selection.removeAllRanges();
      selection.addRange(outside);
      return { all, dragged, foreign: selectedSourceText(code, selection), expected };
    }, { fnSource: selectedSourceText.toString(), expected: source });

    assert.equal(copied.all, source, "a whole-file copy must reproduce the source exactly");
    assert.ok(copied.all!.includes("\t\tdeep"), "tabs must survive the clipboard, not become spaces");
    assert.ok(copied.all!.includes("\n\n"), "a blank line is part of the source");
    assert.equal(copied.dragged, "total = 0", "a part-line drag copies exactly what was dragged");
    assert.equal(copied.foreign, undefined, "a selection beyond the viewer is left to the browser");
  } finally {
    await browser.close();
  }
});
