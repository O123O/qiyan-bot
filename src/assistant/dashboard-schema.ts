import { z } from "zod";

const timestamp = z.string().refine((value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}, "expected an ISO timestamp");
const nullableText = z.string().max(4_000).nullable();
const tokenBreakdown = z.object({
  total_tokens: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  reasoning_output_tokens: z.number().int().nonnegative(),
}).strict();

export const LastSentSchema = z.object({
  text: z.string(),
  mode: z.enum(["start", "steer"]),
  attachment_ids: z.array(z.string()),
  turn_id: z.string().min(1),
  at: timestamp,
}).strict();

export const LastWorkerEventSchema = z.object({
  message_id: z.string().min(1).nullable(),
  turn_id: z.string().min(1),
  status: z.string().min(1),
  at: timestamp,
}).strict();

export const DashboardTokenUsageSchema = z.object({
  total: tokenBreakdown,
  last_turn: tokenBreakdown,
  model_context_window: z.number().int().nonnegative().nullable(),
  context_remaining: z.number().int().nonnegative().nullable(),
  context_used_percent: z.number().min(0).max(100).nullable(),
  observed_at: timestamp,
}).strict();

export const DashboardGoalSchema = z.object({
  objective: z.string(),
  status: z.string().min(1),
  token_budget: z.number().int().positive().nullable(),
}).strict();

export const ManagerNotesSchema = z.object({
  project_summary: nullableText,
  supervision_objective: nullableText,
  pending_follow_up: nullableText,
  updated_at: timestamp.nullable(),
}).strict();

export const SessionNotesPatchSchema = z.object({
  project_summary: nullableText.optional(),
  supervision_objective: nullableText.optional(),
  pending_follow_up: nullableText.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "at least one manager note field is required");

export const AutoSessionInfoSchema = z.object({
  last_sent: LastSentSchema.nullable(),
  last_worker_event: LastWorkerEventSchema.nullable(),
  model: z.object({ current: z.string().nullable(), pending: z.string().nullable() }).strict(),
  reasoning_effort: z.object({ current: z.string().nullable(), pending: z.string().nullable() }).strict(),
  token_usage: DashboardTokenUsageSchema.nullable(),
  goal: DashboardGoalSchema.nullable(),
  observed_at: timestamp.nullable(),
}).strict();

export const SessionDashboardEntrySchema = z.object({
  identity: z.object({ thread_id: z.string().min(1), endpoint: z.string().min(1), project_dir: z.string().min(1) }).strict(),
  auto_session_info: AutoSessionInfoSchema,
  manager_notes: ManagerNotesSchema,
}).strict();

export const SessionDashboardDocumentSchema = z.object({
  version: z.literal(3),
  sessions: z.record(z.string().min(1), SessionDashboardEntrySchema),
}).strict();

const LegacyAutoSessionInfoSchema = AutoSessionInfoSchema.extend({
  management_state: z.enum(["managed", "unavailable"]),
  native_status: z.string(),
  active_turn_id: z.string().nullable(),
}).strict();

const LegacySessionDashboardDocumentSchema = z.object({
  version: z.literal(2),
  sessions: z.record(z.string().min(1), SessionDashboardEntrySchema.extend({
    auto_session_info: LegacyAutoSessionInfoSchema,
  }).strict()),
}).strict();

export const ExistingSessionDashboardDocumentSchema = z.union([
  SessionDashboardDocumentSchema,
  LegacySessionDashboardDocumentSchema,
]);

const appServerTokenBreakdown = z.object({
  totalTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
}).strict();

const appServerTokenUsage = z.object({
  total: appServerTokenBreakdown,
  last: appServerTokenBreakdown,
  modelContextWindow: z.number().int().nonnegative().nullable(),
}).strict();

export type SessionDashboardDocument = z.infer<typeof SessionDashboardDocumentSchema>;
export type SessionDashboardEntry = z.infer<typeof SessionDashboardEntrySchema>;
export type ManagerNotes = z.infer<typeof ManagerNotesSchema>;
export type SessionNotesPatch = z.infer<typeof SessionNotesPatchSchema>;
export type LastSent = z.infer<typeof LastSentSchema>;
export type LastWorkerEvent = z.infer<typeof LastWorkerEventSchema>;
export type DashboardTokenUsage = z.infer<typeof DashboardTokenUsageSchema>;
export type DashboardGoal = z.infer<typeof DashboardGoalSchema>;

export function toIsoTimestamp(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) throw new RangeError("timestamp must be finite");
  return new Date(milliseconds).toISOString();
}

export function normalizeTokenUsage(input: unknown, observedAt: number): DashboardTokenUsage {
  const parsed = appServerTokenUsage.parse(input);
  const normalize = (value: z.infer<typeof appServerTokenUsage>["total"]) => ({
    total_tokens: value.totalTokens,
    input_tokens: value.inputTokens,
    cached_input_tokens: value.cachedInputTokens,
    output_tokens: value.outputTokens,
    reasoning_output_tokens: value.reasoningOutputTokens,
  });
  const window = parsed.modelContextWindow;
  const contextTokens = parsed.last.totalTokens;
  const remaining = window === null ? null : Math.max(0, window - contextTokens);
  const used = window === null ? null : window === 0 ? (contextTokens === 0 ? 0 : 100) : Math.min(100, Math.max(0, contextTokens / window * 100));
  return DashboardTokenUsageSchema.parse({
    total: normalize(parsed.total),
    last_turn: normalize(parsed.last),
    model_context_window: window,
    context_remaining: remaining,
    context_used_percent: used,
    observed_at: toIsoTimestamp(observedAt),
  });
}
