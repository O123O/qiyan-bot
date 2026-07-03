# Slack Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure, durable Slack adapter that can run alone or beside Telegram, while preserving QiYan's conversation-bound steering, shared delivery tools, attachment guarantees, and single-owner model.

**Architecture:** Add official Slack Socket Mode and Web API transports behind focused ingress, delivery, and context services. Keep start/steer/queue decisions in the existing conversation dispatcher, add durable Slack inbox/activation/latest-route state, and route administrative output through the latest accepted owner conversation with a configured primary fallback. Shared chat tools remain adapter-neutral; only Slack search and mention retrieval are platform-specific.

**Tech Stack:** TypeScript 6, Node.js 24, `node:sqlite`, `@slack/socket-mode`, `@slack/web-api`, Codex app-server JSON-RPC v2, MCP SDK, Node test runner, esbuild.

---

## File structure

New focused units:

- `src/chat/owner-route-store.ts`: durable latest-owner binding with primary fallback.
- `src/slack/result-limiter.ts`: bounded transient in-memory search responses with no durable copies.
- `src/slack/types.ts`: normalized persisted Slack event and result types only.
- `src/slack/event-classifier.ts`: owner/workspace validation, activation, identity, and mention stripping.
- `src/slack/inbox-store.ts`: durable normalized Socket Mode inbox, per-file checkpoints, and activation records.
- `src/slack/clients.ts`: narrow official-SDK bot/search clients and startup validation.
- `src/slack/context-service.ts`: history, search, exact mentions, coverage, ordering, and materialization.
- `src/slack/ingress-worker.ts`: inbox draining, file ingestion, and canonical-source acceptance.
- `src/slack/delivery-adapter.ts`: Slack message and upload-v2 delivery.
- `src/slack/chat-adapter.ts`: Socket Mode lifecycle and composition.
- `assets/slack/manifest.yaml`: reusable single-workspace Slack app manifest.

Existing seams to extend:

- `src/config.ts` and `src/config-source.ts`: optional all-or-none adapter groups and primary selection.
- `src/chat/contracts.ts` and `src/chat/adapter-registry.ts`: optional adapter history capability.
- `src/storage/migrations.ts` and `src/storage/conversation-store.ts`: Slack inbox, activated threads, latest route, and atomic acceptance.
- `src/assistant/tools.ts` and `src/production-app.ts`: one generic history tool and two Slack-specific retrieval tools.
- `src/events/relay.ts`, `src/assistant/runtime.ts`, and warning producers in `src/production-app.ts`: resolve unsolicited routes at delivery creation time.
- `scripts/build.mjs`, `package.json`, and release tests: bundle Slack SDKs and package the manifest.

