// How a worker's memory is actually read, on whichever host the worker runs on.
//
// One shell program serves both: locally it is run under `sh`, remotely it is the same text
// sent over the endpoint's existing ControlMaster. Keeping a single implementation is what
// makes a local and a remote warning mean the same thing.
import { readFile, readdir } from "node:fs/promises";
import { AppError } from "../core/errors.ts";
import type { MemoryScope, WorkerMemorySample } from "./worker-memory.ts";

// Sums RSS over the subtree rooted at $1 and prints `<usedKb> <limitKb> <memTotalKb> <memAvailableKb>`.
//
// $2, when given, is the root's expected start time (field 22 of /proc/pid/stat). A pid alone
// is not an identity: login nodes churn pids, and a reused one would otherwise be measured as
// though the dead runtime were still there, forever, because the reading would keep succeeding.
//
// The limit is the nearest FINITE cgroup limit at or above the probe's own cgroup, under both
// hierarchy versions, falling back to MemTotal when nothing caps it. Walking up from the probe
// is right on both hosts: on the QiYan host nothing is capped, so it lands on total RAM; on a
// remote login node the ssh session scope sits under the same per-user slice that caps the
// worker, so it finds that cap. Both the v2 and the v1 pass run unconditionally and the
// smallest finite limit wins — under a hybrid mount the unified hierarchy carries no memory
// controller, and only the v1 pass can see the cap.
//
// MemAvailable is reported as -1 rather than omitted when the kernel does not publish it, so
// the output always has four fields and a short read is never mistaken for a reading.
//
// Prints nothing when the root pid is gone or is not the expected process — an exited runtime
// is not a reading of zero.
export const MEMORY_PROBE_SCRIPT = `set -u
root=\${1:-0}
expect=\${2:-}
if [ -n "$expect" ]; then
  started=$(sed -e 's/^[0-9][0-9]* (.*) //' "/proc/$root/stat" 2>/dev/null | awk '{print $20}')
  [ "\${started:-}" = "$expect" ] || exit 1
fi
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
memtotal=$(awk '/^MemTotal:/{print $2; exit}' /proc/meminfo 2>/dev/null)
[ -n "\${memtotal:-}" ] || exit 1
memavailable=$(awk '/^MemAvailable:/{print $2; exit}' /proc/meminfo 2>/dev/null)
[ -n "\${memavailable:-}" ] || memavailable=-1
limit=$memtotal
g=$(awk -F: '/^0::/{print $3; exit}' /proc/self/cgroup 2>/dev/null || true)
while [ -n "\${g:-}" ] && [ "$g" != "/" ]; do
  for base in /sys/fs/cgroup /sys/fs/cgroup/unified; do
    v=$(cat "$base$g/memory.max" 2>/dev/null || true)
    case "\${v:-}" in
      ''|max) : ;;
      *) k=$((v / 1024)); if [ "$k" -gt 0 ] && [ "$k" -lt "$limit" ]; then limit=$k; fi ;;
    esac
  done
  g=\${g%/*}
done
m=$(awk -F: '$2 ~ /(^|,)memory(,|$)/ {print $3; exit}' /proc/self/cgroup 2>/dev/null || true)
while [ -n "\${m:-}" ] && [ "$m" != "/" ]; do
  v=$(cat "/sys/fs/cgroup/memory$m/memory.limit_in_bytes" 2>/dev/null || true)
  case "\${v:-}" in
    '') : ;;
    *) k=$((v / 1024)); if [ "$k" -gt 0 ] && [ "$k" -lt "$limit" ]; then limit=$k; fi ;;
  esac
  m=\${m%/*}
done
echo "$used $limit $memtotal $memavailable"`;

// The pid travels as $1 rather than being pasted into the program text, so nothing about a pid
// can ever be read as shell syntax. `sh -c <script> sh <pid> [<startTime>]` sets $0 to "sh",
// which is the portable way to pass arguments to an inline program.
function probeArgv(rootPid: number, startTime?: string): readonly string[] {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new AppError("CONFIGURATION_ERROR", "invalid worker memory probe pid");
  if (startTime !== undefined && !/^\d{1,20}$/u.test(startTime)) throw new AppError("CONFIGURATION_ERROR", "invalid worker memory probe start time");
  const argv = ["-c", MEMORY_PROBE_SCRIPT, "sh", String(rootPid)];
  return startTime === undefined ? argv : [...argv, startTime];
}

export function localMemoryProbeArgv(rootPid: number, startTime?: string): readonly string[] {
  return probeArgv(rootPid, startTime);
}

// One argv element for the remote login shell, quoted the same way every other opaque remote
// command here is. The script contains single quotes of its own (the awk programs), which is
// exactly what this quoting style exists to survive.
export function remoteMemoryProbeCommand(rootPid: number, startTime?: string): string {
  return `sh ${probeArgv(rootPid, startTime).map(shellQuote).join(" ")}`;
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }

