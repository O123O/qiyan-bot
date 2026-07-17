# App-Server-authoritative lifecycle redesign

## 1. Decision

QiYan will treat the connected provider runtime as the only authority for native
session liveness. For Codex, that authority is the App Server connection,
notifications, and bounded requests made on the current connection generation.
For Claude, it is the current `ClaudeRuntime` process and its emitted lifecycle
events.

Persisted `native_status`, `active_turn_id`, assistant turn leases,
`management_state=unavailable`/`restore_state`, dashboard snapshots, delivery
cursors, capacity receipts, and old notification rows must not answer any of
these questions:

- Is a session working or idle now?
- Which turn may be steered or interrupted now?
- Does a turn consume live concurrency now?
- May a completed turn be finalized now?
- Is an endpoint connection currently usable?

The sole exception is external-ownership detection for automatic unadoption.
Its rollout/transcript cursor and owned-turn evidence remain durable, but that
subsystem may only decide whether a managed mapping must be released. It cannot
publish native status, reserve turn capacity, or block unrelated work.

Durable registration state, accepted inputs, idempotency records, pending
settings, delivery outcomes, goals, terminal facts, and ownership evidence are
not native liveness and remain persisted.

Durable registration lifecycle and volatile availability are separate:
`managed`, `unadopting`, `archiving`, and their operation checkpoints describe
QiYan's intended registration; they remain durable. `unavailable` describes a
current transport observation and is volatile. The migration removes the
persisted unavailable/restore mirror rather than retaining a second dormant
state path. Durable notification rows and operation receipts may initiate
reconciliation of one named fact; they cannot authorize tools, restore live
capacity, defer terminalization, or decide endpoint availability.

## 2. Why the current design fails

The current design copies App Server observations into `session_runtime`, then
uses those copies as live control state. The same stored turn identity is used
by dispatch, interrupt, capacity recovery, terminal processing, the dashboard,
and the Web UI. The assistant adds another durable `assistant_turn_lease` and
currently reports `working` whenever that lease exists.

This makes an ambiguous submission contagious. One uncertain steer can keep a
terminal lease alive, make the UI report `working`, restore a capacity claim on
restart, force repeated history scans, and prevent every later accepted input
from running. A restart restores the poison because the stale state was made
authoritative deliberately.

The design violates the liveness invariant:

> Every accepted input must eventually be delivered, requeued, or exposed as a
> bounded visible failure; no single input may hold a session or the assistant
> globally forever.

## 3. Sources of truth

| Question | Authority | Durable fallback allowed? |
| --- | --- | --- |
| Endpoint connected/usable now | Current endpoint instance and generation | No |
| Thread active/idle now | Current App Server/Claude snapshot plus lifecycle events | No |
| Current active turn ID | `turn/started`, successful start/steer response, or a bounded current-generation refresh | No |
| Live message flow | Item and delta notifications on the current connection | No |
| Managed registration | Session registry and lifecycle operation | Yes |
| Accepted user input | Source context / assistant attempt records | Yes |
| Pending model/effort choice | Runtime settings record until applied | Yes |
| Final response delivery | Logical final and delivery outbox records | Yes |
| Missed terminal delivery recovery | Delivery cursor plus bounded native history | Yes, as a recovery cursor only |
| External activity / auto-unadopt | Rollout/transcript ownership evidence | Yes, isolated exception |

Persisted observations may be shown as historical facts with an observation
time, but no runtime decision or Web UI status may consume them as current
state.

## 4. Volatile native state

Introduce one in-memory `NativeSessionState` component keyed by endpoint,
thread, mapping, and endpoint generation. It owns:

```ts
type NativeSessionView = {
  availability: "ready" | "unavailable";
  status: "unknown" | "idle" | "active" | "error";
  activeTurnId: string | null;
  endpointGeneration: number;
  lifecycleRevision: number;
  receiveSequence: number;
  observedAt: number;
};
```

Rules:

