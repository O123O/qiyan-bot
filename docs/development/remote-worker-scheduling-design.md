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

**Gating requirement (review, BLOCKING):** the catalog is reloaded on every activation and the assistant adds a
remote Claude endpoint at **runtime** by writing `endpoints.json` — so any startup-snapshot decision misses the
primary use case (an endpoint added after boot would get no goal/scheduling stack). **Always construct**
`claudeGoals`/`scheduling`/`claudeGoalDriver`, unconditionally (drop the `claudeCodeConfig === undefined ?
undefined` gates). Cost is one idle loopback MCP + one poll loop; it removes all "does a claude endpoint exist
yet" bookkeeping.

**`resumeActive` (review, SHOULD-FIX) is an enumeration, not a predicate swap:** `listActive(id)` is per
endpointId, so on startup enumerate `registry.snapshot().sessions`, keep `sessionProvider(endpoint)==="claude"`,
group by `endpoint`, and `listActive` per id. (Recovery otherwise self-heals: a resumed drive fires →
`send_to_session` → `createRemote` establishes the driver subscription → the turn completes back into the driver.)

**Remote launch flags (review, NIT):** the remote runtime must take `model`/`disallowedTools` from the catalog
`definition`, not the local `claudeLaunchFlags` (else goals drive turns on the wrong model). Catalog `claude-code`
has no such fields today → default `{}`; sourcing them is a small follow-up, noted.

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
**Dynamic** (resolved during implementation — a deterministic port is unreclaimable): establish the tunnel with
`-R 127.0.0.1:0:127.0.0.1:<localPort>` and read the sshd-allocated remote port back from `-O forward`'s stdout
(empirically it prints just the port; the design's earlier worry that `-O forward` won't surface it was wrong).
The worker learns the port from the URL in its per-session config, so it need not be fixed. `ExitOnForwardFailure=yes`
still guards a real establishment failure (the config is then NOT written — the session runs without self-scheduling,
same as a local endpoint whose scheduler is down). A deterministic `20000 + (sha256(endpointId) mod 20000)` port was
rejected: an ssh forward is cancellable ONLY with its EXACT original spec (verified against OpenSSH — no listen-port-only
cancel form matches), so once a prior QiYan instance's ephemeral `localPort` is forgotten, a stale forward squatting the
fixed remote port can never be reclaimed and every re-establishment fails `ExitOnForwardFailure`. Dynamic allocation
picks a fresh free port each establishment, so it never collides; a leaked forward from an unclean exit dies with the
ControlMaster.

### 3.4 Lifecycle (review, SHOULD-FIX: ownership + idempotency)
- **The tunnel manager lives in the `createRemote` closure** (which holds the plan + `SshRemoteClient`), NOT in
  `ClaudeCodeRuntime` (which holds only the runner). `closeConnection()` doesn't touch the master, and a
  daemonless adapter reset does NOT exit the master (`ControlPersist=yes`), so the `-R` forward **survives** a
  reset — reuse is fine, but re-arm must be **idempotent** (tolerate an already-live forward; `ssh -O check`
  first). Teardown (`-O cancel -R` + optionally master exit) hooks to real endpoint disposal, not `closeConnection`,
  or old loopback listeners accumulate on the remote across re-leases.
- Establish lazily on the first `workerMcpConfigPath` for the endpoint; cache per endpoint; re-check the master
  before reuse (mirrors the runner's per-turn `attestUserControlMaster`).
- `workerMcpConfigPath` for a remote endpoint writes the config with `url: http://127.0.0.1:<rport>/mcp` (the
  remote-forwarded port), writes it to the **remote** runtime dir (the worker reads it there, via the file
  bridge / a `write-file` helper op), and returns the remote path for `--mcp-config`.
- On endpoint disconnect/restart (daemonless lifecycle) the tunnel is torn down (`-O cancel -R`) and re-armed on
  next use.

### 3.5 The monitor caveat (review: REJECT for remote, do not document)
`schedule_monitor` runs a `bash -c` check on the QIYAN host (`runMonitorCheck`, host-blind). Its tool
description tells the worker the check runs "on your session's host" (`worker-mcp.ts:107`) — a lie for a remote
worker, and a doc caveat never reaches the LLM worker, so it would write remote-path greps that silently
evaluate against QiYan's fs. The in-code comment (`production-app.ts:125-127`) already mandates gating. So:
**reject `schedule_monitor` (UNSUPPORTED) for a provider=claude remote session** until a remote-check op exists.
`schedule_wakeup`/`schedule_cron`/`set_goal_status` are host-agnostic and fully supported remotely.

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

## 6. Open questions — RESOLVED
- §3.3 → **dynamic `-R 0` + read the allocated port from `-O forward` stdout** (revised during implementation).
  The review had picked deterministic-with-fail on the belief that `-O forward` won't surface the allocated port;
  that was tested false (it prints the port). Deterministic is worse: a stale forward on the fixed remote port is
  unreclaimable (ssh cancels only by exact original spec) and permanently breaks re-establishment. Dynamic never
  collides, so it also drops the same-host squat-DoS concern.
- §3.5 → **reject `schedule_monitor` for remote** (see §3.5).
- Sequencing → **Tier A first** (no networking, no new attack surface), Tier B second.
