// Split highlight.js output into one HTML fragment per source line.
//
// The obvious approach — `html.split("\n")` — corrupts the markup, because a highlighted span
// routinely crosses lines: a block comment, a template literal, a multi-line string. Splitting
// naively leaves an unclosed `<span>` on one line and a stray `</span>` on the next, and the
// browser then reflows the rest of the file inside that colour.
//
// So the open spans are tracked: at a newline every one is closed, and the next line reopens
// them in the same order. Each fragment is therefore independently well-formed, which is what
// lets every line be its own element — and that is what keeps a line-number gutter aligned
// when a long line wraps, since the number sits beside a row rather than at a fixed offset.
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = "";
  let index = 0;

  const breakLine = (): void => {
    lines.push(current + "</span>".repeat(open.length));
    current = open.join("");
  };
  const addText = (text: string): void => {
    const pieces = text.split("\n");
    for (let position = 0; position < pieces.length; position += 1) {
      if (position > 0) breakLine();
      current += pieces[position];
    }
  };

  while (index < html.length) {
    const next = html.indexOf("<", index);
    if (next < 0) { addText(html.slice(index)); break; }
    if (next > index) addText(html.slice(index, next));
    const close = html.indexOf(">", next);
    // An unterminated tag is not markup highlight.js produced. Treat the remainder as text
    // rather than guessing, so malformed input degrades to plain output, never scrambled.
    if (close < 0) { addText(html.slice(next)); break; }
    const tag = html.slice(next, close + 1);
    if (tag.startsWith("</")) open.pop();
    else if (!tag.endsWith("/>")) open.push(tag);
    current += tag;
    index = close + 1;
  }
  lines.push(current + "</span>".repeat(open.length));
  return lines;
}
