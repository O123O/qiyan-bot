import { Buffer } from "node:buffer";
import { AppError } from "../core/errors.ts";
import { isExactThreadTurnsNotMaterialized } from "./thread-errors.ts";

export type ThreadItemsView = "full" | "summary" | "notLoaded";

export interface ThreadHistoryItem {
  type: string;
  id: string;
  clientId?: string | null;
  text?: string;
  phase?: string | null;
  [key: string]: unknown;
}

export interface ThreadHistoryTurn {
  id: string;
  status: string;
  itemsView: ThreadItemsView;
  items: ThreadHistoryItem[];
  startedAt?: number | null;
  completedAt?: number | null;
  [key: string]: unknown;
}

export interface ThreadHistoryPage<T> {
  data: T[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

type HistoryRequest = (method: string, params: unknown) => Promise<unknown>;

export interface ExactTurnItems {
  items: ThreadHistoryItem[];
  firstUserMessage?: ThreadHistoryItem;
  complete: boolean;
  turn: ThreadHistoryTurn;
}

export interface HistoryScanLimits {
  maxPages: number;
  maxTurns: number;
  maxItems: number;
  maxBytes: number;
  deadlineAt: number;
}

export class HistoryScanBudgetExhaustedError extends AppError {
  constructor() {
    super("OPERATION_UNCERTAIN", "native history scan budget was exhausted");
    this.name = "HistoryScanBudgetExhaustedError";
  }
}

export class HistoryScanBudget {
  private pages = 0;
  private turns = 0;
  private items = 0;
  private bytes = 0;

  constructor(private readonly limits: HistoryScanLimits) {}

  consume(kind: "turns" | "items", values: readonly unknown[]): void {
    this.pages += 1;
    if (kind === "turns") this.turns += values.length;
    else this.items += values.length;
    this.bytes += Buffer.byteLength(JSON.stringify(values), "utf8");
    if (Date.now() > this.limits.deadlineAt
      || this.pages > this.limits.maxPages
      || this.turns > this.limits.maxTurns
      || this.items > this.limits.maxItems
      || this.bytes > this.limits.maxBytes) {
      throw new HistoryScanBudgetExhaustedError();
    }
  }
}

export function createHistoryScanBudget(overrides: Partial<Omit<HistoryScanLimits, "deadlineAt">> & { deadlineAt?: number } = {}): HistoryScanBudget {
  return new HistoryScanBudget({
    maxPages: overrides.maxPages ?? 8,
    maxTurns: overrides.maxTurns ?? 512,
    maxItems: overrides.maxItems ?? 2_048,
    maxBytes: overrides.maxBytes ?? 4 * 1024 * 1024,
    deadlineAt: overrides.deadlineAt ?? Date.now() + 30_000,
  });
}

export function isHistoryScanBudgetExhausted(error: unknown): error is HistoryScanBudgetExhaustedError {
  return error instanceof HistoryScanBudgetExhaustedError;
}

export class ThreadHistoryReader {
  constructor(private readonly request: HistoryRequest) {}

  async latestTurn(threadId: string): Promise<ThreadHistoryTurn | undefined> {
    const page = await this.turnsPage(threadId, {
      limit: 1,
      sortDirection: "desc",
      itemsView: "notLoaded",
    });
    return page.data[0];
  }

  async turnsPage(
    threadId: string,
    params: { cursor?: string; limit: number; sortDirection: "asc" | "desc"; itemsView: ThreadItemsView },
  ): Promise<ThreadHistoryPage<ThreadHistoryTurn>> {
    try {
      const page = turnPage(await this.request("thread/turns/list", { threadId, ...params }));
      validateSinglePage(page, params.cursor, "turn");
      return page;
    } catch (error) {
      if (!isExactThreadTurnsNotMaterialized(error, threadId)) throw error;
      return { data: [], nextCursor: null, backwardsCursor: null };
    }
  }

  async findTurn(threadId: string, turnId: string, budget: HistoryScanBudget): Promise<ThreadHistoryTurn | undefined> {
    let found: ThreadHistoryTurn | undefined;
    await this.walkTurns(threadId, {
      sortDirection: "desc",
      itemsView: "notLoaded",
      budget,
      onTurn: (turn) => {
        if (turn.id !== turnId) return false;
        found = turn;
        return true;
      },
    });
    return found;
  }

  async descendingSuffix(
    threadId: string,
    anchorTurnId: string | undefined,
    budget: HistoryScanBudget,
  ): Promise<{ turns: ThreadHistoryTurn[]; anchorFound: boolean; exhausted: boolean }> {
    const buffered: ThreadHistoryTurn[] = [];
    let anchorFound = anchorTurnId === undefined;
    const scan = await this.walkTurns(threadId, {
      sortDirection: "desc",
      itemsView: "notLoaded",
      budget,
      onTurn: (turn) => {
        if (turn.id === anchorTurnId) {
          anchorFound = true;
          return true;
        }
        buffered.push(turn);
        return false;
      },
    });
    return {
      turns: anchorFound ? buffered : [],
      anchorFound,
      exhausted: scan.exhausted,
    };
  }

  async descendingFrom(
    threadId: string,
    firstTurnId: string,
    budget: HistoryScanBudget,
  ): Promise<{ turns: ThreadHistoryTurn[]; anchorFound: boolean; exhausted: boolean }> {
    const buffered: ThreadHistoryTurn[] = [];
    let anchorFound = false;
    const scan = await this.walkTurns(threadId, {
      sortDirection: "desc",
      itemsView: "notLoaded",
      budget,
      onTurn: (turn) => {
        buffered.push(turn);
        if (turn.id !== firstTurnId) return false;
        anchorFound = true;
        return true;
      },
    });
    return {
      turns: anchorFound ? buffered : [],
      anchorFound,
      exhausted: scan.exhausted,
    };
  }

  async exactTurnItems(
    threadId: string,
    turnId: string,
    options: { budget: HistoryScanBudget },
  ): Promise<ExactTurnItems> {
    const turn = await this.exactFullTurn(threadId, turnId, options.budget);
    return { ...exactItems(turn.items, true), turn };
  }

  private async exactFullTurn(threadId: string, turnId: string, budget: HistoryScanBudget): Promise<ThreadHistoryTurn> {
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      if (cursor !== undefined && !rememberCursor(seenCursors, cursor)) throw uncertain("thread turn pagination repeated a cursor");
      const page = await this.turnsPage(threadId, {
        ...(cursor === undefined ? {} : { cursor }),
        limit: 128,
        sortDirection: "desc",
        itemsView: "notLoaded",
      });
      budget.consume("turns", page.data);
      validatePageProgress(page, cursor);
      const index = page.data.findIndex((turn) => turn.id === turnId);
      if (index >= 0) {
        let targetCursor = cursor;
        if (index > 0) {
          const prefix = await this.turnsPage(threadId, {
            ...(cursor === undefined ? {} : { cursor }),
            limit: index,
            sortDirection: "desc",
            itemsView: "notLoaded",
          });
          budget.consume("turns", prefix.data);
          if (prefix.data.length !== index || prefix.nextCursor === null
            || prefix.data.some((turn, position) => turn.id !== page.data[position]?.id)) {
            throw uncertain("thread history changed while locating the exact turn");
          }
          targetCursor = prefix.nextCursor;
        }
        const full = await this.turnsPage(threadId, {
          ...(targetCursor === undefined ? {} : { cursor: targetCursor }),
          limit: 1,
          sortDirection: "desc",
          itemsView: "full",
        });
        budget.consume("turns", full.data);
        const target = full.data[0];
        if (full.data.length !== 1 || target?.id !== turnId || target.itemsView !== "full") {
          throw uncertain("thread history changed before the exact turn was loaded");
        }
        return target;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    throw uncertain("the exact turn is absent from authoritative history");
  }

  private async walkTurns(
    threadId: string,
    options: {
      sortDirection: "asc" | "desc";
      itemsView: ThreadItemsView;
      pageLimit?: number;
      budget: HistoryScanBudget;
      onTurn(turn: ThreadHistoryTurn): boolean;
    },
  ): Promise<{ exhausted: boolean }> {
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      if (cursor !== undefined && !rememberCursor(seenCursors, cursor)) throw uncertain("thread turn pagination repeated a cursor");
      const page = await this.turnsPage(threadId, {
        ...(cursor === undefined ? {} : { cursor }),
        limit: options.pageLimit ?? 128,
        sortDirection: options.sortDirection,
        itemsView: options.itemsView,
      });
      options.budget.consume("turns", page.data);
      validatePageProgress(page, cursor);
      for (const turn of page.data) {
        if (!rememberId(seenIds, turn.id)) throw uncertain("thread turn pagination repeated a turn");
        if (options.onTurn(turn)) return { exhausted: page.nextCursor === null };
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return { exhausted: true };
  }

}

function exactItems(items: ThreadHistoryItem[], complete: boolean): Omit<ExactTurnItems, "turn"> {
  const firstUserMessage = items.find((item) => item.type === "userMessage");
  return { items, ...(firstUserMessage ? { firstUserMessage } : {}), complete };
}

function turnPage(value: unknown): ThreadHistoryPage<ThreadHistoryTurn> {
  const page = basePage(value);
  return { ...page, data: page.data.map((turn) => historyTurn(turn)) };
}

function basePage(value: unknown): ThreadHistoryPage<unknown> {
  if (!record(value) || !Array.isArray(value.data)) throw uncertain("thread history returned an invalid page");
  const nextCursor = nullableCursor(value.nextCursor);
  const backwardsCursor = nullableCursor(value.backwardsCursor);
  return { data: value.data, nextCursor, backwardsCursor };
}

function historyTurn(value: unknown): ThreadHistoryTurn {
  if (!record(value) || typeof value.id !== "string" || value.id.length === 0 || typeof value.status !== "string") {
    throw uncertain("thread history returned an invalid turn");
  }
  const itemsView = value.itemsView;
  if (itemsView !== "full" && itemsView !== "summary" && itemsView !== "notLoaded") {
    throw uncertain("thread history returned an invalid item projection");
  }
  if (!Array.isArray(value.items)) throw uncertain("thread history returned invalid turn items");
  return { ...value, id: value.id, status: value.status, itemsView, items: value.items.map(historyItem) } as ThreadHistoryTurn;
}

function historyItem(value: unknown): ThreadHistoryItem {
  if (!record(value) || typeof value.type !== "string" || typeof value.id !== "string" || value.id.length === 0) {
    throw uncertain("thread history returned an invalid item");
  }
  return value as ThreadHistoryItem;
}

function nullableCursor(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) throw uncertain("thread history returned an invalid cursor");
  return value;
}

function validatePageProgress(page: ThreadHistoryPage<unknown>, requestCursor: string | undefined): void {
  if (page.data.length === 0 && page.nextCursor !== null) throw uncertain("empty thread history page had a continuation cursor");
  if (requestCursor !== undefined && page.nextCursor === requestCursor) throw uncertain("thread history cursor did not advance");
}

function validateSinglePage(
  page: ThreadHistoryPage<{ id: string }>,
  requestCursor: string | undefined,
  kind: "turn" | "item",
): void {
  validatePageProgress(page, requestCursor);
  const ids = new Set<string>();
  for (const value of page.data) {
    if (!rememberId(ids, value.id)) throw uncertain(`thread ${kind} page repeated a ${kind}`);
  }
}

function rememberCursor(seen: Set<string>, value: string): boolean {
  if (seen.has(value)) return false;
  seen.add(value);
  return true;
}

function rememberId(seen: Set<string>, value: string): boolean {
  if (seen.has(value)) return false;
  seen.add(value);
  return true;
}

function record(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uncertain(message: string): AppError {
  return new AppError("OPERATION_UNCERTAIN", message);
}
