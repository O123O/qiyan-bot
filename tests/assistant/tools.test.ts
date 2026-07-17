import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { ASSISTANT_TOOL_SCHEMAS, EPHEMERAL_READ_TOOLS, TOOL_NAMES, createAssistantTools } from "../../src/assistant/tools.ts";
import { AttemptScope } from "../../src/assistant/attempt-scope.ts";
import { ConversationStore } from "../../src/storage/conversation-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";

const expected = [
  "list_managed_sessions", "discover_sessions", "get_session_status", "create_session", "adopt_session", "rename_session", "unadopt_session", "archive_session",
  "disconnect_endpoint", "restart_endpoint",
  "send_to_session", "read_worker_message", "inspect_worker_conversation", "collect_messages", "interrupt_session", "compact_session", "list_models", "set_session_model", "set_reasoning_effort", "get_goal", "set_goal", "pause_goal", "resume_goal", "cancel_goal",
  "update_session_notes",
  "send_chat_message", "prepare_chat_attachment", "send_chat_attachment", "get_chat_history", "search_slack", "get_slack_mentions",
].sort();

test("tool catalog is curated and excludes completion and raw RPC", () => {
  assert.deepEqual([...TOOL_NAMES].sort(), expected);
  assert.equal(TOOL_NAMES.includes("complete_goal" as any), false);
  assert.equal(TOOL_NAMES.includes("raw_rpc" as any), false);
  assert.equal(TOOL_NAMES.some((name) => name.includes("weixin") || name.includes("wechat")), false);
});

test("session nicknames are safe and create_session may use the backend fallback", () => {
  assert.deepEqual(ASSISTANT_TOOL_SCHEMAS.create_session.parse({ nickname: "docs_2026" }), { nickname: "docs_2026" });
  for (const nickname of ["Bad", "has space", "../escape", "", "x".repeat(65)]) {
    assert.throws(() => ASSISTANT_TOOL_SCHEMAS.create_session.parse({ nickname }));
  }
});

test("endpoint lifecycle tools default to local", () => {
  assert.deepEqual(ASSISTANT_TOOL_SCHEMAS.disconnect_endpoint.parse({}), { endpoint: "local" });
  assert.deepEqual(ASSISTANT_TOOL_SCHEMAS.restart_endpoint.parse({ endpoint: "devbox" }), { endpoint: "devbox" });
});

test("chat history has one bounded platform-neutral read-only schema", () => {
  assert.deepEqual(ASSISTANT_TOOL_SCHEMAS.get_chat_history.parse({ scope: "conversation", count: 100, before: "123.4" }), {
    scope: "conversation", count: 100, before: "123.4",
  });
  assert.deepEqual(ASSISTANT_TOOL_SCHEMAS.get_chat_history.parse({ scope: "channel", count: 1 }), { scope: "channel", count: 1 });
  for (const input of [
    { scope: "workspace", count: 1 }, { scope: "channel", count: 0 }, { scope: "channel", count: 101 }, { scope: "channel", count: 1, adapter: "slack" },
  ]) assert.throws(() => ASSISTANT_TOOL_SCHEMAS.get_chat_history.parse(input));
});

