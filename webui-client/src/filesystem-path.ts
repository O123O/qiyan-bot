export function joinFilesystemPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent.replace(/\/+$/u, "")}/${name}`;
}

export function parentFilesystemPath(path: string): string {
  const normalized = path.replace(/\/+$/u, "") || "/";
  if (normalized === "/") return "/";
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? "/" : normalized.slice(0, slash);
}

// The directory a markdown file's relative references resolve against. Distinct from
// parentFilesystemPath, which answers "/" for a bare name: a session-relative "README.md"
// sits at the project root, and resolving its images against the FILESYSTEM root would send
// every one of them somewhere the project never was.
export function markdownBaseDir(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return "";
  return slash === 0 ? "/" : path.slice(0, slash);
}

// Resolve a reference written inside a markdown file — an image src or a link href — against
// the directory holding that file. Absolute references are taken as written; relative ones
// are joined and then collapsed, so "../figs/a.png" beside docs/design.md reaches figs/a.png
// rather than a literal path no filesystem has.
export function resolveMarkdownRef(baseDir: string, ref: string): string {
  const absolute = ref.startsWith("/");
  const base = absolute ? "" : baseDir.replace(/\/+$/u, "");
  const joined = absolute || !base ? ref : `${base}/${ref}`;
  const rooted = joined.startsWith("/");
  const out: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    // A ".." that escapes the top is dropped rather than kept: it cannot be resolved here,
    // and keeping it would hand the server a path it must reject anyway.
    if (segment === "..") { if (out.length > 0 && out[out.length - 1] !== "..") out.pop(); continue; }
    out.push(segment);
  }
  return (rooted ? "/" : "") + out.join("/");
}
