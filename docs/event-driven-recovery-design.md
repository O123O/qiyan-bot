# Event-Driven Recovery Design

## Status

Implemented and verified.

## Problem

QiYan currently runs one broad maintenance function every 60 seconds. That function mixes unrelated responsibilities: external Codex-client detection, missed-completion recovery, durable operation recovery, registry reload, dashboard rendering, cache cleanup, and health checks. A failure in any step becomes the same user-facing `maintenance failed` warning, and idle services repeatedly read SQLite, rewrite the dashboard, and read every managed thread's history.

Most of this work already has an authoritative event: startup, app-server reconnect, `turn/completed`, a durable operation becoming uncertain, or a local projection failure. Only detection of turns started by a separate Codex client lacks a reliable event and requires polling.

## Goals

- Keep automatic recovery after QiYan or an app-server exits unexpectedly.
- Detect externally started Codex turns within approximately one minute and automatically release the affected managed session.
- Trust `turn/completed` while the app-server connection is healthy.
- Run history reconciliation once at startup or reconnect, not every minute.
- Retry only the subsystem with known unfinished work.
- Remove the generic `maintenance failed` warning.
- Keep the implementation understandable without introducing a general scheduler framework.

## Non-goals

- Changing the SQLite schema or durability model.
- Changing app-server restart, SSH runtime, delivery, or ownership semantics.
- Adding filesystem watches for rollout files.
- Supporting live external edits to `sessions.json`.
- Refactoring unrelated chat adapters or endpoint interfaces.

## Design principles

1. A timer must correspond to a real clock-based requirement.
2. A durable incomplete state must have an explicit wake-up path.
3. Startup remains the comprehensive crash-recovery boundary.
4. Normal app-server notifications are authoritative while their connection is healthy.
5. Failures are isolated and reported by capability, never as generic maintenance.
6. Retry state remains local to the subsystem that owns the unfinished work.
7. Recovery never classifies an operation while its original side-effecting call is still in flight.

## Runtime architecture

### Remove generic maintenance

Remove the `maintenance` option from `composeApp`, the production no-op maintenance phase, `runMaintenance`, and their timer-specific tests. Production will no longer have a once-per-minute function that walks unrelated durable state.

The startup assistant phase retains the existing ordered recovery boundary before chat ingress:

1. Recover the assistant dispatcher.
2. Reconcile durable operations and lifecycle transitions.
3. Resume managed sessions.
4. Reconcile ownership and terminal history for referenced endpoints.
5. Recover delivery state and enqueue pending events.

Endpoint-ready recovery retains the corresponding endpoint-scoped reconciliation.

### External ownership watcher

Add an explicit lifecycle phase named `external-ownership-watcher`.

- Start after endpoints and managed sessions are ready.
- Run once every 60 seconds, with no overlapping executions.
- Consider managed sessions and externally-triggered `unadopting` sessions on ready endpoints.
- Acquire the existing endpoint work lease.
- First finish an `unadopting` removal that has a durable pending external-ownership incident.
- Incrementally inspect rollout ownership and release positively identified external sessions.
- Do not drain dashboard observations.
- Do not call `EventRelay.reconcileEndpoint` or read thread history.
- Stop and await an in-flight cycle during application shutdown.

The watcher isolates failures per endpoint. One endpoint failure must not prevent other endpoints from being inspected. If external unadoption fails after the registry transition, the next watcher tick resumes that exact removal before looking for new managed-session incidents. The endpoint candidate set therefore cannot be derived only from `managedSnapshot()`. This is not general lifecycle polling: user-initiated lifecycle operations retain their operation-owned recovery path.

The existing failure-episode reporter may send one specific warning after three consecutive failed cycles and reset after a conclusive successful cycle. The warning states that external session ownership detection is degraded; it does not mention maintenance or generic durable reconciliation.

### Completion delivery

Normal worker completion remains notification-driven:

