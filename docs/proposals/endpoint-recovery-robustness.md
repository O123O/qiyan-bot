# Fix plan: endpoints that stay down

Status: step 1 implemented, plus step 2a (`recover_endpoint`). Steps 2 and 3
remain proposals.

## What happens today

Remote endpoints drop about three times a day. That part is ordinary — SSH over a
cluster network — and the transport layer recovers from it unaided (measured:
prenyx dropped 02:56:57, recovered 03:01:21, nothing intervened).

The damage comes afterwards. A drop can leave a worker unusable **indefinitely**,
and the action that would repair it is refused. On 2026-08-22 that cost two
workers about two hours and needed manual lock surgery plus two bot restarts.

## The chain, as measured

1. A stale `thread-writer-lock` on the remote host makes `thread/resume` fail with
   `thread-store conflict: already has an active writer`.
2. `managedRecoveryDisposition` (`production-app.ts:1691`) returns `"permanent"` —
   its fallthrough for anything that is not `RpcRequestTimeoutError` or
   `ENDPOINT_UNAVAILABLE`.
3. `applyFailure` parks the session as `"safety"` (`:2030`). It is never retried;
   only a fresh endpoint-ready epoch or a process restart re-enters.
4. So `nativeSessions.view` never becomes ready for those threads.
5. So `requireManagedThreadsIdle` (`manager.ts:641`) cannot pass.
6. So **five** actions are refused, not two: `restart_endpoint` and
   `disconnect_endpoint` (`manager.ts:264,463`), `unadopt` and `archive`
   (`lifecycle.ts:228,329` via `requireCurrentNativeIdle`), and any `send`
   (`service.ts:589`). Nothing short of a process restart touches a parked
   session -- which is what the owner had to do, twice.
7. And `restart_endpoint` is the only action that clears the condition in (1).

The repair is gated on the health it exists to restore. Same signature appears in
the ledger for `polyphe` and `ptyche02`, so it is a class, not an incident.

Confirmed empirically today: after freeing the locks, the sessions still did not
recover, because step 3 had already parked them. Only a restart brought them back.

## Design properties behind it

- **Fail-permanent by default.** Two error shapes retry; everything else is
  terminal. Correctness depends on having anticipated each error.
- **Terminal states with no exit.** `"safety"`, `gaveUp`, and `recoveryPause` are
  all cleared only by something that cannot happen while they are set.
- **Repair gated on the symptom.** (5) and (6) above.
- **Reactive, not supervised.** Nothing asks "should this be up, and is it?"
- **Failures invisible.** A failed activation is swallowed in three places and
  logged in none.

## Options

| # | Change | Size | Robustness | Notes |
|---|---|---|---|---|
| A | Let `restart_endpoint` proceed when threads are **unprovable**, not only when provably idle | small, one predicate | breaks the deadlock at its narrowest point | must still refuse when threads are provably BUSY |
| B | Invert the retry default: retry with bounded backoff unless the error proves the session unrecoverable | small edit, wide blast radius | removes the permanent-by-default trap | risks hot loops against genuinely dead sessions |
| C | Add a supervisor reconciling desired vs actual endpoint state | large | strongest | new component, new failure modes |
| D | Persist desired state so intent survives restart | medium | fixes an inversion, not this outage | does not address the deadlock |

## Review findings (two independent reviews, converged)

They agreed the chain is real and disagreed on the fix. The disagreement is
settled by what was measured during the 2026-08-22 recovery.

**Corrections to the original analysis, both verified:**

- Step 6 understates it: **five** actions are refused, not two -- restart,
  disconnect, unadopt, archive (`lifecycle.ts:228,329`) and send
  (`service.ts:589`). Nothing short of a process restart touches a parked session.
- Step 4 is wrong. Views DO become ready at the new generation
  (`production-app.ts:4574-4578`); they carry `status: "unknown"`. The blocker is
  the status, not a missing view -- so "treat a missing view as not-a-blocker"
  would have fixed nothing.
- The guard refuses on five distinct conditions and reports two messages. Two
  further deadlocks follow from it, unrelated to any lock: one session stuck in
  `adopting` refuses every restart of its endpoint forever, and a
  currently-down endpoint can never be restarted because its views are
  invalidated and the generation never advances.

**The measurement that settles the fix.** Option A assumes replacing the
app-server clears the writer. On 2026-08-22 it did not:

1. killed every app-server process -> relaunched
2. conflicts continued; the fresh process could not acquire either lock
3. `flock -n` reported BUSY with no live local holder
4. moving the file aside (new inode) made it FREE
5. only then did the sessions recover

