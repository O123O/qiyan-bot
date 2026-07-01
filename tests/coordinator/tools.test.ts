import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { TOOL_NAMES, createCoordinatorTools } from "../../src/coordinator/tools.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";

const expected = [
  "list_managed_sessions", "discover_sessions", "get_session_status", "create_session", "register_session", "adopt_session", "rename_session", "detach_session", "attach_session", "archive_session",
  "send_to_session", "read_worker_message", "collect_messages", "interrupt_session", "list_models", "set_session_model", "set_reasoning_effort", "get_goal", "set_goal", "pause_goal", "resume_goal", "cancel_goal",
  "update_session_notes",
  "send_chat_message", "prepare_chat_attachment", "send_chat_attachment",
].sort();

test("tool catalog is curated and excludes completion and raw RPC", () => {
  assert.deepEqual([...TOOL_NAMES].sort(), expected);
  assert.equal(TOOL_NAMES.includes("complete_goal" as any), false);
  assert.equal(TOOL_NAMES.includes("raw_rpc" as any), false);
});

test("every curated handler validates, records, dispatches, and replays its receipt", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "1", rawText: "ordinary", attachmentIds: [] });
  const calls: string[] = [];
  const actions = Object.fromEntries(TOOL_NAMES.map((name) => [name, async (args: unknown) => { calls.push(name); return { name, args }; }]));
  const tools = createCoordinatorTools(operations, actions, { maxCollectCount: 20 });
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
  const tools = createCoordinatorTools(operations, { send_to_session: async (args) => { sent.push(args); return { turnId: "turn" }; } }, { maxCollectCount: 20 });
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
  const tools = createCoordinatorTools(operations, { collect_messages: async (args) => { calls += 1; assert.equal((args as any).direct, true); return [{ deliveryId: "d1" }, { deliveryId: "d2" }]; } }, { maxCollectCount: 20 });
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
  const tools = createCoordinatorTools(operations, { send_chat_message: async () => { calls += 1; return { deliveryId: "d" }; } }, { maxCollectCount: 20 });
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
  const tools = createCoordinatorTools(operations, {
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

test("manager note updates require a bounded partial patch and expose stable operation order", async () => {
  const db = createTestDatabase();
  const operations = new OperationStore(db);
  operations.createSourceContext({ id: "ctx", kind: "telegram", sourceId: "5", rawText: "remember this", attachmentIds: [] });
  const calls: any[] = [];
  const tools = createCoordinatorTools(operations, {
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
