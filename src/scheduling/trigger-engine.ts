// Trigger engine (Phase 2.2) — provider-blind. It polls the durable ScheduleStore
// and, on a due trigger, drives a turn through the unified send_to_session (the same
// tool the assistant/manager use), so both Codex and Claude sessions get
// wakeup/cron/monitor for free. Firing is single-fire idempotent, including across a
// restart at the moment of firing. Steer is NOT here (that's the Claude adapter).
//
// Trigger kinds:
//   wakeup  — one-shot at next_fire_at.
//   cron    — recurring every interval_ms (interval-based; re-arms after each fire).
//   monitor — every interval_ms run `spec` as a shell predicate on the session's
//             endpoint; fire only when it exits 0; always re-arm the next poll.
import type { ScheduleRow, ScheduleStore } from "./schedule-store.ts";

export interface TriggerEngineDeps {
  store: ScheduleStore;
  // Drive a turn on the target session (production-app wires this to the durable
  // send_to_session operation). Must be idempotent-safe; the engine also guards.
  fire(row: ScheduleRow): Promise<void>;
  // Run a monitor's shell predicate on the session's endpoint; true iff exit 0.
  runCheck(row: ScheduleRow): Promise<boolean>;
  now(): number;
  // Injectable timer for tests; defaults to setTimeout.
  setTimer?(fn: () => void, ms: number): { cancel(): void };
  pollIntervalMs?: number;
  onError?(error: unknown, row: ScheduleRow): void;
}

const DEFAULT_POLL_MS = 1000;
const MIN_INTERVAL_MS = 1000;

export class TriggerEngine {
  private timer: { cancel(): void } | undefined;
  private stopped = false;
  private ticking = false;

  constructor(private readonly deps: TriggerEngineDeps) {}

  // Recovery (2.5): the store is already durable, so starting simply resumes polling;
  // armed rows (including missed ones — next_fire_at in the past) fire on the first tick.
  start(): void {
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
    const make = this.deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return { cancel: () => clearTimeout(t) }; });
    this.timer = make(() => void this.tick(), this.deps.pollIntervalMs ?? DEFAULT_POLL_MS);
  }

  // Exposed for tests to drive deterministically.
  async tick(): Promise<void> {
    if (this.ticking) { this.scheduleTick(); return; }
    this.ticking = true;
    try {
      for (const row of this.deps.store.due(this.deps.now())) {
        if (this.stopped) break;
        try { await this.process(row); }
        catch (error) { this.deps.onError?.(error, row); }
      }
    } finally {
      this.ticking = false;
      this.scheduleTick();
    }
  }

  private async process(row: ScheduleRow): Promise<void> {
    const now = this.deps.now();
    if (row.kind === "monitor") {
      const triggered = await this.deps.runCheck(row);
      if (!triggered) { this.deps.store.advance(row.id, now + this.interval(row)); return; }
    }
    // Single-fire idempotency: the key binds this row to this scheduled instant, so a
    // restart mid-fire cannot double-deliver.
    const key = `${row.id}:${row.nextFireAt ?? now}`;
    if (this.deps.store.claimFire(row.id, key)) {
      await this.deps.fire(row);
    }
    this.deps.store.advance(row.id, row.kind === "wakeup" ? null : now + this.interval(row));
  }

  private interval(row: ScheduleRow): number {
    return Math.max(MIN_INTERVAL_MS, row.intervalMs ?? DEFAULT_POLL_MS);
  }
}
