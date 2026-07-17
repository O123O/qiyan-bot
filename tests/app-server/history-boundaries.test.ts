import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("automatic recovery has no unbounded full-thread reads", async () => {
  const matches: string[] = [];
  for (const path of await sourceFiles("src")) {
    const lines = (await readFile(path, "utf8")).split("\n");
    lines.forEach((line) => {
      if (line.includes("includeTurns: true")) matches.push(path);
    });
  }

  assert.deepEqual(matches, [
    "src/app-server/pool.ts", // Explicit interactive full-history API.
  ]);
});
