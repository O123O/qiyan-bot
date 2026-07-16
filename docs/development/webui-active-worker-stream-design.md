# Web UI active-worker event stream

## Goal

Make the foreground worker chat panel live from Codex App Server events without
continually re-reading native history. Each browser follows at most one worker:
selecting a worker installs its subscription, loads one bounded history snapshot,
and then applies that worker's live events. Switching panels immediately replaces
the subscription. A background worker continues through QiYan's existing lifecycle
and recovery paths, but QiYan does not track its detailed message flow.

QiYan remains a multi-chat bot. Completed worker turns continue through the
existing chat-neutral final-message, assistant-awareness, and adapter delivery
paths for Telegram, Slack, WeChat, and the Web UI. Subscriptions, deltas,
optimistic bubbles, and timeline merging are Web UI presentation features only;
they do not change the behavior or contracts of other chat adapters.

The existing one-second session-list refresh remains. It reads QiYan's local
registry/dashboard state for status dots and goals; it does not read worker
transcripts or poll Codex.

## Why this model

Codex App Server already publishes the authoritative turn and item lifecycle:
`turn/started`, `item/started`, `item/agentMessage/delta`, `item/completed`, and
`turn/completed`. `item/completed` is the final item value, while
`turn/completed` is lifecycle metadata and must not be treated as a transcript.
The managed endpoint's shared App Server stream necessarily receives these
protocol notifications. QiYan must not turn that into global message tracking:
for detailed item/delta notifications it performs only a constant-time active-
subscriber lookup, then returns without inspecting, normalizing, storing, or
forwarding the payload when no Web UI is viewing that endpoint and thread.

This follows Codex-Web-UI's important property—build the visible timeline from
App Server notifications—but narrows its replay architecture to QiYan's lazy
panel. QiYan will not maintain a browser replay stream for every worker when no
browser is viewing it. A bounded `thread/read` is reserved for panel entry,
browser reconnect, explicit history paging, and recovery after a gap. That read
reconstructs the browser timeline from Codex's durable `userMessage` and
`agentMessage` items, including commentary/intermediate agent messages; QiYan
does not copy those items into its own persistence.

## Fixed behavior

- Each WebSocket has zero or one active worker nickname.
- Selecting the assistant panel unsubscribes the worker.
- Selecting a worker subscribes before requesting its history snapshot. Live
  events received while that snapshot is in flight are buffered by the client,
  then merged after the snapshot using stable turn/item IDs and terminal state.
- Switching workers discards the old panel's transient state and subscription.
  Returning later performs a fresh lazy snapshot.
- A WebSocket reconnect re-subscribes to the current foreground worker and takes
  a fresh snapshot. No server-side event ring is required for the first version.
- Worker events are inspected and sent only when at least one Web UI socket is
  subscribed to that worker. There is no backend timeline, event replay buffer,
  unread state, or background message-flow persistence. Session-list and
  assistant-message broadcasts keep their current behavior.
- The 900 ms post-send transcript reload and the idle-status transcript reload
  are removed for Codex workers. The Web UI initiates no additional Codex
  `thread/read` on send or completion. This does not affect core terminal
  reconciliation, which may perform its own authoritative history read.
- Claude currently publishes only `turn/completed`, without item/delta events.
  While a Claude worker is selected, its targeted `turn/completed` event triggers
  one Web-UI snapshot, deduplicated by turn ID. This does not depend on the
  one-second session-summary poll, so fast turns are not missed. Inactive Claude
  workers are never read for chat.
- Normal completed-turn processing remains global because it is a core QiYan
  capability used by every chat adapter; only detailed in-progress flow is
  subscription-gated and Web-UI-specific.

## Browser protocol

### Subscription

The browser sends:

```json
{ "type": "worker/subscribe", "nickname": "sparse-att-scale", "requestId": "uuid" }
```

or:

```json
{ "type": "worker/unsubscribe", "requestId": "uuid" }
```

The server strictly validates `requestId` as a canonical UUID with a fixed input
length, validates the nickname against the current registry, atomically replaces
the socket's subscription, and replies with one of:

