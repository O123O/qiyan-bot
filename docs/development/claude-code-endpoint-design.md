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
  durable artifact (the Codex-rollout analog).
- **Prompt caching works across separate `-p` processes** (tested): a resumed `-p` process reads cache a prior
  process created (server-side, prefix-keyed) — measured `cache_read=15122` on a back-to-back resume. But the
  cache has a **~5-min TTL** (extendable to 1h). So closely-spaced turns re-hydrate cheaply (`cache_read`);
  turns spaced **beyond the TTL** (an infrequent cron/reminder) pay full `cache_creation` each fire. That
  re-hydration is the accepted, bounded cost of fire-and-resume with no warm mode — active sessions keep
  interactive-grade caching; only genuinely-idle-then-woken sessions pay full context load.
- **`Monitor` is asynchronous and only fires via re-invocation** → **dead in one-shot `claude -p`** (the
  process exits with the monitor merely "armed"). Rather than keep a warm process to host it, QiYan owns
  watching via its own `monitor` MCP tool (§5).
- **Subagents survive a process restart with full context** (verified across three `claude -p` invocations;
  the parent re-attached by id and the subagent recounted its first-turn instruction verbatim). *Completed*
  subagents are transcript-backed and durable; only *in-flight* background work is ephemeral on resume.

## 3. Assumptions (confirm in the spike)

- A1. ~~Headless auth is **API key** (`ANTHROPIC_API_KEY`).~~ **Corrected by spike (2026-07-11):** headless
  auth uses the host's **existing Claude Code login (subscription OAuth)** — resolved with no
  `ANTHROPIC_API_KEY`, no `~/.claude/.credentials.json`, no `apiKeyHelper` (token lives in the CLI's own
  store/keyring). QiYan runs `claude` as the target user and inherits that login; it manages neither
  credentials nor permissions. *Open (R6): OAuth token refresh/expiry over a long-running bot — Phase 1.*
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
- **goal — DIVERGES from Codex; emulate the *ownership* half, not the primitive:** QiYan uses Codex's native
  `thread/goal/*` primarily for **turn attribution** — a goal makes QiYan-generated turns `goalControlled` →
  classified **owned** (vs external) in the ownership logic (`rollout-ownership.ts:241,316`). Claude Code's
  `/goal` is a *different* mechanism (a session-scoped **Stop hook** that blocks the agent from stopping until
  a condition holds — a "keep working" loop), not a turn-attribution primitive, so it does not substitute.
  Emulation splits in two: **(a) ownership** → already covered by the **`clientId` per-turn marker** (§4.3/§6):
  QiYan stamps every turn it authors, so owned-vs-external is answered by the marker, not a goal — no goal
  primitive needed. **(b) "keep pursuing" persistence** → QiYan drives turns (orchestrator owns the loop)
  and/or the §5 `monitor`/`schedule_cron` tools; optionally a session-self-persistence Stop hook via
  `--settings`. Resolve the persistence choice in Phase 1; the ownership half is already designed.
- **steer — DIVERGES from Codex; emulate `turn/steer` as a durable QiYan-side queue (never abort):** there is
  no separate steer tool — `send_to_session(…, mode: "auto"|"start"|"steer")` (`service.ts:35`) makes QiYan
  **pick the mode and call a distinct Codex method**: `turn/start` (new turn) or **`turn/steer`**
  (`service.ts:58`, inject into the running turn; Codex holds/queues it natively). For Claude, `turn/start` →
  `claude -p --resume` works, but **`turn/steer` has no native equivalent** and Claude has **no knowledge of a
  pending steer** — so **QiYan owns and persists the queue** (with Codex the app-server holds it; with Claude
  it moves into QiYan). Model:
  - Steer while the subprocess is running → QiYan **stores the message in a durable per-session queue**;
    **do NOT touch the running subprocess** (no abort).
  - On `turn/completed`, QiYan **drains the queue FIFO**, driving each as the next turn (`turn/start`).
    **Single-delivery + survives QiYan restart** (a crash mid-turn must neither lose nor double-send it).
  - **No interrupt in the steer path.** Deliberate stopping stays a *separate* explicit action
    (`interrupt_session` → kill subprocess), never a side effect of steering.
  This reuses the §5 "drive a turn with a stored message" durable mechanism — steer is just triggered by
  turn-completion instead of a timer/condition. Under fire-and-resume a Claude session is only "mid-turn"
  while QiYan awaits the subprocess, so `mode:"auto"` resolves to start (idle) or enqueue-for-next.

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
`thread/read` and the `turn/completed` synthesis are the non-trivial parts and were the spike's real risk —
**now de-risked (2026-07-11):** the reconstruction rule and interrupted-turn shape are pinned above with
committed fixtures, and remote round-trip + remote→local MCP reachability were proven end-to-end (Phase-0
FINDINGS 0.2/0.6/0.7).

