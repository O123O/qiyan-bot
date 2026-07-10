# Assistant Conversation and Native Turn Ownership

## Status

Implemented and verified.

## Problem

QiYan must serialize several chat conversations through one assistant thread while still allowing natural follow-ups from the conversation that currently owns the assistant. The current conversation lease already does that, but the native turn identity can be replaced after a successful `turn/start`: `AppServerPool` rereads thread history and accepts the newest turn that either has the same client message ID or has the returned turn ID.

That lets reconstructed history override the App Server's successful response. In the observed failure, the successful response named the live Codex turn, while a client-correlated synthetic terminal entry from rollout reconstruction was selected instead. QiYan immediately terminalized the assistant attempt and rejected later MCP calls even though Codex was still running the real turn.

The defect is not the conversation lease. It is that a recovery representation was allowed to become live lifecycle authority.

## Goals

- Let only the exact chat conversation that started the active assistant turn steer it.
- Queue input from every different adapter/conversation until the owning turn completes.
- Treat a successful App Server `turn/start` response as authoritative for the live native turn identity.
- Treat exact App Server completion notifications as authoritative during a healthy connection.
- Preserve crash recovery for genuinely uncertain submissions without running history reconciliation on successful starts.
- Keep MCP tool admission open for the active QiYan attempt until its exact native turn begins terminalization.
- Make the smallest change that fixes the authority error; do not redesign the existing durable conversation queue.

## Non-goals

- Removing the durable QiYan assistant attempt, source membership, or tool fence.
- Allowing one conversation to steer a turn started by another conversation.
- Supporting parallel native assistant turns on the shared assistant thread.
- Parsing rollout files to discover live turn state.
- Replacing App Server notifications with polling.
- Changing managed worker-session ownership or chat-adapter behavior.

## Authority model

The two identities answer different questions and must not be conflated.

| State | Authority | Purpose |
|---|---|---|
| Source order, owning conversation, queued conversations | QiYan SQLite | Durable multi-chat arbitration |
| Assistant attempt and admitted MCP tools | QiYan SQLite plus in-process tool fence | Side-effect scope and safe terminal settlement |
| Live native turn ID and lifecycle | Codex App Server | Start, steer, interrupt, and completion |
| Client user message ID | QiYan-generated correlation token | Reconcile only a submission whose response was genuinely lost |
| Correlated `turn/started` notification | App Server | Native identity authority when the start response is unavailable |
| `turn/completed` notification | App Server | Terminal authority for an already-bound exact ID; otherwise uncertainty evidence |
| Reconstructed thread history | Recovery evidence | Exact-ID terminal proof, submission-presence/absence evidence, and final content; never mint a live ID |

A native turn ID is an opaque exact token. QiYan stores it because `turn/steer`, `turn/interrupt`, and `turn/completed` correlation require it. It does not determine which chat conversation owns the turn; the durable conversation binding does.

## Invariants

1. There is at most one durable assistant conversation lease.
2. A chat source is the lease owner only when both `adapterId` and `conversationKey` exactly match the lease binding.
3. Only an owner source may be reserved for `turn/steer`; every different conversation remains pending and receives the existing queue notice.
4. Only one native start or steer submission may be unresolved at a time.
5. A successful `turn/start` response binds the capacity claim, lease, and attempt source to exactly the returned turn ID.
6. No `thread/read`, rollout-derived record, client-ID match, or unrelated notification may replace that successful turn ID.
7. A live completion terminalizes only the exact stored native turn ID. An unknown-ID completion never establishes identity; while the exact local start request is in flight it may be buffered only for later comparison with an authoritative start response or correlated `turn/started` notification.
8. MCP admission requires the singleton lease, its matching active attempt, phase `starting` or `active`, and an open attempt tool fence. An active lease additionally requires a non-null exact native turn ID consistent with the attempt mirror.
9. Beginning terminalization closes new MCP tool admission before admitted tools settle and durable operations reconcile; MCP admission derives from lease phase so a crash between the lease CAS and the attempt fence is closed safely.
10. Repeated start/steer/completion/recovery events are idempotent and cannot release another attempt's lease.

