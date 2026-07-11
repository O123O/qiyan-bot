// Durable schedule store (Phase 2.1) — the provider-agnostic source of truth for
// wakeup/cron/monitor triggers. Net-new additive table; unrelated to the assistant's
// conversation batcher (`assistant/scheduler.ts`). The trigger engine (2.2) reads
// due rows and fires via send_to_session; firing idempotency lives in the durable
// enqueue (a unique-constraint insert keyed by the single-fire key), not here.
import { randomUUID } from "node:crypto";
import type { Database } from "../storage/database.ts";

export type ScheduleKind = "wakeup" | "cron" | "monitor";
export type ScheduleState = "armed" | "done" | "cancelled";

export interface ScheduleRow {
  id: string;
  nickname: string;
  endpointId: string;
  threadId: string;
  kind: ScheduleKind;
  spec: string;            // wakeup: epoch-ms; cron: cron expr; monitor: shell check command
  message: string;         // the turn message delivered on fire
  state: ScheduleState;
  nextFireAt: number | null;
  intervalMs: number | null;  // cron/monitor recurrence & monitor poll floor
  createdAt: number;
}

export interface NewSchedule {
  nickname: string;
  endpointId: string;
  threadId: string;
  kind: ScheduleKind;
  spec: string;
  message: string;
  nextFireAt: number | null;
  intervalMs?: number | null;
}

export class ScheduleStore {
  constructor(private readonly db: Database) {}

  create(schedule: NewSchedule, now: number): ScheduleRow {
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO session_schedules(id, nickname, endpoint_id, thread_id, kind, spec, message, state, next_fire_at, interval_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'armed', ?, ?, ?)`,
    ).run(id, schedule.nickname, schedule.endpointId, schedule.threadId, schedule.kind, schedule.spec, schedule.message,
      schedule.nextFireAt, schedule.intervalMs ?? null, now);
    return this.require(id);
  }

  require(id: string): ScheduleRow {
    const row = this.get(id);
    if (!row) throw new Error(`unknown schedule: ${id}`);
    return row;
  }

  get(id: string): ScheduleRow | undefined {
    const row = this.db.prepare("SELECT * FROM session_schedules WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : undefined;
  }

  listArmed(): ScheduleRow[] {
    return (this.db.prepare("SELECT * FROM session_schedules WHERE state = 'armed' ORDER BY created_at").all() as Array<Record<string, unknown>>).map(fromRow);
  }

  listForSession(endpointId: string, threadId: string): ScheduleRow[] {
    return (this.db.prepare("SELECT * FROM session_schedules WHERE endpoint_id = ? AND thread_id = ? AND state = 'armed' ORDER BY created_at").all(endpointId, threadId) as Array<Record<string, unknown>>).map(fromRow);
  }

  // Armed timer rows whose next_fire_at has passed. Monitors (next_fire_at holds the
  // next poll time) are included so the engine can run their check.
  due(now: number): ScheduleRow[] {
    return (this.db.prepare("SELECT * FROM session_schedules WHERE state = 'armed' AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at").all(now) as Array<Record<string, unknown>>).map(fromRow);
  }

  // After a fire: a one-shot wakeup is done; a recurring cron/monitor re-arms. Guarded
  // on state='armed' so it can never clobber a row cancelled mid-tick.
  advance(id: string, nextFireAt: number | null): void {
    if (nextFireAt === null) this.db.prepare("UPDATE session_schedules SET state = 'done', next_fire_at = NULL WHERE id = ? AND state = 'armed'").run(id);
    else this.db.prepare("UPDATE session_schedules SET next_fire_at = ? WHERE id = ? AND state = 'armed'").run(nextFireAt, id);
  }

  // Self-guarding: only the owning session can cancel its own armed schedule.
  cancel(endpointId: string, threadId: string, id: string): boolean {
    return this.db.prepare("UPDATE session_schedules SET state = 'cancelled' WHERE id = ? AND endpoint_id = ? AND thread_id = ? AND state = 'armed'")
      .run(id, endpointId, threadId).changes === 1;
  }
}

function fromRow(row: Record<string, unknown>): ScheduleRow {
  return {
    id: String(row.id),
    nickname: String(row.nickname),
    endpointId: String(row.endpoint_id),
    threadId: String(row.thread_id),
    kind: String(row.kind) as ScheduleKind,
    spec: String(row.spec),
    message: String(row.message),
    state: String(row.state) as ScheduleState,
    nextFireAt: row.next_fire_at === null ? null : Number(row.next_fire_at),
    intervalMs: row.interval_ms === null ? null : Number(row.interval_ms),
    createdAt: Number(row.created_at),
  };
}
