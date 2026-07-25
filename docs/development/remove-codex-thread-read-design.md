# Remove production Codex `thread/read`

## Problem

Codex `thread/read` may reconstruct an entire rollout even when
`includeTurns:false` is requested. Large sessions therefore make status checks,
endpoint lifecycle operations, and recovery time out. Several callers also
treated one RPC as the source of truth for unrelated facts: live turn state,
immutable registry identity, current settings, and historical messages.

## Design

Production Codex code will not call `thread/read`.

Each fact has one source:

- Live availability, status, and active turn: `NativeSessionState`, populated
  from the bounded response to `thread/resume` and subsequent App Server
  notifications for the current endpoint generation. When current-generation
  evidence says active but omits the turn id, a generation/revision-fenced
  `thread/turns/list` probe requests only the newest turn with
  `itemsView:"notLoaded"`. Only an exact nonterminal result is bound as active;
  every other result remains unknown and fails closed. The same probe settles
  an unmatched completion without scanning older turns. Notification-triggered
  repairs capture the lifecycle revision before queuing, so a newer live event
  cancels the stale repair before it can issue an RPC.
- Nickname, endpoint, thread id, and cwd: the atomic managed-session registry.
  Workspace policy revalidates the registry cwd before a mutation.
- Current model and reasoning effort: bounded `thread/start` / `thread/resume`
  responses are persisted in the dashboard observation store, plus the existing
  pending-setting store. Effort validation fails closed when no current model is
  known.
- Human-visible Codex conversation: one shared, bounded rollout JSONL history
  service for both the foreground Web UI and `inspect_worker_conversation`.
  It reads local byte ranges or the same bounded byte ranges through the remote
  helper, caches only the latest bounded page, and pages older content by opaque
  byte cursor.
- Exact structured turns needed for durable recovery, terminal delivery,
  compaction evidence, idempotency proof, or the narrowly scoped missing-active-
  turn-id repair above: the existing bounded `thread/turns/list` / exact-item
  reader. This is not used for UI history or routine status polling.
- Thread creation and reconnect: `thread/start` or
  `thread/resume` with `excludeTurns:true`; their bounded response seeds live
  state and rollout location metadata.

Claude keeps its endpoint-local `thread/read` emulation because it reads a
bounded in-memory/process transcript rather than a Codex rollout.

## Call-site replacements

- Assistant identity recovery verifies the bounded `thread/resume` response.
  New identity creation verifies `thread/start`, sets the name, then resumes
  with `excludeTurns:true` to verify the finalized identity.
- Managed-session recovery always resumes with `excludeTurns:true` because a
  new App Server generation must subscribe to the thread anyway. Removal
  reconciliation directly performs the idempotent unsubscribe/archive
  operation and handles exact absent/not-loaded responses. Claude's managed
  resume receives the registry cwd and recreates an empty in-memory thread when
  no transcript exists. Any exact no-rollout response after that attempt,
  including Codex no-rollout evidence, removes the non-restorable mapping.
- Session mutations require a current, ready `NativeSessionState` view and
  revalidate the registry cwd. Status reads return the event-driven view without
  issuing an RPC. Ambiguous turn recovery uses bounded exact-turn history.
- Endpoint restart/disconnect proves every managed thread idle from current
  generation native views. Missing, stale, active, error, or unknown views
  block shutdown.
- Assistant startup applies the status in the resume response. An active
  response without a turn id, an id-less active notification, or an unmatched
  completion uses the fenced one-turn metadata probe; it never triggers an
  unbounded refresh.
- Recovery helpers combine registry metadata, current native state, and bounded
  turn pages instead of decorating `thread/read`.
- The unused full-thread pool helper is removed.

## Invariants

1. No production Codex request uses `thread/read`.
2. No history scan or disk read is used merely to determine live status. The
   only status repair is one newest-turn metadata page when active identity is
   otherwise unknowable.
3. Unknown live state is never converted to idle from persisted history.
4. Human conversation parsing has one shared rollout JSONL implementation.
5. Every history read is bounded in bytes or bounded by native page/scan
   budgets; no polling runs while the Web UI is inactive.
6. Reconnect/adoption never transfers turns across the App Server WebSocket.

## Verification

- A source-level regression test rejects production `thread/read` outside the
  Claude endpoint adapter and generated protocol files.
- Unit tests prove status/mutations and endpoint idle checks use native state
  without a read RPC.
- Reconnect, id-less-active-notification, and unmatched-completion tests prove
  the fenced one-turn metadata repair cannot overwrite newer lifecycle state.
- Identity and lifecycle tests require resume-with-excluded-turns behavior.
- Web UI and assistant inspection tests exercise the same shared rollout
  history service for local and remote slices.
- Run targeted tests, `npm run check`, then re-review the aggregate change.