export function parseMemoryProbeOutput(stdout: string, scope: MemoryScope): WorkerMemorySample | undefined {
  const match = /(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s*$/u.exec(stdout.trim());
  if (!match) return undefined;
  const [usedKb, limitKb, totalKb, availableKb] = match.slice(1, 5).map(Number) as [number, number, number, number];
  if (![usedKb, limitKb, totalKb].every((value) => Number.isSafeInteger(value)) || limitKb <= 0 || totalKb <= 0) return undefined;
  return {
    usedBytes: usedKb * 1024,
    limitBytes: limitKb * 1024,
    scope,
    hostTotalBytes: totalKb * 1024,
    // -1 is the probe's way of saying the kernel does not publish MemAvailable; dropping the
    // field is how the watch learns not to judge host pressure rather than judging it wrongly.
    ...(availableKb < 0 ? {} : { hostAvailableBytes: availableKb * 1024 }),
  };
}

export interface ProcessTreeReader {
  listPids(): Promise<number[]>;
  readParentPid(pid: number): Promise<number | undefined>;
  readCommandLine(pid: number): Promise<string | undefined>;
}

// How far below the bot a process may sit and still be taken for the one that OWNS a session.
// The Claude CLI is a direct child; anything a worker runs is further down. Bounding the depth
// is what stops one session's deep shell command — which may well echo another session's
// thread id — from being mistaken for that other session's runtime.
export const MAX_OWNER_DEPTH = 3;

// Finds the process that IS a local worker, for hosts where no runtime identity carries a pid.
// A remote runtime reports its own pid, so this is only needed locally, where a Claude session
// is spawned inside the Agent SDK and its pid never surfaces to us.
//
// The session's thread id is the handle: QiYan creates with it and resumes by it, so the id is
// in the argv of the process that owns the session. The SHALLOWEST match within MAX_OWNER_DEPTH
// wins. No match returns undefined, and the caller then says nothing: a warning attributed to
// the wrong process tree is worse than no warning.
export async function findWorkerRootPid(
  rootPid: number,
  needle: string,
  reader: ProcessTreeReader,
  maxDepth = MAX_OWNER_DEPTH,
): Promise<number | undefined> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || needle.length === 0) return undefined;
  const pids = await reader.listPids();
  const parents = new Map<number, number>();
  await Promise.all(pids.map(async (pid) => {
    const parent = await reader.readParentPid(pid);
    if (parent !== undefined) parents.set(pid, parent);
  }));
  const depthOf = (pid: number): number | undefined => {
    let depth = 0;
    let current = pid;
    const seen = new Set<number>([pid]);
    while (depth <= maxDepth) {
      if (current === rootPid) return depth;
      const parent = parents.get(current);
      if (parent === undefined || parent <= 0 || seen.has(parent)) return undefined;
      seen.add(parent);
      current = parent;
      depth += 1;
    }
    return undefined;
  };
  const candidates = pids
    .filter((pid) => pid !== rootPid)
    .map((pid) => ({ pid, depth: depthOf(pid) }))
    .filter((entry): entry is { pid: number; depth: number } => entry.depth !== undefined)
    .sort((left, right) => left.depth - right.depth || left.pid - right.pid);
  for (const candidate of candidates) {
    const commandLine = await reader.readCommandLine(candidate.pid);
    if (commandLine?.includes(needle)) return candidate.pid;
  }
  return undefined;
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
    return stdout === undefined ? undefined : parseMemoryProbeOutput(stdout, "session");
  };
}

export interface RemoteRuntimeRoot { pid: number; startTime?: string }

// A worker's memory on its own machine, over the endpoint's existing ControlMaster.
//
// The runtime's identity is cached because reading it costs a round trip of its own (a full
// remote inspect) and it only changes when the runtime is replaced. The probe re-checks the
// cached pid's start time on every call, so a reused pid fails the check and the identity is
// re-read — which is also what makes a restarted runtime pick itself up without anyone
// invalidating anything.
//
// When the identity cannot be read at all the endpoint is left alone for `identityBackoffMs`
// rather than re-inspected every tick: that host is usually unreachable, and hammering it adds
// a round trip a minute per session while bypassing the manager's own recovery notices.
export function createRemoteWorkerMemorySampler(deps: {
  rootPid(): Promise<RemoteRuntimeRoot | undefined>;
  runRemote(command: string): Promise<string | undefined>;
  now?(): number;
  identityBackoffMs?: number;
}): () => Promise<WorkerMemorySample | undefined> {
  const now = deps.now ?? (() => Date.now());
  const backoffMs = deps.identityBackoffMs ?? 5 * 60 * 1000;
  let cached: RemoteRuntimeRoot | undefined;
  let blockedUntil = 0;
  return async () => {
    if (cached === undefined) {
      if (now() < blockedUntil) return undefined;
      cached = await deps.rootPid();
      if (cached === undefined) { blockedUntil = now() + backoffMs; return undefined; }
      blockedUntil = 0;
    }
    const stdout = await deps.runRemote(remoteMemoryProbeCommand(cached.pid, cached.startTime));
    const sample = stdout === undefined ? undefined : parseMemoryProbeOutput(stdout, "endpoint");
    if (!sample) cached = undefined;
    return sample;
  };
}