## Message routing

When no lease exists, the dispatcher chooses the existing oldest eligible chat source or forced internal event, acquires the single lease, and starts one native turn.

While a chat-bound lease is active:

- A message from the same adapter and exact conversation key is persisted as an owner source and may be submitted as the next steer.
- A message from another Slack thread, Slack DM, Telegram chat, WeChat conversation, or any other distinct conversation key is persisted as pending, receives `[system] queued`, and cannot be selected by `reserveNextSteer`.
- A second owner message waits behind an unresolved owner steer; native submissions remain serialized.
- Internal recovery/event work does not join a chat turn unless the existing source policy explicitly created that lease for it.

After exact terminal settlement releases the lease, ordinary global arrival arbitration selects the next queued source. No native turn ID is needed for this queue decision.

## Successful start

The success path is deliberately direct:

1. Persist the source, lease, unique client user message ID, and provisional capacity claim.
2. Send `turn/start` once.
3. On a successful response, bind the capacity claim and durable lease to exactly `response.turn.id`.
4. Mark the source submitted, activate the runtime attempt, and allow same-conversation steering.
5. Do not issue a confirming `thread/read` and do not substitute a client-correlated history turn.

If an exact `turn/completed` arrived before the start response was processed, the existing early-completion buffer may terminalize only after the returned ID matches it. A terminal status carried by the successful response may use the same exact-ID terminal path. Neither case permits history to change the identity.

The early notification buffer is scoped to the single locally in-flight assistant start and is cleared when that start settles. Arbitrary unmatched assistant completions are not retained.

## Steering

The dispatcher sends `turn/steer` only for a source with the exact lease binding and uses the stored native turn ID as `expectedTurnId`.

On success, the returned ID must equal the stored expected turn ID. A different ID is an operation conflict and must not mutate ownership. On a proven `activeTurnNotSteerable` response, restore the source to pending and pause steering until the exact current turn settles. Messages from other conversations remain queued throughout.

## Completion and MCP admission

During a healthy App Server connection, `turn/completed` is the live terminal authority.

1. Known-ID path: `active(turnId=A) + completed(A)` compare-and-sets the singleton lease to `terminalizing(A)`. Every other ID is ignored.
2. Unknown-ID path: `starting(turnId=NULL)` plus `turn/completed(A)` records durable `unknown_terminal_observed` uncertainty but does not bind `A`. During the exact local start request it may remain in the bounded buffer; only a later authoritative start response or correlated `turn/started(A)` may consume it and enter `terminalizing(A)`.
3. After dispatcher settlement, production rereads the singleton lease and continues only when it is `terminalizing` with the notification's exact turn ID. It then resolves the active attempt by that lease's exact attempt ID plus turn ID. An unmatched, orphan, or historical attempt cannot enter fencing or finalization merely because its turn ID appears in a notification.
4. MCP admission reads the lease phase, so either successful lease transition closes new admission immediately. The attempt fence is then incremented for durable audit and in-process tool settlement.
5. Release native turn capacity as soon as the exact App Server completion is observed.
6. Wait for already admitted MCP handlers through the existing bounded tool fence.
7. Reconcile durable operations created by those handlers.
8. Persist final output/recovery state, deliver results, clear the durable conversation lease, and pump the next queued source.

The MCP server remains ordinary Codex tool transport. Its request does not carry a trustworthy native turn ID. The QiYan attempt ID and singleton lease bind durable side effects and fence late calls during terminal settlement. A tool call may race ahead of local processing of the `turn/start` response on the separate MCP transport, so the exact singleton `starting` lease remains admissible even before its native ID is known. No provisional `pending:*` value is exposed as a native ID; the tool context's native turn ID is optional and is not used for side-effect ownership.

## Genuine uncertainty and restart recovery

The assistant dispatcher is the sole durable recovery owner when QiYan did not receive a definitive native response or restarted with unfinished state.

