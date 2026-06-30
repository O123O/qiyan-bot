export interface UserJob { id: string; payload: unknown }
export interface EventJob { id: string; sessionKey: string; payload: unknown }
export type CoordinatorJob = UserJob | { id: string; events: EventJob[]; payload: unknown };

interface QueuedEvent { job: EventJob; queuedAt: number }

export class CoordinatorScheduler {
  private readonly users: UserJob[] = [];
  private readonly events: QueuedEvent[] = [];
  private running = false;
  private consecutiveUsers = 0;
  private readonly waiters: Array<() => void> = [];
  private eventTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly execute: (job: CoordinatorJob) => Promise<void>,
    private readonly options: {
      maxBatchEvents?: number;
      maxBatchBytes?: number;
      batchWindowMs?: number;
      maxEventAgeMs?: number;
      now?: () => number;
      setTimeout?: typeof setTimeout;
      clearTimeout?: typeof clearTimeout;
      onError?: (job: CoordinatorJob, error: unknown) => Promise<void> | void;
    } = {},
  ) {}

  enqueueUser(job: UserJob): void { this.users.push(job); this.kick(); }

  enqueueEvent(job: EventJob): void {
    const transient = this.isTransient(job);
    if (transient) {
      const index = this.events.findIndex((item) => item.job.sessionKey === job.sessionKey && this.isTransient(item.job));
      if (index >= 0) {
        const queuedAt = this.events[index]!.queuedAt;
        this.events.splice(index, 1, { job, queuedAt });
        this.scheduleEventWindow();
        return;
      }
    }
    this.events.push({ job, queuedAt: this.now() });
    this.scheduleEventWindow();
    if (this.users.length > 0 || this.consecutiveUsers >= 5) this.kick();
  }

  async idle(): Promise<void> {
    if (!this.running && this.users.length === 0 && this.events.length === 0) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private kick(): void {
    if (this.running) return;
    this.running = true;
    void this.pump().catch(() => undefined);
  }

  private async pump(): Promise<void> {
    try {
      while (this.users.length > 0 || this.events.length > 0) {
        if (this.shouldServiceEvents()) {
          const events = this.takeEventBatch();
          this.consecutiveUsers = 0;
          await this.executeSafely({ id: `batch:${events.map((item) => item.id).join(",")}`, events, payload: events.map((item) => item.payload) });
          continue;
        }
        if (this.users.length > 0) {
          const job = this.users.shift()!;
          this.consecutiveUsers += 1;
          await this.executeSafely(job);
          continue;
        }
        this.scheduleEventWindow();
        break;
      }
    } finally {
      this.running = false;
      if (this.users.length === 0 && this.events.length === 0) {
        this.cancelEventTimer();
        for (const resolve of this.waiters.splice(0)) resolve();
      } else if (this.users.length > 0 || this.shouldServiceEvents()) {
        this.kick();
      }
    }
  }

  private async executeSafely(job: CoordinatorJob): Promise<void> {
    try { await this.execute(job); }
    catch (error) {
      try { await this.options.onError?.(job, error); }
      catch { /* scheduler failure reporting must not stop later durable jobs */ }
    }
  }

  private shouldServiceEvents(): boolean {
    if (this.events.length === 0) return false;
    if (this.consecutiveUsers >= 5) return true;
    const age = this.now() - this.events[0]!.queuedAt;
    if (age >= (this.options.maxEventAgeMs ?? 30_000)) return true;
    return this.users.length === 0 && age >= (this.options.batchWindowMs ?? 1_000);
  }

  private scheduleEventWindow(): void {
    if (this.events.length === 0 || this.eventTimer) return;
    const first = this.events[0]!;
    const windowAt = first.queuedAt + (this.options.batchWindowMs ?? 1_000);
    const starvationAt = first.queuedAt + (this.options.maxEventAgeMs ?? 30_000);
    const delay = Math.max(0, Math.min(windowAt, starvationAt) - this.now());
    const schedule = this.options.setTimeout ?? setTimeout;
    this.eventTimer = schedule(() => {
      this.eventTimer = undefined;
      this.kick();
    }, delay);
    this.eventTimer.unref?.();
  }

  private cancelEventTimer(): void {
    if (!this.eventTimer) return;
    (this.options.clearTimeout ?? clearTimeout)(this.eventTimer);
    this.eventTimer = undefined;
  }

  private takeEventBatch(): EventJob[] {
    this.cancelEventTimer();
    const maxEvents = this.options.maxBatchEvents ?? 20;
    const maxBytes = this.options.maxBatchBytes ?? 8 * 1024;
    const batch: EventJob[] = [];
    let bytes = 0;
    while (this.events.length > 0 && batch.length < maxEvents) {
      const next = this.events[0]!.job;
      const size = Buffer.byteLength(JSON.stringify(next.payload));
      if (batch.length > 0 && bytes + size > maxBytes) break;
      batch.push(this.events.shift()!.job); bytes += size;
    }
    this.scheduleEventWindow();
    return batch;
  }

  private isTransient(job: EventJob): boolean {
    return typeof job.payload === "object" && job.payload !== null && "status" in job.payload && !("final" in job.payload);
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
}