test("transient history and Slack reads never create replay receipts", async () => {
  assert.deepEqual([...EPHEMERAL_READ_TOOLS].sort(), ["get_slack_mentions", "inspect_worker_conversation", "search_slack"]);
  assert.deepEqual(ASSISTANT_TOOL_SCHEMAS.inspect_worker_conversation.parse({ nickname: "payments" }), { nickname: "payments", count: 20 });
  assert.deepEqual(ASSISTANT_TOOL_SCHEMAS.inspect_worker_conversation.parse({ nickname: "payments", count: 50, before: "cursor" }), {
    nickname: "payments", count: 50, before: "cursor",
  });
  for (const input of [
    { nickname: "payments", count: 0 }, { nickname: "payments", count: 51 }, { nickname: "payments", count: 1, message_id: "forbidden" },
  ]) assert.throws(() => ASSISTANT_TOOL_SCHEMAS.inspect_worker_conversation.parse(input));
  assert.deepEqual(ASSISTANT_TOOL_SCHEMAS.search_slack.parse({ query: "launch", date_from: "2026-01-01", date_to: "2026-02-01" }), {
    query: "launch", date_from: "2026-01-01", date_to: "2026-02-01",
  });
  assert.deepEqual(ASSISTANT_TOOL_SCHEMAS.get_slack_mentions.parse({ date_from: "2026-01-01" }), { date_from: "2026-01-01" });
  assert.throws(() => ASSISTANT_TOOL_SCHEMAS.search_slack.parse({ query: "x", cursor: "forbidden" }));

  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx-search", kind: "slack", sourceId: "source", rawText: "search", attachmentIds: [] });
  let calls = 0;
  const sentinel = "TRANSIENT_SLACK_RESULT_DO_NOT_STORE_91f2";
  const tools = createAssistantTools(operations, {
    search_slack: async () => ({ results: [{ text: sentinel, call: ++calls }] }),
    inspect_worker_conversation: async () => ({ messages: [{ body: sentinel, call: ++calls }] }),
  }, { maxCollectCount: 20 });
  const context = { sourceContextId: "ctx-search", attemptId: "a", turnId: "t", callId: "same-call" };
  assert.equal(((await tools.search_slack(context, { query: "launch" })) as any).results[0].call, 1);
  assert.equal(((await tools.search_slack(context, { query: "launch" })) as any).results[0].call, 2);
  assert.equal(((await tools.inspect_worker_conversation(context, { nickname: "payments" })) as any).messages[0].call, 3);
  assert.equal(((await tools.inspect_worker_conversation(context, { nickname: "payments" })) as any).messages[0].call, 4);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM operations").get() as any).count, 0);
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>) {
    const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(sentinel));
  }
});

test("adoption uses the native Codex cwd and rejects a caller-supplied project directory", () => {
  assert.deepEqual(ASSISTANT_TOOL_SCHEMAS.adopt_session.parse({ nickname: "payments", thread_id: "thread-1" }), {
    nickname: "payments",
    thread_id: "thread-1",
  });
  assert.throws(() => ASSISTANT_TOOL_SCHEMAS.adopt_session.parse({ nickname: "payments", thread_id: "thread-1", project_dir: "/wrong" }));
});

test("every curated handler validates, records, dispatches, and replays its receipt", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "1", rawText: "ordinary", attachmentIds: [] });
  const calls: string[] = [];
  const actions = Object.fromEntries(TOOL_NAMES.map((name) => [name, async (args: unknown) => { calls.push(name); return { name, args }; }]));
  const tools = createAssistantTools(operations, actions, { maxCollectCount: 20 });
  const context = { sourceContextId: "ctx", attemptId: "a", turnId: "t", callId: "c" };
  const first = await tools.list_managed_sessions(context, {});
  const replay = await tools.list_managed_sessions(context, {});
  assert.deepEqual(first, replay);
  assert.deepEqual(calls, ["list_managed_sessions"]);
  await assert.rejects(tools.list_managed_sessions(context, { extra: true }));
});

test("pass sends the exact opaque payload and attachment order once", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "1", rawText: "tell payments /pass  keep /collect 3\n", attachmentIds: ["file_a", "file_b"] });
  const sent: any[] = [];
  const tools = createAssistantTools(operations, { send_to_session: async (args) => { sent.push(args); return { turnId: "turn" }; } }, { maxCollectCount: 20 });
  const context = { sourceContextId: "ctx", attemptId: "a", turnId: "t", callId: "call-1" };
  const args = { nickname: "payments", content: " keep /collect 3\n", attachment_ids: ["file_a", "file_b"], mode: "start" };
  const receipt = await tools.send_to_session(context, args);
  assert.deepEqual(sent, [args]);
  assert.equal((receipt as any).actualText, " keep /collect 3\n");
  assert.deepEqual(await tools.send_to_session({ ...context, callId: "retry" }, args), receipt);
  await assert.rejects(
    tools.send_to_session({ ...context, callId: "different" }, { ...args, nickname: "billing" }),
    (error: unknown) => error instanceof AppError && error.code === "DIRECTIVE_ALREADY_CONSUMED",
  );
  await assert.rejects(
    tools.send_to_session({ ...context, sourceContextId: "ctx", callId: "bad" }, { ...args, content: "translated" }),
    (error: unknown) => error instanceof AppError && error.code === "DIRECTIVE_MISMATCH",
  );
});