**Adapter contract (must meet — verified against the code; fold into Phase-1 scope):**
- **Endpoint-lifecycle shape:** be a **parallel `ManagedAppServerEndpoint`-shaped class** that satisfies the
  pool/`EndpointManager` duck-typed surface (`start`, `closeConnection`, `onNotification`, `onUnavailable`,
  `onPermissionBlocked`, `runtimeIdentity`, etc.) **but bypasses** the Codex handshake — a daemon-less Claude
  session has no `RpcWire`, `initialize`, `initialized`, or `account/read` (`managed-endpoint.ts:93-103`).
  Do NOT implement `AppServerRuntimeService` directly (that would trigger that handshake).
- **`thread/read` must include `cwd`** — lifecycle verifies it everywhere (`verifyCwd`, `requireFreshThread`
  `lifecycle.ts:510,526-536`). Supply it from the known session cwd.
- **`clientUserMessageId` round-trip:** `turn/start` stamps a `clientUserMessageId` (`pool.ts:319`) and
  reconciliation finds the `thread/read` item `type:"userMessage"` with matching `clientId` (`:475-486`);
  ownership keys on `client_id` too. The synthesized user item MUST echo back QiYan's clientId.
  **Spike-verified (2026-07-11):** the message content is stored **verbatim** in the turn-start `user` row, so
  QiYan stamps its clientId into the message and reads it back — the round-trip mechanism is proven; 1.1
  picks the encoding.
- **Transcript reconstruction rule (spike-verified 2026-07-11; fixtures in `spike/fixtures/`):** a turn does
  **NOT** boundary on "any `user` row" — a tool result is itself a `user`-type row. **A turn starts on a
  `user` row whose `promptSource` is non-null** (`"sdk"` for headless/QiYan-driven); a `user` row with
  `promptSource=null` + `tool_result` content is mid-turn. Coalesce all `assistant` rows of a turn (it emits
  `thinking`/`text`/`tool_use` as **separate** rows) plus interleaved `tool_result` `user` rows until
  `stop_reason=end_turn` (or the next non-null-`promptSource` `user` row). **Subagents are NOT interleaved** —
  a `Task`/`Agent` subagent appears only as an `assistant` `tool_use:Agent` + its `tool_result`; the
  subagent's own transcript is a **sidecar file** (`<session_id>/subagents/agent-*.jsonl`), and `isSidechain`
  stays `False` in the main transcript. **An interrupted turn** (subprocess killed mid-generation) leaves the
  turn-start `user` row but **no `assistant` row and no `result` row** (disk lags the stream) → so
  `turn/completed` must be synthesized from the **stream**, never by re-reading the transcript mid-turn, and
  recovery detects an interrupted turn as a non-null-`promptSource` `user` row with no following `end_turn`.
  *(Still to capture in 1.1: the exact `promptSource` value of a human-interactive turn — for external-turn
  classification — and a compaction/summary transcript.)*
- **Specific item shapes:** final delivery extracts `type:"agentMessage"` + `phase:"final_answer"` (or null) +
  `text`, keyed by `item.id` (`final-messages.ts:29`); turn identity needs `type:"userMessage"` + `clientId`.
  The translator must emit exactly these.
