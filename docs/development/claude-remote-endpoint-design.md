# Design: Remote Claude endpoints (catalog `claude-code`) + ssh ownership scan

Status: draft (for review)
Goal: let the assistant add a **remote Claude Code** endpoint the same way it adds a remote Codex one — an
`endpoints.json` entry — and manage sessions on it safely, including the **ownership scan over ssh** (external-
turn / duplicate-driver detection). This is the deferred remote half of the Claude endpoint work (PRs #7–#12).

## 1. What already exists (do not rebuild)

- **Local Claude endpoint** (merged): `ClaudeCodeRuntime` drives `claude -p`; opt-in via `CLAUDE_CODE_ENDPOINT_ID`.
  Local ownership scan works (`scanLocalClaudeTranscript` reads the local transcript).
- **`SshClaudeCommandRunner`** (merged, verified vs `dfw-vscode`): runs `claude -p` over ssh; the runtime is
  unchanged (local-vs-remote is purely the injected runner). It currently takes a raw `{host}`; production must
  drive it over the **QiYan-managed ControlMaster** instead (see §3.3).
- **Provider awareness** (merged, PR #12): `sessionProvider(endpointId)` + `list_managed_sessions.provider` +
  AGENTS.md. `sessionProvider` already reads a catalog `type:"claude-code"` (once the schema allows it, §3.1).
- **Ownership model** (merged): a Claude turn QiYan drove carries a `<!-- qiyan-cid:ctx:call -->` marker in the
  `user` row's message content (Claude has no Codex `client_id` field); the scanner reads it back and
  `ownsWorkerTurn` classifies owned-vs-external. This is what the remote scan must reproduce on the remote host.

## 2. The impedance: SSH infra is Codex-coupled

A remote Codex endpoint is built in `createRemote` (`production-app.ts:2349`) as: SSH plan (ControlMaster) →
`SshRemoteClient` (helper channel) → **`SshRuntime`** → `SshAppServerRuntime` → `ManagedAppServerEndpoint`, and
a `RemoteContext = { runtime: SshRuntime; remote: SshRemoteClient; projectsRoot }` is recorded.

`RemoteContext.runtime` (the `SshRuntime`) is consumed in **three** places, and every one assumes Codex:
1. **Workspace router** (`production-app.ts:2386-2402`) — `runtime.remoteHome`, `runtime.remoteRuntimeDir`,
   `runtime.remoteHelperPath` (via `SshHost`), to set up a project workspace on the remote host.
2. **Worker file bridge** (`:2403-2413`) — `runtime.remoteHelperPath`, `runtime.remoteRuntimeDir`, for
   attachment transfer.
3. **Ownership-scan router** (`RolloutAccessRouter.remote()`, `:2426-2430`) — `runtime.remoteHelperPath`, to run
   the `rollout-scan` helper op on the remote.

**Correction (design review):** the three consumers need the **remote *host* management** — bootstrap the
shipped `qiyan-ssh-helper.mjs`, expose `remoteHome`/`remoteRuntimeDir`/`remoteHelperPath`, and run helper ops
(workspace, file transfer, rollout-scan). The helper *ops* are provider-agnostic — BUT the host facts are **not
free of Codex today**: `SshRuntime.prepare()` gets `home`/`uid`/`shell` from the helper **`preflight`** op
(`ssh-runtime.ts:169-178`); `remoteHome = preflight.home` and `remoteRuntimeDir`/`remoteHelperPath` derive from
`preflight.uid` (`ssh-runtime.ts:126-129,171-174`). And the shipped `preflight` **hard-requires codex + tmux**
on the remote (`qiyan-ssh-helper.mjs:53,58` — throws unless all 7 tools resolve). So a Claude-only host (has
`claude`, may lack `codex`/`tmux`) would **fail bootstrap**.

So the coupling is deeper than "just starting the app-server": (a) `SshRuntime` bundles host management with the
Codex-app-server lifecycle (`ensureStarted` → helper `start`), AND (b) **host bootstrap itself is Codex-gated
via `preflight`**. The decoupling therefore has TWO parts: split `preflight` into a lean **host-preflight**
(returns `uid`/`home`/`shell`, requires neither `codex` nor `tmux`) plus a separate **Codex capability probe**
(the codex/tmux check, run only on the Codex `start` path); and separate the host-management surface from the
app-server lifecycle (§3.2).

## 3. Design

### 3.1 Catalog: discriminated `type`
`endpoints.json` entry becomes a discriminated union:
```
{ "type": "ssh",         "projects_root"?: "~/..." }               // Codex on that host (unchanged)
{ "type": "claude-code", "projects_root"?: "~/...", "model"?: "..." } // Claude Code on that host
```
`EndpointCatalog.require` returns `RemoteEndpointDefinition = SshEndpointDefinition | ClaudeEndpointDefinition`.
`CatalogReader.require` / `createRemote` signatures widen to the union (manager.ts). `sessionProvider` already
handles it. **Must land atomically with §3.3** — a `claude-code` entry with no createRemote branch would be
mis-built as Codex.

### 3.2 Decouple host-management from the Codex app-server (the core change)

**Design item 0 (from finding #1): split `preflight`.** Add a lean host-preflight (returns `uid`/`home`/`shell`,
requires NEITHER `codex` NOR `tmux`) in `qiyan-ssh-helper.mjs`, and move the codex/tmux capability check to a
separate op invoked only on the Codex `start` path. Both Codex and Claude host bootstrap use host-preflight; only
Codex additionally runs the capability probe. (This is the actual ship-blocker the original draft missed.)

**Shape (revised after review — a shared `RemoteHost` COMPOSED by `SshRuntime`, NOT a Codex-consumer rewrite).**
The reviewer's key point: rewriting the three consumers from `context.runtime.X` to `context.host.X` touches the
exact Codex ownership/workspace code behind the duplicate-delivery incident, for no functional gain. Instead:
```
interface RemoteHost {                 // provider-agnostic; built from host-preflight
  remoteHome: string;
  remoteRuntimeDir: string;
  remoteHelperPath: string;
  remote: SshRemoteClient;             // helper channel
}
```
- Introduce `RemoteHost` and have **`SshRuntime` compose one internally** — its existing
  `remoteHome`/`remoteRuntimeDir`/`remoteHelperPath` getters just delegate to `this.host.X`. This is a
  behavior-preserving internal refactor of the Codex path (single source of truth, no consumer signature change).
- The **Claude remote** builds a lean `RemoteHost` directly (host-preflight only, no `SshRuntime`, no
  app-server).
- `RemoteContext` becomes `{ host: RemoteHost; runtime?: SshRuntime; remote; projectsRoot; provider }`. The three
  consumers read `context.host.X` (Codex's `RemoteContext.host` is `runtime`'s composed host; Claude's is the
  lean one). This is the minimal touch: the consumers change `context.runtime.X → context.host.X` but the VALUES
  are identical for Codex (delegation), so the Codex semantics are unchanged — gate on the Codex remote suite
  (§5) to prove it.

Consumers after the change (all read `context.host`):
1. Workspace router → `context.host.remoteHome/remoteRuntimeDir` + `SshHost(id, context.remote, context.host.remoteHelperPath)`. Needed for Claude: the remote turn does `cd <cwd>` (`ssh-claude-command-runner.ts:24`), so the project dir must be provisioned; the `workspace` helper op is provider-agnostic (`qiyan-ssh-helper.mjs:385-415`). ✓
2. File bridge → `context.host.remoteHelperPath/remoteRuntimeDir`. Dormant but correct for Claude (attachments are text-only today). ✓
3. Ownership-scan router → `context.host.remoteHelperPath` + provider dispatch (§3.4).

### 3.3 `createRemote` claude-code branch
```
if (definition.type === "claude-code") {
  const generation = await planner.createGeneration(definition.id);          // ControlMaster plan
  const remote = new SshRemoteClient({ plan: generation.plan, helperSource });
  const host = await createRemoteHost(remote, generation.plan);              // bootstrap helper + dirs (no codex)
  const runner = new SshClaudeCommandRunner({ buildSshArgs: (cmd) => buildSshStreamArgs(generation.plan, cmd) });
  const endpoint = new ClaudeCodeRuntime({ id, runner, launchFlags: { disallowedTools, appendSystemPrompt, model }, goals: claudeGoals });
  remoteCandidateContexts.set(endpoint, { host, remote, projectsRoot: definition.projectsRoot, provider: "claude" });
  return { endpoint, pendingBinding: generation.pendingBinding };
}
```
`buildSshStreamArgs(plan, remoteCommand)` (helper to add to `ssh-config.ts`) = `[...baseArgs(plan, false),
plan.alias, remoteCommand]` — reuses the established ControlMaster; `remoteCommand` is a single pre-quoted shell
string (the runner quotes its own tokens via `shq`), so it bypasses `buildSshRemoteArgs`'s strict per-token
guard (which is for the restricted helper protocol, and would reject the prompt/flags). The
`SshClaudeCommandRunner` refactors from `{host}` to an injected `buildSshArgs(remoteCommand)`.

**Attestation (finding #4).** The helper path re-attests a user-owned master on every `invoke`
(`ssh-runtime.ts:264` → `attestUserControlMaster`), re-verifying socket owner/mode. The streaming turn reuses
the same socket. Decision: for `!plan.ownsControlMaster`, the runner **re-attests before each turn**
(`attestUserControlMaster(plan)`), matching the helper path — cheap and keeps the trust boundary symmetric on
the exact SSH layer behind the incident. (A QiYan-owned master is created + trusted by QiYan; no per-turn
re-attest needed.)

**Eager ControlMaster (finding #6).** `ClaudeCodeRuntime.start()` is a no-op (marks ready) and does NOT open the
ssh master. So `createRemote` must **establish/attest the ControlMaster eagerly** (it already runs
`planner.createGeneration` which attests a user master / plans an owned one; the first helper op — host-preflight
— establishes an owned master). The first turn then reuses an established, multiplexed master rather than opening
a fresh direct connection. Known limitation: a remote Claude endpoint has **no ControlMaster health/loss
detection** (unlike Codex's `SshRuntime.classifyLoss`); a dead master surfaces only as a turn failure (existing
B1 handling). Acceptable for the `claude -p` fire-and-resume model; documented, not hidden.

### 3.4 Ownership scan over ssh (the safety-critical piece)
Port the Claude transcript scanner into `qiyan-ssh-helper.mjs` as a new op `claude-rollout-scan`. It runs **on
the remote host** and returns only `RolloutScanResult` metadata (cursor, `starts[]`, `openTurn?`, `malformed?`)
— **never message bodies** (privacy parity with Codex).

**Critical (finding #3): the port is a faithful transliteration of `ClaudeTranscriptParser`
(`src/sessions/claude-transcript.ts`), NOT a fork of the helper's Codex `createRolloutParser`.** The two
parsers differ in ways that would silently diverge ownership if the Codex one is copied:
- **Open-turn cursor:** the Codex helper rewinds to the turn start when a turn has not seen its user message
  (`qiyan-ssh-helper.mjs:266`); the Claude scanner ALWAYS advances to `parsedEnd` (every Claude turn opens with
  a user message) and reports the open turn (`claude-transcript.ts:152-157`). Copy the Claude behavior.
- **Turn-end:** ends on ANY concrete `stop_reason` except `tool_use` (`claude-transcript.ts:209-213`) — broader
  than `end_turn` (match the code, not any stale comment), else `max_tokens`/`refusal` turns stay open forever.
- **Marker:** extract the `<!-- qiyan-cid:…-->` clientId from the `user` row's message CONTENT (Claude has no
  Codex `client_id` field); `hasUserMessage:true` always.
- **Owner uid check:** the remote helper SHOULD verify the transcript file's `state.uid` (as the Codex helper
  does, `qiyan-ssh-helper.mjs:182`) even though the local scanner omits it — defense on a shared remote host.
- Byte-offset cursor with the shared append/truncation/mtime detection; throw the shared literal
  `"rollout appended while scanning"` (`ROLLOUT_APPENDED_WHILE_SCANNING`) so the helper's existing retry harness
  (`qiyan-ssh-helper.mjs:163`) keys on it — ports cleanly.

`RolloutAccessRouter` (remove the `UNSUPPORTED` stub): for a remote **claude** endpoint, invoke
`claude-rollout-scan` (via `context.remote.invoke`) instead of `rollout-scan`. Dispatch by `provider(endpointId)`
(already injected). The scan filename validator on the remote uses `<session_id>.jsonl` (not Codex `rollout-*`).

### 3.5 Worker scheduling MCP over a remote worker (separable)
The Phase-2 worker scheduling tools reach a LOCAL loopback MCP. A **remote** Claude worker calling them needs the
`ssh -R` reverse tunnel + bind-not-relax auth (impl-plan §2.4). This is **out of scope** for this doc (a remote
Claude endpoint's *management* works without it; only the worker's self-scheduling needs it). Track separately.

## 4. Recovery / edge cases
- Recovery reconciliation runs the ownership scan over ssh on restart — same path, just remote. The phantom-gate
  and external-turn fencing behave identically (metadata is provider-neutral).
- Remote transcript pull-and-parse-locally is the rejected alternative (streams bodies over the wire, needs
  remote `stat` for the device/inode cursor identity) — the on-remote helper keeps bodies remote and reuses the
  cursor machinery, matching Codex.
- Missing `claude` on the remote host → spawn error → the runner reports the turn failed (existing B1 handling);
  the ownership `claude-rollout-scan` returns `missing` if there is no transcript yet.

## 5. Plan (each an independently-reviewed step)

**Ordering constraint (finding #5): §3.1 + §3.3 + §3.4 land ATOMICALLY.** A `claude-code` endpoint that is
buildable/leasable but whose ownership scan still throws `UNSUPPORTED_CAPABILITY`
(`rollout-access.ts:82-86`) is fail-closed but would wedge adoption/recovery. So the scan is not a later step.

0. **Preflight split** (§3.2 item 0) — lean host-preflight (no codex/tmux) + separate Codex capability probe.
   *Verify:* Codex remote host bootstrap unchanged (capability probe still enforced on the Codex `start` path);
   a host with no `codex`/`tmux` passes host-preflight.
1. **`RemoteHost` refactor** (§3.2) — introduce `RemoteHost`; `SshRuntime` composes one internally (getters
   delegate); consumers read `context.host`. *Verify (GATE):* the **full existing Codex remote test suite stays
   green** (this is a behavior-preserving refactor of the incident-sensitive path).
2. **Catalog + createRemote + ownership scan (atomic)** — §3.1 union; §3.3 claude-code branch +
   `buildSshStreamArgs` + attestation + runner refactor; §3.4 helper `claude-rollout-scan` + router routing
   (remove the `UNSUPPORTED` stub). *Verify:* catalog-union unit tests; a fake-runner composition test that a
   `claude-code` endpoint constructs and a session leases/starts a turn through the **full manager path** (not
   just the pool); a helper-scan unit test asserting **byte-identical `RolloutScanResult` vs
   `scanLocalClaudeTranscript`** over the committed fixtures, INCLUDING an open (interrupted) turn and a
   `max_tokens`-terminated turn; router routes remote-claude to `claude-rollout-scan`.
3. **End-to-end** — gated integration (`RUN_CLAUDE_REMOTE_INTEGRATION`): add a `claude-code` catalog entry for
   `dfw-vscode`, create/adopt a session, run a turn, and confirm the ownership scan classifies an owned turn
   (owned) and an externally-typed turn (external → unadopt). Build + restart + PR.

## 6. Risks
- **Safety-critical layer.** This touches SSH + ownership (the duplicate-delivery layer). The `RemoteHost`
  extraction has real blast radius on the Codex remote path — the Codex remote tests must stay green throughout.
- **Decoupling shape.** (A) vs (B) is the main review decision; (A) is cleaner but larger.
- **Helper port fidelity.** The remote `claude-rollout-scan` must byte-for-byte match `scanLocalClaudeTranscript`
  (same turn model, marker, cursor, sentinel) or ownership diverges local-vs-remote.

## 7. Open questions (mostly resolved by the design review)
- ~~(A) vs (B) decoupling shape~~ → **resolved:** shared `RemoteHost` composed by `SshRuntime` (§3.2), the
  minimal-blast-radius option; both original options needed the preflight split anyway.
- ~~Does a remote Claude session need workspace provisioning?~~ → **resolved: yes** — the remote turn does
  `cd <cwd>`, and the `workspace` helper op is provider-agnostic.
- Ship §3.5 (remote worker scheduling over `ssh -R`) with this, or strictly separate? → **separate** (a remote
  endpoint's management needs no reverse tunnel).
- Remaining: exact `preflight` split shape (one op with a `capabilities?` flag vs two ops) — decide in step 0.
