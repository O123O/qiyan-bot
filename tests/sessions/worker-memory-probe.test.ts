import assert from "node:assert/strict";
import test from "node:test";
import {
  MEMORY_PROBE_SCRIPT,
  createLocalWorkerMemorySampler,
  createRemoteWorkerMemorySampler,
  findWorkerRootPid,
  localMemoryProbeArgv,
  remoteMemoryProbeCommand,
  parseMemoryProbeOutput,
  type ProcessTreeReader,
} from "../../src/sessions/worker-memory-probe.ts";

test("reads the two figures the probe prints", () => {
  assert.deepEqual(parseMemoryProbeOutput("267372 263950616\n"), { usedBytes: 267372 * 1024, limitBytes: 263950616 * 1024 });
  assert.deepEqual(parseMemoryProbeOutput("  200928 4194304  "), { usedBytes: 200928 * 1024, limitBytes: 4194304 * 1024 });
});

test("a probe that measured nothing is not read as a reading", () => {
  // The probe prints nothing and exits non-zero when the root pid is gone; a host whose shell
  // printed a warning instead must not be mistaken for a measurement either.
  assert.equal(parseMemoryProbeOutput(""), undefined);
  assert.equal(parseMemoryProbeOutput("bash: ps: command not found"), undefined);
  assert.equal(parseMemoryProbeOutput("1024 0"), undefined, "a zero limit would make every share infinite");
});

test("the pid travels as an argument, never inside the program text", () => {
  const argv = localMemoryProbeArgv(4132046);
  assert.deepEqual(argv, ["-c", MEMORY_PROBE_SCRIPT, "sh", "4132046"]);
  assert.ok(!MEMORY_PROBE_SCRIPT.includes("4132046"));
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => localMemoryProbeArgv(bad), /invalid worker memory probe pid/u);
    assert.throws(() => remoteMemoryProbeCommand(bad), /invalid worker memory probe pid/u);
  }
});

test("the remote form survives the single quotes inside the awk program", () => {
  const command = remoteMemoryProbeCommand(4132046);
  assert.ok(command.startsWith("sh '-c' '"));
  assert.ok(command.endsWith("'sh' '4132046'"));
  // Every one of the script's own quotes is closed, reopened and escaped rather than ending
  // the quoted argument early.
  assert.equal(command.includes("'\\''"), true);
});

function reader(tree: { pid: number; ppid: number; cmd: string }[]): ProcessTreeReader {
  return {
    listPids: async () => tree.map((row) => row.pid),
    readParentPid: async (pid) => tree.find((row) => row.pid === pid)?.ppid,
    readCommandLine: async (pid) => tree.find((row) => row.pid === pid)?.cmd,
  };
}

test("finds the process that owns the session, not a command that merely mentions it", async () => {
  const thread = "e4a62341-3fad-4030-a85d-efba49903647";
  const tree = reader([
    { pid: 100, ppid: 1, cmd: "node qiyan-bot" },
    { pid: 200, ppid: 100, cmd: `claude --resume=${thread}` },
    { pid: 300, ppid: 200, cmd: "bash -c" },
    // A worker's own shell exporting its session id — deeper, so it must lose.
    { pid: 400, ppid: 300, cmd: `bash -c export CLAUDE_SESSION_ID='${thread}'` },
  ]);
  assert.equal(await findWorkerRootPid(100, thread, tree), 200);
});

test("ignores a match that is not below the given root", async () => {
  const thread = "t-abc";
  const tree = reader([
    { pid: 100, ppid: 1, cmd: "node qiyan-bot" },
    { pid: 900, ppid: 1, cmd: `claude --resume=${thread}` },
  ]);
  assert.equal(await findWorkerRootPid(100, thread, tree), undefined);
});

test("says nothing rather than guessing when no process carries the session", async () => {
  const tree = reader([
    { pid: 100, ppid: 1, cmd: "node qiyan-bot" },
    { pid: 200, ppid: 100, cmd: "claude --resume=someone-else" },
  ]);
  assert.equal(await findWorkerRootPid(100, "t-abc", tree), undefined);
  assert.equal(await findWorkerRootPid(100, "", tree), undefined);
  assert.equal(await findWorkerRootPid(0, "t-abc", tree), undefined);
});

