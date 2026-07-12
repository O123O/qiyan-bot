import assert from "node:assert/strict";
import test from "node:test";
import { claudeModelCatalog, CLAUDE_REASONING_EFFORTS } from "../../src/endpoints/claude-models.ts";

test("catalog is the documented aliases incl. `default`, effort defaults to high, one default entry", () => {
  const models = claudeModelCatalog();
  assert.deepEqual(models.map((m) => m.id), ["default", "opus", "sonnet", "haiku", "fable"]);
  for (const model of models) {
    assert.deepEqual(model.supportedReasoningEfforts.map((e) => e.reasoningEffort), [...CLAUDE_REASONING_EFFORTS]);
    assert.equal(model.defaultReasoningEffort, "high");
  }
  assert.equal(models.filter((m) => m.isDefault).length, 1, "exactly one default");
  // With no CLAUDE_CODE_MODEL, `default` (account/org recommended model) is THE default — it
  // follows the user's setting rather than pinning a specific model.
  assert.ok(models.find((m) => m.id === "default")!.isDefault, "`default` is the default when unpinned");
});

test("a configured CLAUDE_CODE_MODEL becomes the default; a configured alias is not duplicated", () => {
  const custom = claudeModelCatalog("claude-opus-4-8");
  assert.equal(custom[0]!.id, "claude-opus-4-8");
  assert.ok(custom[0]!.isDefault);
  assert.equal(custom.filter((m) => m.id === "claude-opus-4-8").length, 1);
  assert.equal(custom.filter((m) => m.isDefault).length, 1);
  assert.ok(!custom.find((m) => m.id === "default")!.isDefault, "`default` not the default when a model is pinned");

  const alias = claudeModelCatalog("sonnet");
  assert.equal(alias.filter((m) => m.id === "sonnet").length, 1, "configured alias not duplicated");
  assert.ok(alias.find((m) => m.id === "sonnet")!.isDefault);
  assert.equal(alias.filter((m) => m.isDefault).length, 1);
});