test("collect directive fixes count, creates direct delivery once, and returns only its receipt", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "2", rawText: "report payments /collect 2", attachmentIds: [] });
  let calls = 0;
  const tools = createAssistantTools(operations, { collect_messages: async (args) => { calls += 1; assert.equal((args as any).direct, true); return [{ deliveryId: "d1" }, { deliveryId: "d2" }]; } }, { maxCollectCount: 20 });
  const context = { sourceContextId: "ctx", attemptId: "a", turnId: "t", callId: "c" };
  const receipt = await tools.collect_messages(context, { nickname: "payments", count: 2 });
  assert.deepEqual(receipt, { deliveries: ["d1", "d2"], count: 2, nickname: "payments" });
  assert.deepEqual(await tools.collect_messages({ ...context, callId: "retry" }, { nickname: "payments", count: 2 }), receipt);
  assert.equal(calls, 1);
  await assert.rejects(tools.collect_messages({ ...context, callId: "bad" }, { nickname: "payments", count: 3 }), (error: unknown) => error instanceof AppError && error.code === "DIRECTIVE_MISMATCH");
});

test("changed arguments conflict and uncertain operations are never retransmitted", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "3", rawText: "ordinary", attachmentIds: [] });
  let calls = 0;
  const tools = createAssistantTools(operations, { send_chat_message: async () => { calls += 1; return { deliveryId: "d" }; } }, { maxCollectCount: 20 });
  const context = { sourceContextId: "ctx", attemptId: "a", turnId: "t", callId: "c" };
  await tools.send_chat_message(context, { content: "one" });
  await assert.rejects(tools.send_chat_message(context, { content: "two" }), (error: unknown) => error instanceof AppError && error.code === "OPERATION_CONFLICT");
  assert.equal(calls, 1);
});

test("a proven no-effect error does not consume a pass directive", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "4", rawText: "/pass exact", attachmentIds: [] });
  let calls = 0;
  const tools = createAssistantTools(operations, {
    send_to_session: async () => {
      calls += 1;
      if (calls === 1) throw new AppError("SESSION_BUSY", "busy before dispatch");
      return { turnId: "turn" };
    },
  }, { maxCollectCount: 20 });
  const args = { nickname: "payments", content: "exact", attachment_ids: [], mode: "start" };
  await assert.rejects(tools.send_to_session({ sourceContextId: "ctx", attemptId: "a", turnId: "t", callId: "first" }, args), (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY");
  const failed = db.prepare("SELECT state FROM operations WHERE call_id = 'first'").get() as { state: string };
  assert.equal(failed.state, "failed");
  await assert.rejects(tools.send_to_session({ sourceContextId: "ctx", attemptId: "a", turnId: "t", callId: "first" }, args), (error: unknown) => error instanceof AppError && error.code === "OPERATION_UNCERTAIN");
  const receipt = await tools.send_to_session({ sourceContextId: "ctx", attemptId: "a", turnId: "t", callId: "second" }, args);
  assert.equal((receipt as any).turnId, "turn");
  assert.equal(calls, 2);
});

test("configuration rejection is recorded as proven no effect", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "path", rawText: "create it", attachmentIds: [] });
  let calls = 0;
  const tools = createAssistantTools(operations, {
    create_session: async () => {
      calls += 1;
      if (calls === 1) throw new AppError("CONFIGURATION_ERROR", "project directory must be absolute");
      return { nickname: "docs" };
    },
  }, { maxCollectCount: 20 });
  const base = { sourceContextId: "ctx", attemptId: "a", turnId: "t" };
  await assert.rejects(tools.create_session({ ...base, callId: "first" }, { nickname: "docs", project_dir: "relative" }), /must be absolute/);
  assert.equal((db.prepare("SELECT state FROM operations WHERE call_id = 'first'").get() as any).state, "failed");
  assert.deepEqual(await tools.create_session({ ...base, callId: "second" }, { nickname: "docs", project_dir: "/tmp/docs" }), { nickname: "docs" });
});

