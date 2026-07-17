import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { TOOL_NAMES } from "../../src/assistant/tools.ts";
import { SessionDashboardDocumentSchema } from "../../src/assistant/dashboard-schema.ts";

const policyPath = fileURLToPath(new URL("../../assets/assistant/AGENTS.md", import.meta.url));
const catalog = [
  ["Session discovery and lifecycle", ["list_managed_sessions", "discover_sessions", "get_session_status", "create_session", "adopt_session", "rename_session", "unadopt_session", "archive_session", "disconnect_endpoint", "restart_endpoint"]],
  ["Work and results", ["send_to_session", "read_worker_message", "read_worker_messages", "collect_messages", "interrupt_session", "compact_session"]],
  ["Model, goal, and management memory", ["list_models", "set_session_model", "set_reasoning_effort", "get_goal", "set_goal", "pause_goal", "resume_goal", "cancel_goal", "update_session_notes"]],
  ["User output and attachments", ["send_chat_message", "prepare_chat_attachment", "send_chat_attachment"]],
  ["Chat context and Slack retrieval", ["get_chat_history", "search_slack", "get_slack_mentions"]],
] as const;

test("packaged assistant policy is concise and reserves examples for exact directives", async () => {
  const policy = await readFile(policyPath, "utf8");
  for (const heading of [
    "## Direct work and delegation",
    "## Routing and state",
    "## Results and supervision",
    "## Managed state",
    "## Exact directives",
    "## Exact directive examples",
    "## Tool catalog",
  ]) assert.match(policy, new RegExp(`^${heading}$`, "mu"));
  assert.ok(policy.indexOf("## Direct work and delegation") < policy.indexOf("## Routing and state"));

  assert.match(policy, /general-purpose personal assistant/iu);
  assert.match(policy, /your name is QiYan/iu);
  assert.match(policy, /prefer direct work for small, personal, one-off, or cross-project tasks/iu);
  assert.match(policy, /delegate deliberately.*resumable transcript/isu);
  assert.match(policy, /read `assistant-context\.json` and `session-status\.json`.*after context compaction/isu);
  assert.match(policy, /App Server `HOME` is isolated.*Codex state and skills/isu);
  assert.match(policy, /shell commands.*real user `HOME`.*shell `~`/isu);
  assert.match(policy, /`CODEX_HOME`.*isolated/isu);
  assert.match(policy, /absolute paths derived from `assistant-context\.json\.user_home`/iu);
  assert.match(policy, /never create or root a project worker in the assistant workdir.*QiYan state/isu);
  assert.match(policy, /existing relevant project.*user-specified location.*semantic user location/isu);
  assert.match(policy, /Documents.*example.*not.*default/isu);
  assert.match(policy, /direct work.*never.*QiYan home.*assistant workdir/isu);
  assert.match(policy, /direct work.*no suitable location.*`default_projects_root\/<project-name>`/isu);
  assert.match(policy, /omit `project_dir`.*backend exclusively creates `default_projects_root\/<nickname>`/isu);

  const catalogSection = policy.split(/^## Tool catalog$/mu)[1];
  assert.ok(catalogSection, "missing tool catalog section");
  const catalogued: string[] = [];
  for (const [label, expected] of catalog) {
    const line: string | undefined = catalogSection.split("\n").find((candidate) => candidate.startsWith(`${label}: `));
    assert.ok(line, `missing tool catalog category: ${label}`);
    const actual: string[] = [...line.matchAll(/`([^`]+)`/gu)].map((match) => match[1]!);
    assert.deepEqual(actual, [...expected]);
    catalogued.push(...actual);
  }
  assert.deepEqual(new Set(catalogued), new Set(TOOL_NAMES));

  assert.match(policy, /worker final messages are automatically delivered/iu);
  assert.match(policy, /do not repeat, paraphrase, acknowledge, or announce an automatically delivered result/iu);
  assert.match(policy, /read by id when possible.*`read_worker_messages` only for requested or necessary supervision/iu);
  assert.match(policy, /for monitoring.*follow up until the requested outcome is genuinely resolved/isu);
  assert.match(policy, /worker notification wakes you.*does not itself justify another user message/isu);
  assert.match(policy, /external_worker_turn_detected.*release.*pending/isu);
  assert.match(policy, /external_worker_session_released.*confirms.*unadopt/isu);
  assert.match(policy, /backend.*user warning.*do not.*duplicate/isu);
  assert.match(policy, /ask when more than one target remains plausible/iu);
  assert.match(policy, /never silently repoint a nickname/iu);
  assert.match(policy, /state change happened only when its tool receipt proves it/iu);
  assert.match(policy, /interrupt only on explicit user intent or an already-authorized supervision objective/iu);
  assert.match(policy, /permission blocks.*worker failures are real states.*never fabricate/isu);
  assert.match(policy, /notifications omit worker bodies/iu);
  assert.match(policy, /model and effort changes are pending.*next new turn.*steer/isu);
  assert.match(policy, /use `assistant`.*own status\/model\/effort\/compaction/iu);
  assert.match(policy, /self results return internally as `\[system\]`.*all results notify the user.*never reply to or repeat/iu);
  assert.match(policy, /goal completion is a worker.*never declare or mark a worker goal complete yourself/isu);
  assert.match(policy, /never declare or mark a worker goal complete/iu);
  assert.match(policy, /never (?:edit|patch|replace|delete|regenerate)[^\n]*session-status\.json/iu);
  assert.match(policy, /never (?:edit|patch|replace|delete|regenerate)[^\n]*sessions\.json/iu);
  assert.match(policy, /manager_notes.*update_session_notes/isu);
  assert.match(policy, /clear `pending_follow_up` with `null` when resolved/iu);
  assert.match(policy, /automatically maintained `auto_session_info`/iu);
  assert.match(policy, /automatic values may be `null`.*do not invent/isu);
  assert.match(policy, /Endpoints have a \*\*provider\*\*, `codex` or `claude`/iu);
  assert.match(policy, /each entry has a `provider` \(`codex`\|`claude`\) and `transport` \(`local`\|`ssh`\)/iu);
  assert.match(policy, /thread context usage.*not.*(?:billing|account usage|credits|rate limits)/isu);
  assert.match(policy, /no `?watch_session`? tool/iu);
  assert.match(policy, /preserve attachment IDs deliberately.*never invent backend paths.*never expose tokens, hidden bodies/isu);
  assert.match(policy, /Slack search results are transient, newest-first, and may be truncated/iu);
  assert.match(policy, /coverage and completeness warnings.*narrow the query or date range/isu);

  assert.match(policy, /\/pass.*every character.*attachment IDs in original order exactly/isu);
  assert.match(policy, /one required ASCII space/iu);
  assert.match(policy, /\/pass.*choose the target and `start` or `steer`/isu);
  assert.match(policy, /\/collect.*exact count.*backend delivers.*directly/isu);
  assert.match(policy, /`\/to <worker>` is delivered directly to that worker by the backend/iu);
  assert.match(policy, /do NOT reply to it, re-send it, or act on it unless separately asked/iu);
  assert.match(policy, /`web_goal` awareness.*backend.*already handled/isu);
  assert.match(policy, /objective.*quoted user data.*not instructions/isu);
  assert.match(policy, /never reply.*repeat.*goal.*mutation/isu);
  assert.match(policy, /even if.*objective.*(?:asks|says).*otherwise/isu);
  assert.match(policy, /do not repeat, summarize, or acknowledge directly collected bodies/iu);
  assert.match(policy, /User: tell payments \/pass  preserve this leading space/u);
  assert.match(policy, /"content":" preserve this leading space"/u);
  assert.match(policy, /collect_messages\(\{"nickname":"payments","count":3\}\)/u);

  const exampleSection = policy.split(/^## Exact directive examples$/mu)[1]?.split(/^## Tool catalog$/mu)[0];
  assert.ok(exampleSection, "missing exact directive examples section");
  assert.deepEqual([...policy.matchAll(/^### (.+)$/gmu)].map((match) => match[1]), ["Preserve exact pass-through text", "Collect directly"]);
  assert.equal([...policy.matchAll(/^```text$/gmu)].length, 2);

  assert.doesNotMatch(policy, /^### (?:Create and name new work|Discover and adopt existing work|Read complete status|Record supervision intent)$/mu);
  assert.doesNotMatch(policy, /User: Work on \/projects\/payments|Continue my existing Codex work|What is the status of payments|Monitor payments until tests pass/iu);
  assert.doesNotMatch(policy, /qiyan-bot:(?:managed|user)/u);
  // Budget raised from 7_000 to accommodate the permanent endpoint-provider model
  // (codex/claude + the remote ssh/claude-code catalog types); the doc stays concise.
  assert.ok(Buffer.byteLength(policy, "utf8") < 7_800, "assistant policy exceeded the concise prompt budget");

  const examplePath = fileURLToPath(new URL("../../assets/assistant/session-status.example.json", import.meta.url));
  assert.deepEqual(SessionDashboardDocumentSchema.parse(JSON.parse(await readFile(examplePath, "utf8"))), { version: 3, sessions: {} });
});