1. A new endpoint generation starts with `unknown` for every mapping.
2. Every parsed response and notification receives a monotonically increasing
   sequence on its endpoint generation before any async continuation runs. All
   observations enter one serialized reducer. Receive sequence orders evidence
   already received; it does not make a later-arriving snapshot causally newer
   than events the server may have emitted while computing that snapshot.
3. Every lifecycle mutation accepted by the reducer increments
   `lifecycleRevision`. A resume/read refresh captures both endpoint generation
   and lifecycle revision when its request is dispatched. Its response may
   initialize or replace the view only when both values are unchanged. A late
   response with a stale dispatch revision is discarded, even when it has a
   larger receive sequence. At most one bounded follow-up refresh may be
   scheduled if the current event evidence is still incomplete. If an accepted
   refresh reports active without an ID, read at most the newest turn metadata
   page to identify it under the same revision fence.
4. `turn/started` and a successful `turn/start` response use a mutation-specific
   reducer, not the generic refresh reducer. Start dispatch captures the
   lifecycle revision. Its response applies when that revision is unchanged,
   or is idempotent when current state is already active for that same turn. A
   same-turn terminal tombstone or any authoritative idle observation accepted
   after dispatch prevents the response from resurrecting the turn; an
   identity ambiguity schedules at most one bounded refresh. This covers an
   ID-less `thread/status/changed: idle` as well as `turn/completed` arriving
   before the start response continuation.
5. `turn/completed` sets `idle` only for the current active turn. A mismatched
   lifecycle event triggers one bounded refresh rather than consulting SQLite.
6. `thread/status/changed` updates status immediately. An `active` event without
   a known ID retains a same-generation ID or schedules one bounded refresh.
7. Endpoint loss invalidates the whole generation and publishes `unavailable`.
8. Events and request results from older generations are ignored.
9. Nothing writes this state to SQLite.

The component publishes changes to lightweight listeners. Core lifecycle,
capacity, controls, and Web UI status consume the same view. There is no legacy
status cache, compatibility writer, or second status reducer after cutover.

## 5. Code structure and schema cutover

This is a replacement, not an adapter layered over `RuntimeStore`.

- Remove `RuntimeStore` after its allowed responsibilities move to focused
  stores.
- Registration and lifecycle intent live only in `SessionRegistry` plus durable
  lifecycle operation checkpoints.
- Pending model/effort and goal-control intent move to `SessionControlStore`.
- Delivery cursor/epoch progress moves to `SessionDeliveryProgressStore`.
- Current provider liveness lives only in in-memory `NativeSessionState`.
- Dashboard terminal/settings/goal projection lives in
  `SessionFactProjector`; it cannot import `NativeSessionState` as persistence
  input or expose liveness fields.
- Rollout/transcript ownership evidence remains in `RolloutOwnershipStore` and
  is reachable only through `OwnershipGuard`.

An atomic SQLite migration creates the focused durable tables, copies only
registration-independent control and delivery data, and drops
`session_runtime`. It does not copy `native_status`, `active_turn_id`,
`native_observation_sequence`, `management_state`, or `restore_state`.

The dashboard schema advances in the same cutover and removes
`native_status`, `active_turn_id`, and the cached availability mirror. The Web
API changes atomically to use `NativeSessionState`; there is no release where
both old and new status sources can be selected.

The assistant singleton turn lease is also removed, not retained as a renamed
arbiter. Existing assistant attempt/source rows migrate to per-input
dispatch/reconciliation records. Any pre-existing unresolved input receives an
absolute deadline derived from its original creation time, so deployment does
not restart its budget. Turn association remains only as idempotent delivery
correlation and cannot serialize the inbox.

## 6. Dispatch and controls

`SessionService.send`, interrupt, compaction, goal control, and endpoint
lifecycle operations run under the existing thread gate and endpoint work
lease. They resolve current native state as follows:

1. Use the volatile view only if it belongs to the admitted endpoint
   generation and is not `unknown`.
2. Otherwise perform one bounded native refresh on the admitted connection.
3. Start when native state is idle; steer only when it is active with an exact
   turn ID.
