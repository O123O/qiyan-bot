# Codex Chat Bot MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the verified local MVP of a single-user Telegram assistant whose persistent Codex coordinator manages ordinary local Codex sessions through one owned `codex app-server` process.

**Architecture:** A modular TypeScript process owns Telegram long polling, SQLite state, an app-server JSON-RPC client, a loopback MCP tool server, session/attachment services, and the coordinator scheduler. Human-editable JSON owns nickname mappings, SQLite owns operational truth, and the coordinator owns a gitignored manager notebook. All external effects pass through durable operation/delivery records.

**Tech Stack:** Node.js 24+, TypeScript 6, Node test runner, `tsx`, built-in `node:sqlite`, `zod`, `@modelcontextprotocol/sdk`, native `fetch`, and Codex app-server 0.142.4 protocol schemas.

---

## Scope and file map

The plan implements only the local Telegram MVP. SSH endpoints, Slack, WeChat, multiple users, voice/video, and multiple local app-server shards remain deferred.

```text
package.json                         scripts and pinned dependencies
tsconfig.json                       strict TypeScript configuration
.gitignore                          runtime state and secrets
scripts/run-tests.mjs               recursive and targeted test runner
src/main.ts                         process entry point and shutdown
src/app.ts                          dependency composition
src/config.ts                       environment parsing and defaults
src/core/errors.ts                  stable typed application errors
src/core/types.ts                   canonical IDs, messages, sessions, events
src/core/clock.ts                   injectable time source
src/storage/database.ts             SQLite lifecycle and transactions
src/storage/migrations.ts           schema migrations
src/storage/operation-store.ts      durable source contexts and side effects
src/storage/delivery-store.ts       Telegram outbox and ambiguity states
src/storage/runtime-store.ts        session epochs, cursors, event batches
src/directives/parser.ts            raw `/pass` and `/collect` grammar
src/registry/session-registry.ts    atomic human-editable JSON registry
src/app-server/protocol.ts          narrowed generated protocol types
src/app-server/json-rpc-client.ts   request/response/notification transport
src/app-server/local-endpoint.ts    owned stdio app-server process
src/app-server/pool.ts              endpoint abstraction and capacity
src/sessions/discovery.ts           exhaustive snapshot-based discovery
src/sessions/lifecycle.ts           create/register/adopt/detach/attach/archive
src/sessions/final-messages.ts      terminal-turn logical message extraction
src/sessions/service.ts             status, send/steer, collect, model, goals
src/attachments/store.ts            streamed storage and opaque handles
src/telegram/api.ts                 Bot API HTTP client
src/telegram/adapter.ts             canonical inbound/outbound conversion
src/telegram/poller.ts              owner-only long polling
src/telegram/delivery-worker.ts     durable at-least-once outbox delivery
src/events/relay.ts                 app-server terminal event extraction/delivery
src/coordinator/scheduler.ts        fair user/event queue and batching
src/coordinator/runtime.ts          coordinator thread and recovery contexts
src/coordinator/tools.ts            validated coordinator tool handlers
src/mcp/server.ts                   loopback Streamable HTTP MCP server
coordinator/AGENTS.override.md      durable coordinator operating policy
coordinator/session-status.example.json
coordinator/.gitignore              live manager notebook exclusion
AGENTS.md                            repository development instructions
scripts/generate-app-server-schema.mjs
tests/**                            unit, contract, integration, recovery tests
```

## Task 1: Project scaffold, configuration, and core contracts

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `scripts/run-tests.mjs`
- Create: `src/config.ts`
- Create: `src/core/errors.ts`
- Create: `src/core/types.ts`
- Create: `src/core/clock.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write failing configuration tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

test("loadConfig requires the Telegram owner and token", () => {
  assert.throws(() => loadConfig({}), /TELEGRAM_BOT_TOKEN/);
});

test("loadConfig applies bounded defaults", () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: "secret",
    TELEGRAM_OWNER_ID: "42",
    TELEGRAM_DESTINATION_CHAT_ID: "42",
  });
  assert.equal(config.maxConcurrentTurns, 4);
  assert.equal(config.maxCollectCount, 20);
  assert.equal(config.mcpHost, "127.0.0.1");
});
```

- [ ] **Step 2: Add the pinned package and compiler configuration**

```json
{
  "name": "codex-chat-bot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "start": "tsx src/main.ts",
    "test": "node scripts/run-tests.mjs",
    "typecheck": "tsc --noEmit",
    "check": "npm run typecheck && npm test",
    "generate:codex-schema": "node scripts/generate-app-server-schema.mjs"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.29.0",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/node": "26.0.1",
    "tsx": "4.22.4",
    "typescript": "6.0.3"
  }
}
```

