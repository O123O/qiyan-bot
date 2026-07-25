import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";

async function typescriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat();
}

test("production Codex paths never request thread/read", async () => {
  const files = (await typescriptFiles("src")).filter((path) =>
    !path.includes(`${join("src", "app-server", "generated")}${process.platform === "win32" ? "\\" : "/"}`)
    && path !== join("src", "endpoints", "claude-runtime.ts"));
  const offenders: string[] = [];
  for (const path of files) {
    const source = await readFile(path, "utf8");
    if (/["']thread\/read["']/u.test(source)) offenders.push(relative(".", path));
  }
  assert.deepEqual(offenders, []);
});