4. Treat App Server response/errors and subsequent notifications as
   authoritative. Do not pre-write or repair `session_runtime.active_turn_id`.
5. If the endpoint is unavailable, return `ENDPOINT_UNAVAILABLE`. Do not fall
   back to a stored active or idle value.

Turn capacity becomes generation-local in memory. Startup no longer restores
active claims from `session_runtime`. It reconstructs claims from the bounded
native snapshots obtained while referenced endpoints are activated. Durable
provisional start records may only initiate reconciliation of a specific
idempotent dispatch; they never restore capacity directly. Before new starts
are admitted, a bounded in-memory bootstrap barrier waits for every reachable
referenced mapping's first current-generation snapshot. Unreachable mappings
settle as unavailable and reserve nothing. Claims are uniquely keyed by
endpoint generation, thread, and turn ID so snapshot, start response, and
`turn/started` observations deduplicate. If reconnect discovers more active
turns than the configured capacity, those native turns remain represented and
new starts are denied until usage falls. The deliberate tradeoff is that work
on an unreachable endpoint cannot be counted toward a strictly provable global
limit.

## 7. Assistant input and terminal handling

The assistant's durable records remain an inbox/outbox and idempotency ledger,
not a live turn state machine.

- A native `turn/completed` always completes native lifecycle and releases live
  capacity immediately.
- Final extraction and delivery are not blocked by another uncertain input.
- A submitted or uncertain input is reconciled independently by its
  `clientUserMessageId` against only its expected turn or bounded post-baseline
  suffix.
- If the client ID is present, associate the input with that native turn.
- If exact terminal history proves it absent, requeue it.
- If exact evidence is unavailable after a bounded attempt/time budget, move
  only that input to a visible `needs_attention` outcome. Do not retry every
  second, keep a live lease, or block later inputs indefinitely.
- Reconciliation uses exponential backoff with jitter and a finite deadline.
  Attempt count, absolute deadline, and next eligible retry time are persisted
  per input, so a restart cannot renew the budget.
- `needs_attention` atomically ends that input's reconciliation and prepares a
  durable owner-facing system delivery. It is not merely a dashboard flag.
- An unfinished terminal finalization has the same durable retry discipline:
  each recovery cycle consumes its per-attempt budget whether native history is
  missing or the exact terminal is found, then ends visibly instead of looping.
- The singleton assistant lease is removed. A small in-memory arbiter may
  serialize actual native submissions on one thread, but it is rebuilt solely
  from current-generation native state and never persisted as liveness.
- Restart reconstructs native state from App Server, then reconciles durable
  inputs. A durable attempt or lease never makes QiYan appear active.

## 8. Terminal delivery and missed events

The normal path consumes a complete `turn/completed` payload directly after
revalidating mapping generation and durable accepted-turn correlation; it does
not re-read history merely to rediscover the same terminal. Partial notifications
enter bounded exact-turn recovery.
The backend always consumes lifecycle/final events because Telegram, Slack,
Weixin, and Web delivery must continue even without an open browser.

History is used only at explicit boundaries:

- endpoint/thread resume;
- reconnect gap repair;
- reconciliation of a named uncertain dispatch;
- recovery after a missed terminal notification;
- lazy Web UI history paging.

Every recovery query must be bounded by a latest page, exact turn ID, client
ID, or durable delivery cursor. No retry path may call `allTurns()` from the
beginning of a thread. Repeated failure opens a circuit and produces a degraded
incident instead of an unbounded scan loop.

Missed-terminal delivery recovery has a finite page, turn, byte, and time
budget. It must prove an unbroken suffix back to the exact mapping-epoch
delivery cursor. It prepares idempotent outbox records keyed by mapping epoch,
turn ID, and item ID and advances the cursor in the same transaction. It never
advances across an absent, corrupt, or unclassified anchor. Budget exhaustion
degrades only that mapping and creates one visible incident; it does not retry
forever or make the endpoint unavailable.

