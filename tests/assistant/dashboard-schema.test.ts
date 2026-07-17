import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionDashboardDocumentSchema,
  SessionNotesPatchSchema,
  normalizeTokenUsage,
} from "../../src/assistant/dashboard-schema.ts";

test("parses a complete strict facts-only version-3 dashboard", () => {
  const document = {
    version: 3,
    sessions: {
      payments: {
        identity: { thread_id: "thread-1", endpoint: "local", project_dir: "/projects/payments" },
        auto_session_info: {
          last_sent: { text: "run tests", mode: "start", attachment_ids: ["a1"], turn_id: "turn-1", at: "2026-07-01T00:00:00.000Z" },
          last_worker_event: { message_id: "msg-1", turn_id: "turn-1", status: "completed", at: "2026-07-01T00:01:00.000Z" },
          model: { current: "gpt-5", pending: null },
          reasoning_effort: { current: "high", pending: null },
          token_usage: {
            total: { total_tokens: 10, input_tokens: 6, cached_input_tokens: 2, output_tokens: 4, reasoning_output_tokens: 1 },
            last_turn: { total_tokens: 4, input_tokens: 3, cached_input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 0 },
            model_context_window: 100,
            context_remaining: 90,
            context_used_percent: 10,
            observed_at: "2026-07-01T00:01:00.000Z",
          },
          goal: { objective: "finish", status: "active", token_budget: null },
          observed_at: "2026-07-01T00:01:00.000Z",
        },
        manager_notes: { project_summary: "Payments", supervision_objective: null, pending_follow_up: null, updated_at: null },
      },
    },
  };
  assert.deepEqual(SessionDashboardDocumentSchema.parse(document), document);
  assert.throws(() => SessionDashboardDocumentSchema.parse({ ...document, extra: true }));
  assert.throws(() => SessionDashboardDocumentSchema.parse({ ...document, sessions: { payments: { ...document.sessions.payments, extra: true } } }));
  for (const forbidden of ["management_state", "native_status", "active_turn_id"]) {
    assert.throws(() => SessionDashboardDocumentSchema.parse({
      ...document,
      sessions: { payments: { ...document.sessions.payments, auto_session_info: { ...document.sessions.payments.auto_session_info, [forbidden]: null } } },
    }));
  }
});

test("manager note patches require a field and accept null clearing", () => {
  assert.throws(() => SessionNotesPatchSchema.parse({}));
  assert.deepEqual(SessionNotesPatchSchema.parse({ pending_follow_up: null }), { pending_follow_up: null });
  assert.throws(() => SessionNotesPatchSchema.parse({ project_summary: "x", unknown: true }));
});

test("normalizes exact token usage and clamps derived context values", () => {
  assert.deepEqual(normalizeTokenUsage({
    total: { totalTokens: 120, inputTokens: 80, cachedInputTokens: 20, outputTokens: 40, reasoningOutputTokens: 10 },
    last: { totalTokens: 20, inputTokens: 12, cachedInputTokens: 4, outputTokens: 8, reasoningOutputTokens: 3 },
    modelContextWindow: 100,
  }, 1_751_328_000_000), {
    total: { total_tokens: 120, input_tokens: 80, cached_input_tokens: 20, output_tokens: 40, reasoning_output_tokens: 10 },
    last_turn: { total_tokens: 20, input_tokens: 12, cached_input_tokens: 4, output_tokens: 8, reasoning_output_tokens: 3 },
    model_context_window: 100,
    context_remaining: 0,
    context_used_percent: 100,
    observed_at: "2025-07-01T00:00:00.000Z",
  });
});

test("leaves context derivations null without an observed context window", () => {
  const normalized = normalizeTokenUsage({
    total: { totalTokens: 5, inputTokens: 4, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
    last: { totalTokens: 5, inputTokens: 4, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
    modelContextWindow: null,
  }, 0);
  assert.equal(normalized.model_context_window, null);
  assert.equal(normalized.context_remaining, null);
  assert.equal(normalized.context_used_percent, null);
});
