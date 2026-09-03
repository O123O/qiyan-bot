// What the browser puts on the clipboard for a selection is derived from layout, not from the
// text we were given. The viewer renders one CSS grid row per line, with `display:contents` on the
// row and a sticky gutter cell beside the code cell, and how an engine serialises that is its own
// business: Chromium reproduces the source exactly, others are free to drop the line breaks the
// boxes never contained, or to include gutter digits that `user-select:none` was supposed to hide.
// The result pastes as garbage, and none of it is visible in the rendered view.
//
// So the clipboard is not asked to reconstruct the source. `textContent` of the code cells IS the
// source -- it is the text highlight.js escaped, untouched by any CSS -- and joining the selected
// parts of those cells with "\n" reproduces what was selected, byte for byte, in every engine.
//
// Self-contained by design: no imports and no closure, so a test can ship this exact function into
// a real browser and exercise the code that runs in production rather than a copy of it.
export function selectedSourceText(container: Element, selection: Selection): string | undefined {
  if (selection.rangeCount === 0 || selection.isCollapsed) return undefined;
  const range = selection.getRangeAt(0);
  // A selection that merely passes through the viewer -- starting in the page and ending past it --
  // is not ours to rewrite; leaving it alone keeps the browser's own behaviour for everything else.
  if (!container.contains(range.commonAncestorContainer)) return undefined;

  const cells = Array.from(container.querySelectorAll(".code-text"));
  // The >5000-line path renders one block with no per-line cells and no gutter, so the selection
  // already covers nothing but source: its own text is the answer, and it still comes from
  // textContent rather than from layout.
  if (cells.length === 0) return range.cloneContents().textContent ?? undefined;

  const parts: string[] = [];
  for (const line of cells) {
    if (!range.intersectsNode(line)) continue;
    // The intersection of the selection with this one line: start at whichever comes later, end at
    // whichever comes earlier. Cloning the selection keeps its endpoints when they fall inside the
    // line, which is what makes a part-line drag copy exactly the characters under the cursor.
    const clamped = range.cloneRange();
    const whole = line.ownerDocument.createRange();
    whole.selectNodeContents(line);
    if (clamped.compareBoundaryPoints(Range.START_TO_START, whole) < 0) {
      clamped.setStart(whole.startContainer, whole.startOffset);
    }
    if (clamped.compareBoundaryPoints(Range.END_TO_END, whole) > 0) {
      clamped.setEnd(whole.endContainer, whole.endOffset);
    }
    // cloneContents, not toString: the fragment's textContent ignores CSS entirely, so indentation
    // survives regardless of white-space, and the gutter cannot contribute because it is a sibling
    // of this element rather than a descendant.
    parts.push(clamped.cloneContents().textContent ?? "");
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}
