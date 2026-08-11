import assert from "node:assert/strict";
import test from "node:test";
import { STYLES } from "../../webui-client/src/styles.ts";

// A real cascade resolution, not a substring match. The file viewer shipped broken twice
// because `.code-lines { display:grid }` sits earlier in this sheet than the highlight.js
// palette's `.hljs { display:block }`, and the two have equal specificity — so `block` won and
// every line laid out inline, rendering the entire file on one line. Asserting that the grid
// rule merely *exists* would have passed in exactly that state, so this computes the winner.

interface Rule { selector: string; declarations: string; order: number }

function parseRules(sheet: string): Rule[] {
  const rules: Rule[] = [];
  // Comments carry selector-shaped text; strip them so they cannot be parsed as rules.
  const withoutComments = sheet.replace(/\/\*[\s\S]*?\*\//gu, "");
  const pattern = /([^{}]+)\{([^{}]*)\}/gu;
  let match: RegExpExecArray | null;
  let order = 0;
  while ((match = pattern.exec(withoutComments)) !== null) {
    for (const selector of match[1]!.split(",")) {
      const trimmed = selector.trim();
      if (trimmed && !trimmed.startsWith("@")) rules.push({ selector: trimmed, declarations: match[2]!, order });
    }
    order += 1;
  }
  return rules;
}

// (ids, classes, elements) — enough for the simple selectors this sheet uses.
function specificity(selector: string): [number, number, number] {
  const last = selector.split(/\s+/u).at(-1) ?? selector;
  return [
    (last.match(/#[\w-]+/gu) ?? []).length,
    (last.match(/\.[\w-]+/gu) ?? []).length + (last.match(/:[\w-]+/gu) ?? []).length,
    /^[a-z]/iu.test(last) ? 1 : 0,
  ];
}

function matches(selector: string, tag: string, classes: readonly string[]): boolean {
  const last = selector.split(/\s+/u).at(-1) ?? selector;
  const wantedTag = /^[a-z][\w-]*/iu.exec(last)?.[0];
  if (wantedTag && wantedTag !== tag) return false;
  return (last.match(/\.[\w-]+/gu) ?? []).every((name) => classes.includes(name.slice(1)));
}

function winningValue(property: string, tag: string, classes: readonly string[]): string | undefined {
  const candidates = parseRules(STYLES)
    .filter((rule) => matches(rule.selector, tag, classes))
    .filter((rule) => new RegExp(`(^|;)\\s*${property}\\s*:`, "u").test(rule.declarations))
    .sort((a, b) => {
      const sa = specificity(a.selector), sb = specificity(b.selector);
      for (let i = 0; i < 3; i += 1) if (sa[i]! !== sb[i]!) return sa[i]! - sb[i]!;
      return a.order - b.order; // later wins at equal specificity — the bug this pins
    });
  const winner = candidates.at(-1);
  return winner && new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "u").exec(winner.declarations)?.[1]?.trim();
}

test("the file viewer's line grid survives the highlight.js palette", () => {
  // <code class="hljs code-lines"> — exactly what CodeView renders.
  assert.equal(winningValue("display", "code", ["hljs", "code-lines"]), "grid",
    "the palette's .hljs{display:block} must not win, or every line lays out inline");
});

test("source lines in the viewer do not soft-wrap", () => {
  // <span class="code-text"> inside .code-view, which .sheet-body pre would otherwise wrap.
  assert.equal(winningValue("white-space", "span", ["code-text"]), "pre",
    "wrapped lines break the one-line-one-number correspondence the gutter promises");
});

test("a plain markdown code block is left alone by the viewer rules", () => {
  // <code class="hljs"> with no code-lines: still the palette's block display.
  assert.equal(winningValue("display", "code", ["hljs"]), "block");
});
