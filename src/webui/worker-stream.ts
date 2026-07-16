import type { RegistryDocument } from "../registry/session-registry.ts";
import type { WebBus } from "./web-bus.ts";

export type WorkerChatItem =
  | { type: "user-message"; id: string; clientId?: string; text: string }
  | { type: "agent-message"; id: string; text: string; phase?: string };

export type WorkerChatEvent =
  | { kind: "turn-started"; turnId: string; status?: string }
  | { kind: "turn-completed"; turnId: string; status?: string }
  | { kind: "item-started" | "item-completed"; turnId: string; item: WorkerChatItem; atMs?: number }
  | { kind: "agent-message-delta"; turnId: string; itemId: string; delta: string };

const METHODS = new Set(["turn/started", "turn/completed", "item/started", "item/completed", "item/agentMessage/delta"]);

const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

function inputText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.flatMap((entry) => {
    const value = record(entry);
    return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("").replace(/^\s*<environment_context>[\s\S]*?<\/environment_context>\s*/iu, "").trim();
}

function mapItem(value: unknown): WorkerChatItem | undefined {
  const item = record(value);
  const id = string(item?.id);
  if (!item || !id) return undefined;
  if (item.type === "userMessage") {
    const text = inputText(item.content);
    if (!text) return undefined;
    const clientId = string(item.clientId);
    return { type: "user-message", id, ...(clientId ? { clientId } : {}), text };
  }
  if (item.type === "agentMessage" && typeof item.text === "string") {
    const phase = string(item.phase);
    return { type: "agent-message", id, text: item.text, ...(phase ? { phase } : {}) };
  }
  return undefined;
}

function normalize(method: string, params: Record<string, unknown>): WorkerChatEvent | undefined {
  const turn = record(params.turn);
  const turnId = method.startsWith("turn/") ? string(turn?.id) : string(params.turnId);
  if (!turnId) return undefined;
  if (method === "turn/started" || method === "turn/completed") {
    const status = string(turn?.status);
    return { kind: method === "turn/started" ? "turn-started" : "turn-completed", turnId, ...(status ? { status } : {}) };
  }
  if (method === "item/agentMessage/delta") {
    const itemId = string(params.itemId), delta = string(params.delta);
    return itemId && delta !== undefined ? { kind: "agent-message-delta", turnId, itemId, delta } : undefined;
  }
  const item = mapItem(params.item);
  if (!item) return undefined;
  const atMs = number(method === "item/started" ? params.startedAtMs : params.completedAtMs);
  return { kind: method === "item/started" ? "item-started" : "item-completed", turnId, item, ...(atMs === undefined ? {} : { atMs }) };
}

export interface WorkerStream {
  handleNotification(endpointId: string, method: string, params: unknown): void;
}

// The Web UI is a non-owning observer. Its failure must never consume or block the core notification
// path (session observation, final relay, and every chat adapter continue independently).
export function offerWorkerNotification(stream: WorkerStream, endpointId: string, method: string, params: unknown): void {
  try { stream.handleNotification(endpointId, method, params); }
  catch { /* detailed Web UI flow is best-effort and never owns routing */ }
}

export function createWorkerStream(deps: { bus: WebBus; registrySnapshot(): RegistryDocument }): WorkerStream {
  return {
    handleNotification(endpointId, method, rawParams) {
      if (!METHODS.has(method)) return;
      const params = record(rawParams);
      const threadId = string(params?.threadId);
      if (!params || !threadId || !deps.bus.hasWorkerSubscriber(endpointId, threadId)) return;

      const sessions = deps.registrySnapshot().sessions;
      deps.bus.pruneWorkerSubscriptions(endpointId, threadId, (subscription) => {
        const current = sessions[subscription.nickname];
        return current?.endpoint === endpointId && current.thread_id === threadId && current.mapping_id === subscription.mappingId;
      });
      if (!deps.bus.hasWorkerSubscriber(endpointId, threadId)) return;
      const event = normalize(method, params);
      if (event) deps.bus.publishWorker(endpointId, threadId, event);
    },
  };
}
