import assert from "node:assert/strict";
import test from "node:test";
import { RolloutAccessRouter } from "../../src/endpoints/rollout-access.ts";

test("SSH rollout scans use one bounded metadata-only helper call", async () => {
  const calls: Array<{ operation: string; args: readonly string[]; helperPath?: string }> = [];
  const response = {
    results: [{
      cursor: { device: "1", inode: "2", offset: 30 },
      starts: [{ turnId: "turn-1", clientId: "ctx:call" }],
      openTurn: { turnId: "turn-1", clientId: "ctx:call" },
      malformed: true,
    }],
  };
  const remote = {
    bootstrap: async () => undefined,
    invoke: async <T>(operation: string, args: readonly string[], helperPath?: string) => {
      calls.push({ operation, args, ...(helperPath ? { helperPath } : {}) });
      return response as T;
    },
  };
  const router = new RolloutAccessRouter({
    remote: (endpointId) => endpointId === "devbox" ? { remote, helperPath: "/tmp/qiyan/helper.mjs" } : undefined,
  });
  const request = { path: "/home/user/.codex/sessions/rollout-thread-1.jsonl", threadId: "thread-1" };

  assert.deepEqual(await router.scan("devbox", [request]), response.results);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.operation, "rollout-scan");
  assert.equal(calls[0]?.helperPath, "/tmp/qiyan/helper.mjs");
  assert.deepEqual(JSON.parse(calls[0]!.args[0]!), { requests: [request] });
});

test("SSH rollout scans reject malformed helper metadata", async () => {
  const router = new RolloutAccessRouter({
    remote: () => ({
      helperPath: "/tmp/qiyan/helper.mjs",
      remote: { bootstrap: async () => undefined, invoke: async <T>() => ({ results: [{ cursor: { device: "secret", inode: "2", offset: 0 }, starts: [] }] }) as T },
    }),
  });
  await assert.rejects(router.scan("devbox", [{ path: "/tmp/rollout-thread.jsonl", threadId: "thread" }]), /invalid data/u);
});

test("SSH rollout scans accept only the literal malformed boundary flag", async (t) => {
  const invalidResults = [
    { name: "false", result: { cursor: { device: "1", inode: "2", offset: 0 }, starts: [], malformed: false } },
    { name: "string", result: { cursor: { device: "1", inode: "2", offset: 0 }, starts: [], malformed: "true" } },
    { name: "unknown body", result: { cursor: { device: "1", inode: "2", offset: 0 }, starts: [], body: "private" } },
    { name: "unknown message", result: { cursor: { device: "1", inode: "2", offset: 0 }, starts: [], message: "private" } },
  ];
  for (const fixture of invalidResults) {
    await t.test(fixture.name, async () => {
      const router = new RolloutAccessRouter({
        remote: () => ({
          helperPath: "/tmp/qiyan/helper.mjs",
          remote: { bootstrap: async () => undefined, invoke: async <T>() => ({ results: [fixture.result] }) as T },
        }),
      });
      await assert.rejects(router.scan("devbox", [{ path: "/tmp/rollout-thread.jsonl", threadId: "thread" }]), /invalid data/u);
    });
  }
});
