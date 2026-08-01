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
   codebase for Codex workers, which have no native equivalent; the manager's
   own scheduling, steer queue and runtime-recovery wakeups still run through
   `SchedulingService` for both providers.

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
   native background-task set already — it gates idle and eviction, so a
   session with a live task is never unloaded and its result is never lost —
   and `session/status` exposes it. As built, nothing projects that set to the
   manager: `get_session_status` reports QiYan's own idle/active view, so a
   background task running past its parent turn reads as idle until it settles
   and its output is delivered. No management verbs either.

6. **No legacy migration.** Verified against the live database on 2026-07-31:
   `session_schedules` holds no `armed` rows (only `done`/`cancelled`),
   `scheduled_sends` holds no unresolved `sending` claims, and
   `claude_session_goals` is empty. The cutover therefore needs a precondition
   assertion, not a migration. Re-check immediately before switching.

## Deployment prerequisites

**Both the Claude Agent SDK and the Claude CLI must be installed on every machine
that runs a Claude worker host** — the QiYan host for local endpoints, and each
remote worker host for SSH endpoints. Neither is bundled.

The reason is measurable rather than stylistic. The SDK does not use the CLI on
`PATH`; it spawns a platform-specific native binary shipped as an optional
dependency of its own package. Traced during the spike:

```
execve(".../node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude")
```

That package is ~264 MB per platform. No bundler can inline it into
`dist/qiyan-bot`, so bundling the SDK's JavaScript alone would produce a binary
that fails at first use. `@anthropic-ai/claude-agent-sdk` is therefore marked
`external` in `scripts/build.mjs` and imported from the host's own installation,
which also preserves the repo's zero-runtime-dependency packaging contract.

The CLI is required separately because the host passes
`pathToClaudeCodeExecutable` pointing at it, rather than using the SDK's vendored
copy — one Claude per machine instead of two, and the same binary the operator
already manages. QiYan already required the CLI on every worker host, so this
adds no new install step there; the SDK is the new one.

`src/claude-host/requirements.ts` gates both at startup and fails closed:

- A missing SDK reports a deployment prerequisite with the install command, not
  an unresolvable-module crash.
- A missing or unreadable CLI names the executable that failed.
- A CLI older than `MIN_CLAUDE_CLI_VERSION` (2.1.220, the version the spike
  proved against) is refused. The SDK's JS and the CLI are released together and
  the SDK's manifest pins an exact CLI build, so an older CLI can lack
  control-protocol capabilities the host depends on.

## Manager tool coverage

Every manager tool that operates on a worker needs a working path under this design.
Audited against `ASSISTANT_TOOL_SCHEMAS` in `src/assistant/tools.ts`:

| Manager tool | Claude path |
| --- | --- |
| `create_session` | `thread/start` → `session/open` (create) with the caller-chosen UUID |
| `adopt_session` | `thread/resume` → `session/open` (resume); proven not to fork |
| `unadopt_session` | `thread/unsubscribe` → `session/close` |
| `archive_session` | tombstone in `ClaudeArchiveStore` + `session/close` |
| `discover_sessions` | `thread/list` → `ClaudeCommandRunner.listThreads` (bounded transcript scan; SDK `listSessions` not adopted) |
| `send_to_session` | `turn/start` → `session/send` with an idempotency uuid |
| `interrupt_session` | `turn/interrupt` → `session/interrupt` |
| `get_session_status` | QiYan's own idle/active view. The host's `session/status` also carries the background-task set, but **no caller projects it yet**, so a task outliving its parent turn reads as idle |
| `inspect_worker_conversation` | `thread/turns/list` → `ClaudeTranscriptHistory` (SDK helpers are branch-limited) |
| `read_worker_message` | same bounded JSONL reader |
| `collect_messages` | same bounded JSONL reader |
| `list_models` | `model/list` → the curated `claude-models.ts` catalog; the host exposes `supportedModels()` but nothing has switched to it yet |
| `set_session_model` | `session/setModel` |
| `set_reasoning_effort` | `applyFlagSettings({ effortLevel })` |
| `compact_session` | delivers Claude's native `/compact` |
| `set_goal` | delivers `/goal <objective>` |
| `cancel_goal` | delivers `/goal clear` |
| `get_goal` | reports no goal — native goal state is not exposed to the SDK stream |
| `pause_goal`, `resume_goal` | **unsupported**: native `/goal` has no pause, and QiYan keeps no objective to reinstate |
| `rename_session` | **still a gap**: a silent no-op. SDK `renameSession()` is the equivalent and must run on the worker's host; the host exists now, the method has no caller yet |
| `update_session_notes`, `list_managed_sessions` | QiYan-side, provider-neutral |
| `restart_endpoint`, `disconnect_endpoint` | endpoint manager, unchanged |
| chat/attachment/Slack tools | provider-neutral, unchanged |

