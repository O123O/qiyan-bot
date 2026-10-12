# A forced restart that always works

## The contract

A lifecycle operation reports **success**, or **failure with a reason**. There is no third outcome.

A forced restart ends in one of exactly two states:

- the endpoint is running a fresh runtime, or
- it is not, and the result says why, in the words of whatever actually failed.

It never refuses, never asks the caller to prove anything, never hangs, and never reports that it
does not know what happened.

"Fresh runtime" means the endpoint's own runtime. Re-attaching managed sessions afterwards is a
separate concern and cannot change this verdict.

Mechanically: the **tool handler** catches a `resumeManagedEndpoint` failure, records
`sessions_restored: false` with its reason in the receipt, and still returns success. The recovery
branch's own acknowledgement requirement is left alone — it gates `succeedRecovered` and removing it
there would break recovery to fix reporting.

## Why the current design cannot honour that

The first draft of this document blamed identity-addressed shutdown. That is one cause of three, and
it is not the one the owner hit most. The refusals and non-answers are spread across four layers:

**The tool layer turns almost every failure into uncertainty and discards the reason.**
`assistant/tools.ts:220` reports `OPERATION_UNCERTAIN` whenever an operation is side-effecting and
not *proven* no-effect, and `isProvenNoEffect` (`tools.ts:270-297`) proves that for a lifecycle verb
only when the receipt is absent entirely. The manager checkpoints `draining` as its first act
(`manager.ts:482`), so from that instant every failure is uncertain. `restart_endpoint` is not in
`WAIT_FOR_DURABLE_RECOVERY_TOOLS` (`tools.ts:132`), so `definiteOperationFailure` never runs and the
underlying `operation.error.message` never reaches the caller. A forced restart that destroys the old
runtime cleanly and then fails to start a new one — a plain failure with a plain reason — is reported
as *"restart_endpoint may already have taken effect; wait for durable reconciliation before
retrying"*. That is the Ptyche report, and nothing below this layer can fix it.

**A fully successful restart can still be reported as uncertain.** The handler calls
`resumeManagedEndpoint(endpointId, true)` after the restart returns (`production-app.ts:4441-4448`),
which raises `managed sessions were not restored` when a session fails to reconcile. The receipt by
then holds `runtime_started`, so the tool layer converts that into uncertainty — the endpoint is up
and healthy, and the owner is told the outcome is unknown.

**It can hang, which is worse than refusing.** `restartInternal` awaits
`EndpointAdmissionGate.beginDrain()` (`manager.ts:479`), which resolves only when every live lease
has drained (`admission-gate.ts:50-57`). There is no timeout and no force path. A `send_to_session`
holding a lease on a dead SSH channel parks the restart forever, and because `enqueueLifecycle`
serializes on `record.lifecycle` (`manager.ts:812-826`), every later restart queues behind it and
also never returns. This is the likeliest shape of "the manager connection then failed during the
Polyphe restart".

**The ledger fence refuses before the manager is reached.** `settleEndpointLifecycleOrder`
(`production-app.ts:4435`) runs first and has no `force` parameter. It refuses when an earlier row is
not `uncertain` (`:958`), when `waitForTerminal` times out (`:1012-1031`), when the endpoint awaits
authentication (`:969`), or when a non-subsumed lifecycle row exists (`:1000`). With two instances
sharing this NFS home — which happens here — a row owned by the other instance refuses the restart
outright. Worse, `:1029-1031` can return `satisfied`, and the handler then reports
`{ state: "ready" }` **having restarted nothing**.

And the shutdown path is identity-addressed, which is the original diagnosis and still true: asking
"is this the exact runtime I was told about?" has no answer when the identity file is gone, the
generation moved, or the channel died before the close was acknowledged — so it says
`OPERATION_UNCERTAIN`.

## The design

Force is a **postcondition**, not a flag that lifts individual checks: *after this call, either this
endpoint is running a runtime that did not exist before, or the result says why not.* Every
mechanism below follows from that.

### 1. Destroy by location, not by identity

A forced shutdown destroys whatever occupies the endpoint's runtime directory and tmux session.

For an **ssh Codex app-server** (`assets/remote/qiyan-ssh-helper.mjs`, `stop`), gaining `force?: true`
and making `expected` optional:

