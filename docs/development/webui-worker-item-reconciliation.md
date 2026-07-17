# Web UI worker item reconciliation

## Problem

The foreground worker panel subscribes to native app-server notifications and then reads bounded
native turn/item history. QiYan currently omits every item from an in-progress turn. A panel that joins a
remote worker mid-turn therefore loses the current user message and any completed intermediate
agent messages until the turn finishes.

The HTTP snapshot and WebSocket events can cross in transit. Their text cannot be compared safely:
repeated text may be either an already-snapshotted delta or legitimate new output.

## Codex contract

Codex identifies every streamed item by `threadId`, `turnId`, and `itemId`. Its per-item lifecycle
is `item/started`, zero or more ordered item-specific deltas, and `item/completed`; the completed
item is authoritative. Rows returned by native history contain complete messages rather than an
actively streaming partial message. A bounded page is not proof that every previously emitted
intermediate notification is present.

An in-progress turn can therefore contain two different kinds of state at once:

- completed user and agent-message items available from bounded native history;
- a newer active item available only through live notifications until `item/completed`.

## Design

The foreground-only Web UI flow reconciles by native item identity:

- include terminal and in-progress turn rows in the bounded history page;
- treat every agent-message row returned by history as a completed item even when its turn remains
  open;
- hydrate every snapshot item by `turnId + itemId`;
- while the initial snapshot is pending, keep the existing bounded live-event buffer;
- when replaying that buffer, discard `item/started` and deltas only for item IDs already present in
  the snapshot, because the snapshot proves those items completed; replay events for all other item
  IDs normally;
- always accept `item/completed` as the authoritative replacement;
- keep the last 50 live `turn/completed` statuses so a stale older-page response cannot reclassify
  a completed turn as open, while still trusting a later terminal history status during recovery;
- preserve the byte/count-bounded recent browser timeline across tab switches when the immutable
  worker mapping is unchanged; stable item IDs let returned history replace matching retained rows;
- keep the existing one-shot completion recovery for a turn joined after `turn/started`, so a
  partial live item is repaired if the panel missed its prefix;
- retain Claude's existing completion recovery path; Claude does not use Codex delta semantics.

Older scroll-back pages only merge historical items. They do not classify a live turn or alter the
initial snapshot buffer.

## Non-goals and invariants

- No rollout-file watching or polling.
- No backend persistence of worker message flow.
- No subscriptions for inactive worker panels.
- No change to general final-message relay for Telegram, Slack, WeChat, or other chat adapters.
- Existing WebSocket byte limits, browser event-buffer limits, draft-cache limits, and history page
  limits remain in force.

## Verification

Tests cover open-turn history, distinct completed and active items in the same turn, snapshot/event
deduplication by item ID, authoritative completion, bounded pagination, tab retention, recovery,
and buffer limits. Run focused Web UI tests, both TypeScript checks, and `npm run check` before
deployment.
