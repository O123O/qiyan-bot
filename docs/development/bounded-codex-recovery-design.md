# Bounded Codex Recovery

## Problem

Codex `thread/resume` traditionally returns every reconstructed turn in one JSON-RPC response. QiYan's remote App Server transport intentionally limits WebSocket frames to 1 MiB, so a long-lived worker can close the connection during recovery. Raising the frame limit only postpones the failure and increases resource exposure.

Using `thread/resume { excludeTurns: true }` fixes only the first response. Endpoint recovery also reconciles capacity claims, missed terminal deliveries, queued observations, and the assistant's startup state. Those paths must not follow the lightweight resume with `thread/read { includeTurns: true }`.

`excludeTurns` changes only the response projection. Codex still reconstructs the persisted rollout into the resumed model session, so future turns retain their prior context. It does not truncate or rewrite the rollout.

## Design

QiYan requires Codex 0.144.4 and uses its experimental paginated history APIs for recovery:

- Resume every Codex thread with `excludeTurns: true`.
- Read thread status, cwd, and rollout path with `thread/read { includeTurns: false }`.
- Read recovery turn metadata through `thread/turns/list`, in descending order with `itemsView: "notLoaded"` and a page limit of 128. This keeps each response independent of message/tool-output size while avoiding one rollout reconstruction per individual turn.
- Read items only for an exact turn that recovery has already proved it needs, through `thread/items/list { turnId }` with a page limit of 16. On stores that support item pagination, this preserves every explicit `final_answer` item and the existing last-unphased-agent fallback.
- Codex 0.144.4 can reject `thread/items/list` with the exact `-32601 thread/items/list is not supported yet` error for a legacy thread store. For that exact error only, user/agent consumers fetch the exact turn through a one-turn `thread/turns/list { itemsView: "summary" }` scan. Recovery then deliberately retains only the summary's last agent response. All other item-list errors remain retryable failures. This recovery-only degradation is preferable to either dropping the terminal turn or full-reading a legacy rollout.
- Treat the exact pre-first-message `thread/turns/list is unavailable` error as an empty history, just like the existing exact `includeTurns is unavailable` case. Near-match errors remain failures.
- Keep the 1 MiB WebSocket frame limit.

The App Server transport owns a small typed page reader so session lifecycle, capacity claims, relay recovery, observations, assistant startup, and durable operation reconciliation share cursor validation and the exact empty-history/unsupported-items fallbacks. The reader does not persist message flow. Codex 0.144.4 reconstructs the rollout server-side for every legacy pagination request, so callers first scan 128 metadata-only turns at a time and request 16-item pages only for the usually tiny suffix of exact turns that must be recovered. A single provider item or summary text has no protocol byte bound; if one alone exceeds the 1 MiB transport limit, recovery fails safely and retries instead of weakening the transport limit. Ordinary history length can no longer make one response grow without bound.

The page reader enforces these invariants before exposing buffered results to a caller:

- Page cursors are opaque, non-empty when present, and must advance. A repeated cursor, duplicate turn/item ID, an empty page with a continuation cursor, or an invalid response is an uncertain operation and produces no side effects.
- A descending suffix scan buffers every result until it finds the requested durable delivery cursor or epoch baseline. If an anchor was expected but exhaustion occurs without finding it, the scan is uncertain: no delivery is committed and no cursor advances.
- With no expected anchor, normal exhaustion proves the beginning of the thread and makes the buffered suffix authoritative.
- An exact target missing before authoritative exhaustion is uncertain. Once an anchor is found, a target at or older than the anchor is conclusively outside the managed epoch; a newer target missing from the buffered suffix remains uncertain.
- Consumers reverse an authoritative descending suffix before applying changes, so commits remain chronological. A nonterminal turn stops terminal delivery and leaves later work pending.

### Provider contract

Pool and relay recovery are provider-neutral. Codex calls use App Server's native `thread/turns/list` and `thread/items/list` methods. `ClaudeCodeRuntime` implements the same methods over positional transcript windows: 256 KiB for turn pages and 4 MiB for an exact turn. Its opaque cursor pins device, inode, and size, and remote windows cross SSH through a byte-capped response. The generic reader has no full-thread provider fallback.

### Managed worker recovery

Recovery reads one latest `notLoaded` turn for the delivery baseline and ownership initialization, then resumes without turns. The current-generation native snapshot/notification is authoritative; a latest bounded turn page only resolves an ID-less active snapshot for ownership preparation. The exact pre-first-message pagination error is classified as an empty latest-turn result, so a managed thread that has never received a user message remains restorable.

### Capacity claims

