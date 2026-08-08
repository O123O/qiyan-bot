# Claude Agent SDK session redesign handoff

## Status

**Historical.** Planning handoff captured on 2026-07-31, before any Agent SDK
production code existed. The migration it proposed has landed; where this
document and `claude-agent-sdk-host-design.md` disagree, that one wins, and its
"Architecture (as built)" section describes the shipped shape. Everything here
describing the one-shot `claude -p` engine is now an account of code that has
been deleted, kept because it is the clearest statement of why.

The implementation snapshot behind this document is commit `2cffd52`. All four
of the changes it once listed as unintegrated are now in `main`, so the warning
that stood here is spent: `4f4c536` (pending Claude messages stay visible in the
Web UI), `c1174ae` (native subagent notifications hidden from the user-message
stream), `7cef7f4` (condition monitors complete after their first fire), and
`2cffd52` (one-shot headless turns launch no background agents). The last of
those was a workaround for the one-process-per-turn engine that this document
argued against; the SDK host replaced that engine, and background tasks now have
their own lifetime and delivery semantics, so the workaround no longer guards
anything.

Since the migration landed, production has corrected two claims made here and in
the design doc. Both are recorded where they belong rather than here — see
"Turn identity" in `claude-agent-sdk-host-design.md` for the first — but they
share a shape worth naming for anyone reading this as history:

- **A turn id is not always a transcript row.** This document assumed every
  accepted send becomes a turn. A send that arrives mid-turn does not: Claude
  folds it into the turn already running, which answers both prompts under its
  own id, and the folded send never runs as a turn of its own. Settling by id
  alone therefore left it in flight forever, and the session reported "working"
  while idle until a restart.
- **Reconciliation is only as good as the source it trusts.** The correction
  built for stale turns asked the host which turns were still running and
  settled anything it no longer held. The host was itself the stale source, so
  the sweep confirmed the ghost every 60 seconds instead of clearing it. A
  bounded read that cannot say "I do not know" will eventually launder its own
  limits into a fact.

## Executive decision

Do not reproduce Claude Code's tool loop, built-in tools, context management,
subagent implementation, skills, hooks, or permission machinery in QiYan.
Anthropic describes the Agent SDK as Claude Code's agent loop exposed as a
library, specifically for applications that do not want to implement the tool
loop themselves.

The SDK is not a network daemon equivalent to Codex App Server. It supervises a
Claude subprocess and keeps session state on the worker host. QiYan therefore
needs a thin, persistent `qiyan-claude-host` around the TypeScript Agent SDK.
That host is the Claude-side analogue of Codex App Server:

```text
QiYan backend
    |
    | provider-neutral session requests and events
    v
Claude endpoint client
    |
    | local Unix socket, or SSH forwarding to the same socket protocol
    v
qiyan-claude-host (one independently supervised host per endpoint)
    |
    | one long-lived SDK Query / Claude subprocess per loaded session
    v
Claude Code + its native JSONL transcript
```

The relevant upstream statements are:

- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview):
  the SDK provides the same tools, agent loop, and context management as Claude
  Code.
- [Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode):
  streaming input is the recommended persistent mode and supports queued
  messages, interruption, live feedback, tools, and multi-turn context.
