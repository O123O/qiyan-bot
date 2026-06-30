# Codex Chat Bot Design

## Summary

Build a single-user, self-hosted assistant that lets its owner operate Codex from chat applications. The assistant is itself a persistent Codex thread called the coordinator. It answers general questions, manages projects, chooses project sessions, and uses structured backend tools to control ordinary Codex threads.

The MVP uses Telegram, TypeScript, and one local `codex app-server`. It is designed so Slack and WeChat adapters, remote app-servers reached through SSH, and multiple app-server processes per host can be added without changing coordinator behavior.

## Goals

- Provide a general-purpose personal assistant with the capabilities available to a normal Codex session.
- Let the coordinator discover, create, adopt, resume, steer, interrupt, and inspect ordinary Codex sessions in any local project directory.
- Keep project work in normal Codex threads that the owner can also resume manually with standard Codex clients.
- Let the coordinator manage sessions using memorable nicknames rather than thread IDs.
- Deliver project-session responses automatically to Telegram without routing their full content through the coordinator model.
- Give the coordinator metadata about every project-session result and let it inspect full messages only when needed.
- Preserve concise coordinator-owned project status and follow-up intent across automatic context compaction without adding backend intelligence.
- Support exact pass-through and direct collection semantics through `/pass` and `/collect` markers on the normal send and collect tools.
- Exchange text and file attachments in both directions.
- Recover from backend and app-server restarts with explicit idempotency and delivery-ambiguity handling; Telegram output is at-least-once rather than impossibly claiming exactly-once visible delivery.
- Keep platform, transport, and app-server boundaries general enough for later Telegram alternatives and SSH hosts.

## Non-goals for the MVP

- Multiple bot users or tenant isolation.
- SSH-hosted projects.
- Slack or WeChat adapters.
- Interactive approval buttons or approval conversations in Telegram.
- Voice or video handling.
- A generic raw JSON-RPC tool exposed to the coordinator.
- Multiple app-server processes on one local host unless verification reveals a practical concurrency limit.

## Terminology

- **App-server:** A Codex JSON-RPC server process that can host and operate multiple threads.
- **Thread/session:** A persistent Codex conversation containing turns and items. This document uses "session" in user-facing language and "thread" when referring to the app-server protocol.
- **Coordinator:** A persistent Codex thread rooted in the bot repository and instructed to act as the user's assistant and session manager.
- **Project session:** An ordinary Codex thread whose working directory is a project directory. It has no bot-specific worker behavior and may use normal Codex tools and subagents.
- **Endpoint:** A connection strategy for one app-server. The MVP has a local endpoint; a later release adds SSH endpoints.
- **Managed session:** A discovered or created Codex thread that has a coordinator-assigned nickname in the bot registry.

App-server threads are distinct from subagent threads. Limits such as `agents.max_threads` govern subagents spawned inside a Codex session, not the number of persistent top-level sessions stored by one app-server. The backend will nevertheless cap concurrent active turns and retain the ability to shard a host across multiple app-server processes.

## Architecture

```text
Telegram API
    |
    v
ChatAdapter
    | canonical messages and attachments
    v
TypeScript Bot Backend
    |-- CoordinatorRuntime
    |-- CoordinatorToolGateway
    |-- SessionRegistry
    |-- AppServerPool
    |-- EventRelay
    |-- AttachmentStore
    `-- OperationalStore
             |
             v
    AppServerEndpoint: local
      `-- one local Codex app-server
            |-- coordinator thread
            |-- payments thread
            `-- website thread

Future:
    AppServerEndpoint: ssh://devbox
      `-- one remote Codex app-server
            `-- remote project threads
```

### Component responsibilities

#### ChatAdapter

Converts platform-specific inbound messages and attachments into canonical events and converts canonical outbound deliveries into platform API calls. The Telegram adapter uses long polling. Later Slack and WeChat adapters implement the same interface without importing coordinator or app-server logic.

#### CoordinatorRuntime

Owns the persistent coordinator thread, serializes its turns, sends user messages and internal metadata events to it, and distinguishes user-triggered turns from internal notification turns.

#### CoordinatorToolGateway

Exposes curated, typed backend operations to the coordinator through a coordinator-scoped MCP server. It binds each tool invocation to its originating Telegram message so directive enforcement cannot be detached from the source text.

#### SessionRegistry

Stores human-editable nickname mappings. The coordinator selects nicknames, project directories, and sessions; the backend validates and atomically persists those choices.

#### AppServerPool

Owns app-server processes and connections. An endpoint identifies the host and transport; it does not identify a Codex thread. The MVP owns one local app-server child process over stdio. This gives the backend unambiguous process lifetime, restart, and subscription ownership. A future `SshEndpoint` starts a remote app-server over SSH stdio or an SSH tunnel. The pool interface also permits multiple processes for a host if load testing or a later Codex version requires sharding.

#### EventRelay

Consumes app-server notifications, updates runtime state, forwards final project-session messages to Telegram, and queues compact metadata events for the coordinator.

#### AttachmentStore

Downloads, checksums, stores, materializes, uploads, expires, and cleans up attachments without placing their bytes into model context.

#### OperationalStore

Uses SQLite for queues, delivery state, event deduplication, Telegram update offsets, durable tool-operation records, attachment metadata, session runtime state, and crash recovery.

## Coordinator configuration and behavior

The coordinator is started in a dedicated directory inside the repository:

```text
codex-bot/
  AGENTS.md
  coordinator/
    AGENTS.override.md
    session-status.json
