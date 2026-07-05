import assert from "node:assert/strict";
import test from "node:test";
import { requireMinimumCodexVersion } from "../../src/app-server/version-compat.ts";

test("accepts the minimum and newer numeric Codex App Server versions", () => {
  assert.equal(requireMinimumCodexVersion("codex_app_server/0.142.5", "0.142.5"), "0.142.5");
  assert.equal(requireMinimumCodexVersion("codex_app_server/0.143.0", "0.142.5"), "0.143.0");
  assert.equal(requireMinimumCodexVersion("codex_app_server/0.143.0-alpha.36+build.1 (linux)", "0.142.5"), "0.143.0");
  assert.equal(requireMinimumCodexVersion("codex_app_server/1.0.0", "0.142.5"), "1.0.0");
});

test("rejects older, missing, and malformed versions without leaking the user agent", () => {
  const sentinel = "DO_NOT_LEAK_USER_AGENT_SENTINEL";
  for (const userAgent of [
    `codex_app_server/0.142.4 (${sentinel})`,
    `codex_app_server/0.142 (${sentinel})`,
    `unknown-${sentinel}`,
    undefined,
  ]) {
    let thrown: unknown;
    try { requireMinimumCodexVersion(userAgent, "0.142.5"); } catch (error) { thrown = error; }
    assert.ok(thrown instanceof Error);
    assert.doesNotMatch(thrown.message, new RegExp(sentinel, "u"));
  }
});

test("rejects an invalid configured minimum", () => {
  assert.throws(() => requireMinimumCodexVersion("codex_app_server/0.143.0", "v0.142.5"), /invalid minimum/u);
});
