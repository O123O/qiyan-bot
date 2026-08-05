import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { joinFilesystemPath, markdownBaseDir, parentFilesystemPath, resolveMarkdownRef } from "../../webui-client/src/filesystem-path.ts";

test("filesystem paths stay absolute while navigating the QiYan explorer", () => {
  assert.equal(joinFilesystemPath("/home/user", "notes"), "/home/user/notes");
  assert.equal(joinFilesystemPath("/", "etc"), "/etc");
  assert.equal(parentFilesystemPath("/home/user"), "/home");
  assert.equal(parentFilesystemPath("/"), "/");
});

test("the QiYan tab loads the owner filesystem route and exposes a path field", async () => {
  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /\/api\/filesystem/u);
  assert.match(source, /placeholder="~\/ or absolute path"/u);
  assert.match(source, /Upload file/u);
  assert.match(source, /method: "PUT"/u);
  assert.match(source, /title="Download"/u);
});

test("markdown references resolve against the file that wrote them", () => {
  // A bare name sits at the project root, not the filesystem root.
  assert.equal(markdownBaseDir("README.md"), "");
  assert.equal(markdownBaseDir("docs/design.md"), "docs");
  assert.equal(markdownBaseDir("/home/user/notes.md"), "/home/user");

  // Relative refs are relative to the document, which is what a markdown author writes.
  assert.equal(resolveMarkdownRef("docs", "figs/flow.svg"), "docs/figs/flow.svg");
  assert.equal(resolveMarkdownRef("docs", "./figs/flow.svg"), "docs/figs/flow.svg");
  assert.equal(resolveMarkdownRef("docs/deep", "../figs/flow.svg"), "docs/figs/flow.svg");
  assert.equal(resolveMarkdownRef("", "flow.svg"), "flow.svg");

  // An absolute ref ignores the base entirely, and stays absolute.
  assert.equal(resolveMarkdownRef("docs", "/tmp/flow.svg"), "/tmp/flow.svg");
  assert.equal(resolveMarkdownRef("/home/user", "figs/a.png"), "/home/user/figs/a.png");
  assert.equal(resolveMarkdownRef("/home/user", "../shared/a.png"), "/home/shared/a.png");

  // Escaping the top is dropped rather than passed to a server that must reject it.
  assert.equal(resolveMarkdownRef("", "../../etc/passwd"), "etc/passwd");
});

test("markdown figures are served from the raw-file route rather than the SPA origin", async () => {
  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  // An img override must exist: without one react-markdown emits the author's path verbatim,
  // the browser resolves it against this origin, and every local figure renders broken.
  assert.match(source, /img: \(props: any\) =>/u);
  assert.match(source, /src=\{rawUrl\(path, session\)\}/u);
  // Remote and data-URI images must never reach the resolver: joining "https://..." to a
  // base directory produces a path no host has, so a badge or hosted figure would break.
  assert.match(source, /if \(!isLocalHref\(src\)\) return <img \{\.\.\.props\}/u);
  // Resolved against the document's own directory, not the project root.
  assert.match(source, /mdComponentsFor\(preview\.session \?\? null, markdownBaseDir\(/u);
  const styles = await readFile(new URL("../../webui-client/src/styles.ts", import.meta.url), "utf8");
  assert.match(styles, /\.md img\.md-img/u);
});
