import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcResponseError } from "../../src/app-server/rpc-client.ts";
import {
  createHistoryScanBudget,
  HistoryScanBudgetExhaustedError,
  ThreadHistoryReader,
} from "../../src/app-server/thread-history.ts";
import { AppError } from "../../src/core/errors.ts";

test("descending suffix buffers pages until its anchor is proven", async () => {
  const calls: unknown[] = [];
  const pages = new Map<string, unknown>([
    ["", { data: [{ id: "t4", status: "completed", itemsView: "notLoaded", items: [] }, { id: "t3", status: "completed", itemsView: "notLoaded", items: [] }], nextCursor: "page-2", backwardsCursor: "back-1" }],
    ["page-2", { data: [{ id: "t2", status: "completed", itemsView: "notLoaded", items: [] }, { id: "t1", status: "completed", itemsView: "notLoaded", items: [] }], nextCursor: null, backwardsCursor: "back-2" }],
  ]);
  const reader = new ThreadHistoryReader(async (_method, params) => {
    calls.push(params);
    return pages.get(String((params as any).cursor ?? ""));
  });

  const suffix = await reader.descendingSuffix("thread", "t2", createHistoryScanBudget());

  assert.equal(suffix.anchorFound, true);
  assert.equal(suffix.exhausted, true);
  assert.deepEqual(suffix.turns.map((turn) => turn.id), ["t4", "t3"]);
  assert.equal(calls.length, 2);
});

test("missing anchors and malformed pagination remain uncertain without exposing turns", async () => {
  const missing = new ThreadHistoryReader(async () => ({
    data: [{ id: "t2", status: "completed", itemsView: "notLoaded", items: [] }],
    nextCursor: null,
    backwardsCursor: "back",
  }));
  const suffix = await missing.descendingSuffix("thread", "absent", createHistoryScanBudget());
  assert.equal(suffix.anchorFound, false);
  assert.deepEqual(suffix.turns, []);

  const repeated = new ThreadHistoryReader(async () => ({
    data: [{ id: "t2", status: "completed", itemsView: "notLoaded", items: [] }],
    nextCursor: "same",
    backwardsCursor: "back",
  }));
  await assert.rejects(
    repeated.descendingSuffix("thread", undefined, createHistoryScanBudget()),
    (error: unknown) => error instanceof AppError && error.code === "OPERATION_UNCERTAIN",
  );
});

test("the exact pre-message turns-list error is an empty history, not a failed worker", async () => {
  const reader = new ThreadHistoryReader(async () => {
    throw new JsonRpcResponseError(-32600, "thread empty is not materialized yet; thread/turns/list is unavailable before first user message");
  });

  assert.deepEqual(await reader.latestTurn("empty"), undefined);
  assert.deepEqual(await reader.descendingSuffix("empty", undefined, createHistoryScanBudget()), { turns: [], anchorFound: true, exhausted: true });
});

test("exact turn reads locate metadata first and load only the target turn", async () => {
  const calls: Array<{ method: string; params: any }> = [];
  const reader = new ThreadHistoryReader(async (method, params: any) => {
    calls.push({ method, params });
    assert.equal(method, "thread/turns/list");
    if (params.itemsView === "full") return {
      data: [{
        id: "target", status: "completed", itemsView: "full",
        items: [
          { type: "reasoning", id: "r", summary: [], content: [] },
          { type: "userMessage", id: "u", clientId: "client", content: [] },
          { type: "agentMessage", id: "a", text: "done", phase: "final_answer", memoryCitation: null },
        ],
      }],
      nextCursor: "after-target",
      backwardsCursor: "before-target",
    };
    if (params.limit === 1) return {
      data: [{ id: "newer", status: "completed", itemsView: "notLoaded", items: [] }],
      nextCursor: "before-target",
      backwardsCursor: null,
    };
    return {
      data: [
        { id: "newer", status: "completed", itemsView: "notLoaded", items: [] },
        { id: "target", status: "completed", itemsView: "notLoaded", items: [] },
        { id: "older", status: "completed", itemsView: "notLoaded", items: [] },
      ],
      nextCursor: null,
      backwardsCursor: null,
    };
  });

  const items = await reader.exactTurnItems("thread", "target", { budget: createHistoryScanBudget() });
  assert.equal(items.complete, true);
  assert.equal(items.firstUserMessage?.clientId, "client");
  assert.deepEqual(items.items.map((item) => item.id), ["r", "u", "a"]);
  assert.deepEqual(calls.map(({ method, params }) => ({ method, limit: params.limit, cursor: params.cursor, itemsView: params.itemsView })), [
    { method: "thread/turns/list", limit: 128, cursor: undefined, itemsView: "notLoaded" },
    { method: "thread/turns/list", limit: 1, cursor: undefined, itemsView: "notLoaded" },
    { method: "thread/turns/list", limit: 1, cursor: "before-target", itemsView: "full" },
  ]);
});