Endpoint readiness is acknowledged immediately after transport handshake and
runtime health succeed. Thread resume, history, delivery, and ownership repair
are per-mapping work. One corrupt or legacy thread opens only its own circuit
and sets that volatile mapping view to `error`; healthy mappings on the same
local or remote endpoint continue. Only transport/runtime-health failures may
restart an endpoint.

## 9. Web UI

The Web UI follows the App Server rich-client model:

1. Selecting the QiYan or worker panel subscribes that browser socket to one
   exact mapping and endpoint generation.
2. The backend installs the subscription first and buffers matching events
   while it reads one bounded initial native history page. The history adapter
   may expose only complete native items, keyed by stable turn and item IDs. In
   particular, Codex rollout history contains persisted complete items; an
   actively streaming agent-message body is not a snapshot item. An adapter
   that cannot prove an item complete omits it instead of returning partial
   text.
3. It then forwards `turn/started`, `item/started`,
   `item/agentMessage/delta`, `item/completed`, `turn/completed`, and relevant
   settings/goal events immediately.
4. The browser reducer derives message flow and `working` from those events.
5. Switching panels removes the detailed-flow subscription. The backend still
   consumes terminal lifecycle for durable delivery, but does not retain or
   forward inactive panels' deltas.
6. Initial load and reconnect use one convergence reducer keyed by turn/item
   ID. Complete snapshot items are authoritative replacements. Buffered
   `item/started` and delta events for those same complete IDs are discarded;
   buffered `item/completed` remains an idempotent replacement. An item absent
   from the snapshot is built from ordered buffered/live events only when this
   subscription observed its `item/started`. If its first observation is a
   delta, the panel joined that item in progress: it shows a non-message
   "joined in progress" placeholder and withholds the suffix body until
   `item/completed` replaces it exactly. A bounded browser row retained from a
   prior foreground subscription may seed the item only when its stable ID
   matches. Turn terminal evidence is merged by turn ID and cannot be
   downgraded by the history page.
7. Request/subscription IDs reject an old browser generation. A bounded event
   buffer has byte and item limits; overflow aborts bootstrap and returns a
   visible retry state rather than a partial timeline.

This contract deliberately does not compare or overlap raw text. The Codex
delta protocol has no offset, so merging a partial active snapshot with deltas
would be ambiguous when text repeats. Provider adapters must therefore mark
only complete history items as snapshot rows. If a future provider exposes an
atomic snapshot revision or offset-bearing deltas, its adapter may add an
equivalent exact convergence strategy. A protocol-violating partial row is
rejected; `item/completed` is the exact repair boundary. No backend event body
or replay log survives the foreground subscription.

Session-list status is event driven. The WebSocket receives lightweight
`session-state` changes from `NativeSessionState`; there is no Web UI polling
interval. On initial socket connection it receives the current in-memory view.
Unknown or disconnected state displays `unavailable`, never the last persisted
status.

QiYan's main panel continues to load the durable owner conversation because it
also contains worker relays and system notices that are not native assistant
items. While the panel is active, native assistant items are overlaid live.
Confirmed assistant deliveries are not rebroadcast as duplicate bubbles to a
socket that already observed the same native item; a reload obtains the durable
conversation normally.

## 10. Auto-unadopt isolation

`session_rollout_ownership`, managed epoch boundaries, owned turn markers, and
the ownership monitor remain. They are placed behind an interface whose only
observable result is one of:

- owned: continue the requested worker operation;
- external: transition that exact mapping to unadoption;
- inconclusive: fail or defer that exact ownership-sensitive operation.

Ownership evidence must not update `NativeSessionState`, restore capacity,
change Web UI status, gate terminal finalization/delivery, or block the
assistant/other mappings. Native capacity is released on a current-generation
terminal event regardless of ownership scan health. A terminal belongs to
QiYan delivery only when durable accepted-dispatch correlation identifies its
client/turn; this is an idempotent delivery fact, not liveness. Unknown external
finals are ignored by delivery while the ownership subsystem independently
unadopts the exact mapping. The existing periodic ownership scan remains the
only explicit exception to the no-stored-status rule.

