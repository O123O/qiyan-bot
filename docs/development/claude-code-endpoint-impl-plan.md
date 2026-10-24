# Implementation Plan: Claude Code endpoint + provider-agnostic scheduling

Companion to `claude-code-endpoint-design.md`. Ordered, independently-verifiable tasks with review
checkpoints. Karpathy: build the minimum that passes each task's check; do not build ahead of the spike's
findings. **Stop for review at each ⬛ checkpoint before proceeding.**

Guiding invariants (from the design):
- The only provider-aware code is the **adapter** (`ClaudeCodeRuntime`). Everything above `send_to_session`
  (lifecycle, relay, ownership, scheduling, steer, manager tools) is provider-blind.
- Scheduling (wakeup/cron/monitor) fires by **calling `send_to_session`**: one durable store + one firing path
  + **three** trigger sources (timer / cron / condition-poll). **Steer is separate** — provider-specific, in
  the adapter: Codex is native `turn/steer`; Claude *reuses the store* but fires via the adapter, not the
  scheduling engine (§2.3). It is not a fourth scheduling trigger and Codex steer does not go through
  `send_to_session`.
- Everything QiYan owns is **durable + single-fire idempotent**; everything the session owns is the transcript.

---

## Phase 0 — Spike (throwaway; de-risk the unknowns) ⬛

Goal: turn every "confirm in spike" from the design into a documented fact before building the abstraction.
Not merged; a scratch script + a findings note.

- **0.1 Drive one session end-to-end** headless: start (`claude -p … --output-format stream-json`) → capture
  `session_id` → follow-up via `--resume` → stream. Confirm context retained across turns.
- **0.2 Document the transcript schema**: dump a `~/.claude/projects/<hash>/<id>.jsonl` and map its records to
  the fields the adapter needs — per-turn `userMessage` marker (for the `clientId` round-trip / external-turn
  classification), `agentMessage`/final-text, tool events, cwd, turn boundaries, status.
- **0.3 Tool-disable + redirect**: spawn with `--disallowedTools "Monitor ScheduleWakeup CronCreate CronList
  CronDelete"` + the redirect prompt; assert the model cannot invoke each AND has no residual scheduling path
  (does not reach for `/loop` or background/hooks). Exact tool-name strings verified.
- **0.4 Steer/queue behavior**: with `--input-format stream-json` held open, does a second message injected
  mid-turn queue-for-next or nothing? (Confirms the emulation is "queue," not a Claude feature.)
- **0.5 Auth + config**: confirm API-key headless auth and `~/.claude` inheritance (non-`--bare`).
- **0.6 Remote round-trip**: run `ssh <host> claude -p --resume <id> …` over ControlMaster (e.g. `dfw-vscode`,
  which has `claude` installed) and confirm start + resume + stream work identically to local, and that the
  remote transcript is readable over the same SSH command channel. (No remote server — confirms remote is just
  ssh-wrapped spawn.)

(Runtime is **headless `claude -p`** — decided; no SDK comparison.)

**Verify / exit:** a findings note with the transcript schema and the tool-disable proof. ⬛ *Review the
findings before Phase 1 — they may change the adapter shape.*

---

## Phase 1 — The Claude endpoint (Codex-protocol adapter) + transcript layer

Build so the whole existing stack (lifecycle, relay, ownership, manager tools) drives a Claude session
unchanged. Test each unit against the real lifecycle/relay with a **faked** runtime first (de-risk R1).

- **1.1 Transcript parser + `RolloutAccess`** (`src/sessions/…` new module): parse the Phase-0 schema; implement
  **both** `scan` and `scanUnmaterialized`; a Claude filename validator (the existing `validRolloutPath`,
  `rollout-ownership.ts:414`, hard-rejects non-`rollout-*.jsonl` paths, so the Claude scanner is separate).
  **Name the dispatch seam:** `RolloutAccessRouter` (`endpoints/rollout-access.ts`) today routes local-vs-ssh
  for the Codex scanner; add **provider dispatch** (Codex scanner vs Claude scanner) keyed by the
  endpoint/session provider. Reuse the ownership DB tables + `inspect`/`initialize` state machine unchanged.
  **Remote implication:** for remote sessions the scan runs in the shipped `qiyan-ssh-helper.mjs`, which is
  Codex-jsonl-aware — a remote *Claude* transcript needs either a Claude-aware helper or a raw-bytes-back-then-
  parse-locally path. The 1.1 dispatch seam covers the local case; call out the remote-helper work so it isn't
  discovered mid-Phase-1.
  *Verify:* unit tests over sample transcripts — materialized/unmaterialized/missing; owned-vs-external via the
  user-message marker.
