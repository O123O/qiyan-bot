# Design: Managing Claude Code sessions (a Claude Code endpoint)

Status: draft (rev 2, review-corrected)
Goal: let QiYan manage **Claude Code** sessions the way it manages Codex — start/adopt a session, send a
message, stream the response, set a goal, and schedule/monitor — running headless on the cluster, reusing
QiYan's session/ownership/recovery machinery where it genuinely can.

Grounded in **behavior verified by test on 2026-07-11** (§2). Karpathy: minimal first slice, explicit
assumptions, verifiable success criteria, no speculative abstraction. Rev 2 corrects over-claimed "reuse":
lifecycle/relay/pool are tightly coupled to the Codex JSON-RPC protocol, so the integration is a
**Codex-protocol adapter**, and the MCP scheduling/monitor layer is a **new build**, not reuse.

## 1. The core difference from Codex

- **Codex** = one long-running `codex app-server` daemon per endpoint hosting **many threads** via a JSON-RPC
  protocol (`thread/start`, `thread/read`, `thread/resume`, `turn/start`, notifications). QiYan drives it via
  `pool.request(endpointId, method, params)` and reacts to `turn/completed`.
- **Claude Code** = **no daemon.** Driven per-session as a headless CLI subprocess (`claude -p --resume`) or
  the Agent SDK. A session is a transcript on disk (`~/.claude/projects/<cwd-hash>/<session-id>.jsonl`),
  resumable by id.

So the integration is **one runtime-per-session**. The reuse is real but sits **behind an adapter** that
speaks Codex's request surface (§4.3) — not a drop-in.

## 2. Verified findings (tested today)

- `claude -p` is authenticated on the host (returns `session_id`, cost, usage).
- **`--input-format stream-json` keeps the process open across turns**; one-shot `claude -p "x"` runs one turn
  and exits.
- **`--resume <session-id>` restores full conversation context** — no memory loss. The transcript is the
  durable artifact (the Codex-rollout analog). Cost is re-hydration (cache-creation + cold start), not lost
  memory.
- **`Monitor` is asynchronous and only fires via re-invocation** → **dead in one-shot `claude -p`** (the
  process exits with the monitor merely "armed"). Rather than keep a warm process to host it, QiYan owns
  watching via its own `monitor` MCP tool (§5).
- **Subagents survive a process restart with full context** (verified across three `claude -p` invocations;
  the parent re-attached by id and the subagent recounted its first-turn instruction verbatim). *Completed*
  subagents are transcript-backed and durable; only *in-flight* background work is ephemeral on resume.

## 3. Assumptions (confirm in the spike)

- A1. Headless auth is **API key** (`ANTHROPIC_API_KEY`) or an existing host credential; not interactive OAuth.
- A2. Managed sessions **inherit the user's `~/.claude` config** (CLAUDE.md, skills, MCP) — not `--bare` —
  consistent with "rely on the user's home settings" for Codex workers.
- A3. Single-writer per session, enforced by QiYan's lease/ownership **plus** a Claude-specific external-turn
  detector that does not exist yet (§6) — do not assume this is free.
- A4. All sessions are **fire-and-resume** (process exits between turns). There is **no warm mode** (§5).

## 4. The design

### 4.1 Turn = one `claude -p --resume` invocation (fire-and-resume core)

- **start session:** `claude -p "<first message>" --output-format stream-json` from the session `cwd` →
  capture `session_id` from `system/init`. Register a managed session (transcript = durable artifact).
- **adopt session:** register an existing `session_id`; resume validates it.
- **submit turn:** `claude -p --resume <id> "<message>" --output-format stream-json` → stream events →
  translate to QiYan's turn/item notifications → `result` event = final message → delivery. Process exits.
- **set goal — OPEN DESIGN POINT (not reuse):** QiYan sets Codex goals via Codex's **native** `thread/goal/*`
  RPC and tracks native goal state (`goalControlled`). **Claude Code has no native goal engine.** So goal for
  Claude is new app-layer work — most likely folded onto the §5 MCP mechanism (a standing "goal" prompt QiYan
  re-injects) or a synthesized system-prompt. Resolve in Phase 1; do not assume the Codex goal path applies.

### 4.2 Event translation

A pure translator maps stream-json (`system/init`, `stream_event`/assistant/tool events, `result`) onto
QiYan's turn/item notification shapes. This is where the adapter (§4.3) manufactures the Codex-shaped
`turn/completed` notification and the `thread/read` turn/item structure.

### 4.3 Runtime = a **Codex-protocol adapter** (decision; not runtime-agnostic)