Use `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `allowImportingTsExtensions: true`, `noEmit: true`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, and include `src`, `tests`, and `scripts`.

`scripts/run-tests.mjs` recursively discovers every `*.test.ts` file when called without arguments and otherwise passes only its explicit CLI paths to `node --import tsx --test`. Sort discovered paths for deterministic output and propagate the child exit status.

- [ ] **Step 3: Implement strict configuration and shared contracts**

```ts
export type SessionKey = `${string}:${string}`;
export type ManagementState =
  | "managed" | "detaching" | "detached"
  | "attaching" | "archived" | "unavailable";
export type OperationState = "prepared" | "dispatched" | "succeeded" | "failed" | "uncertain";
export type DeliveryState = "prepared" | "dispatched" | "confirmed" | "failed" | "uncertain";

export interface SourceContext {
  id: string;
  kind: "telegram" | "event_batch" | "recovery";
  sourceId: string;
  rawText: string;
  attachmentIds: readonly string[];
}
```

Implement `AppError` with the exact stable codes from the design, a `SystemClock`, and `loadConfig(env)` using `zod`. Do not read `process.env` outside `main.ts`.

Add `OPERATION_CONFLICT` as the stable code for replaying one operation identity with a different canonical argument hash.

- [ ] **Step 4: Install and verify**

Run: `npm install`

Run: `npm test -- tests/config.test.ts`

Expected: 2 passing tests.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore scripts/run-tests.mjs src/core src/config.ts tests/config.test.ts
git commit -m "chore: scaffold TypeScript bot"
```

## Task 2: SQLite schema, source contexts, operation ledger, and outbox

**Files:**
- Create: `src/storage/database.ts`
- Create: `src/storage/migrations.ts`
- Create: `src/storage/operation-store.ts`
- Create: `src/storage/delivery-store.ts`
- Create: `src/storage/runtime-store.ts`
- Test: `tests/storage/operation-store.test.ts`
- Test: `tests/storage/delivery-store.test.ts`

- [ ] **Step 1: Write failing operation-ledger tests**

```ts
test("an identical operation replay returns its stored receipt", () => {
  const first = store.prepare({ contextId: "ctx", attemptId: "a1", callId: "c1", kind: "send", args: { text: "x" } });
  store.succeed(first.id, { turnId: "turn-1" });
  const replay = store.prepare({ contextId: "ctx", attemptId: "a1", callId: "c1", kind: "send", args: { text: "x" } });
  assert.deepEqual(replay.receipt, { turnId: "turn-1" });
});

test("changing arguments for an existing operation is rejected", () => {
  store.prepare({ contextId: "ctx", attemptId: "a1", callId: "c1", kind: "send", args: { text: "x" } });
  assert.throws(
    () => store.prepare({ contextId: "ctx", attemptId: "a1", callId: "c1", kind: "send", args: { text: "y" } }),
    /OPERATION_CONFLICT/,
  );
});
```

- [ ] **Step 2: Write failing delivery-state tests**

```ts
test("dispatched deliveries become uncertain during startup recovery", () => {
  const id = deliveries.prepare({ kind: "worker_final", body: "done" });
  deliveries.markDispatched(id);
  deliveries.recoverAfterCrash();
  assert.equal(deliveries.get(id).state, "uncertain");
});
```

- [ ] **Step 3: Implement schema and transactional stores**