```

The repository-level file contains development guidance. The nested override contains the runtime manager role and applies after the root instructions. Coordinator-only MCP configuration is scoped to this directory so unrelated project sessions do not receive bot management tools.

The coordinator instructions require it to:

- Act as the user's general assistant and project/session manager.
- Answer directly when a request does not need a project session.
- Select sessions using nicknames, project metadata, current status, and conversational context.
- Ask the user when a routing choice remains ambiguous.
- Discover and adopt existing Codex sessions when appropriate.
- Assign short, memorable, unique nicknames.
- Avoid reading project transcripts and files unless the user's request requires them.
- Know that project-session final messages are automatically delivered to Telegram.
- Avoid repeating or paraphrasing an automatically delivered result unless asked.
- Treat project-session notifications as metadata and read their referenced messages only when useful.
- Retain supervision requests in its concise manager notebook and persistent conversation, then decide what to do after each notification. There is no separate `watch_session` backend state.
- Use the ordinary send and collect tools for `/pass` and `/collect`, respecting backend enforcement.
- Use structured status, model, effort, goal, and lifecycle tools rather than simulating CLI slash commands inside prompts.
- Know that setting a goal replaces the current goal and that goal completion is determined by the target Codex session/app-server, not by the coordinator.
- Warn the user when a session is blocked, detached, unavailable, or inconsistent with its registered directory.

The instructions guide model judgment. Tool validation, authorization, exact pass-through, delivery targeting, and registry integrity remain deterministic backend responsibilities.

### Coordinator manager notebook

`coordinator/session-status.json` is coordinator-owned durable memory for surviving context compaction. The live file is gitignored and initialized from a committed example. It is deliberately separate from the backend registry and SQLite state:

```json
{
  "version": 1,
  "sessions": {
    "payments": {
      "thread_id": "thr_payments",
      "project_status": "Fixing duplicate webhook processing",
      "current_objective": "Get all idempotency tests passing",
      "last_sent": {
        "message": "Rerun the tests and fix the remaining failures.",
        "at": "2026-06-30T14:20:00Z"
      },
      "last_worker_event": {
        "message_id": "msg_42",
        "status": "completed",
        "at": "2026-06-30T14:27:00Z"
      },
      "pending_follow_up": "Check migration compatibility",
      "updated_at": "2026-06-30T14:27:00Z"
    }
  }
}
```

`AGENTS.override.md` instructs the coordinator to read this file at session start and whenever compacted context is insufficient; update it after adopting or renaming a session, sending an instruction, or receiving worker metadata; keep one concise record rather than a transcript; and remove completed follow-ups. The stable thread ID reconciles nickname changes. The last sent instruction may be stored in full, but worker entries contain only message ID, status, and time unless the coordinator deliberately reads and summarizes a result.

The notebook is not authoritative for execution. Before sending, steering, interrupting, or changing a goal, the coordinator checks live state through backend tools. No backend tool is required to maintain the notebook; the coordinator edits its own workspace file, preserving valid JSON through atomic replacement or focused patching.

## Session registry

The durable JSON registry contains identity and mapping data only:

```json
{
  "version": 1,
  "coordinator": {
    "endpoint": "local",
    "thread_id": "thr_coordinator",
    "project_dir": "/home/user/codex-bot/coordinator"
  },
  "sessions": {
    "payments": {
      "endpoint": "local",
      "thread_id": "thr_payments",
      "project_dir": "/home/user/projects/payments",
      "description": "Payments service"
    }
  }
}
```

The JSON registry is authoritative only for identity: nickname, endpoint, thread ID, project directory, and description. SQLite is authoritative for operational state: managed lifecycle, running state, active turn, managed-epoch watermarks, last activity, delivery cursors, pending overrides, and errors. SQLite rows are keyed by `(endpoint, thread_id)`, never by mutable nickname.

### Registry rules

- Nicknames are unique, human-facing identifiers. Internal thread IDs remain available for diagnostics and discovery.
- The backend canonicalizes project paths and verifies a thread's recorded `cwd` through app-server before registering, adopting, attaching, or messaging it.
- A nickname is never silently repointed to a different thread or directory.
- Backend writes use a temporary file and atomic rename.
- Human edits are supported. The complete replacement file must pass schema and mapping validation before activation.
- An invalid edit leaves the last known-good registry active and produces a warning; it does not delete or repair existing mappings.
- Startup validates all mappings. Invalid entries are quarantined from control and reported.
- Registry changes and operational transitions use a durable prepared/committed record. If a crash occurs between the atomic JSON replacement and the SQLite commit, startup reconciles by stable endpoint/thread ID: a mapping without an operational row is validated and initialized as unavailable, while an operational row without a mapping is retained as an orphan audit record but cannot be controlled.

## Session discovery and lifecycle

Discovery lists all persisted normal Codex sessions visible to the app-server's OS user and active `CODEX_HOME`, not merely sessions already controlled by the bot. The backend does not rely on `thread/list` defaults: it omits the `cwd` filter, explicitly requests every top-level source kind advertised by the connected protocol, queries non-archived and archived sessions separately, sets `useStateDbOnly` to false so app-server may repair metadata from rollout files, and follows both protocol pagination streams until exhaustion. It excludes ephemeral threads and records with a non-null `parentThreadId`. Results include thread ID, title or preview, working directory, source, archive state, timestamps, and runtime status.

Because archived and non-archived records are separate app-server streams, the backend exhausts and merges them into a short-lived discovery snapshot in SQLite, sorted by `updatedAt` descending and then thread ID. The coordinator-facing opaque cursor contains the snapshot ID, query fingerprint, and next offset; `limit` applies to the combined snapshot. Subsequent pages read the same snapshot, preventing partition cursors or concurrent thread updates from skipping or duplicating entries. A fresh query creates a fresh snapshot.

The coordinator may:

- Create a new session in a selected project directory.
- Register a known thread ID after directory verification.
- Discover and adopt a CLI-, IDE-, app-, or app-server-created thread under a new nickname.
- Rename the nickname without changing the Codex thread.
- Detach a session before the user resumes it manually in another Codex client.
- Reattach it after rereading and validating its current metadata.
- Archive a session while retaining registry history.

Concurrent control of the same thread from the bot and another client is unsafe. The supported manual workflow is:

```text
detach payments -> work manually -> attach payments
```

If conflicting active control is detected, the backend fails the new operation instead of guessing.

### Lifecycle state machine and delivery baseline

SQLite stores a durable management state for each endpoint/thread ID: `managed`, `detaching`, `detached`, `attaching`, `archived`, or `unavailable`. `unavailable` also retains the state to restore after endpoint recovery. Native app-server runtime status such as idle or active is stored separately.

- **Create:** start and validate an idle thread, write its registry mapping, create a managed epoch with an empty baseline, and enter `managed`.
- **Register/adopt:** both operations use the same transition. Require an idle persisted top-level thread, read its canonical `cwd`, and set the managed-epoch baseline to the latest completed turn. `register_session` additionally requires a caller-supplied project directory and fails unless it exactly matches the canonical thread directory; `adopt_session` derives the directory from the thread. Historical turns are available through collection but are not automatically delivered.
- **Detach:** require `managed` plus native idle status. Set `detaching`, call app-server `thread/unsubscribe`, record the end watermark, then enter `detached`. Active work must be interrupted explicitly before detach; detach never interrupts implicitly.
- **Attach:** require the manual client to be stopped. Set `attaching`, read the thread and require native idle status, validate its directory, resume/subscribe it through app-server, then read status and history again while holding the backend's per-thread lock. If either status read is active, unsubscribe and return to `detached`. Otherwise set a new managed-epoch baseline to the latest completed turn and enter `managed`. Turns created during detached manual use are not automatically replayed but remain available through collection. App-server has no cross-client compare-and-swap, so not restarting manual work after the final idle check is an operator invariant. The backend rejects conflicts it can observe but does not claim it can detect every external-client race.
- **Archive:** require idle state, archive through app-server, retain the identity mapping, and enter `archived`.
- **Unavailable:** block state-changing tools while preserving identity, watermarks, and the intended state to restore after a successful reconnect and validation.

At startup, the backend completes or rolls back interrupted `detaching` and `attaching` transitions using the operation ledger and app-server state. It resumes/subscribes managed threads, leaves detached threads unsubscribed and unloaded by the bot, and never auto-delivers turns at or before the current managed-epoch baseline.

## Coordinator tool surface

The exact TypeScript/MCP schemas will use structured objects and errors, but the conceptual operations are:

### Discovery and lifecycle

```text
list_managed_sessions()
discover_sessions(endpoint?, search?, cwd?, cursor?, limit?)
get_session_status(nickname_or_thread_id)
create_session(nickname, project_dir, endpoint?)
register_session(nickname, thread_id, project_dir, endpoint?)
adopt_session(nickname, thread_id, endpoint?)
rename_session(old_nickname, new_nickname)
detach_session(nickname)
attach_session(nickname)
archive_session(nickname)
```

### Project-session interaction

```text
send_to_session(nickname, content, attachment_ids?, mode)
read_worker_message(nickname, message_id)
collect_messages(nickname, count)
interrupt_session(nickname)
```

`mode` is explicitly `start` or `steer`. `start` requires an idle session and begins a turn. `steer` requires an active turn and appends input to it. State mismatches return structured errors; the backend does not choose a mode for the coordinator.

### Model, effort, status, and goals

```text
list_models(endpoint?)
set_session_model(nickname, model)
set_reasoning_effort(nickname, effort)
get_goal(nickname)
set_goal(nickname, objective, token_budget?)
pause_goal(nickname)
resume_goal(nickname)
cancel_goal(nickname, interrupt_active_turn?)
```

Model and effort changes are validated against endpoint capabilities and applied on the next turn, after which app-server keeps them for subsequent turns. `get_session_status` combines native app-server status with endpoint, directory, active-turn, configured model/effort, goal, delivery, and managed/detached state.

`set_goal` replaces any current goal and activates the new one. Pause and resume alter the native goal status. Cancel clears the goal and may also interrupt the current turn when explicitly requested. No `complete_goal` tool is exposed: completion, blockage, and budget/usage-limit transitions come from the project session and app-server.

Goal methods and other version-sensitive operations are exposed only when the connected app-server advertises or successfully validates the required capability. The backend uses generated app-server types matching the installed Codex version.

### App-server compatibility policy

Each bot release pins and tests one exact Codex CLI/app-server version. Its TypeScript bindings are generated from that version's protocol schema. At connection time, the endpoint records the server version and checks required methods and fields before accepting work. A different version is accepted only when the compatibility suite for its generated schema passes; otherwise the endpoint reports `UNSUPPORTED_CAPABILITY` or a version-mismatch diagnostic. Upgrading Codex requires regenerating bindings and running the full thread, goal, status, event, attachment-input, and recovery contract suite.

### Chat output

```text
send_chat_message(content, reply_to?)
prepare_chat_attachment(owner, relative_path) -> file_handle
send_chat_attachment(file_handle, caption?, reply_to?)
```

`owner` is a managed-session nickname or the reserved coordinator workspace. It prevents arbitrary absolute-path access. `prepare_chat_attachment` validates and opens the relative path under that owner's verified root, then returns an opaque, expiring backend handle. Existing inbound attachment IDs are already opaque handles and may also be sent. There is no arbitrary recipient argument in the MVP. All outbound operations target the configured Telegram destination for the single authorized user.

The backend contains a typed app-server client broader than this list, but raw JSON-RPC is not exposed to the coordinator. Common safe operations can be added as curated tools later.

## Message routing

### Normal user message

1. Telegram long polling receives an update.
2. The adapter checks the sender's Telegram user ID. Updates from every other sender are silently discarded before persistence or model invocation.
3. The accepted update is deduplicated and queued. Its immutable raw text or caption is preserved exactly as received for directive enforcement; separately normalized metadata may be used for display and routing context.
4. The backend starts a coordinator turn with the canonical message and attachment metadata.
5. The coordinator answers directly or calls tools to operate a project session.
6. A final coordinator answer from this user-triggered turn is automatically delivered to Telegram.

Coordinator turns are serialized. Each Telegram message receives its own turn and source-message context. Messages received while the coordinator is busy remain in FIFO order instead of being steered into the active coordinator turn. This makes directive binding deterministic.

### `/pass` enforcement

`/pass` is not a separate tool. It places an invariant on the ordinary `send_to_session` tool invoked during the same coordinator turn.

Directive parsing uses immutable raw Telegram text, without Unicode normalization, trimming, Markdown parsing, or newline conversion. Scanning left to right, a directive candidate is the exact ASCII string `/pass` or `/collect` whose preceding character is the start of input or ASCII whitespace and whose following character is the end of input or ASCII whitespace. The first candidate is authoritative. If it is malformed, no later marker can rescue the message.

If that first candidate does not satisfy its grammar, the source context is marked malformed and any related send or collection call fails with `DIRECTIVE_MISMATCH`; the backend never weakens it into an unconstrained operation.

For `/pass`, the marker must be followed by exactly one required ASCII space. Text before the marker is routing context. The payload is every Unicode character after that delimiter space; additional leading spaces, newlines, and strings such as `/collect` inside the payload are opaque payload content. An empty payload is valid only when the source message has at least one attachment.

Example:

```text
tell payments /pass rerun the tests, but change nothing
```

When the coordinator calls `send_to_session`, the tool gateway verifies that:

- `content` is exactly the extracted payload as received from Telegram.
- Attachment IDs exactly match the source message attachments and preserve their order.
- The tool call belongs to the same source-message context.

The coordinator may choose the nickname and `start`/`steer` mode. It may not alter, normalize, translate, or reconstruct the content. A mismatch rejects the call and reports the expected payload. A successful receipt includes the resolved nickname, thread ID, actual transmitted text, attachment IDs, and payload hash.

Each source message authorizes exactly one logical directive operation. Before dispatch, the operation ledger records the source update, coordinator turn and tool-call ID, directive kind, selected target/mode, and argument hash. An identical retry returns or resumes the same stored operation and receipt. A second invocation or a retry with a different target, mode, payload, attachment list, or argument hash fails with `DIRECTIVE_ALREADY_CONSUMED`.

### `/collect` enforcement

`/collect` is not a separate command sent to Codex. It constrains the ordinary `collect_messages` tool in the same source-message context.

After `/collect`, the only valid suffix is either end of input, whitespace to end of input, or exactly one ASCII space followed by a positive base-10 integer and then optional trailing whitespace. The default count is one and the configurable MVP maximum defaults to 20; a larger count fails before message selection or delivery records are created. Text before the marker is routing context. Any other trailing content, including a later `/pass`, makes the first `/collect` directive malformed. Conversely, `/collect` text after a valid `/pass` belongs to the opaque pass payload.

Example:

```text
report payments /collect 3
```

The backend verifies the coordinator's requested count and consumes the source message's single directive authorization. Collection operates on the same stored eligible logical final messages produced by the terminal-turn extraction algorithm used for automatic delivery; it never selects commentary, tool items, or messages from nonterminal turns. It selects the newest N logical messages by the total order `(turn completed_at, turn ID, item order)` descending, then presents that selected window in chronological order. An identical retry uses the original selection and per-message delivery records rather than creating a second collection. The coordinator receives a delivery receipt rather than the collected bodies unless it separately calls `read_worker_message` outside the direct-collection result.

Without `/pass`, `send_to_session` accepts coordinator-composed content normally. Without `/collect`, `collect_messages` returns the selected message bodies to the coordinator as its tool result and does not deliver them directly to Telegram. The coordinator may then inspect, summarize, or forward them according to the user's request.

## Project-session events and automatic delivery

For every terminal project-session turn after the current managed-epoch baseline:

```text
Project-session final response
  |-- full response -> Telegram, prefixed with [nickname]
  `-- compact event -> coordinator event queue
```

