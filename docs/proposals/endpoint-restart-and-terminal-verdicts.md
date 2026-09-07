# Fix plan: a restart that finishes, and a backend with no "maybe"

Status: proposal. No code changed yet.

Two requirements, stated by the owner on 2026-09-07:

1. **The backend must not have a "maybe" thing.** Every operation ends as worked, or
   did not work with a reason.
2. **A restart must kill the old things — including the tmux session — and start fresh.**

Both describe the same production failure. `polyphe` cannot be restarted, and `ptyche02`
has been unresolvable for four days. This is what is actually wrong, measured rather than
inferred.

## What happens today

`polyphe`, observed directly on the host:

- an orphaned QiYan tmux session, alive **4 days**
  (`tmux -S /run/user/2001066568/qiyan-bot/17ce18ce.../tmux.sock … -s qiyan-17ce18ce…`)
- **no `app-server.sock`** in that runtime directory, though the directory survives
- 6 codex processes running an OMX worker team out of the `qwq-32b` project, 11h34m old,
  **not** descendants of the dead app-server
- the processes QiYan reported as "orphaned Codex/OMX children" belong to **other users**
  (`junsongc`, `bowenw`); its `pgrep` was not filtered by user

The ledger:

```
restart_endpoint    polyphe   proto=1  receipt=NONE  age=0h   "existing SSH runtime is unhealthy: polyphe"
disconnect_endpoint ptyche02  proto=1  receipt=NONE  age=97h  "SSH process failed (exit 255)"
```

and later rows carrying `"superseded by a later restart_endpoint on endpoint polyphe"`.
**Corrected in review:** that message is written onto *earlier* rows by
`settleEarlierEndpointOperations` as it retires them (`production-app.ts:958-963`) — it is
evidence the fence **lifted**, not that it blocked. This doc originally read it the other way.

## The chain, as measured

Five independent defects. Each is separately fixable; together they form a loop with no exit.

| # | Defect | Location | Effect |
|---|---|---|---|
| 1 | ~~Teardown never kills the tmux supervisor~~ **WRONG — withdrawn** | — | see below |
| 2 | `supervised !== false` ⇒ refuse to reclaim, even with no socket and a dead identity | `ssh-runtime.ts:251` | restart declines to remove the blocker |
| 3 | The failure happens *before* dispatch, so no checkpoint is written | `ssh-runtime.ts:252` throws | `receipt=NONE` |
| 4 | `isProvenNoEffect` consults a receipt for `create_session` only; lifecycle phases are never consulted | `assistant/tools.ts:260-266` | a provable no-effect becomes `uncertain` |
| 5 | The give-up counter is deleted **at the top of every pass**, before the attempt | `production-app.ts:5146` | `failures` is always 1; `>= 5` is unreachable in any process |

**Defect 1 is withdrawn.** `stop()` already kills the tmux session — `kill-session` at
`qiyan-ssh-helper.mjs` `stop()+39`, unconditional once the guards pass. The supervisor teardown
this plan proposed to *add* exists. Requirement (2) is already implemented and merely gated off.
The orphan survives because `stop` is never called: `ssh-runtime.ts:251` throws first.

**Defect 5 is worse than first stated.** The counter is not reset by bot restarts; `:5146`
deletes it at the top of every attempted pass, before the `try`. So the increment at `:5651`
always computes `1`, and `lifecycleRecoveryExhausted` can never fire — in any process, of any
lifetime. Persisting the counter *without moving that reset changes nothing*: durability is the
smaller half of step 1.

Defect 5 is why four days passed without a verdict. With the reset moved to the success path,
the *existing* in-memory counter would have retired `ptyche02` in about 2.5 minutes —
reconciliation backoff caps at 30s (`production-app.ts:1317`).

Defect 4 matters because the proof already exists and is discarded. Lifecycle operations
checkpoint their phase — `draining` → `idle_proven` → `runtime_stopped` → `runtime_started`
(`endpoints/manager.ts:265,268`) — and `parseEndpointLifecycleCheckpoint`
(`production-app.ts:2330`) can read it. A receipt **absent** proves the runtime was never
stopped. (A phase earlier than `runtime_stopped` does *not* — `idle_proven` is written before a
non-atomic stop, `manager.ts:265-266` and `:462-471`; see open question 1.) Reconciliation
instead **re-runs the whole restart** when the receipt is absent (`production-app.ts:5190-5194`),
so it retries something that cannot succeed while defect 2 stands.

**The two incidents are independent, and the fence is not implicated in either.**
`"superseded by a later restart_endpoint"` is written onto *earlier* rows by
`settleEarlierEndpointOperations` as it retires them (`production-app.ts:958-963`) — evidence
the fence **lifted**, not that it blocked. polyphe's row is `age=0h`: a fresh, unfenced attempt
that ran and failed on its own at `ssh-runtime.ts:252`.

