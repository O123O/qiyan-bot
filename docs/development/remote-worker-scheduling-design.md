# Remote Claude worker: goals, steer, and self-scheduling

Extends the remote Claude endpoint (`claude-remote-endpoint-design.md` §3.5, deferred) so a **remote**
`dfw-claude`-style endpoint has the same goal/steer/scheduling surface the local `claude-local` endpoint
already has. Today a remote Claude session is a driven worker only: `set_goal`→UNSUPPORTED, `turn/steer`→
UNSUPPORTED, and the worker's `schedule_*`/`set_goal_status` MCP tools are unreachable.

## 1. What exists (local endpoint, do not rebuild)

- `ClaudeGoalStore` (durable goal state), `ClaudeGoalDriver` (auto-drive: enqueue the next goal-pursuit turn
  after each completion while active), `SchedulingService` (durable schedules + the worker MCP surface),
  `WorkerScheduleMcpServer` (HTTP on `127.0.0.1:<port>`, per-session bearer token → session; tools:
  `schedule_wakeup`/`schedule_cron`/`schedule_monitor`/`set_goal_status`), and `workerMcpConfigPath(session)`
  (writes a per-session `--mcp-config` JSON: `{type:"http", url:"http://127.0.0.1:<port>/mcp", headers:{Authorization: Bearer <token>}}`).
- All of it is wired ONLY when `config.claudeCode` is set, and keyed to the single local endpoint id
  `claudeCodeConfig.endpointId` (`production-app.ts:2285-2360`, `2780`, `3293`). `turn/steer` = durable enqueue
  (`scheduling.enqueueSteer`) delivered as the next turn — Claude has no mid-turn injection.
- The remote endpoint's `createRemote` branch builds a **minimal** `ClaudeCodeRuntime({id, runner, launchFlags})`
  — no `goals`, no `steer`, no `workerMcpConfigPath`.

## 2. Tier A — goals + steer for the remote endpoint (no networking)

Goals and steer are entirely QiYan-side (state in QiYan's DB, driver runs in QiYan, enqueue writes QiYan's
schedule store). They work for a remote endpoint the moment its runtime carries the same callbacks — the
`claude -p` host is irrelevant.

**Blocker:** the goal store / driver / dashboard refresh are keyed to `claudeCodeConfig.endpointId` (the local
id). A remote `claude-code` endpoint has a different id, and its config lives in the catalog, not
`config.claudeCode`. So "is this a Claude endpoint I drive goals for?" must become **provider-based**, not
`=== claudeCodeConfig.endpointId`.

**Change:**
1. `ClaudeGoalStore` is already `(endpointId, threadId)`-keyed — reuse it for all Claude endpoints (one store).
2. Generalize the goal predicate: replace every `endpoint === claudeCodeConfig.endpointId` /
   `config.claudeCode?.endpointId` goal gate with `sessionProvider(endpoint) === "claude"` (the driver
   `onTurnCompleted`/`activate`/`resumeActive`, `refreshClaudeGoalObservation`, `activateClaudeGoalIfClaude`).
   The driver already takes `endpointId` per call, so it is endpoint-agnostic; only the *gates* are hardcoded.
3. `createRemote` claude branch wires `goals: claudeGoals` and `steer:` (the same `scheduling.enqueueSteer`
   closure the local endpoint uses) into the remote `ClaudeCodeRuntime`. `workerMcpConfigPath` is Tier B.
4. The goal driver's turn-completed hook currently subscribes only to the local `claudeEndpoint`
   (`production-app.ts:2348`). A remote endpoint's `turn/completed` must ALSO reach the driver — subscribe on
   the remote `ClaudeCodeRuntime` in `createRemote` (or route all provider=claude completions to the driver).

**Gating requirement:** goals need `config.claudeCode` to exist today (that's what constructs `claudeGoals`,
`scheduling`, `claudeGoalDriver`). A remote Claude endpoint can exist with NO local `claudeCode` config. So
construct `claudeGoals`/`scheduling`/`claudeGoalDriver` when **either** a local claude endpoint OR any catalog
`claude-code` endpoint exists (catalog is readable at startup).

## 3. Tier B — worker self-scheduling over `ssh -R` (the networking piece)

The worker's own tools (`schedule_*`, `set_goal_status`) run inside `claude -p` ON THE REMOTE HOST and speak
MCP over HTTP to the URL in their `--mcp-config`. That URL points at QiYan's loopback MCP — unreachable from
the remote host. Expose it via an `ssh -R` reverse tunnel over the endpoint's existing ControlMaster.

### 3.1 Transport: remote loopback TCP → QiYan's MCP port
`ssh -O forward -R 127.0.0.1:<rport>:127.0.0.1:<mcpPort>` over the ControlMaster (one tunnel **per endpoint/host**,
shared by all its sessions — the per-session bearer token already distinguishes them). Mirror the existing
`buildSshStreamForwardArgs` (which does `-L` for the Codex app-server socket) with a new `buildSshReverseForwardArgs`
using `-R`. The remote listener binds to `127.0.0.1` (NOT `0.0.0.0`) — with the default `GatewayPorts no` this is
**bind-not-relax**: only processes ON the remote host can connect, never the network.