- **Error shapes:** either reproduce the exact `JsonRpcResponseError` code `-32600` messages
  (`thread-errors.ts:3-13`) or be structured so those recovery branches are never reached (a transcript-backed
  read has no daemon "not loaded" state — plausible). State which.
- **Notifications must be emitted:** relay only reacts to a pushed `turn/completed` via `onNotification`
  (`relay.ts:112`, param `{threadId, turn:{id}}`); the adapter must actively push it (and decide on
  `onPermissionBlocked`).

### 4.4 The existing assistant manager tools work unchanged for both providers (the adapter payoff)

The assistant's manager tools (`send_to_session`, `get_session_status`, `adopt_session`, `get_chat_history`,
`list_managed_sessions`, `unadopt_session`, …) call QiYan's session layer (service → lifecycle →
`pool.request`), never Codex directly. Because the adapter (§4.3) makes a Claude session present the Codex
request surface, these tools are **provider-blind and require no change**. Mapping:
- `send_to_session(nick, msg)` → `turn/start` → adapter runs `claude -p --resume <id> <STABLE flags> "msg"`;
  on completion the adapter **synthesizes `turn/completed`** → the response returns through QiYan's normal
  relay/delivery path (async, same as Codex — not a synchronous tool return).
- `get_chat_history` / `get_session_status` → `thread/read` → adapter **reconstructs turns/items from the
  session `.jsonl` transcript**. "Old responses" = the transcript, read on demand. This is the *same*
  reconstruction QiYan's own delivery uses — **one implementation serves both** the assistant's history reads
  and QiYan's final-message extraction.
- `adopt_session` → `thread/resume`; `unadopt`/`archive` → local/no-op per §4.3.
- `interrupt_session(nick, turn_id?)` (a real manager tool, `production-app.ts:2855`) → `turn/interrupt` →
  adapter **kills the `claude -p` subprocess** (the transcript up to the kill survives). Works for both.

**The one exception — the goal tools.** `get_goal`/`set_goal`/`pause_goal`/`resume_goal`/`cancel_goal`
(`production-app.ts:2880-2919`) map to Codex's **native `thread/goal/*`**, which Claude lacks. These are the
*only* manager tools that do **not** reuse transparently; they need the §4.1 emulation (QiYan-tracked goal
state + persistence via QiYan driving / an optional Stop hook; ownership already handled by the `clientId`
marker). All other manager tools work by construction through the adapter.

So the unified-tools requirement is satisfied *by construction* for everything except the goal family — it is
the reason to choose the adapter over a refactor. The cost is concentrated in the one transcript-reconstruction
(§4.3/§6), reused everywhere.

### 4.5 Runtime: headless `claude -p` (decided) — and remote is trivial

Use the **headless `claude -p` subprocess** — it mirrors QiYan's existing subprocess + jsonl patterns
(`LocalAppServerRuntime`) and keeps sessions out-of-process. The TS Agent SDK is **not** used (decision closed;
no comparison). Each turn is one `claude -p --resume` invocation with stable flags.

