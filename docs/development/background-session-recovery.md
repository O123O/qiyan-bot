# Background session recovery (startup must not wait for recovery)

## Problem

Startup blocked on `resumeStartupManagedSessions` — re-verifying each managed session against the
app-server (`thread/resume`+`thread/read`, workspace validation, ownership re-scan). Measured 9.4s in
a fast run and **minutes** when the cluster/ssh is slow, so startup was 6–10 min and wildly variable.
The web UI (last phase) and everything after it waited behind it.

## Key fact: recovery state is durable

`RuntimeStore` and ownership are SQLite-backed. Across a restart these persist: `management_state`,
`delivery_cursor`, `native_status`, `managed_epochs` (epoch + `baseline_turn_id`),
`session_rollout_ownership`. So recovery is **not** rebuilding lost state — it re-verifies durable
state against the live app-server and re-scans the rollout for an external turn that ran while the bot
was down. There is no correctness reason it must block startup.

## Design — synchronous gate-close, background recovery

In `resumeStartupManagedSessions` (production-app.ts):

1. **Synchronous flip (the keystone):** set every managed session on an automatic, non-lifecycle-owned
   endpoint to `management_state = "unavailable"` (DB-only, ~ms). This is what makes backgrounding
   safe — the invariant "a session is re-verified before QiYan drives/delivers to it" is preserved by
   the `unavailable` state, which every downstream gate treats as hands-off:
   - dispatch: `SessionService.managed()` throws `SESSION_DETACHED` on non-`managed` (service.ts).
   - delivery: `EventRelay.isDeliverableState` accepts only `managed`/`unadopting` (relay.ts) → zero
     deliveries for an `unavailable` session; external turns re-checked at delivery time.
   - ownership watcher: enumerates only `managed`/`unadopting` (production-app.ts) → excluded.
   - scheduler: a drive → `SESSION_DETACHED` ∈ `PROVEN_NOT_DISPATCHED` → outbox key released, re-armed
     → the drive **retries** after recovery (no loss, no double).

   Leaving sessions `managed` while recovery is backgrounded would let delivery/ownership act on a
   **stale** ownership cursor before the external-turn re-scan — the duplicate-delivery class. So the
   flip MUST stay synchronous, before the function returns.

2. **Background per-endpoint recovery:** `runBackground(() => resumeManagedEndpoint(id), onError)` per
   endpoint (local AND remote — local recovery measured ~4.5s here, not sub-second, and the directive
   is "don't wait for recovery"). Each session stays `unavailable` (hands-off) until its endpoint's
   background recovery re-opens it. Failures are reported (`background_task_failed`) and retried by the
   existing `managedRecoveryOwner`; a later endpoint-ready event re-arms the buffer normally.

3. **Acknowledge up-front:** `endpointReadyBuffer?.acknowledge(id)` right after spawning each task, so
   the synchronous `acceptAndDrain()` later in the phase doesn't kick a second, concurrent
   `recoverProjectEndpoint` for the same endpoint.

4. **Claims loop skips backgrounded endpoints:** the function returns the backgrounded set; the
   `reconcileEndpointClaims` loop `continue`s on it, so the sync loop can't race/redo the per-endpoint
   reconcile the background task owns, nor block on a still-recovering endpoint. Operation-only
   `recoveredEndpointIds` (no managed session) are not in the set → still reconciled synchronously.

## Result

Startup ~6–10 min (variable to minutes) → **consistent ~5–10s**; `resumeStartupManagedSessions`
9.4s → ~ms. Sessions come back `managed` asynchronously (verified live: `lifecycleState:"managed"`).
A send to an as-yet-unrecovered session gets `SESSION_DETACHED` (natural error, converges); scheduled
drives retry. Every risk resolves to "deferred," none to "wrong delivery/ownership."

`activateReferenced` (~2.5s, endpoint app-server connect) stays synchronous — it fits the budget and
keeps `activation.unavailable` accurate + pre-warms endpoints so each background recovery gets a ready
lease immediately (no thundering herd). Background it too only if the budget later tightens.

## Correctness review

Adversarially reviewed: flip-set ≡ recovery-set (exact); local-backgrounding is as safe as remote
(gates key on `management_state`, not locality); the up-front acknowledge removes the `acceptAndDrain`
overlap. The synchronous flip is the linchpin and is correctly placed and scoped.