- **1.2 Event translator** (pure function): stream-json → Codex-shaped turn/item notifications; synthesize
  `turn/completed`. *Verify:* pure-function unit tests on captured stream-json fixtures.
- **1.3 `ClaudeCodeRuntime`** — a **parallel `ManagedAppServerEndpoint`-shaped class** (NOT
  `AppServerRuntimeService` — avoid the initialize/account handshake). Implement the adapter contract (design
  §4.3): `thread/start`, transcript-reconstructed `thread/read` (+`cwd`, `clientId` round-trip, `agentMessage`/
  `userMessage` item shapes), `thread/resume`, `turn/start` (spawn `claude -p --resume` with the **stable**
  flags → translate → push synthesized `turn/completed` via `onNotification`), `turn/interrupt` (kill
  subprocess), `archive`/`unsubscribe` (local). The reconstructed `thread/read` must report
  **`itemsView:"full"`** on every turn (`pool.readFullThread` requires it). Decide error-shape handling
  (reproduce the exact `-32600` messages vs. structure so those branches are never reached).
  *Verify:* drive it through the **real** `lifecycle`/`relay` with a scripted subprocess: start → turn →
  synthesized `turn/completed` → delivery; resumed turn carries context; phantom-gate drops a
  never-materialized session (uses 1.1).
  Parameterize spawn by a **command runner**: local = direct `claude -p`; remote = `ssh <host> claude -p` over
  the existing **ControlMaster** channel (no remote daemon, no forwarding). `RolloutAccess.scan` (1.1) and the
  `monitor` `check` run over the same command channel (local or ssh). Remote is a spawn parameter, not a
  subsystem — reuse QiYan's SSH infra.
- **1.4 Wire into pool / EndpointManager / config** — endpoints model **hosts**, not providers, and are
  currently hardcoded Codex (local = Codex `ManagedAppServerEndpoint`, `production-app.ts:2213-2218`; catalog
  `type: z.literal("ssh")` → Codex runtime, `catalog.ts:10`). **Multiplexing model (state it):** a
  `ClaudeCodeRuntime` is **one endpoint per host, multiplexing many sessions** (threadId = Claude
  `session_id`), matching the pool's `(endpointId, threadId)` keying — NOT one-endpoint-per-session. Required
  work: (i) extend the catalog schema (a `claude-code` local + ssh variant, differing only in the command
  runner); (ii) a new construction path in `EndpointManager`/`production-app`; (iii) session-start endpoint
  selection that can target it. The pool only needs the `AppServerEndpoint`/`ManagedAppServerEndpoint`
  duck-typed surface (`pool.ts:4-8`), so it's feasible. Launch flags (system-prompt, `--mcp-config`,
  `--disallowedTools`, model) are **stable per session**.
  *Verify:* a Claude session is created/adopted and appears in `list_managed_sessions`; the unified manager
  tools (`send_to_session`, `get_session_status`, `get_chat_history`, `adopt_session`, `interrupt_session`)
  work against it identically to Codex; two Claude sessions multiplex on one endpoint concurrently.
- **1.5 Goal emulation** (the one non-transparent manager family): implement `get/set/pause/resume/cancel_goal`
  for Claude via QiYan-tracked goal state + persistence (ownership already covered by the `clientId` marker).
  *Verify:* the 5 goal tools operate on a Claude session; set-goal **persists a goal row** that **causes a
  QiYan-driven follow-up turn after the current turn completes** (the observable proof of enforcement), and
  `cancel_goal` stops it.

