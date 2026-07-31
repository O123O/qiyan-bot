import assert from "node:assert/strict";
import test from "node:test";
import {
  checkClaudeRuntimeRequirements,
  compareVersions,
  MIN_CLAUDE_CLI_VERSION,
  parseClaudeVersion,
  resolveClaudeCli,
} from "../../src/claude-host/requirements.ts";

const okExec = async () => ({ stdout: "2.1.220 (Claude Code)\n" });

test("the CLI version is read from real --version output", () => {
  assert.equal(parseClaudeVersion("2.1.220 (Claude Code)\n"), "2.1.220");
  assert.equal(parseClaudeVersion("no version here"), undefined);
});

test("version comparison orders by component, not lexically", () => {
  assert.equal(compareVersions("2.1.220", "2.1.220"), 0);
  assert.equal(compareVersions("2.1.9", "2.1.220"), -1, "9 < 220 despite sorting later as text");
  assert.equal(compareVersions("2.2.0", "2.1.220"), 1);
  assert.equal(compareVersions("2.1", "2.1.0"), 0, "a missing component reads as zero");
});

test("a satisfying CLI resolves to its version", async () => {
  assert.equal(await resolveClaudeCli("claude", { exec: okExec }), "2.1.220");
});

// The SDK's JS and the CLI ship together, so an older CLI can lack control-protocol
// capabilities the host depends on. It must fail closed rather than accept turns.
test("an older CLI is refused with an actionable message", async () => {
  await assert.rejects(
    resolveClaudeCli("claude", { exec: async () => ({ stdout: "2.0.1 (Claude Code)" }) }),
    (error: any) => {
      assert.equal(error.code, "UNSUPPORTED_CAPABILITY");
      assert.match(error.message, new RegExp(MIN_CLAUDE_CLI_VERSION));
      assert.match(error.message, /Upgrade Claude Code/u);
      return true;
    });
});

test("a missing CLI names the executable and how to fix it", async () => {
  await assert.rejects(
    resolveClaudeCli("/nowhere/claude", { exec: async () => { throw new Error("ENOENT"); } }),
    (error: any) => {
      assert.equal(error.code, "CONFIGURATION_ERROR");
      assert.match(error.message, /\/nowhere\/claude/u);
      assert.match(error.message, /Install Claude Code/u);
      return true;
    });
});

test("unreadable version output is refused rather than assumed current", async () => {
  await assert.rejects(
    resolveClaudeCli("claude", { exec: async () => ({ stdout: "claude: command not found" }) }),
    /could not read a version/u);
});

// The SDK is external to the bundle, so a deployment that never installed it must say so
// rather than crashing on module resolution.
test("a missing Agent SDK is reported as a deployment prerequisite", async () => {
  await assert.rejects(
    checkClaudeRuntimeRequirements({
      claudeExecutable: "claude",
      importer: async () => { throw new Error("Cannot find module"); },
      exec: okExec,
    }),
    (error: any) => {
      assert.equal(error.code, "CONFIGURATION_ERROR");
      assert.match(error.message, /Agent SDK is not installed/u);
      assert.match(error.message, /deployment prerequisite/u);
      return true;
    });
});

test("both prerequisites present reports the versions in play", async () => {
  const result = await checkClaudeRuntimeRequirements({
    claudeExecutable: "/usr/local/bin/claude",
    importer: async () => ({ VERSION: "0.3.220" }),
    exec: okExec,
  });
  assert.deepEqual(result, {
    sdkVersion: "0.3.220",
    claudeVersion: "2.1.220",
    claudeExecutable: "/usr/local/bin/claude",
  });
});

// The SDK is checked before the CLI: a host missing both should be told about the SDK
// first, since installing it is the step that also makes the CLI check meaningful.
test("the SDK is checked before the CLI", async () => {
  await assert.rejects(
    checkClaudeRuntimeRequirements({
      claudeExecutable: "/nowhere/claude",
      importer: async () => { throw new Error("Cannot find module"); },
      exec: async () => { throw new Error("ENOENT"); },
    }),
    /Agent SDK is not installed/u);
});
