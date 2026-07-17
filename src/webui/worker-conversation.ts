import { Buffer } from "node:buffer";

// Foreground-only mapping of provider-native turn rows. The provider transcript remains the
// durable owner of this history; consumers map one requested page and do not cache the timeline.

export interface WorkerConvoRow {
  id: string;
  turnId: string;
  role: "you" | "worker";
  body: string;
  completedAt: number;
  terminalStatus: string;
  turnOrder: number;
  itemOrder: number;
  clientId?: string;
  phase?: string;
}

export interface WorkerConvoPage {
  messages: WorkerConvoRow[];
  hasOlder: boolean;
  nextCursor?: string;
}

const TERMINAL = new Set(["completed", "failed", "interrupted"]);
const toMillis = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? (number < 1e12 ? Math.round(number * 1000) : Math.round(number)) : 0;
};

const userInputText = (content: unknown): string => Array.isArray(content)
  ? content.flatMap((entry) => {
      const value = entry && typeof entry === "object" ? entry as { type?: unknown; text?: unknown } : undefined;
      return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
    }).join("").trim()
  : "";

const stripSetup = (text: string): string => text.replace(/^\s*<environment_context>[\s\S]*?<\/environment_context>\s*/iu, "").trim();

type NativeItem = { type?: string; id?: string; clientId?: string | null; text?: string; phase?: string | null; content?: unknown; itemOrder?: number };
type NativeTurn = { id?: string; status?: string; startedAt?: number | null; completedAt?: number | null; items?: NativeItem[]; turnOrder?: number };

export function openWorkerTurnIds(turns: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const raw of turns) {
    const turn = (raw ?? {}) as NativeTurn;
    if (turn.id && !TERMINAL.has(String(turn.status ?? ""))) ids.push(turn.id);
  }
  return ids;
}

export function terminalWorkerTurnIds(turns: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const raw of turns) {
    const turn = (raw ?? {}) as NativeTurn;
    if (turn.id && TERMINAL.has(String(turn.status ?? ""))) ids.push(turn.id);
  }
  return ids;
}

interface CursorKey { completedAt: number; turnOrder: number; itemOrder: number; id: string }

function compareKey(left: CursorKey, right: CursorKey): number {
  return left.completedAt - right.completedAt
    || left.turnOrder - right.turnOrder
    || left.itemOrder - right.itemOrder
    || left.id.localeCompare(right.id);
}

function encodeCursor(row: CursorKey): string {
  return Buffer.from(JSON.stringify([row.completedAt, row.turnOrder, row.itemOrder, row.id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorKey {
  if (!cursor || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error("invalid worker history cursor");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); }
  catch { throw new Error("invalid worker history cursor"); }
  if (!Array.isArray(value) || value.length !== 4
    || !Number.isSafeInteger(value[0]) || (value[0] as number) < 0
    || !Number.isSafeInteger(value[1]) || (value[1] as number) < 0
    || !Number.isSafeInteger(value[2]) || (value[2] as number) < 0
    || typeof value[3] !== "string" || !value[3] || value[3].length > 512) {
    throw new Error("invalid worker history cursor");
  }
  return { completedAt: value[0] as number, turnOrder: value[1] as number, itemOrder: value[2] as number, id: value[3] };
}

export function pageWorkerConversation(turns: readonly unknown[], count: number, before?: string): WorkerConvoPage {
  const rows = workerConversationRows(turns);
  const boundary = before === undefined ? undefined : decodeCursor(before);
  const eligible = boundary ? rows.filter((row) => compareKey(row, boundary) < 0) : rows;
  const pageSize = Math.max(1, Math.min(50, Math.trunc(count) || 20));
  const start = Math.max(0, eligible.length - pageSize);
  const messages = eligible.slice(start);
  return {
    messages,
    hasOlder: start > 0,
    ...(start > 0 && messages[0] ? { nextCursor: encodeCursor(messages[0]) } : {}),
  };
}

export function workerConversationRows(turns: readonly unknown[]): WorkerConvoRow[] {
  const rows: WorkerConvoRow[] = [];
  turns.forEach((raw, turnOrder) => {
    const turn = (raw ?? {}) as NativeTurn;
    const turnId = String(turn.id ?? "");
    const status = String(turn.status ?? "");
    const startedMs = toMillis(turn.startedAt ?? turn.completedAt);
    const completedMs = toMillis(turn.completedAt ?? turn.startedAt);
    const items = Array.isArray(turn.items) ? turn.items : [];
    const stableTurnOrder = Number.isSafeInteger(turn.turnOrder) && Number(turn.turnOrder) >= 0 ? Number(turn.turnOrder) : turnOrder;
    items.forEach((item, itemOrder) => {
      const stableItemOrder = Number.isSafeInteger(item.itemOrder) && Number(item.itemOrder) >= 0 ? Number(item.itemOrder) : itemOrder;
      const itemId = item.id ?? String(itemOrder);
      if (item.type === "userMessage") {
        const body = stripSetup(userInputText(item.content));
        if (!body) return;
        const clientId = typeof item.clientId === "string" && item.clientId ? item.clientId : undefined;
        rows.push({ id: `u:${turnId}:${itemId}`, turnId, role: "you", body, completedAt: startedMs, terminalStatus: status, turnOrder: stableTurnOrder, itemOrder: stableItemOrder, ...(clientId ? { clientId } : {}) });
        return;
      }
      if (item.type !== "agentMessage" || typeof item.text !== "string" || !item.text) return;
      const phase = typeof item.phase === "string" && item.phase ? item.phase : undefined;
      rows.push({ id: `a:${turnId}:${itemId}`, turnId, role: "worker", body: item.text, completedAt: completedMs, terminalStatus: status, turnOrder: stableTurnOrder, itemOrder: stableItemOrder, ...(phase ? { phase } : {}) });
    });
  });
  rows.sort(compareKey);
  return rows;
}