⬛ *Review Phase 1 (adapter correctness + manager-tool parity + phantom-gate) before Phase 2.*

Exit criterion: **a Claude session is a first-class managed session** — every manager tool except goal works by
construction; goal works via emulation; recovery reconciles it via the transcript.

---

## Phase 2 — The provider-agnostic scheduling / monitor / steer layer

One module, provider-blind, firing via `send_to_session`. Built once, tested against **both** Codex and Claude.

- **2.1 Durable schedule store** (`src/…` new DB table + migration): `(id, session, trigger_kind, trigger_spec,
  message, single_fire_key, state, next_fire_at)`. **Net-new additive table** — there is no scheduler to
  replace. (`assistant/scheduler.ts` is the assistant's conversation job/event-batching engine, wired into the
  conversation-dispatcher — unrelated; **do not touch it**.)
  *Verify:* store/reload round-trips; survives process restart in a test.
- **2.2 Trigger engine** (provider-blind): timers (wakeup/cron) + condition poller (`monitor`, runs `check` on
  the session endpoint, floored interval). On fire → enqueue a **durable `send_to_session` operation**
  (`send_to_session` is a replayable durable operation, `production-app.ts:3433`) with **its OWN single-fire
  key** — NOT the relay's per-observed-turn delivery idempotency (a fire is self-originated; different key, per
  design §5). (Steer is 2.3, not here.)
  *Verify:* a fake trigger enqueues exactly one `send_to_session` operation, never twice — including across a
  simulated restart at the moment of firing.
- **2.3 Steer — provider-specific, in the adapter (NOT a scheduling-engine trigger):** `send_to_session(mode:
  steer)` → `turn/steer`. **Codex keeps its native `turn/steer`** (`service.ts:58`) — unchanged,
  **regression-locked**, no behavior change. **Claude's adapter implements `turn/steer` as a durable enqueue**
  into the 2.1 store (turn-completed trigger) — drain FIFO on `turn/completed`, never interrupt. So Claude steer
  reuses the store/engine; Codex steer is native. The scheduling layer is NOT involved in the steer decision.
  *Verify:* (Codex) existing steer behavior byte-identical (regression test); (Claude) two steers during a
  running turn deliver as the next two turns, in order, single-delivery, surviving a simulated restart mid-turn.