- [Hosting the Agent SDK](https://code.claude.com/docs/en/agent-sdk/hosting):
  a session maps to a subprocess, and a long-running host maps active sessions
  to long-lived queries.
- [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript):
  `Query` exposes `streamInput`, `interrupt`, `setModel`,
  `setPermissionMode`, MCP controls, task controls, and initialization
  metadata. It also exposes session discovery/history helpers and a
  caller-supplied `sessionId` option.
- [SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions):
  sessions remain native JSONL conversations and can be resumed by ID.
- [Claude Code features in the SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features):
  the SDK can load the same `CLAUDE.md`, settings, skills, agents, commands,
  and hooks as the CLI.
- [Modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts):
  the SDK default is a minimal prompt, not the Claude Code CLI prompt; CLI
  parity requires the explicit `claude_code` preset.
- [Native Claude goals](https://code.claude.com/docs/en/goal):
  `/goal` owns the multi-turn evaluator loop and restores active goals when a
  session resumes.

## Current implementation

### Shared endpoint facade

`src/endpoints/claude-runtime.ts` implements `ClaudeCodeRuntime`, a
`ManagedAppServerEndpoint`-shaped adapter. It translates the provider-neutral
thread, turn, model, goal, archive, and interrupt operations into Claude
operations so the rest of QiYan can treat Codex and Claude similarly.

This facade is worth preserving, but its execution backend should become a
client of `qiyan-claude-host`, not a controller for one-shot CLI processes.
Today `thread/start` pre-reserves a caller-chosen UUID and passes it to
`claude --session-id`. The current TypeScript SDK has an `Options.sessionId`
field, so the host should preserve this transaction shape rather than
introducing a second synthetic identity; the spike must verify it against the
configured Claude executable.

### Local Claude

`LocalClaudeCommandRunner` in
`src/endpoints/claude-command-runner.ts` starts:

```text
claude -p --output-format stream-json --verbose ...
```

for every user turn. The prompt is written to stdin. The process is a child of
the QiYan service, so a service restart interrupts an active local Claude turn.
The `stream-json` output is drained primarily to detect the final result; live
conversation content is reconstructed later from Claude's JSONL.

### Remote Claude

`SshClaudeCommandRunner` and the assets under `assets/remote/` implement a
persistent remote tmux runtime:

- One endpoint-level tmux runtime survives SSH and QiYan reconnects.
- Each loaded Claude session has a persistent pane.
- Every turn still launches a new one-shot `claude -p` process inside that
  pane.
- The helper records exact process identity, waits for native transcript
  materialization, watches settlement, and supports fenced interrupt/release.

The detailed current design is in
`docs/development/remote-claude-tmux-runtime-design.md`. It has solved remote
process survival, but a large amount of machinery exists only because a
one-shot CLI is being made to behave like a session server.

### History and live events

Claude's native transcript under `~/.claude/projects/` is the durable source of
conversation history. `ClaudeTranscriptHistory` in
`src/endpoints/claude-history.ts` reads bounded, snapshot-pinned JSONL chunks
and exposes paginated turns/items. QiYan does not maintain a second durable
Claude transcript, which is the correct invariant.

During an active turn, however, QiYan does not use the CLI's message stream as
the authoritative live event stream. It repeatedly has to reconcile process
state and newly written JSONL. That indirect path has contributed to delayed,
missing, duplicated, and incorrectly ordered Web UI messages.

### QiYan-owned behavior

The following behavior is currently implemented by QiYan:

- `ClaudeGoalStore` and `ClaudeGoalDriver` maintain and drive QiYan's durable
  worker goals.
- `WorkerScheduleMcpServer` provides durable wakeups, cron schedules,
  condition monitors, and Claude's `set_goal_status`.
- The managed-session registry maps QiYan nicknames to provider session IDs.
- The endpoint manager owns SSH connection recovery and endpoint availability.
- Chat relays decide which completed worker turns notify QiYan and chat apps.

The scheduling persistence and public goal-control contract remain after the
SDK migration. Prefer retiring `ClaudeGoalDriver` and mapping that contract
onto Claude's native `/goal` loop, but only if the SDK spike proves that native
goals can preserve QiYan's complete status and budget contract. The persistent
host migration does not depend on that goal-engine decision.

## Why the redesign is needed

The one-shot CLI boundary creates limitations that more tmux, transcript
scanning, and recovery state cannot cleanly remove:

1. Local turns die with the QiYan service.
2. A new process is created and resumed for every message instead of retaining
   a natural interactive session.
3. Mid-session message queueing, interruption, permission requests, and model
   changes have to be approximated around CLI flags and process signals.
4. Background Claude agents are unsafe because the one-shot parent may exit
   before they finish. The current system prompt disables them as a workaround.
5. Live UI updates are inferred from transcript writes instead of coming
   directly from the running agent.
6. Remote dispatch needs tmux buffers, materialization scans, process markers,
   wait channels, and recovery rules merely to prove that one prompt reached
   one CLI process.

The redesign should remove this accidental complexity, not add an SDK path
beside it indefinitely.

## Responsibility boundary

| Capability | Owner after redesign |
| --- | --- |
| Agent/tool execution loop | Agent SDK |
| Bash, file, web, and other built-in tools | Agent SDK / Claude Code |
| Foreground and background subagents | Agent SDK / Claude Code |
| Claude context, compaction, native session history | Agent SDK / Claude Code |
| `CLAUDE.md`, settings, skills, agents, commands, hooks | Agent SDK / Claude Code |
| Claude permission requests and permission mode | Agent SDK, surfaced by the host |
| Interrupt, model changes, MCP status, task control | Agent SDK `Query` APIs |
| Goal auto-drive and completion evaluation | Exactly one driver: native Claude `/goal` if it passes the spike, otherwise the existing QiYan driver over SDK input |
| Manager-visible goal objective, pause/blocked state, and controls | QiYan projection over the selected sole goal driver |
| Durable QiYan schedules and monitors | QiYan MCP server |
| Nickname/session registry and archive tombstones | QiYan |
| Local/SSH transport, reconnect, and host supervision | QiYan |
| Provider-neutral events and Web UI projection | QiYan |
| Durable conversation transcript | Claude native JSONL only |

The existing QiYan scheduling and goal-status tools remain MCP tools, but their
implementation stays in QiYan. The host exposes them to the SDK through an
in-process MCP bridge and forwards typed calls over the authenticated endpoint
channel. This avoids binding a long-lived query to the backend's current
in-memory bearer token and dynamically allocated reverse-tunnel port. Every
bridge call carries a stable operation ID derived from the session and SDK tool
use identity. The backend durably records the request hash and terminal result,
rejects reuse with different arguments, and replays the same result after a
lost response. Existing schedule/goal handlers remain the only place durable
effects are applied. For `set_goal_status=complete|blocked`, the host also
withholds the MCP tool result and fences native goal continuation from the
moment the call begins. It reconciles the durable backend result, clears and
verifies the native goal, and only then returns the tool result to Claude.

Use only one goal driver. If native goals pass the spike, QiYan's goal API sets,
clears, pauses, and resumes native `/goal`; `ClaudeGoalStore` retains the
manager-visible objective and full status/budget projection, while
`ClaudeGoalDriver` is retired. Exact `/goal` input from the Web UI/chat control
surface routes through this manager API rather than starting a second
independent goal. A worker `set_goal_status` call completes or blocks the
projected goal and clears the native goal under that continuation fence. If the
host dies during the transition, replacement must use a proven SDK/native
pre-resume control path to read the durable projected status and clear any
remaining native goal before it can auto-continue. If no supported
pre-auto-resume clearance exists, native goals fail the spike. In that case,
retain `ClaudeGoalDriver` as the sole driver and submit its follow-ups through
the persistent SDK query; never run it alongside native `/goal`.

Native `/goal` is available only in a trusted workspace with hooks enabled.
The host must preflight this capability. When it is unavailable, goal
operations fail closed with an actionable `UNSUPPORTED_CAPABILITY`; QiYan must
not silently start its old auto-driver. Ordinary non-goal turns remain usable.

QiYan still enforces the existing finite goal contract without becoming a
second driver. It projects `active`, `paused`, `blocked`, `usageLimited`,
`budgetLimited`, and `complete`, and retains `tokenBudget`. Counting only
terminal `SDKResultMessage` events is insufficient because native `/goal` may
continue internally before emitting a result. The spike must identify a
documented per-response usage signal and a pre-continuation stop/clear boundary.
The host must update turn/token usage from that signal and atomically prevent
the next continuation when either bound is reached, then project
`budgetLimited`. Include an explicit turn bound in the native goal condition as
a backend-independent backstop. If the SDK cannot enforce both limits before
the next continuation, native `/goal` does not meet QiYan's contract and cannot
replace `ClaudeGoalDriver`.

### Legacy goal cutover

Do not switch an existing active goal by merely enabling native `/goal`.
`ClaudeGoalDriver` may already have armed `session_schedules` rows with
`kind="wakeup"` and `spec="goal"`, plus corresponding `scheduled_sends`
claims. Those are real pending effects.

Use an idle-only, per-session durable migration:

1. Mark the session's goal engine as `draining_legacy`. This fences both new
   legacy goal-drive rows and native-goal installation.
2. Wait for the session to become idle and for every already-claimed legacy
   goal send to become authoritatively sent or proven not dispatched. An
   unresolved `sending` claim blocks migration; it is never guessed away or
   replayed under a new identity.
3. In one transaction, cancel remaining armed legacy goal schedules, snapshot
   the goal status/budget/counters, and record a stable pending native-goal
   migration ID.
4. Install an `active` goal once using that migration ID, then commit the native
   driver mode only after authoritative native acknowledgement. Paused,
   blocked, limited, and complete goals remain projected without starting
   native auto-drive.
5. An ambiguous native install is reconciled from native goal state before any
   retry. A proven failed install may transactionally restore legacy mode and
   arm at most one fresh legacy drive.

The migration is complete only when no legacy goal schedule/claim can still
fire and exactly one goal driver is enabled.

## Target invariants

1. One independently supervised `qiyan-claude-host` runs per configured Claude
   endpoint.
2. One loaded Claude session owns one long-lived SDK `Query` and its Claude
   subprocess. Sessions are loaded lazily and may be evicted only while no
   foreground response or native background task is active.
3. A QiYan service restart disconnects and reconnects to the host. It does not
   terminate the host or an active Claude turn.
4. Remote hosts use the existing shared runtime root, never `/tmp`, because
   MFA cluster SSH channels may not share `/tmp`.
5. User messages enter the running query through the documented streaming
   input API. A message is acknowledged only after the host accepts it into
   that session's queue.
6. Active status and live message flow come from SDK events. SQLite lifecycle
   rows and old turn IDs are not live sources of truth.
7. Claude JSONL remains the only durable conversation history. The Web UI
   loads older history lazily through the existing bounded history interface.
   Prefer the SDK's `listSessions`, `getSessionInfo`, and
   `getSessionMessages` helpers if the spike proves their reads are bounded and
   performant; otherwise keep the current snapshot-pinned reader behind the
   host. Do not create a QiYan transcript cache.
8. QiYan never inserts correlation comments, synthetic user rows, or other
   content into Claude's transcript.
9. Host reconnect must not replay an accepted user message. Map QiYan's
   caller-generated UUID to `SDKUserMessage.uuid` and reconcile that native
   identity after an ambiguous transport failure. A bounded in-memory ledger
   may accelerate same-process retries, but it must not become a second
   transcript.
10. Existing Claude session IDs remain discoverable in QiYan and resumable by
    explicit ID from the correct project directory in the ordinary Claude CLI.
    Agent SDK and `-p` sessions are not promised to appear in the CLI picker.
11. Launch configuration explicitly uses:

    ```ts
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: CLAUDE_REDIRECT_PROMPT,
    }
    ```

    Omitting `systemPrompt` would silently replace Claude Code behavior with
    the SDK's minimal prompt.
12. Settings loading preserves normal Claude behavior. Unless a test proves a
    reason to isolate it, do not set `settingSources: []`; omitting it loads
    normal user/project/local configuration.
13. QiYan scheduling/goal MCP calls use a stable host-owned in-process bridge,
    not a backend-generation bearer URL. The bridge reconnects to the QiYan
    backend and never executes durable tool effects itself. Every call has a
    stable operation ID and request hash; the backend durably deduplicates the
    effect and replays its terminal result after reconnect. A goal-terminal
    status call additionally fences native continuation until both its durable
    result and native-goal clearance are authoritative.
14. Each host generation owns a fenced process tree. A replacement host cannot
    start until the supervisor has terminated and verified the absence of the
    prior host, Claude subprocesses, tool subprocesses, and background agents.
    Use a cgroup/systemd scope where available or retain equivalent exact
    process-generation attestation.
15. The host handshake includes a protocol version, QiYan host build identity,
    Agent SDK version, Claude version, runtime generation, and advertised
    capabilities. A backend accepts only its documented compatibility window.
16. Host upgrades are drain-and-replace operations. A new backend may use an
    older host only when the protocol is declared compatible, marks that host
    upgrade-pending, and replaces it after all foreground turns/background
    tasks are idle. An incompatible active host is left running and the
    endpoint fails closed with an actionable upgrade-required state; it is
    never killed merely to complete deployment.
17. Production prefers the Claude binary bundled with the pinned Agent SDK.
    A configured `pathToClaudeCodeExecutable` is an explicit override and must
    pass a minimum-version and initialization-capability gate before the host
    becomes ready.
18. Provider-specific execution stays behind the Claude endpoint interface.
    Chat adapters and the Web UI must not depend directly on SDK message types.

## Proposed host surface

Keep the protocol deliberately smaller than the Codex App Server protocol. A
newline-delimited JSON-RPC or equivalent framed protocol over an owner-only
Unix socket is sufficient:

- `host/status` with protocol/build/SDK/Claude versions, runtime generation,
  capabilities, and upgrade state
- `session/open` with the caller-chosen native session ID, create/resume mode,
  cwd, launch policy, and MCP configuration
- `session/close` for idle eviction/unadoption
- `session/send` with a caller-generated idempotency ID and structured input
- `session/interrupt`
- `session/status`
- `session/setModel`
- `session/setPermissionMode`
- `session/setMcpServers`
- `session/stopTask` for a native background task
- `events/subscribe` with a host-generation/event cursor

The channel is bidirectional: host-owned in-process QiYan MCP tools issue
typed, session-bound calls back to the backend. On reconnect, the backend
rebinds the host generation and session identities before those tool calls are
accepted. Each call includes its stable operation ID and canonical request
hash. The backend commits the durable effect and replayable terminal result
together, so a disconnect after apply is resolved by replay rather than by
executing the effect again. The host must not persist or independently apply
schedule/goal effects while the backend is absent.

The handshake is the first request on every connection. Keep protocol changes
backward compatible for at least one released backend/host pair. Stage a new
host asset beside the running generation; do not replace it until its sessions
are idle. If a future change cannot retain that compatibility, report the
incompatible active generation for operator action instead of aborting it.

The exact wire schema must be settled by the spike. Do not expose every SDK
method preemptively. Add a method only for a QiYan capability that already has
a caller.

The host should keep only bounded transient event replay so a short backend
reconnect can recover live output. Durable reconstruction remains JSONL. Do
not assume a host process exit also killed its descendants: the supervisor must
fence and clean the complete prior process generation before replacement. Only
then may the next host report the prior foreground turn interrupted and resume
the native session for later input.

## Event mapping

The SDK yields typed events for assistant content, user messages, results,
tool progress, tasks, status, compaction, permissions, and other lifecycle
changes. Add one provider adapter that maps those events into QiYan's existing
provider-neutral worker-event model.

Required rules:

- One accepted, top-level, non-synthetic human `SDKUserMessage` creates one
  visible user message, never an optimistic row plus a second transcript row.
  Preserve the caller-supplied `SDKUserMessage.uuid` as its stable correlation
  identity.
- Replayed messages, tool-result user messages, synthetic messages, peer
  messages, and task notifications do not become top-level user bubbles.
- Top-level assistant text is visible in the worker panel.
- Commentary/partial text is live-only and bounded; it is not duplicated into
  QiYan storage.
- Subagent content is identified by SDK parent/task fields and rendered as
  nested/internal content, not as a top-level user message.
- Background-task follow-up results are identified by SDK
  `origin.kind === "task-notification"`, not by parsing their text.
- Tool payloads are excluded from ordinary conversation inspection unless a
  caller explicitly requests them.
- Only the terminal result matched to the accepted human-origin request
  completes that QiYan turn, triggers its worker-completion delivery, and
  advances goal control. Task-notification and other synthetic results never
  do so.
- A session becomes idle only when no human-origin response is running and its
  tracked native background-task set is empty. Idle eviction uses the same
  rule.
- Permission requests become explicit status/events rather than looking like a
  frozen working session.
- Native session-history APIs or bounded JSONL pagination are used for
  initial/lazy history and recovery, not for polling an active turn.

## First next step: a bounded SDK-only spike

Do not begin by replacing `ClaudeCodeRuntime`. First build a disposable
TypeScript spike around one in-process SDK `Query`. This first phase answers
SDK capability questions only; it does not build supervision, a wire protocol,
SSH transport, or production persistence. It should use the configured system
Claude executable through `pathToClaudeCodeExecutable` initially, so it
exercises the same binary and filesystem configuration as today's worker.

The SDK-only spike must prove:

1. Authentication works in the actual QiYan service environment. Anthropic's
   public SDK guidance tells third-party products to use API-key
   authentication rather than offering Claude.ai login/rate limits. Confirm
   the acceptable authentication model before making the SDK a required
   dependency.
2. The query uses the explicit `claude_code` system-prompt preset with
   `CLAUDE_REDIRECT_PROMPT` appended, while omitting `settingSources` loads the
   same user/project/local settings, `CLAUDE.md`, skills, agents, commands, and
   hooks as the CLI.
3. The SDK-bundled Claude binary works with the chosen authentication and
   filesystem configuration. A configured system executable is accepted only
   after its initialization version/capabilities satisfy the host minimum.
4. One streaming `Query` accepts at least three sequential messages without
   respawning and preserves context.
5. `Options.sessionId` creates the exact caller-chosen UUID used by QiYan's
   create-session transaction, and `resume` accepts existing CLI-created
   session IDs without forking or rewriting them.
6. A supplied `SDKUserMessage.uuid` is preserved in live events and native
   history. Retrying the same UUID after an ambiguous host response does not
   create a second user turn.
7. A second message sent while a turn is active is queued exactly once and
   appears in the correct order.
8. `interrupt()` terminates only the active response and leaves the session
   usable for the next message.
9. Built-in Bash/file/Web tools and the existing authenticated QiYan MCP
   scheduling tools execute without a manual terminal approval deadlock.
10. Foreground and background subagents produce distinguishable events.
   Determine whether a background agent can complete after the parent response
   while the query remains open, how `stopTask()` behaves, and how the task set
   gates idle status and eviction. Prove that task-notification results do not
   produce duplicate user bubbles, completion delivery, or goal advancement.
11. `setModel`, permission-mode changes, effort/settings changes, MCP status,
    and initialization metadata behave as required by the current UI/tools.
12. `supportedModels()` can replace the current static model catalog without
    losing effort validation or configured-default behavior.
13. SDK events contain reliable top-level versus subagent identity, user-input
    identity, partial/final text, and per-turn result boundaries.
14. The native JSONL remains compatible with lazy history, discovery, CLI
    resume, and archive behavior. Measure `listSessions`,
    `getSessionInfo`, and `getSessionMessages` on a large real transcript and
    determine whether they can replace QiYan's manual JSONL parser without
    unbounded reads.
15. Native `/goal` can implement set, clear, pause/resume projection, automatic
    completion, resume after disposing and recreating the SDK `Query`, and
    worker-reported complete/blocked without `ClaudeGoalDriver`. Test trusted
    and untrusted workspaces plus `disableAllHooks`: unsupported goal operations
    fail closed without affecting ordinary turns. No test may run native and
    QiYan auto-drive simultaneously.
16. Native goal processing exposes a documented per-response turn/usage signal
    and a stop boundary before the next continuation. Demonstrate that a
    50-turn or token-budget limit interrupts an actively continuing goal and
    projects `budgetLimited`, rather than merely classifying its eventual final
    result. Rate/usage limits must project `usageLimited`, and the native turn
    backstop must remain effective without a QiYan callback participating. If
    the SDK query is disposed after a goal-terminal tool effect commits but
    before its result returns, a fresh query must clear the native goal before
    auto-resume can start another continuation. If either boundary cannot be
    proven, record the decision to retain `ClaudeGoalDriver` as the sole driver.

The SDK-only spike is successful only if it demonstrates the above locally
with real Claude, not only with mocks. Its output is a short capability report
and a go/no-go decision for native `/goal`.

## Second next step: minimal host-lifecycle prototype

After the SDK-only spike, build a minimal host/client prototype. It is allowed
to exercise the proposed protocol and supervision boundary, but it is not yet a
production replacement for `ClaudeCodeRuntime`.

The host prototype must prove:

1. Disconnecting only the client does not stop the independently running host
   or active query; reconnect observes current status and the eventual result.
2. One host-owned in-process MCP bridge can call the real QiYan scheduling and
   goal handlers through a typed backend connection. If the connection drops
   after the backend commits an effect but before its reply arrives, retrying
   the same operation ID returns the durable result without a duplicate effect.
   For `set_goal_status=complete|blocked`, drop that reply while native `/goal`
   is ready to continue: the held tool call must prevent another continuation,
   reconnect must recover the durable result, and the host must clear and
   verify the native goal before releasing the tool result. Repeat with a host
   crash during the same transition.
3. The protocol handshake carries host/backend/SDK/Claude versions,
   capabilities, and runtime generation. An N+1 client can let a compatible N
   host finish active work and replace it only after it drains; an incompatible
   active host is not terminated.
4. Killing the host cannot leave a Claude, Bash, tool, or background-agent
   descendant alive. Replacement remains refused until the prior process
   generation is proven absent.
5. The same prototype works through the existing SSH/runtime-root transport on
   one remote endpoint and survives ControlMaster loss.

Only after both phases pass should production migration begin.

## Implementation sequence after successful prototypes

Follow test-driven changes: add a failing behavioral test before each
production behavior change.

1. Add the pinned TypeScript Agent SDK dependency and a standalone
   `qiyan-claude-host` entry point. Define a small host client interface
   independent of local versus SSH transport. Version the protocol and include
   build/SDK/Claude identities plus capabilities in its handshake.
2. Implement one session actor per loaded thread. The actor owns the SDK
   `Query`, streaming input queue, foreground request identity, native task set,
   status, bounded event replay, and SDK control calls.
3. Add the SDK-to-QiYan event adapter and make active Web UI flow consume those
   events. Implement lazy history through the SDK session helpers if the spike
   proves they are bounded; otherwise keep `ClaudeTranscriptHistory` behind
   the host for lazy/durable history only.
4. Add the host-owned in-process MCP bridge and bidirectional endpoint RPC.
   Share the existing scheduling/goal tool handlers; do not duplicate their
   persistence logic in the host. Add stable tool-operation IDs, durable
   request-hash/result replay, the goal-terminal continuation fence, and
   disconnect/crash-after-apply tests.
5. Apply the goal decision from the SDK spike. If native `/goal` passed, add
   the idle-only legacy-goal migration, map public controls onto native goals,
   retain the manager-visible status/budget projection and enforceable live
   stop guard, preflight trust/hooks, and retire `ClaudeGoalDriver` only after
   all legacy drive rows/claims are drained. Otherwise retain
   `ClaudeGoalDriver` as the sole driver and route its follow-ups into the
   persistent query.
6. Add independent local supervision. A restart of the main QiYan service must
   leave the host process outside the restarted service's kill scope. The host
   generation must own a cgroup or equivalently fenced process tree, and restart
   must kill/verify every descendant before replacement.
7. Switch local `ClaudeCodeRuntime` from `LocalClaudeCommandRunner` to the host
   client and run real acceptance tests for send, queue, interrupt, reconnect,
   goals, schedules, subagents, and history.
8. Package the same host for remote endpoints. Run it inside the existing
   endpoint tmux generation and forward/connect its owner-only socket through
   SSH. Reuse endpoint bootstrap, runtime-root attestation, ControlMaster, and
   reconnect policy. Preserve exact generation/process cleanup until the new
   host proves equivalent ownership. Stage versioned host assets and replace a
   compatible old generation only after it drains.
9. Switch remote `ClaudeCodeRuntime` to the host client. Verify an active turn
   survives both SSH loss and QiYan restart.
10. Remove the obsolete one-shot dispatch path in the same migration:
   `LocalClaudeCommandRunner`, turn dispatch/watch operations in
   `SshClaudeCommandRunner`, `qiyan-claude.mjs`, transcript-materialization
   acknowledgement scans, and related recovery tests. Also remove the manual
   JSONL history/discovery parser if the SDK helpers have replaced it.
11. Re-evaluate and remove the "never use background agents" appended prompt
   only after native background-agent lifecycle is proven.
12. Update endpoint documentation and release notes, then deploy first to one
    local and one remote canary before migrating all Claude workers.

Do not keep both execution engines behind a long-lived fallback. A short
feature flag for canary rollback is acceptable, but once the SDK host passes
the acceptance suite, delete the one-shot implementation rather than
maintaining two competing lifecycle models.

## Components to retain, adapt, and retire

### Retain

- Goal-control storage needed for manager-visible paused/blocked projection,
  the full existing status/budget contract, and goal migrations. Retain
  `ClaudeGoalDriver` only if the SDK spike rejects native `/goal`; never retain
  two active drivers.
- Scheduling/goal tool handlers and schedule persistence.
- Managed-session registry, archive tombstones, endpoint catalog, and endpoint
  manager.
- Provider-neutral chat relay and Web UI contracts.

### Adapt

- `ClaudeCodeRuntime`: keep its external interface, replace process ownership
  with a host client.
- Remote runtime bootstrap: install/start the host and expose its socket rather
  than dispatching one CLI process per turn.
- Worker scheduling transport: reuse the current tool handlers through a
  host-owned in-process MCP bridge; the Claude query no longer depends on the
  backend-generation HTTP token/reverse tunnel.
- Claude goal controls: use the sole driver selected by the spike. For native
  `/goal`, project the additional manager-visible status/budget state,
  preflight trust/hooks, migrate legacy goal-drive effects while idle, and
  retain an enforceable pre-continuation stop guard.
- Model/effort/permission tools: call the corresponding SDK controls where
  available and preserve sticky QiYan settings where Claude has no native
  equivalent.
- Model discovery: use `supportedModels()`/initialization metadata instead of
  maintaining a static Claude model catalog.
- Active status and completion: derive them from host/SDK events.
- Lazy history and discovery: prefer the SDK's session APIs; retain the current
  bounded JSONL reader only if those APIs fail the large-transcript spike.

### Retire after cutover

- `LocalClaudeCommandRunner.startTurn`.
- Per-turn tmux dispatch, live PID markers, turn wait channels, and
  materialization scans in `SshClaudeCommandRunner`.
- `assets/remote/qiyan-claude.mjs`.
- `ClaudeGoalDriver` and its synthetic continue prompts, only if native `/goal`
  passes the complete goal-contract spike and the legacy cutover finishes.
- Claude's use of the worker HTTP MCP token/reverse tunnel.
- Process-exit inference as the normal definition of turn completion.
- JSONL polling as the normal active-message transport.
- Manual JSONL history/discovery parsing, if SDK session APIs meet the bounded
  paging and performance requirements.
- The static Claude model catalog, once SDK model discovery is verified.
- The headless-only background-agent prohibition, if the SDK tests prove safe
  native background behavior.

## Open decisions

Resolve these in the spike/design review, not ad hoc during migration:

- Authentication and distribution terms for QiYan's use of the Agent SDK.
- Whether local host supervision is a separate systemd unit, a user service
  instance, or another independently managed runtime. It must survive the main
  QiYan service restart and fence the complete process tree.
- Confirm the SDK-bundled Claude binary works with the chosen authentication.
  Production should prefer it; a configured system `claude` must pass the
  explicit version/capability gate.
- Confirm that `Options.sessionId` works with the configured system Claude
  executable and produces the same native identity QiYan supplied.
- Whether SDK session-history helpers are sufficiently bounded and efficient
  for large local and remote transcripts. Use them if they are; do not retain a
  manual parser merely for compatibility with the old implementation.
- Event replay cursor and memory bound for short backend disconnects.
- Idle eviction threshold and maximum loaded SDK subprocesses per endpoint.
  Anthropic recommends sizing per subprocess; do not leave every discovered
  session loaded.
- Exact approval policy. If managed workers use `bypassPermissions`, configure
  the SDK's required opt-in explicitly and retain QiYan's disallowed native
  scheduling tools. Otherwise permission requests must be surfaced to users.
- Whether queued input during an active turn is always "next turn" or whether
  QiYan exposes a separate interrupt-and-replace operation.
- Background-subagent completion and notification semantics.
- Exact native `/goal` event/state representation needed for manager
  projection, pre-continuation budget enforcement, and `set_goal_status`
  ordering. Failure to prove the bound selects the existing QiYan driver
  instead of weakening the contract.
- The precise protocol compatibility window and how long an idle,
  upgrade-pending host may remain before replacement.
- How effort changes map to current SDK settings when no dedicated effort
  setter exists.

## Acceptance criteria for the completed redesign

- Local and remote active turns survive a QiYan service restart.
- Remote active turns survive SSH ControlMaster loss and reconnect.
- Messages sent during an active turn are accepted once, remain visible, and
  execute in order.
- Live assistant output reaches the active worker panel from SDK events without
  transcript polling.
- Final worker messages reach the correct QiYan/chat recipient exactly once.
- Background task notifications never masquerade as user input, settle a human
  turn, drive a goal, or make a task-bearing session idle.
- Top-level, replayed, synthetic, commentary, tool, and subagent events keep
  their correct roles.
- Existing native Claude sessions remain discoverable in QiYan and resumable
  by explicit ID in the ordinary Claude CLI.
- Claude JSONL is the only durable conversation transcript.
- The selected sole Claude goal driver, QiYan's manager-visible goal controls,
  `set_goal_status`, schedules, and monitors still work after backend restart.
- A lost MCP bridge reply after a committed schedule/goal call replays the
  durable result and never duplicates the effect.
- A lost `set_goal_status=complete|blocked` reply cannot start another native
  goal continuation: the tool call remains fenced until the durable result is
  reconciled and native goal clearance is verified, including after host crash.
- Unsupported native goals fail closed in untrusted/hook-disabled workspaces;
  no second auto-driver starts. If native goals were rejected by the spike, the
  legacy QiYan driver remains the sole driver.
- Goal turn/token caps and every existing goal status remain enforced without
  overshooting an internal native continuation. No armed legacy goal-drive
  schedule or unresolved outbox claim survives a native-goal cutover.
- A host replacement is impossible while any process from its prior generation
  remains alive.
- A backend upgrade neither aborts active host work nor speaks an incompatible
  protocol; compatible old hosts drain and are replaced while idle.
- Interrupt, model, effort, permissions, archive/unadopt, reconnect, and idle
  eviction have real local and remote tests.
- The old one-shot execution and its recovery machinery are deleted after
  canary validation.
