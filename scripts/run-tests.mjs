import { mkdir, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

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
// Node's test runner arms `--report-signal=SIGUSR2` in every test child, so a suite that
// exercises a real SIGUSR2 handler drops a ~40 KB diagnostic dump — full environment
// block, absolute paths, pids — into the cwd, i.e. the repository root. Park those in
// .tmp/ so a routine `git add` cannot sweep them into a commit.
const reportDirectory = resolve("./.tmp/node-reports");
await mkdir(reportDirectory, { recursive: true });
const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=8", ...files], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --report-directory=${reportDirectory}`.trim(),
  },
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