- Rejected: reverse-forwarding a **unix socket** (stronger fs-perm auth) — Claude's MCP client config is
  `{type:"http", url}`; there is no portable unix-socket URL form, so TCP loopback is required.

### 3.2 Auth
Two layers: (a) the remote listener is loopback-only (§3.1), so off-host attackers can't reach it; (b) the
per-session **bearer token** in the worker's `--mcp-config` (mode 0600, readable only by the ssh user) is the
real credential — an unauthenticated request is rejected by `WorkerScheduleMcpServer` exactly as locally. A
co-tenant process on the remote host could reach the port but not the token. This matches the local model,
where any local process could reach `127.0.0.1:<port>` but needs the token.

### 3.3 Remote port allocation
Deterministic per endpoint: `rport = 20000 + (sha256(endpointId) mod 20000)` (a stable high port). Establish the
tunnel with `ExitOnForwardFailure=yes`; on a bind collision (port in use on the remote), fail the tunnel
establishment loudly and surface it — the worker MCP config for that endpoint is then NOT written (the session
still runs, just without self-scheduling, same as a local endpoint whose scheduler is down). *Open question for
review:* deterministic-with-fail vs. dynamic `-R 0` + parse the allocated port (unreliable under `-O forward`).

### 3.4 Lifecycle
- Establish the tunnel lazily, the first time `workerMcpConfigPath` is requested for a remote endpoint (i.e. the
  first worker turn that would use scheduling), and cache it per endpoint. Re-establish if the ControlMaster
  dropped (the tunnel dies with it) — `ssh -O check` before reuse, like the runner's attestation.
- `workerMcpConfigPath` for a remote endpoint writes the config with `url: http://127.0.0.1:<rport>/mcp` (the
  remote-forwarded port), writes it to the **remote** runtime dir (the worker reads it there, via the file
  bridge / a `write-file` helper op), and returns the remote path for `--mcp-config`.
- On endpoint disconnect/restart (daemonless lifecycle) the tunnel is torn down (`-O cancel -R`) and re-armed on
  next use.

### 3.5 The monitor caveat
`schedule_monitor` runs a `bash -c` check. Today that check runs on the QIYAN host (`runMonitorCheck`), not the
worker's host. For a remote worker a monitor that greps a remote log would silently check QiYan's fs. Scope:
`schedule_wakeup`/`schedule_cron`/`set_goal_status` are host-agnostic and fully supported remotely; **document
that `schedule_monitor`'s check evaluates on the QiYan host** (or reject `schedule_monitor` for a remote worker
until a remote-check op exists). Decide in review.

## 4. Plan
1. **Tier A** (goals + steer for remote) — provider-based goal gates; construct the goal/scheduling stack when
   any Claude endpoint (local or catalog) exists; wire `goals`+`steer` into the remote `createRemote` runtime;
   route remote `turn/completed` to the driver. *Verify:* acceptance test drives `set_goal` → an owned autonomous
   goal turn → `pause`/`resume`/`cancel`, and a `steer` (queued, delivered next turn), on `dfw-claude`.
2. **Tier B** (reverse tunnel) — `buildSshReverseForwardArgs`; a per-endpoint tunnel manager (establish/check/
   cancel over the ControlMaster); remote `workerMcpConfigPath` (reverse port + write config to the remote dir);
   wire it into the remote runtime. *Verify:* acceptance test — a real remote worker turn calls `schedule_wakeup`
   and `set_goal_status`, the fire lands in QiYan's schedule store and drives a turn, the goal status flips.
3. Both tiers go through the acceptance harness (`mcp-production-actions`, remote fixture) end-to-end, plus unit
   tests for the new ssh args + tunnel manager + provider goal gates.

## 5. Risks
- **Security:** the reverse tunnel exposes an internal MCP surface onto another host. Loopback-bind + 0600
  token-file + the existing bearer auth is the control; a review must confirm no `0.0.0.0`/GatewayPorts relax and
  that the token file never lands world-readable on the remote.
- **ControlMaster coupling:** the tunnel dies with the master; must be re-established idempotently (and torn down
  on endpoint teardown so it doesn't leak).
- **Tier A gating change:** constructing the goal/scheduling stack for catalog-only Claude endpoints must not
  change behavior when only the local endpoint (or neither) exists.

## 6. Open questions (for review)
- §3.3 deterministic-port-with-fail vs. dynamic-port-parse.
- §3.5 `schedule_monitor` remote semantics: document-QiYan-host vs. reject-for-remote vs. remote-check op.
- Should Tier A ship first (no networking, high value) and Tier B follow, or land together?