Final-message extraction is deterministic. In turn item order, the relay first selects all completed agent-message items explicitly marked as final-answer phase. If none are marked because the provider omitted phase information, it selects the last completed phase-unknown agent message. Multiple explicit final messages remain separate logical messages and preserve their order. Tool items, commentary-phase messages, deltas, and command output are excluded.

For a successful turn with no eligible agent message, the relay records `NO_FINAL_MESSAGE` and sends no fabricated answer. For a failed or interrupted turn, any eligible final message is delivered with separate failure/interruption metadata; if none exists, the relay sends a deterministic nickname-labeled status warning. The coordinator event therefore contains zero or more final-message IDs plus nickname, endpoint, thread ID, turn ID, timestamps, terminal status, and delivery state. It does not include response bodies.

Coordinator notifications use a durable priority queue. Final-result events are never discarded; transient status changes for the same session may be coalesced before delivery. The default batch window is one second, with at most 20 events or 8 KiB of metadata per internal turn. User messages normally take priority, but after five consecutive user turns or 30 seconds of pending-event age, the scheduler processes one internal batch. This prevents either queue from starving the other and bounds the token cost of each wake-up.

Each event batch is acknowledged after its coordinator turn completes. If a coordinator turn fails before any side-effecting operation reaches `dispatched`, the scheduler may create a new attempt for the same logical source context. Once any side effect reaches `dispatched`, the original user or event turn is never re-executed: after reconciling its operations, one SQLite transaction creates a uniquely keyed recovery event and marks the original context and event IDs terminal as `superseded_by` that recovery context. This atomic transition prevents the original batch from remaining pending or spawning multiple recovery events. The new recovery event lists the original IDs and confirmed, failed, or uncertain receipts, allowing the coordinator to decide follow-up with explicit knowledge of prior effects. This same rule applies to failed user-triggered coordinator turns.

