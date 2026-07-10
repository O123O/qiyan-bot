export interface AssistantTurnLifecycleNotification {
  method: "turn/started" | "turn/completed";
  params: { threadId: string; turn: { id: string; [key: string]: unknown }; [key: string]: unknown };
}

export interface AssistantItemCompletedNotification {
  method: "item/completed";
  params: {
    threadId: string;
    turnId: string;
    item: { type: "agentMessage"; id: string; text: string; phase?: string | null; [key: string]: unknown };
    completedAtMs: number;
    [key: string]: unknown;
  };
}

export type AssistantLifecycleNotification = AssistantTurnLifecycleNotification | AssistantItemCompletedNotification;

export class AssistantCompletedItems {
  private readonly byTurn = new Map<string, Map<string, AssistantItemCompletedNotification["params"]["item"]>>();

  constructor(private readonly maxTurns = 8, private readonly maxItemsPerTurn = 16) {
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || !Number.isInteger(maxItemsPerTurn) || maxItemsPerTurn < 1) {
      throw new Error("assistant completed item limits must be positive integers");
    }
  }

  record(notification: AssistantItemCompletedNotification): void {
    let items = this.byTurn.get(notification.params.turnId);
    if (!items) {
      if (this.byTurn.size >= this.maxTurns) this.byTurn.delete(this.byTurn.keys().next().value!);
      items = new Map();
      this.byTurn.set(notification.params.turnId, items);
    }
    if (!items.has(notification.params.item.id) && items.size >= this.maxItemsPerTurn) items.delete(items.keys().next().value!);
    items.set(notification.params.item.id, structuredClone(notification.params.item));
  }

  peek(turnId: string): AssistantItemCompletedNotification["params"]["item"][] {
    const items = this.byTurn.get(turnId);
    return items ? [...items.values()] : [];
  }

  discard(turnId: string): void { this.byTurn.delete(turnId); }

  clear(): void { this.byTurn.clear(); }
}

export function parseAssistantLifecycleNotification(method: string, params: unknown): AssistantLifecycleNotification | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const value = params as Record<string, unknown>;
  if (method === "item/completed") {
    if (typeof value.threadId !== "string" || typeof value.turnId !== "string" || typeof value.completedAtMs !== "number") return undefined;
    if (!value.item || typeof value.item !== "object" || Array.isArray(value.item)) return undefined;
    const item = value.item as Record<string, unknown>;
    if (item.type !== "agentMessage" || typeof item.id !== "string" || typeof item.text !== "string" || !item.text
      || (item.phase !== "final_answer" && item.phase != null)) return undefined;
    return { method, params: structuredClone(params) as AssistantItemCompletedNotification["params"] };
  }
  if (method !== "turn/started" && method !== "turn/completed") return undefined;
  if (typeof value.threadId !== "string" || !value.turn || typeof value.turn !== "object" || Array.isArray(value.turn)) return undefined;
  const turn = value.turn as Record<string, unknown>;
  if (typeof turn.id !== "string") return undefined;
  return { method, params: structuredClone(params) as AssistantTurnLifecycleNotification["params"] };
}

export class AssistantLifecycleBuffer {
  private readonly pending: AssistantTurnLifecycleNotification[] = [];
  private ready = false;

  constructor(private readonly maxPending = 64) {
    if (!Number.isInteger(maxPending) || maxPending < 1) throw new Error("assistant lifecycle buffer limit must be positive");
  }

  async accept(notification: AssistantTurnLifecycleNotification, handle: (notification: AssistantTurnLifecycleNotification) => Promise<void>): Promise<void> {
    if (this.ready) {
      await handle(notification);
      return;
    }
    if (this.pending.length >= this.maxPending) throw new Error("assistant lifecycle notification buffer is full");
    this.pending.push(notification);
  }

  async activate(handle: (notification: AssistantTurnLifecycleNotification) => Promise<void>): Promise<void> {
    while (this.pending.length > 0) await handle(this.pending.shift()!);
    this.ready = true;
  }

  clear(): void {
    this.pending.length = 0;
    this.ready = false;
  }

  get size(): number { return this.pending.length; }
}
