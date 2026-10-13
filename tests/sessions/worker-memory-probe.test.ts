import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_OWNER_DEPTH,
  MEMORY_PROBE_SCRIPT,
  createLocalWorkerMemorySampler,
  createRemoteWorkerMemorySampler,
  findWorkerRootPid,
  localMemoryProbeArgv,
  parseMemoryProbeOutput,
  remoteMemoryProbeCommand,
  type ProcessTreeReader,
} from "../../src/sessions/worker-memory-probe.ts";

test("reads the four figures the probe prints", () => {
  assert.deepEqual(parseMemoryProbeOutput("267372 263950616 263950616 61746224\n", "session"), {
    usedBytes: 267372 * 1024,
    limitBytes: 263950616 * 1024,
    scope: "session",
    hostTotalBytes: 263950616 * 1024,
    hostAvailableBytes: 61746224 * 1024,
  });
  // A MOTD or shell banner ahead of the reading must not break it.
  assert.equal(parseMemoryProbeOutput("Welcome to login01\n200928 4194304 790000000 700000000", "endpoint")?.scope, "endpoint");
});

test("a kernel that publishes no MemAvailable leaves host pressure unjudged rather than judged wrongly", () => {
  const parsed = parseMemoryProbeOutput("1024 4096 4096 -1\n", "session");
  assert.equal(parsed?.hostAvailableBytes, undefined);
  assert.equal(parsed?.hostTotalBytes, 4096 * 1024);
});

test("a probe that measured nothing is not read as a reading", () => {
  assert.equal(parseMemoryProbeOutput("", "session"), undefined);
  assert.equal(parseMemoryProbeOutput("bash: ps: command not found", "session"), undefined);
  assert.equal(parseMemoryProbeOutput("1024 0 4096 100", "session"), undefined, "a zero limit would make every share infinite");
  assert.equal(parseMemoryProbeOutput("1024 4096", "session"), undefined, "a short read is not a reading");
});

test("the pid travels as an argument, never inside the program text", () => {
  assert.deepEqual(localMemoryProbeArgv(4132046), ["-c", MEMORY_PROBE_SCRIPT, "sh", "4132046"]);
  assert.deepEqual(localMemoryProbeArgv(4132046, "36039580"), ["-c", MEMORY_PROBE_SCRIPT, "sh", "4132046", "36039580"]);
  assert.ok(!MEMORY_PROBE_SCRIPT.includes("4132046"));
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => localMemoryProbeArgv(bad), /invalid worker memory probe pid/u);
    assert.throws(() => remoteMemoryProbeCommand(bad), /invalid worker memory probe pid/u);
  }
  for (const bad of ["", "12; rm -rf /", "abc", "'"]) {
    assert.throws(() => localMemoryProbeArgv(10, bad), /invalid worker memory probe start time/u);
  }
});

test("the remote form survives the single quotes inside the awk programs", () => {
  const command = remoteMemoryProbeCommand(4132046, "36039580");
  assert.ok(command.startsWith("sh '-c' '"));
  assert.ok(command.endsWith("'sh' '4132046' '36039580'"));
  assert.ok(command.includes("'\\''"), "the script's own quotes are closed, escaped and reopened");
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
    { pid: 400, ppid: 300, cmd: `bash -c export CLAUDE_SESSION_ID='${thread}'` },
  ]);
  assert.equal(await findWorkerRootPid(100, thread, tree), 200);
});

// Without a depth bound, an idle session whose own CLI process is gone could be attributed the
// subtree of a DIFFERENT session's deep shell command that happened to echo its thread id.
test("a deep command mentioning another session's id is not taken for that session's runtime", async () => {
  const thread = "t-victim";
  const tree = reader([
    { pid: 100, ppid: 1, cmd: "node qiyan-bot" },
    { pid: 200, ppid: 100, cmd: "claude --resume=t-other" },
    { pid: 300, ppid: 200, cmd: "bash -c" },
    { pid: 400, ppid: 300, cmd: "bash -c" },
    { pid: 500, ppid: 400, cmd: `python analyse.py --session ${thread}` },
  ]);
  assert.equal(await findWorkerRootPid(100, thread, tree), undefined);
  assert.equal(MAX_OWNER_DEPTH, 3);
  // Raising the bound reaches it, which is what proves the bound is what excluded it.
  assert.equal(await findWorkerRootPid(100, thread, tree, 4), 500);
});

