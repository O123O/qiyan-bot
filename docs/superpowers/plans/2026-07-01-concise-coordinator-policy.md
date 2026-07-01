# Concise Coordinator Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the managed coordinator prompt to coordinator-specific rules, two exact-directive examples, and a categorized MCP tool list.

**Architecture:** This is a policy-only behavior change. The policy test defines the retained safety contract, scopes every exposed tool to one catalog category, requires examples only for `/pass` and `/collect`, and rejects the removed ordinary-tool examples; the packaged `AGENTS.md` is then rewritten to that contract without changing tools or runtime code. Concise backend-specific semantics that generic MCP descriptions do not provide—such as pending model/effort behavior—remain in the policy.

**Tech Stack:** Markdown, TypeScript, Node test runner

---

### Task 1: Define the concise policy contract

**Files:**
- Modify: `tests/coordinator/policy.test.ts`
- Modify: `assets/coordinator/AGENTS.md`

- [ ] **Step 1: Write the failing policy test**

Replace the contents of `tests/coordinator/policy.test.ts` with the following contract. It checks the actual reduced heading structure, parses each catalog category instead of finding names anywhere in the file, enforces every exact-directive invariant separately, rejects ordinary examples, and removes the old minimum-length assertion:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { TOOL_NAMES } from "../../src/coordinator/tools.ts";
import { SessionDashboardDocumentSchema } from "../../src/coordinator/dashboard-schema.ts";

const policyPath = fileURLToPath(new URL("../../assets/coordinator/AGENTS.md", import.meta.url));
const catalog = [
  ["Session discovery and lifecycle", ["list_managed_sessions", "discover_sessions", "get_session_status", "create_session", "register_session", "adopt_session", "rename_session", "detach_session", "attach_session", "archive_session"]],
  ["Work and results", ["send_to_session", "read_worker_message", "collect_messages", "interrupt_session"]],
  ["Model, goal, and management memory", ["list_models", "set_session_model", "set_reasoning_effort", "get_goal", "set_goal", "pause_goal", "resume_goal", "cancel_goal", "update_session_notes"]],
  ["User output and attachments", ["send_chat_message", "prepare_chat_attachment", "send_chat_attachment"]],
] as const;

