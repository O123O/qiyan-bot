# Web UI worker message-flow repair

## Incident and evidence

The `sparse-att-scale` worker was not stalled and its direct Web UI input was not lost. The
registered prenyx App Server, SSH proxy, remote process, and active turn remained live. A fresh
foreground WebSocket subscription received the worker's `item/started`, agent-message deltas, and
`item/completed` notifications while the turn continued. The native rollout also continued to
advance.

The misleading symptoms came from the foreground browser timeline:

- a live row was retained across a tab switch only while its turn was nonterminal; after completion,
  a bounded history page that omitted the row caused it to be discarded;
- a bottom-pinned panel scrolled only when the number of rendered rows changed, so additional deltas
  growing the last row moved below the viewport without following them;
- the native history reader is intentionally bounded and can return fewer visible messages than the
  requested page size for tool-heavy turns, while the client automatically followed only an empty
  page. If that sparse page did not fill the viewport, no scroll event requested the continuation.

Codex App Server history and its live notification stream are complementary. The supported client
lifecycle is to reconstruct conversation history and keep reading active-turn notifications. In the
observed Codex build, paged history did not reproduce every intermediate commentary notification
that had been emitted during a long turn. Absence from one bounded page therefore cannot prove that
a browser-observed row is invalid.

## Constraints

- Worker message flow remains a Web UI-only feature.
- Only the foreground worker is subscribed and read.
- QiYan does not persist worker deltas or maintain a backend replay buffer.
- Native rollout files are not read or watched.
- Browser retention and automatic continuation remain count- and byte-bounded.
- Completed-turn delivery to QiYan and other chat adapters is unchanged.

## Repair

1. Retain the most recent bounded browser timeline rows across worker-tab switches, including rows
   from a turn that completed while it was visible. Preserve those rows when the immutable mapping
   ID is unchanged; a mapping change still drops them before any snapshot merge. Stable native item
   IDs deduplicate retained and history rows.
2. Follow growth of the last rendered message while the panel is pinned to the bottom. Do not change
   scroll position while the user is reading older messages or while a prepend is being preserved.
3. After a sparse history response, automatically follow its exclusive continuation only while the
   rendered panel still cannot scroll. Stop once the viewport is filled, history ends, the panel is
   switched, or the existing bounded continuation budget is exhausted. Manual scroll-up continues
   lazy pagination after that.
4. Make foreground subscription requests idempotent for the same open WebSocket, nickname, and
   mapping ID so overlapping socket-open and tab-selection effects cannot reset the reducer or create
   a short event gap. A new socket, worker, or mapping still creates a fresh subscription. Explicit
   unsubscribe, socket close, and `worker/subscription-error` invalidate the guard so a server-pruned
   subscription can retry the identical target.

## Verification

- Reducer tests cover completed live-row retention, same-mapping snapshot merge, mapping replacement,
  stable-ID deduplication, and all existing memory caps.
- Client policy tests cover sparse-page continuation, a bounded stop, and idempotent subscription
  identity including invalidation after rejection.
- Scroll-policy tests cover same-row body growth while pinned, no following while unpinned, and
  prepend-position preservation.
- Existing Web UI stream/history tests, client build, and `npm run check` must pass.
