import type { Database } from "../storage/database.ts";

export interface LogicalFinalMessage {
  endpointId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  completedAt: number;
  itemOrder: number;
  body: string;
  terminalStatus: string;
}

interface TerminalTurn {
  id: string;
  status: string;
  completedAt: number | null;
  items: Array<{ type: string; id: string; text?: string; phase?: string | null }>;
}

export class FinalMessageStore {
  constructor(private readonly db: Database) {}

  persistTerminalTurn(endpointId: string, threadId: string, turn: TerminalTurn, observedAt: number): LogicalFinalMessage[] {
    if (!new Set(["completed", "failed", "interrupted"]).has(turn.status)) return [];
    const completedAt = turn.completedAt ?? this.observedAt(endpointId, threadId, turn.id, observedAt);
    if (turn.completedAt !== null) this.observedAt(endpointId, threadId, turn.id, completedAt);
    const explicit = turn.items.map((item, index) => ({ item, index })).filter(({ item }) => item.type === "agentMessage" && item.phase === "final_answer" && item.text);
    const unknown = turn.items.map((item, index) => ({ item, index })).filter(({ item }) => item.type === "agentMessage" && item.phase == null && item.text);
    const eligible = explicit.length > 0 ? explicit : unknown.slice(-1);
    for (const { item, index } of eligible) {
      this.db.prepare(`INSERT OR IGNORE INTO logical_final_messages
        (id, endpoint_id, thread_id, turn_id, item_id, completed_at, item_order, body, terminal_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(this.id(endpointId, threadId, turn.id, item.id), endpointId, threadId, turn.id, item.id, completedAt, index, item.text ?? "", turn.status);
    }
    return eligible.map(({ item }) => this.get(endpointId, threadId, turn.id, item.id) as LogicalFinalMessage);
  }

  list(endpointId: string, threadId: string, count: number): LogicalFinalMessage[] {
    if (!Number.isSafeInteger(count) || count < 1 || count > 20) throw new RangeError("count must be between 1 and 20");
    const rows = this.db.prepare(`SELECT * FROM (
      SELECT * FROM logical_final_messages WHERE endpoint_id = ? AND thread_id = ?
      ORDER BY completed_at DESC, turn_id DESC, item_order DESC LIMIT ?
    ) ORDER BY completed_at ASC, turn_id ASC, item_order ASC`).all(endpointId, threadId, count) as Array<Record<string, unknown>>;
    return rows.map((row) => this.fromRow(row));
  }

  get(endpointId: string, threadId: string, turnId: string, itemId: string): LogicalFinalMessage | undefined {
    const row = this.db.prepare("SELECT * FROM logical_final_messages WHERE endpoint_id = ? AND thread_id = ? AND turn_id = ? AND item_id = ?")
      .get(endpointId, threadId, turnId, itemId) as Record<string, unknown> | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  private observedAt(endpointId: string, threadId: string, turnId: string, value: number): number {
    this.db.prepare("INSERT OR IGNORE INTO terminal_turn_observations(endpoint_id, thread_id, turn_id, observed_at) VALUES (?, ?, ?, ?)")
      .run(endpointId, threadId, turnId, value);
    const row = this.db.prepare("SELECT observed_at FROM terminal_turn_observations WHERE endpoint_id = ? AND thread_id = ? AND turn_id = ?")
      .get(endpointId, threadId, turnId) as { observed_at: number };
    return Number(row.observed_at);
  }

  private id(endpointId: string, threadId: string, turnId: string, itemId: string): string {
    return `final:${endpointId}:${threadId}:${turnId}:${itemId}`;
  }

  private fromRow(row: Record<string, unknown>): LogicalFinalMessage {
    return {
      endpointId: String(row.endpoint_id), threadId: String(row.thread_id), turnId: String(row.turn_id), itemId: String(row.item_id),
      completedAt: Number(row.completed_at), itemOrder: Number(row.item_order), body: String(row.body), terminalStatus: String(row.terminal_status),
    };
  }
}