```json
{ "type": "worker/subscribed", "nickname": "sparse-att-scale", "requestId": "uuid", "subscriptionId": "server-uuid" }
{ "type": "worker/unsubscribed", "requestId": "uuid" }
{ "type": "worker/subscription-error", "requestId": "uuid", "code": "unknown-worker" }
```

The acknowledgement also contains a cryptographically random, server-generated
`subscriptionId`. It is unique among active sockets and is included on every
event. The browser ignores acknowledgements and events whose request ID or
subscription ID is no longer current. After `worker/subscribed`, it starts the
messages GET with `subscriptionId`; the server rejects a missing, unknown, or
nickname-mismatched ID. The read uses the subscription's stored endpoint,
thread, and mapping ID rather than independently resolving the nickname. Before
starting the native read, the server verifies that exact identity against the
current registry. After the raw native read resolves, it rechecks both the
socket's still-active subscription and the full current registry identity before
extracting any message text or sending the response. A client-chosen UUID
therefore never identifies a socket across a separate HTTP connection, and a
nickname rebind during the read cannot disclose the old or new thread.

The read is passive and atomic: production acquires
`EndpointManager.withReadyWorkLease(endpointId, ...)`, then passes that existing
lease and the reader's `AbortSignal` to `pool.request`. `withReadyWorkLease`
fails unless that exact endpoint generation is already ready and never requests
activation. The existing lease prevents the pool's work-lease provider from
falling through to activating `withWorkLease` between a boolean readiness check
and the request. Opening a panel must never activate/bootstrap or dial an
unavailable local, SSH, or MFA endpoint; that case returns an explicit unavailable
error without activating or dialing it.

Because the subscription is installed before the acknowledgement is sent, no
event can fall between subscription and snapshot start. Matching events are
buffered until the snapshot resolves, then merged using the rule below.

### Snapshot/live merge without a transport-order assumption

Wire ordering does not prove that App Server `thread/read` is a linearizable
snapshot, so QiYan does not discard events based on an assumed time watermark.
The snapshot response identifies terminal turn IDs and any open turn IDs:

- Rows from terminal snapshot turns are authoritative and keyed by native turn
  and item ID. They carry native turn/item order so recovered commentary is
  restored before later commentary and the final answer even when the turn's
  items share one completion timestamp. Replayed `item/started` is ignored,
  `item/completed` idempotently replaces the same item, and deltas for an
  already-finalized item are ignored.
- Rows from an open snapshot turn are not installed. Buffered events for that
  turn build the forward stream from subscription time; `item/completed`
  eventually supplies the authoritative full item text.
- Opening midway through a turn can omit items that completed before the
  subscription. For each open snapshot turn, the client first checks its buffered
  events: a matching `turn-started` proves the turn was fully observed after the
  subscription, so no recovery read is needed. Only an open turn without that
  buffered start is recorded as a true mid-turn join. Its targeted
  `turn/completed` event triggers one selected-worker recovery operation,
  deduplicated by turn ID, which merges the now-terminal native items by stable
  ID. Recovery is complete only when the native response explicitly proves that
  turn terminal. A failed or not-yet-terminal proof remains queued for at most
  three short, bounded active-panel retries; it never becomes a background
  poller. A successful recovery also advances the exclusive older-page cursor
  to the recovery page, so omitted items from a turn longer than one page (or
  rows completed while recovery waited) remain reachable by scroll-up and are
  deduplicated by stable ID. Codex turns that start after initial subscription
  need no completion read, even when they overlap the initial native snapshot.
- A turn absent from the snapshot is built entirely from buffered/live events.

This rule may temporarily show only the post-subscription suffix of an item that
was already streaming when the panel opened, but it never guesses whether a
delta was included in a snapshot. The authoritative `item/completed` or the one
mid-turn-join recovery snapshot repairs it. No event body or replay log is kept
by the backend.

### Normalized worker events

When an active Web UI subscriber exists, the backend forwards only the fields
needed by that browser timeline. It does not expose arbitrary raw notifications:

```ts
type WorkerChatEvent =
  | { kind: "turn-started"; turnId: string }
  | { kind: "turn-completed"; turnId: string; status?: string }
  | {
      kind: "item-started" | "item-completed";
      turnId: string;
      item: WorkerChatItem;
      atMs?: number;
    }
  | {
      kind: "agent-message-delta";
      turnId: string;
      itemId: string;
      delta: string;
    };

type WorkerChatItem =
  | {
      type: "user-message";
      id: string;
      clientId?: string;
      text: string;
    }
  | {
      type: "agent-message";
      id: string;
      text: string;
      phase?: string;
    };
```

Each event is wrapped with `type: "worker/event"`, the nickname, the client
request ID, and the server-generated subscription ID. Attachments and other item
types are excluded in this change. Message bodies are never logged.

## Input correlation and duplicate prevention

Before POSTing input, the browser creates a canonical UUID and includes it as
`clientInputId`. The server rejects non-canonical UUIDs and values outside the
fixed input length before ingress. The web ingress uses `web:<clientInputId>` as
the canonical source ID. The existing direct-to path derives
`clientUserMessageId = to:web:<clientInputId>`, passes it to App Server, and the
HTTP response returns that exact ID.

The deterministic native ID is part of the Web UI protocol, so the browser keys
the optimistic user bubble by `to:web:<clientInputId>` immediately, without
waiting for the HTTP response. When App Server
publishes the native user-message item with the same `clientId`, the reducer
replaces the optimistic bubble with the native item. There is no text-based or
timing-based deduplication. Repeating an HTTP request with the same
`clientInputId` also reuses the existing ingress idempotency key.

## Client timeline reducer

Timeline state is isolated in a pure reducer so ordering and deduplication can be
tested independently from React:

- Snapshot and native items use stable item IDs, including turn and item IDs.
- `agent-message-delta` creates or appends to one draft keyed by `itemId`.
- `item-completed` replaces that draft with the authoritative full text.
- A native user item consumes the optimistic item with matching `clientId`.
- Reapplying the same native item replaces it rather than appending a duplicate.
- `turn/completed` marks lifecycle only; it does not synthesize a message.
- Events for a stale nickname, request ID, or server-generated subscription ID
  are ignored.

The selected worker can therefore show intermediate agent text immediately,
even when Codex does not call QiYan's `send_message` tool.

## Boundary between QiYan core and the Web UI

- `ManagedAppServerEndpoint.onNotification` remains the shared App Server input
  used by QiYan core. The existing `turn/completed` lifecycle/final-message path
  runs as it does today for every worker and every chat surface.
- `production-app.ts` contains only one non-owning integration call that offers
  the endpoint ID, method, and params to a Web UI observer. It does not import
  worker-timeline event types, extract message text, or maintain subscription
  state. A no-throw boundary contains every observer failure, so it cannot
  consume the notification or alter core routing.
- Web UI subscriptions are resolved at subscribe time to the worker's endpoint
  and thread identity plus registry `mapping_id`. `WebBus` stores only that
  identity, nickname, mapping ID, request ID, and subscription ID per
  socket—never
  messages or a timeline—and exposes a constant-time
  `hasWorkerSubscriber(endpoint, threadId)` interest check.
- `src/webui/worker-stream.ts` owns all App Server-method recognition, the
  active-interest check, item mapping, and text extraction. With no interest,
  Web UI handling ends immediately. With interest, the event is normalized and
  synchronously forwarded to matching sockets without retaining it.
- After an interest hit and before text extraction, the observer compares each
  subscription's stored `mapping_id`, endpoint, and thread with the current
  registry entry for its nickname. A removed, renamed, or replaced mapping is
  unsubscribed and notified as invalid; it receives no message content.
- The existing endpoint-generation fence remains authoritative, so
  notifications from replaced endpoints are ignored.
- Existing observation, terminal relay, reconciliation, and assistant delivery
  paths are unchanged. Web streaming is an additional ephemeral observer and
  must not consume, short-circuit, or redefine their notifications. It does not
  publish detailed flow to Telegram, Slack, WeChat, or other adapters.
- `web-reads` retains a raw native `thread/read` for the lazy snapshot and future
  paging. The HTTP worker-history route requires the active subscription ID, so
  it cannot initiate reads for a background panel. It validates the stored full
  identity before the read and again after it, then maps text. It is not a live-
  update mechanism. The existing Web-UI-only native transcript
  mapper moves from `src/sessions/worker-conversation.ts` to `src/webui/` and is
  extended to expose all visible native agent-message items with stable IDs and
  phases, not just final answers. Its tests move under `tests/webui/`.