Final text produced by an internal event turn is suppressed by default, preventing acknowledgements such as "noted" from reaching Telegram. The coordinator calls a chat-output tool when it decides the user should receive an additional message.

All project-session result metadata is sent to the coordinator; there is no `watch_session` tool. If the user asks the coordinator to supervise work until completion, the coordinator records the objective and pending follow-up in `session-status.json`, reads result messages when needed, sends further project instructions, updates the notebook after each event, and decides when supervision is finished. This survives automatic context compaction without making the backend interpret supervision intent.

Tool calls, command output, deltas, and progress events are not automatically forwarded as final responses. Permission blocks, system failures, and delivery failures produce deterministic warnings and coordinator metadata events. Nickname labels and terminal-status annotations are Telegram envelope metadata, not modifications to the stored worker message body; collection can therefore reconstruct the original body exactly.

## Attachments

Inbound messages contain text plus zero or more canonical attachment references:

```json
{
  "id": "att_123",
  "name": "error.log",
  "media_type": "text/plain",
  "size": 18421,
  "sha256": "...",
  "source": "telegram"
}
```

The attachment store uses randomized internal names and preserves the display name as metadata. Downloads are streamed through a hard byte counter and aborted at the configured limit rather than trusting Telegram metadata. Per-file, per-message, and total-store quotas apply. Storage directories use owner-only permissions, files are non-executable and owner-readable only, and a checksum is calculated while streaming.

