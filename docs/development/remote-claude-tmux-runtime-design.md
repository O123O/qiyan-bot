# Remote Claude tmux runtime

## Status

Implementation design for persistent remote Claude endpoints.

## Problem

Remote Codex and Claude endpoints already implement the same
`ManagedAppServerEndpoint` interface and are managed by the same endpoint pool,
registry, reconnect loop, and session service. Their transport implementations
are different:

- Codex runs one detached remote App Server in tmux. SSH channels only control
  or connect to that runtime.
- Claude currently starts `claude -p` as a child of one SSH command for every
  turn. Losing that SSH channel kills, or appears to kill, the turn, and a
  QiYan service restart interrupts every in-flight remote Claude turn.

The remote Claude transport must gain Codex-like runtime ownership and
reconnection without pretending that `claude -p` is a daemon.

## Invariants

1. A remote Claude endpoint owns one detached tmux session. It is created once
   and is recreated only when that tmux runtime has actually exited or an
   explicit endpoint restart replaces it.
2. Each managed Claude thread has one persistent pane inside that session.
   Turns reuse the pane; no pane or window is created per turn.
3. `qiyan-claude` remains a one-shot launcher: it reads one prompt from stdin,
   starts one `claude -p` process, and exits when that process exits.
4. Per-turn user message bodies are never written to a file or placed in a
   process argument. The remote helper transfers each body through stdin into a
   named tmux buffer, and the persistent pane pipes that buffer into
   `qiyan-claude`. The separately configured append-system-prompt remains a
   launch setting and is necessarily materialized in config/Claude argv.
5. Effective launch configuration is materialized as a private, atomic
   per-thread JSON file at a runtime-owned path. It contains the cwd, session
   identity, model, effort, append prompt, permission/tool restrictions, and MCP
   configuration. SQLite remains authoritative for mutable QiYan settings; the
   JSON file is only the remote runtime's current materialization.
6. Claude's native JSONL transcript is the only durable source for messages and
   turn completion. QiYan does not add a second durable turn-status or exit-code
   journal.
7. SSH transport loss never means that the Claude process failed. It marks the
   endpoint unavailable and lets the existing endpoint manager reconnect.
8. A normal QiYan service stop closes SSH clients and observers but does not
   stop the remote tmux session or its Claude processes. Explicit endpoint
   restart/disconnect still verifies and stops the exact managed runtime.

## Architecture

The manager-facing API stays unchanged. Remote Claude stops being a
`daemonless` special case by composing `ClaudeCodeRuntime` with two
SSH-specific lower-level components:

- A remote runtime controller implements start, inspect, exact identity,
  detach, verified shutdown, and a blocking liveness watch for the endpoint
  tmux session.
- A remote Claude command runner materializes thread configuration, creates or
  reuses the thread pane, dispatches stdin, inspects its live turn marker, and
  observes settlement.

Local Claude continues to use `LocalClaudeCommandRunner` and remains
daemonless. Codex continues to use `SshRuntime` and `SshAppServerRuntime`.
Provider-specific commands are added to the existing digest-pinned SSH helper;
remote host preflight, bootstrap, runtime-directory attestation, SSH
ControlMaster reuse, file access, and reconnect policy remain shared.

### Remote assets

Bootstrap installs two additional mode-0700 assets beside the existing remote
helper:

- `qiyan-claude`: a Node launcher that validates the known per-thread config,
  builds a `claude -p --output-format stream-json --verbose` argv without a
  shell, copies stdin to the child, and exits with the child.
- `qiyan-claude-runtime-launcher.sh`: starts the persistent tmux anchor and
  records its exact token, PID, Linux start time, and process group using the
  same identity discipline as the Codex launcher.

The anchor keeps the tmux session alive independently of worker panes. A thread
pane is created on first use and then remains as a shell waiting for the next
one-shot command. The runtime token is placed in the tmux session environment,
so the anchor, every persistent pane shell, and every child inherit the same
unforgeable endpoint-generation token.

After start, one SSH helper channel blocks while watching the exact tmux
generation. The anchor holds the write side of an owner-only runtime FIFO, and
the helper blocks in a kernel read on its read side; anchor or tmux exit closes
the writer and wakes the helper without polling. This is a liveness stream, not
a turn transport. If only that SSH channel fails, the controller classifies the
runtime through a fresh helper call and reports connection loss when the same
tmux generation still exists. Closing QiYan detaches this watch deliberately
and must not be interpreted as a runtime failure.

### Prompt dispatch

For a new turn the runner:

1. Atomically synchronizes the private per-thread config.
2. Ensures the thread's existing pane is alive and idle, creating it only if it
   does not yet exist.
3. Loads the raw prompt from the SSH helper's stdin into a uniquely named tmux
   buffer.
