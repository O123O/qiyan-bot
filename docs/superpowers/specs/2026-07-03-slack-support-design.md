# Slack Support Design

Date: 2026-07-03

Status: Approved design, amended after security/API review

## Objective

Add Slack as a second, concurrently usable chat adapter for QiYan Bot. One self-hosted deployment serves one owner and may run Telegram, Slack, or both. Slack direct messages and owner mentions in joined channels feed the same conversation-bound Codex assistant used by Telegram. Shared chat actions remain adapter-neutral; only Slack search capabilities receive Slack-specific tools.

The first Slack target supports:

- one Slack workspace and one configured owner;
- Socket Mode, with no public event endpoint;
- owner DMs and owner `@QiYan` mentions in channels where the app is a member;
- thread-bound channel conversations;
- owner follow-ups in an activated QiYan thread without another mention;
- inbound and outbound attachments;
- current-conversation history;
- workspace search through a read-only Slack user token;
- exact owner-mention retrieval from a requested date;
- concurrent operation with Telegram and durable cross-adapter routing.

Multi-workspace installation, posting as the owner, private content outside the owner's Slack authorization, and generic Slack administration are out of scope.

## Architectural approach

Use Slack's focused official Node SDK packages rather than Bolt or raw protocols:

- `@slack/socket-mode` owns the WebSocket connection, acknowledgements, and reconnect behavior.
- `@slack/web-api` owns Slack Web API formatting, pagination, and the current file-upload flow. SDK retries are disabled for side-effecting clients; QiYan alone decides whether a failed write is proven safe to retry.

Bolt is not used because QiYan already owns application lifecycle, routing, persistence, delivery, and tool dispatch. Raw WebSocket and HTTP implementations would duplicate reconnection, acknowledgement, rate-limit, and upload behavior without improving the product boundary.

Slack support is split into four components:

1. `SlackChatAdapter` implements the shared `ChatAdapter` lifecycle and composes ingress and delivery.
2. `SlackIngressWorker` durably accepts Socket Mode events, downloads authorized trigger files, and produces `CanonicalChatSource` values.
3. `SlackDeliveryAdapter` implements the existing `ChatDeliveryAdapter` contract for messages and files.
4. `SlackContextService` provides current-history and search operations through narrow bot-token and read-only-user-token clients.

The production app constructs all configured adapters, starts them concurrently, and registers every delivery implementation in `ChatAdapterRegistry`. At least one complete chat adapter configuration is required.

## Token separation

Slack uses three credentials with distinct roles:

- App token (`xapp-`): Socket Mode connection only.
- Bot token (`xoxb-`): QiYan-authored messages, file delivery, joined-conversation history, trigger-file downloads, and user-name resolution.
- User token (`xoxp-`): read-only Real-time Search on behalf of the configured owner.

The user token is wrapped by an internal interface that exposes only:

- `auth.test`;
- `assistant.search.info`;
- `assistant.search.context`.

The interface exposes no generic Web API call and no chat, reaction, file-write, channel-management, or arbitrary method. All QiYan output uses the bot token and appears as QiYan, never as the owner.

All Slack credentials remain in the owner-only QiYan dotenv file. They are added to the bot-secret denylist, excluded from assistant and worker child environments, redacted from errors, and never written to source contexts, search reports, dashboards, or Codex input.

## Configuration

Telegram becomes an optional all-or-none credential group:

```dotenv
TELEGRAM_BOT_TOKEN=
TELEGRAM_OWNER_ID=
TELEGRAM_DESTINATION_CHAT_ID=
```

Slack is also an optional all-or-none group:

```dotenv
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
SLACK_USER_TOKEN=xoxp-...
SLACK_TEAM_ID=T...
SLACK_OWNER_USER_ID=U...
```

If exactly one adapter is configured, it is the initial administrative route. If multiple adapters are configured, `PRIMARY_CHAT_APP` is required and must name one configured adapter. The primary route is used only before an owner message establishes a durable latest route.

Slack startup validation must prove that:

- bot and user tokens are valid and belong to `SLACK_TEAM_ID`;
- the user token represents `SLACK_OWNER_USER_ID`;
- the bot identity differs from the owner identity;
- Socket Mode can establish a connection;
- public Real-time Search is available;
- requested private, IM, MPIM, file, and user-search coverage is recorded without claiming that `assistant.search.info` can reveal per-user consent that Slack does not expose;
- the bot can open or resolve its DM with the owner.

A configured but invalid adapter is a startup configuration failure. A runtime Slack disconnection does not stop Telegram.

## Packaged Slack manifest

Ship a reusable Slack app manifest and a focused setup guide. The manifest enables Socket Mode, a bot user, the App Home messages tab, and these bot events:

- `app_mention`;
- `message.channels`;
- `message.groups`;
- `message.im`.

Bot scopes:

- `app_mentions:read`;
- `chat:write`;
- `channels:history`, `groups:history`, `im:history`;
- `channels:read`, `groups:read`, `im:write`;
- `files:read`, `files:write`;
- `users:read`.

Read-only user scopes:

- `search:read.public`;
- `search:read.private`;
- `search:read.im`;
- `search:read.mpim`;
- `search:read.files`;
- `search:read.users`.

The app-level token additionally receives `connections:write`. The guide explains Slack's private-search consent and that search coverage cannot exceed the owner's Slack permissions or workspace policy.

For the first release, the owner copies the app, bot, and user tokens plus workspace and user IDs into `~/.qiyan-bot/.env`. A QiYan-managed OAuth login flow is deferred.

## Ingress and durable acknowledgement

Socket Mode delivery must not create a loss window. Each authorized event follows this sequence:

1. Validate envelope shape, team ID, event type, and owner user ID.
2. Normalize only the fields required for later processing, assign a monotonic inbox arrival sequence, and insert a durable Slack inbox row. For an authorized mention, atomically record its pending thread activation in the same transaction.
3. Acknowledge the Socket Mode envelope after that insert commits.
4. Process pending inbox rows asynchronously.
5. Download authorized trigger attachments into the shared attachment store using deterministic stable-message-and-file-derived handles.
6. Create a canonical source and accept it through the conversation dispatcher.
7. Mark the inbox row processed in the same transaction that accepts or deduplicates the source.

If inbox persistence fails, do not acknowledge; Slack may redeliver. Unauthorized users, unsupported events, bot messages, service messages, and irrelevant channel messages are acknowledged and discarded without retaining their content.

Persist only normalized event fields and per-file download state. Never persist the Socket Mode `action_token`; the selected design uses the read-only user token for search.

Slack event ID deduplicates envelopes. The stable native message identity is workspace, channel, and message timestamp, which deduplicates overlapping `app_mention` and `message.*` delivery of the same Slack message. Canonical source scope and attachment handles derive from that stable message identity—not event ID. The single ordered ingress worker checks for an already accepted canonical source before any file work, so overlapping events cause at most one file download or permanent-failure decision, one warning, one attachment row, and one retain.

## Activation and conversation identity

Activation rules are deterministic:

- An owner `message.im` event is always eligible.
- An owner `app_mention` in a joined public or private channel activates its thread.
- A non-mention owner message in a public or private channel is eligible only when its thread was previously activated as a QiYan conversation.
- Other channel traffic is ignored at ingress. QiYan may later retrieve it explicitly as context.

Activated chat conversations are recorded durably rather than inferred only from the current lease. A mention's activation commits with its inbox row before Socket Mode acknowledgement, not later with asynchronous source processing, so an immediate owner follow-up cannot race ahead and be discarded. Inbox processing remains ordered by its committed monotonic sequence—even for equal timestamps—and an older transient failure blocks later rows. This lets an owner continue an already activated Slack thread without mentioning QiYan again, including while that thread is queued behind another app's active conversation.

Conversation keys are:

```text
slack:<workspace>:dm:<channel>
slack:<workspace>:thread:<channel>:<root_timestamp>
```

A top-level mention uses its own timestamp as the thread root. A mention or follow-up already inside a thread uses the existing root `thread_ts`. Slack channel output always replies under that root. DM output remains an ordinary direct message.

The leading bot mention and its activation whitespace are removed before storing the semantic owner text. Thus:

```text
<@QIYAN_BOT_ID> /pass exact text
```

becomes the immutable source text:

```text
/pass exact text
```