1. Receive `turn/completed` for the exact endpoint and thread.
2. Inspect ownership before reading authoritative turn history.
3. Read and persist the exact terminal turn.
4. Inspect ownership again to fence a concurrent external turn.
5. Prepare the worker delivery and durable assistant event.

`EventRelay.handleNotification` must return a discriminated outcome:

- `handled`: the exact turn was durably projected.
- `conclusively_ignored`: the exact turn is external, belongs to a stale mapping generation, or is otherwise proven outside the managed delivery epoch.
- `retry`: ownership is unclassified, authoritative history does not yet contain the turn, or the current state cannot yet prove either of the above outcomes.

Exceptions and `retry` both retain a metadata-only target containing endpoint, thread, turn, mapping, and epoch IDs captured under the thread gate. Relay recovery owns a coalesced set keyed by all five identifiers; one new target cannot replace another unresolved target. The target is cleared only after that exact epoch-bound turn becomes `handled` or `conclusively_ignored`. A mapping or epoch mismatch is conclusively ignored and can never be reconstructed against a replacement mapping.

Endpoint recovery uses the existing ownership-read-ownership fence and may retry with capped backoff while the endpoint remains ready. A broad `void` history pass is not considered success when an exact target remains unresolved.

Endpoint loss cancels the local relay retry. Endpoint-ready recovery then performs the existing full history reconciliation and either projects or conclusively advances past eligible terminal turns.

No completion safety scan runs while the connection is healthy. If the app-server process or connection exits, the existing endpoint supervisor restarts or reconnects it with capped backoff. The endpoint-ready recovery then reads history once and recovers completions missed while disconnected.

### Assistant terminal recovery

Assistant terminal processing reuses `ConversationDispatcher`'s existing recovery timer. Expose a narrow `requestRecovery()` operation that coalesces onto that timer; do not add another assistant timer.

Request dispatcher recovery when assistant notification processing or asynchronous deferred-terminal processing fails. Recovery reads authoritative assistant history and re-enters the exact terminal path. A terminalizing assistant lease therefore retains a wake-up while the endpoint stays healthy, independent of the removed minute loop.

### Durable operations

Keep the existing serialized `operationReconciliationTail`; do not add a second operation queue.

Request operation reconciliation from these explicit events:

- Startup.
- Endpoint ready after reconnect.
- A side-effecting tool operation becomes `uncertain`.
- Assistant tool fencing at terminal time.
- A relevant worker terminal notification.

For an uncertain tool result, request the wake only after the MCP boundary has called `finishTool`; do not arm reconciliation from inside the action catch while the original handler is still registered as active.

Assistant terminal processing must preserve causal ordering:

1. Stop new tool admission and mark the attempt terminalizing.
2. Wait a bounded time for already-registered tool calls to leave the in-process active-tool set.
3. If any tool remains active at the timeout, mark its dispatched operations uncertain, request one controlled QiYan restart, and do not reconcile or finalize that attempt in the current process.
4. After all registered tools have settled, reconcile the active attempt's recoverable operations before classifying a failed attempt or constructing its recovery context.
5. Finalize the assistant attempt.
6. Request another reconciliation pass if terminalization left any operation recoverable.

This design deliberately chooses controlled restart on a fence timeout instead of introducing a second durable tool-permit protocol. Completed turns use the same safe post-fence reconciliation trigger even though they do not create a recovery context. Reconciliation remains conservative: an operation stays uncertain unless authoritative state proves its outcome.

Controlled restart has a real shutdown barrier. Scheduler shutdown stops new MCP admission, then waits for `AssistantRuntime`'s registered active-tool count to reach zero through each handler's `finishTool` before project endpoints, MCP transport, or SQLite storage can close. This wait is not the ordinary bounded fence: endpoint transport remains available so the original handler can settle, and startup cannot begin while the old QiYan process is still draining. The MCP response lifetime is not accepted as proof that a handler stopped.

A single local operation retry timer may remain active only for actionable recovery work. It coalesces requests, uses capped backoff, and follows these rules:

- A live `dispatched` operation is not actionable; its wake-up is tool settlement or terminal fencing.
- An `uncertain` operation is actionable only after its registered tool handler has left the active-tool set.
- A dispatched operation from a terminal or non-live attempt is actionable.
- Work blocked by endpoint unavailability sleeps until endpoint ready instead of polling.
- A pass re-arms the timer only when it attempted actionable work and a classified transient condition blocked proof. Merely remaining uncertain or waiting for a worker terminal does not poll.

Operation reconciliation returns a bounded outcome describing whether actionable work was attempted and whether a transient retry is needed. Permanently unproven work remains durable and wakes on its relevant terminal, endpoint-ready, explicit tool-settlement, or startup boundary. This prevents the operation owner from becoming a disguised scheduler.

### Durable observations

`SessionObservationProcessor.accept` already persists and enqueues app-server observations immediately. A thrown transient processing failure schedules another attempt for that endpoint. A notification returned as `deferred` does not arm a timer or busy-retry; it remains asleep until managed-session recovery restores the mapping and explicitly calls `drain(endpointId)`.

Retry state is endpoint-local and cleared after success, endpoint loss, or shutdown. No external timer calls `drain`.

### Managed-session recovery

Startup and endpoint-ready recovery remain the normal resume paths. The per-session failure/isolation path classifies its failure before marking a mapping unavailable; the outer caller does not infer failure from a swallowed exception.

Arm endpoint-scoped managed-session retry only for an allowlisted transient condition such as endpoint/transport unavailability, temporarily unclassified ownership, or a busy session. Permanent validation/configuration failures such as `CWD_MISMATCH`, and unclassified unknown errors, remain unavailable, warn once, and sleep until startup or an explicit relevant state change. They do not keep a timer alive.

Retry only classified transient sessions whose runtime state is `unavailable`; do not mark healthy managed sessions unavailable merely to rescan them. After a session is restored, request endpoint relay reconciliation for completions missed while it was unavailable, then call `drain(endpointId)` to wake observations that were deliberately deferred. Disarm retry when no retryable unavailable session remains for that ready endpoint.

### Deliveries and events

The delivery worker remains the owner of delivery retries. A terminal delivery-state projection normally creates its durable event immediately.

If projection fails after the delivery state has committed, request a controlled QiYan restart. Startup `reconcileDeliveryStateEvents` repairs the missing projection before ingress. This avoids a permanent delivery-projection polling loop and preserves the rule that a confirmed outbound delivery is never rolled back.

The delivery worker intentionally contains state-observer exceptions, so its observer invokes `requestRestart` as a side effect before returning; throwing alone is not a recovery signal.

### Durable event wake-up

Every successful durable event commit synchronously requests the existing assistant event-scheduler wake when the scheduler is accepting work. If the commit succeeds but enqueue/wake fails, request a controlled QiYan restart; startup pending-event enqueue becomes the recovery boundary. Do not catch the wake failure and depend on later traffic.

Events committed before scheduler startup or while the assistant endpoint is unavailable remain covered by the existing startup/endpoint-ready enqueue. No generic pending-event poller is added.

### Dashboard

Dashboard rendering remains state-change-driven.

- Remove the unconditional minute-level `markDirty` and render.
- A normal render failure leaves the dashboard dirty, emits its existing deduplicated warning, and retries on the next dashboard state change.
- Route every metadata-dependent dashboard mutation and render-state read through one private `SessionDashboardStore` metadata guard. The guard validates the singleton metadata before mutation and invokes one injected, one-shot recovery callback on the exact metadata-recovery error before rethrowing.
- The production callback requests one controlled QiYan restart. Startup automatic recovery rebuilds that metadata while holding the database lease.
- Do not periodically assert dashboard metadata health while the service is idle.

### Registry

Open and validate `sessions.json` at startup. During runtime, all supported registry mutations continue through `SessionRegistry`, which atomically writes `sessions.json` and its last-good snapshot before replacing the in-memory document.