test("a parent cycle in the table cannot hang the walk", async () => {
  const tree = reader([
    { pid: 100, ppid: 1, cmd: "node qiyan-bot" },
    { pid: 200, ppid: 300, cmd: "claude --resume=t-abc" },
    { pid: 300, ppid: 200, cmd: "loop" },
  ]);
  assert.equal(await findWorkerRootPid(100, "t-abc", tree), undefined);
});

test("the shallowest match wins when two sit at different depths", async () => {
  const tree = reader([
    { pid: 100, ppid: 1, cmd: "root" },
    { pid: 500, ppid: 100, cmd: "wrapper t-abc" },
    { pid: 200, ppid: 500, cmd: "claude t-abc" },
  ]);
  assert.equal(await findWorkerRootPid(100, "t-abc", tree), 500);
});

test("the local sampler resolves the owning process every tick", async () => {
  const seen: number[] = [];
  let tree = [
    { pid: 100, ppid: 1, cmd: "node qiyan-bot" },
    { pid: 200, ppid: 100, cmd: "claude --resume=t-abc" },
  ];
  const sample = createLocalWorkerMemorySampler({
    botPid: 100,
    reader: {
      listPids: async () => tree.map((row) => row.pid),
      readParentPid: async (pid) => tree.find((row) => row.pid === pid)?.ppid,
      readCommandLine: async (pid) => tree.find((row) => row.pid === pid)?.cmd,
    },
    runLocal: async (argv) => { seen.push(Number(argv[3])); return "1048576 2097152\n"; },
  });
  assert.deepEqual(await sample("t-abc"), { usedBytes: 1048576 * 1024, limitBytes: 2097152 * 1024 });
  // The session is re-spawned under a new pid; the next tick must follow it, not the old one.
  tree = [
    { pid: 100, ppid: 1, cmd: "node qiyan-bot" },
    { pid: 777, ppid: 100, cmd: "claude --resume=t-abc" },
  ];
  await sample("t-abc");
  assert.deepEqual(seen, [200, 777]);
});

test("the local sampler says nothing when no process owns the session", async () => {
  let ran = false;
  const sample = createLocalWorkerMemorySampler({
    botPid: 100,
    reader: { listPids: async () => [100], readParentPid: async () => 1, readCommandLine: async () => "node qiyan-bot" },
    runLocal: async () => { ran = true; return "1 2\n"; },
  });
  assert.equal(await sample("t-abc"), undefined);
  assert.equal(ran, false, "no probe is run when there is nothing to attribute it to");
});

test("the remote sampler reads the runtime pid once and re-reads it when the runtime is gone", async () => {
  const pids = [4132046, 555];
  let reads = 0;
  let output: string | undefined = "200928 4194304\n";
  const sample = createRemoteWorkerMemorySampler({
    rootPid: async () => pids[Math.min(reads++, pids.length - 1)],
    runRemote: async () => output,
  });
  assert.deepEqual(await sample(), { usedBytes: 200928 * 1024, limitBytes: 4194304 * 1024 });
  await sample();
  assert.equal(reads, 1, "a live runtime is not re-inspected every tick");
  output = "";
  assert.equal(await sample(), undefined);
  output = "300 4194304\n";
  assert.deepEqual(await sample(), { usedBytes: 300 * 1024, limitBytes: 4194304 * 1024 });
  assert.equal(reads, 2, "the pid was re-read exactly once, after the probe stopped finding it");
});

test("the remote sampler stays quiet when the runtime has no identity at all", async () => {
  let ran = false;
  const sample = createRemoteWorkerMemorySampler({
    rootPid: async () => undefined,
    runRemote: async () => { ran = true; return "1 2"; },
  });
  assert.equal(await sample(), undefined);
  assert.equal(ran, false);
});