4. Sends a fixed command to the pane that starts `qiyan-claude` in a new process
   group and saves the buffer to its stdin.
5. `qiyan-claude` reads the complete prompt into memory, deletes the named
   buffer, starts `claude -p`, records its exact PID/start-time/process-group
   identity in an in-memory pane option, snapshots the transcript before spawn,
   and incrementally scans only bytes appended after that snapshot until the
   matching QiYan client marker is present in Claude's native JSONL. Only then
   does the pane signal the helper's unique `tmux wait-for` acknowledgement.
6. The SSH helper returns success only after receiving that in-pane
   acknowledgement. It then proves either that the same live identity is still
   running, or that it has already settled and the matching native JSONL marker
   still proves materialization. The latter returns a handle whose settlement
   promise is already resolved; this covers turns that finish between the
   `wait-for` signal and helper inspection. Before acknowledgement, every error
   path deletes the buffer and terminates any attested process group that did
   start. Endpoint start also sweeps orphaned QiYan-prefixed buffers from its
   exact tmux server.

Only validated runtime paths and opaque generated identifiers occur in the
shell command. User text is never interpolated into it. Dispatch succeeds only
after native transcript materialization, so a returned `turn/start` always has
a durable Claude user row containing its idempotency marker. There is no
pre-materialization state to reconstruct after an acknowledged call: an
unacknowledged call is reconciled by that same native marker, and an absent
marker plus an absent attested live process proves that it did not materialize.

The tmux live marker contains only the endpoint token, QiYan turn id, dispatch
token, PID, Linux start time, and process group. It is deliberately ephemeral:
it answers which exact managed process is running now and makes interrupt
fenceable; it does not duplicate transcript status or output.

### Exact process ownership

`qiyan-claude` and its `claude -p` child share a new process group whose members
inherit the endpoint token. Interrupt reads the live pane identity, proves the
PID start time and process group, proves that every member carries the expected
token, then terminates and verifies that exact group before returning.

Explicit endpoint shutdown first proves the anchor identity supplied by
`EndpointManager`, enumerates all process groups carrying that exact runtime
token, kills the tmux session, terminates any surviving token-owned groups, and
returns only after no token-owned process remains. The SSH helper itself does
not inherit the token, so shutdown cannot select its own control channel.

### Completion and recovery

While connected, one bounded SSH helper request may wait for a dispatched
pane's live marker to clear. The wait response means only "the process
settled." An individual wait-channel error first inspects the exact pane and
reattaches its observer while the endpoint liveness watch remains healthy. It
does not make the endpoint unavailable. Only loss of the endpoint-level watch,
or a failed fresh runtime probe, emits `onUnavailable`.

After settlement, `ClaudeCodeRuntime` reconstructs the native transcript and
derives the result:

- a matching terminal JSONL turn: completed;
- a matching incomplete JSONL turn and no live process: interrupted;
- no matching JSONL turn after an unacknowledged dispatch and no live process:
  proven not materialized, so the durable caller may retry its same client id.

If an observer cannot reattach because the endpoint liveness watch or fresh
probe is also lost, its promise remains unsettled while the runtime emits
unavailable. The in-memory running turn is retained and no `turn/completed` is
emitted.

Every pane inspection validates the live marker's PID, Linux start time,
process group, and endpoint token. A marker whose attested process is already
absent is settlement evidence, not a reason to re-wait: inspection clears the
stale marker idempotently, performs deferred release when requested, and
reconstructs JSONL. This handles SIGKILL/OOM death while the pane shell and
endpoint tmux remain healthy, without waiting for an endpoint reconnect.

On reconnect, endpoint start reattaches the exact tmux runtime and its liveness
watch. The existing ready-owner recovery then resumes each managed thread; that
thread-level resume inspects its persistent pane:

- If tmux and the thread's live marker still exist, restore its running turn and
  attach a new settlement observer.
- If tmux exists but the marker is gone, reconstruct JSONL and emit a terminal
  event only when native state proves settlement.
- If tmux exited, start one replacement runtime. Any previously running,
  nonterminal materialized JSONL turn is interrupted; a terminal JSONL turn
  remains completed. Existing restart-continuity policy may then offer a new
  resume prompt when no active goal is already driving the worker.

If only the anchor dies while attested thread panes keep the tmux session
alive, startup validates every pane against the prior runtime token and repairs
only the anchor with that same token. It never replaces or duplicates the live
thread panes.

The endpoint manager continues to provide exponential reconnect backoff and
deduplicated reconnect attempts. No history polling loop is added.

### Thread release