Create migrations for `telegram_state`, `source_contexts`, `coordinator_attempts`, `operations`, `deliveries`, `events`, `event_batches`, `logical_final_messages`, `session_runtime`, `managed_epochs`, `discovery_snapshots`, and `attachments`. Use `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, and explicit `BEGIN IMMEDIATE` transactions.

Canonicalize operation arguments by recursively sorting object keys before SHA-256 hashing. Implement the terminal `superseded_by` transition atomically with recovery-event insertion.

- [ ] **Step 4: Run storage tests**

Run: `npm test -- tests/storage/*.test.ts`

Expected: all storage tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/storage tests/storage
git commit -m "feat: add durable operation and delivery stores"
```

## Task 3: Raw directive parser and owner-only Telegram normalization

**Files:**
- Create: `src/directives/parser.ts`
- Create: `src/telegram/types.ts`
- Create: `src/telegram/adapter.ts`
- Test: `tests/directives/parser.test.ts`
- Test: `tests/telegram/adapter.test.ts`

- [ ] **Step 1: Write a directive grammar table as tests**

```ts
const cases = [
  ["tell pay /pass hello", { kind: "pass", prefix: "tell pay ", payload: "hello" }],
  ["/pass  hello", { kind: "pass", prefix: "", payload: " hello" }],
  ["/pass hello /collect 9", { kind: "pass", prefix: "", payload: "hello /collect 9" }],
  ["report pay /collect", { kind: "collect", prefix: "report pay ", count: 1 }],
  ["report pay /collect 3", { kind: "collect", prefix: "report pay ", count: 3 }],
  ["/collect 3 /pass x", { kind: "malformed" }],
  ["/pass", { kind: "malformed" }],
] as const;

for (const [raw, expected] of cases) {
  test(raw, () => assert.deepEqual(parseDirective(raw, [], 20), expected));
}
```

Also test Unicode preservation, attachment-only empty pass payload, count 21 rejection, and a consumed directive rejecting a different target or mode.

- [ ] **Step 2: Write owner/update-form tests**

Construct Telegram fixtures proving only ordinary `message` updates from `from.id === ownerId` yield canonical messages. Edited messages, callbacks, channel posts, service messages, unsupported media, and other senders must return `{ kind: "ignored", updateId, reason }` containing no sender content. This lets the poller advance its offset without persisting message bodies or downloading attachments.

- [ ] **Step 3: Implement parser and adapter**

```ts
export type ParsedDirective =
  | { kind: "none" }
  | { kind: "pass"; prefix: string; payload: string }
  | { kind: "collect"; prefix: string; count: number }
  | { kind: "malformed"; reason: string };
```

Scan raw Unicode text by code-unit indices only for ASCII marker/boundary characters; slice the payload directly from the original string. Keep raw text separate from display metadata.

Expand the parser matrix to cover start/ASCII-space/tab/newline boundaries, non-ASCII whitespace not acting as a boundary, malformed-first/no-later-rescue, `/pass` with tab versus exactly one ASCII space, empty pass with and without attachments, every `/collect` trailing-whitespace form, and count limits. At the tool boundary, malformed directive contexts must reject both send and collect, using the wrong tool must fail, and successful receipts must assert the exact payload, ordered attachment IDs, SHA-256, target thread, and mode.

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- tests/directives/*.test.ts tests/telegram/adapter.test.ts`

Expected: all pass.

```bash
git add src/directives src/telegram/types.ts src/telegram/adapter.ts tests/directives tests/telegram/adapter.test.ts
git commit -m "feat: parse lossless chat directives"
```

## Task 4: Atomic session registry and coordinator notebook assets

**Files:**
- Create: `src/registry/session-registry.ts`
- Create: `src/coordinator/notebook.ts`
- Create: `AGENTS.md`
- Create: `coordinator/AGENTS.override.md`
- Create: `coordinator/session-status.example.json`
- Create: `coordinator/.gitignore`
- Test: `tests/registry/session-registry.test.ts`
- Test: `tests/coordinator/notebook.test.ts`

- [ ] **Step 1: Write failing registry tests**

Test atomic create/rename, nickname collision, duplicate endpoint/thread mappings, invalid JSON preserving the last known-good value, and canonical `realpath` handling. Simulate a failed rename and verify the old file remains valid. Add concurrent registration/rename tests under a registry-wide mutex, external valid replacement activation, startup quarantine warnings, mapping-without-runtime initialization as unavailable, and operational orphan retention without control access.

- [ ] **Step 2: Implement registry validation and atomic replacement**

```ts
export interface RegistrySession {
  endpoint: string;
  thread_id: string;
  project_dir: string;
  description?: string;
}

export interface RegistryDocument {
  version: 1;
  coordinator: RegistrySession;
  sessions: Record<string, RegistrySession>;
}
```

Write to a same-directory temporary file with mode `0o600`, `fsync` the file, rename it, then `fsync` the directory. Expose immutable snapshots to readers. Serialize every compare-and-write with one registry-wide mutex because nickname uniqueness spans all sessions. `reload()` validates an externally replaced complete document before activation; startup reconciliation applies the exact JSON/SQLite authority rules from the design.

- [ ] **Step 3: Add coordinator instructions and notebook example**

The instructions must encode the routing, automatic delivery, no-repeat, `/pass`, `/collect`, goal, and notebook rules from the design. Ignore `session-status.json` in `coordinator/.gitignore`; commit only the example.

Implement `CoordinatorNotebook.bootstrap()` to atomically copy the example when the live file is missing and validate version/thread-ID keyed entries when it exists. Tests must verify initialization, invalid-JSON quarantine/recovery, rename reconciliation by stable thread ID, and that notebook status never overrides live tool status. Static instruction tests must require read-on-start and updates after adopt, rename, send, worker event, and completed follow-up removal.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/registry/*.test.ts tests/coordinator/notebook.test.ts`

```bash
git add AGENTS.md src/registry src/coordinator/notebook.ts coordinator tests/registry tests/coordinator/notebook.test.ts
git commit -m "feat: add session registry and coordinator policy"
```

## Task 5: App-server JSON-RPC client and owned local endpoint

**Files:**
- Create: `scripts/generate-app-server-schema.mjs`
- Create: `src/app-server/generated/` (output of `codex app-server generate-ts`)
- Create: `src/app-server/protocol-manifest.json`
- Create: `src/app-server/protocol.ts`
- Create: `src/app-server/json-rpc-client.ts`
- Create: `src/app-server/local-endpoint.ts`
- Test: `tests/app-server/json-rpc-client.test.ts`
- Test: `tests/app-server/local-endpoint.test.ts`

- [ ] **Step 1: Generate and pin protocol evidence**

The script verifies `codex --version` is the pinned 0.142.4 release, runs `codex app-server generate-ts --out src/app-server/generated` and `generate-json-schema --out .tmp/codex-app-server-schema`, then writes `protocol-manifest.json` with CLI version and a SHA-256 over generated artifacts. `protocol.ts` imports generated request/response/notification types and narrows them into service methods; `unknown` is allowed only while decoding the transport envelope. Add a negative test that a changed version/hash or missing required method rejects endpoint startup.

- [ ] **Step 2: Write failing transport tests with a fake child process**

Test initialize-before-use, monotonically increasing request IDs, out-of-order responses, notifications, malformed JSON isolation, request timeout, process exit rejection, and clean shutdown. Test deterministic responses for `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, and `item/permissions/requestApproval`: deny/block the request, mark the thread permission-blocked, and emit one deduplicatable metadata/warning event. Do not implement `item/tool/call` here because coordinator tools use MCP, not dynamic client tools.

- [ ] **Step 3: Implement JSON-RPC transport**

```ts
export interface RpcPeer {
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
  notify(method: string, params: unknown): void;
  onNotification(listener: (method: string, params: unknown) => void): () => void;
  onServerRequest(listener: (request: ServerRequest) => Promise<unknown>): () => void;
}
```

Use newline-delimited JSON over child stdin/stdout; never parse stderr as protocol.

- [ ] **Step 4: Implement `LocalEndpoint`**

Own `codex app-server --listen stdio://`, initialize once, verify the pinned manifest/capabilities, restart with fake-clock-testable bounded backoff, and expose generated-type-backed thread/model/goal/turn methods. Route all thread/turn notifications and permission-blocked events through one subscription.

- [ ] **Step 5: Run and commit**

Run: `npm test -- tests/app-server/*.test.ts`

```bash
git add scripts src/app-server tests/app-server
git commit -m "feat: connect to local codex app-server"
```

## Task 6: App-server pool, discovery snapshots, and lifecycle state machine

**Files:**
- Create: `src/app-server/pool.ts`
- Create: `src/sessions/discovery.ts`
- Create: `src/sessions/lifecycle.ts`
- Test: `tests/sessions/discovery.test.ts`
- Test: `tests/sessions/lifecycle.test.ts`

- [ ] **Step 1: Write discovery tests**

Fake separate archived/non-archived pages with mixed source kinds and subagent/ephemeral rows. Verify exhaustive pagination, filtering, deterministic `updatedAt`/thread-ID sorting, combined limit, opaque snapshot cursor, and stable second-page results after the fake server changes. Assert exact `sourceKinds`, both archived queries, `useStateDbOnly: false`, omission of absent `cwd`, query-fingerprint mismatch rejection, cursor tamper/expiry rejection, and TTL cleanup.

- [ ] **Step 2: Write lifecycle transition tests**

Cover create, register/adopt equivalence, canonical-cwd mismatch, idle requirements, detach unsubscribe, attach's two idle checks, archive, unavailable recovery, startup completion of intermediate states, and managed-epoch baselines excluding historical/detached turns.

- [ ] **Step 3: Implement pool and discovery**

```ts
export interface AppServerEndpoint {
  readonly id: string;
  readonly state: "starting" | "ready" | "unavailable" | "stopped";
  request<T>(method: string, params: unknown): Promise<T>;
}
```

`AppServerPool.startTurn` uses a semaphore and throws `CAPACITY_EXCEEDED` immediately rather than queueing. Fake-clock tests verify permits release on success, failure, interrupt, endpoint exit, and startup rejection; restart backoff resets only after a stable ready interval.

- [ ] **Step 4: Implement lifecycle service**

Use the registry for identity and `RuntimeStore` for management state. Hold a per-session mutex for every transition. Reconcile prepared registry mutations and intermediate states during startup.

- [ ] **Step 5: Run and commit**

Run: `npm test -- tests/sessions/discovery.test.ts tests/sessions/lifecycle.test.ts`

```bash
git add src/app-server/pool.ts src/sessions/discovery.ts src/sessions/lifecycle.ts tests/sessions
git commit -m "feat: manage codex session lifecycle"
```

## Task 7: Final-message extraction, collection, status, model, and goals

**Files:**
- Create: `src/sessions/final-messages.ts`
- Create: `src/sessions/service.ts`
- Test: `tests/sessions/final-messages.test.ts`
- Test: `tests/sessions/service.test.ts`

- [ ] **Step 1: Write the terminal-turn extraction matrix**

Test explicit final phase, several final items, phase-unknown fallback to the last agent message, commentary exclusion, successful no-message, failed/interrupted with and without an eligible message, nullable protocol `completedAt`, and stable ordering by effective completion time/turn ID/item index. When protocol completion time is null, persist the first terminal-observed timestamp once and reuse it during every replay/reconciliation.

- [ ] **Step 2: Write collection and control tests**

Verify normal collect returns bodies to the coordinator; direct `/collect` persists a newest-N selection and emits it chronologically; count over 20 fails before records exist. Verify start versus steer preconditions, interrupt, status composition, model/effort persistence, goal replacement, pause/resume/cancel, and absence of complete-goal.

- [ ] **Step 3: Implement logical message storage and session service**

```ts
export interface LogicalFinalMessage {
  endpointId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  completedAt: number; // protocol completedAt or persisted first terminal-observed time
  itemOrder: number;
  body: string;
  terminalStatus: string;
}
```

Apply pending model/effort settings to the next `turn/start`. Capability-gate goal methods and never expose a completion setter.

- [ ] **Step 4: Run and commit**

Run: `npm test -- tests/sessions/final-messages.test.ts tests/sessions/service.test.ts`

```bash
git add src/sessions tests/sessions
git commit -m "feat: add session messaging and controls"
```

## Task 8: Safe attachment store and app-server inputs

**Files:**
- Create: `src/attachments/store.ts`
- Test: `tests/attachments/store.test.ts`

- [ ] **Step 1: Write failing safety tests**

Test streamed byte limits despite false metadata, per-message/store quota, randomized mode-0600 files, SHA-256, sanitized display names, attachment-only pass, reference-counted retention, expiry, traversal rejection, intermediate/final symlink swapping, growing-file upload limits, sandbox readability, and opaque handle scope. Add full Telegram-download -> store -> app-server `localImage`/`mention` fixtures and project-relative file -> safe handle -> Telegram-upload fixtures.

- [ ] **Step 2: Implement the store**

```ts
export type FileHandle = `file_${string}`;

export interface StoredAttachment {
  id: FileHandle;
  displayName: string;
  mediaType: string;
  size: number;
  sha256: string;
}
```

Materialize images as `{ type: "localImage", path }` and generic files as `{ type: "mention", name, path }`. On Linux, resolve an outbound relative path beneath the canonical owner root, open the final component with `O_NOFOLLOW`, `fstat` it as a regular file, resolve `/proc/self/fd/<fd>` after opening, and reject unless that actual opened target remains under the root. Retain the descriptor through a byte-limited upload, so later symlink/path swaps cannot change the source. Fail closed on platforms without an equivalent race-safe primitive.

- [ ] **Step 3: Run and commit**

Run: `npm test -- tests/attachments/*.test.ts`

```bash
git add src/attachments tests/attachments
git commit -m "feat: add safe attachment handling"
```

## Task 9: Telegram API, polling, and durable delivery worker

**Files:**
- Create: `src/telegram/api.ts`
- Create: `src/telegram/poller.ts`
- Create: `src/telegram/delivery-worker.ts`
- Test: `tests/telegram/api.test.ts`
- Test: `tests/telegram/poller.test.ts`
- Test: `tests/telegram/delivery-worker.test.ts`

- [ ] **Step 1: Write HTTP and polling tests**

Use an injected `fetch` fake. For accepted input, verify one transaction persists the source context and next update offset. For unauthorized/unsupported input, persist only the next offset—never sender content—so ignored updates cannot stall polling; verify no attachment download, queue, content log, model work, or reply. Also test 429 retry-after handling, abortable long polling, file download streaming, text splitting, and upload paths.

- [ ] **Step 2: Write ambiguity tests**

Verify prepared -> dispatched -> confirmed, startup dispatched -> uncertain, confirmed never retries, mandatory uncertain result retries with `[payments · recovery retry d_ab12]`, and optional uncertain chat-tool output returns `DELIVERY_UNCERTAIN` without automatic retry.

- [ ] **Step 3: Implement native Bot API client and worker**

No Telegram framework dependency is needed. Keep worker bodies unchanged; labels and retry IDs belong to an escaped/plain-text envelope. Store returned Telegram message IDs in the same transaction that confirms delivery.

- [ ] **Step 4: Run and commit**

Run: `npm test -- tests/telegram/*.test.ts`

```bash
git add src/telegram tests/telegram
git commit -m "feat: add Telegram transport and outbox"
```

## Task 10: Event relay, coordinator scheduler, and runtime recovery policy

**Files:**
- Create: `src/events/relay.ts`
- Create: `src/coordinator/scheduler.ts`
- Create: `src/coordinator/runtime.ts`
- Test: `tests/events/relay.test.ts`
- Test: `tests/coordinator/scheduler.test.ts`
- Test: `tests/coordinator/runtime.test.ts`

- [ ] **Step 1: Write event-relay tests**

Feed app-server terminal notifications and thread reads into the relay. Verify managed-epoch filtering, terminal extraction, logical-message persistence, automatic Telegram deliveries with nickname envelope, metadata-only coordinator events, failed/interrupted warnings, no-final behavior, and event/delivery deduplication after replay. Feed permission-blocked server events and verify deterministic nickname-labeled Telegram warnings, metadata-only coordinator notification, runtime status, and deduplication.

- [ ] **Step 2: Write scheduler tests with a fake clock**

Verify one active coordinator turn, FIFO user messages, one-second event batching, 20-event/8-KiB limits, user priority, event service after five user turns or 30 seconds, per-session event order, and transient-status coalescing without dropping final-result events.

- [ ] **Step 3: Write failed-attempt recovery tests**

Verify a failure before dispatch permits a new attempt; a failure after any dispatched effect atomically supersedes the original context and creates exactly one recovery context; original event IDs cannot remain pending; the recovery prompt includes stored receipts; internal final text is suppressed.

- [ ] **Step 4: Write coordinator-answer and reconnect reconciliation tests**

For a user-triggered coordinator terminal turn, extract its eligible final text, create a mandatory durable Telegram delivery correlated to the source message, suppress nothing, and verify notification replay does not duplicate the logical delivery. Fault-inject Telegram ambiguity and verify mandatory recovery retry. For internal turns, continue suppressing final text.

Simulate endpoint ready after a disconnect: for every managed thread, read history after its epoch baseline and delivery cursor, feed unseen terminal turns through the same relay, and advance the cursor transactionally. Verify a turn completed before notification processing is recovered while adopted history and detached-period turns remain excluded.

- [ ] **Step 5: Implement relay, scheduler, and runtime**

Use source-context records from Task 2. Coordinator user turns receive raw message metadata and directive context. Internal event turns receive metadata only. Start/resume the coordinator thread in `coordinator/` and never pass project transcripts automatically. Subscribe the relay to endpoint notifications and endpoint-ready events; the latter always runs the managed-history reconciliation pass before new work is accepted.

- [ ] **Step 6: Run and commit**

Run: `npm test -- tests/events/*.test.ts tests/coordinator/*.test.ts`

```bash
git add src/events src/coordinator tests/events tests/coordinator
git commit -m "feat: orchestrate coordinator turns"
```

## Task 11: Validated coordinator tools and operation execution

**Files:**
- Create: `src/coordinator/tools.ts`
- Test: `tests/coordinator/tools.test.ts`

- [ ] **Step 1: Write a handler test for every curated tool**

Cover list/discover/status/create/register/adopt/rename/detach/attach/archive, send/read/collect/interrupt, models/model/effort, goal get/set/pause/resume/cancel, chat message, prepare/send attachment. Verify no complete-goal or raw-RPC tool exists.

- [ ] **Step 2: Write directive enforcement tests at the tool boundary**

For `/pass`, verify exact raw payload and attachment order, coordinator-selected target/mode, single consumption, identical receipt replay, and changed target/mode rejection. For `/collect`, verify source count, stored selection, direct deliveries, and receipt-only tool output.

Add a per-operation recovery matrix:

- `turn/start` and `turn/steer`: reconcile by verified `clientUserMessageId` plus thread/turn history; otherwise become uncertain.
- create/register/adopt/detach/attach/archive/rename: reconcile app-server thread state, canonical `cwd`, registry prepared record, and runtime transition.
- model/effort: remain local pending state until included in a successful turn start, so no standalone remote retry exists.
- goal set/pause/resume/cancel: compare native `thread/goal/get` with the requested objective/status before deciding success or uncertainty.
- interrupt: inspect terminal/active turn status before retry; never interrupt a different turn ID.
- chat message/attachment and direct collection: reconcile through delivery records and Telegram confirmed/uncertain policy.
- file-handle preparation: return the existing valid opaque handle for identical replay.

Test stored receipt replay, changed-argument `OPERATION_CONFLICT`, proven success after a lost response, proven failure, and irreconcilable `OPERATION_UNCERTAIN` without retransmission for every row.

- [ ] **Step 3: Implement tools through the operation ledger**

```ts
export interface ToolCallContext {
  sourceContextId: string;
  attemptId: string;
  turnId: string;
  callId: string;
}

export type ToolHandler = (context: ToolCallContext, args: unknown) => Promise<unknown>;
```

Validate args with `zod`, call `OperationStore.prepare` before effects, mark dispatched immediately before transport, persist receipts, and surface `OPERATION_UNCERTAIN` when reconciliation cannot prove the outcome.

The serialized coordinator runtime exposes an `ActiveCoordinatorContextProvider`. It is set before each coordinator turn, updated with the actual app-server turn ID, and cleared on terminal notification. MCP calls derive their durable call ID from the MCP JSON-RPC request ID and are rejected when no coordinator context is active; project threads never receive this MCP configuration.

- [ ] **Step 4: Run and commit**

Run: `npm test -- tests/coordinator/tools.test.ts`

```bash
git add src/coordinator/tools.ts tests/coordinator/tools.test.ts
git commit -m "feat: expose coordinator control tools"
```

## Task 12: Loopback MCP server

**Files:**
- Create: `src/mcp/server.ts`
- Test: `tests/mcp/server.test.ts`

- [ ] **Step 1: Write MCP protocol tests**

Start the server on an ephemeral loopback port. Verify bearer authorization, initialize instructions, complete tool listing, successful dispatch with source context, MCP JSON-RPC request ID propagation into `callId`, malformed input errors, unknown tools, inactive/mismatched coordinator context rejection, and rejection from non-loopback binding configuration.

- [ ] **Step 2: Implement Streamable HTTP MCP**

Use `@modelcontextprotocol/sdk` and its Streamable HTTP server transport. Bind only `127.0.0.1`, require a random startup bearer token, advertise the manager workflow in server instructions, and register tools from Task 11. Pass the MCP URL through the coordinator thread start/resume `config.mcp_servers` override. Build the owned app-server child environment by inheriting the Codex-required host environment (`PATH`, `HOME`, `CODEX_HOME`, proxy settings, and supported Codex authentication variables), explicitly removing Telegram and unrelated bot secrets, then adding `CODEX_BOT_MCP_TOKEN`. Add `shell_environment_policy.exclude = ["CODEX_BOT_MCP_TOKEN"]` plus the default secret exclusions to every turn configuration so model-launched commands cannot inherit it. Do not put this MCP server in global Codex configuration or project-session thread configuration. Test both a file-backed Codex profile and a fixture environment-auth profile at the environment-construction boundary.

- [ ] **Step 3: Run and commit**

Run: `npm test -- tests/mcp/*.test.ts`

```bash
git add src/mcp tests/mcp
git commit -m "feat: serve coordinator tools over MCP"
```

## Task 13: Application composition, startup reconciliation, and shutdown

**Files:**
- Create: `src/app.ts`
- Create: `src/main.ts`
- Test: `tests/app.test.ts`

- [ ] **Step 1: Write composition tests**

Use fakes to verify startup order: database/migrations, registry validation and operational reconciliation, coordinator-notebook bootstrap, attachment cleanup, MCP listener, construct the endpoint/pool, install event-relay notification and endpoint-ready subscriptions, start/initialize app-server, lifecycle and missed-history reconciliation while live notifications are concurrently deduplicated, outbox recovery, coordinator resume/create, coordinator scheduler, delivery worker, maintenance scheduler, then Telegram polling. No work is accepted before reconciliation completes. Verify a terminal notification arriving during startup reconciliation is delivered exactly once, every long-lived worker starts exactly once, reverse-order graceful shutdown, startup-failure cleanup, and signal idempotence.

- [ ] **Step 2: Implement `createApp` and `main`**

```ts
export interface BotApp {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function main(env = process.env): Promise<void> {
  const app = await createApp(loadConfig(env));
  await app.start();
  const stop = () => void app.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
```

Ensure startup failures close already-started resources. The maintenance scheduler expires attachment materializations and discovery snapshots with an injected clock and is covered by deterministic tests. Emit structured metadata logs without message bodies, sender content from ignored updates, tokens, or attachment content.

- [ ] **Step 3: Run and commit**

Run: `npm test -- tests/app.test.ts`

```bash
git add src/app.ts src/main.ts tests/app.test.ts
git commit -m "feat: compose bot application"
```

## Task 14: Real app-server contract, end-to-end recovery tests, and operator docs

**Files:**
- Create: `tests/integration/app-server.test.ts`
- Create: `tests/integration/recovery.test.ts`
- Create: `tests/integration/mcp-coordinator.test.ts`
- Create: `tests/integration/telegram-live.test.ts`
- Create: `tests/integration/fixtures/fake-telegram-server.ts`
- Create: `.env.example`
- Create: `README.md`

- [ ] **Step 1: Add opt-in real app-server tests**

Under `RUN_CODEX_INTEGRATION=1`, start one real app-server and temporary projects. Verify multiple top-level threads, exhaustive discovery, create/register/adopt, detach/unsubscribe, two-read attach, archive, `cwd`, status, concurrent turns, immediate capacity failure and permit release, fake-clock restart backoff, start/steer/interrupt, model/effort, available goal methods, localImage/mention inputs, final extraction, and restart/resume. Measure and record the pinned version's actual `clientUserMessageId` behavior for start and steer; make recovery policy assertions match the observed contract. Skip with a clear message when the flag is absent.

Start the loopback MCP server and real coordinator thread with `config.mcp_servers`. Prompt the coordinator to call one harmless curated status tool and assert the SDK request ID binds to the active source context and receipt. Start a project thread through the same app-server and prove it does not list the bot MCP tool and that a shell command cannot observe `CODEX_BOT_MCP_TOKEN`.

Exercise both attachment directions end to end: Telegram fixture -> streamed store -> localImage/mention turn input, and project-relative file -> race-safe handle -> Telegram fixture upload.

- [ ] **Step 2: Add fault-injection recovery tests**

Use child processes and the fake Telegram server to crash at every boundary: before/after app-server dispatch, before/after Telegram transmission/response commit, during registry transition, and during coordinator recovery-context creation. Verify the exact confirmed/uncertain/superseded states from the design.

- [ ] **Step 3: Document operation**

README sections: prerequisites, BotFather token, owner/destination IDs, environment variables, Codex authentication, non-interactive/sandbox warning, start/stop, registry format, notebook, nicknames, `/pass`, `/collect`, detach/manual/attach, model/goal controls, attachments, delivery retries, logs/state paths, backup, troubleshooting, and deferred SSH/adapters.

- [ ] **Step 4: Run complete verification**

Run: `npm run check`

Expected: typecheck exit 0 and all non-integration tests pass.

Run: `RUN_CODEX_INTEGRATION=1 npm test -- tests/integration/app-server.test.ts`

Expected: app-server contract tests pass against pinned Codex 0.142.4.

Run: `RUN_CODEX_INTEGRATION=1 npm test -- tests/integration/mcp-coordinator.test.ts`

Expected: real coordinator MCP invocation and project-thread/token isolation pass.

Run: `npm test -- tests/integration/recovery.test.ts`

Expected: all fault-injection cases pass.

Run only when `RUN_TELEGRAM_LIVE=1`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, and `TELEGRAM_DESTINATION_CHAT_ID` are present:

`RUN_TELEGRAM_LIVE=1 npm test -- tests/integration/telegram-live.test.ts`

Expected: one owner-only private-chat round trip succeeds; otherwise the test skips without failure.

- [ ] **Step 5: Commit**

```bash
git add tests/integration .env.example README.md
git commit -m "test: verify end-to-end bot recovery"
```

## Task 15: Final audit

**Files:**
- Modify only files required by findings.

- [ ] **Step 1: Run the complete verification suite from a clean process**

```bash
npm ci
npm run check
RUN_CODEX_INTEGRATION=1 npm test -- tests/integration/app-server.test.ts
npm test -- tests/integration/recovery.test.ts
git diff --check
git status --short
```

Expected: every command exits 0; worktree contains only intentional final-audit changes.

- [ ] **Step 2: Review design coverage line by line**

Confirm every MVP success criterion in `docs/superpowers/specs/2026-06-30-codex-chat-bot-design.md` has at least one passing test and documented operator behavior.

- [ ] **Step 3: Commit audit fixes if any**

```bash
git add -u
git commit -m "fix: address final MVP audit"
```

If no files changed, do not create an empty commit.