Attachment IDs and prepared outbound file handles are opaque backend capabilities, not paths accepted from the model. For a local project turn, the endpoint materializes each inbound handle into an endpoint-owned per-thread staging directory and verifies that the active sandbox can read it. Images use app-server's native `localImage` input. Generic files use a `mention` input with the sanitized display name and staged path so Codex may inspect the file through its normal tools. `/pass` requires the original attachment IDs and order. Attachment bytes are never embedded in coordinator context.

Materializations are reference-counted through the active turn and are not expired while a turn or pending delivery uses them. Cleanup occurs after the configured retention period.

For outbound project files, `prepare_chat_attachment` accepts only a verified session owner plus relative path. The backend resolves beneath that session's canonical root and opens the file with no-follow semantics, then checks the opened descriptor is a regular file before minting a short-lived handle. Upload reads from that already-validated descriptor or an equivalent safely duplicated handle, avoiding a path check/use race. The Telegram adapter enforces streaming size limits again during upload. A future SSH endpoint implements the same handle contract by securely fetching the remote file before handing it to the chat adapter.

## Persistence and recovery

SQLite stores at least these logical records:

- Accepted inbound Telegram updates and coordinator-turn state.
- App-server event identities and processing state.
- Prepared, dispatched, confirmed, failed, and uncertain Telegram deliveries.
- Pending and completed coordinator metadata notifications.
- Per-thread runtime state and delivery cursors.
- Durable coordinator tool operations and their external receipts.
- Model/effort overrides awaiting their next turn.
- Attachment metadata and expiry state.