1. `tmux kill-session` on the runtime's socket and session name. Failure means it was already gone.
2. Read `identity.json` **for its token and pgid only**, no `sameIdentity` comparison. Signal that
   process group, filtered to members still carrying the token.
3. Remove `app-server.sock`, `identity.json`, `app-server.token`.

For an **ssh Claude host** (`stopClaudeHost`), the same shape against its own names:
`qiyan-claude-<hash>` session, `claude-host-identity.json`, `claude.sock`.

For a **daemonless endpoint** (local Claude, `manager.ts:835,855`) there is no tmux session and no
runtime directory, so there is nothing to destroy. Force instead **abandons** the connection rather
than waiting for `requireClosed`'s 15-second close (`manager.ts:589-596`): the generation is
incremented and the old connection discarded, which is what "destroyed" means for a runtime that is
only a connection.

**Ordering is load-bearing and must not be rearranged.** Files are removed *last*, because `inspect`
derives group membership from `identity.json` (`:162-163`) — removing it first would make survivors
unsignallable — and because their absence is what makes the following `start` see `absent` rather
than `unhealthy` (`:168-171`). "Then start, exactly as a cold start does" only works because of this.

The **runtime-token gate stays** under force. It is not a proof about our own work; it is what stops
a recycled pid group taking a stranger's processes with it. `processHasToken` reads
`/proc/<pid>/environ`, which is unreadable across uids, so a foreign process can never pass it and a
recycled pgid yields zero signallable members. Force is permission to destroy *this endpoint's*
runtime, not permission to signal anyone else.

### 2. Report what was destroyed, and what refused to die

Three facts go in the result and reach the caller:

- `destroyedIdentity`: the identity read before destruction, or `null` when there was none. A force
  that killed something must say what.
- `survivors`: count of token-carrying members that outlived SIGKILL. When `identity.json` was
  absent, this is **not** `0` — it is `"unknown: no identity to signal from"`, because a detached
  app-server outside the pane's process group survives `kill-session` unaccounted for, and a zero
  there reads as "clean" when it means "did not look".
- `interruptedTurns`: the managed turns that were running when force destroyed the runtime. Force's
  whole justification is that the operator spends an in-flight turn deliberately; he is owed the list
  of what he spent.
- `serverSurvived`: true when the recorded server process itself is still alive and token-carrying.
  Today that raises `runtime process group did not stop` (`:524`). Under force it must not raise —
  the socket is unlinked and the replacement gets a new pid, pgid, token and port — but it is loud
  enough to deserve its own field rather than being folded into a count.

### 3. Force pre-empts live leases, and the queue in front of them

Two separate things, and fixing only the second leaves the owner exactly where he is.

**Before enqueueing**, `restart(id, …, force)` discards the gate's live leases: it clears `live` and
calls `resolveDrainIfReady()`. This is what unwedges an endpoint whose *predecessor* is already
parked inside the unbounded `beginDrain` — that predecessor's drain promise resolves, it completes or
fails, `enqueueLifecycle`'s chain drains, and the forced call then runs. Doing this inside
`restartInternal` would be too late: the forced call would be queued behind the hang it is meant to
clear. Deadlock-free, and it needs no cancellation machinery.

A discarded lease can no longer be used for further work, and `validate()` makes its eventual
`release()` a safe no-op. It does **not** cancel work already in flight, and that is worth stating
precisely rather than claiming more: `withWorkLease` validates once before running and never again,
so an RPC that returns after the destroy will still return. Its result is not waited for and not
relied upon; some call sites re-check the generation afterwards and most do not. This is no better
and no worse than a lost connection, which is the honest comparison.

**Turn-capacity claims do need explicit release.** They are not held by the gate; the pool releases
them from the endpoint's own `onUnavailable` subscription. A forced destroy can leave an endpoint
that never announces its own death — and `startTurnAdmitted` deliberately *retains* a claim on
`OPERATION_UNCERTAIN`, which a destroy mid-`turn/start` produces. If the replacement then publishes,
both the pool's and the manager's subscriptions to the old endpoint are removed and a late event is
dropped, stranding the claim for the life of the process: inflated `activeTurnCount`, and conflicts
for any caller reusing the claim id. So the forced path **marks the old endpoint unavailable in the
pool explicitly**, before publishing the replacement, rather than relying on a dead connection to
report itself. For a daemonless endpoint, where there is no helper call at all, this and the
generation bump are the *only* observable effects.

