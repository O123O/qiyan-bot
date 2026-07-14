import type { RegistryDocument } from "../registry/session-registry.ts";
import type { SessionDashboardDocument } from "../assistant/dashboard-schema.ts";
import type { LogicalFinalMessage } from "../sessions/final-messages.ts";

export interface WebReadsDeps {
  registrySnapshot(): RegistryDocument;
  dashboardSnapshot(): SessionDashboardDocument;
  listFinals(endpointId: string, threadId: string, count: number, before?: number): LogicalFinalMessage[];
  // The owner↔assistant conversation (your chat + the assistant's replies), oldest → newest.
  listOwnerConversation(endpointId: string, threadId: string, before: number | undefined, limit: number): WebConvoMessage[];
  provider(endpointId: string): "codex" | "claude";
}

export interface WebConvoMessage {
  role: "you" | "assistant";
  body: string;
  at: number;
}

// One page of messages plus whether an older page exists (a full page came back ⇒ maybe more).
export interface WebPage<T> {
  messages: T[];
  hasOlder: boolean;
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

// A worker's final messages (lease-free), oldest → newest, one page. `before` (a completedAt cursor)
// pages older for scroll-up. `hasOlder` is true when the page came back full.
export function transcript(deps: WebReadsDeps, nickname: string, limit: number, before?: number): WebPage<WebMessage> | undefined {
  const session = deps.registrySnapshot().sessions[nickname];
  if (!session) return undefined;
  const clamped = Math.max(1, Math.min(50, limit));
  const messages = deps.listFinals(session.endpoint, session.thread_id, clamped, before)
    .map((m): WebMessage => ({ turnId: m.turnId, body: m.body, completedAt: m.completedAt, terminalStatus: m.terminalStatus }));
  return { messages, hasOlder: messages.length === clamped };
}

// The QiYan conversation (your chat + the assistant's replies), lease-free, oldest → newest, one
// page. `before` pages older. Survives reloads/restarts. Whitespace-only finals are dropped.
export function assistantTranscript(deps: WebReadsDeps, limit: number, before?: number): WebPage<WebConvoMessage> {
  const assistant = deps.registrySnapshot().assistant;
  const clamped = Math.max(1, Math.min(50, limit));
  const raw = deps.listOwnerConversation(assistant.endpoint, assistant.thread_id, before, clamped);
  return { messages: raw.filter((m) => m.body.trim()), hasOlder: raw.length === clamped };
}