The pool's only seam is `AppServerEndpoint.request(method, params)` (`pool.ts:4-8`), and — critically —
**lifecycle and relay never hold an endpoint object; they call `pool.request(endpointId, "<codex-method>", …)`
with hardcoded Codex method strings and consume Codex-shaped responses**: `thread/start`, `thread/read`
(+`includeTurns`, returning `{status:{type}, turns:[{id,status,items:[{type,phase,text}]}], threadSource,
path, itemsView}`), `thread/resume`, `turn/start`, `turn/interrupt`, `thread/archive`, `thread/unsubscribe`,
`thread/goal/*`; and relay reacts only to the `turn/completed` notification (`relay.ts:112`) then re-reads
history (`relay.ts:252`).

Therefore a Claude runtime **cannot** "plug in without going behind `request()`." We choose the
**least-blast-radius option: a `ClaudeCodeRuntime` that implements Codex's request surface** over per-session
subprocesses, honoring §7 (no changes to shared session/delivery internals). It must:

- `thread/start` → spawn `claude -p`, return a Codex-shaped thread from the captured `session_id`.
- `thread/read` (+includeTurns) → **reconstruct** turns/items/`itemsView`/`status.type` **from the transcript
  on disk** (the process has exited between turns, so there is no live server to query).
- `thread/resume` → validate the transcript resumes.
- `turn/start` → `claude -p --resume <id> "<msg>"`; stream → translate; **synthesize a `turn/completed`
  notification** so relay fires unchanged.
- `turn/interrupt` → kill the subprocess; `thread/archive`/`thread/unsubscribe` → no-op/local.
- `thread/goal/*` → per §4.1 (open; likely emulated, since Claude has no native goal).

The alternative — refactoring pool/lifecycle/relay to a provider-agnostic session interface — is a large
change §7 forbids for now; revisit only if a third provider appears. The transcript-reconstruction of
`thread/read` and the `turn/completed` synthesis are the non-trivial parts and are the spike's real risk.

### 4.4 SDK vs headless

Start with the **headless `claude -p` subprocess** (mirrors QiYan's existing subprocess + jsonl patterns,
keeps sessions out-of-process). Evaluate the **TS Agent SDK** (`@anthropic-ai/claude-agent-sdk`, typed
events/resume/hooks) in the spike and pick one before building the adapter.

## 5. Scheduling AND monitoring are QiYan MCP tools (a NEW BUILD — the largest piece)

Do **not** rely on native schedulers/monitors (Codex has none; Claude Code's is process-bound and dies on
exit — §2), and do **not** keep sessions warm: **you can't predict which sessions need a monitor**, so
warm-vs-cold is guesswork. Every session is fire-and-resume; QiYan owns all scheduling/watching via three MCP
tools any managed session (Codex or Claude) can call:

- `schedule_wakeup(delay, prompt)` — one-shot timer.
- `schedule_cron(spec, prompt)` — recurring timer.
- `monitor(check, prompt, {interval?, timeout?})` — QiYan runs `check` on the session's endpoint on an
  interval; on trigger it fires. Same shape as Claude's native Monitor, but **QiYan** evaluates it — this
  replaces warm mode.

Firing (uniform, both providers): QiYan durably records `(session id, schedule/condition, prompt)`; when it
fires it **resumes the session and drives one turn** with the prompt.

**This is net-new plumbing, not reuse** (corrected from rev 1):
- **Worker-facing MCP surface.** Today `LoopbackMcpServer` is assistant-only — it requires an assistant source
  context and rejects other callers (`mcp/server.ts:152-164`), and workers are spawned with the MCP token
  stripped (`production-app.ts:2218`). Exposing these tools to worker sessions needs a worker-facing MCP
  endpoint, a **worker auth model** (the current one authorizes the assistant PID), and **per-session identity
  injection** (the tool must know which worker called).
- **Durable schedule storage.** None exists — `assistant/scheduler.ts` is in-memory only and doesn't survive
  restart. Needs a new table + a firing loop.
- **Single-fire semantics** with **its own idempotency key** — a scheduler-initiated wakeup is self-originated,
  a different key than relay's per-observed-`turn/completed` delivery. Don't conflate the two.

`monitor` polling is the extra cost: bound the interval; prefer endpoint-native events where available.

**Enforcement — disable the native tools, not just discourage them (verified flags):** a QiYan-managed
Claude session is launched so it *cannot* reach the process-bound native schedulers:
- `--disallowedTools "Monitor ScheduleWakeup CronCreate CronList CronDelete"` — hard-removes the native
  cron/wakeup/monitor tools from the session (the model can't call them). (`--allowedTools`/`--tools` whitelist
  is an alternative.)
- `--mcp-config <qiyan-mcp.json>` (+ `--strict-mcp-config`) — provides the `qiyan_*` scheduling/monitor tools.
- `--append-system-prompt "…scheduling/reminders/watching MUST use the qiyan_* MCP tools; the built-in
  Monitor/ScheduleWakeup/cron tools are disabled…"` — so the model reaches for the right ones and knows why.
