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
  // Drive a turn on the target session. `singleFireKey` binds this fire to this
  // scheduled instant; production-app wires this to a DURABLE, idempotent
  // send_to_session enqueue keyed by that key. At-least-once: the engine only marks
  // the row advanced AFTER fire() resolves, so a throw/crash re-fires next tick; the
  // durable enqueue's dedup on `singleFireKey` makes the redelivery a no-op.
  fire(row: ScheduleRow, singleFireKey: string): Promise<void>;
  // Run a monitor's shell predicate on the session's endpoint; true iff exit 0.
  runCheck(row: ScheduleRow): Promise<boolean>;
  now(): number;
  // Injectable timer for tests; defaults to setTimeout.
  setTimer?(fn: () => void, ms: number): { cancel(): void };
  pollIntervalMs?: number;
  // Bounds a single runCheck/fire so one hung monitor shell or slow send can't stall
  // the whole engine (head-of-line). A timed-out op throws → retried next tick.
  opTimeoutMs?: number;
  onError?(error: unknown, row: ScheduleRow): void;
}

const DEFAULT_POLL_MS = 1000;
const MIN_INTERVAL_MS = 1000;
const DEFAULT_OP_TIMEOUT_MS = 30_000;

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
    // Re-read state right before acting: a cancel_schedule during a prior row's await
    // could have disarmed this row after due() snapshotted it (TOCTOU).
    if (this.deps.store.get(row.id)?.state !== "armed") return;
    if (row.kind === "monitor") {
      const triggered = await this.withTimeout(this.deps.runCheck(row));
      if (!triggered) { this.deps.store.advance(row.id, now + this.interval(row)); return; }
      // runCheck can await; re-verify the row wasn't cancelled during its window.
      if (this.deps.store.get(row.id)?.state !== "armed") return;
    }
    // The key binds this fire to this scheduled instant. fire() is a durable,
    // idempotent enqueue keyed by it; we advance ONLY after it resolves, so a
    // throw/crash re-fires next tick and the enqueue dedups the redelivery
    // (at-least-once + idempotent, not the previous at-most-once).
    const key = `${row.id}:${row.nextFireAt ?? now}`;
    await this.withTimeout(this.deps.fire(row, key));
    this.deps.store.advance(row.id, row.kind === "wakeup" ? null : now + this.interval(row));
  }

  private interval(row: ScheduleRow): number {
    return Math.max(MIN_INTERVAL_MS, row.intervalMs ?? DEFAULT_POLL_MS);
  }

  private async withTimeout<T>(op: Promise<T>): Promise<T> {
    const ms = this.deps.opTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("schedule op timed out")), ms); timer.unref?.(); });
    try { return await Promise.race([op, timeout]); }
    finally { clearTimeout(timer!); }
  }
}
