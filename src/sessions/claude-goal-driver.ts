// Claude goal enforcement (the auto-drive). Codex's app-server drives a session toward
// its goal natively; a headless Claude session has no such engine, so QiYan drives it:
// after each completed turn, if the goal is still `active`, enqueue the next
// goal-pursuit turn. Termination is AGENT-driven — the worker calls the
// `set_goal_status` MCP tool to mark the goal `complete` or `blocked`, which flips the
// stored status so driving stops. A per-goal iteration cap is only a backstop for a
// model that never marks its goal done (→ `budgetLimited`, i.e. paused, not looping).
import type { ClaudeGoalStore } from "./claude-goals.ts";

export interface GoalDriveSession {
  nickname: string;
  endpointId: string;
  threadId: string;
}

export class ClaudeGoalDriver {
  constructor(private readonly deps: {
    goals: ClaudeGoalStore;
    // Deliver a goal-pursuit turn to the session (wired to the durable scheduling
    // enqueue, so it lands as the next turn and survives restart).
    enqueue(session: GoalDriveSession, message: string): void;
    // True if a goal drive is already pending for the session (dedup — one lane).
    hasPendingDrive(session: GoalDriveSession): boolean;
    now(): number;
    maxDrivenTurns: number;
    // Notified when the driver itself changes status (cap → budgetLimited) so the
    // dashboard can be refreshed.
    onStatusChanged?(session: GoalDriveSession): void;
  }) {}

  // Kick the loop when an objective is (re)set active — delivers the announcement so
  // the worker knows a goal is now in effect and how it ends.
  activate(session: GoalDriveSession): void {
    this.driveIfActive(session, true);
  }

  // Called on every completed turn for a Claude session — delivers the continue nudge.
  onTurnCompleted(session: GoalDriveSession): void {
    this.driveIfActive(session, false);
  }

  // Startup re-kick: an active goal whose drive turn was in flight at restart leaves no
  // pending schedule and gets no live turn/completed, so it would stall. Re-drive it
  // (deduped, so it's a no-op if a drive is already pending).
  resumeActive(sessions: readonly GoalDriveSession[]): void {
    for (const session of sessions) this.driveIfActive(session, true);
  }

  private driveIfActive(session: GoalDriveSession, initial: boolean): void {
    const goal = this.deps.goals.get(session.endpointId, session.threadId);
    if (goal?.status !== "active") return; // complete / blocked / paused / budgetLimited → stop
    // Dedup BEFORE burning a cap slot: at most one goal drive pending per session, so a
    // completing user/steer turn (or activate racing a completion) can't accumulate
    // drive lanes or consume extra budget.
    if (this.deps.hasPendingDrive(session)) return;
    const driven = this.deps.goals.recordDrivenTurn(session.endpointId, session.threadId, this.deps.now());
    if (driven > this.deps.maxDrivenTurns) {
      // The worker never marked the goal done — pause it (a human/assistant can resume)
      // rather than driving forever.
      this.deps.goals.setStatus(session.endpointId, session.threadId, "budgetLimited", this.deps.now());
      this.deps.onStatusChanged?.(session);
      return;
    }
    const remaining = this.deps.maxDrivenTurns - driven;
    this.deps.enqueue(session, initial ? announceMessage(goal.objective, remaining) : continueMessage(goal.objective, remaining));
  }
}

const HOW_IT_ENDS =
  'This goal will NOT stop on its own: QiYan will keep prompting you to continue after every turn until YOU end it — call the set_goal_status tool with status="complete" once the goal is fully accomplished, or status="blocked" if you cannot make progress without help.';

// Delivered when the goal is first set, so the worker knows a goal is in effect.
function announceMessage(objective: string, remaining: number): string {
  return `A goal has been set for you: ${objective}. ${HOW_IT_ENDS} Begin working toward it now. (${remaining} auto-continue turns remain before QiYan pauses this goal.)`;
}

// Delivered after each completed turn while the goal is still active.
function continueMessage(objective: string, remaining: number): string {
  return `Continue pursuing your goal: ${objective}. Take the next concrete step now. ${HOW_IT_ENDS} (${remaining} auto-continue turns remain before QiYan pauses this goal.)`;
}
