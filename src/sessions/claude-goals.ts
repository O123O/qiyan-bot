// Emulated goal state for Claude sessions (Phase 1.5). Codex persists goals inside
// its app-server; a headless Claude session has none, so QiYan stores the goal here
// and ClaudeCodeRuntime's thread/goal/get|set|clear handlers read/write it. The
// stored shape matches what SessionService/production-app expect from a Codex goal
// read: { goal: { objective, status, tokenBudget? } | null }.
import type { Database } from "../storage/database.ts";

export interface ClaudeGoal {
  objective: string;
  status: string;
  tokenBudget?: number;
}

export class ClaudeGoalStore {
  constructor(private readonly db: Database) {}

  get(endpointId: string, threadId: string): ClaudeGoal | null {
    const row = this.db.prepare(
      "SELECT objective, status, token_budget FROM claude_session_goals WHERE endpoint_id = ? AND thread_id = ?",
    ).get(endpointId, threadId) as { objective: string; status: string; token_budget: number | null } | undefined;
    if (!row) return null;
    return { objective: row.objective, status: row.status, ...(row.token_budget === null ? {} : { tokenBudget: Number(row.token_budget) }) };
  }

  // Set a fresh objective (status defaults to "active"); returns the stored goal.
  set(endpointId: string, threadId: string, goal: { objective: string; status?: string; tokenBudget?: number }, now: number): ClaudeGoal {
    const status = goal.status ?? "active";
    this.db.prepare(
      `INSERT INTO claude_session_goals(endpoint_id, thread_id, objective, status, token_budget, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint_id, thread_id) DO UPDATE SET objective = excluded.objective, status = excluded.status, token_budget = excluded.token_budget, updated_at = excluded.updated_at`,
    ).run(endpointId, threadId, goal.objective, status, goal.tokenBudget ?? null, now);
    return this.get(endpointId, threadId)!;
  }

  // Update only the status (pause/resume/blocked/complete) of an existing goal.
  setStatus(endpointId: string, threadId: string, status: string, now: number): ClaudeGoal | null {
    this.db.prepare(
      "UPDATE claude_session_goals SET status = ?, updated_at = ? WHERE endpoint_id = ? AND thread_id = ?",
    ).run(status, now, endpointId, threadId);
    return this.get(endpointId, threadId);
  }

  clear(endpointId: string, threadId: string): void {
    this.db.prepare("DELETE FROM claude_session_goals WHERE endpoint_id = ? AND thread_id = ?").run(endpointId, threadId);
  }
}
