import { randomUUID } from "node:crypto";
import type { Database } from "./database.ts";

export type ManagedEpochRecoveryMode = "from_beginning" | "from_first_turn";

export interface ManagedEpoch {
  id: string;
  baselineTurnId?: string;
  recoveryMode: ManagedEpochRecoveryMode;
  firstTurnId?: string;
  startedAt: number;
  endedAt?: number;
}

export class ManagedEpochStore {
  constructor(private readonly db: Database) {}

  begin(
    endpointId: string,
    threadId: string,
    mappingId: string,
    baselineTurnId: string | undefined,
    startedAt: number,
    recoveryMode: ManagedEpochRecoveryMode = "from_beginning",
  ): string {
    const id = `epoch_${randomUUID()}`;
    this.db.prepare(`INSERT INTO managed_epochs(
      id, endpoint_id, thread_id, mapping_id, baseline_turn_id, recovery_mode, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, endpointId, threadId, mappingId, baselineTurnId ?? null, recoveryMode, startedAt);
    return id;
  }

  recordFirstTurn(endpointId: string, threadId: string, mappingId: string, turnId: string): boolean {
    return Number(this.db.prepare(`UPDATE managed_epochs SET first_turn_id = ? WHERE id = (
      SELECT id FROM managed_epochs
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ? AND ended_at IS NULL
      ORDER BY started_at DESC LIMIT 1
    ) AND recovery_mode = 'from_first_turn' AND first_turn_id IS NULL`)
      .run(turnId, endpointId, threadId, mappingId).changes) === 1;
  }

  end(endpointId: string, threadId: string, mappingId: string, endedAt: number): void {
    this.db.prepare(`UPDATE managed_epochs SET ended_at = ? WHERE id = (
      SELECT id FROM managed_epochs WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ? AND ended_at IS NULL
      ORDER BY started_at DESC LIMIT 1
    )`).run(endedAt, endpointId, threadId, mappingId);
  }

  current(endpointId: string, threadId: string, mappingId: string): ManagedEpoch | undefined {
    const row = this.db.prepare(`SELECT * FROM managed_epochs
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ? AND ended_at IS NULL
      ORDER BY started_at DESC LIMIT 1`).get(endpointId, threadId, mappingId) as Record<string, unknown> | undefined;
    return row ? this.parse(row) : undefined;
  }

  latest(endpointId: string, threadId: string, mappingId: string): ManagedEpoch | undefined {
    const row = this.db.prepare(`SELECT * FROM managed_epochs
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ? ORDER BY started_at DESC LIMIT 1`)
      .get(endpointId, threadId, mappingId) as Record<string, unknown> | undefined;
    return row ? this.parse(row) : undefined;
  }

  private parse(row: Record<string, unknown>): ManagedEpoch {
    return {
      id: String(row.id),
      ...(row.baseline_turn_id ? { baselineTurnId: String(row.baseline_turn_id) } : {}),
      recoveryMode: row.recovery_mode === "from_first_turn" ? "from_first_turn" : "from_beginning",
      ...(row.first_turn_id ? { firstTurnId: String(row.first_turn_id) } : {}),
      startedAt: Number(row.started_at),
      ...(row.ended_at ? { endedAt: Number(row.ended_at) } : {}),
    };
  }
}