No other user text is translated or rewritten. `/pass` and `/collect` remain ordinary messages that use normal start, steer, or queue routing; their only special behavior remains exact attempt-scoped validation at the tool boundary.

Codex receives a separate short source header, such as `[slack #project-alpha thread]` or `[slack dm]`, before the immutable owner text. This exposes origin without changing safeguard payloads.

## Conversation ownership and cross-adapter routing

The existing conversation dispatcher remains the only owner of start, native steer, and queue decisions.

- A same-conversation Slack follow-up may steer the active Codex turn.
- Another Slack thread, a Slack DM, or Telegram cannot steer that turn and receives the existing exact `[system] queued` notice.
- When the turn terminalizes, pending sources compete by durable arrival order at the next lease boundary.
- `/pass` and `/collect` have no separate ingress or routing path.

Every accepted owner source atomically updates a singleton latest-owner-route record with its immutable `ConversationBinding`. Direct and causal outputs use their attempt binding. Unsolicited worker completions, startup warnings, and permission failures use the latest owner route; before the first accepted source they use the configured primary adapter. Delivery intent freezes the selected binding when the outbox record is created.

When Slack is the primary adapter, startup opens or resolves the owner DM and uses that binding as the fallback route.

## Shared and Slack-specific tools

Do not add adapter-specific copies of shared chat operations. These existing tools remain unchanged in name and intent:

- `send_chat_message`;
- `prepare_chat_attachment`;
- `send_chat_attachment`.

Their backend implementation routes by the active attempt's immutable adapter binding. Incoming files continue through the shared attachment store and outbound files continue through the shared durable delivery outbox.

Add one platform-neutral history tool:

```text
get_chat_history(scope, count, before?)
```

The current source binding selects the adapter. For Slack:

- `scope="conversation"` uses `conversations.replies` with the persisted root timestamp for a channel thread, including the root and replies, and uses `conversations.history` for a DM;
- `scope="channel"` uses `conversations.history` for the active channel;
- `count` is bounded by the tool schema;
- `before` is an optional opaque platform timestamp from an earlier result.

History returns the newest `count` messages before the requested boundary and renders that window oldest-to-newest for model context, plus the next opaque `before` boundary. A supplied `before` is exclusive, matching Slack's `latest` boundary with `inclusive=false`, so adjacent calls neither duplicate nor skip a timestamp. Because `conversations.replies` pages oldest-first, thread history consumes all pages up to the boundary into a bounded `count`-sized ring, deduplicates the root timestamp, and then selects the newest window. DM/channel history consumes Slack's newest-first pages only until the window is full.

Telegram initially returns an explicit unsupported-capability error because the Bot API cannot retrieve arbitrary historical chat messages.

Only genuinely Slack-specific retrieval receives Slack-specific names:

```text
search_slack(query, date_from?, date_to?)
get_slack_mentions(date_from)
```

Dates accept an ISO `YYYY-MM-DD` date or ISO-8601 timestamp and are normalized to UTC. `date_from` is inclusive. `date_to` is exclusive when provided; otherwise it is the call time.

`search_slack` queries Slack Real-time Search with the read-only user token, consumes every returned cursor internally, and preserves messages, files, channels, contextual messages, and permalinks where Slack supplies them.

`get_slack_mentions` queries for the configured owner's exact `<@USER_ID>` mention, consumes all returned search pages, post-filters message text and blocks to reject false matches, and returns matches newest first. Each match contains channel, author, timestamp, text, thread identity, contextual messages, and permalink.

Slack does not expose its Activity feed through an API. Consequently, “all mentions” means all exact matches returned by Slack's supported search index across the coverage authorized for the user token, not a promise to reproduce historical Activity notifications.

Both tools report the channel/content categories requested from Slack, state that Slack enforced the user token's current authorization, and identify any explicit API errors or omitted categories. Because `assistant.search.info` exposes AI-search availability but not each private-consent grant, QiYan must not describe a private search as workspace-complete merely because the call succeeded.

If search fails before yielding any page, the tool returns an actionable error. If a later page fails after earlier pages were collected, the tool materializes those results with `complete=false` and a warning naming the omitted coverage or rate-limited continuation. It never labels a partial result as all mentions.

## Transient search result policy