Every side-effecting coordinator tool call uses an operation ledger keyed by source context (a Telegram update, internal event batch, or recovery event), coordinator attempt/turn, MCP tool-call ID, and operation kind. The record includes a canonical argument hash, state (`prepared`, `dispatched`, `succeeded`, `failed`, or `uncertain`), app-server or Telegram identifiers, and the final receipt. Intent is committed before dispatch. An identical replay within the same attempt returns the stored receipt or resumes reconciliation; reuse of the same identity with different arguments is rejected.

The inbound-processing record assigns each source a stable logical context ID and allows only one active coordinator attempt at a time. A new attempt is permitted only when the prior attempt failed with no dispatched effects. If any effect was dispatched, recovery uses a new, explicit recovery context rather than rerunning the original message or event batch. This prevents a terminal failed Codex turn from being restarted with new tool-call IDs that invisibly repeat earlier effects.

For app-server operations, a crash after dispatch but before receipt triggers reconciliation against thread and turn history before any retry. `clientUserMessageId` may be used only after an integration test proves its deduplication behavior for the supported app-server version. If the backend cannot prove whether a state-changing operation occurred, it records `OPERATION_UNCERTAIN`, does not blindly repeat the operation, and notifies the coordinator.

All externally visible effects use durable inbox/outbox semantics:

- Record accepted input before processing.
- Give every event and delivery a stable idempotency key.
- Mark Telegram output confirmed only after committing the successful Bot API response and returned Telegram message ID.
- Track each Telegram delivery as `prepared`, `dispatched`, `confirmed`, `failed`, or `uncertain`.

The Telegram Bot API does not accept a caller-supplied idempotency key, so exactly-once visible delivery is not promised. If the process dies after Telegram accepts a request but before the response is committed, startup changes `dispatched` to `uncertain`. Mandatory automatic results and direct `/collect` output are retried to provide at-least-once delivery; a recovery retry is labeled in the Telegram envelope with the stable delivery ID, and a duplicate may be visible. Confirmed deliveries are never retried. Other uncertain chat-tool deliveries return their uncertain receipt to the coordinator instead of being blindly repeated.