Remove periodic `registry.reload`, its now-unused public API, and the runtime replacement-rejected warning. This intentionally removes the tested ability to apply a live assistant `description` metadata edit. That field has no runtime consumer, and repository documentation already defines the registry as generated read-only state. External edits while QiYan is running are unsupported and may be replaced by the next supported in-process mutation. A user who intentionally edits the file must restart QiYan for startup validation and activation.

### Cleanup

- Attachments: clean once during startup, then once every 24 hours. Runs do not overlap. Failure produces a metadata-only operational log and retries the next day; it does not create a chat warning.
- Discovery snapshots: delete expired rows opportunistically at the beginning of a new discovery request. Expired cursors are already rejected by timestamp, so cleanup is storage reclamation only.

## Timers after the change

The production recovery design introduces no generic timer. The only clocks addressed by this change are:

| Timer | Active when | Purpose |
|---|---|---|
| External ownership watcher | Service running | Detect separate Codex clients within 60 seconds |
| Attachment cleanup | Service running, daily | Reclaim expired unreferenced files |
| Operation retry | Settled actionable work hit a transient proof failure | Prove uncertain operation outcomes |
| Endpoint relay retry | An exact epoch-bound completion target is unresolved | Recover that endpoint's missed completion |
| Observation retry | An endpoint has pending failed observations | Finish that endpoint's durable projection |
| Managed-session retry | An endpoint has classified transient unavailable sessions | Recover only retryable unavailable sessions |

Existing dispatcher, endpoint reconnect, delivery worker, and chat-ingress timers are unchanged.

## Local retry-owner contract

Every local retry owner follows the same lifecycle rule without introducing a shared scheduler abstraction:

- At most one timer and one in-flight promise/tail for its own responsibility.
- Concurrent events coalesce onto that work.
- A stopped or stale endpoint generation cannot start new work or publish success.
- Endpoint-local retry timers are cancelled on endpoint loss; endpoint-ready recovery becomes the next wake-up.
- `stop()` marks the owner stopped, cancels its timer, and awaits its in-flight work.
- Lifecycle phases are ordered so retry owners stop before endpoint connections and SQLite storage close.
- Retry controllers retain only fixed subsystem labels and bounded endpoint/thread/turn/mapping/epoch/operation IDs. Raw exceptions, notifications, history responses, and message contents are discarded immediately after classification.

The assistant reuses the dispatcher's existing timer, and externally-triggered removal reuses the ownership tick. Neither receives a new timer.

## Endpoint-ready recovery

Endpoint-ready handling is a wake-up boundary, not a warning-only monolith. It delegates to existing subsystem owners:

- Dispatcher recovery for the assistant endpoint.
- Managed-session recovery for unavailable mappings.
- Terminal relay recovery for the endpoint history gap.
- Actionable operation recovery.
- Observation drain after managed mappings are restored.

Each owner applies its own single-flight and retry classification. A failure in one owner arms that owner's retry contract and does not silently prevent the other owners from receiving their wake-up. The top-level endpoint-ready handler requests controlled restart only when endpoint generation or ownership safety cannot be established. No new central endpoint recovery component or timer is introduced.

## Failure reporting

- Operational logs contain fixed subsystem labels and bounded metadata only.
- Never log chat message bodies, attachment contents, bot tokens, Codex credentials, raw rollout records, or raw exception strings.
- User-facing warnings are reserved for degraded user-visible capabilities and deduplicated by failure episode.
- Successful recovery resolves the corresponding episode.
- There is no `maintenance` failure episode and no `[system] maintenance failed; durable reconciliation will retry` message.

## Data and compatibility

- No database migration is required.
- Existing durable operations, observations, deliveries, ownership cursors, and unavailable runtime rows remain recoverable.
- Existing `sessions.json` files remain valid; the unused live assistant-description reload behavior is removed.
- Restarting an app-server or QiYan preserves the current recovery behavior.

## Test strategy

Behavior changes must be introduced with failing tests before implementation.

### Composition and watcher