Slack's Real-time Search terms prohibit storing or copying retrieved result data. Therefore `search_slack` and `get_slack_mentions` never write result bodies to SQLite, operation receipts, logs, dashboards, or files. They share an in-memory response limiter and do not expose Slack cursors to QiYan.

Results are requested newest first and stabilized with a channel-and-timestamp tie break. The backend consumes every Slack cursor to determine total count and completion through an incremental limiter that discards bodies outside the bounded prefix immediately; it never accumulates the complete normalized result set. It returns only the newest prefix satisfying both limits:

- at most 30 matches;
- at most 3,000 Unicode-whitespace-delimited rendered words.

The response contains `count`, `returned_count`, `truncated`, `order="newest_first"`, `complete`, requested/limited coverage metadata, and the transient `results` prefix. When truncated, it includes an explicit warning telling QiYan to narrow the query or date range; it never creates a report path. `complete` describes Slack pagination, while `truncated` independently describes the model-facing prefix.

These two tools bypass durable operation-receipt replay because even a read-only receipt would retain result content. Retrying the same call may observe newer Slack state. The only copies are the in-memory call result and the immediate model context needed to answer the owner's request.

## Attachments

Authorized trigger messages may include Slack-hosted files. The ingress worker downloads them with the bot token because the bot is a member of the triggering conversation. Downloads stream into the existing attachment store and retain its byte limit, total quota, private paths, immutable source scope, and expiry rules. Each Slack file uses a deterministic handle derived from workspace, channel, message timestamp, and Slack file ID; the inbox records per-file completion. The worker checks for that handle before requesting another download. A crash or overlapping Slack event reuses the same object and cannot create quota-consuming duplicates.

Transient download failures retain the Slack inbox row for retry. A permanent access or file failure preserves the immutable owner text and stores a separate immutable failed-attachment descriptor. QiYan receives an explicit unavailable-file text item beside, not inside, the owner text, and the backend queues a warning in the same causal Slack conversation. An attachment-only message with a permanent failure still produces a source containing that descriptor, so it is not silently lost. Attempt-scoped `/pass` validation rejects the matched directive source when that source has a failed attachment rather than authorizing a text-only send that silently drops the file; a failed attachment on an unrelated ordinary attempt member does not invalidate another source's valid directive.

Outbound files use the current `files.getUploadURLExternal` plus upload plus `files.completeUploadExternal` sequence through the official SDK convenience API. The deprecated `files.upload` method is forbidden.

## Delivery and failure handling

Slack message delivery uses the existing outbox and immutable `ConversationBinding`. The Slack destination contains workspace ID, channel ID, and optional root thread timestamp. The reply metadata contains the Slack message timestamp.

Use a stable `client_msg_id` derived from the delivery ID when Slack accepts it. Message and file receipts persist Slack channel, timestamp, and file identifiers as opaque JSON.

Side-effecting Slack Web API clients use zero automatic retries and reject rate-limited calls back to QiYan. A write is retried only when its error proves no effect (for example, a pre-dispatch rate limit); ambiguous transport or upload-stage failures become uncertain. A file upload whose effect is uncertain is not blindly repeated and produces one mandatory visible warning, matching the existing no-duplicate side-effect policy.

Runtime Socket Mode disconnection triggers SDK reconnect without stopping other chat adapters. Slack-bound outbox rows remain pending or uncertain until Slack recovers. Revocation of the read-only user token disables Slack search tools with an actionable warning but leaves bot messaging available. Startup with invalid configured credentials fails rather than silently disabling Slack.

## Storage migration

Add durable schema for:

- normalized Slack inbox rows, deterministic per-file download checkpoints, and retry/processed state;
- activated chat-conversation identities;
- the latest accepted owner route.

Chat source rows also gain immutable failed-attachment metadata so unavailable Slack files survive source acceptance, Codex input construction, safeguard validation, and restart without mutating the owner's raw text.

Existing Telegram source, attempt, lease, operation, attachment, and delivery tables remain authoritative. Slack sources use `kind="slack"` and `source_class="chat"`. Migration preserves existing Telegram installations and derives the initial latest route from the configured primary adapter only when no accepted-route record exists.

