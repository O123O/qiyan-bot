import type { RegistryDocument } from "../registry/session-registry.ts";
import type { SessionDashboardDocument } from "../assistant/dashboard-schema.ts";
import type { WorkerNativeHistoryPage } from "./worker-history-reader.ts";
import type { NativeSessionView } from "../sessions/native-session-state.ts";

export interface WebReadsDeps {
  registrySnapshot(): RegistryDocument;
  dashboardSnapshot(): SessionDashboardDocument;
  assistantSession(): WebSessionSummary;
  nativeSession(endpointId: string, threadId: string, mappingId: string): NativeSessionView | undefined;
  onSessionsChanged?(listener: () => void): () => void;
  // Raw native turns for the active Web UI subscription. Production must acquire an already-ready
  // endpoint lease and pass the AbortSignal through; mapping happens only after identity revalidation.
  readWorkerTurns(endpointId: string, threadId: string, limit: number, cursor: string | undefined, signal: AbortSignal): Promise<WorkerNativeHistoryPage>;
  // The owner↔QiYan conversation (your chat + everything the owner was sent — replies, [worker]
  // relays, notices), oldest → newest.
  listOwnerConversation(before: number | undefined, limit: number): OwnerConversationMessage[];
  provider(endpointId: string): "codex" | "claude";
  // Lease-free display label: local process hostname or configured SSH alias.
  host(endpointId: string): string;
}

export interface OwnerConversationMessage {
  id: string;
  role: "you" | "assistant";
  body: string;
  at: number;
  deliveryKind?: string;
}

export interface WebConvoMessage extends Omit<OwnerConversationMessage, "deliveryKind"> {
  worker?: string; // trusted worker-delivery author, retained even after the session is removed
  origin?: string; // the worker a relayed "[worker] …" message came from (routes its file paths to that host)
}

// One page of messages plus whether an older page exists (a full page came back ⇒ maybe more).
export interface WebPage<T> {
  messages: T[];
  hasOlder: boolean;
}

export interface WebSessionSummary {
  nickname: string;
  mappingId: string;
  endpoint: string;
  provider: "codex" | "claude";
  projectDir: string;
  lifecycleState: string;
  nativeStatus: string | null;
  activeTurnId: string | null;
  model: string | null;
  effort: string | null;
  host: string;
  goal: { objective: string; status: string } | null;
}

export interface WebMessage {
  id: string;
  turnId: string;
  body: string;
  completedAt: number;
  terminalStatus: string;
  turnOrder?: number;
  itemOrder?: number;
  role?: "you"; // a prompt sent to the worker; absent ⇒ the worker's own reply
  clientId?: string;
  phase?: string;
}

// Lease-free: reads only the registry + dashboard snapshots (never the pool / thread-read).
export function listSessions(deps: WebReadsDeps): WebSessionSummary[] {
  const registry = deps.registrySnapshot();
  const dashboard = deps.dashboardSnapshot();
  return Object.entries(registry.sessions).map(([nickname, session]) => {
    const info = dashboard.sessions[nickname]?.auto_session_info;
    const native = deps.nativeSession(session.endpoint, session.thread_id, session.mapping_id);
    const goal = info?.goal ?? null;
    return {
      nickname,
      mappingId: session.mapping_id,
      endpoint: session.endpoint,
      provider: deps.provider(session.endpoint),
      projectDir: session.project_dir,
      lifecycleState: session.lifecycle_state,
      nativeStatus: native?.availability === "ready" ? native.status : null,
      activeTurnId: native?.availability === "ready" ? native.activeTurnId : null,
      model: info?.model.current ?? null,
      effort: info?.reasoning_effort.current ?? null,
      host: deps.host(session.endpoint),
      goal: goal ? { objective: goal.objective, status: goal.status } : null,
    };
  }).sort((a, b) => a.nickname.localeCompare(b.nickname));
}

export function sessionSnapshot(deps: WebReadsDeps): { sessions: WebSessionSummary[]; assistant: WebSessionSummary } {
  return { sessions: listSessions(deps), assistant: deps.assistantSession() };
}

// The QiYan conversation (your chat + the assistant's replies), lease-free, oldest → newest, one
// page. `before` pages older. Survives reloads/restarts. Rows are returned raw (whitespace included)
// so `hasOlder` and the client's `before` cursor stay consistent; the client hides blank bodies.
export function assistantTranscript(deps: WebReadsDeps, limit: number, before?: number): WebPage<WebConvoMessage> {
  const clamped = Math.max(1, Math.min(50, limit));
  const raw = deps.listOwnerConversation(before, clamped)
    .filter((message) => message.deliveryKind !== "queue_notice");
  // Delivery kind is the authority for authorship; prefix parsing alone would mislabel a QiYan reply
  // that happens to start with "[worker]". Keep presentation after unadopt, but route files only while
  // the nickname still resolves to a managed session.
  const sessions = deps.registrySnapshot().sessions;
  const messages = raw.map(({ deliveryKind, ...message }) => {
    if (message.role !== "assistant") return message;
    const worker = workerDeliveryNickname(deliveryKind, message.body);
    return worker ? { ...message, worker, ...(sessions[worker] ? { origin: worker } : {}) } : message;
  });
  return { messages, hasOlder: raw.length === clamped };
}

const WORKER_DELIVERY_KINDS = new Set(["worker_final", "collection"]);

export function workerDeliveryNickname(kind: string | undefined, body: string): string | undefined {
  if (!kind || !WORKER_DELIVERY_KINDS.has(kind)) return undefined;
  return /^\[([a-z0-9][a-z0-9_-]{0,63})(?:[^\]]*)\]/u.exec(body)?.[1];
}
