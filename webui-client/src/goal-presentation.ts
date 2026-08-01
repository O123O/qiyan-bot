export interface WorkerGoal {
  objective: string;
  status: string;
}

export function selectedWorkerGoal(
  sessions: readonly { nickname: string; goal: WorkerGoal | null }[],
  selected: string | null,
): WorkerGoal | null {
  if (selected === null) return null;
  return sessions.find((session) => session.nickname === selected)?.goal ?? null;
}

export function formatGoalStatus(status: string): string {
  return status.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase();
}

// "2 background tasks", "1 subagent", or both — pluralised, and never showing a zero.
// This is work Claude started for itself; it is shown as a live indicator beside the
// composer rather than as conversation, because the agent reports its result as an
// ordinary turn when it finishes.
export function describeWorkerTasks(tasks: { background: number; subagents: number }): string {
  const parts: string[] = [];
  if (tasks.background > 0) parts.push(`${tasks.background} background task${tasks.background === 1 ? "" : "s"}`);
  if (tasks.subagents > 0) parts.push(`${tasks.subagents} subagent${tasks.subagents === 1 ? "" : "s"}`);
  return `${parts.join(", ")} running`;
}
