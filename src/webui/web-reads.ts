import type { RegistryDocument } from "../registry/session-registry.ts";
import type { SessionDashboardDocument } from "../assistant/dashboard-schema.ts";
import type { LogicalFinalMessage } from "../sessions/final-messages.ts";

export interface WebReadsDeps {
  registrySnapshot(): RegistryDocument;
  dashboardSnapshot(): SessionDashboardDocument;
  listFinals(endpointId: string, threadId: string, count: number): LogicalFinalMessage[];
  provider(endpointId: string): "codex" | "claude";
}

export interface WebSessionSummary {
  nickname: string;
  endpoint: string;
  provider: "codex" | "claude";
  projectDir: string;
  lifecycleState: string;
  nativeStatus: string | null;
  activeTurnId: string | null;
  model: string | null;
  goal: { objective: string; status: string } | null;
}

export interface WebMessage {
  turnId: string;
  body: string;
  completedAt: number;
  terminalStatus: string;
}

// Lease-free: reads only the registry + dashboard snapshots (never the pool / thread-read).
export function listSessions(deps: WebReadsDeps): WebSessionSummary[] {
  const registry = deps.registrySnapshot();
  const dashboard = deps.dashboardSnapshot();
  return Object.entries(registry.sessions).map(([nickname, session]) => {
    const info = dashboard.sessions[nickname]?.auto_session_info;
    const goal = info?.goal ?? null;
    return {
      nickname,
      endpoint: session.endpoint,
      provider: deps.provider(session.endpoint),
      projectDir: session.project_dir,
      lifecycleState: session.lifecycle_state,
      nativeStatus: info?.native_status ?? null,
      activeTurnId: info?.active_turn_id ?? null,
      model: info?.model.current ?? null,
      goal: goal ? { objective: goal.objective, status: goal.status } : null,
    };
  }).sort((a, b) => a.nickname.localeCompare(b.nickname));
}

// A worker's final messages (lease-free), oldest → newest. `count` is clamped to the store's 1..20.
export function transcript(deps: WebReadsDeps, nickname: string, count: number): WebMessage[] | undefined {
  const session = deps.registrySnapshot().sessions[nickname];
  if (!session) return undefined;
  return finals(deps, session.endpoint, session.thread_id, count);
}

// The assistant's own final messages (its replies), lease-free, oldest → newest — a persisted
// history for the QiYan tab that survives page reloads and restarts.
export function assistantTranscript(deps: WebReadsDeps, count: number): WebMessage[] {
  const assistant = deps.registrySnapshot().assistant;
  return finals(deps, assistant.endpoint, assistant.thread_id, count);
}

function finals(deps: WebReadsDeps, endpoint: string, threadId: string, count: number): WebMessage[] {
  const clamped = Math.max(1, Math.min(20, count));
  return deps.listFinals(endpoint, threadId, clamped)
    .map((message) => ({ turnId: message.turnId, body: message.body, completedAt: message.completedAt, terminalStatus: message.terminalStatus }));
}