Two gaps are deliberate rather than accidental: `pause_goal`/`resume_goal` have no
native equivalent, and `rename_session` waits for the host because it must write on
the worker's filesystem.

## Architecture (as built)

```text
QiYan backend
    |  provider-neutral thread/turn/goal RPC (unchanged)
    v
ClaudeCodeRuntime            (keeps its ManagedAppServerEndpoint surface)
    |  ClaudeHost interface            + ClaudeCommandRunner (transcript reads only)
    v                                    |
LocalClaudeHost (in QiYan's process)     |  local fs, or `find`/`node -e` over ssh
  or RemoteClaudeHost over an            v
  SSH-proxied Unix socket           Claude's native JSONL transcript
    |
qiyan-claude-host            (one per remote endpoint, tmux-supervised)
    |  one long-lived SDK Query per loaded session
    v
Claude Code + its native JSONL transcript
```

`ClaudeCodeRuntime` keeps its external interface — `thread/start`,
`thread/read`, `thread/resume`, `thread/turns/list`, `turn/start`,
`turn/interrupt`, `turn/steer`, `thread/list`, `thread/archive`,
`thread/unsubscribe`, `model/list`, `thread/goal/*`, and the `turn/started` /
`item/started` / `turn/completed` notifications. What changed is everything
beneath it: the one-shot `claude -p` engine is gone and turns run on a
`ClaudeHost`.

`ClaudeCommandRunner` survives, narrowed to what the host cannot serve: bounded
snapshot-pinned transcript paging and session discovery (see History below). It
no longer starts turns, and `SshClaudeCommandRunner` is no longer a persistent
runtime — `SshClaudeHostRuntime` is.

### Host process

A **local** endpoint runs `LocalClaudeHost` in QiYan's own process. Local turns
therefore still die with the QiYan service; that is the known gap, unchanged by
this migration, and with QiYan-side scheduling gone a local restart now also
drops any pending native wakeup (accepted under decision 3).

A **remote** endpoint runs `qiyan-claude-host` on the worker's machine,
supervised exactly like the Codex app-server: inside the endpoint's tmux
generation under the shared runtime root, never `/tmp`, identified by the
runtime token it carries in its own `/proc` environ, holding an owner-only Unix
socket that the ssh helper proxies raw bytes to. A QiYan restart re-dials that
socket and the turn it left running is still there.

Protocol: newline-framed JSON over that socket, one request per `ClaudeHost`
method so the wire cannot drift from the interface. Methods exist only where a
caller does (`src/claude-host/protocol.ts`):

- `host/status` — protocol, host build, SDK and Claude versions, generation
- `open` — caller-chosen native session id, create-or-resume, cwd, model, effort
- `close` — idle eviction / unadopt
- `send` — caller-generated idempotency id (which is the QiYan turn id), message
- `interrupt`, `status`, `setModel`, `setEffort`, `models`, `stopTask`
- `evictIdle`, `shutdown`

Events are live fan-out only, in one direction; the host buffers nothing and a
client that missed events reloads the transcript tail instead. There is no
callback into QiYan's durable state, because no QiYan MCP tools are attached to
Claude sessions. That removes the bridge, operation ledger, request-hash
replay, and goal-continuation fence the earlier handoff required.

Permission mode is a pass-through of the user's own settings, so a session whose
resolved mode is `default` would have every tool denied; the host warns rather
than choosing a mode, and QiYan surfaces that as a `claude_permission_mode`
operational event.

### Session lifetime

One loaded session owns one long-lived `Query`. Sessions load lazily and are
evicted only while no top-level response and no native background task is
active. A QiYan restart reconnects to a remote host; it does not terminate the
host or an active turn. A host generation owns a fenced process tree, and a
replacement host may not start until the prior generation's Claude, tool, and
background-agent processes are proven gone — so `SshClaudeHostRuntime` pins the
identity it started and refuses to dial a replacement, reporting the generation
lost instead, because that replacement never heard of the loaded sessions.

### Turn identity

A QiYan turn id **is** the caller's `clientUserMessageId`. The SDK preserves it
as the transcript user row's `uuid`, so the live stream and the reconstructed
history agree on turn identity without QiYan writing a correlation marker into
the transcript. A live assistant item id is `${sdkAssistantUuid}:${index}` over
the filtered text blocks, matching reconstruction exactly. This is what makes
duplicate Web UI bubbles after a reload structurally impossible, and it is why
recovery correlates a send by turn id rather than by counting appended turns.

### History