An inconclusive ownership scan may fail or defer the exact new worker mutation
it protects, but it cannot suppress an already-correlated QiYan final or delay
unrelated mappings.

## 11. Provider adapters

The volatile reducer consumes a provider adapter contract rather than assuming
all providers have Codex semantics:

- **Codex:** current-generation App Server resume/read, lifecycle, item, delta,
  and terminal events are authoritative. Start/steer responses use Codex turn
  identity semantics.
- **Claude:** only a child process handle owned by the current `ClaudeRuntime`
  generation proves `active`. A cold transcript with an incomplete last row is
  historical interrupted/unknown, never a live process. The adapter
  synthesizes started/status/completed events from child creation and exit. A
  queued steer response does not replace the running child turn ID. Foreground
  Claude flow remains terminal plus targeted snapshots until the runner can
  emit rich item/delta events.

Claude implements `thread/turns/list` and `thread/items/list` over positional
JSONL windows. Turn pages transfer at most 256 KiB from the worker host, exact
turn/full-history operations at most 4 MiB, and cursors pin device, inode, and
size. Replacement, truncation, append races, an oversized record/turn, or an
exact turn outside that bounded window fails explicitly. Local reads use
positional file I/O; remote reads parse a byte-capped SSH response. There is no
`thread/read(includeTurns: true)` compatibility fallback in the generic history
reader.

Claude therefore has no refresh race or reconstructed live-turn cache: child
spawn is the start boundary, child exit is the terminal boundary, and process
loss invalidates that runtime generation. Transcript reads are history and
final-content recovery only.

Provider-specific tests enforce these differences; generic code cannot infer
live state from a reconstructed Claude transcript.

## 12. Dashboard and public status APIs

- `get_session_status` and assistant self-status perform a current-generation
  native read or return unavailable; they never read persisted native status.
- `/api/sessions` combines registry identity with the volatile native view.
- The dashboard keeps registration, last sent/final facts, pending settings,
  token usage, goal facts, and timestamps. Its schema contains no current or
  historical native liveness fields.
- Model, effort, and goal displayed as current come from native resume/read and
  events. Pending user-selected settings remain durable until applied.

## 13. Failure behavior

| Failure | Required result |
| --- | --- |
| App Server connection ends | Invalidate generation; status becomes unavailable immediately |
| Completion event is missed | Reconnect snapshot plus bounded delivery-cursor recovery |
| Start response is lost | Reconcile that client ID against a bounded suffix |
| Steer response is lost at terminal boundary | Finalize the turn; reconcile/requeue/fail only that steer |
| Native exact history is unsupported/corrupt | Open circuit and expose `needs_attention`; do not loop or block |
| One mapping has corrupt recovery history | Degrade that mapping; keep the endpoint and healthy mappings ready |
| Old-generation event arrives | Ignore it |
| Same-generation refresh response loses a race with a newer event | Dispatch-revision fence rejects the stale response |
| ID-less idle event precedes a late start response | Start dispatch fence prevents resurrection; one bounded refresh resolves ambiguity |
| Browser is closed | Stop detailed forwarding; backend terminal delivery continues |
| Separate Codex process writes the managed rollout | Ownership subsystem may auto-unadopt that mapping only |

## 14. Verification invariants

Tests must establish:

1. Poisoned persisted `active_turn_id`, `native_status`, unavailable/restore
   management state, assistant lease, dashboard notification, and capacity
   receipt cannot make status working, force steering, block a start, restore
   capacity, authorize tools, or prevent terminal finalization.
2. A restart with a terminal assistant turn plus an uncertain steer requeues or
   isolates the steer and accepts the next input.
3. Endpoint loss changes live status to unavailable without a database read.
4. Reconnect repairs state with bounded requests and ignores old-generation
   events.