`thread/archive` idempotently releases the remote thread's runtime
materialization after the existing lifecycle layer proves the thread idle.
`thread/unsubscribe` writes the token-bound release-on-idle marker first and
then inspects the exact live identity: an absent identity is released
synchronously, while an active pane is left running for the launcher to
release. At settlement the launcher clears its live identity first and then
checks the release marker. This lock-free ordering closes every active-to-idle
interleaving: either unsubscribe observes absence and cleans, or the launcher
observes the marker and cleans (both paths are idempotent). It also cannot be
wedged by a killed lock holder. The active case is required by adoption
rollback, which may unsubscribe a thread whose native goal auto-started during
resume.

Release verifies the pane belongs to the exact endpoint token, kills that one
idle pane, deletes its private config and any matching dispatch buffers, and
forgets its path cache. For deferred release, the one-shot launcher itself
checks the token-bound release marker after its Claude child settles, removes
the config/buffers, and kills its own pane. This remains effective if QiYan
restarts while the orphaned turn is active because it executes inside the
persistent tmux pane, not in the local observer. Endpoint attach additionally
sweeps release-marked panes whose attested process is already absent, covering
forced launcher death before its cleanup block. It does not delete or modify
Claude's native JSONL, so a later adoption recreates the pane and resumes the
same session. Endpoint shutdown performs the same cleanup implicitly for every
pane.

## Lifecycle behavior

| Event | Runtime action | Turn interpretation |
| --- | --- | --- |
| One turn-observer channel drops | Keep endpoint ready and reattach after exact pane inspection | Never failed solely from observer transport loss |
| Endpoint liveness channel drops | Keep tmux and pane when the fresh probe finds the same runtime; otherwise reconnect through the shared manager | Unknown until reinspection |
| QiYan service stops/restarts | Detach local SSH resources only | Remote turn continues; reconnect restores observation |
| `qiyan-claude` exits normally | Pane clears its live marker | Read JSONL; terminal native turn is completed |
| `qiyan-claude` exits without a terminal JSONL row | Pane clears its live marker | The acknowledged, materialized native turn is interrupted |
| tmux/anchor exits unexpectedly | Runtime identity becomes absent | Recreate tmux once; reconcile prior turn from JSONL |
| Explicit endpoint restart/disconnect | Verify exact identity, require managed threads idle, then kill the exact tmux session | Existing manager policy; no broad process kill |
| Archive/unadopt an idle thread | Verify and remove only its pane/config/buffers | Native JSONL remains resumable |
| Adoption rollback unsubscribes an active thread | Leave its turn alive and mark the pane for release after settlement | The persistent launcher performs exact cleanup; attach sweeps a killed launcher |

## Implementation plan

1. Add failing helper and runner tests for bootstrap assets, exact runtime
   identity, one tmux session, reusable per-thread panes, stdin-only prompts,
   config synchronization, in-pane/native-row acknowledgement (including a
   process that exits between acknowledgement and inspection), exact interrupt,
   observer loss, forced launcher death with a surviving pane, reconnect,
   idle/deferred thread release, active adoption rollback including a QiYan
   restart while its turn remains active, and tmux loss.
2. Extend the digest-pinned remote helper with narrowly scoped Claude runtime,
   pane, dispatch, inspect, wait, and stop operations. Reuse its runtime-root
   and subprocess safety primitives.
3. Add the two packaged remote assets and include their digests in bootstrap.
4. Replace `SshClaudeCommandRunner`'s per-turn SSH child with tmux dispatch and
   native transcript access. Add an SSH runtime controller and optional
   persistent-runtime capability to `ClaudeCodeRuntime`; leave the local runner
   behavior unchanged.
5. Wire remote Claude through the existing endpoint manager as non-daemonless,
   including exact identity and unavailable/reconnect signals.
6. Update remote-worker documentation and package manifests, then run focused
   tests and `npm run check`.

## Acceptance criteria

- An in-flight remote Claude turn survives a QiYan service restart and a lost
  SSH observer channel.
- Reconnection neither starts a duplicate turn nor emits a false completion.
- `turn/start` is not acknowledged until the native JSONL contains its matching
  client marker; dispatch failures cannot leave a plaintext prompt buffer or a
  false live marker.
- Multiple Claude sessions on one endpoint can run concurrently in persistent
  per-thread panes.
- Repeated turns for one thread reuse its pane and tmux session.
- Killing the endpoint tmux runtime is detected and results in exactly one
  replacement attempt through the existing reconnect manager.
- Explicit restart/disconnect stops only the attested managed tmux runtime.
- Interrupt stops only the attested turn process group, and endpoint shutdown
  verifies that no process with its exact runtime token survives.
- Per-turn user message bodies are absent from command arguments and runtime
  files; configured append-system-prompt material remains a launch setting.
- No QiYan-owned durable completion/exit-code record is introduced; history and
  terminal state reconstruct from Claude JSONL.
- Archive/unadopt removes the thread pane/config without removing native JSONL.
- Local Claude and remote Codex behavior remains unchanged.