### 4. Force passes through the ledger fence

`settleEndpointLifecycleOrder` takes `force`. Under it:

- every earlier **lifecycle** row is proceeded past without waiting, whatever its state and whoever
  owns it — but "proceed past" means *do not wait*, not *retire*. Only `uncertain` rows are retired,
  exactly as today. A peer's `dispatched` row is left alone: the peer is still going to settle it,
  retiring it would race that and record a completed operation as superseded, and it costs nothing to
  leave, since the next forced action proceeds past it too.

  The justification is the operator's decision, not subsumption. Subsumption holds when the peer is
  mid-destroy or stalled; it does not hold when the peer has not reached its destroy yet, because it
  will then destroy our fresh runtime seconds after we report success. Proceeding is still right —
  refusing is how the endpoint got wedged — but it is right because force is an instruction about
  this endpoint, not because the earlier rows are provably moot.
- the `satisfied` short-circuit is **disabled**. A forced restart that returns without restarting is
  a lie, and the owner asked for this operation precisely when the system's own bookkeeping is the
  thing he does not trust.

### 5. The ledger records that the destroy happened

A new checkpoint phase, `destroyed`, is written between the kill and the start, and the receipt
carries `forced: true`.

**This cannot ship without a compatibility rule, or it recreates the wedge it exists to remove.**
`parseEndpointLifecycleCheckpoint` has a strict key allowlist (`endpoint`, `phase`, `identity`) and a
strict phase set (`draining`, `idle_proven`, `runtime_stopped`, `runtime_started`). A receipt
carrying `forced: true`, or a phase of `destroyed`, parses as `undefined`, and the recovery branch
then *silently skips the row* — leaving it unresolved forever and fencing every later lifecycle
action on that endpoint. That is bit-for-bit the failure this document exists to end.

So: extend both sets, and make the parse **tolerant of unknown keys** from here on rather than
re-pinning it to a new fixed list.

And state the cross-version rule, because two instances share this ledger and deploys here are not
atomic: a row written by a new build and reconciled by an old one hits the old allowlist and strands.
The rollout is therefore ordered, and only two releases can enforce it — a feature flag on shared
NFS state cannot give you the ordering. Release N ships the tolerant parse and the extended sets and
writes nothing new. Release N+1 writes `destroyed` and `forced`. Until N is everywhere, the new
fields are not written.

This is what makes "no uncertain status" true rather than relocated. If the channel dies between
destroy and start, the last checkpoint today is `runtime_stopped` — indistinguishable from an
unforced stop that may or may not have completed, so recovery re-enters `recoverRestart` and its two
`OPERATION_UNCERTAIN` throws. With `destroyed` on the row, recovery of a forced restart is a plain
idempotent start: the old runtime is provably gone, so there is nothing left to be uncertain about.

### 6. Force survives recovery

`production-app.ts:5381-5386` currently retries a failed restart **unforced**, even though `force` is
on the row — so it refuses again on the same unprovable idle and the row stays unresolved, fencing
the next restart. `recoverRestart` gains the parameter and the recovery branch passes `args.force`.

### 7. The tool layer reports success or a reason

- `isProvenNoEffect` learns the `destroyed`/`forced` receipt: a forced lifecycle row that failed
  after its destroy is a **definite failure**, not an uncertainty.
  That is sufficient on its own: when no-effect is proven the tool fails the row and **rethrows the
  original error**, so the launcher's own message and code reach the caller unchanged. These verbs
  are deliberately *not* added to `WAIT_FOR_DURABLE_RECOVERY_TOOLS` — that set is keyed by tool name,
  so it cannot be scoped to forced rows, and it would make an unforced restart block the assistant's
  turn for the whole retry ramp of an unreachable host. Unforced behaviour stays unchanged.
- A failure notice is prepared alongside the existing success notice (`production-app.ts:4447`), so
  the reason lands in chat history rather than only in `operations.error_json`.