App-server events are deduplicated by endpoint, thread, turn, item, and event type. Telegram updates use Telegram's stable update/message identities. Direct `/collect` creates one delivery record per selected logical message under its single operation record, so operation replay cannot create a new selection.

If an app-server disconnects, the endpoint becomes unavailable and new state-changing operations fail immediately with `ENDPOINT_UNAVAILABLE`; the backend does not maintain a hidden work queue. The pool restarts its owned child process with bounded exponential backoff. After reconnecting, the backend rereads registered threads and reconciles completed turns against managed-epoch delivery cursors. This recovers final messages whose live notifications were missed without replaying historical or detached-period turns.

Thread identity is independent of a particular app-server process. Persisted threads are resumed by ID after a process restart.

## Concurrency and capacity

- The coordinator processes one source message or internal notification turn at a time.
- Different project sessions may run concurrently.
- Events remain ordered within one project session; cross-session events may interleave and are labeled.
- A configurable `maxConcurrentTurns` protects local CPU, memory, and API limits. An excess `start` fails immediately with `CAPACITY_EXCEEDED`; the MVP has no hidden project-turn queue. The coordinator may retry later after inspecting status.
- The MVP uses one app-server process because app-server supports multiple top-level threads. The pool can add another process for a host without changing registry or coordinator APIs.
- The system warns against multiple concurrent sessions modifying the same project files. The MVP does not create worktrees automatically.

## Security and execution policy

### Telegram authorization

Exactly one Telegram user ID is configured. Updates from all other user IDs are silently ignored before they enter durable queues, attachment storage, logs, or Codex. Outbound tools have no recipient parameter and use the configured destination chat.

The MVP accepts only ordinary Telegram `message` updates from that user containing supported text, caption, image, or document input. It ignores edited messages, callbacks, inline queries, channel posts, membership/service updates, unsupported media, and every update without the authorized `from.id`. The sender ID, rather than chat membership, is the authorization boundary; responses still go only to the configured destination chat.

Long polling avoids exposing a public webhook listener. The Telegram bot token and Codex credentials are supplied through environment variables or a local secret store and never committed.

### Codex permissions

Sessions run with a configured non-interactive approval policy. The operator explicitly configures the sandbox level, including whether to grant full machine access. This is a high-trust personal deployment: granting unrestricted Codex access makes the Telegram account a remote-control boundary for the machine.

If app-server still reports an approval or permission requirement, the deterministic backend does not approve it conversationally. It marks the session blocked, sends a nickname-labeled warning to Telegram, notifies the coordinator with metadata, and rejects or leaves the action blocked as required by the protocol.

### Data handling

- Logs redact tokens and do not include full message bodies or attachment contents by default.
- Registry paths are canonicalized, and thread working directories are verified before state-changing operations.
- Attachment paths reject traversal and symlink surprises at the point of materialization or upload.
- Outbound chat operations cannot select another recipient.
- Malformed configuration or registry input never replaces known-good active state.

## Error handling

Backend tools return typed errors with stable categories, including:

- `UNKNOWN_SESSION`
- `AMBIGUOUS_SESSION`
- `SESSION_DETACHED`
- `SESSION_BUSY`
- `SESSION_IDLE`
- `THREAD_NOT_FOUND`
- `CWD_MISMATCH`
- `ENDPOINT_UNAVAILABLE`
- `UNSUPPORTED_CAPABILITY`
- `DIRECTIVE_MISMATCH`
- `DIRECTIVE_ALREADY_CONSUMED`
- `ATTACHMENT_INVALID`
- `DELIVERY_FAILED`
- `DELIVERY_UNCERTAIN`
- `OPERATION_UNCERTAIN`
- `CAPACITY_EXCEEDED`
- `PERMISSION_BLOCKED`

Errors include safe recovery hints and correlation IDs but do not leak secrets. The coordinator decides how to explain recoverable errors to the user. Automatic delivery failures remain in the outbox and are also surfaced as metadata notifications.

## Extensibility

### SSH endpoints

Stage two adds `SshEndpoint`, which starts or communicates with `codex app-server` on a configured SSH host. The project directory is interpreted and validated on that host. The registry's existing `endpoint` field selects the correct connection, and attachment materialization gains upload/download behavior. Coordinator tools and chat adapters remain unchanged.

Direct public WebSocket exposure is not required. SSH stdio, Unix-socket forwarding, or loopback tunneling is preferred.

### Additional chat applications

Slack and WeChat adapters translate their native update, message, formatting, file, and delivery concepts into the canonical chat contracts. They do not import app-server types. Platform-specific message size and formatting rules are handled at the adapter boundary.

The single-user authorization policy remains part of deployment configuration. A future multi-user product would require a separate identity, authorization, isolation, and registry design rather than merely adding more user IDs.

## Verification strategy

### Unit tests

