# Claude Agent SDK host design

Supersedes the architecture section of
`claude-agent-sdk-redesign-handoff.md`. That handoff was written before the
scope decisions below; where the two disagree, this document wins. The handoff
remains useful as the inventory of what exists today and why.

## Decisions

The Claude endpoint is rebuilt around one persistent host process per endpoint,
wrapping the TypeScript Agent SDK. Beyond that, the governing decision is
**QiYan does not manage Claude's native features.**

1. **A managed Claude session is an ordinary Claude Code session.** No appended
   system prompt, no tool allow/deny list, no injected MCP servers. The only
   launch configuration is the one required to *be* a normal session:

   ```ts
   systemPrompt: { type: "preset", preset: "claude_code" }
   ```

   This field is mandatory, not optional: omitting `systemPrompt` selects the
   SDK's minimal prompt instead of Claude Code's. `settingSources` stays
   omitted so user/project/local settings, `CLAUDE.md`, skills, agents,
   commands, and hooks load exactly as in the CLI.

   The one exception is permission mode, and it is a **pass-through, not a
   policy**. The SDK ignores `permissions.defaultMode` from settings files and
   requires an in-process opt-in for `bypassPermissions`; with nothing passed,
   every tool is denied (measured — see results below). So the host resolves
   the user's own `permissions.defaultMode` across the normal precedence
   (managed policy, then local, project, user settings for the session's cwd)
   and forwards it as `permissionMode`, attaching
   `allowDangerouslySkipPermissions: true` only when the user's own config
   asked for `bypassPermissions`. QiYan chooses nothing: a user who configures
   nothing gets `default` and sees tools denied, and the fix remains their
   Claude config. This preserves Codex parity in intent — the worker's
   permission policy is the user's — past an SDK guard that only accepts the
   value in-process.

2. **Claude owns scheduling, background tasks, subagents, and goals.** The
   worker no longer receives QiYan's `schedule_wakeup` / `schedule_cron` /
   `monitor` tools, and `ClaudeGoalDriver` is retired in favour of native
   `/goal`. `SchedulingService` and `WorkerScheduleMcpServer` remain in the
   codebase for Codex workers, which have no native equivalent.

3. **Native state is not made durable by QiYan.** If a host restart loses a
   native cron or wakeup, it is lost. QiYan adds no shadow store, no
   re-arming, and no reconciliation layer. On restart the existing behaviour is
   retained: a resume prompt is sent to the session ("the worker restarted;
   resume if unfinished, otherwise do nothing"). This is a deliberate trade of
   durability for the removal of an entire compatibility layer.

4. **Every top-level end-of-turn is delivered.** QiYan does not distinguish
   human-initiated from self-initiated turns. Any terminal `SDKResultMessage`
   for a *top-level* turn produces one worker-completion delivery. Subagent and
   other nested results never do, or one turn would fan out into several chat
   messages.

5. **Background status is readable, not manageable.** The host tracks the
   native background-task set already (it gates idle and eviction), so
   `session/status` exposes it and QiYan projects it to the manager: idle vs
   working, and what is still pending that may wake the session. No management
   verbs.

6. **No legacy migration.** Verified against the live database on 2026-07-31:
   `session_schedules` holds no `armed` rows (only `done`/`cancelled`),
   `scheduled_sends` holds no unresolved `sending` claims, and
   `claude_session_goals` is empty. The cutover therefore needs a precondition
   assertion, not a migration. Re-check immediately before switching.

## Architecture

```text
QiYan backend
    |  provider-neutral thread/turn/goal RPC (unchanged)
    v
ClaudeCodeRuntime            (keeps its ManagedAppServerEndpoint surface)
    |  host client
    v
local Unix socket, or SSH-forwarded socket to the same protocol
    |
qiyan-claude-host            (one per endpoint, independently supervised)
    |  one long-lived SDK Query per loaded session
    v
Claude Code + its native JSONL transcript
```

`ClaudeCodeRuntime` keeps its external interface — `thread/start`,
`thread/read`, `thread/resume`, `thread/turns/list`, `turn/start`,
`turn/interrupt`, `turn/steer`, `thread/list`, `thread/archive`,
`thread/unsubscribe`, `model/list`, `thread/goal/*`, and the `turn/started` /
`item/started` / `turn/completed` notifications. What changes is everything
beneath it: `ClaudeCommandRunner` and its two implementations are replaced by a
host client.

### Host process

Supervision reuses the pattern that already works for remote Codex and Claude:
the host runs inside the endpoint's tmux generation under the shared runtime
root, never `/tmp`. Local supervision is the known gap — local turns die with
the QiYan service today, and that stays true until local supervision is added.
With QiYan-side scheduling gone, a local restart now also drops any pending
native wakeup; that is accepted under decision 3.

Protocol: newline-framed JSON over an owner-only Unix socket. Methods are added
only when a caller exists.

- `host/status` — protocol, host build, SDK and Claude versions, generation
- `session/open` — caller-chosen native session id, create-or-resume, cwd
- `session/close` — idle eviction / unadopt
- `session/send` — caller-generated idempotency id, structured input
- `session/interrupt`
- `session/status` — activity, background-task set, pending native schedules
- `session/setModel`, `session/setPermissionMode`
- `session/stopTask`
- `events/subscribe` — host generation + event cursor

The channel is unidirectional in the sense that matters: the host has no
callback into QiYan's durable state, because no QiYan MCP tools are attached to
Claude sessions. That removes the bridge, operation ledger, request-hash
replay, and goal-continuation fence the earlier handoff required.

### Session lifetime

One loaded session owns one long-lived `Query`. Sessions load lazily and are
evicted only while no top-level response and no native background task is
active. A QiYan restart reconnects to the host; it does not terminate the host
or an active turn. A host generation owns a fenced process tree, and a
replacement host may not start until the prior generation's Claude, tool, and
background-agent processes are proven gone.

### History

Claude's JSONL remains the only durable transcript; QiYan keeps no cache and
writes nothing into it. Prefer the SDK's `listSessions` / `getSessionInfo` /
`getSessionMessages` for discovery and lazy paging if the spike shows their
reads are bounded on a large real transcript; otherwise keep
`ClaudeTranscriptHistory`'s snapshot-pinned reader behind the host. Either way,
JSONL polling stops being the live-message transport — live content comes from
SDK events.

## Spike results (2026-07-31, SDK 0.3.220, Claude 2.1.220)

Run with `node --import tsx scripts/claude-sdk-spike.ts core tasks goal history`
against real Claude on this host. 25 of 27 checks passed. What changed in the
design as a result:

**Settled in favour of the design.**

- Auth is inherited from the Claude CLI. `apiKeySource` is `/login managed
  key`, read from `~/.claude.json`; no `ANTHROPIC_API_KEY` and no
  `.credentials.json` are involved. The **bundled** SDK binary works with it —
  `pathToClaudeCodeExecutable` was never set. API-key billing is not forced.
- `systemPrompt: {type:"preset", preset:"claude_code"}` with `settingSources`
  omitted loads 28 tools, 48 commands, 5 agents, and the model from
  `~/.claude/settings.json`.
- `Options.sessionId` produces exactly the caller-chosen UUID, and `resume`
  reopens it without forking (verified by init `session_id` and by restored
  context after disposing the query).
- One `Query` takes many sequential messages; two pushed during an active turn
  execute in order.
- Re-sending an identical `SDKUserMessage.uuid` creates no second turn: JSONL
  rows with that uuid stayed at 1 and the result count did not move. Host
  reconnect can retry safely.
- `interrupt()` ends only the active response; the session is immediately
  reusable. The receipt (`{still_queued: []}`) reports queued messages that
  would otherwise still run.
- Subagents are unambiguous: nested messages carry `parent_tool_use_id` and
  `subagent_type`, and one human turn with a subagent produced exactly **one**
  `result`. A subagent cannot cause a duplicate delivery.
- A background task started with `run_in_background` **completed after its
  parent turn** while the query stayed open, and its completion arrived as a
  separate result with `origin.kind === "task-notification"`. This is what the
  headless background-agent prohibition was working around; it can go.
- `supportedModels()` returns `value`, `displayName`, `supportsEffort`, and
  `supportedEffortLevels`, so it replaces `claude-models.ts` including effort
  validation. `applyFlagSettings({effortLevel})` is the effort setter.
- Native `/goal` exists and drove a task to completion unattended.

**Changed the design.**

1. `permissionMode` is **not** inherited from `settings.json`. With nothing
   passed and `permissions.defaultMode: bypassPermissions` set in
   `~/.claude/settings.json`, init reported `default` and *every* tool was
   denied: foreground Bash, `Write`, and background Bash all blocked across
   four permission denials. A worker launched on user settings alone cannot
   execute a single tool. Hence the pass-through in decision 1.
2. SDK session helpers do **not** replace the JSONL reader.
   `getSessionMessages` returned 242 messages for a transcript holding 13,322
   user+assistant records, and `limit: 100000` still returned 242 — it walks
   the current context branch, not the full transcript. Adopt `listSessions`
   (79 sessions in 112 ms) and `getSessionInfo` (18 ms, carries summary,
   firstPrompt, fileSize) to replace the manual directory scan in
   `LocalClaudeCommandRunner.listThreads`; **keep** `ClaudeTranscriptHistory`
   for lazy history paging.
3. An interrupted turn emits `error_during_execution` with `user_message_uuid`
   **absent**. Turn settlement is therefore "the result matching the accepted
   uuid, **or** an uncorrelated non-success result while exactly one turn is in
   flight" — uuid correlation alone is not sufficient.
4. `session_state_changed` never fired (0 events across every phase), so it is
   not available as an idle signal. Idle must be derived from outstanding turn
   results plus the tracked background-task set.

**Goals — works, but is opaque in flight.**

A `/goal` spanning several continuations completed unattended (3 of 3 files
created, one per turn as instructed). Its native transcript shows the mechanism:
a session-scoped Stop hook plus two `Stop hook feedback` user rows, driving 8
assistant messages.

Critically, that entire goal produced **exactly one** top-level `result` in the
SDK stream. Continuations are internal and emit no result of their own, so
decision 4 yields one delivery per goal, not one per continuation.

What is *not* available:

- `active_goal` events never reach the query iterator. `SDKActiveGoalMessage`
  (carrying `condition`, `iterations`, `set_at`, `tokens_at_start`) is declared
  on `StdoutMessage` but not on the `SDKMessage` union, and none were observed.
- `includeHookEvents: true` did not help. Two hook events arrived
  (`hook_started`, `hook_response`), neither Stop-related.
- Consequently there is no in-flight goal status to project to the manager and
  no per-continuation point at which QiYan could enforce a token or turn bound.
  `Options.maxTurns` and `Options.maxBudgetUsd` exist, but they bound the whole
  session rather than one goal.

So a Claude worker can hold a native goal and finish it, but QiYan can only
show "working" until it lands.

**Decided: native `/goal`, accepting that opacity.** `ClaudeGoalDriver` is
retired. `ClaudeGoalStore` keeps the manager-visible objective and a reduced
projection — objective plus working/idle/complete — and drops the live
`paused` / `blocked` / `usageLimited` / `budgetLimited` states and the
`tokenBudget` contract, none of which are observable in flight.
`Options.maxTurns` and `Options.maxBudgetUsd` remain available as a
session-level backstop against a goal that never terminates.

## What the spike must settle

Resolved items are struck through by the results above; the remainder stand.
The earlier handoff's MCP-bridge and legacy-migration items are gone.

1. Authentication in the real service environment, and whether the SDK-bundled
   Claude binary works with it (production prefers the bundled binary; a
   configured `pathToClaudeCodeExecutable` is an override behind a
   version/capability gate).
2. `claude_code` preset with no append, `settingSources` omitted, loads the
   same settings/`CLAUDE.md`/skills/agents/commands/hooks as the CLI.
3. `Options.sessionId` produces exactly the caller-chosen UUID that
   `thread/start` reserves, and `resume` accepts CLI-created session ids
   without forking them.
4. One streaming `Query` takes three or more sequential messages without
   respawning, preserving context.
5. A message sent during an active turn is queued once and ordered correctly.
6. `interrupt()` ends only the active response; the session stays usable.
7. `SDKUserMessage.uuid` survives into live events and JSONL, so a retry after
   an ambiguous send does not create a second user turn.
8. Events carry reliable top-level vs subagent identity and per-turn result
   boundaries — decision 4 depends entirely on this.
9. Background tasks: can one complete after its parent response while the query
   stays open, what does `stopTask()` do, and does a task notification avoid
   producing a duplicate user bubble or a second completion delivery?
10. Native `/goal`: set, clear, pause/resume, automatic completion, resume
    after the query is disposed and recreated, and enforcement of a turn/token
    bound before the next internal continuation. Preflight trusted-workspace
    and hooks availability; unsupported goal operations must fail closed with
    `UNSUPPORTED_CAPABILITY` without disturbing ordinary turns.
11. `supportedModels()` can replace the static catalog in `claude-models.ts`
    without losing effort validation.
12. Session-history helpers on a large real transcript: bounded and fast enough
    to replace the manual JSONL parser.

Item 10 is the only remaining fork. If native `/goal` cannot hold the turn/token
bound, goals are not offered on Claude workers rather than reviving a second
driver — decision 2 does not get partially reversed.

## Sequence

1. SDK spike (disposable, real Claude, local).
2. Host + client prototype: client disconnect does not stop the host; SSH
   transport survives ControlMaster loss; killing the host leaves no
   descendant alive.
3. Production: host client behind `ClaudeCodeRuntime`, SDK-event-driven live
   flow, local then remote.
4. Delete in the same migration: `claudeLaunchPolicy` and its prompt/tool
   constants, `LocalClaudeCommandRunner.startTurn`, per-turn tmux dispatch and
   materialization scans, `assets/remote/qiyan-claude.mjs`, `ClaudeGoalDriver`,
   Claude's worker-MCP attachment, and the static model catalog.

No long-lived dual engine. A short canary flag is acceptable; two lifecycle
models are not.

## Accepted losses

Stated plainly so they are not rediscovered as bugs:

- A native cron or wakeup does not survive host replacement or a local QiYan
  restart.
- The manager cannot cancel a worker's schedule from QiYan; it can only see
  that something is pending and ask the worker.
- A goal in flight shows only as "working". The paused, blocked, usage-limited,
  and budget-limited statuses and the per-goal token budget are gone, because
  native `/goal` exposes no in-flight state to the SDK stream.
- A worker whose Claude config sets no permission mode will have every tool
  denied. QiYan reports it but does not fix it.
- Claude workers gain Claude's own scheduling semantics, which differ from
  Codex workers' QiYan-backed ones. The two providers are no longer symmetric
  here.