test("a side-effecting failure returns fixed uncertainty while retaining its original durable cause", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "uncertain", rawText: "create it", attachmentIds: [] });
  let calls = 0;
  const tools = createAssistantTools(operations, {
    create_session: async () => {
      calls += 1;
      throw new AppError("ENDPOINT_UNAVAILABLE", "SSH process failed (exit 1)");
    },
  }, { maxCollectCount: 20 });
  const context = { sourceContextId: "ctx", attemptId: "a", turnId: "t", callId: "create" };

  await assert.rejects(tools.create_session(context, { nickname: "docs" }), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "OPERATION_UNCERTAIN", true);
    assert.equal((error as Error).message, "create_session may already have taken effect; wait for durable reconciliation before retrying");
    assert.doesNotMatch(String(error), /SSH process/u);
    return true;
  });
  const row = db.prepare("SELECT state, error_json FROM operations WHERE call_id = 'create'").get() as { state: string; error_json: string };
  assert.equal(row.state, "uncertain");
  assert.deepEqual(JSON.parse(row.error_json), { message: "SSH process failed (exit 1)" });
  await assert.rejects(tools.create_session(context, { nickname: "docs" }), (error: unknown) => error instanceof AppError && error.code === "OPERATION_UNCERTAIN");
  assert.equal(calls, 1, "uncertain creation is never redispatched");
});

test("a pre-dispatch create checkpoint makes endpoint failure definite", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "before-dispatch", rawText: "create it", attachmentIds: [] });
  const tools = createAssistantTools(operations, {
    create_session: async (_args, context) => {
      context.checkpoint({ endpoint: "devbox", mappingId: "mapping-1", dispatchStarted: false });
      throw new AppError("ENDPOINT_UNAVAILABLE", "SSH workspace helper returned an invalid response");
    },
  }, { maxCollectCount: 20 });

  await assert.rejects(
    tools.create_session(
      { sourceContextId: "ctx", attemptId: "a", turnId: "t", callId: "create" },
      { nickname: "docs", endpoint: "devbox" },
    ),
    (error: unknown) => error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE",
  );
  const row = db.prepare("SELECT state, receipt_json FROM operations WHERE call_id = 'create'").get() as {
    state: string; receipt_json: string;
  };
  assert.equal(row.state, "failed");
  assert.deepEqual(JSON.parse(row.receipt_json), { endpoint: "devbox", mappingId: "mapping-1", dispatchStarted: false });
});

test("create_session waits for exact durable reconciliation instead of returning transient uncertainty", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "wait-success", rawText: "create it", attachmentIds: [] });
  let calls = 0;
  let waits = 0;
  const tools = createAssistantTools(operations, {
    create_session: async (_args, context) => {
      calls += 1;
      context.checkpoint({ endpoint: "devbox", dispatchStarted: true, threadId: "thread-1" });
      throw new AppError("ENDPOINT_UNAVAILABLE", "SSH process failed (exit 1)");
    },
  }, {
    maxCollectCount: 20,
    waitForTerminal: async (operationId) => {
      waits += 1;
      assert.equal(operations.get(operationId)?.state, "uncertain");
      operations.succeed(operationId, { nickname: "docs", mapping_id: "mapping-1" });
    },
  });
  const context = { sourceContextId: "ctx", attemptId: "a", turnId: "t", callId: "create" };

  assert.deepEqual(await tools.create_session(context, { nickname: "docs", endpoint: "devbox" }), {
    nickname: "docs", mapping_id: "mapping-1",
  });
  assert.deepEqual(await tools.create_session(context, { nickname: "docs", endpoint: "devbox" }), {
    nickname: "docs", mapping_id: "mapping-1",
  });
  assert.equal(calls, 1, "terminal waiting never redispatches thread/start");
  assert.equal(waits, 1, "the recovered receipt replays without another wait");
});

test("create_session reports a reconciled failure as definite", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "wait-failure", rawText: "create it", attachmentIds: [] });
  const tools = createAssistantTools(operations, {
    create_session: async (_args, context) => {
      context.checkpoint({ endpoint: "devbox", dispatchStarted: true, threadId: "thread-1" });
      throw new AppError("ENDPOINT_UNAVAILABLE", "SSH process failed (exit 1)");
    },
  }, {
    maxCollectCount: 20,
    waitForTerminal: async (operationId) => {
      operations.failAndUnbind(operationId, { message: "allocated worker thread was lost before its rollout materialized" });
    },
  });

  await assert.rejects(
    tools.create_session({ sourceContextId: "ctx", attemptId: "a", turnId: "t", callId: "create" }, { nickname: "docs", endpoint: "devbox" }),
    (error: unknown) => {
      assert.equal(error instanceof AppError && error.code === "OPERATION_FAILED", true);
      assert.equal((error as Error).message, "create_session failed: allocated worker thread was lost before its rollout materialized");
      return true;
    },
  );
});