- Directive parsing against immutable raw text, including exact Unicode preservation, candidate boundaries, malformed-first behavior, opaque `/pass` payload markers, mixed directives, collection-count bounds, attachment order, single-use authorization, identical replay, and conflicting-replay rejection.
- Canonical chat conversion and Telegram message splitting.
- Registry schema validation, atomic replacement, nickname collisions, and canonical-path checks.
- Coordinator source-message binding.
- Event ordering, batching bounds, user/event fairness, idempotency keys, inbox/outbox transitions, and the rule that a failed coordinator attempt is never rerun after a side effect is dispatched.
- Operation-ledger transitions, argument-hash conflicts, stored receipt replay, and uncertain side-effect handling.
- Manager-notebook update and rename reconciliation behavior without treating it as live state.
- Attachment streaming caps, quotas, checksum, reference-counted expiry, sandbox-readable materialization, no-follow path validation, and output targeting.
- Goal replacement, pause/resume/cancel mapping, and the absence of coordinator-controlled completion.
- Unauthorized Telegram updates being discarded before persistence and model invocation.

### App-server contract and integration tests

- Pin an exact supported Codex version and generate TypeScript/JSON schemas from it; reject an incompatible server and run the suite again whenever the version changes.
- Start and operate several top-level threads through one local app-server.
- Verify exhaustive discovery across directories, source kinds, archive states, and protocol pagination while excluding ephemeral and subagent threads; verify combined discovery-snapshot cursors never skip or duplicate records across pages.
- Verify register and adopt share idle, directory, mapping, and baseline invariants.
- Verify thread resume, working-directory validation, every detach/attach state transition, attach's two idle checks, startup recovery from intermediate states, and status transitions.
- Verify managed-epoch baselines prevent adoption history and detached-period turns from being automatically delivered.
- Verify model and effort overrides on subsequent turns.
- Verify supported native goal operations and capability-gated behavior.
- Verify final-message extraction for explicit final phase, unknown-phase fallback, multiple final messages, successful no-message turns, failed turns, and interrupted turns while excluding tool and progress items; verify normal and direct collection use only those stored logical messages and preserve selected-window chronology.
- Verify interruption and structured busy/idle failures.

### Recovery and concurrency tests

- Fault-inject before Telegram dispatch, after request transmission, after response receipt, and before SQLite receipt commit. Confirm the state becomes confirmed or uncertain as specified, confirmed output is not retried, and an ambiguous mandatory retry may duplicate only under the same stable delivery ID.
- Fault-inject before and after each app-server and Telegram tool side effect. Confirm operation-ledger replay returns the stored receipt, reconciliation prevents duplicate turns where provable, and irreconcilable state-changing operations become `OPERATION_UNCERTAIN` rather than repeating blindly.
- Kill app-server after turn completion but before event processing and confirm reconciliation recovers the result.
- Run several project sessions concurrently while coordinator inputs remain serialized.
- Exercise immediate `CAPACITY_EXCEEDED`, user/event scheduling fairness, metadata batch limits, and endpoint restart backoff.
- Confirm no two aliases can race into inconsistent registry mappings.

### Telegram tests

- Mock Telegram API behavior for polling, downloads, uploads, retries, rate limiting, and message-size splitting.
- Prove updates from unauthorized users cause no storage, Codex work, or reply.
- Prove edited messages, callbacks, channel posts, service updates, and unsupported media are ignored even when associated with the authorized account.
- Provide an optional live private-chat smoke test for the configured owner.

## MVP success criteria

The MVP is successful when one configured Telegram user can:

1. Converse with a persistent coordinator as a general assistant.
2. Discover Codex sessions from across the local machine's active Codex profile.
3. Create or adopt project sessions and manage them by nickname.
4. Start and steer work, interrupt turns, inspect status, and change supported model/effort settings.
5. Set or replace, pause, resume, inspect, and cancel native goals without the coordinator declaring completion.
6. Receive every completed project-session response automatically with its nickname.
7. Give the coordinator metadata-only visibility, selective message inspection, and a concise per-session manager notebook that survives context compaction.
8. Use backend-enforced `/pass` and `/collect` semantics through the normal tools.
9. Send and receive file attachments.
10. Restart the backend or app-server without losing registered sessions, with durable operation reconciliation and explicit Telegram uncertain-delivery handling instead of an exactly-once claim.

## Delivery stages

1. **MVP:** TypeScript modular monolith, Telegram, local app-server pool endpoint, coordinator, discovery/registry/tools, attachments, directives, automatic delivery, and recovery.
2. **Remote projects:** SSH endpoint, remote validation, and remote attachment transfer.
3. **Additional chat apps:** Slack and WeChat adapters.
4. **Optional scale work:** Multiple app-server processes per host based on measured capacity, not speculation.