- When the assistant supplies a caller-owned capacity claim, `AppServerPool.startTurn` sends `turn/start` once. Success is returned unchanged. A possibly-dispatched failure is surfaced as uncertain without a history read and without releasing the caller's provisional claim. The dispatcher persists and reconciles that uncertainty. The pool may retain self-reconciliation for implicit non-assistant callers.
- If `turn/start` becomes uncertain, do not retransmit it. Full history may prove that the client-correlated input is present or absent, but a history turn ID is not sufficient provenance to become the live steer/completion token.
- An App Server `turn/started` notification whose turn items contain the unresolved start's exact client user message ID may supply the native ID because it is a native start surface with direct correlation. A `turn/completed` notification cannot supply an unknown ID. Without a successful response or correlated start notification, retain the uncertain lease. Do not infer provenance from uniqueness, recency, UUID shape, or a `rollout-` prefix.
- If `turn/steer` becomes uncertain, use its unique client ID only inside the already known exact expected turn. History may prove admission to that same turn, but may not rebind the lease to another turn.
- If history conclusively proves no effect, restore the source according to the existing policy.
- If history is incomplete, ambiguous, or contains only reconstructed identity, retain the durable uncertain state. Do not guess, release the lease, steer, interrupt, or admit another conversation.
- On startup or endpoint reconnect, reconcile a lease that already has an exact turn ID by exact ID only. History may prove that exact turn terminal; it may not replace it.

A start with no received turn ID remains non-steerable but continues to admit MCP calls for its exact singleton starting lease because the native turn may really be running. Those calls are scoped by QiYan attempt/source identity and do not resolve native identity. An unknown completion records durable uncertainty, suppressing absence proof, polling, and retransmission until an authoritative start identity arrives. Once an authoritative ID is bound, every native lifecycle operation is exact-ID-only.

### Notification/response race

An authoritative lifecycle notification can arrive while the original `turn/start` promise is still pending. Start confirmation therefore uses an exact compare-and-set disposition such as `bound`, `already_same`, `already_terminal_same`, or `conflict`.

- `turn/started(A,C)` followed by successful response `A` is one idempotent active binding.
- `turn/started(A,C)` followed by a transport rejection remains bound to `A`; the rejection cannot regress the source to uncertain.
- `turn/completed(A,C)` before response is buffered without binding; response `A` consumes it and terminalizes once, while response rejection retains durable uncertainty.
- If notification binds `A` and the later response reports `B`, retain `A`, keep the lease closed to conflicting progress, and report an identity conflict. Never overwrite the lease or pump another conversation.

Failure handling first reads the durable submission/lease disposition. It marks uncertainty only while that submission is still unresolved. Notification correlation always uses the notification turn's own user item and exact client ID, never a separate history candidate.

### Startup lifecycle window

The App Server connection can deliver assistant `turn/started` or `turn/completed` before the dispatcher has been constructed. Production accepts exact assistant-thread lifecycle notifications into a bounded, ordered in-memory buffer during that window. After dispatcher construction it drains the buffer through the same notification handlers, in arrival order, before dispatcher recovery and tool readiness. Notifications arriving during the drain join its tail. Failed startup and shutdown clear the buffer, and malformed or unrelated notifications cannot acquire assistant ownership.

The one-time legacy conversation cutover follows the same rule. An existing exact attempt turn ID must match exact full history or cutover fails safely. It may not fall back to a client-correlated turn and rewrite the attempt/lease. Legacy state without an exact authoritative ID remains a configuration/recovery error instead of being guessed into a live lease.

## Minimal implementation

