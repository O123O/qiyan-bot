import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../src/core/errors.ts";
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

test("local rollout scans retry two concurrent appends before returning one stable snapshot", async () => {
  let attempts = 0;
  const expected = { cursor: { device: "1", inode: "2", offset: 30 }, starts: [] };
  const router = new RolloutAccessRouter({
    remote: () => undefined,
    scanLocal: async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error("rollout appended while scanning");
      return expected;
    },
  });

  assert.deepEqual(await router.scan("local", [{ path: "/tmp/rollout-thread.jsonl", threadId: "thread" }]), [expected]);
  assert.equal(attempts, 3);
});

test("local rollout snapshot retries remain bounded", async () => {
  let attempts = 0;
  const router = new RolloutAccessRouter({
    remote: () => undefined,
    scanLocal: async () => {
      attempts += 1;
      throw new Error("rollout appended while scanning");
    },
  });

  await assert.rejects(
    router.scan("local", [{ path: "/tmp/rollout-thread.jsonl", threadId: "thread" }]),
    /rollout appended while scanning/u,
  );
  assert.equal(attempts, 3);
});

test("local rollout scans never retry non-append mutations or malformed boundaries", async (t) => {
  for (const message of [
    "rollout identity changed",
    "rollout was truncated",
    "rollout changed while scanning",
    "rollout line exceeds the maximum size",
  ]) {
    await t.test(message, async () => {
      let attempts = 0;
      const router = new RolloutAccessRouter({
        remote: () => undefined,
        scanLocal: async () => { attempts += 1; throw new Error(message); },
      });
      await assert.rejects(router.scan("local", [{ path: "/tmp/rollout-thread.jsonl", threadId: "thread" }]), new RegExp(message, "u"));
      assert.equal(attempts, 1);
    });
  }

  let malformedAttempts = 0;
  const malformed = { cursor: { device: "1", inode: "2", offset: 30 }, starts: [], malformed: true as const };
  const router = new RolloutAccessRouter({
    remote: () => undefined,
    scanLocal: async () => { malformedAttempts += 1; return malformed; },
  });
  assert.deepEqual(await router.scan("local", [{ path: "/tmp/rollout-thread.jsonl", threadId: "thread" }]), [malformed]);
  assert.equal(malformedAttempts, 1);
});

test("local rollout append retry rechecks the endpoint lease before rescanning", async () => {
  let attempts = 0;
  let leaseChecks = 0;
  const router = new RolloutAccessRouter({
    remote: () => undefined,
    validateLease: () => { leaseChecks += 1; return leaseChecks === 1; },
    scanLocal: async () => { attempts += 1; throw new Error("rollout appended while scanning"); },
  });

  await assert.rejects(
    router.scan("local", [{ path: "/tmp/rollout-thread.jsonl", threadId: "thread" }], {
      endpointId: "local", lifecycleGeneration: 1, endpointGeneration: 1, leaseId: "lease",
    }),
    /endpoint work lease changed/u,
  );
  assert.equal(attempts, 1);
  assert.equal(leaseChecks, 2);
});

test("SSH rollout scans distinguish a not-yet-materialized file from transport failure", async () => {
  const calls: unknown[] = [];
  const router = new RolloutAccessRouter({
    remote: () => ({
      helperPath: "/tmp/qiyan/helper.mjs",
      remote: {
        bootstrap: async () => undefined,
        invoke: async <T>(_operation: string, args: readonly string[]) => {
          calls.push(JSON.parse(args[0]!));
          return { results: [{ missing: true }] } as T;
        },
      },
    }),
  });
  const request = { path: "/home/user/.codex/sessions/rollout-thread.jsonl", threadId: "thread" };

  assert.deepEqual(await router.scanUnmaterialized("devbox", request), { state: "missing" });
  assert.deepEqual(calls, [{ requests: [request], allowMissing: true, collectFromStart: true }]);
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

test("provider dispatch routes a Claude endpoint's local scan to the transcript scanner", async () => {
  const calls: string[] = [];
  const claudeResult = { cursor: { device: "1", inode: "2", offset: 10 }, starts: [{ turnId: "p1", clientId: "ctx:1", hasUserMessage: true as const }] };
  const router = new RolloutAccessRouter({
    remote: () => undefined,
    provider: (endpointId) => endpointId === "local" ? "claude" : "codex",
    scanLocalClaude: async (request) => { calls.push(request.path); return claudeResult; },
    scanLocal: async () => { throw new Error("codex scanner must not run for a claude endpoint"); },
  });

  const result = await router.scan("local", [{ path: "/home/u/.claude/projects/x/sess-1.jsonl", threadId: "sess-1" }]);

  assert.deepEqual(result, [claudeResult]);
  assert.deepEqual(calls, ["/home/u/.claude/projects/x/sess-1.jsonl"]);
});

test("remote Claude rollout scan fails loudly until the Claude-aware helper exists", async () => {
  const router = new RolloutAccessRouter({
    remote: () => ({ helperPath: "/tmp/h.mjs", remote: { bootstrap: async () => undefined, invoke: async <T>() => ({ results: [] }) as T } }),
    provider: () => "claude",
  });
  await assert.rejects(
    router.scan("devbox", [{ path: "/home/u/.claude/projects/x/sess-1.jsonl", threadId: "sess-1" }]),
    (error: unknown) => error instanceof AppError && error.code === "UNSUPPORTED_CAPABILITY",
  );
});

test("a Claude local scan retries on the shared concurrent-append sentinel", async () => {
  let attempts = 0;
  const stable = { cursor: { device: "1", inode: "2", offset: 5 }, starts: [] };
  const router = new RolloutAccessRouter({
    remote: () => undefined,
    provider: () => "claude",
    scanLocalClaude: async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("rollout appended while scanning"); // the shared sentinel
      return stable;
    },
  });

  assert.deepEqual(await router.scan("local", [{ path: "/h/.claude/projects/x/s.jsonl", threadId: "s" }]), [stable]);
  assert.equal(attempts, 2);
});
