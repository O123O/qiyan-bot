# Design: Chat App Plugin Architecture

Status: draft (for review)
Goal: make chat-app support a uniform, register-once extension point so adding a new app
(Teams, Discord, …) is small and mechanical, without constraining an app's internal machinery.

Layers on top of the folder consolidation (`src/chat-apps/{shared,slack,telegram,weixin}`), which is
co-location only and changes no API.

## 0. Review outcome & scope decisions (authoritative — supersedes conflicting text below)

A code-verified review corrected several claims and surfaced real landmines. Final scope:

- **onMessage is already unified for 2 of 3.** Slack (`slack/ingress-worker.ts:23`) and WeChat
  (`weixin/ingress-worker.ts:22`) already use `onMessage(source, effects)`; only Telegram's poller
  (`telegram/poller.ts`) passes `(source, commitNativeCheckpoint)`, already bridged inline at
  `production-app.ts:2067`. So there is **no ingress divergence to fix** beyond that one already-bridged
  site; §4.3's "converge three call sites" is really zero net work. `ChatAppDeps.onMessage` = the existing
  `acceptChat(source, effects)`.
- **`primaryBinding` is formalized on the adapter contract.** Add `readonly primaryBinding?: ConversationBinding`
  to `ChatAdapter` (today it's an untyped cast at `production-app.ts:4072`). Slack sets it post-`initialize()`,
  WeChat in its ctor. **Telegram's binding is config-derived and needed at the storage phase**
  (`preflightConversationCutover` ~1958, backfill ~1986) *before adapters exist* — so `telegramApp` also
  exposes a pure `primaryBindingFromConfig(config)` used at that early phase; this stays unchanged.
- **`create()` returns a `ChatAppInstance`, not a bare adapter**, so app-specific composition outputs are not
  dropped: `{ adapter; onAllReady?(): Promise<void>|void; contextService?: … }`. WeChat's `create` builds its
  incident router internally and returns `onAllReady: () => incidents.reconcileUnwarned()`; Slack's `create`
  surfaces its `SlackContextService` (consumed by the MCP search tool at `production-app.ts:2989`) on the
  instance. These are genuinely app-specific and stay app-specific — not forced through a generic hole.
- **WeChat credential** (`options.weixinCredential`, a secrets handle in neither config nor deps today) is
  routed via `ChatAppDeps.weixinCredential?`.
- **OUT OF SCOPE (deliberate, karpathy):** generalizing config parsing. `config.ts` env→section mapping and
  the cross-app invariants (primary-required-when->1, primary-names-configured, telegram dest==owner,
  `config.ts:30-57`/`110-128`) stay central. Adding a new app still adds a config section centrally — the
  primary win here is uniform **construction + composition**, not config. Config generalization is a separate,
  larger change; do it only if a real need appears.
- Drop `clock` from `ChatAppDeps` (no adapter uses it). `create()` receives already-parsed config;
  `CHAT_APPS` is `readonly ChatApp[]` and each app narrows its own config — no static id→Config union (that is
  not cleanly typeable in strict TS; it's a runtime `z.parse`).
- Preserve the `options.chatAdapters` injection seam and generalize the credential check to
  "enabled ids == configured ids." A Phase-1 regression test locks primary/administrative-binding outcomes.

## 1. What's already good (keep, do not touch)

- `ChatDeliveryAdapter` (`shared/contracts.ts`): `id`, `sendMessage`, optional `sendDocument?` /
  `reconcileUncertain?` / `isSafeToRetry?`. Capability-based optionals.
- App-agnostic core: `ChatAdapterRegistry` (dispatch by `delivery.id`), the shared `DeliveryWorker`, and
  opaque `ConversationBinding` / `JsonValue` (`destination`/`receipt`/`conversationKey` are the app's business).
- App-specific machinery is already sandboxed per folder (WeChat's credential/api/protocol/outbound stores
  never leak into shared). **Adding app-specific things is already unconstrained** — this design keeps it that way.

## 2. The only real friction (what to fix)

1. **Construction is per-app and positional.** `new SlackChatAdapter(db, attachments, conversations, deliveries, opts)`
   vs `new TelegramChatAdapter(db, attachments, opts)` vs `new WeixinChatAdapter(opts)`. No common factory/deps.
2. **Composition is a hand-maintained switchboard** in `production-app.ts` (~2062–2165): per-app `if`-gating,
   construction, `chats.push`, a bespoke primary/administrative-binding cascade, and a credential-match check.
   Adding an app edits this block in several places, plus the `config.chat.*` schema and the `primary` union.
3. **The inbound hand-off shape differs per app.** Slack `onMessage(source, effects)`, Telegram
   `onMessage(source, commitNativeCheckpoint)`, WeChat a different options object. So there is no single
   "similar API" a new app targets for receiving.

Everything else (delivery, history, per-app internals) is already fine.

## 3. Assumptions (please confirm)

- A1. Compile-time registration (an array of apps) is acceptable; no runtime/dynamic plugin loading is wanted.
- A2. "Similar API" means a new app implements the *same small surface* the core needs; it does **not** mean
  the three existing apps must share ingress *implementation*. Their ingress internals can stay as-is.
- A3. Config stays env/file-driven with one section per app id (`config.chat.<id>`), `primary` = an app id.

If any is wrong, the design changes — say so before implementation.

## 4. Minimal design

Four small pieces. No shared ingress framework, no codec abstraction, no per-app scaffolding rewrite.

### 4.1 `ChatApp` — the registration interface (the one thing a new app implements)

```ts
// src/chat-apps/shared/plugin.ts
export interface ChatApp<Config = unknown> {
  readonly id: string;                 // == delivery adapter id, e.g. "discord"
  readonly displayName: string;
  readonly configSchema: ZodType<Config>;   // contributed to the chat-config union; undefined config => disabled
  create(deps: ChatAppDeps, config: Config): ChatAdapter;   // wire any app-specific stores/clients here
}
```

Registered in one array:

```ts
// src/chat-apps/registry.ts
export const CHAT_APPS: readonly ChatApp[] = [slackApp, telegramApp, weixinApp /*, discordApp */];
```

Adding Discord = add its folder + one line here. `create()` is a plain factory, so app-specific internals
stay unconstrained (A2).

### 4.2 `ChatAppDeps` — one dependency bundle (replaces positional args)

```ts
export interface ChatAppDeps {
  db: Database;
  attachments: AttachmentStore;
  conversations: ConversationStore;
  deliveries: DeliveryStore;
  clock: Clock;
  onOperationalEvent?: OperationalEventSink;
  onMessage: OnMessage;              // the one inbound hand-off shape (4.3)
  maxMessageBytes: number;
}
```

Apps take only what they need. Adding a dep is one field, not N constructor edits.

### 4.3 One inbound hand-off shape

```ts
type OnMessage = (source: CanonicalChatSource, effects: ChatAcceptanceEffects) => Promise<void>;
```

This is the "similar API" for receiving: every app, however it runs its own transport/inbox internally,
hands a canonical message to the core the same way. Telegram's post-commit offset checkpoint and Slack's
socket-ack are expressed *through* `ChatAcceptanceEffects` (a post-commit hook), not by a shared worker.

Decision to make (surfaced, not chosen silently):
- **(a)** converge all three existing apps onto this signature now (true uniformity, ~3 small callback-site
  changes, touches ingress), or
- **(b)** define the shape, use it for new apps, and converge the three lazily (less churn now, temporary
  inconsistency). Recommendation: **(a)** — it's the point of "similar API" and the change is small.

### 4.4 Registry-driven composition (delete the switchboard)

```ts
const enabled  = CHAT_APPS.filter(app => config.chat[app.id] !== undefined);
const adapters = enabled.map(app => app.create(deps, config.chat[app.id]));
const registry = new ChatAdapterRegistry(adapters);
const primary  = enabled.find(app => app.id === config.chat.primary) ?? fail(...);
```

- Config: the `chat` object's per-app sections derive from `CHAT_APPS` (each contributes `configSchema`);
  `primary` is `z.string()` validated against enabled ids. New app ⇒ no central schema edit.
- The `actualAdapters`-vs-configured credential check generalizes to "enabled ids == configured ids."
- Primary/administrative binding replaces the `slack ? … : telegram ? …` cascade with a lookup by primary id.

## 5. Explicitly NOT doing (avoid speculative abstraction)

- **No shared ingress worker / codec framework.** The three apps' ingress paths are genuinely different
  (socket-ack vs update-offset vs sync-cursor) and they work. Forcing them into one scaffold is a risky
  rewrite that "add an app" does not require. A future helper is possible if a second app ever wants it —
  extract then, not now (rule of three).
- No runtime plugin loader (A1).
- No changes to `DeliveryWorker`, `ConversationStore`, or recovery internals.
- No new capabilities the assistant doesn't ask for.

## 6. Plan and verifiable success criteria

- Phase 1 — registration + composition (no behavior change):
  add `ChatApp`, `ChatAppDeps`, `registry.ts`; wrap the three adapters as `slackApp/telegramApp/weixinApp`
  (adapter classes unchanged, just standardized construction); switch `production-app` to registry-driven.
  **Verify:** full test suite green with byte-identical behavior; a regression test locks the exact
  primary/administrative-binding outcome for slack/telegram/weixin.
- Phase 2 — unify the inbound hand-off (decision 4.3):
  converge the three `onMessage` call sites onto `(source, effects)`.
  **Verify:** each app's existing ingress tests pass unchanged (dedup, ordered drain, post-commit ack).
- Phase 3 — prove extensibility:
  add a fake `exampleApp` (tests only) with an in-memory transport and a conformance test — same delivery id
  ⇒ one send; ingress dedup by provider id; disabled when no config; enabled + routable when configured.
  **Verify:** `exampleApp` passes the conformance suite with zero core edits beyond adding it to a test registry.

Each phase is its own reviewed change; the three real apps stay green throughout.

## 7. Success = this becomes true

Adding Discord/Teams is: create `src/chat-apps/discord/` (its transport + `ChatDeliveryAdapter` + whatever
internal stores it needs), export a `discordApp: ChatApp`, add one line to `CHAT_APPS`. No edits to the core,
config schema, or composition; the conformance suite proves it behaves. App-specific internals remain fully
the app's own.

## 8. Open questions

- Q1: Decision 4.3 — converge all three now (a) or lazily (b)?
- Q2: Keep "explicit `options.chatAdapters` wins over env config" (current test seam) as-is?
- Q3: `primary` stays a single owner channel (not per-app owner routing) for now?