- Web UI history pages include terminal turns only; open-turn IDs are separate
  merge metadata and cannot consume the response page. Older-page navigation
  uses a server-generated exclusive opaque cursor containing timestamp plus
  native turn/item order, so a turn with more than one page of same-timestamp
  commentary always makes progress without skipping or repeating rows.
- `src/webui/worker-history-reader.ts` bounds native reads. It keys in-flight
  work by exact endpoint/thread identity, passes an `AbortSignal` through to
  `pool.request`, and allows at most one native `thread/read` for that identity.
  Compatible active subscriptions may share the same raw-turn promise and map
  their own page only after their individual post-read identity validation. A
  second overlapping GET from the same subscription is rejected as already in
  progress rather than queued. Unsubscribe, socket close, subscription
  replacement, and server stop remove that consumer; when no valid consumer
  remains, the reader aborts the native request and skips mapping. This
  bounds local request state and full-history mapping even if the remote RPC has
  already begun.
- Each HTTP request is itself a consumer. Request abort or response close detaches
  it immediately even if its WebSocket remains subscribed, so a cancelled GET
  cannot keep an otherwise-unused native read alive.
- Codex `thread/read` currently has no native cursor/limit: the HTTP response is
  bounded to the requested 1–50 mapped messages, but App Server may return the
  full native turn history before local mapping. The design does not claim that
  RPC cost is bounded. Reducing calls to panel entry/reconnect is the available
  improvement until Codex exposes paged thread reads.
- All detailed timeline accumulation, snapshot/event buffering, optimistic-item
  correlation, and delta reduction lives in `webui-client`, not the bot core.

## Failure and race handling

- Unknown/deleted workers fail subscription without retaining an old worker.
- A tab switch invalidates the old request ID before the new request is sent, so
  late snapshot results, acknowledgements, and events cannot enter the new
  panel.
- A failed snapshot leaves the live subscription active and shows an error; it
  is never converted into an empty successful snapshot. A completion-recovery
  failure remains queued and uses only the bounded active-panel retry sequence
  above while buffering subsequent events.
- Socket disconnect removes its subscription. Reconnect uses a fresh request ID
  and snapshot, repairing any missed interval.
- A history request is accepted only for an already-ready endpoint and one
  active exact subscription. Duplicate reads for that subscription return a
  retryable conflict. Switching tabs or disconnecting cancels that consumer;
  closing the HTTP request also detaches it. The underlying identity read is
  aborted as soon as it has no consumers.
- The browser serializes history reads per subscription. If a selected Claude
  completion or required Codex mid-turn recovery arrives during initial history
  or load-older paging, it records the completion turn ID and runs one recovery
  snapshot immediately after the current read settles, provided the same
  subscription and unrecovered turn remain current. The native response must
  explicitly list that turn as terminal before recovery is marked complete;
  failures remain queued. When one turn exhausts its bounded retry budget, only
  that turn leaves the queue and the next queued completion is drained. Recovery
  has priority over any next paging request. Thus the server's duplicate-read
  rejection cannot discard a legitimate completion.
- The server sets a small fixed inbound WebSocket `maxPayload`; subscription
  commands exceeding it close the connection. Before every outbound worker
  event, `bufferedAmount + payloadBytes` is checked against a fixed 1 MiB cap.
  Crossing the cap clears the subscription and closes the socket with a retryable
  status, so browser reconnect plus a native snapshot recovers without an
  unbounded backend queue.
- The browser's pre-snapshot event buffer is capped at 2,048 events and 1 MiB of
  encoded content. Crossing either cap closes the socket and discards the
  partial buffer; reconnect starts from a new snapshot.
- If the backend restarts, the browser reconnect path provides the same repair;
  QiYan does not persist browser-delivery cursors.
- WebSocket event order is preserved in the client buffer. Snapshot overlap is
  resolved by stable IDs and terminal/open turn state, not by an unproven
  ordering relationship between App Server notifications and RPC responses.

