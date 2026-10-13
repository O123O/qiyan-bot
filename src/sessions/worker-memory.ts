// Warns a worker when the work it launched is close to taking the machine down.
//
// The incident this exists for: a worker's own benchmark ran a 32-process pool whose tasks
// took ~10 GB each, filled a 252 GB host that has no swap, and the kernel OOM-killed one of
// those processes. systemd's default `OOMPolicy=stop` then stopped QiYan — whose own
// resident set was 160 MB — because something in its cgroup had been OOM-killed. Nothing had
// told the worker it was approaching the cliff, so nothing could back off.
//
// What is measured is the RSS of the worker's own process subtree, NOT its host cgroup.
// A cgroup is charged for page cache, which is reclaimable and which the kernel drops long
// before it kills anything: an idle remote login node reads 71% of its 4 GiB cap purely in
// cache, and a cgroup-based warning would fire there forever while saying nothing true. RSS
// over the subtree tracks what the OOM killer actually weighs.

// The share at which a worker is told. Half the machine is not fatal on its own, which is the
// point: the warning has to arrive while there is still room to act on it.
export const WARN_PERCENT = 50;
// Re-arm below this, so a worker hovering at the threshold is not warned on every tick. The
// gap is deliberate hysteresis, not a second threshold.
export const REARM_PERCENT = 40;
// A worker that stays above the threshold is reminded this often. It has to be long enough
// not to be nagging and short enough to catch a slow climb toward the cliff.
export const REPEAT_WARNING_MS = 15 * 60 * 1000;
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

export interface WorkerMemorySample {
  // Resident bytes summed over the worker's process subtree.
  readonly usedBytes: number;
  // What the worker's host will actually let it have: the nearest finite cgroup memory.max
  // above it, or total RAM when nothing caps it.
  readonly limitBytes: number;
}

export interface WorkerMemoryTarget {
  readonly nickname: string;
  readonly endpointId: string;
  readonly threadId: string;
}

export function memorySharePercent(sample: WorkerMemorySample): number | undefined {
  if (!Number.isFinite(sample.usedBytes) || !Number.isFinite(sample.limitBytes) || sample.limitBytes <= 0) return undefined;
  if (sample.usedBytes < 0) return undefined;
  return (sample.usedBytes / sample.limitBytes) * 100;
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// Addressed to the worker, in the second person, because the worker is the only party that can
// act on it: the memory belongs to processes it started.
export function memoryWarningMessage(sample: WorkerMemorySample, percent: number): string {
  return `[system] Warning, you used ${Math.round(percent)}% memory of the system`
    + ` (${gigabytes(sample.usedBytes)} of ${gigabytes(sample.limitBytes)}),`
    + " be careful about the oom, reduce unnecessary memory cost.";
}

interface WatchState { warnedAt: number }

export interface WorkerMemoryWatchDeps {
  // The worker sessions to watch, re-read every tick so sessions that come and go are picked
  // up without the watch holding a stale list.
  targets(): readonly WorkerMemoryTarget[];
  // One sample for one worker. `undefined` means "could not measure" — an unreachable host, a
  // runtime whose pid is unknown — and is deliberately NOT treated as "recovered".
  sample(target: WorkerMemoryTarget): Promise<WorkerMemorySample | undefined>;
  // Deliver the warning to the worker. production-app wires this to the ordinary send, in
  // `auto` mode: steered into the running turn when the worker is busy (which is exactly when
  // its memory is growing), started as a turn when it is idle but still holding the memory.
  warn(target: WorkerMemoryTarget, message: string): Promise<void>;
  now(): number;
  onError?(error: unknown, target: WorkerMemoryTarget): void;
  warnPercent?: number;
  rearmPercent?: number;
  repeatWarningMs?: number;
  pollIntervalMs?: number;
  setTimer?(fn: () => void, ms: number): { cancel(): void };
}

// The warning is sent live and is never persisted. A memory reading is only true at the
// instant it was taken, so a durable row redelivered after a restart would tell the worker
// about a cliff that no longer exists.
export class WorkerMemoryWatch {
  private timer: { cancel(): void } | undefined;
  private stopped = true;
  private ticking = false;
  private readonly state = new Map<string, WatchState>();

  constructor(private readonly deps: WorkerMemoryWatchDeps) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleTick();
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
  }

  private scheduleTick(): void {
    if (this.stopped) return;
    const make = this.deps.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return { cancel: () => clearTimeout(handle) };
    });
    this.timer = make(() => { void this.tick().finally(() => this.scheduleTick()); }, this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  // One pass. Never throws: a watch that dies on one unreachable host stops protecting every
  // other worker, which is the opposite of what it is for.
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const targets = this.deps.targets();
      this.prune(targets);
      for (const target of targets) {
        try { await this.visit(target); }
        catch (error) { this.deps.onError?.(error, target); }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async visit(target: WorkerMemoryTarget): Promise<void> {
    const sample = await this.deps.sample(target);
    if (!sample) return;
    const percent = memorySharePercent(sample);
    if (percent === undefined) return;
    const key = stateKey(target);
    if (percent < (this.deps.rearmPercent ?? REARM_PERCENT)) { this.state.delete(key); return; }
    if (percent <= (this.deps.warnPercent ?? WARN_PERCENT)) return;
    const now = this.deps.now();
    const previous = this.state.get(key);
    if (previous && now - previous.warnedAt < (this.deps.repeatWarningMs ?? REPEAT_WARNING_MS)) return;
    // Recorded BEFORE the send: a send that hangs or fails must not leave the worker eligible
    // for another warning on the very next tick.
    this.state.set(key, { warnedAt: now });
    await this.deps.warn(target, memoryWarningMessage(sample, percent));
  }

  private prune(targets: readonly WorkerMemoryTarget[]): void {
    if (this.state.size === 0) return;
    const live = new Set(targets.map(stateKey));
    for (const key of [...this.state.keys()]) if (!live.has(key)) this.state.delete(key);
  }
}

function stateKey(target: WorkerMemoryTarget): string {
  return `${target.endpointId}\0${target.threadId}`;
}
