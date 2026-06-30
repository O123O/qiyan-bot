import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";

const expected = "codex-cli 0.142.4";
const version = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
if (version !== expected) throw new Error(`Expected ${expected}, found ${version}`);

const generated = "src/app-server/generated";
const schemas = ".tmp/codex-app-server-schema";
await rm(generated, { recursive: true, force: true });
await rm(schemas, { recursive: true, force: true });
await mkdir(generated, { recursive: true });
await mkdir(schemas, { recursive: true });
execFileSync("codex", ["app-server", "generate-ts", "--out", generated], { stdio: "inherit" });
execFileSync("codex", ["app-server", "generate-json-schema", "--out", schemas], { stdio: "inherit" });

async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else result.push(path);
  }
  return result.sort();
}

const digest = createHash("sha256");
for (const path of await files(generated)) {
  digest.update(relative(generated, path));
  digest.update(await readFile(path));
}
await writeFile("src/app-server/protocol-manifest.json", `${JSON.stringify({ version, sha256: digest.digest("hex") }, null, 2)}\n`);
