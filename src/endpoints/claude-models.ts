// The FALLBACK model catalog, and the floor every model list is built on.
//
// The SDK does report Claude's real models (`supportedModels()`), and claude-runtime overlays
// that onto these entries for the one thing only it knows: which effort levels each model
// actually offers. This list is still what answers `model/list` until any session has been
// loaded, and it is never replaced, because it is the only source of two entries the live list
// does not contain:
//
//   - `default`, the special alias that CLEARS a model override and reverts to your account's
//     recommended model (or the org default). `set_session_model default` is the documented way
//     to do that, and `set_reasoning_effort` looks the session's CURRENT model up in this list —
//     which for an endpoint with no pinned model is the literal string "default".
//   - the endpoint's pinned `endpoints.json` model, which may be an alias Claude does not list.
//
// Aliases resolve to the latest concrete model on the host; the transcript records the resolved
// id. Context windows (per the models overview): opus/sonnet/fable are 1M-token, haiku 200k.
// Effort defaults to `high` on Opus 4.8 / Claude Code, so that is the catalog default effort.
//
// Entries here share one `supportedReasoningEfforts` set because a static list cannot know
// better. That is a floor, NOT an invariant of `model/list`: the live overlay deliberately gives
// a model the narrower set it reports, and `set_reasoning_effort` validates against whichever
// entry is current. `--effort` accepts exactly these levels (verified via `claude --help`).

export const CLAUDE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const CLAUDE_DEFAULT_REASONING_EFFORT = "high";

export interface ClaudeCatalogModel {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
  defaultReasoningEffort: string;
  isDefault: boolean;
}

const ALIASES: ReadonlyArray<{ id: string; displayName: string }> = [
  { id: "default", displayName: "Account default" },
  { id: "opus", displayName: "Claude Opus" },
  { id: "sonnet", displayName: "Claude Sonnet" },
  { id: "haiku", displayName: "Claude Haiku" },
  { id: "fable", displayName: "Claude Fable" },
];

function entry(id: string, displayName: string, isDefault: boolean): ClaudeCatalogModel {
  return {
    id,
    model: id,
    displayName,
    hidden: false,
    supportedReasoningEfforts: CLAUDE_REASONING_EFFORTS.map((reasoningEffort) => ({ reasoningEffort })),
    defaultReasoningEffort: CLAUDE_DEFAULT_REASONING_EFFORT,
    isDefault,
  };
}

// The catalog for an endpoint. The default entry is the endpoint's pinned `model`
// when set, else `default` (the account/org recommended model). A configured model that isn't
// already an alias is prepended so it's selectable; a configured alias is just marked default
// (not duplicated).
export function claudeModelCatalog(configuredModel?: string): ClaudeCatalogModel[] {
  const defaultId = configuredModel ?? "default";
  const models = ALIASES.map((alias) => entry(alias.id, alias.displayName, alias.id === defaultId));
  if (!ALIASES.some((alias) => alias.id === defaultId)) {
    models.unshift(entry(configuredModel!, configuredModel!, true));
  }
  return models;
}