**Remote (SSH) needs no server and no forwarding — a major simplification over remote Codex.** Remote Codex
uses `SshAppServerRuntime`: launch a `codex app-server` *daemon* on the remote, forward its socket over SSH,
speak JSON-RPC through the tunnel, manage the remote daemon lifecycle (a source of past incidents). Remote
Claude is just **`ssh <host> claude -p --resume <id> …`** over the existing **ControlMaster** connection —
stream-json over the SSH pipe, the subprocess exits after the turn. No remote daemon, no port forwarding, no
tunnel. Local vs remote differ in exactly two already-solved places: (1) **spawn** — the runtime is
parameterized by a *command runner* (direct vs `ssh`-wrapped, reusing QiYan's SSH channel + ControlMaster);
(2) **transcript location** — local disk vs the remote `~/.claude/…`, read over the **same SSH command
channel** (`RolloutAccess.scan` and the `monitor` `check` already "run on the session's endpoint"). Everything
else (adapter, scheduling, steer, recovery) is identical. Confirmed: `dfw-vscode` has `claude` installed and
ControlMaster is active. So remote support is a spawn parameter, not a subsystem.

## 5. Scheduling, monitoring, and steer — one provider-agnostic layer over `send_to_session`

**The core modularity decision (keeps the code clean):** this whole capability is a **provider-agnostic layer
that, on any trigger, calls the already-unified `send_to_session(session, message)`.** It **never knows Codex
vs Claude** — that divergence is entirely sealed *below* `send_to_session` (pool + adapter). Consequences:
- **Both providers gain it.** Codex has no native wakeup/cron/monitor either, so this is **net-new for both,
  from one codebase** — a capability upgrade, not a Claude workaround.
- **Zero provider branching in the scheduling code.** The messy bits (subprocess vs daemon, steer emulation,
  transcript reconstruction) stay inside the adapter; the scheduler only ever calls `send_to_session`.

**The three SCHEDULING triggers collapse into ONE provider-agnostic pattern** — a durable `(session, message)`
+ a **trigger** → on fire, `send_to_session` — differing only in the trigger: `schedule_wakeup` = absolute
time; `schedule_cron` = recurring time; `monitor` = a `check` predicate polling true. These are fully
provider-blind (firing = `send_to_session` → `turn/start`).

**Steer is the one exception (provider-specific, below `send_to_session`).** `send_to_session(mode:"steer")` →
`turn/steer`, whose *queueing* differs by provider and lives in the **adapter**, not the scheduling engine:
**Codex keeps its native `turn/steer`** (the app-server queues into the running turn — unchanged, no
regression); **Claude's adapter implements `turn/steer` as a durable enqueue** into the *same* store with a
"turn-completed" trigger, so Claude steer *reuses* the store + firing while Codex steer stays native. So it's
**one durable store + one firing path for scheduling (provider-blind) + a steer path whose provider difference
is contained in the adapter** (Claude reuses the store; Codex is native).

**Module boundaries (what prevents the mess):** (1) **schedule store** (durable DB: `session, trigger,
message, single-fire key`; provider-agnostic); (2) **MCP tools** (the worker-facing registration surface,
below); (3) **trigger engine** (QiYan-internal: timers + condition poller + turn-completion hook → on fire,
`send_to_session`; single-fire idempotent; provider-agnostic); (4) **`send_to_session`** (existing unified
dispatch; Codex/Claude live only below here). Registration flows up (agent → MCP → store); firing flows down
(engine → `send_to_session` → provider). The only provider-aware code is the adapter.

Do **not** rely on native schedulers/monitors (Codex has none; Claude Code's is process-bound and dies on
exit — §2), and do **not** keep sessions warm: **you can't predict which sessions need a monitor**, so
warm-vs-cold is guesswork. Every session is fire-and-resume. The registration surface — three MCP tools any
managed session (Codex or Claude) can call:

- `schedule_wakeup(delay, prompt)` — one-shot timer.
- `schedule_cron(spec, prompt)` — recurring timer.
- `monitor(check, prompt, {interval?, timeout?})` — `check` is a **shell command** (a stateless predicate)
  that QiYan runs **on the session's endpoint** (the worker host — local or SSH, reusing that command channel,
  with the worker's own permissions) every `interval`; **exit code 0 = condition met → fire** (resume with
  `prompt`), non-zero = keep polling, bounded by `timeout`. Note the difference from native Monitor: native
  takes a *blocking until-loop* command run by a live process; QiYan takes just the **predicate**, polled — so
  it's durable (survives the session process exiting and a QiYan restart). Constraints: `check` must be
  side-effect-free (run repeatedly); floor the `interval` (e.g. ~10–30s) so polling doesn't hammer the
  endpoint. This replaces warm mode.
- `list_schedules()` — list this session's pending wakeups/crons/monitors (unified across all three types;
  ↔ native `CronList` but not cron-only).
- `cancel_schedule(id)` — cancel any pending wakeup/cron/monitor by id (↔ native `CronDelete`, all types).

