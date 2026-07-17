import assert from "node:assert/strict";
import test from "node:test";
import { readWorkerMessages } from "../../src/assistant/worker-message-history.ts";

const mapping = { endpoint: "remote", thread_id: "thread", mapping_id: "mapping" };

test("worker message reads delegate one bounded page and project native rows", async () => {
  const signal = new AbortController().signal;
  const calls: unknown[][] = [];
  const result = await readWorkerMessages({
    resolveSession: (nickname) => nickname === "worker" ? mapping : undefined,
    readTurns: async (...args) => {
      calls.push(args);
      return {
        messages: [
          { id: "u1", turnId: "turn", role: "you", body: "question", completedAt: 1, terminalStatus: "completed", turnOrder: 1, itemOrder: 1, clientId: "client" },
          { id: "a1", turnId: "turn", body: "answer", completedAt: 2, terminalStatus: "completed", turnOrder: 1, itemOrder: 2, phase: "final_answer" },
        ],
        hasOlder: true, nextCursor: "next", openTurnIds: [], terminalTurnIds: ["turn"],
      };
    },
  }, { nickname: "worker", count: 7, before: "before" }, signal);

  assert.deepEqual(calls, [["remote", "thread", "mapping", 7, "before", signal]]);
  assert.deepEqual(result, {
    messages: [
      { id: "u1", turnId: "turn", role: "user", body: "question", completedAt: 1, status: "completed", clientId: "client" },
      { id: "a1", turnId: "turn", role: "worker", body: "answer", completedAt: 2, status: "completed", phase: "final_answer" },
    ],
    hasOlder: true, nextCursor: "next", openTurnIds: [], terminalTurnIds: ["turn"],
  });
});

test("worker message reads reject unknown and remapped nicknames", async () => {
  let current = mapping;
  let resolveRead!: (value: any) => void;
  const pending = new Promise<any>((resolve) => { resolveRead = resolve; });
  const deps = {
    resolveSession: (nickname: string) => nickname === "worker" ? current : undefined,
    readTurns: async () => pending,
  };

  await assert.rejects(readWorkerMessages(deps, { nickname: "missing", count: 1 }, new AbortController().signal), (error: any) => error?.code === "UNKNOWN_SESSION");
  const read = readWorkerMessages(deps, { nickname: "worker", count: 1 }, new AbortController().signal);
  current = { ...mapping, mapping_id: "replacement" };
  resolveRead({ messages: [], hasOlder: false, openTurnIds: [], terminalTurnIds: [] });
  await assert.rejects(read, (error: any) => error?.code === "OPERATION_CONFLICT");
});