test("multi-page scans terminate with an explicit budget-exhausted outcome", async () => {
  const reader = new ThreadHistoryReader(async (_method, params) => ({
    data: [{ id: String((params as any).cursor ?? "first"), status: "completed", itemsView: "notLoaded", items: [] }],
    nextCursor: (params as any).cursor ? "third" : "second",
    backwardsCursor: null,
  }));
  await assert.rejects(
    reader.descendingSuffix("thread", "absent", createHistoryScanBudget({ maxPages: 1 })),
    (error: unknown) => error instanceof HistoryScanBudgetExhaustedError,
  );
});

test("inclusive history recovery starts at the first observed managed turn", async () => {
  const turns = ["newest", "first-managed", "historical"].map((id) => ({
    id, status: "completed", itemsView: "notLoaded", items: [],
  }));
  const reader = new ThreadHistoryReader(async () => ({ data: turns, nextCursor: null, backwardsCursor: null }));

  const suffix = await reader.descendingFrom("thread", "first-managed", createHistoryScanBudget());

  assert.equal(suffix.anchorFound, true);
  assert.deepEqual(suffix.turns.map((turn) => turn.id), ["newest", "first-managed"]);
});

test("single pages reject duplicate rows and non-advancing cursors, but allow an empty window", async () => {
  const duplicate = new ThreadHistoryReader(async () => ({
    data: [
      { id: "same", status: "completed", itemsView: "notLoaded", items: [] },
      { id: "same", status: "completed", itemsView: "notLoaded", items: [] },
    ],
    nextCursor: null,
    backwardsCursor: null,
  }));
  await assert.rejects(duplicate.turnsPage("thread", { limit: 2, sortDirection: "asc", itemsView: "notLoaded" }), (error: unknown) => (
    error instanceof AppError && error.code === "OPERATION_UNCERTAIN"
  ));

  // An empty page WITH a cursor is legitimate progress: a reader paging a native transcript by
  // byte window can land entirely inside one oversized turn, which contains no turn boundary.
  // Rejecting it made such a session unreadable rather than slow, and every walker over these
  // pages is separately bounded, so a run of empty windows ends on its own.
  const empty = new ThreadHistoryReader(async () => ({ data: [], nextCursor: "more", backwardsCursor: null }));
  assert.deepEqual(
    (await empty.turnsPage("thread", { limit: 1, sortDirection: "desc", itemsView: "notLoaded" })).nextCursor,
    "more",
  );

  const stuck = new ThreadHistoryReader(async () => ({
    data: [{ id: "turn", status: "completed", itemsView: "notLoaded", items: [] }],
    nextCursor: "cursor",
    backwardsCursor: null,
  }));
  await assert.rejects(stuck.turnsPage("thread", {
    cursor: "cursor", limit: 1, sortDirection: "desc", itemsView: "notLoaded",
  }));
});

test("unsupported provider paging fails closed without falling back to a full thread read", async () => {
  const calls: string[] = [];
  const reader = new ThreadHistoryReader(async (method) => {
    calls.push(method);
    throw new AppError("UNSUPPORTED_CAPABILITY", "provider paging is unavailable");
  });

  await assert.rejects(reader.turnsPage("thread", {
    cursor: "not+a+base64url+cursor", limit: 1, sortDirection: "desc", itemsView: "notLoaded",
  }), (error: unknown) => error instanceof AppError && error.code === "UNSUPPORTED_CAPABILITY");
  assert.deepEqual(calls, ["thread/turns/list"]);
});

test("latestTurn steps over turn-less windows rather than reporting an empty thread", async () => {
  // A reader paging a native transcript by byte window lands entirely inside one oversized turn
  // and legitimately returns no turns for that window. Taking a single page would read that as
  // "this thread has no turns" — a confident wrong answer feeding active-turn identity, recovery
  // baselines and delivery boundaries, where a false empty baseline makes every historical turn a
  // delivery candidate.
  const cursors: Array<string | undefined> = [];
  const walked = new ThreadHistoryReader(async (_method, params) => {
    const cursor = (params as { cursor?: string }).cursor;
    cursors.push(cursor);
    if (cursor === undefined) return { data: [], nextCursor: "window-1", backwardsCursor: null };
    if (cursor === "window-1") return { data: [], nextCursor: "window-2", backwardsCursor: null };
    return {
      data: [{ id: "newest", status: "completed", itemsView: "notLoaded", items: [] }],
      nextCursor: null,
      backwardsCursor: null,
    };
  });
  assert.equal((await walked.latestTurn("thread"))?.id, "newest");
  assert.deepEqual(cursors, [undefined, "window-1", "window-2"]);

  // A thread that really has no turns still answers undefined, not an error.
  const genuinelyEmpty = new ThreadHistoryReader(async () => ({ data: [], nextCursor: null, backwardsCursor: null }));
  assert.equal(await genuinelyEmpty.latestTurn("thread"), undefined);

  // And a walk that never finds one fails the way its callers already handle: the classified
  // budget error they degrade on, never a silent empty answer.
  let hops = 0;
  const endless = new ThreadHistoryReader(async () => {
    hops += 1;
    return { data: [], nextCursor: `window-${hops}`, backwardsCursor: null };
  });
  await assert.rejects(endless.latestTurn("thread"), (error: unknown) => error instanceof HistoryScanBudgetExhaustedError);
  assert.ok(hops <= 8, `the walk must stay bounded, took ${hops}`);
});
