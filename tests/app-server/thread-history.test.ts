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

test("exact item paging preserves multiple finals and scans past non-user leading items", async () => {
  const reader = new ThreadHistoryReader(async (method, params) => {
    assert.equal(method, "thread/items/list");
    if (!(params as any).cursor) return {
      data: [
        { type: "reasoning", id: "r", summary: [], content: [] },
        { type: "userMessage", id: "u", clientId: "client", content: [] },
      ],
      nextCursor: "next",
      backwardsCursor: "back",
    };
    return {
      data: [
        { type: "agentMessage", id: "a1", text: "one", phase: "final_answer", memoryCitation: null },
        { type: "agentMessage", id: "a2", text: "two", phase: "final_answer", memoryCitation: null },
      ],
      nextCursor: null,
      backwardsCursor: "back-2",
    };
  });

  const items = await reader.exactTurnItems("thread", "turn", { budget: createHistoryScanBudget() });
  assert.equal(items.complete, true);
  assert.equal(items.firstUserMessage?.clientId, "client");
  assert.deepEqual(items.items.filter((item) => item.type === "agentMessage").map((item: any) => item.text), ["one", "two"]);

});

test("legacy item stores degrade only user/agent recovery to one summary turn", async () => {
  const calls: string[] = [];
  const reader = new ThreadHistoryReader(async (method) => {
    calls.push(method);
    if (method === "thread/items/list") {
      throw new JsonRpcResponseError(-32601, "thread/items/list is not supported yet");
    }
    return {
      data: [{
        id: "turn", status: "completed", itemsView: "summary",
        items: [
          { type: "userMessage", id: "u", clientId: "client", content: [] },
          { type: "agentMessage", id: "a", text: "last", phase: "final_answer", memoryCitation: null },
        ],
      }],
      nextCursor: null,
      backwardsCursor: "back",
    };
  });

  const items = await reader.exactTurnItems("thread", "turn", { budget: createHistoryScanBudget(), allowLegacySummary: true });
  assert.equal(items.complete, false);
  assert.equal(items.firstUserMessage?.clientId, "client");
  assert.deepEqual(items.items.map((item) => item.id), ["u", "a"]);
  assert.deepEqual(calls, ["thread/items/list", "thread/turns/list"]);

  await assert.rejects(
    reader.exactTurnItems("thread", "turn", { budget: createHistoryScanBudget() }),
    (error: unknown) => error instanceof AppError && error.code === "OPERATION_UNCERTAIN",
  );
});

test("turn ordering distinguishes older targets from missing history", async () => {
  const turns = ["new", "anchor", "old"].map((id) => ({
    id, status: "completed", itemsView: "notLoaded", items: [],
  }));
  const reader = new ThreadHistoryReader(async () => ({ data: turns, nextCursor: null, backwardsCursor: null }));
  assert.equal(await reader.classifyTurnAgainstAnchor("thread", "new", "anchor", createHistoryScanBudget()), "newer");
  assert.equal(await reader.classifyTurnAgainstAnchor("thread", "anchor", "anchor", createHistoryScanBudget()), "anchor");
  assert.equal(await reader.classifyTurnAgainstAnchor("thread", "old", "anchor", createHistoryScanBudget()), "older");
  assert.equal(await reader.classifyTurnAgainstAnchor("thread", "absent", "anchor", createHistoryScanBudget()), "missing");
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

test("single pages reject duplicate rows, empty continuations, and non-advancing cursors", async () => {
  const duplicate = new ThreadHistoryReader(async () => ({
    data: [{ type: "agentMessage", id: "same" }, { type: "agentMessage", id: "same" }],
    nextCursor: null,
    backwardsCursor: null,
  }));
  await assert.rejects(duplicate.itemsPage("thread", { limit: 2, sortDirection: "asc" }), (error: unknown) => (
    error instanceof AppError && error.code === "OPERATION_UNCERTAIN"
  ));

  const empty = new ThreadHistoryReader(async () => ({ data: [], nextCursor: "more", backwardsCursor: null }));
  await assert.rejects(empty.turnsPage("thread", { limit: 1, sortDirection: "desc", itemsView: "notLoaded" }));

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
