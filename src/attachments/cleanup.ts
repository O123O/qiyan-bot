export interface CleanupTimers {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const nodeCleanupTimers: CleanupTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export class AttachmentCleanup {
  private stopped = true;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private starting: Promise<void> | undefined;

  constructor(
    private readonly cleanup: () => Promise<number>,
    private readonly onError: () => void,
    private readonly timers: CleanupTimers = nodeCleanupTimers,
    private readonly intervalMs = 24 * 60 * 60_000,
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) {
      await (this.starting ?? this.running);
      return;
    }
    this.stopped = false;
    this.generation += 1;
    const generation = this.generation;
    const draining = this.running;
    let starting: Promise<void>;
    starting = this.startGeneration(generation, draining).finally(() => {
      if (this.starting === starting) this.starting = undefined;
    });
    this.starting = starting;
    await starting;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private async startGeneration(generation: number, draining: Promise<void> | undefined): Promise<void> {
    if (draining) await draining;
    if (this.stopped || generation !== this.generation) return;
    await this.run(generation);
  }

  private run(generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) return Promise.resolve();
    if (this.running) return this.running;
    const running = this.runOnce(generation);
    this.running = running.finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runOnce(generation: number): Promise<void> {
    try {
      await this.cleanup();
    } catch {
      this.onError();
    }
    if (this.stopped || generation !== this.generation) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    timer = this.timers.setTimeout(() => {
      if (this.stopped || generation !== this.generation || timer === undefined || this.timer !== timer) return;
      this.timer = undefined;
      void this.run(generation);
    }, this.intervalMs);
    this.timer = timer;
  }
}