## Task 1: Make chat adapter configuration optional and composable

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config-source.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/production-app.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/config-source.test.ts`
- Modify: `tests/mcp/server.test.ts`
- Modify: `tests/production-startup.test.ts`

- [ ] **Step 1: Write failing configuration matrix tests**

Add table-driven cases covering Telegram-only, Slack-only, both with a valid `PRIMARY_CHAT_APP`, both without a primary, partial credential groups, invalid token prefixes, a primary naming an unconfigured adapter, and no configured adapter. Assert the parsed shape is discriminated and secrets never enter assistant or worker child environments:

```ts
assert.deepEqual(loadConfig(slackEnv, overrides).chat, {
  primary: "slack",
  telegram: undefined,
  slack: {
    appToken: "xapp-test",
    botToken: "xoxb-test",
    userToken: "xoxp-test",
    teamId: "T1",
    ownerUserId: "U1",
  },
});
for (const name of ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "SLACK_USER_TOKEN"]) {
  assert.equal(name in buildWorkerChildEnvironment(slackEnv), false);
  assert.equal(name in buildAssistantChildEnvironment(slackEnv, profile, "mcp"), false);
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/config.test.ts tests/config-source.test.ts tests/mcp/server.test.ts tests/production-startup.test.ts`

Expected: FAIL because Telegram is mandatory and Slack keys are unsupported.

- [ ] **Step 3: Implement grouped parsing and secret isolation**

Replace the flat mandatory Telegram fields in `BotConfig` with:

```ts
interface TelegramConfig { token: string; ownerId: number; destinationChatId: number }
interface SlackConfig { appToken: string; botToken: string; userToken: string; teamId: string; ownerUserId: string }
interface ChatConfig { primary: "telegram" | "slack"; telegram?: TelegramConfig; slack?: SlackConfig }
```

Parse each group as absent or complete. Preserve the Telegram owner/destination equality rule. Require at least one group; infer `primary` for exactly one group and require `PRIMARY_CHAT_APP` for two. Validate `xapp-`, `xoxb-`, `xoxp-`, `T...`, and `U...` shapes without logging values. Add Slack credentials and IDs plus `PRIMARY_CHAT_APP` to supported dotenv keys; add all credentials and identifiers to `BOT_SECRET_ENV_NAMES`/service-unset handling so no Slack authorization material crosses a child-process boundary.

Update every existing `BotConfig` consumer and typed fixture in this task. Until Task 12 composes Slack, `buildProductionApp` reads `config.chat.telegram` through a checked helper and throws an explicit unsupported-composition error when absent; this is a temporary internal transition, not flat-field compatibility. Existing Telegram startup behavior and tests remain green after the shape change.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/config.test.ts tests/config-source.test.ts tests/mcp/server.test.ts tests/production-startup.test.ts && npm run typecheck`

```bash
git add src/config.ts src/config-source.ts src/mcp/server.ts src/production-app.ts tests/config.test.ts tests/config-source.test.ts tests/mcp/server.test.ts tests/production-startup.test.ts
git commit -m "feat: support composable chat adapter config"
```

## Task 2: Add Slack and latest-route durable schema

**Files:**
- Modify: `src/storage/migrations.ts`
- Create: `src/chat/owner-route-store.ts`
- Modify: `src/storage/conversation-store.ts`
- Modify: `src/core/types.ts`
- Modify: `src/assistant/conversation-dispatcher.ts`
- Modify: `src/assistant/attempt-scope.ts`
- Modify: `src/production-app.ts`
- Test: `tests/storage/slack-schema.test.ts`
- Test: `tests/chat/owner-route-store.test.ts`
- Modify: `tests/storage/conversation-store.test.ts`
- Modify: `tests/assistant/attempt-scope.test.ts`
- Modify: `tests/production-app.test.ts`
- Modify: `tests/storage/database.test.ts`

- [ ] **Step 1: Write failing schema and route tests**

Assert the migration adds these tables and constraints:

```sql
CREATE TABLE slack_inbox (
  event_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  thread_ts TEXT,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  files_json TEXT NOT NULL,
  file_state_json TEXT NOT NULL DEFAULT '{}',
  arrival_sequence INTEGER NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('pending','processing','processed','retry')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  received_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE slack_inbox_sequence (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  next_value INTEGER NOT NULL
);
INSERT INTO slack_inbox_sequence(singleton, next_value) VALUES (1, 1);
CREATE TABLE activated_chat_conversations (
  adapter_id TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  destination_json TEXT NOT NULL,
  activated_at INTEGER NOT NULL,
  PRIMARY KEY(adapter_id, conversation_key)
);
CREATE TABLE latest_owner_route (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  adapter_id TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  destination_json TEXT NOT NULL,
  reply_json TEXT,
  source_context_id TEXT NOT NULL REFERENCES source_contexts(id),
  accepted_at INTEGER NOT NULL
);
```

Also assert `source_contexts` gains `failed_attachments_json TEXT NOT NULL DEFAULT '[]'`. A canonical source with a failed Slack file persists that descriptor without modifying `raw_text`; dispatcher input renders it as a separate text item and attempt-scoped `/pass` resolution rejects the source. At this task boundary, test only the inbox sequence column's uniqueness and seeded singleton; Task 4 implements and behaviorally tests allocation/order.

Test that accepting a new canonical Slack source inserts `kind='slack'` and updates `latest_owner_route` in the same transaction. Activation itself moves to the earlier Slack-inbox acknowledgement transaction in Task 4 so an immediate follow-up cannot race asynchronous processing. Duplicate native source acceptance must still advance neither arrival order nor latest route. Test `OwnerRouteStore.current()` returns the configured primary before the first source, and the durable latest binding afterward and after reopening.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/storage/slack-schema.test.ts tests/chat/owner-route-store.test.ts tests/storage/conversation-store.test.ts tests/assistant/conversation-dispatcher.test.ts tests/assistant/attempt-scope.test.ts tests/production-app.test.ts`

- [ ] **Step 3: Append the migration and route store**

Add indexes for `slack_inbox(state, arrival_sequence)` and activation lookup. Generalize `SourceContext.kind` to include `slack`, and make `ConversationStore.acceptChatSource` persist `kind=input.binding.adapterId` after validating a known adapter-safe identifier. Add an optional acceptance object and pass it through `ConversationDispatcher.accept`:

```ts
interface ChatAcceptanceEffects {
  commitNativeCheckpoint?: () => void;
}
```

Within the existing `BEGIN IMMEDIATE`, insert/dedupe the source including immutable failed-attachment descriptors, retain successful attachments, update the singleton latest route only for a newly accepted owner source, decide owner/queued disposition, create any queue notice, then call the native checkpoint. Add a read-only `hasChatSource(adapterId, nativeSourceId)` query for ingress preflight; acceptance remains the authoritative dedupe boundary. `OwnerRouteStore` accepts an immutable primary binding in its constructor and returns a defensive JSON-safe copy. Extend `AttemptScope` so `/pass` cannot resolve successfully when the matched directive source has a failed attachment. Test that a different ordinary attempt member's failed attachment does not invalidate a valid directive source.

Update Telegram's `onMessage` bridge in `src/production-app.ts` and every dispatcher caller in this task to pass `{ commitNativeCheckpoint }` rather than the old bare callback. Do not leave a temporarily incompatible overload: the task's focused tests and typecheck must pass at this commit.

- [ ] **Step 4: Preserve migration/cutover contracts**

Update exact migration counts and cutover validation so old Telegram databases gain empty Slack tables without changing retained source routing. Do not synthesize a latest accepted route from historical sources; primary fallback covers the pre-message state.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/storage/slack-schema.test.ts tests/chat/owner-route-store.test.ts tests/storage/conversation-store.test.ts tests/assistant/conversation-dispatcher.test.ts tests/assistant/attempt-scope.test.ts tests/production-app.test.ts tests/storage/conversation-cutover.test.ts tests/storage/database.test.ts && npm run typecheck`

```bash
git add src/storage/migrations.ts src/chat/owner-route-store.ts src/storage/conversation-store.ts src/core/types.ts src/assistant/conversation-dispatcher.ts src/assistant/attempt-scope.ts src/production-app.ts tests/storage/slack-schema.test.ts tests/chat/owner-route-store.test.ts tests/storage/conversation-store.test.ts tests/assistant/conversation-dispatcher.test.ts tests/assistant/attempt-scope.test.ts tests/production-app.test.ts tests/storage/database.test.ts
git commit -m "feat: persist Slack ingress and owner routes"
```

## Task 3: Classify Slack events without retaining unauthorized content

**Files:**
- Create: `src/slack/types.ts`
- Create: `src/slack/event-classifier.ts`
- Test: `tests/slack/event-classifier.test.ts`

- [ ] **Step 1: Write classifier tests**

Cover owner DM, top-level mention, mention inside a thread, activated-thread follow-up, inactive channel traffic, wrong owner/team, bot/service/edit events, malformed payloads, overlapping `app_mention`/`message.channels`, file metadata normalization, and exact leading mention stripping. Include the safeguard cases:

```ts
assert.equal(classify(ownerMention("<@B1> /pass  exact"), ctx).source.rawText, "/pass  exact");
assert.equal(classify(ownerMention("before <@B1> after"), ctx).source.rawText, "before <@B1> after");
assert.equal(classify(ownerMention("<@B1> /collect 3"), ctx).source.rawText, "/collect 3");
```

Assert keys and destinations exactly:

```ts
slack:T1:dm:D1
slack:T1:thread:C1:1710000000.000100
{ workspaceId: "T1", channelId: "C1", threadTs: "1710000000.000100" }
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/slack/event-classifier.test.ts`

- [ ] **Step 3: Implement pure normalization and classification**

Expose a pure result union `discard | accept`. The classifier receives only team/owner/bot IDs and an `isActivated(conversationKey)` callback. Persistable accepted data contains event ID, stable native source ID `${team}:${channel}:${ts}`, canonical source scope derived from that native identity, semantic text, bounded file descriptors (`id`, sanitized name, MIME, declared size, private download URL), binding, received time, and `activate=true` for mentions. Do not include envelope IDs, `action_token`, authorization objects, blocks unrelated to exact mention filtering, or the raw event.

Use `thread_ts ?? ts` for channel roots, ordinary DM destinations without a root, and `reply: { messageTs: ts }`. Reject message subtypes by default and allow only the ordinary owner-authored message forms explicitly tested.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/slack/event-classifier.test.ts && npm run typecheck`

```bash
git add src/slack/types.ts src/slack/event-classifier.ts tests/slack/event-classifier.test.ts
git commit -m "feat: classify authorized Slack events"
```

## Task 4: Add a durable Slack inbox and acknowledgement boundary

**Files:**
- Create: `src/slack/inbox-store.ts`
- Create: `src/slack/envelope-handler.ts`
- Create: `src/slack/ingress-worker.ts`
- Test: `tests/slack/inbox-store.test.ts`
- Test: `tests/slack/envelope-handler.test.ts`
- Test: `tests/slack/ingress-worker.test.ts`

- [ ] **Step 1: Write failing durable-boundary tests**

With injected fake clients, assert:

- authorized normalized data commits before `ack()`;
- a database failure prevents `ack()`;
- unauthorized/unsupported envelopes call `ack()` without an insert;
- an authorized mention atomically inserts its activation with the inbox row, so an immediate owner follow-up arriving before either row drains is retained and acknowledged;
- duplicate `event_id` and overlapping stable message identities are harmless;
- equal-time events from different conversations process in committed inbox arrival-sequence order rather than event-ID order;
- startup drains rows left pending/retry;
- source acceptance and `state='processed'` commit together through the conversation-store checkpoint;
- transient file errors leave retry state while preserving completed per-file checkpoints;
- permanent file errors preserve raw text, persist a separate unavailable descriptor, render a separate Codex input item, and queue one same-binding warning;
- an attachment-only permanent failure still creates a source with a failed descriptor;
- `/pass` plus any permanently unavailable file is rejected at the safeguard boundary;
- overlapping `app_mention`/`message.*` event IDs with a successful file cause one download, one deterministic attachment row/retain, and no warning;
- the same overlap with a permanent failure causes one failure decision, zero attachment rows/retains, one failed descriptor, and one warning;
- crashes after each downloaded file or immediately before source acceptance reuse one deterministic stored object and one eventual retain;
- an older retry row blocks later inbox processing so canonical arrival order cannot invert.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/slack/inbox-store.test.ts tests/slack/envelope-handler.test.ts tests/slack/ingress-worker.test.ts`

- [ ] **Step 3: Implement inbox persistence and draining**

`SlackInboxStore.accept` allocates a monotonic inbox arrival sequence and performs `INSERT OR IGNORE` of normalized fields; for an authorized mention it also `INSERT OR IGNORE`s its activated conversation in the same transaction before acknowledgement. Duplicates do not consume a new committed ordering decision. `claimNext` changes only the lowest-sequence unprocessed row to processing; an older retry blocks newer rows. Per-file checkpoint updates record only deterministic attachment IDs, Slack file IDs, and completed/permanent-failure state. `retry` stores a redacted bounded error summary. Recovery changes orphaned processing rows back to retry.

`SlackEnvelopeHandler` models the official Socket Mode emitted payload, including its public `ack` callback. It classifies, durably accepts/discards, and invokes `ack()` after the required commit; it never reaches into private `SocketModeClient.send` internals. Task 10 only wires this tested handler to the real client.

`SlackIngressWorker.processOne` first checks for an already accepted `(adapter_id, native_source_id)` and, when present, sends the duplicate through canonical acceptance only to atomically mark this inbox row processed—before any file work. This suppresses repeat permanent failures and warnings as well as successful downloads. Otherwise it streams each authorized file through `AttachmentStore.ingest` under the stable native-message source scope, passing a deterministic `file_<sha256(team,channel,messageTs,file)>` requested ID. Check `AttachmentStore.get` before requesting Slack download. Existing completed handles are reused; a crash orphan with no metadata is safely replaced by the attachment store's requested-ID path. Classify SDK/file failures with explicit injected predicates. On success call:

```ts
await onMessage(source, {
  commitNativeCheckpoint: () => inbox.markProcessedInTransaction(eventId),
});
```

For a permanent file failure, add `{ slackFileId, displayName, reasonCode }` to `failedAttachments` without changing semantic text, and prepare one mandatory warning using the source binding inside the acceptance checkpoint. `ConversationDispatcher.input` renders `[Slack attachment unavailable: <safe name>]` as a separate model item. Never store bearer headers or Slack response bodies in `last_error`.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/slack/inbox-store.test.ts tests/slack/envelope-handler.test.ts tests/slack/ingress-worker.test.ts tests/attachments/store.test.ts && npm run typecheck`

```bash
git add src/slack/inbox-store.ts src/slack/envelope-handler.ts src/slack/ingress-worker.ts tests/slack/inbox-store.test.ts tests/slack/envelope-handler.test.ts tests/slack/ingress-worker.test.ts
git commit -m "feat: add durable Slack ingress"
```

## Task 5: Wrap the official Slack clients behind narrow capabilities

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/slack/clients.ts`
- Test: `tests/slack/clients.test.ts`

- [ ] **Step 1: Install pinned SDKs and write capability tests**

Run: `npm install --save-dev @slack/socket-mode@latest @slack/web-api@latest`

Pin the exact resolved versions in `package.json` after installation. Test injected `WebClient`-shaped fakes so the bot client exposes only auth, DM resolution, history, posting, file download, upload-v2, channel/user lookup; the user client exposes only `auth.test`, `assistant.search.info`, and `assistant.search.context`. Assert no generic `apiCall` escapes either wrapper.

- [ ] **Step 2: Test startup identity and coverage validation**

Assert validation rejects wrong team, wrong user, owner/bot identity collision, unavailable Real-time Search, and an unresolvable owner DM. `assistant.search.info` contributes only `is_ai_search_enabled`. Coverage metadata separately records categories requested by configuration, that Slack enforces current token authorization, and explicit call omissions/errors; it never invents per-user private/IM/MPIM/file/user consent or “unavailable” categories from search-info.

- [ ] **Step 3: Implement official-SDK wrappers**

Create separate SDK instances for bot reads, bot writes, and user search. Configure the write client with zero automatic retries and `rejectRateLimitedCalls=true`; read-only clients may use bounded SDK retries. Convert SDK failures into `SlackApiError` with `status`, `retryAfterMs`, `deterministic`, `safeToRetry`, and a sanitized message; never retain request headers, token-bearing URLs, or raw authorization payloads. `safeToRetry` is true only when Slack proves no write began. Use `conversations.open({users: ownerId})` for the primary DM. The Socket Mode client is constructed separately with the app token and receives no user token.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/slack/clients.test.ts tests/config.test.ts && npm run typecheck`

```bash
git add package.json package-lock.json src/slack/clients.ts tests/slack/clients.test.ts
git commit -m "feat: add narrow official Slack clients"
```

## Task 6: Implement Slack message and file delivery

**Files:**
- Create: `src/slack/delivery-adapter.ts`
- Modify: `src/chat/contracts.ts`
- Modify: `src/chat/delivery-worker.ts`
- Test: `tests/slack/delivery-adapter.test.ts`
- Modify: `tests/chat/delivery-worker.test.ts`
- Modify: `tests/telegram/delivery-worker.test.ts`

- [ ] **Step 1: Write failing delivery tests**

Assert DM and threaded `chat.postMessage` arguments, deterministic `client_msg_id` from delivery ID, opaque receipts, and `filesUploadV2` arguments/receipts. Assert the source contains no `files.upload` call. Exercise a pre-dispatch rate limit, deterministic error, ambiguous message transport failure, and injected failures at upload-URL, byte-upload, and completion stages. Verify only a failure proven to precede a side effect becomes prepared again; every ambiguous stage becomes uncertain without blind repeat.

- [ ] **Step 2: Extend the adapter contract with delivery identity**

Change the shared contract to pass stable delivery identity without adding Slack-specific methods:

```ts
sendMessage(destination: JsonValue, body: string, reply?: JsonValue, options?: { deliveryId: string }): Promise<JsonValue>;
sendDocument?(destination: JsonValue, file: ExistingFileShape & { deliveryId: string }): Promise<JsonValue>;
```

Update Telegram to ignore the extra value. Have `DeliveryWorker` always provide it.

- [ ] **Step 3: Implement Slack delivery**

Validate destination workspace/channel/root values. Call `chat.postMessage` with `thread_ts` only for channel-thread destinations and a UUID-form stable `client_msg_id` derived from a SHA-256 of delivery ID. Use the SDK's current upload-v2 flow for documents and include channel/thread/caption. The write client performs no internal retry. Return `{ channelId, messageTs }` and file IDs when supplied. Add an optional adapter-specific `isSafeToRetry(error)` contract. Slack returns true only for `safeToRetry === true`; adapters without it retain the existing generic rate-limit behavior, preserving Telegram's `429`/`retry_after` retries and document-stream reopen semantics. Ambiguous Slack file-helper failures remain uncertain.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/slack/delivery-adapter.test.ts tests/chat/delivery-worker.test.ts tests/telegram/delivery-worker.test.ts tests/telegram/chat-adapter.test.ts && npm run typecheck`

```bash
git add src/slack/delivery-adapter.ts src/chat/contracts.ts src/chat/delivery-worker.ts src/telegram/delivery-adapter.ts tests/slack/delivery-adapter.test.ts tests/chat/delivery-worker.test.ts tests/telegram/delivery-worker.test.ts
git commit -m "feat: deliver Slack messages and files"
```

## Task 7: Add generic current-chat history routing

**Files:**
- Modify: `src/chat/contracts.ts`
- Modify: `src/chat/adapter-registry.ts`
- Modify: `src/assistant/tools.ts`
- Modify: `src/production-app.ts`
- Create: `src/slack/context-service.ts`
- Test: `tests/chat/adapter-registry.test.ts`
- Modify: `tests/assistant/tools.test.ts`
- Test: `tests/slack/context-service.test.ts`
- Modify: `tests/production-app.test.ts`

- [ ] **Step 1: Write failing schema and routing tests**

Add the sole generic history schema:

```ts
get_chat_history: z.object({
  scope: z.enum(["conversation", "channel"]),
  count: z.number().int().positive().max(100),
  before: z.string().min(1).optional(),
}).strict()
```

Assert it is read-only and routes using the immutable assistant-attempt binding. Telegram throws `UNSUPPORTED_CAPABILITY`. A Slack channel thread uses `conversations.replies` with its root timestamp and includes root plus replies; a DM conversation and channel scope use `conversations.history`. For a thread longer than two pages, test that oldest-first Slack pages feed a bounded `count`-sized ring selecting the newest window before the boundary, root timestamps are deduplicated, output is oldest-to-newest, and consecutive exclusive `before` windows have no overlap or gap.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/chat/adapter-registry.test.ts tests/assistant/tools.test.ts tests/slack/context-service.test.ts tests/production-app.test.ts`

- [ ] **Step 3: Implement adapter-neutral history capability**

Add `ChatHistoryProvider` and optional `history` on `ChatAdapter`; register full adapter capabilities rather than delivery-only objects. `ChatAdapterRegistry.getHistory(binding, request)` validates adapter/binding agreement and returns an actionable unsupported error when absent. `SlackContextService.history` uses the bot client only. For replies it consumes every oldest-first page up to the exclusive boundary while retaining only the newest `count` deduplicated messages; for newest-first history it stops when the window is full. It normalizes authors/text/timestamps/thread IDs and never includes raw payloads or tokens.

- [ ] **Step 4: Wire the tool action and verify**

The production action calls `assistantAttemptBinding(context.attemptId)` and then `chatRegistry.getHistory(...)`. It must not accept an adapter, channel ID, or destination from model arguments.

Run: `npm test -- tests/chat/adapter-registry.test.ts tests/assistant/tools.test.ts tests/slack/context-service.test.ts tests/production-app.test.ts && npm run typecheck`

```bash
git add src/chat/contracts.ts src/chat/adapter-registry.ts src/assistant/tools.ts src/production-app.ts src/slack/context-service.ts tests/chat/adapter-registry.test.ts tests/assistant/tools.test.ts tests/slack/context-service.test.ts tests/production-app.test.ts
git commit -m "feat: add current chat history tool"
```

## Task 8: Bound Slack search output without retaining it

**Files:**
- Create: `src/slack/result-limiter.ts`
- Test: `tests/slack/result-limiter.test.ts`

- [ ] **Step 1: Write transient boundary tests**

Test 30 vs. 31 matches, exactly 3,000 vs. 3,001 Unicode-whitespace words, stable newest-first ordering with channel/timestamp tie break, and deterministic prefix selection. Feed hundreds of pages and assert retained object count/word storage never exceeds the configured prefix bounds while total count continues increasing. Assert a large result returns total `count`, bounded `returned_count`, `truncated=true`, no `path`, and narrowing guidance.

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/slack/result-limiter.test.ts`

- [ ] **Step 3: Implement the in-memory limiter**

Return only:

```ts
interface TransientResults<T> {
  count: number;
  returned_count: number;
  truncated: boolean;
  order: "newest_first";
  complete: boolean;
  coverage: SearchCoverage;
  warning?: string;
  results: T[];
}
```

The limiter is an incremental accumulator: `addPage` receives one newest-first normalized page, updates total count, and retains only the stable newest prefix within both bounds while immediately discarding other bodies. `finish` adds completion/coverage metadata. It performs no filesystem, database, logging, or operation-store work and never accepts a complete result array.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/slack/result-limiter.test.ts && npm run typecheck`

```bash
git add src/slack/result-limiter.ts tests/slack/result-limiter.test.ts
git commit -m "feat: bound transient Slack results"
```

## Task 9: Implement Slack search and exact owner mentions

**Files:**
- Modify: `src/slack/context-service.ts`
- Modify: `src/assistant/tools.ts`
- Modify: `src/production-app.ts`
- Modify: `assets/assistant/AGENTS.md`
- Modify: `tests/slack/context-service.test.ts`
- Modify: `tests/assistant/tools.test.ts`
- Modify: `tests/assistant/policy.test.ts`

- [ ] **Step 1: Write failing search behavior tests**

Cover UTC normalization for `YYYY-MM-DD` and ISO timestamps, inclusive `date_from`, exclusive `date_to`, default call time, every internal cursor consumed, messages/files/channels/context/permalinks preserved, stable newest-first order, requested/Slack-enforced coverage metadata without unprovable completeness claims, first-page failure, and later-page partial success (`complete=false` plus warning).

For `get_slack_mentions(date_from)`, assert the query uses the exact configured `<@OWNER_ID>` token and post-filter both text and rich-text block user elements. Reject substring names, escaped textual lookalikes, and other user IDs. Confirm Slack cursors never appear in a tool response.

At the actual `createAssistantTools` boundary, return a unique sentinel result body and assert: no operation row is created; repeating the same call ID executes a fresh read; the sentinel appears in no SQLite text column, data-directory file, captured diagnostic log, or dashboard state. This is the acceptance test for Slack's no-storage policy, not the standalone limiter test.

- [ ] **Step 2: Add exactly two Slack-specific schemas**

```ts
search_slack: z.object({
  query: z.string().min(1),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
}).strict(),
get_slack_mentions: z.object({ date_from: z.string() }).strict(),
```

Mark both ephemeral read-only. Extend `createAssistantTools` with an explicit `EPHEMERAL_READ_TOOLS` path that validates arguments and calls the action without creating, checkpointing, succeeding, or replaying an operation row. Do not add `send_slack_message`, Slack attachment tools, cursor tools, or multiple search variants.

- [ ] **Step 3: Implement paginated search and materialization**

Use only the narrow user client, normalize each page and feed it immediately to the incremental transient limiter. Consume all cursors for count/completion while returning only the newest bounded prefix; never write search bodies to SQLite, files, logs, dashboards, or operation receipts. A revoked user token causes these actions to throw an actionable Slack search unavailable error while bot messaging remains untouched. The assistant policy should list the generic history tool and two Slack tools succinctly, explaining truncation and coverage limitations without duplicating MCP schemas.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/slack/context-service.test.ts tests/slack/result-limiter.test.ts tests/assistant/tools.test.ts tests/assistant/policy.test.ts && npm run typecheck`

```bash
git add src/slack/context-service.ts src/assistant/tools.ts src/production-app.ts assets/assistant/AGENTS.md tests/slack/context-service.test.ts tests/assistant/tools.test.ts tests/assistant/policy.test.ts
git commit -m "feat: add Slack search and mention tools"
```

## Task 10: Compose the Slack adapter and Socket Mode lifecycle

**Files:**
- Create: `src/slack/chat-adapter.ts`
- Modify: `src/chat/contracts.ts`
- Modify: `src/telegram/chat-adapter.ts`
- Modify: `src/slack/ingress-worker.ts`
- Test: `tests/slack/chat-adapter.test.ts`

- [ ] **Step 1: Write lifecycle and acknowledgement tests**

Inject a low-level `SocketModeClient` facade matching `@slack/socket-mode` 2.0.7's public emitted `slack_event` payload and `ack` callback. Assert `start()` validates credentials/coverage/owner DM, recovers inbox rows, installs and enables the persistence handler, and only then connects. Emit an event after connection begins but before `start()` resolves and assert it is durably handled/acknowledged. Assert SDK reconnect events do not duplicate handlers, disconnection does not close delivery/context clients, and `stop`/`close` are idempotent. Never reach into the client's private `send` method.

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/slack/chat-adapter.test.ts`

- [ ] **Step 3: Implement `SlackChatAdapter`**

Expose `delivery`, optional `history`, `context`, `primaryBinding`, and an asynchronous `ChatAdapter.initialize()` lifecycle. Initialization performs auth/search checks and owner-DM resolution without accepting ingress. After dispatcher recovery, `start()` recovers pending inbox state, enables the already-tested `SlackEnvelopeHandler`, subscribes it, and then calls the Socket Mode client's `start()`. Runtime disconnection is contained inside the adapter; it does not signal global app shutdown. Handler inputs are immediately reduced to the classifier's allowed envelope fields. Telegram implements `initialize()` as a no-op and keeps its polling start behavior.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/slack/chat-adapter.test.ts tests/slack/ingress-worker.test.ts tests/slack/clients.test.ts && npm run typecheck`

```bash
git add src/slack/chat-adapter.ts src/chat/contracts.ts src/telegram/chat-adapter.ts src/slack/ingress-worker.ts tests/slack/chat-adapter.test.ts
git commit -m "feat: compose Slack Socket Mode adapter"
```

## Task 11: Route unsolicited output through the latest owner conversation

**Files:**
- Modify: `src/events/relay.ts`
- Modify: `src/assistant/runtime.ts`
- Modify: `src/assistant/auth-recovery.ts`
- Modify: `src/production-app.ts`
- Modify: `tests/events/relay.test.ts`
- Modify: `tests/assistant/runtime.test.ts`
- Modify: `tests/assistant/auth-recovery.test.ts`
- Modify: `tests/integration/recovery.test.ts`

- [ ] **Step 1: Write failing dynamic-route tests**

Assert direct assistant finals and tool sends retain the attempt's immutable Slack/Telegram binding. Assert worker finals, permission warnings, startup warnings, endpoint failures, registry warnings, and background failures select `OwnerRouteStore.current()` when the delivery record is created. After accepting a message on another adapter, new unsolicited output follows it while existing outbox records keep their original binding. Reopen the database and repeat.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/events/relay.test.ts tests/assistant/runtime.test.ts tests/assistant/auth-recovery.test.ts tests/integration/recovery.test.ts`

- [ ] **Step 3: Replace static administrative bindings**

Pass `binding: () => ConversationBinding` to producers of unsolicited delivery intent, or pass `OwnerRouteStore` directly where clearer. Call it exactly once per `DeliveryStore.prepare` and freeze that result. Keep causal attempt paths unchanged. `AssistantRuntime` may use current route only for destinationless internal work; a chat attempt must still resolve its persisted attempt binding.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/events/relay.test.ts tests/assistant/runtime.test.ts tests/assistant/auth-recovery.test.ts tests/integration/recovery.test.ts && npm run typecheck`

```bash
git add src/events/relay.ts src/assistant/runtime.ts src/assistant/auth-recovery.ts src/production-app.ts tests/events/relay.test.ts tests/assistant/runtime.test.ts tests/assistant/auth-recovery.test.ts tests/integration/recovery.test.ts
git commit -m "feat: follow the latest owner chat route"
```

## Task 12: Run Telegram and Slack concurrently in production

**Files:**
- Modify: `src/production-app.ts`
- Modify: `src/chat/adapter-registry.ts`
- Modify: `src/storage/conversation-cutover.ts`
- Modify: `src/storage/database.ts`
- Modify: `src/assistant/conversation-dispatcher.ts`
- Modify: `tests/production-startup.test.ts`
- Modify: `tests/production-app.test.ts`
- Modify: `tests/storage/conversation-cutover.test.ts`
- Modify: `tests/storage/database.test.ts`
- Create: `tests/integration/multi-chat.test.ts`

- [ ] **Step 1: Write production composition tests**

Inject adapter factories and assert Telegram-only, Slack-only, and dual startup. In dual mode both adapters share `dispatcher.accept`, `AttachmentStore`, `DeliveryStore`, and one `ChatAdapterRegistry`; failures during configured Slack validation roll back startup; runtime Slack disconnect leaves Telegram active. Stop all ingress before delivery, close every transport, and aggregate cleanup deterministically.

Add migration cases for (a) a fresh Slack-only database, which completes routing backfill with no legacy Telegram binding, and (b) a pre-cutover database containing Telegram rows after Telegram configuration was removed, which fails closed with `CONFIGURATION_ERROR` before writable open. Snapshot the database bytes and absence/content of `-wal`/`-shm` sidecars and assert they remain unchanged. A configured legacy Telegram binding may reconstruct only those historical Telegram rows even when Slack is primary.

The integration scenario must prove:

1. a Slack thread starts and its follow-up steers;
2. Telegram and another Slack thread each receive exact `[system] queued`;
3. the next durable arrival starts after terminalization;
4. Slack follow-up without a new mention remains eligible because activation is durable;
5. causal outputs return to the originating app;
6. later unsolicited worker output follows the latest accepted owner route.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/production-startup.test.ts tests/production-app.test.ts tests/storage/conversation-cutover.test.ts tests/storage/database.test.ts tests/integration/multi-chat.test.ts`

- [ ] **Step 3: Implement multi-adapter composition**

Replace singular `chat` with `ChatAdapter[]`. Before `openDatabase` enables WAL or applies migrations, call a new immutable/read-only `preflightConversationCutover(path, hasLegacyTelegramBinding)` that inspects an existing state database and rejects unbound retained Telegram rows without creating sidecars or mutating bytes. Then, during the storage phase, call `runConversationRoutingBackfill(db, config.chat.telegram ? telegramBinding : undefined)`: fresh Slack-only state succeeds because no legacy rows require reconstruction. After storage and attachment setup, construct every configured adapter and call `initialize()` before creating any startup-warning delivery. Determine the primary binding (Telegram private chat or the initialized Slack owner DM), construct `OwnerRouteStore`, and only then materialize registry/workspace/access warnings. The administrative primary route never participates in legacy backfill, so selecting Slack as primary cannot reinterpret historical Telegram rows. Start one delivery worker over all delivery implementations. Adapter ingress starts only after dispatcher recovery. Use `Promise.allSettled`-style cleanup so one adapter's close error does not skip another.

Keep conversation ownership entirely in `ConversationDispatcher`; do not create an app-level queue, per-adapter active-turn flag, or special `/pass`/`/collect` branch. In `ConversationDispatcher.input`, prepend a separate derived origin text item (`[slack <channel-id> thread]`, `[slack dm]`, or `[telegram]`) before the immutable semantic text. Derive it only from the persisted binding; never prepend it to `rawText`, so exact safeguard validation is unchanged.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/production-startup.test.ts tests/production-app.test.ts tests/storage/conversation-cutover.test.ts tests/storage/database.test.ts tests/integration/multi-chat.test.ts tests/assistant/conversation-dispatcher.test.ts && npm run typecheck`

```bash
git add src/production-app.ts src/chat/adapter-registry.ts src/storage/conversation-cutover.ts src/storage/database.ts src/assistant/conversation-dispatcher.ts tests/production-startup.test.ts tests/production-app.test.ts tests/storage/conversation-cutover.test.ts tests/storage/database.test.ts tests/integration/multi-chat.test.ts tests/assistant/conversation-dispatcher.test.ts
git commit -m "feat: run Slack and Telegram together"
```

## Task 13: Package the manifest and document Slack setup

**Files:**
- Create: `assets/slack/manifest.yaml`
- Modify: `package.json`
- Modify: `scripts/build.mjs`
- Modify: `docs/chat-apps/slack.md`
- Modify: `docs/chat-apps/telegram.md`
- Modify: `docs/setup.md`
- Modify: `README.md`
- Modify: `tests/docs.test.ts`
- Modify: `tests/distribution/package-info.test.ts`
- Modify: `tests/distribution/release-workflow.test.ts`

- [ ] **Step 1: Write failing manifest, docs, and package tests**

Assert the manifest enables Socket Mode, App Home messages, the four approved events, exactly the approved bot/user scopes, and no incoming webhooks or redirect URLs. Assert `npm pack --dry-run --json` includes `assets/slack/manifest.yaml`, the bundled runtime contains Slack SDK code, and the package still has no runtime install tree.

Docs contract tests must require all five Slack dotenv fields, `PRIMARY_CHAT_APP` dual-adapter behavior, mode-0600 `.env`, app/user/bot token separation, internal-app Real-time Search eligibility, private-search consent, owner/workspace ID discovery, channel invitation/activation, thread follow-ups, transient/truncated search behavior, Activity limitations, attachment limits, revocation, and troubleshooting.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/docs.test.ts tests/distribution/package-info.test.ts tests/distribution/release-workflow.test.ts`

- [ ] **Step 3: Add manifest, packaging, and guides**

Add the manifest to `package.json.files`; make the build/release contract preserve it beside the binary and assistant assets. Replace Slack's planned stub with exact setup steps. Update README language from “Telegram first, Slack planned” to implemented multi-adapter support, make requirements say at least one adapter, and remove Slack from deferred work. Clarify that the user token is read-only by code boundary but remains powerful and should be revoked if search is unwanted.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/docs.test.ts tests/distribution/package-info.test.ts tests/distribution/release-workflow.test.ts && npm run build`

```bash
git add assets/slack/manifest.yaml package.json scripts/build.mjs docs/chat-apps/slack.md docs/chat-apps/telegram.md docs/setup.md README.md tests/docs.test.ts tests/distribution/package-info.test.ts tests/distribution/release-workflow.test.ts
git commit -m "docs: add Slack installation and manifest"
```

## Task 14: Add recovery and opt-in live coverage

**Files:**
- Modify: `tests/integration/recovery.test.ts`
- Create: `tests/integration/slack-live.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add crash-point integration cases**

Cover crash after inbox commit/before ack, after ack/before processing, after each deterministic attachment ingestion/before source acceptance, after source acceptance/before inbox processed commit, overlapping mention/message events carrying the same successfully downloaded file, the same overlap with a permanent file failure, after Slack message dispatch/before receipt persistence, and after upload completion ambiguity. For successful overlap assert one download, attachment row, retain, and no warning. For permanent-failure overlap assert one failure decision, zero attachment rows/retains, one failed descriptor, and one warning. Across restart preserve latest route and never repeat an optional uncertain effect.

- [ ] **Step 2: Add a skipped-by-default live test**

Guard with `RUN_SLACK_INTEGRATION=1` plus dedicated test credentials. Exercise owner DM receipt/reply, channel mention/thread reply, owner thread follow-up, a small inbound/outbound file, public search, and exact mention retrieval. Refuse to run when credentials do not match a designated test workspace/user pair.

- [ ] **Step 3: Run recovery tests and compile the live test**

Run: `npm test -- tests/integration/recovery.test.ts tests/integration/slack-live.test.ts && npm run typecheck`

- [ ] **Step 4: Commit**

```bash
git add tests/integration/recovery.test.ts tests/integration/slack-live.test.ts README.md
git commit -m "test: cover Slack recovery and live round trip"
```

## Task 15: Final verification and release-package audit

**Files:**
- Modify only if verification exposes a defect.

- [ ] **Step 1: Search for forbidden or duplicated surfaces**

Run:

```bash
rg -n "files\.upload|send_slack|search_slack_.*cursor|action_token|slack-results|SLACK_(APP|BOT|USER)_TOKEN" src assets/assistant
```

Expected: no deprecated upload, no platform-specific send duplicates, no exposed cursor tools, no action-token persistence, no search-report storage path, and Slack token names only in configuration isolation code (never values or assistant policy).

- [ ] **Step 2: Run the complete verification suite**

Run:

```bash
npm run check
npm run build
node dist/qiyan-bot --version
npm pack --dry-run
git diff --check
```

Expected: all pass, the standalone binary starts without `node_modules`, and the pack list contains only intended runtime/docs/assets.

- [ ] **Step 3: Self-review against the approved design**

Trace every design section to code/tests: token separation, all-or-none config, manifest, durable ack, activation, exact source text, conversation steering, latest route, generic tools, search completeness, large-result safety, attachments, delivery uncertainty, migration, dual-adapter operation, docs, and live-test gating. Check type/API consistency across every caller after contract changes.

- [ ] **Step 4: Request code review and fix until clean**

Give reviewers the approved design, this plan, commit range, and verification evidence. Resolve findings test-first, rerun focused and full verification, and request re-review until no actionable findings remain.

- [ ] **Step 5: Commit any final fixes**

```bash
git add -A
git commit -m "fix: address Slack support review"
```
