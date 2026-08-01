import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const reportPattern = /^report\..+\.json$/u;

const reportsIn = async (directory: string): Promise<string[]> =>
  (await readdir(directory).catch(() => [] as string[])).filter((name) => reportPattern.test(name));

// Node's test runner arms `--report-signal=SIGUSR2` in every test child, so any suite that
// exercises a real SIGUSR2 handler writes a diagnostic dump — the developer's full
// environment block, absolute paths and pids — into the runner's cwd. That is the
// repository root, which is how 27 of them once ended up committed. Drive the one suite
// that raises the signal, with the inherited redirect scrubbed so the runner has to
// establish it itself, and require the root to stay clean.
test("the test runner keeps signal-triggered diagnostic dumps out of the repository root", async (t) => {
  const reportDirectory = join(process.cwd(), ".tmp", "node-reports");
  const before = new Set(await reportsIn(reportDirectory));
  const scratch = await mkdtemp(join(tmpdir(), "qiyan-run-tests-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  // A --report-directory inherited from the outer runner would satisfy the assertion
  // without run-tests.mjs doing anything, and NODE_TEST_CONTEXT would make the nested
  // runner skip its files outright. TMPDIR keeps the nested suite's scratch out of the
  // shared one.
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: "", TMPDIR: scratch };
  delete env.NODE_TEST_CONTEXT;
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/run-tests.mjs", "tests/webui/webui-signal.test.ts"], {
      stdio: ["ignore", "ignore", "ignore"],
      env,
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  assert.equal(exitCode, 0, "the signal suite must actually run for this assertion to mean anything");

  assert.deepEqual(await reportsIn(process.cwd()), [],
    "a signal-triggered node report landed in the repository root");
  assert.ok((await reportsIn(reportDirectory)).length > before.size,
    "the signal suite produced a dump, redirected into .tmp/");
});

test("a stray diagnostic dump is ignored rather than committable", async () => {
  const ignore = await readFile(".gitignore", "utf8");
  assert.match(ignore, /^report\.\*\.json$/mu);
});