Disable + guide together; do not rely on the prompt alone. (Codex sessions get the same MCP tools; Codex has
no native scheduler to disable.)

## 6. Ownership, durability, recovery (state machine reusable; scanner is NEW)

- **Reusable:** the ownership DB tables and the `inspect`/`initialize` state machine, and the phantom-session
  gate — `reconcileManaged`'s `requireDurableRollout` → `ownership.inspect({requireMaterialized})` →
  `{state:"lost"}` when the artifact never materialized (`lifecycle.ts:346-361`, `rollout-ownership.ts`). And
  `RolloutAccess` is already an interface (`rollout-access.ts:40`).
- **NEW (not reuse):** the actual scanner is Codex-specific — `validRolloutPath` requires
  `rollout-*-<threadId>.jsonl` and `RolloutParser` parses Codex `event_msg` payloads
  (`task_started/user_message/task_complete/turn_id/client_id`). Claude transcripts are a different path and
  schema, so a **new `RolloutAccess`/transcript parser + filename validator** must be written.
- **Confirm:** the Claude transcript must expose a per-turn **user-message marker** (equivalent to Codex's
  `hasUserMessage`/QiYan `client_id`) or external-turn classification (single-writer/A3) won't have equivalent
  evidence. Verify in the spike.
- **Durable artifact:** transcript existence / `--resume` success = "has a durable rollout"; the phantom gate
  then drops a session whose transcript never materialized. **Subagents** are durable across restart (§2), so
  a persistent sub-worker can be a continued subagent (parent holds the id) or a separate managed session.
- **cwd/worktree:** sessions are cwd-scoped — matches `project_dir`; use worktrees for isolation.

## 7. Non-goals

- No changes to the shared session/delivery internals — the Codex-protocol **adapter** (§4.3) is precisely how
  we reuse them without touching them.
- **No warm processes at all** — every session is fire-and-resume; monitoring is a QiYan MCP tool (§5).
- No provider-agnostic pool/lifecycle/relay refactor yet (deferred until a third provider).
- No reimplementation of Claude Code's native scheduler/monitor.

## 8. Plan & verifiable success criteria

- **Phase 0 — Spike (before any abstraction).** Drive one session end-to-end from a script: start → capture
  `session_id` → follow-up via `--resume` → stream response → confirm context retained. A/B the SDK vs
  headless. Confirm A1/A2 (auth, `~/.claude` inheritance) and inspect a real transcript for the §6 per-turn
  user-message marker. **Verify:** two turns, second has first-turn context; SDK-vs-headless decided;
  transcript schema documented; auth confirmed.
- **Phase 1 — Codex-protocol `ClaudeCodeRuntime` (§4.3) + event translator + transcript scanner (§6) + goal
  decision (§4.1).** **Verify:** an integration test drives a real/faked session through the adapter: start →
  turn → `turn/completed` synthesized → delivery; a resumed turn carries context; the new scanner lets the
  phantom gate drop a never-materialized session (this criterion depends on the scanner, so it lives here, not
  earlier).
- **Phase 2 — QiYan MCP scheduling/monitor tools (§5, new build):** worker-facing MCP surface + worker auth +
  session identity; durable schedule table; firing loop with its own single-fire key; `monitor` poll.
  **Verify:** a scheduled wakeup fires exactly one resumed turn **after a QiYan restart** (durability), and a
  `monitor` fires on condition — both against a Codex session **and** a Claude session.

## 9. Risks

- R1 (top): the §4.3 adapter — transcript-reconstructed `thread/read` and synthesized `turn/completed` — is
  the hardest part; de-risk in Phase 0/1 with a faked runtime driving the real lifecycle/relay.
- R2: §5 is a large new build (worker MCP + auth + durable schedule + firing loop) — scope it as such, not as
  reuse.
- R3: the §6 scanner needs the Claude transcript schema; if it lacks a clean per-turn user-message marker,
  external-turn detection (A3) weakens — confirm early.
- R4: goal has no Claude-native equivalent (§4.1) — decide emulation vs MCP-standing-prompt in Phase 1.
- R5: stream-json is stable but version-sensitive — pin a Claude Code version, translate defensively.
- R6: auth/config on the worker host (API key, `~/.claude` inheritance) — confirm in Phase 0.

## 10. What this unlocks

QiYan manages Codex and Claude Code sessions uniformly — start/adopt/send/goal + durable cron/reminders/
monitors via the same MCP tools — with per-turn fire-and-resume everywhere and no warm processes. Subagents
work inside turns and survive restarts, so multi-agent work composes under a managed session. The cost is
honest: a Codex-protocol adapter, a new transcript scanner, and a new worker-facing MCP scheduling layer —
none of which are free, all of which are bounded.