Routing backfill accepts an optional legacy Telegram binding. A fresh Slack-only database has no legacy Telegram rows and completes without one. Before writable open enables WAL or applies schema migrations, an immutable read-only preflight inspects an existing database. If a pre-cutover database still contains Telegram rows whose binding must be reconstructed, startup requires the matching Telegram configuration and fails without changing database bytes or sidecars when it is absent; Slack primary-DM resolution is never used to reinterpret historical Telegram data.

## Test strategy

### Unit tests

- Slack envelope and event validation.
- Workspace and owner checks before content retention.
- DM, channel mention, and activated-thread follow-up classification.
- Bot, edit, service, duplicate, and unrelated channel-message rejection.
- Leading mention removal and exact `/pass` and `/collect` payload preservation.
- Conversation keys and thread-root behavior.
- Search coverage, exact owner-mention filtering, UTC date bounds, complete cursor consumption, and newest-first stable ordering.
- Multi-page thread/DM/channel history, root inclusion, chronological output, and exclusive `before` boundaries.
- The 30-match and 3,000-word transient-prefix boundaries.
- No Real-time Search result bodies in SQLite, files, logs, operation receipts, or dashboards.
- Token redaction, dotenv validation, and child-environment isolation.

### Component tests with injected Slack clients

- Durable inbox commit before Socket Mode acknowledgement.
- No acknowledgement on persistence failure.
- Redelivery and duplicate-envelope handling.
- Restart processing of pending inbox rows.
- Authenticated attachment download, deterministic crash recovery, permanent failure descriptors, and quotas.
- `/pass` refusal when the matched directive source has an unavailable attachment, without contaminating another source's directive.
- Threaded bot messages, DM messages, `client_msg_id`, and file upload v2.
- Zero SDK write retries plus proven-no-effect rate-limit and ambiguous transport behavior.
- Narrow read-only user client method allowlist.

### Integration tests

- Telegram and Slack active simultaneously.
- Same Slack thread steers while another Slack thread or Telegram queues.
- Queued Slack thread retains follow-ups without repeated mentions.
- Direct and causal replies retain their original adapter binding.
- Unsolicited notifications follow the latest accepted owner route and survive restart.
- Shared send and attachment tools select the correct adapter without platform-specific duplicates.
- Process restart recovers Slack inbox, source, attempt, delivery, and latest-route ambiguity without replaying proven side effects.
- Packaged binary runs with Slack SDK code bundled and without installed runtime dependencies.

### Opt-in live test

Provide a skipped-by-default Slack round trip requiring dedicated test credentials. It verifies Socket Mode DM receipt, channel mention/thread reply, bot delivery, file upload, public search, and mention retrieval without running against real Slack in the default test suite.

## Documentation and distribution

Replace the Slack roadmap stub with an actionable guide covering:

- manifest creation/import;
- app-level token creation;
- workspace installation and bot/user token copying;
- private search consent;
- owner and workspace ID discovery;
- dotenv configuration and permissions;
- inviting QiYan to public or private channels;
- DM and thread activation behavior;
- search coverage and Activity-feed limitations;
- attachment limits;
- token revocation and troubleshooting.

Update setup, configuration, security, and README documentation to describe optional adapters, `PRIMARY_CHAT_APP`, concurrent Telegram and Slack operation, and the read-only user-token boundary. Include the Slack manifest in release packages and source-build archives.

## Official Slack references

- Node Slack SDK: <https://docs.slack.dev/tools/node-slack-sdk/>
- Socket Mode: <https://docs.slack.dev/tools/node-slack-sdk/socket-mode/>
- Web API client: <https://docs.slack.dev/tools/node-slack-sdk/web-api/>
- App mentions: <https://docs.slack.dev/reference/events/app_mention/>
- Direct-message events: <https://docs.slack.dev/reference/events/message.im/>
- Real-time Search API: <https://docs.slack.dev/apis/web-api/real-time-search-api/>
- Search method: <https://docs.slack.dev/reference/methods/assistant.search.context/>
- Conversation history: <https://docs.slack.dev/reference/methods/conversations.history/>
- Message delivery: <https://docs.slack.dev/reference/methods/chat.postMessage/>
- File upload guidance: <https://docs.slack.dev/messaging/working-with-files/>
