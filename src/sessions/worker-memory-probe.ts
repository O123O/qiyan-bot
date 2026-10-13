// How a worker's memory is actually read, on whichever host the worker runs on.
//
// One shell program serves both: locally it is run under `bash -c`, remotely it is the same
// text sent over the endpoint's existing ControlMaster. Keeping a single implementation is
// what makes a local and a remote warning mean the same thing.
import { readFile, readdir } from "node:fs/promises";
import { AppError } from "../core/errors.ts";
import type { WorkerMemorySample } from "./worker-memory.ts";

// Sums RSS over the subtree rooted at $1 and prints `<usedKb> <limitKb>`.
//
// The limit is the nearest FINITE `memory.max` at or above the probe's own cgroup, falling
// back to MemTotal when nothing caps it. Walking up from the probe is right on both hosts: on
// the QiYan host nothing is capped, so it lands on total RAM; on a remote login node the ssh
// session scope sits under the same per-user slice that caps the worker, so it finds that cap.
//
// Prints nothing when the root pid is gone — an exited runtime is not a reading of zero.
export const MEMORY_PROBE_SCRIPT = `set -u
root=\${1:-0}
used=$(ps -eo pid=,ppid=,rss= 2>/dev/null | awk -v root="$root" '
{ p[NR]=$1+0; q[NR]=$2+0; r[NR]=$3+0; n=NR }
END {
  if (root+0 <= 0) exit 0
  want[root+0]=1
  changed=1
  while (changed) {
    changed=0
    for (i=1;i<=n;i++) if (!(p[i] in want) && (q[i] in want)) { want[p[i]]=1; changed=1 }
  }
  total=0; seen=0
  for (i=1;i<=n;i++) if (p[i] in want) { total+=r[i]; seen=1 }
  if (seen) print total
}')
[ -n "$used" ] || exit 1
limit=$(awk '/^MemTotal:/{print $2; exit}' /proc/meminfo 2>/dev/null)
[ -n "$limit" ] || exit 1
g=$(awk -F: '/^0::/{print $3; exit}' /proc/self/cgroup 2>/dev/null || true)
while [ -n "\${g:-}" ] && [ "$g" != "/" ]; do
  v=$(cat "/sys/fs/cgroup$g/memory.max" 2>/dev/null || true)
  case "\${v:-}" in
    ''|max) : ;;
    *) k=$((v / 1024)); if [ "$k" -gt 0 ] && [ "$k" -lt "$limit" ]; then limit=$k; fi ;;
  esac
  g=\${g%/*}
done
echo "$used $limit"`;

// The pid travels as $1 rather than being pasted into the program text, so nothing about a
// pid can ever be read as shell syntax. `sh -c <script> sh <pid>` sets $0 to "sh" and $1 to
// the pid, which is the portable way to pass arguments to an inline program.
function probeArgv(rootPid: number): readonly string[] {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new AppError("CONFIGURATION_ERROR", "invalid worker memory probe pid");
  return ["-c", MEMORY_PROBE_SCRIPT, "sh", String(rootPid)];
}

export function localMemoryProbeArgv(rootPid: number): readonly string[] { return probeArgv(rootPid); }

// One argv element for the remote login shell, quoted the same way every other opaque remote
// command here is. The script contains single quotes of its own (the awk program), which is
// exactly what this quoting style exists to survive.
export function remoteMemoryProbeCommand(rootPid: number): string {
  const argv = probeArgv(rootPid);
  return `sh ${argv.map(shellQuote).join(" ")}`;
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }

export function parseMemoryProbeOutput(stdout: string): WorkerMemorySample | undefined {
  const match = /(\d+)\s+(\d+)\s*$/u.exec(stdout.trim());
  if (!match) return undefined;
  const usedKb = Number(match[1]);
  const limitKb = Number(match[2]);
  if (!Number.isSafeInteger(usedKb) || !Number.isSafeInteger(limitKb) || limitKb <= 0) return undefined;
  return { usedBytes: usedKb * 1024, limitBytes: limitKb * 1024 };
}

export interface ProcessTreeReader {
  listPids(): Promise<number[]>;
  readParentPid(pid: number): Promise<number | undefined>;
  readCommandLine(pid: number): Promise<string | undefined>;
}