**Five tools total** (3 create + 2 manage). Unified `list`/`cancel` (rather than mirroring native's cron-only
list/delete) because in QiYan's durable model every wakeup/cron/monitor is a persistent row the agent should
see and cancel. No `update` (cancel+recreate). Optional: `schedule_wakeup`+`schedule_cron` could merge into one
`schedule(when,…)`, but keeping them separate matches the native mental model so they read as true drop-ins.

Firing (uniform, both providers): QiYan durably records `(session id, trigger, message, single-fire key)`;
when the trigger fires, the engine **calls `send_to_session(session, message)`** — the same unified tool the
assistant uses. It does NOT special-case the provider; `send_to_session` dispatches to Codex `turn/start` or
the Claude adapter. If the session is mid-turn at fire time, delivery follows the steer rule (§4.1: enqueue,
deliver as the next turn) — so a fire never interrupts a running turn.

**How the MCP tools are attached (decision):** per-invocation `--mcp-config` (a file/JSON on the `claude -p`
command), **not** `~/.claude.json` or a project `.mcp.json`. Rationale: the QiYan tools must exist **only when
QiYan drives a turn** — if the user later resumes the session themselves (`claude --resume <id>` without the
flag), the QiYan MCP is simply absent and the session is clean (historical QiYan tool calls in the transcript
are inert). Do **not** use `--strict-mcp-config` — QiYan's tools are **additive** so the worker keeps the
user's own `~/.claude` MCP (inherit-home-settings). Keep the `--mcp-config` byte-identical every QiYan turn
(MCP tool defs are in the cached prefix — a change re-creates cache like a changed system prompt). For a
**remote** worker the `--mcp-config` must point at a QiYan MCP surface reachable from that host (URL+token, or
a stdio launcher tunneling over the existing SSH channel) — see the worker-facing MCP item below.

**This is net-new plumbing, not reuse** (corrected from rev 1):
- **Worker-facing MCP surface.** Today `LoopbackMcpServer` is assistant-only — it requires an assistant source
  context and rejects other callers (`mcp/server.ts:152-164`), and workers are spawned with the MCP token
  stripped (`production-app.ts:2218`). Exposing these tools to worker sessions needs a worker-facing MCP
  endpoint, a **worker auth model** (the current one authorizes the assistant PID), and **per-session identity
  injection** (the tool must know which worker called).
