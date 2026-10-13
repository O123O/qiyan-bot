// Warns a worker when the work it launched is close to taking the machine down.
//
// The incident this exists for: a worker's own benchmark ran a 32-process pool whose tasks
// took ~10 GB each, filled a 252 GB host that has no swap, and the kernel OOM-killed one of
// those processes. systemd's default `OOMPolicy=stop` then stopped QiYan — whose own resident
// set was 160 MB — because something in its cgroup had been OOM-killed. Nothing had told the
// worker it was approaching the cliff, so nothing could back off.
//
// What is measured is the RSS of the worker's own process subtree, NOT its host cgroup. A
// cgroup is charged for page cache, which is reclaimable and which the kernel drops long
// before it kills anything: an idle remote login node reads 71% of its 4 GiB cap purely in
// cache, and a cgroup-based warning would fire there forever while saying nothing true.
//
// What this is NOT: a guard. It is advisory, it polls, and the warning reaches a Claude worker
// between tool calls. A single command that goes from nothing to 186 GB inside one tool call
// will OOM before anything here is read. It catches the climb, not the leap.

// The share at which a worker is told about its own subtree. Half the machine is not fatal on
// its own, which is the point: the warning has to arrive while there is still room to act.
export const WARN_PERCENT = 50;
// Re-arm below this, so a worker hovering at the threshold is not warned on every tick. The
// gap is deliberate hysteresis, not a second threshold.
export const REARM_PERCENT = 40;
// Separately: how little free memory makes the HOST itself the emergency. A per-worker share
// cannot see the aggregate that actually fills a machine — three workers at 35% each is 105%
// of RAM and not one of them is over the line — so the host is watched in its own right, and
// everyone measured on it is told.
export const HOST_FREE_WARN_PERCENT = 15;
export const HOST_FREE_REARM_PERCENT = 25;
// A worker that stays over a line is reminded this often: long enough not to nag, short enough
// to catch a slow climb toward the cliff.
export const REPEAT_WARNING_MS = 15 * 60 * 1000;
export const DEFAULT_POLL_INTERVAL_MS = 60_000;
// Bounds one sample and one send. Without this a single wedged endpoint stalls the whole pass:
// `sessions.send` has no deadline of its own anywhere on its path (the thread gate is an
// unbounded FIFO), and a remote app-server that hangs turn/start while reads still work is a
// failure this deployment has actually seen.
export const DEFAULT_OP_TIMEOUT_MS = 30_000;

// What `usedBytes` describes. A Codex app-server hosts every thread on its endpoint, so one
// reading covers all of that endpoint's work and no single session can be told "you".
export type MemoryScope = "session" | "endpoint";

export interface WorkerMemorySample {
  // Resident bytes summed over the measured process subtree.
  readonly usedBytes: number;
  // What the host will actually let that subtree have: the nearest finite cgroup memory limit
  // above it, or total RAM when nothing caps it.
  readonly limitBytes: number;
  readonly scope: MemoryScope;
  // The host's own figures, when the probe could read them. These are what catch the case no
  // per-worker share can: a machine filled by several workers, none of them individually over
  // the line.
  readonly hostTotalBytes?: number;
  readonly hostAvailableBytes?: number;
}

export interface WorkerMemoryTarget {
  readonly nickname: string;
  readonly endpointId: string;
  readonly threadId: string;
}

export type WarningReason = "share" | "host";

export function memorySharePercent(sample: WorkerMemorySample): number | undefined {
  if (!Number.isFinite(sample.usedBytes) || !Number.isFinite(sample.limitBytes) || sample.limitBytes <= 0) return undefined;
  if (sample.usedBytes < 0) return undefined;
  return (sample.usedBytes / sample.limitBytes) * 100;
}