// Finds the process that IS a local worker, for hosts where no runtime identity carries a pid.
// A remote runtime reports its own pid, so this is only needed locally, where a Claude session
// is spawned inside the Agent SDK and its pid never surfaces to us.
//
// The session's thread id is the handle: QiYan resumes a session by it, so the id appears in
// the argv of the process that owns the session. The SHALLOWEST match wins — a command the
// worker itself runs may well mention its own thread id, and that command is always deeper
// than the process running it. No match returns undefined, and the caller then says nothing:
// a warning attributed to the wrong process tree is worse than no warning.
export async function findWorkerRootPid(
  rootPid: number,
  needle: string,
  reader: ProcessTreeReader,
): Promise<number | undefined> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || needle.length === 0) return undefined;
  const pids = await reader.listPids();
  const parents = new Map<number, number>();
  for (const pid of pids) {
    const parent = await reader.readParentPid(pid);
    if (parent !== undefined) parents.set(pid, parent);
  }
  // Depth from rootPid, for descendants only. An unrelated process has no depth and is skipped.
  const depthOf = (pid: number): number | undefined => {
    let depth = 0;
    let current = pid;
    const seen = new Set<number>([pid]);
    while (depth <= 64) {
      if (current === rootPid) return depth;
      const parent = parents.get(current);
      if (parent === undefined || parent <= 0 || seen.has(parent)) return undefined;
      seen.add(parent);
      current = parent;
      depth += 1;
    }
    return undefined;
  };
  let best: { pid: number; depth: number } | undefined;
  for (const pid of pids) {
    if (pid === rootPid) continue;
    const depth = depthOf(pid);
    if (depth === undefined) continue;
    if (best && depth > best.depth) continue;
    const commandLine = await reader.readCommandLine(pid);
    if (!commandLine || !commandLine.includes(needle)) continue;
    if (!best || depth < best.depth || (depth === best.depth && pid < best.pid)) best = { pid, depth };
  }
  return best?.pid;
}

export const procProcessTreeReader: ProcessTreeReader = {
  async listPids() {
    const entries = await readdir("/proc");
    const pids: number[] = [];
    for (const entry of entries) {
      if (!/^\d+$/u.test(entry)) continue;
      pids.push(Number(entry));
    }
    return pids;
  },
  async readParentPid(pid) {
    let text: string;
    try { text = await readFile(`/proc/${pid}/stat`, "utf8"); }
    catch { return undefined; }
    // The comm field is parenthesised and may itself contain spaces and parentheses, so the
    // fields after it are located from the LAST ')' rather than by splitting the whole line.
    const close = text.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = text.slice(close + 1).trim().split(/\s+/u);
    const parent = Number(fields[1]);
    return Number.isSafeInteger(parent) && parent > 0 ? parent : undefined;
  },
  async readCommandLine(pid) {
    try { return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " "); }
    catch { return undefined; }
  },
};

// A worker's memory on the QiYan host. The owning process is resolved every tick rather than
// cached: a local Claude session is re-spawned across restarts, and a cached pid would then
// measure either nothing or, worse, whatever process inherited the number.
export function createLocalWorkerMemorySampler(deps: {
  botPid: number;
  runLocal(argv: readonly string[]): Promise<string | undefined>;
  reader?: ProcessTreeReader;
}): (threadId: string) => Promise<WorkerMemorySample | undefined> {
  return async (threadId) => {
    const rootPid = await findWorkerRootPid(deps.botPid, threadId, deps.reader ?? procProcessTreeReader);
    if (rootPid === undefined) return undefined;
    const stdout = await deps.runLocal(localMemoryProbeArgv(rootPid));
    return stdout === undefined ? undefined : parseMemoryProbeOutput(stdout);
  };
}

// A worker's memory on its own machine, over the endpoint's existing ControlMaster.
//
// The runtime's pid is cached because reading it costs a round trip of its own (a full remote
// inspect) and it only changes when the runtime is replaced. A probe that comes back empty
// means the pid is gone, so the cache is dropped and re-read on the next tick — which is also
// what makes a restarted runtime pick itself up without anyone invalidating anything.
//
// One sample describes the whole endpoint: a Codex app-server hosts every thread on it, so its
// subtree is the memory of all of that endpoint's work, not of one session.
export function createRemoteWorkerMemorySampler(deps: {
  rootPid(): Promise<number | undefined>;
  runRemote(command: string): Promise<string | undefined>;
}): () => Promise<WorkerMemorySample | undefined> {
  let cached: number | undefined;
  return async () => {
    if (cached === undefined) cached = await deps.rootPid();
    if (cached === undefined) return undefined;
    const stdout = await deps.runRemote(remoteMemoryProbeCommand(cached));
    const sample = stdout === undefined ? undefined : parseMemoryProbeOutput(stdout);
    if (!sample) cached = undefined;
    return sample;
  };
}
