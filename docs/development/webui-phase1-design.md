# Web UI — Phase 1 (chat + dashboard)

## Goal

A browser interface for QiYan, built in reviewed phases. **Phase 1:** a live
dashboard of every managed session (status, goal, model, tokens) and a chat
surface where you talk to the assistant and address a specific worker
(`@worker`) — with the assistant kept in the loop. No file browsing yet
(Phase 2 reuses Codex-Web-UI's local browser; Phase 3 adds remote).

## Decisions (fixed with the user)

- **Input goes through the assistant.** Sending to a worker from the web UI is
  routed via the assistant so it stays aware of the whole progress — NOT a
  direct `SessionService.send`. This makes the web UI a new **ChatAdapter**,
  reusing the entire existing input→assistant→worker pipeline.
- **Isolated / opt-in.** The web UI is a self-contained module, off by default.
  When disabled it adds no phase, no server, and does not touch any existing
  behavior. The only edit to core code is one opt-in `AppPhase` registration
  plus a few config flags.
- **Exposure:** default bind `127.0.0.1`; opt-in `--web-host 0.0.0.0` (LAN) is
  allowed behind the access token, with a loud security warning (the bot is
  `danger-full-access`).
- **Phase 1 = chat + dashboard.** Local file browser is Phase 2, remote Phase 3.

## Why a ChatAdapter (not direct worker send)

QiYan already turns chat input into assistant turns and delivers replies by
`ConversationBinding`. A web ChatAdapter (`delivery.id = "web"`) plugs into that
untouched:

- **Inbound:** browser message → the adapter builds a `CanonicalChatSource`
  (`core/types.ts`) and calls the existing `acceptChat` closure
  (`production-app.ts:1960`). Assistant-panel text runs a normal assistant turn;
  a `/to <worker>` message is intercepted at the ingress and delivered directly
  to the worker + copied to the assistant as awareness (see the `/to` section) —
  it does NOT run an assistant reply turn.
- **Outbound:** assistant replies (and worker-final auto-deliveries, system
  warnings) are delivered to the **owner route** — a DB singleton
  (`latest_owner_route`, `OwnerRouteStore.current()` = `currentOwnerBinding()`)
  that `ConversationStore.acceptChatSource` overwrites to whichever surface most
  recently sent input. So the web adapter's `sendMessage` fires when web was the
  last surface to speak. This is co-tenancy with Telegram/Slack on the SAME
  existing singleton, not a new mechanism: for a single-user-one-surface-at-a-
  time model it is fine, but note that after web input, owner-route deliveries
  (including worker finals + warnings) route to the browser until another
  surface speaks. This is an accepted, explicit consequence, not a bug.

The assistant remains the single brain that sees every message and routes to
workers with `send_to_session`, so it always knows the whole progress. Because
the assistant is globally serialized ("one active conversation"), web input
queues through it exactly like chat input does — the trade the user chose for
awareness. (Workers themselves still run concurrently via the pool.)

### Addressing `@worker` — a backend-direct `/to <worker>` directive

The message to a worker is delivered **directly by the backend** — NOT by the
assistant calling `send_to_session` (which would be LLM-mediated and
non-deterministic). The assistant is kept aware via a passive copy it never
replies to. So `/to` is an **ingress directive** the backend executes, distinct
from `/pass`/`/collect` (which constrain the *assistant's* tool calls):

- **Parse** (`src/directives/parser.ts`): recognize `/to <nickname> <text>` →
  `{ kind:"to"; target; payload }`. One ASCII space, a nickname matching
  `^[a-z0-9][a-z0-9_-]{0,63}$`, one ASCII space, then the verbatim payload
  (empty allowed only with attachments), mirroring `/pass` payload rules.
- **Direct delivery** (at the ingress, in/next to `acceptChat`): when a `/to`
  directive is present, the backend calls `SessionService.send(target, payload,
  { mode:"auto", clientUserMessageId })` directly and does NOT dispatch a normal
  assistant turn for it. Deterministic target + verbatim content, and workers
  run in parallel (no assistant serialization for the delivery itself). Failure
  (unknown nickname, busy) is surfaced back to the sender.
- **Assistant awareness copy (no reply)**: alongside the direct send, the
  backend enqueues an **internal event** to the assistant conversation (the
  existing `source_class="internal"` / batched `event_batch` path, via an
  `enqueueInternal`-style producer) carrying "user directed to `<worker>`:
  `<text>`" plus the send result. The assistant processes it (batched, so many
  rapid `/to`s don't each cost a turn) to update its understanding / notes, and
  — per policy — produces NO user-facing reply and does not re-send.
- **Policy** (`assets/assistant/AGENTS.md` + pinned `policy.test.ts`): add — "A
  `/to <worker>` message is delivered directly to that worker by the backend;
  you receive an awareness copy of it — note it for supervision, do NOT reply to
  it, and do NOT re-send it."

The web UI worker panel sends `/to <nickname> <text>` (+ attachment ids); the
assistant panel sends text as-is (a normal assistant turn). `/to` is a general
ingress capability (works from any chat surface), validated by ordinary unit
tests independent of the web module. (Implementation note: confirm the internal-
event producer API and the exact `acceptChat` interception point in chunk 1.)

## Reads (dashboard + transcripts) — no assistant involvement

These are direct, **lease-free** reads of existing state, exposed as token-authed
HTTP GETs (prefer these to `thread/read`, which takes an endpoint work lease):

- **Session list + status:** `SessionRegistry.snapshot()` (nickname → endpoint,
  thread, project_dir, lifecycle_state) joined with the dashboard snapshot
  (`SessionDashboardStore.renderState()`/`dashboard.snapshot()`: native_status,
  active_turn_id, goal, model, token usage). Provider from `sessionProvider`.
- **Per-session final messages:** `FinalMessageStore.list(endpoint, thread,
  count)` (lease-free, backed by `logical_final_messages`).
- **Full live turns (on demand only):** `pool.request(endpoint, "thread/read",
  { threadId, includeTurns: true })` — takes a work lease and can serialize
  against active turns, so it is a heavier on-demand op (opening a transcript),
  not the dashboard poll. Works for both codex and Claude.

## Live updates (WS)

A WebSocket per browser session (token-authed on upgrade). Sources:

- **Status/goal changes:** reuse the existing observation hook — the
  `SessionObservationProcessor`'s `onChanged` callback
  (`production-app.ts:~2649`, already wired to `renderDashboardSafely`). The web
  phase wraps/extends that callback to also broadcast a metadata-only
  `session-updated` (from `dashboard.snapshot()`). There is NO dashboard
  "dirty event" to subscribe to — `onChanged` is the push hook; `renderState().
  revision` is the poll fallback.
- **Turn completion (metadata only):** `turn/completed` carries no body
  (`{threadId, turn:{id}}`) — use it (or the observation hook) to emit
  `turn-completed`/refresh status, never a chat body.
- **Assistant reply bodies:** delivered SOLELY through the web adapter's
  `sendMessage` → WS `message` event. `turn/completed` MUST NOT also emit the
  body (that would double-deliver). Single source of truth for chat bubbles =
  the adapter delivery.

No message bodies are logged; the channel is loopback/tunnel by default.

## Auth

Reuse Codex-Web-UI's scheme (its `server/auth.ts`): a random 32-byte
`base64url` access token minted at startup, printed in the launch URL,
stored as an `httpOnly`, `sameSite=lax` cookie, compared with
`crypto.timingSafeEqual`. Every HTTP route and the WS upgrade require it. The
token is process-local (not persisted). It is a **distinct token from the
loopback MCP bearer** (`QIYAN_BOT_MCP_TOKEN`) — the possibly-LAN-exposed web
surface must not share the loopback control token. When bound non-loopback the
token is mandatory (no bypass).

## Module layout (isolated)

The adapter must live in the `chats` array (so `ChatAdapterRegistry` can route
outbound delivery to it) and is therefore lifecycle-driven by the existing
`chat-adapters`/`chat-ingress` phases — it canNOT be created in a new
post-assistant phase. So split responsibilities and share a small bus:

- `src/webui/` — bot-side module:
  - `web-bus.ts` — a `WebSocketRegistry`/broadcast bus (connected browser
    sockets + `broadcast(event)`), created early so BOTH the adapter and the
    server can reference it.
  - `web-adapter.ts` — the `ChatAdapter` (`delivery.id="web"`,
    `primaryBinding = { adapterId:"web", conversationKey:"web:owner",
    destination:<constant> }`). Inbound: browser input → build a
    `CanonicalChatSource` (unique `nativeSourceId` for dedup, `attachmentIds:
    []` in P1) → `acceptChat`. Outbound: `sendMessage(destination, body)` →
    `bus.broadcast({type:"message", body})`. `history` omitted (optional).
  - `web-server.ts` — the HTTP + WS server (Express + `ws`): auth, static assets,
    the lease-free read APIs, WS upgrade (token-checked) registering sockets into
    the bus, and the `onChanged`→`session-updated` bridge. Bind `127.0.0.1`
    unless the LAN opt-in flag is set.
  - `web-reads.ts` — registry/dashboard/finals query helpers (+ on-demand
    `thread/read`).
  - `index.ts` — `createWebUiPhase(deps): AppPhase` for the SERVER only.
- `webui-client/` — the React/Vite frontend adapted from Codex-Web-UI (chat
  timeline, input box, session picker/sidebar, goal + runtime status). Built to
  static assets bundled into the release and served by `web-server.ts`.

**Core touches (minimal, additive):**
- In the `chat-adapters` phase: when web is enabled, construct the web adapter,
  push it into `chats`, AND admit `"web"` into the `expectedAdapters` set that
  the boot guard (`production-app.ts:~2200`) deep-compares — otherwise the bot
  refuses to boot. Create the shared `web-bus` here too.
- Add `createWebUiPhase(...)` (the server) to the phase array after the
  `assistant` phase, capturing `sessions`, `pool`, `registry`, `dashboard`,
  `finals`, `goals`, `sessionProvider`, and the `web-bus`. Server stop must run
  BEFORE the delivery/chat-adapters teardown (place it late in the array so it
  stops early in the reverse-order unwind).
- Config: `WEB_UI` (bool, default off), `WEB_HOST`, `WEB_PORT`, plus a dedicated
  LAN opt-in flag (`WEB_ALLOW_LAN` / `--web-allow-lan`) — added to the env
  schema, `SUPPORTED_DOTENV_KEYS`, `SERVICE_UNSET_ENV_NAMES`, and a pinning test;
  CLI flags `--web`/`--web-host`/`--web-port`.
- The `/to` directive touches `src/directives/parser.ts`,
  `src/assistant/attempt-scope.ts`, and `AGENTS.md`/`policy.test.ts` — additive
  to the existing directive system, independent of the web module.

When `WEB_UI` is off: no adapter in `chats`, `"web"` not in `expectedAdapters`,
no server phase — zero runtime effect, matching "doesn't affect the main bot."
"Isolated when on" means co-tenant of the existing owner-route/assistant
serialization (a new participant, not a new singleton), NOT orthogonal.

## Frontend reuse from Codex-Web-UI

Adapt (not import wholesale): `ChatTimeline`, `ChatItem`, `InputBox`,
`StreamingCard`, `MarkdownView`, `SessionPicker`, `WorkspaceSidebar`,
`GoalProgressRow`, `RuntimeStatusCard`, `Header`, `AuthOverlay`. Its `types.ts`
goal-status enum already matches QiYan's. Drop file/git/queue-editing
components until later phases. The client speaks a QiYan-specific WS/REST
protocol (sessions, transcripts, send), not Codex-Web-UI's codex-app-server
protocol.

## Out of scope for Phase 1

Local + remote file browsing, Monaco editing, git, attachments upload,
scheduling UI, approval cards, direct (assistant-bypassing) worker control.

## Risks / open items

- **`@worker` routing** — RESOLVED by the backend-enforced `/to <worker>`
  directive (target + content pinned in `attempt-scope`), so routing is
  deterministic, not LLM-guessed. Residual: the assistant must still *call*
  `send_to_session` for the turn to send; the policy directive makes this
  reliable, and a refusal is a visible no-send, never a misroute.
- **Owner-route singleton co-tenancy** — after web input, owner-route
  deliveries (worker finals, warnings) route to the browser until another
  surface speaks (M2). Accepted for the single-user model; documented, not a bug.
- **Serialization through the assistant** — web input queues behind the single
  assistant turn (the user's "assistant knows the whole progress" choice); a
  later phase could add an opt-in direct-to-worker mode.
- **Security of a full-access process on the LAN** — LAN bind is a dedicated
  opt-in flag + mandatory distinct token; default stays loopback. File browsing
  (later) will need its own path allow-listing (no OS sandbox).
- **Frontend divergence** — Codex-Web-UI's client is coupled to its own
  codex-app-server protocol; treat it as a component/style source, not a drop-in.
- **Per-endpoint notification plumbing** — to see turn/completed for remote
  endpoints added at runtime, subscribe to `endpointManager.onEndpoint` +
  enumerate builtins; for Phase 1 the simpler `onChanged`/dashboard-revision
  path covers session status, so raw per-endpoint listeners are optional.

### `/to` chunk — reviewed follow-ups (Minor, deferred)

The `/to` directive shipped reviewed (two Criticals found + fixed: it now
delivers directly, records an INTERNAL awareness source that can't be steered
into a live attempt, commits the ingress checkpoint, and is idempotent per
message). Remaining minors, acceptable for now:
- **Steer dedup on retry** — the worker send is idempotent via
  `clientUserMessageId` on the error path, but the native steer SUCCESS path
  may not re-verify it, so a crash-after-send + worker-now-busy retry could
  double-inject. Confirm the backend dedups `clientUserMessageId` on steer.
- **`OPERATION_UNCERTAIN`** — currently reported as "could NOT be delivered", so
  the user may resend a message that actually landed. Special-case uncertain/
  transient later (terminal errors like unknown-nickname stay surfaced as-is).
- **Attachments** — `/to` is text-only for now (loudly noted in the awareness
  copy); attachment forwarding lands with the web attachment work (P4).