So: **step 1 fixes `ptyche02`** (host unreachable, nothing to reclaim, needs a verdict).
**Step 2 fixes `polyphe`** (host reachable, reclaim refused). Step 1 does *not* unblock polyphe,
and this plan previously claimed it did.

## Decisions taken

Both settled by the owner. The *mechanisms* below were revised twice in review; the decisions
themselves are unchanged.

**Reclaim rule — reclaim if provably ours and not serving.** The original spec
("session alive + socket absent + name matches") is **withdrawn**: review showed it kills a
booting runtime. See the revised proof under step 2.

**Terminal verdict — durable attempt count, then fail with reason.**

```
attempt 1..N   -> retry, count persisted on the operation row
attempt N+1    -> failed: "could not settle after N attempts; last error: <transport error>"
```

## Live probe of `polyphe` (2026-09-07)

Run because review identified it as the question that decides step 2's scope.

```
/run/user/2001066568/qiyan-bot/17ce18ce576efe938ee0bb6c/
  identity.json   present  {"kind":"ssh","pid":3594781,"processGroupId":3594781,...}
  tmux.sock       present  (session alive, 4 days)
  app-server.sock ABSENT
  pid 3594781     DEAD
```

`stop()` completes on this shape. The derivation is **not** "the recorded pid is dead ⇒
`survivors === 0`" — `survivors` counts token-carrying members of the process *group*, not the
recorded pid. It short-circuits two levels earlier: `members = ownedGroupMembers(identity)`
(`helper:227`) is empty, so the guard at `:228` is false and `:236`, `:247`, `:250` are never
evaluated; control reaches `kill-session` at `:254`.

**The correct statement of the precondition is "the process group holds no token-carrying
member"**, which in the debris case (`survivors > 0`) diverges from "the pid is dead" — and
that divergence is exactly the case the `:250` throw covers.

Two facts make this reliable: the launcher exports `QIYAN_RUNTIME_TOKEN` before `exec`ing
codex, so a live app-server or child is always a token-carrying member of the recorded pgid;
and the six foreign codex processes on that host cannot be owned members even under pgid
recycling, because `processHasToken` (`helper:851`) reads `/proc/<pid>/environ`, gets EACCES
for another user, and returns false.

**After a successful reclaim there is no loop.** `stop` kills the session and removes
`app-server.sock` and `identity.json` (`helper:255-256`), so the next `inspect` sees
`supervised:false`, no identity (hence `group = []`, `groupAlive` false, `helper:157-159`) and
no socket ⇒ `status:"absent"` (`:166`) ⇒ `start` proceeds past its `unhealthy` refusal.

## Plan

| Order | Change | Why |
|---|---|---|
| 1a | **Make the give-up reachable.** Move the counter reset off `production-app.ts:5146`. Reset only when the row reaches a terminal state (leaves `listRecoverable`), never on "the pass did not throw". | One line, no migration, makes an already-reviewed give-up path work. Clears `ptyche02` within minutes of deploy. Ships independently. |
| 1b | **Make the budget durable.** Persist the count in a new `operations` column, atomic `SET attempts = attempts + 1`. | The budget then means the same across the two bot instances that share one ledger. |
| 1c | **Give the silent-return rows a verdict.** Paths that return cleanly *without settling* (`:5174`, `:5176`, `:5191`, and the same shape at `:5245`, `:5348`, `:5411`, `:5613`) never throw, so they never increment and never settle. | Requirement (1) is not met without this: an unparseable receipt at `:5174` fences its endpoint permanently and is invisible to 1a, 1b and 3. |
| 2 | **Reclaim an unserving supervisor.** Relax `ssh-runtime.ts:251`, gated on the revised proof below. | Fixes `polyphe`. `stop` already does the teardown. |
| 3 | **Retire on an absent receipt** *(open)*. | Would make the budget rarely needed. |

Ordering is 1 → 2 for safety, not because 1 unblocks 2.

### Ownership proof for step 2

Review rejected two successive versions of this. Recorded so the third is not re-derived.

**Why the endpoint hash proves nothing about ownership.** It is
`sha256(endpointId).slice(0,24)` (`ssh-runtime.ts:173`), identical for every bot instance
reading the same config. Path and session name prove *"some QiYan, for this endpoint id"*.

**Why "socket absent" is the wrong test — the correction that matters.** A crashed app-server
normally leaves its socket *file* behind: a unix socket is not unlinked when its listener dies.
So socket-absent is neither **necessary** (the ordinary dead-runtime shape has a *stale* socket
and would be refused, leaving the endpoint wedged) nor **sufficient** (a healthy boot has no
socket yet, because `start()` unlinks it *before* `tmux new-session` and codex binds it only at
the end). `polyphe` is the unusual variant, not the general case.