Endpoint claim reconciliation reads metadata once and scans descending `notLoaded` pages. Active claims match exact turn IDs. Before every new implicit or durable provisional start, QiYan persists the latest turn ID (or an explicit empty-history baseline) before dispatch. Reconciliation considers only the suffix newer than that baseline and hydrates exact items only for candidates in that suffix. Nonterminal candidates are rescanned because their user item may not have materialized yet. Restored claims from older versions that lack a baseline remain unresolved rather than scanning historical bodies or proving absence. Claims are released as absent only after an idle thread's bounded suffix is authoritative; a partial or malformed scan never proves absence. On a legacy Codex store without item pagination, the exact one-turn summary supplies the first user message.

### Terminal relay

The relay scans backward only until the durable delivery cursor or epoch baseline and does not commit while searching for that anchor. It reverses the authoritative bounded suffix to preserve chronological delivery and stops at the first nonterminal turn. A live `turn/completed` notification whose embedded turn has `itemsView: "full"` is carried through ownership/generation validation and committed directly, preserving every explicit final item without rereading history. Minimal live notifications and missed-notification recovery read the exact turn's item pages; a legacy summary fallback deliberately recovers only the last agent response. Retried exact targets use the same paginated suffix and never full-read the rollout.

### Assistant startup

Completed conversation-cutover state needs no assistant history. An unfinished one-time cutover pages metadata turns and validates the exact retained active turn; it never required message bodies. Normal startup uses the status returned by resume to decide whether deferred post-turn actions can drain. Assistant dispatcher recovery uses metadata plus exact-turn items when client correlation is required, and observation recovery uses metadata only.

### Automatic operation recovery

Every automatic recovery/reconciliation call site is part of this migration, including startup operation replay and AppServerPool's uncertain start/interrupt reconciliation. Send recovery finds exact turn status and client correlation through metadata plus exact-turn items. Goal recovery uses the authoritative goal API plus metadata when it must authorize an active turn. Compact/model recovery pages exact `contextCompaction` items instead of scanning the whole thread. Interrupt recovery locates the exact/active turn through metadata pages. Attachment terminal checks, deferred assistant compaction, assistant status recovery, and active-turn authorization use the same bounded projections. No Codex reconnect, endpoint-ready callback, startup replay, retry timer, or operation reconciler may issue `thread/read { includeTurns: true }`; Claude is bounded by the same provider-neutral page contract.

Legacy stores cannot expose `contextCompaction` through the summary fallback. If exact item pagination is unsupported, compact/model and deferred-compaction recovery remains explicitly unresolved without dispatching another compaction, consuming pending settings, completing notifications, or advancing operation state. That is a safe, visible uncertain operation rather than a duplicated mutation. Tests cover both supported proof and legacy no-side-effect behavior.

Interactive actions whose explicit purpose is to show/read native history may retain a full-read implementation for now, provided they are never invoked automatically during endpoint recovery. A repository-level call-site audit test enumerates the remaining full reads and fails if one appears outside those named interactive boundaries.

## Implementation plan

1. Add failing contract tests for the shared page reader, exact empty-thread classification, Codex resume persistence, and Claude's bounded adapter.
2. Implement typed turn/item paging and cursor validation, including positional Claude transcript windows.
3. Replace recovery-time full reads in lifecycle, capacity reconciliation, terminal relay, assistant cutover/dispatcher, observations, durable operation replay, pool start/interrupt reconciliation, deferred actions, and attachment/status checks. Keep only audited explicit interactive full-history APIs unchanged.
4. Run focused recovery tests, the full `npm run check`, and the same-reviewer code review. Re-run both after every accepted finding.
5. Squash-merge the feature/notification chain to `main`, exclude the abandoned WebSocket-limit increase, delete the superseded task branches, push, deploy, and validate a long remote worker in place.

## Safety and verification

Tests must prove:

- Resume responses contain no turns while the fake server's persisted history remains unchanged and later pagination still returns it.
- Active-turn and goal ownership survive connection replacement.
- Empty, never-materialized workers recover successfully.
- Codex claims, relay endpoint wake, assistant startup, and Claude recovery never issue an unbounded `thread/read { includeTurns: true }`.
- Every automatic operation/start/interrupt/retry reconciliation path avoids full reads; an allowlisted source audit prevents new recovery-time full reads.
- Cursor pages preserve baseline/delivery ordering and exact absence rules; malformed, repeated, and missing-anchor pages have no side effects.
- Codex uses bounded native paging. Claude exposes the same reader contract through snapshot-pinned positional windows, with tests proving the runner never returns more than the requested bytes. Exact-turn item paging preserves multiple final responses where supported, and the exact legacy-Codex-store fallback is tested to recover only the summary's last agent response without a full read.
- The 1 MiB WebSocket bound remains enforced.

After deployment, record the existing worker rollout size and latest turn ID, restart QiYan, and verify the same latest turn remains pageable while the worker reconnects without a large frame or repeated endpoint outage.