test("ignores a match that is not below the given root", async () => {
  const tree = reader([
    { pid: 100, ppid: 1, cmd: "node qiyan-bot" },
    { pid: 900, ppid: 1, cmd: "claude --resume=t-abc" },
  ]);
  assert.equal(await findWorkerRootPid(100, "t-abc", tree), undefined);
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
    runLocal: async (argv) => { seen.push(Number(argv[3])); return "1048576 2097152 2097152 1000000\n"; },
  });
  assert.equal((await sample("t-abc"))?.scope, "session");
  tree = [
    { pid: 100, ppid: 1, cmd: "node qiyan-bot" },
    { pid: 777, ppid: 100, cmd: "claude --resume=t-abc" },
  ];
  await sample("t-abc");
  assert.deepEqual(seen, [200, 777], "the re-spawned session is followed, not the dead pid");
});

test("the local sampler says nothing when no process owns the session", async () => {
  let ran = false;
  const sample = createLocalWorkerMemorySampler({
    botPid: 100,
    reader: { listPids: async () => [100], readParentPid: async () => 1, readCommandLine: async () => "node qiyan-bot" },
    runLocal: async () => { ran = true; return "1 2 3 4\n"; },
  });
  assert.equal(await sample("t-abc"), undefined);
  assert.equal(ran, false, "no probe is run when there is nothing to attribute it to");
});

test("the remote sampler reads the runtime identity once and carries its start time into the probe", async () => {
  const commands: string[] = [];
  let reads = 0;
  const sample = createRemoteWorkerMemorySampler({
    rootPid: async () => { reads += 1; return { pid: 4132046, startTime: "36039580" }; },
    runRemote: async (command) => { commands.push(command); return "200928 4194304 790000000 700000000\n"; },
  });
  assert.equal((await sample())?.scope, "endpoint");
  await sample();
  assert.equal(reads, 1, "a live runtime is not re-inspected every tick");
  // The start time is what stops a REUSED pid from reading as a valid measurement forever.
  assert.ok(commands.every((command) => command.endsWith("'4132046' '36039580'")));
});

test("the remote sampler re-reads the identity once the probe stops finding the runtime", async () => {
  const roots = [{ pid: 4132046, startTime: "1" }, { pid: 555, startTime: "2" }];
  let reads = 0;
  let output: string | undefined = "200928 4194304 790000000 700000000\n";
  const sample = createRemoteWorkerMemorySampler({
    rootPid: async () => roots[Math.min(reads++, roots.length - 1)],
    runRemote: async () => output,
  });
  await sample();
  output = "";
  assert.equal(await sample(), undefined);
  output = "300 4194304 790000000 700000000\n";
  assert.deepEqual((await sample())?.usedBytes, 300 * 1024);
  assert.equal(reads, 2, "the identity was re-read exactly once, after the probe stopped finding it");
});

// An unreachable host used to be re-inspected every tick, per session, each round trip
// bypassing the manager's own recovery notices and discarding the error.
test("an endpoint whose identity cannot be read is left alone for a while", async () => {
  let reads = 0;
  let clock = 0;
  const sample = createRemoteWorkerMemorySampler({
    rootPid: async () => { reads += 1; return undefined; },
    runRemote: async () => "1 2 3 4",
    now: () => clock,
    identityBackoffMs: 60_000,
  });
  assert.equal(await sample(), undefined);
  clock += 1000;
  assert.equal(await sample(), undefined);
  clock += 1000;
  assert.equal(await sample(), undefined);
  assert.equal(reads, 1, "the unreachable host is not hammered once a minute per session");
  clock += 60_000;
  assert.equal(await sample(), undefined);
  assert.equal(reads, 2, "it is retried once the backoff expires");
});

test("the remote sampler stays quiet when the runtime has no identity at all", async () => {
  let ran = false;
  const sample = createRemoteWorkerMemorySampler({
    rootPid: async () => undefined,
    runRemote: async () => { ran = true; return "1 2 3 4"; },
  });
  assert.equal(await sample(), undefined);
  assert.equal(ran, false);
});