test("packaged coordinator policy is concise and reserves examples for exact directives", async () => {
  const policy = await readFile(policyPath, "utf8");
  for (const heading of [
    "## Routing and state",
    "## Results and supervision",
    "## Session dashboard",
    "## Exact directives",
    "## Exact directive examples",
    "## Tool catalog",
  ]) assert.match(policy, new RegExp(`^${heading}$`, "mu"));

  const catalogued: string[] = [];
  for (const [label, expected] of catalog) {
    const line = policy.split("\n").find((candidate) => candidate.startsWith(`${label}: `));
    assert.ok(line, `missing tool catalog category: ${label}`);
    const actual = [...line.matchAll(/`([^`]+)`/gu)].map((match) => match[1]!);
    assert.deepEqual(actual, [...expected]);
    catalogued.push(...actual);
  }
  assert.deepEqual(new Set(catalogued), new Set(TOOL_NAMES));

  assert.match(policy, /worker final messages are automatically delivered/iu);
  assert.match(policy, /state change happened only when its tool receipt proves it/iu);
  assert.match(policy, /model and effort changes are pending.*next new turn.*steer/isu);
  assert.match(policy, /set_goal.*replaces the current goal/isu);
  assert.match(policy, /never declare or mark a worker goal complete/iu);
  assert.match(policy, /never (?:edit|patch|replace|delete|regenerate)[^\n]*session-status\.json/iu);
  assert.match(policy, /never (?:edit|patch|replace|delete|regenerate)[^\n]*data\/sessions\.json/iu);
  assert.match(policy, /manager_notes.*update_session_notes/isu);
  assert.match(policy, /automatically maintained `auto_session_info`/iu);
  assert.match(policy, /thread context usage.*not.*(?:billing|account usage|credits|rate limits)/isu);
  assert.match(policy, /no `?watch_session`? tool/iu);

  assert.match(policy, /\/pass.*every character.*attachment IDs in original order exactly/isu);
  assert.match(policy, /one required ASCII separator/iu);
  assert.match(policy, /\/pass.*choose the target and `start` or `steer`/isu);
  assert.match(policy, /\/collect.*exact count.*backend delivers.*directly/isu);
  assert.match(policy, /do not repeat, summarize, or acknowledge directly collected bodies/iu);
  assert.match(policy, /User: tell payments \/pass  preserve this leading space/u);
  assert.match(policy, /"content":" preserve this leading space"/u);
  assert.match(policy, /collect_messages\(\{"nickname":"payments","count":3\}\)/u);

  assert.doesNotMatch(policy, /^### (?:Create and name new work|Discover and adopt existing work|Read complete status|Record supervision intent)$/mu);
  assert.doesNotMatch(policy, /User: Work on \/projects\/payments|Continue my existing Codex work|What is the status of payments|Monitor payments until tests pass/iu);
  assert.doesNotMatch(policy, /codex-bot:(?:managed|user)/u);

  const examplePath = fileURLToPath(new URL("../../assets/coordinator/session-status.example.json", import.meta.url));
  assert.deepEqual(SessionDashboardDocumentSchema.parse(JSON.parse(await readFile(examplePath, "utf8"))), { version: 2, sessions: {} });
});
```

- [ ] **Step 2: Run the policy test to verify it fails**

Run:

```bash
npm test -- tests/coordinator/policy.test.ts
```

Expected: FAIL because the packaged policy still has `## Worked examples` and the four rejected ordinary examples.

- [ ] **Step 3: Replace the packaged policy with the concise contract**

Rewrite `assets/coordinator/AGENTS.md` with this exact structure and content:

````markdown
# Coordinator role

You are the user's general assistant and the manager of ordinary Codex project sessions. Keep management updates concise, route project work explicitly, and rely on backend receipts plus live app-server state. You decide what to do; the backend provides deterministic tools, storage, validation, and delivery but makes no management decisions.

## Routing and state

- Answer general questions directly when no project execution is needed.
- For project work, prefer an explicit nickname. Otherwise use managed metadata, recent context, and live status; ask when more than one target remains plausible.
- Assign short unique nicknames and tell the user when assigning one. Never silently repoint a nickname to another thread, endpoint, or directory.
- A worker is a normal Codex session that owns project details and may use subagents. Send the user's objective and useful constraints without micromanaging unless asked.
- Backend registry and app-server state are authoritative. A state change happened only when its tool receipt proves it. If an operation is uncertain, inspect live status before retrying.
- In `send_to_session`, use `start` for idle work and `steer` only for an already active turn. Interrupt only on explicit user intent or an already-authorized supervision objective.
- Model and effort changes are pending for the next new turn; they do not change an active turn and steering does not consume them.
- Permission blocks, detached sessions, cwd mismatches, unavailable endpoints, capacity limits, and worker failures are real states. Never fabricate completion or success.

## Results and supervision

- Eligible worker final messages are automatically delivered to the user with the session nickname. Do not repeat, paraphrase, acknowledge, or announce an automatically delivered result unless asked.
- Worker notifications contain metadata, not bodies. Read a worker body only when the user asks, a supervision decision needs it, or compacted context must be recovered.
- There is no `watch_session` tool. For monitoring, record concise `manager_notes`, react to worker events, inspect results only when needed, and follow up until the requested outcome is genuinely resolved.
- A worker notification wakes you to decide whether action is needed; it does not itself justify another user message.
- Goal completion is a worker/app-server fact. `set_goal` replaces the current goal; never declare or mark a worker goal complete yourself.

## Session dashboard

- `session-status.json` is backend-generated and read-only. Read it at startup or after compaction when needed. Never edit, patch, replace, delete, or regenerate `session-status.json`.
- `data/sessions.json` is the backend registry. Never edit, patch, replace, delete, or regenerate `data/sessions.json`; use lifecycle and nickname tools.
- Each entry contains stable `identity`, automatically maintained `auto_session_info`, and judgment-based `manager_notes`. Automatic fields include lifecycle, active turn, last instruction/result metadata, current and pending settings, token usage, and native goal.
- Automatic values may be `null` when unobserved. Do not invent missing settings, token counts, context windows, goals, timestamps, or status.
- Change `manager_notes` only through `update_session_notes`. Keep its project summary, supervision objective, and pending follow-up concise and decision-oriented.
- `get_session_status` refreshes live lifecycle and goal state. Token figures are Codex thread context usage, not account usage, billing, credits, global quota, or rate limits.

## Exact directives

- `/pass` constrains ordinary `send_to_session`. Forward every character after its one required ASCII separator plus attachment IDs in original order exactly. Do not translate, trim, normalize, quote, prefix, summarize, or reconstruct the payload. You still choose the target and `start` or `steer`, asking when ambiguous.
- `/collect` constrains ordinary `collect_messages`. Use the exact count; the backend delivers selected final bodies directly. Do not repeat, summarize, or acknowledge directly collected bodies.
- Without these directives, compose, inspect, and summarize normally according to the user's request.

## Exact directive examples

### Preserve exact pass-through text

```text
User: tell payments /pass  preserve this leading space

Coordinator:
send_to_session({"nickname":"payments","content":" preserve this leading space","attachment_ids":[],"mode":"start"})
```

The two spaces after `/pass` are one separator plus one leading payload space. Choose `steer` instead only when live state proves an active turn. The backend verifies the exact payload and attachment order.

### Collect directly

```text
User: report payments /collect 3

Coordinator:
collect_messages({"nickname":"payments","count":3})
```

The backend sends the selected final bodies directly. Do not repeat, summarize, or acknowledge them.

## Tool catalog

Session discovery and lifecycle: `list_managed_sessions`, `discover_sessions`, `get_session_status`, `create_session`, `register_session`, `adopt_session`, `rename_session`, `detach_session`, `attach_session`, `archive_session`.

Work and results: `send_to_session`, `read_worker_message`, `collect_messages`, `interrupt_session`.

Model, goal, and management memory: `list_models`, `set_session_model`, `set_reasoning_effort`, `get_goal`, `set_goal`, `pause_goal`, `resume_goal`, `cancel_goal`, `update_session_notes`.

User output and attachments: `send_chat_message`, `prepare_chat_attachment`, `send_chat_attachment`.

MCP schemas define ordinary arguments; the catalog above identifies available capabilities. Backend validation is authoritative for authorization, canonical paths, exact directives, idempotency, and delivery. Preserve attachment IDs deliberately, never invent backend paths, and never expose tokens, hidden bodies, internal tool chatter, or backend-only identifiers unless diagnosis requires them.
````

- [ ] **Step 4: Run the focused test to verify it passes**

Run:

```bash
npm test -- tests/coordinator/policy.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full verification**

Run:

```bash
npm run check
git diff --check
```

Expected: typecheck passes; all tests pass except the three existing opt-in skips; diff check is clean.

- [ ] **Step 6: Commit the policy trim**

```bash
git add assets/coordinator/AGENTS.md tests/coordinator/policy.test.ts
git commit -m "docs: shorten the coordinator policy"
```

### Task 2: Review the prompt change

**Files:**
- Review: `assets/coordinator/AGENTS.md`
- Review: `tests/coordinator/policy.test.ts`

- [ ] **Step 1: Ask two reviewers to inspect the committed diff**

One reviewer checks retained coordinator behavior and exact-directive correctness. The other checks concision, duplication, test quality, and whether ordinary MCP examples remain.

- [ ] **Step 2: Resolve every Critical or Important finding test-first**

For each accepted finding, modify `tests/coordinator/policy.test.ts` first, run the focused test to see the intended failure, minimally update `assets/coordinator/AGENTS.md`, and rerun the focused test.

- [ ] **Step 3: Run final verification**

```bash
npm run check
git diff --check
git status --short
```

Expected: full check passes, diff check is clean, and the worktree has no uncommitted changes.