export function hostFreePercent(sample: WorkerMemorySample): number | undefined {
  const { hostTotalBytes: total, hostAvailableBytes: available } = sample;
  if (total === undefined || available === undefined) return undefined;
  if (!Number.isFinite(total) || !Number.isFinite(available) || total <= 0 || available < 0) return undefined;
  return (available / total) * 100;
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// Second person, because the worker is the only party that can act on it: the memory belongs
// to processes it started. An endpoint-wide reading says so instead of claiming "you", since
// on a Codex endpoint the figure includes every thread sharing that app-server.
export function memoryWarningMessage(sample: WorkerMemorySample, percent: number): string {
  const subject = sample.scope === "endpoint"
    ? "the work on your endpoint used"
    : "you used";
  return `[system] Warning, ${subject} ${Math.round(percent)}% memory of the system`
    + ` (${gigabytes(sample.usedBytes)} of ${gigabytes(sample.limitBytes)}),`
    + " be careful about the oom, reduce unnecessary memory cost.";
}

// The host is nearly full and this worker may or may not be the reason. It is told its own
// figure alongside, so it can judge whether it is the one with room to give.
export function hostPressureWarningMessage(sample: WorkerMemorySample, freePercent: number): string {
  const available = sample.hostAvailableBytes ?? 0;
  const total = sample.hostTotalBytes ?? 0;
  return `[system] Warning, the machine is nearly full: ${Math.round(freePercent)}% memory free`
    + ` (${gigabytes(available)} of ${gigabytes(total)}), and your own work is using ${gigabytes(sample.usedBytes)}.`
    + " Be careful about the oom, reduce unnecessary memory cost.";
}

// Chooses which sessions carry a warning. A session-scoped endpoint measures each session
// separately, so each one is watched. An endpoint-scoped endpoint has ONE reading covering all
// of its threads, so exactly one session carries it — otherwise every session sharing a Codex
// app-server is warned about the same memory, separately, each in a turn started for the
// purpose. The choice is the lowest nickname so it is the same session tick after tick.
export function selectWatchTargets(
  sessions: readonly WorkerMemoryTarget[],
  scopeOf: (endpointId: string) => MemoryScope | undefined,
): WorkerMemoryTarget[] {
  const chosen = new Map<string, WorkerMemoryTarget>();
  for (const session of sessions) {
    const scope = scopeOf(session.endpointId);
    if (scope === undefined) continue;
    if (scope === "session") { chosen.set(`${session.endpointId}\0${session.threadId}`, session); continue; }
    const held = chosen.get(session.endpointId);
    if (!held || session.nickname < held.nickname) chosen.set(session.endpointId, session);
  }
  return [...chosen.values()];
}

interface WatchState { warnedAt: number }

export interface WorkerMemoryWatchDeps {
  // The worker sessions to watch, re-read every tick so sessions that come and go are picked up
  // without the watch holding a stale list. An endpoint whose reading is endpoint-wide must
  // appear ONCE here, or every session on it is warned separately about the same memory.
  targets(): readonly WorkerMemoryTarget[];
  // One sample for one worker. `undefined` means "could not measure" — an unreachable host, a
  // runtime whose pid is unknown — and is deliberately NOT treated as "recovered".
  sample(target: WorkerMemoryTarget): Promise<WorkerMemorySample | undefined>;
  // Deliver the warning to the worker.
  warn(target: WorkerMemoryTarget, message: string, reason: WarningReason): Promise<void>;
  now(): number;
  onError?(error: unknown, target: WorkerMemoryTarget): void;
  // Called when a worker could not be measured at all. Silence is the failure mode this
  // feature degrades into, so somebody has to be able to see it happening.
  onUnmeasured?(target: WorkerMemoryTarget, consecutive: number): void;
  warnPercent?: number;
  rearmPercent?: number;
  hostFreeWarnPercent?: number;
  hostFreeRearmPercent?: number;
  repeatWarningMs?: number;
  pollIntervalMs?: number;
  opTimeoutMs?: number;
  setTimer?(fn: () => void, ms: number): { cancel(): void };
}

// The warning is sent live and is never persisted. A memory reading is only true at the instant
// it was taken, so a durable row redelivered after a restart would tell the worker about a
// cliff that no longer exists.
export class WorkerMemoryWatch {
  private timer: { cancel(): void } | undefined;
  private stopped = true;
  private ticking = false;
  // Bumped by every start and stop. A tick that was already in flight when the watch was
  // stopped finishes, finds its generation stale, and does NOT schedule another timer — which
  // is what stops a stop/start pair from leaving two chains running forever.
  private generation = 0;
  private readonly state = new Map<string, WatchState>();
  private readonly unmeasured = new Map<string, number>();

  constructor(private readonly deps: WorkerMemoryWatchDeps) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation += 1;
    this.scheduleTick(this.generation);
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.ticking = false;
    this.timer?.cancel();
    this.timer = undefined;
  }

  private scheduleTick(generation: number): void {
    if (this.stopped || generation !== this.generation) return;
    const make = this.deps.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return { cancel: () => clearTimeout(handle) };
    });
    this.timer = make(() => { void this.tick().finally(() => this.scheduleTick(generation)); }, this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  // One pass. Never throws, and never waits on one host longer than the op timeout: a watch
  // that dies — or stalls — on a single unreachable endpoint stops protecting every other
  // worker, which is the opposite of what it is for.
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const targets = this.deps.targets();
      this.prune(targets);
      // Concurrently: a wedged endpoint must not delay the pass for the healthy ones, and the
      // timeout below only bounds each worker's own wait, not its position in a queue.
      await Promise.all(targets.map(async (target) => {
        try { await this.visit(target); }
        catch (error) { this.deps.onError?.(error, target); }
      }));
    } finally {
      this.ticking = false;
    }
  }

  private async visit(target: WorkerMemoryTarget): Promise<void> {
    const timeout = this.deps.opTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
    const key = stateKey(target);
    const sample = await bounded(this.deps.sample(target), timeout, "worker memory sample timed out");
    if (!sample) {
      const consecutive = (this.unmeasured.get(key) ?? 0) + 1;
      this.unmeasured.set(key, consecutive);
      this.deps.onUnmeasured?.(target, consecutive);
      return;
    }
    this.unmeasured.delete(key);
    const free = hostFreePercent(sample);
    if (free !== undefined) {
      await this.consider(target, "host", free <= (this.deps.hostFreeWarnPercent ?? HOST_FREE_WARN_PERCENT),
        free >= (this.deps.hostFreeRearmPercent ?? HOST_FREE_REARM_PERCENT),
        () => hostPressureWarningMessage(sample, free), timeout);
    }
    const percent = memorySharePercent(sample);
    if (percent === undefined) return;
    await this.consider(target, "share", percent > (this.deps.warnPercent ?? WARN_PERCENT),
      percent < (this.deps.rearmPercent ?? REARM_PERCENT),
      () => memoryWarningMessage(sample, percent), timeout);
  }

  private async consider(
    target: WorkerMemoryTarget,
    reason: WarningReason,
    over: boolean,
    recovered: boolean,
    message: () => string,
    timeoutMs: number,
  ): Promise<void> {
    const key = `${stateKey(target)}\0${reason}`;
    if (recovered) { this.state.delete(key); return; }
    if (!over) return;
    const now = this.deps.now();
    const previous = this.state.get(key);
    if (previous && now - previous.warnedAt < (this.deps.repeatWarningMs ?? REPEAT_WARNING_MS)) return;
    // Recorded BEFORE the send: a send that hangs or fails must not leave the worker eligible
    // for another warning on the very next tick.
    this.state.set(key, { warnedAt: now });
    await bounded(this.deps.warn(target, message(), reason), timeoutMs, "worker memory warning send timed out");
  }

  private prune(targets: readonly WorkerMemoryTarget[]): void {
    const live = new Set(targets.map(stateKey));
    for (const key of [...this.state.keys()]) if (!live.has(key.slice(0, key.lastIndexOf("\0")))) this.state.delete(key);
    for (const key of [...this.unmeasured.keys()]) if (!live.has(key)) this.unmeasured.delete(key);
  }
}

function stateKey(target: WorkerMemoryTarget): string {
  return `${target.endpointId}\0${target.threadId}`;
}

// Rejects rather than resolving, so a timeout reaches onError and is visible, and so a hung
// send is never mistaken for a delivered warning.
function bounded<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