## Implementation plan

1. Add protocol and bus tests proving one active subscription per socket,
   strict validation, targeted delivery, switching, unsubscribe, cleanup,
   unique server subscription IDs, mapping invalidation, and outbound
   backpressure.
2. Add `src/webui` notification-gating/mapping tests proving uninterested item
   events are not inspected or forwarded, while active user/agent items and
   deltas are normalized. Add a narrow production wiring test for the existing
   endpoint-generation fence and non-consuming observer call.
3. Add Web UI history-reader tests for the already-ready guard, one shared native
   read per endpoint/thread, duplicate-subscription rejection, switch/close
   and HTTP-abort cancellation, last-consumer abort, existing ready-lease
   propagation, and post-read identity validation before mapping.
4. Add pure client reducer tests for optimistic/native user correlation, delta
   accumulation, completion replacement, terminal/open-turn snapshot merge,
   post-subscription turn-start overlap, true mid-turn recovery, bounded
   buffering, authoritative-start replay, native item ordering, provable and
   retryable completion-during-paging recovery for both Claude and Codex, and
   stale nickname/request/subscription event drops.
5. Move the existing native transcript mapper into `src/webui/` and test that a
   Codex snapshot reconstructs user, commentary, and final agent messages
   without QiYan persistence.
6. Implement WebSocket command parsing and per-socket subscriptions in the web
   server and bus.
7. Implement the constant-time interest gate and event normalization entirely
   under `src/webui/`, then add the single production integration call without
   changing lifecycle/reconciliation/final-message routing.
8. Add strictly validated `clientInputId` to worker input and return its native
   correlation ID.
9. Replace worker-panel reload triggers with subscribe → lazy snapshot → live
   reducer behavior. Resubscribe on WebSocket reconnect and unsubscribe on the
   assistant panel. Preserve one deduplicated completion snapshot for a selected
   Claude worker, which has no detailed event stream, and for a Codex turn that
   was already open when its panel subscribed.
10. Run focused tests, client build, and `npm run check`.

## Acceptance criteria

- On the normal fully-observed Codex path, opening a worker performs exactly one
  transcript read and then renders intermediate and completed API events without
  further automatic reads. The only defined exceptions are a selected Claude
  completion and recovery of a Codex turn already open before subscription.
- Reloading or reconnecting reconstructs previously persisted commentary and
  final messages from Codex's native session rather than a QiYan timeline copy.
- Switching workers stops all old-worker chat delivery to that browser.
- A background worker item/delta event is neither normalized, retained, nor sent
  when no Web UI browser subscribes to its endpoint and thread.
- Opening an unavailable worker does not activate or dial its endpoint. Rapid
  switching cannot leave unbounded native history reads or mapping work.
- A direct user message appears once before and once after native confirmation,
  with the same visible bubble rather than a duplicate.
- Agent deltas update one in-progress bubble and completion finalizes it.
- After item completion or the defined mid-turn recovery read, reconnect and
  snapshot/event overlap leave neither lost nor duplicated durable messages.
- A recovery page for a turn with more than one page of visible items advances
  the opaque cursor so every omitted item remains reachable without repeating a
  same-timestamp page.
- A stalled browser cannot grow an unbounded server or client event queue.
- A selected Claude worker refreshes once after its active turn completes;
  inactive Claude workers cause no transcript reads.
- Claude or mid-turn Codex completion during history paging is recovered after
  that read settles rather than being lost to a duplicate-read conflict; a
  failed or stale recovery snapshot is not misclassified as success.
- Assistant messages, session status/goal updates, worker lifecycle handling,
  completed-turn delivery to every chat adapter, and recovery behavior continue
  to pass their existing tests.
- `npm run check` passes, and no message content or credential is added to logs.

## Out of scope

Persistent browser replay cursors, tracking every worker while its panel is
closed, background unread counts, exposing detailed streams to non-Web-UI chat
adapters, attachment rendering, approvals/tool-call cards, and changes to the
assistant/worker delivery policy.

Core-level worker timeline abstractions or persistence are also explicitly out
of scope: this feature belongs to `src/webui/` and `webui-client/`.
