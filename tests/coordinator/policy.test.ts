import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { TOOL_NAMES } from "../../src/coordinator/tools.ts";
import { SessionDashboardDocumentSchema } from "../../src/coordinator/dashboard-schema.ts";

const policyPath = fileURLToPath(new URL("../../assets/coordinator/AGENTS.md", import.meta.url));

test("packaged coordinator policy is a complete manager playbook without marker noise", async () => {
  const policy = await readFile(policyPath, "utf8");
  for (const heading of [
    "## Routing",
    "## Live state and lifecycle",
    "## Worker results and supervision",
    "## Exact directives",
    "## Models, effort, goals, and interruption",
    "## Attachments and failures",
    "## Session dashboard",
    "## Worked examples",
  ]) assert.match(policy, new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"));
  for (const name of TOOL_NAMES) assert.match(policy, new RegExp(`\\b${name}\\b`, "u"));
  assert.match(policy, /worker final messages are automatically delivered/iu);
  assert.match(policy, /\/pass.*payload and attachment IDs exactly/isu);
  assert.match(policy, /\/collect.*backend delivers.*directly/isu);
  assert.match(policy, /set_goal.*replaces the current goal/isu);
  assert.match(policy, /never declare or mark a worker goal complete/iu);
  assert.match(policy, /state change happened only when its tool receipt proves it/iu);
  assert.match(policy, /never (?:edit|patch|replace|delete|regenerate)[^\n]*session-status\.json/iu);
  assert.match(policy, /never (?:edit|patch|replace|delete|regenerate)[^\n]*data\/sessions\.json/iu);
  assert.match(policy, /update_session_notes.*manager_notes/isu);
  assert.match(policy, /auto_session_info.*automatic/isu);
  assert.match(policy, /thread context usage.*not.*(?:billing|account usage|credits|rate limits)/isu);
  assert.match(policy, /no `?watch_session`? tool/iu);
  assert.match(policy, /User: Work on \/projects\/payments/iu);
  assert.match(policy, /discover_sessions\(\{"cwd":"\/projects\/payments"\}\)/u);
  assert.match(policy, /get_session_status\(\{"nickname":"payments"\}\)/u);
  assert.match(policy, /update_session_notes\(\{/u);
  assert.match(policy, /User: tell payments \/pass  preserve this leading space/u);
  assert.match(policy, /"content":" preserve this leading space"/u);
  assert.match(policy, /collect_messages\(\{"nickname":"payments","count":3\}\)/u);
  assert.doesNotMatch(policy, /codex-bot:(?:managed|user)/u);
  assert.ok(Buffer.byteLength(policy, "utf8") >= 4_000);

  const examplePath = fileURLToPath(new URL("../../assets/coordinator/session-status.example.json", import.meta.url));
  assert.deepEqual(SessionDashboardDocumentSchema.parse(JSON.parse(await readFile(examplePath, "utf8"))), { version: 2, sessions: {} });
});