**Revised proof.** Reclaim only when:

1. the recorded identity's process is **dead** — `identityMatches(identity)` false, or the pid
   carries no token; and
2. the tmux session is older than a threshold, from `tmux list-sessions -F '#{session_created}'`

(1) is the whole load-bearing test: it distinguishes a dead runtime from one that is booting.
(2) bounds the window *before* `identity.json` exists at all, and the cross-instance TOCTOU
against a concurrent `start()`. The runtime *directory* mtime is useless — it survives forever.

An optional, decisive not-serving test: `connect()` to the socket and treat `ECONNREFUSED` as
proof nothing is listening. Unlike `stat`, it cannot be fooled by a stale inode. Reclaim path
only.

Dropping the socket-path proof also dissolves the legacy-tmux blocker: legacy mode
(`-L qiyan-bot`, a *shared* server) broke only that proof.

**This needs a helper change, and that is the remaining blocker.** `inspect`'s supervised
branch returns an identical payload — `{status:"unhealthy", supervised:true, identity,
ownedGroup, groupSize}` — for two mutually exclusive cases: identity present with
`identityMatches` **false** (dead, reclaimable, `helper:168`) and identity present with
`identityMatches` **true** (alive, socket absent or mis-permissioned, `helper:170`). The second
is a booting runtime. So `current.identity !== undefined` does **not** express proof (1) — it is
satisfied by the very case proof (1) exists to exclude.

`inspect` must return `serverAlive: identityMatches(identity)`, socket state, and session age.
`inspectSchema` is `.strict()` (`ssh-runtime.ts:53-57`), so the schema changes in the same
commit. There is no distribution cost — see refuted question 4 — and the stream entry points
(`openAppServerStream`, `invokeTransfer`) use the installed file but are untouched by adding
fields to `inspect`'s JSON.

**Without the helper change**, the only available gate is `current.survivors === 0` (already
plumbed at `ssh-runtime.ts:368`) — a sound proxy for (1), since a live app-server is always a
token-carrying member, but it yields nothing for the boot race or the TOCTOU. That is enough to
fix `polyphe` and not enough to generalise. **Those are two different claims and this plan must
not merge them.**

## Risks, and what bounds them

**Killing a booting runtime.** The failure that matters. Bounded by (2) and (3) above; the
socket-absent test alone does *not* bound it, because that is what a healthy boot looks like.

**Failing an operation that took effect.** Step 1 fails a row after N attempts. If the runtime
was stopped and only the reply was lost, the row records "did not settle" for something that
did. It ends `failed` with the transport error as the reason — never `succeeded` — and
`settleEarlierEndpointOperations` treats only `succeeded` as satisfied
(`production-app.ts:987-990`), so a later restart still runs.

**Detached work.** The 6 OMX processes on `polyphe` are not descendants of the app-server and
survive a runtime restart — so the reclaim is safer than it sounds, but it also does not clean
them up.

**Scope not yet decided.** `ssh-claude-host.ts:203` has the identical refusal for the remote
Claude host, and `tmuxArgs` returns a **shared** `-L qiyan-bot` server in `legacy` mode
(helper `tmuxArgs`), where the socket path is not endpoint-derived at all. Step 2 must either
cover both or refuse explicitly in legacy mode.

## Open questions for review

1. **Should step 3 exist, or replace step 1?** Restricted by review to *absent receipt only* —
   note this overlaps step 1c: an unparseable receipt is not an absent one, so step 3 does not
   reach the `:5174` rows either. —
   `idle_proven` is checkpointed **before** a non-atomic stop (`manager.ts:265-266`), so that
   phase can sit on a row whose runtime did go down. Even an absent receipt proves "the runtime
   was not stopped", not "nothing happened": `shutdownTarget` may start an endpoint for proof.
2. **What is N?** With the reset fixed and backoff capped at 30s, N=5 is ~2.5 minutes. Per-row
   across both instances, not per process.
3. ~~Does step 2 need an `inspect` discriminator?~~ **Answered: yes.** The earlier answer
   ("the probe says it is") was a category error — the probe established *polyphe's state*, not
   *`inspect`'s expressiveness*, and the proof must hold on every endpoint. `inspect` returns an
   identical payload for a dead runtime and a booting one.
4. ~~Can a stuck endpoint pick up a helper fix?~~ **Refuted.** `executeHelper` ships the locally
   bundled helper inline on every call; `bootstrap` rewrites the installed copy before any
   inspect/stop/start. `REMOTE_HELPER_SHA256` pins the local bundle, not a remote version gate.

## What this does not fix

A stale writer lock on a remote host still requires manual intervention; that is tracked in
`endpoint-recovery-robustness.md` and is unrelated to the supervisor. Nor does anything here
address the orphaned enroot mounts from `dynamic-nvfp4`, which are a worker-side cleanup
problem.