- Remove tests for the generic `composeApp` maintenance option.
- Test watcher start, stop, no-overlap, and shutdown awaiting an in-flight cycle.
- Test that a watcher tick performs rollout ownership inspection and release without calling terminal relay, registry reload, dashboard rendering, dispatcher recovery, lifecycle recovery, or operation recovery.
- Test per-endpoint failure isolation and three-cycle warning deduplication/reset.
- Test failure after an external mapping transitions to `unadopting`; the next ownership tick completes removal and projects `onReleased` exactly once.

### Completion and restart

- Test that one `turn/completed` notification delivers one exact owned terminal result.
- Test that a notification-handler failure schedules one coalesced endpoint relay recovery.
- Test `handled`, `conclusively_ignored`, and `retry` outcomes, including an unclassified ownership boundary that returns normally but retains an exact retry target.
- Test that the exact retry target is not cleared by a broad reconciliation pass that still cannot classify the turn.
- Test mapping or epoch replacement between initial `retry` and recovery is conclusively ignored without delivering into the replacement epoch.
- Test two simultaneous unresolved epoch-bound targets are retained and resolved independently.
- Test that a healthy idle endpoint performs no thread-history reads.
- Retain startup/reconnect tests that recover a missed terminal result under one endpoint generation lease.
- Retain app-server unexpected-exit and capped reconnect tests.

### Operations and lifecycle

- Test that an uncertain tool operation requests reconciliation without waiting for a clock tick.
- Test completed and failed assistant terminal paths with an operation still active at the fence.
- Test fence timeout requests restart and performs neither no-effect reconciliation nor attempt finalization while the side effect remains active.
- Test shutdown after fence timeout keeps project endpoints, MCP, and SQLite open until the registered handler reaches `finishTool`.
- Test assistant terminal-history or persistence failure wakes the existing dispatcher recovery timer exactly once while the endpoint stays ready.
- Test failed-attempt recovery context construction sees the best authoritatively reconciled receipts.
- Test the operation timer stops when only live dispatched rows remain.
- Test endpoint-unavailable operations sleep until endpoint ready instead of polling.
- Test a transient proof failure re-arms recovery, while a row waiting for a worker terminal does not.
- Test unavailable managed-session retry touches only unavailable sessions.
- Test a permanent `CWD_MISMATCH` remains unavailable with one warning and no retry re-arm.
- Test managed recovery that initially fails and later succeeds wakes relay reconciliation and delivers a completion missed during disconnect.

### Projections, dashboard, registry, and cleanup

- Test thrown observation failure retries, deferred observation sleeps, managed recovery wakes it, and shutdown cancels/awaits retry work.
- Test delivery projection failure requests restart and startup repairs the missing event.
- Test a durable event commit followed by enqueue failure requests restart even when no later input arrives.
- Test exact mid-runtime dashboard metadata corruption is detected before the next metadata mutation, requests one restart, and performs no further mutation; ordinary render failure does not restart.
- Remove live reload tests and test that startup still validates the generated registry.
- Test attachment startup/daily cleanup, non-overlap, and shutdown awaiting in-flight cleanup.
- Test discovery cleanup occurs on a new discovery request.
- Test dispatcher, operation, relay, observation, and managed-session retry owners cancel timers, reject stale generations, and await in-flight work during shutdown.
- Test endpoint-ready recovery wakes every subsystem owner even when one owner's first pass fails.
- Test retry owners retain only bounded identifiers and fixed labels after classifying failures.

### Verification

- Run targeted tests after each behavior slice.
- Run `npm run check` before every commit and before merge.
- Build and install the branch package, restart the local user service, and verify logs contain the ownership watcher but no idle generic maintenance failures or minute-level history reads.

## Implementation boundaries

- Keep chat adapters, app-server transport, session policy, and persistence behind their existing interfaces.
- Prefer small changes in current owners over a new central recovery component.
- Do not combine this work with unrelated cleanup or documentation restructuring.
- The implementation is complete only when an idle service no longer performs generic reconciliation and every removed safety scan has a tested explicit wake-up path.