**Out of scope, explicitly: the assistant endpoint.** Its branch does not restart anything — it
schedules a post-turn action and succeeds at scheduling time, on an identity-pinned payload that the
recovery matcher re-parses to prove the row, and whose eventual outcome never reaches the owner at
all (it lands in `assistant_post_turn_actions.error_json` and surfaces only as a warn-level
`background_task_failed`). Making it forced needs a payload and matcher redesign, and `schedule()`
rejects a changed canonical payload for an existing id, so it is a compatibility surface too. Naming
it here and leaving it unbuilt is better than half-specifying it.

### 8. What force must still fail on

The framing is "a postcondition, not a set of lifted checks", and this list is what makes that
falsifiable. Under force, each of these is a plain failure with a reason:

- **Runtime-directory attestation** — `requireRuntimeDir`, `attestPrivateDirectory` (uid, mode,
  symlink, realpath, non-NFS), `attestFallbackRoot`. An unsafe or foreign directory is never
  bulldozed.
- **Transport and asset integrity** — `attestUserControlMaster`, `validateInstalledHelperPath`, the
  helper and launcher digest pins.
- **The runtime-token gate**, as above.
- **`requireReadyCandidate` before publish.** "I destroyed the old runtime and started something that
  never became ready" is a failure with a reason, not a success. Force never publishes a non-ready
  endpoint.
- **`this.closing`.** During shutdown, force still refuses.
- **The attempt and tool fences.** A forced restart dispatched by a terminalized attempt is exactly
  the hazard those exist for; they stay fail-closed.
- **`sameIdentity` when opening a proxy stream.** Force is about teardown. The stream-open identity
  proof is a different boundary and a shared `force` flag on the request shape must not weaken it.

## What this costs, stated plainly

**Two instances sharing this NFS home can destroy each other's work.** Identity matching is what
refuses that today: instance A's stop fails `runtime identity cannot be proven` when instance B has
published a newer generation. Under location addressing, A destroys B's healthy runtime mid-turn and
reports success — and the token gate does not help, because the token comes from B's own
`identity.json`, so every member passes it.

This is the price of the contract, and it is the right trade for an explicit force: the operator is
asking for this endpoint's runtime to be gone. `destroyedIdentity` in the result is what makes it
visible rather than silent. It is also an argument for single-instance enforcement, which this
deployment lacks and which is separate work.

**Unforced restarts keep every guard.** The idle proof, identity matching, the fence, the polite
close. The difference is that `force` now means what it says instead of lifting two checks out of
twelve.

## What remains uncertain, and why that is honest

Momentary uncertainty cannot be designed away: a channel that dies between a request and its
acknowledgement leaves this side unable to say what happened. What this design removes is
uncertainty as a **resting state** on the forced path — every forced outcome is observed on this side
after the destroy, so the effect is known even when the goal was not reached.

Unforced operations still resolve uncertainty through the ledger, unchanged.

## Test plan

The contract is observable at `restart_endpoint`, so that is where most of these live.

- a forced restart whose start fails reports the launcher's own reason, and the row ends `failed`,
  not `uncertain`
- a forced restart that succeeds but whose session recovery fails still reports success
- a forced restart completes while a live lease is held on a dead channel, and a second forced
  restart does not queue behind it
- a forced restart proceeds past an earlier `dispatched` row owned by another instance, and never
  takes the `satisfied` short-circuit
- `force` survives the recovery path: a forced row retried after a crash is still forced
- forced restart over a missing identity, a mismatched identity, a busy worker, an unhealthy runtime,
  and an already-dead session each succeed
- a process group carrying a foreign token is never signalled, even under force
- `destroyedIdentity` is reported; `survivors` reads unknown when there was no identity;
  `serverSurvived` is reported and does not raise
- the same, for a remote Claude host and for a daemonless endpoint
- a forced restart arriving while an earlier lifecycle action is already parked in its drain runs,
  rather than queueing behind it forever
- a row carrying the new receipt fields is parsed, not silently skipped, by the recovery branch
- turn-capacity claims are released when force destroys a runtime mid-`turn/start`
- an unforced restart still refuses a busy worker, an unproven idle, and a changed identity