1. Add a pool regression where `turn/start` successfully returns active turn `A`, while a possible `thread/read` would contain terminal client-correlated turn `B`. Assert that the response and capacity claim remain bound to `A` and that no history read occurs. Update the existing test that currently expects replacement.
2. For a caller-supplied claim, make `AppServerPool.startTurn` surface a possibly-dispatched failure without reading history or releasing the claim. Keep implicit non-assistant recovery isolated in the pool. The dispatcher remains the one durable assistant uncertainty owner.
3. Change dispatcher reconciliation so history and completion notifications cannot bind an unknown start ID. Bind an uncertain start only from a successful response or correlated App Server `turn/started`; synthetic/history-only evidence remains uncertain. A steer reconciliation must match its existing expected turn exactly.
4. Split or CAS-check store confirmation semantics: start returns `bound | already_same | already_terminal_same | conflict`; steer only confirms membership in the existing exact turn and cannot rewrite lease or attempt identity. Start success/failure and lifecycle-notification handlers must be idempotent across their race.
5. Gate production fencing/finalization by rereading the exact singleton `terminalizing` lease after dispatcher settlement, then resolving only that lease's attempt ID and turn ID. Never find an old/orphan attempt by notification turn ID alone.
6. Make runtime hydration/current context and `registerTool` require the same singleton `starting` or `active` lease, matching active attempt, and open tool fence. Active leases additionally require a non-null exact ID consistent with the attempt mirror. Terminalizing and orphan attempts reject new MCP calls. Make the native turn ID optional in provisional tool context instead of manufacturing a `pending:*` ID.
7. Remove the client-correlated turn-ID replacement from legacy conversation cutover; exact stored identity either matches or cutover fails safely.
8. Preserve the existing exact same-conversation steer and cross-conversation queue policy. Bound the early-completion buffer to the locally in-flight start.
9. Buffer ordered assistant lifecycle notifications that arrive before dispatcher readiness and drain them before recovery/tool readiness.

No schema migration is required. The existing lease binding, native turn ID, attempt membership, client user message IDs, and capacity claim fields already represent the necessary state.

## Test matrix

- Successful start `A`; stale/synthetic correlated terminal history `B`: retain `A`, skip history, keep runtime active.
- Successful start followed by same-conversation input: steer `A`.
- Successful start followed by different-conversation input: queue it and do not steer.
- Two same-conversation follow-ups: submit only one steer at a time.
- Completion for `B` while `A` is active: do not terminalize `A`.
- Completion for `A`: fence tools, finalize once, release lease, then start the oldest queued conversation.
- Lost start response with one synthetic/full-history client-ID match: remain uncertain, keep the exact starting attempt's MCP admission open, and do not steer or bind that history ID.
- Lost start response followed by a correlated authoritative `turn/started`: bind that notification ID without retransmission.
- Lost start response followed by `turn/completed`: retain durable `unknown_terminal_observed`, keep the starting attempt tool-admissible, and do not prove absence or retransmit.
- `turn/started(A,C)` before response, then response `A`: one active binding and no history read.
- `turn/started(A,C)` before response, then rejection: remain bound to `A`, not uncertain.
- `turn/completed(A,C)` before response `A`: buffer then terminalize exactly A once; before response rejection, retain uncertainty without binding.
- Notification binds `A`, later response reports `B`: retain `A`, do not pump another conversation, and surface a safe identity conflict.
- Lost steer response correlated inside exact expected turn: mark admitted; correlation in another turn must not rebind.
- Restart with exact active turn ID: use exact-ID history only; terminal history for another ID has no effect.
- Orphan active attempt: no MCP context and no tool admission. Exact singleton starting/uncertain lease: MCP remains scoped to that attempt, but there is no native steer/interrupt token.
- Completion matching an old/orphan attempt but not the singleton lease: no fence, finalization, delivery, or lease release.
- Known non-steerable owner turn: restore owner input, pause steering, and keep other conversations queued.
- Another adapter using the same literal conversation key: still queued.
- Queued outsider updates later routing state: final delivery still uses the frozen owner binding.

## Operational effect

Normal starts become simpler and faster because they no longer require `thread/read`. Users keep the intended multi-chat behavior: follow-ups in the owning conversation can steer, while messages from every other conversation wait until completion. Recovery reads remain event-driven and only handle genuinely uncertain or restarted state.
