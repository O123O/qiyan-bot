import type { RegistryDocument } from "../registry/session-registry.ts";
import type { SessionDashboardDocument } from "../assistant/dashboard-schema.ts";
import type { WorkerConvoRow } from "../sessions/worker-conversation.ts";

export interface WebReadsDeps {
  registrySnapshot(): RegistryDocument;
  dashboardSnapshot(): SessionDashboardDocument;
  // A worker's two-sided transcript (your prompts + its replies), read from its native codex/claude
  // session — QiYan stores nothing for workers.
  readWorkerConversation(endpointId: string, threadId: string, count: number, before?: number): Promise<WorkerConvoRow[]>;
  // The owner↔QiYan conversation (your chat + everything the owner was sent — replies, [worker]
  // relays, notices), oldest → newest.
  listOwnerConversation(before: number | undefined, limit: number): WebConvoMessage[];
  provider(endpointId: string): "codex" | "claude";
}

export interface WebConvoMessage {
  id: string;
  role: "you" | "assistant";
  body: string;
  at: number;
  origin?: string; // the worker a relayed "[worker] …" message came from (routes its file paths to that host)
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
  id: string;
  turnId: string;
  body: string;
  completedAt: number;
  terminalStatus: string;
  role?: "you"; // a prompt sent to the worker; absent ⇒ the worker's own reply
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

// A worker's two-sided transcript from its native session (your prompts + its replies), oldest →
// newest, one page. `before` (a completedAt cursor) pages older for scroll-up; `hasOlder` is true when
// the page came back full. Returns undefined for an unknown session (→ 404).
export async function transcript(deps: WebReadsDeps, nickname: string, limit: number, before?: number): Promise<WebPage<WebMessage> | undefined> {
  const session = deps.registrySnapshot().sessions[nickname];
  if (!session) return undefined;
  const clamped = Math.max(1, Math.min(50, limit));
  const messages = (await deps.readWorkerConversation(session.endpoint, session.thread_id, clamped, before))
    .map((r): WebMessage => ({ id: r.id, turnId: r.turnId, body: r.body, completedAt: r.completedAt, terminalStatus: r.terminalStatus, ...(r.role === "you" ? { role: "you" as const } : {}) }));
  return { messages, hasOlder: messages.length === clamped };
}

// The QiYan conversation (your chat + the assistant's replies), lease-free, oldest → newest, one
// page. `before` pages older. Survives reloads/restarts. Rows are returned raw (whitespace included)
// so `hasOlder` and the client's `before` cursor stay consistent; the client hides blank bodies.
export function assistantTranscript(deps: WebReadsDeps, limit: number, before?: number): WebPage<WebConvoMessage> {
  const clamped = Math.max(1, Math.min(50, limit));
  const raw = deps.listOwnerConversation(before, clamped);
  // Tag each relayed "[worker …] …" message with a validated origin worker (only the LEADING prefix is
  // trusted; the relay always prepends it) so the client routes its file paths to that worker's host.
  const sessions = deps.registrySnapshot().sessions;
  const messages = raw.map((m) => {
    if (m.role !== "assistant") return m;
    const match = /^\[([a-z0-9][a-z0-9_-]{0,63})(?:[^\]]*)\]/u.exec(m.body);
    return match && sessions[match[1]!] ? { ...m, origin: match[1]! } : m;
  });
  return { messages, hasOlder: raw.length === clamped };
}