Codex sweeps locally-stale locks at startup (`remove_stale_thread_locks`), so a
lock a fresh process still cannot take is not locally stale -- it is held on the
NFS server for a client that is gone, or by a peer on another node. **Option A
would not have prevented this outage.** It remains worth doing for the other two
deadlocks, but it must not be sold as the fix for this one.

**Do NOT build stale-lock clearing.** The lock is a zero-byte `flock` with no
owner token, on a `$CODEX_HOME` shared across omniml-a1..a8. Codex already does
the only safe sweep. The residual cases are indistinguishable from a live writer
on another node, so clearing means risking two writers on one rollout -- trading
a two-hour outage for silent transcript corruption.

**On option B.** It is what the recovery evidence supports (freeing the locks did
not recover the sessions; only a restart did). But the retry engine has no cap and
no backoff -- `schedule` re-arms at 1s indefinitely (`production-app.ts:2169-2183`)
-- so inverting the default without a circuit breaker turns one wedged session
into permanent 1 Hz load on a remote host. Not now.

## Revised plan

| Order | Change | Why |
|---|---|---|
| 1 | **Say why a session parked.** *Done in this commit.* `onSafetyFailure` discarded the `error` argument and its event carried no endpoint, so a park rendered as `background_task_failed` on stderr. The reason now travels with the disposition, and the event names the endpoint, the reason, and how many sessions the failure parked. *Corrected during review:* a durable per-session notice already existed -- `warnSessionUnavailable` fires on exactly this condition, keyed per session per incident -- so step 1 added the missing reason to it rather than a second notice. | Zero behavioural risk, existing machinery, and it produces the per-cause data that settles everything below |
| 2 | **Narrow option A**, in one function (`requireManagedThreadsIdle`, `manager.ts:641-668`): refuse **only** when a thread is provably active at the current generation. Every other shape proceeds, and the result reports that idleness was not proven. | Fixes the `adopting`-session and down-endpoint deadlocks, which have no other repair. Does NOT fix the writer-lock case |
| 3 | **Deferred**: bounded retry (B), and only after `schedule` has a cap and backoff. | Right direction, wrong order |
| 2a | **`recover_endpoint`** *(done, shipped ahead of step 2)*. A manager tool that re-enters recovery without stopping the runtime. | Discovered while step 2 was still unbuilt: the guard was never the only problem. Only the destructive verbs were reachable, so every stuck session became "restart the service" — including for causes a restart cannot reach. This needs no idle proof because it stops nothing, so it is safe by construction rather than by narrowing a safety check. It does not replace step 2: a thread that cannot prove idle still wedges `restart_endpoint`/`disconnect_endpoint`. |

**Where the per-cause data actually comes from.** The stderr event is
deduplicated to one report per endpoint per episode, so a batch that parks
sessions for two different reasons reports `mixed` rather than either one. The
per-cause record is the durable per-session notice, which is keyed per session
and carries its own reason. Nothing is lost: `mixed` can only arise in the batch
path, where every permanent failure also produced a per-session notice. A
failure that takes down recovery as a whole derives one reason from one error,
so it never reports `mixed` -- which matters, because there no per-session
notice is issued and the event is the only record.

**What step 1 does not do.** A park is not as invisible as this plan first
assumed, and it is not permanent in practice: `markEndpointWaiting` rewrites a
`"safety"` park back to `"endpoint"` on the next disconnect, so an ordinary
automatic reconnect re-enters parked sessions. Step 1 therefore explains a park;
it does not claim one requires a restart, and it adds no notice that would need
retracting when a reconnect clears it.

**Known residual, stated plainly.** After 1 and 2, a stale cross-node writer lock
still requires manual intervention. Nothing in this plan fixes that safely; it is
a codex/NFS problem. What changes is that it becomes visible in minutes instead
of hours, and the unrelated deadlocks stop happening.

## Risk accepted by step 2

The idle proof is the only guard between a restart and a mid-flight turn: the
drain gate waits on work leases, and a lease covers only the `turn/start` RPC,
not the turn's execution (`pool.ts:200-227`). A deliberate restart never emits
`runtime-lost`, so `RuntimeRestartRecovery` never arms and a killed turn gets no
resume message (`production-app.ts:5581`). Proceeding on an unprovable thread can
therefore lose a running turn's output.

This is accepted because restart and disconnect have **no automatic callers** --
they exist only as explicitly requested operator actions -- and because the
alternative is an endpoint that cannot be repaired at all. Step 2 must report
that idleness was unproven, following the precedent set by #45.
