import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const historyRoot = resolve(root, "docs", "superpowers");
const retiredRole = ["coor", "dinator"].join("");
const retiredSandbox = ["SAND", "BOX_MODE"].join("");
const retired = [
  ["codex", "-chat-bot"].join(""),
  ["codex", "-bot"].join(""),
  [".", "codex", "-bot"].join(""),
  ["Codex", " Chat Bot"].join(""),
  ["codex", "_chat_bot"].join(""),
  ["COOR", "DINATOR", "_"].join(""),
  ["CODEX", "_BOT_"].join(""),
  [retiredRole, "-local"].join(""),
  ["codex", "_bot_manager"].join(""),
  ["codex", "bot"].join(""),
  ["Codex", " bot"].join(""),
];

test("active source and documentation use only the QiYan identity", async () => {
  const paths = await activeFiles();
  const failures: string[] = [];
  for (const path of paths) {
    const name = relative(root, path);
    inspect(name, name, failures);
    inspect(name, await readFile(path, "utf8"), failures);
  }
  assert.deepEqual(failures, []);

  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<string, unknown>;
  assert.equal(manifest.name, "qiyan-bot");
  assert.equal(manifest.version, "0.2.0");
  assert.deepEqual(manifest.bin, { "qiyan-bot": "dist/qiyan-bot" });
});

function inspect(name: string, content: string, failures: string[]): void {
  const lowered = content.toLowerCase();
  if (lowered.includes(retiredRole)) failures.push(`${name}: retired role`);
  for (const value of retired) {
    if (content.includes(value)) failures.push(`${name}: ${value}`);
  }
  const environmentNames: string[] = content.match(/[A-Z][A-Z0-9_]+/gu) ?? [];
  if (environmentNames.includes(retiredSandbox)) failures.push(`${name}: retired sandbox variable`);
}

async function activeFiles(): Promise<string[]> {
  const entries = [
    "src", "assets", "tests", "scripts", ".github", ".env.example", "package.json", "package-lock.json", "README.md", "docs",
  ];
  const paths = new Array<string>();
  for (const entry of entries) paths.push(...await collect(resolve(root, entry)));
  return paths.filter((path) => !path.startsWith(`${historyRoot}/`));
}

async function collect(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) return [path];
  const paths = new Array<string>();
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) paths.push(...await collect(child));
    else if (entry.isFile()) paths.push(child);
  }
  return paths;
}