- **2.4 Worker-facing MCP surface** (`src/mcp/…` new): expose the 5 tools (`schedule_wakeup/cron/monitor/
  list_schedules/cancel_schedule`) to **worker** sessions — today `LoopbackMcpServer` is assistant-only
  (`mcp/server.ts` rejects non-assistant callers) and worker env is built by `buildWorkerChildEnvironment`
  (`production-app.ts:2218`, MCP token stripped). Sub-parts: (a) **worker auth model** + **per-session
  identity injection** (the tool must learn which worker called); (b) **remote reachability** — the tool logic
  runs in the LOCAL QiYan (store + engine live there); a remote worker reaches it by **reverse-forwarding the
  loopback MCP over the session's own SSH** (`ssh -R <remoteport>:127.0.0.1:<mcpPort>`, added to the
  QiYan-owned ControlMaster via `-O forward`), so the remote `--mcp-config` targets
  `http://127.0.0.1:<remoteport>/mcp`. This is **provider-agnostic and keyed on local-vs-remote, NOT
  Codex-vs-Claude** — a remote worker of *either* provider needs the tunnel (its `--mcp-config` is interpreted
  on the remote host); a local worker of *either* provider hits loopback directly and needs nothing. Remote
  Codex already rides a QiYan-owned master with `-O forward -L` to reach its daemon, so `-R` is the same
  connection; this layer belongs to the endpoint's remote transport, not either adapter. Session transport
  stays forward-only (unchanged) and this adds NO inbound path to the local host — the tunnel terminates at
  loopback on both ends.
  **The hard part is auth, and the right posture is bind-not-relax:** the connection that lands on the LOCAL
  MCP port is opened by the **local ssh ControlMaster process QiYan itself spawned and owns** (sshd is on the
  *remote* end) — so `allowedClientProcess` (`mcp/server.ts:90`, `requestBelongsToProcess` :210) still applies,
  **re-pointed at the ControlMaster's identity** (ssh `RuntimeIdentity` carries pid/start-time; `/proc/<pid>/
  fd` is readable since it's QiYan's child; the tunnel is IPv4 loopback so the inode match is clean). So:
  **bearer token → which worker** (per-session scope; all workers on an endpoint share one master and are
  peer-PID-indistinguishable), **peer-PID = owned ControlMaster → proves the call arrived through QiYan's
  tunnel**, not from an arbitrary local process that merely obtained the token (keeps the deliberate
  defense-in-depth; a leaked token alone is NOT sufficient). Use a **separate listener/port for tunneled
  worker traffic**, ControlMaster-pid-bound; the assistant listener is unchanged. Three constraints to design
  explicitly: **(i)** `-O forward` **throws `OPERATION_CONFLICT` on a user-owned master** (`ssh-config.ts:69`)
  — so remote-worker scheduling requires a QiYan-owned master, else fall back to a dedicated QiYan-owned
  forwarding channel; **(ii)** the remote port must be **stable for the session's life and byte-identical
  across restart** (it's baked into the cache-prefix `--mcp-config`) — allocate a deterministic per-session
  port with collision handling, re-established identically on recovery; **(iii)** the per-session token is
  written to the remote `--mcp-config` on the remote worker's disk — it MUST be a worker-scoped token in a
  **different namespace from the assistant's `QIYAN_BOT_MCP_TOKEN`** (which authorizes the full assistant
  surface, `mcp/server.ts:283`). (stdio alternative rejected: a remote stdio MCP command would need
  remote→local SSH — wrong direction, inbound creds the local host may not grant.)
  (c) attach via per-invocation `--mcp-config`, additive, byte-identical per turn; drop-in descriptions;
  writes to 2.1.
  *Verify:* a worker session (Codex and Claude, **local and remote**) calls each tool; it registers a row;
  `list`/`cancel` work. Remote: the tunneled-worker listener accepts the scoped token from a call whose peer
  is the owned ControlMaster, and **rejects a non-tunneled local process that presents the same token** (peer
  PID ≠ master). Restart: the remote port and `--mcp-config` are byte-identical before/after.
- **2.5 Recovery**: on QiYan restart, reload the store + re-arm (timers recompute next-fire / fire missed
  one-shots per policy; monitors restart poll loops; steer queues reload; goal reloads).
  *Verify:* a `schedule_wakeup` set before a QiYan restart fires **exactly one** resumed turn after restart —
  against **both** a Codex and a Claude session (proves provider-agnostic + durable + single-fire).

⬛ *Review Phase 2 (durability + single-fire + provider-agnostic proof) before finishing.*

---

## Cross-cutting

- **Tests:** each task ships its own failing-test-first per repo convention; Phase-1/2 exit criteria are
  integration tests. Keep Codex behavior byte-identical throughout (regression-lock).
- **Security/logging:** never log message bodies, tokens, or transcript contents (repo rule). `monitor` `check`
  runs with the worker's own permissions (like the agent's own Bash).
- **Sequencing:** Phase 0 gates 1; 1.1/1.2 gate 1.3; 1.3/1.4 gate the manager-tool parity; 2.1/2.2 gate
  2.3/2.4/2.5. **Phase 2 can start in parallel with Phase 1 against Codex** — `send_to_session` works for Codex
  today, so the store/engine/worker-MCP (2.1/2.2/2.4) can be built and validated end-to-end on Codex
  independently of the Claude adapter (R2 is the biggest new build — start early). Only the "both providers"
  exit (2.5) and Claude steer (2.3) truly need Phase 1.
- **Not now (deferred):** detached-subprocess turn survival (start with child + re-drive); provider-agnostic
  pool/lifecycle refactor (only if a 3rd provider appears); warm mode (removed).

## Open decisions to close during implementation (from the design)
- Error-shape reproduce-vs-never-reached (1.3). Goal persistence mechanism (1.5: QiYan-drive vs `--settings`
  Stop hook). Cron missed-occurrence policy (2.5). (Runtime = headless `claude -p`, decided.)
