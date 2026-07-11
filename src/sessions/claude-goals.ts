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

  // Set a fresh objective (status defaults to "active"); resets the auto-drive counter.
  set(endpointId: string, threadId: string, goal: { objective: string; status?: string; tokenBudget?: number }, now: number): ClaudeGoal {
    const status = goal.status ?? "active";
    this.db.prepare(
      `INSERT INTO claude_session_goals(endpoint_id, thread_id, objective, status, token_budget, driven_turns, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(endpoint_id, thread_id) DO UPDATE SET objective = excluded.objective, status = excluded.status, token_budget = excluded.token_budget, driven_turns = 0, updated_at = excluded.updated_at`,
    ).run(endpointId, threadId, goal.objective, status, goal.tokenBudget ?? null, now);
    return this.get(endpointId, threadId)!;
  }

  // Increment and return the auto-drive count for an active goal (backstop cap).
  recordDrivenTurn(endpointId: string, threadId: string, now: number): number {
    this.db.prepare("UPDATE claude_session_goals SET driven_turns = driven_turns + 1, updated_at = ? WHERE endpoint_id = ? AND thread_id = ?").run(now, endpointId, threadId);
    const row = this.db.prepare("SELECT driven_turns FROM claude_session_goals WHERE endpoint_id = ? AND thread_id = ?").get(endpointId, threadId) as { driven_turns: number } | undefined;
    return row ? Number(row.driven_turns) : 0;
  }

  // Update only the status (pause/resume/blocked/complete) of an existing goal.
  // Transitioning back to "active" (e.g. resume_goal after the cap paused it) resets
  // the auto-drive counter, so resume actually continues rather than instantly re-caps.
  setStatus(endpointId: string, threadId: string, status: string, now: number): ClaudeGoal | null {
    const resetDriven = status === "active" ? ", driven_turns = 0" : "";
    this.db.prepare(
      `UPDATE claude_session_goals SET status = ?, updated_at = ?${resetDriven} WHERE endpoint_id = ? AND thread_id = ?`,
    ).run(status, now, endpointId, threadId);
    return this.get(endpointId, threadId);
  }

  // Sessions on this endpoint with an actively-driving goal (for startup re-kick).
  listActive(endpointId: string): Array<{ endpointId: string; threadId: string }> {
    return (this.db.prepare("SELECT thread_id FROM claude_session_goals WHERE endpoint_id = ? AND status = 'active'").all(endpointId) as Array<{ thread_id: string }>)
      .map((row) => ({ endpointId, threadId: String(row.thread_id) }));
  }

  clear(endpointId: string, threadId: string): void {
    this.db.prepare("DELETE FROM claude_session_goals WHERE endpoint_id = ? AND thread_id = ?").run(endpointId, threadId);
  }
}
