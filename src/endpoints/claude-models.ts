// TODO(claude-model-list): this catalog is STATIC, not real-time — it does not reflect the host's
// actual available models, account/org access, or new releases; it can go stale as Claude ships
// models. Replace it with the live Claude model list once Claude Code exposes one non-interactively
// (open feature request anthropics/claude-code#12612 — `claude model list`); until then keep the
// documented aliases here in sync with the model-config docs.
//
// Curated Claude model catalog. Claude Code has NO `models` list API (verified: the CLI has no
// `models`/`config get` command — it's an open feature request), so QiYan cannot discover models
// dynamically. This static list of the documented `--model` aliases is what `model/list` returns
// for a Claude endpoint, so `set_session_model` (which validates against it) and the assistant's
// picker have real, stable entries. Aliases resolve to the latest concrete model on the host; the
// transcript records the resolved id.
//
// `default` is the special alias that CLEARS any model override and reverts to your account's
// recommended model (or the org default) — i.e. "follow the user's setting". It is the catalog
// default unless the endpoint pins one via its endpoints.json `model`.
//
// Context windows (per the models overview): opus/sonnet/fable are 1M-token; haiku is 200k.
// Effort defaults to `high` on Opus 4.8 / Claude Code, so that is the catalog default effort.
//
// INVARIANT: every entry shares the SAME `supportedReasoningEfforts` — `set_reasoning_effort`
// validates the requested effort against the session's resolved model, so divergent effort sets
// per model would make validation depend on which model is current. `--effort` accepts exactly
// these levels (verified via `claude --help`).

export const CLAUDE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

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
    defaultReasoningEffort: "high",
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