- **Durable schedule storage.** None exists — a **net-new additive** table + firing loop (NOT a replacement:
  `assistant/scheduler.ts` is the assistant's conversation batching engine, unrelated — do not touch it).
  Durable so it survives QiYan restart.
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
**Design the MCP tools as drop-in replacements.** Give them clear, **QiYan-owned, provider-neutral**
descriptions that capture the *same when/how* as the native `Monitor`/`ScheduleWakeup`/cron (informed by, but
NOT verbatim copies of, Claude's — verbatim couples to version-specific wording and reads wrong for a tool
Codex also calls), each noting it *replaces any built-in scheduler*. The model then reaches for them naturally.

Three-part enforcement, in order of necessity (tested 2026-07-11 — the "when to use" guidance lives in tool
*descriptions*, so `--disallowedTools` removes the native tools cleanly; but **skills ≠ tools**, so `/loop`
survives the tool disable):
1. **Disable the native tools** (`--disallowedTools "Monitor ScheduleWakeup CronCreate CronList CronDelete"`) —
   REQUIRED: otherwise the model may pick a native version that silently fails in fire-and-resume.
2. **Provide the drop-in MCP tools** — REQUIRED: gives one working, obvious choice.
3. **One `--append-system-prompt` redirect line** ("for scheduled/recurring/watch work use the qiyan_* tools,
   not /loop or background Bash/hooks") — REQUIRED and sufficient for the surviving `/loop` skill: with the
   native tool disabled `/loop` is already broken (it calls the disabled `ScheduleWakeup`) and, given the
   drop-in, unpreferred. **Per-skill disabling of `/loop` is therefore optional insurance, not needed.**
(Codex sessions get the same MCP tools; Codex has no native scheduler to disable.)

**Tool-disable is porous — and that is fine (verified 2026-07-11).** Spike 0.3 showed the disable removes the
named *tool*, not the *capability*: with `Bash` disabled and no redirect, the model still ran a shell command
by routing through other exposed tools (`Monitor`/`TaskOutput`). We deliberately do **not** try to wall off
every alternate path — the goal is only that the model reaches for QiYan's durable MCP tools, and step 3's
redirect achieves that (with all five disabled + the redirect, the model invoked none of them and reached for
the `qiyan_*` tools by name). Any alternate route the model might improvise (background Bash, hooks) is itself
**process-bound** — it dies on `claude -p` exit and cannot deliver durable scheduling anyway, so it is
harmless. So: **redirect to the MCP tools; don't chase model workarounds.** The positive control confirmed the
disable is a real block (when *allowed*, the model does invoke `ScheduleWakeup`/`Bash`; when disallowed it
cannot), and both `--disallowedTools "A B C"` (space-joined) and per-flag forms parse correctly.

**Launch flags must be stable per session (a caching requirement, tested).** `--append-system-prompt` is a
*per-invocation* parameter — it is not stored in the session/transcript, so it must be re-passed on **every**
turn, and it sits at the **front of the cached prefix**, so it must be **byte-identical** each turn or the
cache breaks from that point on. Measured: identical append → full hit (`creation≈8`, `read≈27.7k`); a changed
append re-creates ~12.5k tokens (tools + history) **every turn**. So `ClaudeCodeRuntime` must launch each turn
of a session with **deterministic, identical** prompt-affecting flags (`--append-system-prompt`,
`--disallowedTools`, `--mcp-config`, model). The disabled tool-name strings must be exact — a mismatched name
makes `--disallowedTools` a **silent no-op** (downgrades to prompt-only). Phase 0 verified (2026-07-11) the
exact strings `Monitor ScheduleWakeup CronCreate CronList CronDelete`, that the space-joined form parses, and
via a positive control that the model genuinely cannot invoke each once disabled (it invokes them when
allowed).

## 6. Ownership, durability, recovery (state machine reusable; scanner is NEW)

- **Reusable:** the ownership DB tables and the `inspect`/`initialize` state machine, and the phantom-session
  gate — `reconcileManaged`'s `requireDurableRollout` → `ownership.inspect({requireMaterialized})` →
  `{state:"lost"}` when the artifact never materialized (`lifecycle.ts:346-361`, `rollout-ownership.ts`). And
  `RolloutAccess` is already an interface (`rollout-access.ts:40`).
- **NEW (not reuse):** the actual scanner is Codex-specific — `validRolloutPath` requires
  `rollout-*-<threadId>.jsonl` and `RolloutParser` parses Codex `event_msg` payloads
  (`task_started/user_message/task_complete/turn_id/client_id`). Claude transcripts are a different path and
  schema, so a **new `RolloutAccess`/transcript parser + filename validator** must be written — implementing
  **both** `scan` and `scanUnmaterialized` (ownership throws if the latter is absent,
  `rollout-ownership.ts:368-371`): the materialized and not-yet-materialized transcript cases.
- **Confirm:** the Claude transcript must expose a per-turn **user-message marker** (equivalent to Codex's
  `hasUserMessage`/QiYan `client_id`) or external-turn classification (single-writer/A3) won't have equivalent
  evidence. Verify in the spike.
- **Durable artifact:** transcript existence / `--resume` success = "has a durable rollout"; the phantom gate
  then drops a session whose transcript never materialized. **Subagents** are durable across restart (§2), so
  a persistent sub-worker can be a continued subagent (parent holds the id) or a separate managed session.
- **cwd/worktree:** sessions are cwd-scoped — matches `project_dir`; use worktrees for isolation.

**QiYan-restart recovery — two halves:**
- **Sessions/turns REUSE existing recovery** (via the adapter): reload managed sessions from the registry;
  reconcile each through the adapter's transcript-reconstructed `thread/read` — the transcript says whether the
  last turn *completed* (deliver a response QiYan may have missed) or was *interrupted*; phantom-gate/ownership
  apply (transcript = rollout). No new mechanism — the reconcileManaged + uncertain-delivery path you already
  hardened, working for Claude because the adapter presents Codex shapes.
- **The new "pending → drive a turn" layer is NET-NEW durable state that must reload + re-arm:** goal, wakeup,
  cron, monitor, and the steer queue must live in a **net-new durable DB table** (not in-memory; do not touch
  `assistant/scheduler.ts` — the unrelated conversation batcher). Recovery re-arms each: wakeups (fire on recovery if the time passed, else
  reschedule), cron (recompute next fire; missed-occurrence policy), monitors (restart the poll loop), steer
  queue (reload FIFO, drain after the in-flight turn is reconciled), goal (reload + resume enforcement).
  **Single-fire idempotency key per fire/delivery** so recovery never double-fires or re-sends — reuse the
  hardened delivery-idempotency discipline, do not reinvent.
- **In-flight turn on crash:** a `claude -p` child dies with QiYan → the turn is interrupted; reconcile from
  the transcript (completed → deliver + drain queued steer; incomplete → resume/re-drive). Design choice:
  **child + re-drive (MVP, simpler)** vs **detached subprocess** (turn survives QiYan restart and completes
  independently — how Codex gets it free via its daemon — but manages orphans). Start with child + re-drive.

## 7. Non-goals

- No changes to the shared session/delivery internals — the Codex-protocol **adapter** (§4.3) is precisely how
  we reuse them without touching them.
- **No warm processes at all** — every session is fire-and-resume; monitoring is a QiYan MCP tool (§5).
- No provider-agnostic pool/lifecycle/relay refactor yet (deferred until a third provider).
- No reimplementation of Claude Code's native scheduler/monitor.

## 8. Plan & verifiable success criteria

- **Phase 0 — Spike (before any abstraction).** Drive one session end-to-end from a script: start → capture
  `session_id` → follow-up via `--resume` → stream response → confirm context retained (headless `claude -p`,
  decided). Confirm A1/A2 (auth, `~/.claude` inheritance) and inspect a real transcript for the §6 per-turn
  user-message marker. Also assert the native schedulers are genuinely neutralized — spawn a session with
  `--disallowedTools "Monitor ScheduleWakeup CronCreate CronList CronDelete"` + the redirect prompt and confirm
  the model (a) **cannot invoke** each tool (a mismatched name silently no-ops the flag) **and** (b) has **no
  residual scheduling path** — asked "can you schedule?", it points to the `qiyan_*` MCP tools and does **not**
  reach for the surviving `/loop` skill or background-task/hook workarounds. **Verify:** two turns, second has
  first-turn context; transcript schema documented; auth confirmed; native scheduling provably neutralized
  (tools uninvokable AND no residual skill/workaround path).
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
- R6: auth/config on the worker host — Phase 0 found it is the host's **OAuth login** (not an API key; A1
  corrected) with `~/.claude` inheritance confirmed. Residual: OAuth token **refresh/expiry** over a
  long-running bot — confirm in Phase 1.
- R7: **re-hydration cost** for infrequent scheduled fires (turns spaced beyond the ~5-min prompt-cache TTL
  pay full `cache_creation`). With warm mode removed, the only mitigations are prompt-cache reuse for
  closely-spaced turns, the extended 1-hour cache TTL, and **deterministic launch flags** (§5 — a changed
  system prompt re-creates ~12.5k tokens/turn). Accepted, bounded cost.

## 10. What this unlocks

QiYan manages Codex and Claude Code sessions uniformly — start/adopt/send/goal + durable cron/reminders/
monitors via the same MCP tools — with per-turn fire-and-resume everywhere and no warm processes. Subagents
work inside turns and survive restarts, so multi-agent work composes under a managed session. The cost is
honest: a Codex-protocol adapter, a new transcript scanner, and a new worker-facing MCP scheduling layer —
none of which are free, all of which are bounded.
