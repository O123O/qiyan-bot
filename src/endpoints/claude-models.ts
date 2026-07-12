// Curated Claude model catalog. Claude Code has NO `models` list API (unlike Codex's
// app-server `model/list`), so QiYan cannot discover models dynamically — this static list
// of the documented `--model` aliases is the source `model/list` returns for a Claude
// endpoint, so `set_session_model` (which validates against it) and the assistant's model
// picker have something real to work with. Aliases resolve to the latest concrete model on
// the host; the transcript records the resolved id.
//
// INVARIANT: every entry shares the SAME `supportedReasoningEfforts` — `set_reasoning_effort`
// validates the requested effort against the session's resolved model, so divergent effort
// sets per model would make validation depend on which model is current. `--effort` accepts
// exactly these levels (verified via `claude --help`).

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
    defaultReasoningEffort: "medium",
    isDefault,
  };
}

// The catalog for an endpoint. `configuredModel` (from `CLAUDE_CODE_MODEL` / the endpoint's
// launch flags), if set and not already an alias, is added as the default entry; otherwise the
// first alias is the default. Deduped so a configured alias isn't listed twice.
export function claudeModelCatalog(configuredModel?: string): ClaudeCatalogModel[] {
  const configuredIsAlias = configuredModel !== undefined && ALIASES.some((a) => a.id === configuredModel);
  const models = ALIASES.map((a) => entry(a.id, a.displayName, configuredModel === undefined ? a.id === "opus" : a.id === configuredModel));
  if (configuredModel !== undefined && !configuredIsAlias) {
    models.unshift(entry(configuredModel, configuredModel, true));
  }
  return models;
}