5. Completion-before-start-response, ID-less idle-before-start-response, and a
   physically late refresh response received after started/completed events
   cannot resurrect or downgrade a turn.
6. A status/event path never invokes full-history scanning.
7. Only the selected Web UI panel receives item/delta flow; all panels receive
   lightweight native status changes while a browser is connected.
8. With no browser, detailed Web UI flow work is zero while durable final
   delivery still occurs.
9. Auto-unadopt still detects an external turn, but its persisted evidence does
   not affect native status or capacity.
10. Inconclusive ownership cannot prevent a known QiYan terminal from releasing
    capacity and delivering; unrelated mappings continue.
11. Repeated restarts do not renew an uncertain input's deadline, and later
    inputs proceed after native terminalization.
12. Capacity bootstrap deduplicates snapshot/event/response observations and a
    partially unavailable endpoint does not prevent reachable work.
13. A corrupt mapping does not cause endpoint restart or block a healthy mapping
    on the same endpoint.
14. Claude cold incomplete history is not active, queued steer retains the
    child turn ID, and lack of rich deltas is handled explicitly.
15. Cursor recovery requires exact continuity, commits outbox+cursor atomically,
    and degrades on a gap larger than its budget.
16. Every accepted assistant input reaches delivered, pending/requeued, or
    visible `needs_attention` within a finite durable recovery budget.
17. Schema migration drops the mixed runtime-status table and singleton
    assistant lease; no production source imports an obsolete compatibility
    status API.
18. Web bootstrap merges complete snapshot items and overlapping buffered
    events by stable ID without duplicate text; an adapter-provided partial
    active item is rejected and the eventual complete item repairs it exactly.
19. Joining after an item's start/prefix never renders its observed suffix as
    a normal contiguous message; completion or an exact retained stable-ID row
    is required to show the full body.

## 15. Implementation plan

1. Add failing unit tests for volatile generation fencing, poisoned legacy
   state, and one-shot schema migration. Implement `NativeSessionState` and its
   serialized notification reduction.
2. Wire endpoint ready/loss/resume and provider lifecycle notifications into
   the serialized volatile reducer. Add current-generation receive sequencing,
   terminal-before-start handling, provider adapters, and the capacity bootstrap
   barrier. Replace status reads and Web UI polling with its events.
3. Introduce the focused control/delivery stores, migrate allowed data, and
   switch worker dispatch, steering, interrupt, and capacity reconstruction to
   current-generation native state or one bounded refresh. Delete
   `RuntimeStore`, the mixed `session_runtime` table, and active-claim restore
   logic.
4. Replace the assistant singleton-lease arbiter with per-input durable
   reconciliation plus an in-memory native submission arbiter. Decouple
   terminal finalization, add the owner-visible bounded failure outcome, migrate
   existing unresolved inputs with their original-age deadlines, and drop
   `assistant_turn_lease`.
5. Generalize the foreground Web UI subscription so QiYan and workers use the
   same snapshot-plus-live reducer. Prevent final-delivery duplication.
6. Separate terminal delivery correlation from ownership inspection; make
   endpoint readiness transport-only and mapping recovery circuit-scoped.
7. Remove every persisted liveness surrogate and obsolete interface, including
   native status/turn, unavailable/restore state, assistant leases, old
   lifecycle notifications, direct capacity restoration, Web status polling,
   and compatibility status writers. Isolate ownership interfaces and document
   the exception.
8. Update dashboard schema/API documentation, run focused fault-injection
   tests, verify the committed Web UI asset is rebuilt from its typed source,
   then run `npm run check`.

Each slice must be independently testable, but the final merge is atomic: no
dual old/new status path is shipped. The cutover is complete only when a
repository search and interface audit show no persisted liveness surrogate or
obsolete compatibility API reaches dispatch, capacity, tool admission,
terminal, endpoint availability, dashboard, or Web UI status paths. This
redesign supersedes the durable-active-turn authority in
`bounded-codex-recovery-design.md`; its bounded history and `excludeTurns`
requirements remain, but not its stored active-turn fallback.
