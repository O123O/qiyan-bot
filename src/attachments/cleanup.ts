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
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly cleanup: () => Promise<number>,
    private readonly onError: () => void,
    private readonly timers: CleanupTimers = nodeCleanupTimers,
    private readonly intervalMs = 24 * 60 * 60_000,
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private run(): Promise<void> {
    if (this.running) return this.running;
    const running = this.runOnce();
    this.running = running.finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runOnce(): Promise<void> {
    try {
      await this.cleanup();
    } catch {
      this.onError();
    }
    if (this.stopped) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, this.intervalMs);
  }
}