test("a create failure after native dispatch is uncertain even for a normally no-effect error code", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "post-dispatch", rawText: "create it", attachmentIds: [] });
  const tools = createAssistantTools(operations, {
    create_session: async (_args, context) => {
      context.checkpoint({ endpoint: "devbox", dispatchStarted: true });
      throw new AppError("CONFIGURATION_ERROR", "project workspace changed unexpectedly");
    },
  }, { maxCollectCount: 20 });
  const context = { sourceContextId: "ctx", attemptId: "a", turnId: "t", callId: "create-after-dispatch" };

  await assert.rejects(tools.create_session(context, { nickname: "docs", endpoint: "devbox" }), (error: unknown) => {
    assert.equal(error instanceof AppError && error.code === "OPERATION_UNCERTAIN", true);
    assert.equal((error as Error).message, "create_session may already have taken effect; wait for durable reconciliation before retrying");
    return true;
  });
  const row = db.prepare("SELECT state, receipt_json, error_json FROM operations WHERE call_id = 'create-after-dispatch'").get() as {
    state: string; receipt_json: string; error_json: string;
  };
  assert.equal(row.state, "uncertain");
  assert.deepEqual(JSON.parse(row.receipt_json), { endpoint: "devbox", dispatchStarted: true });
  assert.deepEqual(JSON.parse(row.error_json), { message: "project workspace changed unexpectedly" });
});

test("manager note updates require a bounded partial patch and expose stable operation order", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "5", rawText: "remember this", attachmentIds: [] });
  const calls: any[] = [];
  const tools = createAssistantTools(operations, {
    update_session_notes: async (args, context) => {
      calls.push({ args, sequence: context.operationSequence });
      return { project_summary: args.project_summary ?? null, supervision_objective: null, pending_follow_up: null, updated_at: "now" };
    },
  }, { maxCollectCount: 20 });
  const context = { sourceContextId: "ctx", attemptId: "a", turnId: "t", callId: "notes" };
  await assert.rejects(tools.update_session_notes(context, { nickname: "payments" }));
  const receipt = await tools.update_session_notes(context, { nickname: "payments", project_summary: "Payments", pending_follow_up: null });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].sequence > 0);
  assert.deepEqual(await tools.update_session_notes(context, { nickname: "payments", project_summary: "Payments", pending_follow_up: null }), receipt);
});

test("attempt-scoped safeguards feed the ordinary action path with the admitted source scope", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  const conversations = new ConversationStore(db, new DeliveryStore(db));
  const binding = { adapterId: "telegram", conversationKey: "telegram:chat", destination: { chatId: "chat" } } as const;
  for (const [id, rawText] of [["primary", "ordinary"], ["guard", "/pass exact"]] as const) conversations.acceptChatSource({ id, nativeSourceId: id, binding, rawText, attachmentIds: [], receivedAt: 1 });
  const lease = conversations.createAttempt({ kind: "chat", contextId: "primary" });
  conversations.reserveStart(lease.attemptId, "primary");
  conversations.markSubmitted(lease.attemptId, "primary", "turn");
  conversations.reserveNextSteer(lease.attemptId);
  conversations.markSubmitted(lease.attemptId, "guard", "turn");
  const scope = new AttemptScope(db, operations, { maxCollectCount: 20 });
  let effective = "";
  const tools = createAssistantTools(operations, {
    send_to_session: async (_args, context) => { effective = context.effectiveSourceContextId; return { turnId: "worker" }; },
  }, { maxCollectCount: 20, attemptScope: scope });
  const args = { nickname: "worker", content: "exact", attachment_ids: [], mode: "steer" };
  const result = await tools.send_to_session({ sourceContextId: "primary", attemptId: lease.attemptId, turnId: "turn", callId: "call", toolFence: 0 }, args);
  assert.equal(effective, "guard");
  assert.equal(operations.findForCall(lease.attemptId, "call", "send_to_session")?.contextId, "guard");
  assert.equal((result as any).actualText, "exact");
});
