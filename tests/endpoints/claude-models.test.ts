import assert from "node:assert/strict";
import test from "node:test";
import { claudeModelCatalog, CLAUDE_REASONING_EFFORTS } from "../../src/endpoints/claude-models.ts";

test("catalog exposes the documented aliases with the full effort set", () => {
  const models = claudeModelCatalog();
  assert.ok(models.some((m) => m.id === "opus"), "opus alias present");
  assert.ok(models.some((m) => m.id === "haiku"), "haiku alias present");
  for (const model of models) {
    assert.deepEqual(model.supportedReasoningEfforts.map((e) => e.reasoningEffort), [...CLAUDE_REASONING_EFFORTS]);
  }
  assert.equal(models.filter((m) => m.isDefault).length, 1, "exactly one default");
});

test("a configured non-alias model is prepended as the default; a configured alias is not duplicated", () => {
  const custom = claudeModelCatalog("claude-opus-4-8");
  assert.equal(custom[0]!.id, "claude-opus-4-8");
  assert.ok(custom[0]!.isDefault);
  assert.equal(custom.filter((m) => m.id === "claude-opus-4-8").length, 1);

  const alias = claudeModelCatalog("sonnet");
  assert.equal(alias.filter((m) => m.id === "sonnet").length, 1, "configured alias not duplicated");
  assert.ok(alias.find((m) => m.id === "sonnet")!.isDefault);
});
