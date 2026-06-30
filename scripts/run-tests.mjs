import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path));
    else if (entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

const explicit = process.argv.slice(2);
const files = explicit.length > 0 ? explicit : (await collect("tests")).sort();
const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