Claude's JSONL remains the only durable transcript; QiYan keeps no cache and
writes nothing into it. The SDK's session helpers did **not** replace the
reader: `getSessionMessages` walks the current context branch only (242 of
13,322 records on a compacted transcript — see the spike results), so
`ClaudeTranscriptHistory` over `ClaudeCommandRunner` stays the complete-history
source, and discovery stays a bounded, body-free transcript scan rather than
`listSessions`. JSONL polling did stop being the live-message transport: live
content comes from SDK events.

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

**Decided: native `/goal`, accepting that opacity.** `ClaudeGoalDriver` and
`ClaudeGoalStore` are both retired: QiYan stores no objective at all.
`set_goal` and `cancel_goal` deliver `/goal <objective>` and `/goal clear`
through the steer queue, and `thread/goal/get` reports no goal, because native
goal state is not exposed to the SDK stream. The live `paused` / `blocked` /
`usageLimited` / `budgetLimited` states and the `tokenBudget` contract go with
it — none are observable in flight, and without stored state there is nothing
to reinstate, so pause/resume fail closed. `Options.maxTurns` and
`Options.maxBudgetUsd` remain available as a session-level backstop against a
goal that never terminates.

## What the spike settled

Every question the spike was written to answer is answered above, in "Spike
results" and the decisions that follow: authentication and the preferred
binary, the `claude_code` preset, caller-chosen session ids and non-forking
resume, one `Query` across many sequential messages, queued mid-turn sends,
`interrupt()` semantics, uuid survival into the JSONL, top-level vs subagent
identity, background tasks outliving their parent turn, native `/goal`, and
`supportedModels()` plus the session-history helpers. The earlier handoff's
MCP-bridge and legacy-migration questions are gone with the surfaces they asked
about.

The one fork resolved against enforcement: native `/goal` offers no
per-continuation point at which QiYan could hold a turn or token bound, so a
goal in flight shows only as "working" (see "Accepted losses"). Goals are still
offered — the spike watched native `/goal` drive a task to completion
unattended — but pause and resume are not.

Answered by the spike, not yet taken up by the code:

- `list_models` still returns the static `claude-models.ts` catalog rather than
  the host's `supportedModels()`.
- `rename_session` is still a silent no-op; SDK `renameSession()` is the
  equivalent and must run on the worker's host.
- `LocalClaudeCommandRunner.listThreads` still scans the transcript directory
  by hand rather than using `listSessions`/`getSessionInfo`. History paging
  stays on `ClaudeTranscriptHistory` deliberately: `getSessionMessages` walks
  the current context branch, not the full transcript.

## Sequence (done)

1. SDK spike (disposable, real Claude, local).
2. Host + client prototype: client disconnect does not stop the host; SSH
   transport survives ControlMaster loss; killing the host leaves no
   descendant alive.
3. Production: host client behind `ClaudeCodeRuntime`, SDK-event-driven live
   flow, local then remote.
4. Delete in the same migration. Deleted: `claudeLaunchPolicy` and its
   prompt/tool constants; `LocalClaudeCommandRunner.startTurn`,
   `buildClaudeArgs`, `ClaudeLaunchFlags` and the transcript-materialization
   scan; `SshClaudeCommandRunner`'s per-turn tmux pane dispatch, turn observers
   and turn inspection, with the eight helper ops behind them;
   `assets/remote/qiyan-claude.mjs` and
   `assets/remote/qiyan-claude-runtime-launcher.sh`; `ClaudeGoalDriver`; and
   Claude's worker-MCP attachment.

Two things on that list were **kept**, deliberately:

- The worker-MCP surface itself (`WorkerScheduleMcpServer`, `RemoteWorkerTunnel`,
  `SchedulingService`'s MCP config plumbing). No provider is wired to it today,
  but Codex workers have no native scheduling and it is the obvious home for
  theirs. It carries `TODO(worker-mcp)` notes saying so, so "no callers" is not
  read as "dead".
- The static model catalog in `claude-models.ts`, which still backs `model/list`.

No long-lived dual engine. A short canary flag is acceptable; two lifecycle
models are not — which is why the one-shot engine was deleted rather than left
installed and unreferenced.

## Accepted losses

Stated plainly so they are not rediscovered as bugs:

- A native cron or wakeup does not survive host replacement or a local QiYan
  restart.
- The manager cannot cancel a worker's schedule from QiYan, and cannot see it
  either: no tool projects the host's background-task set, so a pending wakeup
  is invisible until it fires. Asking the worker is the only route.
- A goal in flight shows only as "working". The paused, blocked, usage-limited,
  and budget-limited statuses and the per-goal token budget are gone, because
  native `/goal` exposes no in-flight state to the SDK stream.
- A worker whose Claude config sets no permission mode will have every tool
  denied. QiYan reports it but does not fix it.
- Claude workers gain Claude's own scheduling semantics, which differ from
  Codex workers' QiYan-backed ones. The two providers are no longer symmetric
  here.
